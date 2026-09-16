"""Step 5-prep — Plaid /transactions/enrich for non-Plaid-fed rows.

Contract:
  * We call Plaid's Enrich add-on ONLY for rows where ``source != "plaid"``
    (statement upload / Veryfi / QBO / manual). Plaid-fed rows already
    carry the enrichment data from ``/transactions/sync``.
  * Cache key = normalized description + direction + account_type + mcc
    + location + PFC taxonomy version. Amount is intentionally excluded.
  * All writes go to ``lab_enrich_cache``. Live collections untouched.

Failure modes are captured on the cache row (``enrich_available`` bool +
``reason``). The report surfaces coverage + errors.
"""
from __future__ import annotations
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

from db import db
from .collections import LAB_ENRICH_CACHE

# Reuse the live descriptor normalizer — read-only pure function.
from contact_resolver import normalize_descriptor

log = logging.getLogger("axiom.lab.enrich")

# PFC taxonomy pinned to v2 per the Feb-2026 spec (single source of truth
# for the cache key). See docs/Plaid Enrich playbook.
PFC_TAXONOMY_VERSION = "v2"
# Batch cap is a Plaid product limit — do not exceed.
PLAID_ENRICH_MAX_BATCH = 100


def _account_type(acct: dict | None) -> str:
    """Map internal account ``type`` to Plaid's enrich account_type
    values (``depository`` | ``credit``). Default to depository."""
    t = (acct or {}).get("type", "").strip().lower()
    if t in ("credit", "credit card", "credit_card", "liability"):
        return "credit"
    return "depository"


