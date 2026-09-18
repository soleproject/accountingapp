"""Step 1 — copy stored Plaid fields into a read-only raw block.

The live pipeline stamps Plaid-derived fields on the transaction doc
at ingest, then subsequent Stage 2/3/AI passes and manual edits can
overwrite some of them. The lab preserves whatever survives on the
live doc as an immutable ``raw`` sub-document on ``lab_transactions``.

Fields we snapshot (mirrors ``plaid_service._serialize_txn`` /
``plaid_connect.categorize_and_insert_plaid_txns``):
    original_description, merchant_name, merchant_entity_id,
    counterparties[], pfc_primary, pfc_detailed, pfc_confidence_level,
    transaction_code, payment_channel, check_number, location, pending,
    authorized_date, plaid_transaction_id, bank_account_id, amount,
    date, account_id.

Overwritten-fields report: we cannot compare against Plaid directly
(that would require re-calling the API). Instead we compare a few
"should be immutable if Plaid-fed" fields — if the live doc has
``merchant`` mutated away from ``merchant_name`` we surface that; if
``category_account_id`` was ever set we note the row has been
categorized so Plaid's original suggestion isn't visible.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from db import db
from .collections import LAB_TRANSACTIONS

log = logging.getLogger("axiom.lab.step1")

RAW_FIELDS = (
    "original_description",
    "merchant_name",
    "merchant_entity_id",
    "counterparties",
    "pfc_primary",
    "pfc_detailed",
    "pfc_confidence_level",
    "transaction_code",
    "payment_channel",
    "check_number",
    "location",
    "pending",
    "authorized_date",
    "plaid_transaction_id",
)


def _snapshot_raw(t: dict) -> dict:
    return {k: t.get(k) for k in RAW_FIELDS}


def detect_overwrites(t: dict) -> list[str]:
    """Return a list of short strings for fields we can tell were
    mutated after the initial Plaid stamp. Diagnostic only."""
    out: list[str] = []
    mn = (t.get("merchant_name") or "").strip()
    m  = (t.get("merchant") or "").strip()
    if mn and m and mn.lower() != m.lower():
        out.append("merchant_diverged_from_merchant_name")
    # pfc_detailed downgraded to null or "UNCATEGORIZED"
    pfc = (t.get("pfc_detailed") or "").strip().upper()
    if pfc in ("", "UNCATEGORIZED", "GENERAL_UNCATEGORIZED"):
        if t.get("pfc_primary") and t["pfc_primary"] not in ("", "GENERAL_UNCATEGORIZED"):
            out.append("pfc_detailed_downgraded")
    # counterparties truncated
    if (t.get("counterparties") is None) and (t.get("merchant_name")):
        out.append("counterparties_missing_but_merchant_present")
    return out


async def upsert_raw_batch(company_id: str, txns: list[dict]) -> dict:
    """Upsert one ``lab_transactions`` doc per live txn, populating
    only the raw block (later steps set movement / parse fields).
    Idempotent — safe to re-run."""
    upserted = 0
    overwrite_counts: dict[str, int] = {}
    now = datetime.now(timezone.utc).isoformat()
    for t in txns:
        tid = t.get("id")
        if not tid:
            continue
        raw = _snapshot_raw(t)
        overwrites = detect_overwrites(t)
        for o in overwrites:
            overwrite_counts[o] = overwrite_counts.get(o, 0) + 1
        # Mirror the top-level fields the reader needs read-only.
        doc = {
            "company_id":        company_id,
            "txn_id":            tid,
            "date":              t.get("date"),
            "amount":            t.get("amount"),
            "bank_account_id":   t.get("bank_account_id"),
            "account_id":        t.get("account_id"),
            "description_live":  t.get("description"),
            "merchant_live":     t.get("merchant"),
            "contact_id_live":   t.get("contact_id"),
            "contact_name_live": t.get("contact_name"),
            "category_account_id_live": t.get("category_account_id"),
            "transfer_pair_id_live":    t.get("transfer_pair_id"),
            "is_internal_transfer_live": t.get("is_internal_transfer"),
            "human_reviewed_live":       bool(t.get("human_reviewed")),
            "raw":               raw,
            "raw_overwrites":    overwrites,
            "phase":             1,
            "phase1_at":         now,
        }
        await db[LAB_TRANSACTIONS].update_one(
            {"company_id": company_id, "txn_id": tid},
            {"$set": doc}, upsert=True,
        )
        upserted += 1
    log.info("lab.step1: upserted %d rows for company %s", upserted, company_id)
    return {"upserted": upserted, "overwrite_counts": overwrite_counts}