def _build_cache_key(*, description: str,
                     direction: str,
                     account_type: str,
                     mcc: str | None,
                     location: dict | None) -> str:
    """Cache key = SHA-1 of the deterministic tuple. Version is included
    so a taxonomy bump automatically invalidates."""
    norm = normalize_descriptor(description or "")
    loc = {k: (location or {}).get(k) for k in
           ("country", "region", "city", "postal_code")}
    tup = json.dumps({
        "d":  norm,
        "dr": direction,
        "at": account_type,
        "mcc": (mcc or None),
        "loc": loc,
        "v": PFC_TAXONOMY_VERSION,
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(tup.encode("utf-8")).hexdigest()


async def get_cached(cache_key: str) -> Optional[dict]:
    return await db[LAB_ENRICH_CACHE].find_one({"cache_key": cache_key}, {"_id": 0})


async def _upsert_cache(doc: dict) -> None:
    await db[LAB_ENRICH_CACHE].update_one(
        {"cache_key": doc["cache_key"]}, {"$set": doc}, upsert=True,
    )


def _txn_direction(txn: dict, acct: dict | None) -> str:
    """OUTFLOW / INFLOW from the business's perspective (Plaid's spec).
    Mirrors ``step2_parse.infer_direction`` but returns the strings
    Plaid expects."""
    amt = float(txn.get("amount") or 0)
    at = _account_type(acct)
    if at == "credit":
        return "OUTFLOW" if amt > 0 else "INFLOW"
    return "OUTFLOW" if amt > 0 else "INFLOW"


def _sdk_txn(txn: dict, direction: str) -> dict:
    """Build a ClientProvidedTransaction dict for the Plaid SDK."""
    from plaid.model.client_provided_transaction import ClientProvidedTransaction
    from plaid.model.client_provided_transaction_location import ClientProvidedTransactionLocation
    from plaid.model.enrich_transaction_direction import EnrichTransactionDirection

    kw = {
        "id":                txn["id"],
        "description":       (txn.get("description") or "")[:500] or "unknown",
        "amount":            abs(float(txn.get("amount") or 0)),
        "iso_currency_code": (txn.get("iso_currency_code") or "USD")[:3],
        "direction":         EnrichTransactionDirection(direction),
    }
    loc = txn.get("location") or {}
    if any(loc.get(k) for k in ("country", "region", "city", "address", "postal_code")):
        kw["location"] = ClientProvidedTransactionLocation(**{
            k: loc[k] for k in ("country", "region", "city", "address", "postal_code")
            if loc.get(k)
        })
    mcc = str(txn.get("mcc") or "").strip()
    if mcc:
        kw["mcc"] = mcc
    return ClientProvidedTransaction(**kw)


async def enrich_non_plaid_rows(company_id: str, txns: list[dict],
                                 accts_by_id: dict[str, dict]) -> dict:
    """Enrich rows whose ``source != "plaid"``. Idempotent — cache-first.

    Returns diagnostic dict: {targeted, cache_hits, api_calls, matched,
    empty, errors, error_reasons}.
    """
    # Filter to non-Plaid-fed rows only.
    targets = [t for t in txns if (t.get("source") or "").lower() != "plaid"]
    stats = {
        "targeted":      len(targets),
        "cache_hits":    0,
        "api_calls":     0,
        "matched":       0,
        "empty":         0,
        "errors":        0,
        "error_reasons": {},
    }
    if not targets:
        return stats

    # Separate into depository / credit buckets (batch API requires one).
    buckets: dict[str, list[tuple[dict, str, str]]] = {"depository": [], "credit": []}
    for t in targets:
        acct = accts_by_id.get(t.get("bank_account_id")) or {}
        at = _account_type(acct)
        direction = _txn_direction(t, acct)
        cache_key = _build_cache_key(
            description=t.get("description") or "",
            direction=direction,
            account_type=at,
            mcc=t.get("mcc"),
            location=t.get("location"),
        )
        cached = await get_cached(cache_key)
        if cached:
            stats["cache_hits"] += 1
            if cached.get("enrich_available") and (cached.get("merchant_name") or cached.get("counterparties")):
                stats["matched"] += 1
            elif cached.get("enrich_available"):
                stats["empty"] += 1
            else:
                stats["errors"] += 1
                r = cached.get("reason") or "unknown"
                stats["error_reasons"][r] = stats["error_reasons"].get(r, 0) + 1
            # Stamp lab_transactions with cache pointer only (raw payload
            # lives in the cache collection).
            await db["lab_transactions"].update_one(
                {"company_id": company_id, "txn_id": t["id"]},
                {"$set": {"enrich_cache_key": cache_key,
                          "enrich_source": "cache"}},
            )
            continue
        # Miss — queue for API call.
        buckets[at].append((t, direction, cache_key))

    # Call Plaid Enrich per bucket (100 max per request).
    for at, queue in buckets.items():
        for i in range(0, len(queue), PLAID_ENRICH_MAX_BATCH):
            chunk = queue[i:i + PLAID_ENRICH_MAX_BATCH]
            stats["api_calls"] += 1
            await _enrich_and_cache(company_id, at, chunk, stats)
    return stats


async def _enrich_and_cache(company_id: str, account_type: str,
                             chunk: list[tuple[dict, str, str]],
                             stats: dict) -> None:
    """One Plaid Enrich call for one account_type bucket. Writes the
    response into ``lab_enrich_cache`` (one row per input txn/cache_key).
    """
    from plaid.model.transactions_enrich_request import TransactionsEnrichRequest
    from plaid.model.transactions_enrich_request_options import TransactionsEnrichRequestOptions

    txns = [_sdk_txn(t, direction) for (t, direction, _k) in chunk]
    req = TransactionsEnrichRequest(
        account_type=account_type,
        transactions=txns,
        options=TransactionsEnrichRequestOptions(
            personal_finance_category_version=PFC_TAXONOMY_VERSION,
        ),
    )
    now = datetime.now(timezone.utc).isoformat()

    # Import the shared Plaid client. Never reads/writes to live pipeline
    # collections.
    from plaid_service import _client as plaid_client  # type: ignore

    try:
        t0 = time.time()
        resp = plaid_client.transactions_enrich(req)
        dur = time.time() - t0
        req_id = resp.get("request_id")
        rows = resp.get("enriched_transactions", [])
        by_id = {r.get("id"): r for r in rows}
        for (t, direction, cache_key) in chunk:
            row = by_id.get(t["id"]) or {}
            e = row.get("enrichments") or {}
            doc = {
                "cache_key":        cache_key,
                "company_id":       company_id,
                "created_at":       now,
                "enrich_available": True,
                "duration_s":       round(dur, 3),
                "request_id":       req_id,
                "input": {
                    "description":  t.get("description"),
                    "direction":    direction,
                    "account_type": account_type,
                    "mcc":          t.get("mcc"),
                    "location":     t.get("location"),
                },
                "merchant_name":       _to_dict(e.get("merchant_name")),
                "logo_url":            _to_dict(e.get("logo_url")),
                "merchant_entity_id":  _to_dict(e.get("entity_id")),
                "website":             _to_dict(e.get("website")),
                "counterparties":      _to_dict(e.get("counterparties") or []),
                "personal_finance_category":          _to_dict(e.get("personal_finance_category")),
                "personal_finance_category_icon_url": _to_dict(e.get("personal_finance_category_icon_url")),
                "pfc_taxonomy_version": PFC_TAXONOMY_VERSION,
            }
            await _upsert_cache(doc)
            if doc["merchant_name"] or doc["counterparties"]:
                stats["matched"] += 1
            else:
                stats["empty"] += 1
            await db["lab_transactions"].update_one(
                {"company_id": company_id, "txn_id": t["id"]},
                {"$set": {"enrich_cache_key": cache_key,
                          "enrich_source": "api"}},
            )
    except Exception as ex:                           # noqa: BLE001
        reason = _classify_error(ex)
        log.warning("lab.enrich: %s (n=%d) → %s", reason, len(chunk), ex)
        for (t, direction, cache_key) in chunk:
            doc = {
                "cache_key":        cache_key,
                "company_id":       company_id,
                "created_at":       now,
                "enrich_available": False,
                "reason":           reason,
                "input": {
                    "description":  t.get("description"),
                    "direction":    direction,
                    "account_type": account_type,
                    "mcc":          t.get("mcc"),
                    "location":     t.get("location"),
                },
                "pfc_taxonomy_version": PFC_TAXONOMY_VERSION,
            }
            await _upsert_cache(doc)
            stats["errors"] += 1
            stats["error_reasons"][reason] = stats["error_reasons"].get(reason, 0) + 1
            await db["lab_transactions"].update_one(
                {"company_id": company_id, "txn_id": t["id"]},
                {"$set": {"enrich_cache_key": cache_key,
                          "enrich_source": "error"}},
            )


def _to_dict(v):
    """Coerce a Plaid SDK model instance to a plain dict/list/scalar
    Mongo can persist. Falls back to ``str(v)`` for anything exotic."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, dict):
        return {k: _to_dict(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_to_dict(x) for x in v]
    # Plaid SDK models expose ``to_dict()``.
    if hasattr(v, "to_dict"):
        try:
            return _to_dict(v.to_dict())
        except Exception:                            # noqa: BLE001
            pass
    # datetime / date etc.
    return str(v)


def _classify_error(ex: Exception) -> str:
    body = str(getattr(ex, "body", "") or "")
    status = getattr(ex, "status", None)
    if status == 429:
        return "rate_limited"
    if "PRODUCT_NOT_ENABLED" in body or "SANDBOX_PRODUCT_NOT_ENABLED" in body:
        return "enrich_not_enabled"
    if "INVALID_INPUT" in body:
        return "invalid_input"
    if "INTERNAL_SERVER_ERROR" in body:
        return "plaid_5xx"
    if isinstance(ex, (ImportError, AttributeError)):
        return "sdk_missing"
    return "unknown"
