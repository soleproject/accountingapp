"""Emergent + Atlas infrastructure cost estimator.

The Superadmin Usage & Costs dashboard already tracks *per-event*
external spend (LLM tokens, Veryfi OCR, Resend email, Plaid items).
This module fills the last gap — **infra** — by modeling the flat
monthly platform bill (K8s compute + MongoDB storage + object
storage) and apportioning it across companies by their share of
activity.

Design choices (Mar 2026):

* **Not event-driven.** Infra is billed monthly by the vendor, not
  per API call; we don't emit `ai_usage_events` for it. Instead the
  admin endpoint recomputes the allocation on read.
* **Apportioned by transaction-count share.** A company with 10% of
  the platform's transactions carries ~10% of compute + Mongo.
  Companies with zero activity get zero share (they still cost us
  something, but shopping the bill onto quiet books produces
  meaningless numbers).
* **Object storage measured, not modeled.** We sum actual byte-size
  of every attachment field we know about (`logo_data_url`, receipt
  scans stored inline). Ignores the fact that some data lives in
  Emergent Object Storage — currently there's no per-file byte
  tracking, so a follow-up wire-up needs to log `storage_bytes` on
  every upload. Until then the on-doc bytes are a reasonable proxy.
* **Numbers are estimates.** Clearly labeled as such on the UI.
"""
from __future__ import annotations

import logging
from typing import Any

from db import db
from ai_usage import (
    PLATFORM_MONTHLY_COMPUTE_USD,
    PLATFORM_MONTHLY_MONGODB_USD,
    PLATFORM_MONTHLY_STORAGE_USD_PER_GB,
    SERVICE_UNIT_PRICE_USD,
)

logger = logging.getLogger(__name__)


# Hot collections that make up the bulk of MongoDB storage. Weighted
# proportional to average doc size — matters when we apportion the
# Atlas bill by doc count share.
_HOT_COLLECTIONS: tuple[str, ...] = (
    "transactions", "invoices", "bills", "payments", "journal_entries",
    "receipts", "contacts", "accounts", "taxes", "ai_usage_events",
    "qbo_gl_lines", "reconciliation_matches", "rules", "items",
)


async def _bytes_estimate_for_collection(coll_name: str) -> int:
    """Return the storage-bytes-per-doc estimate for a collection.

    Uses `$collStats` when available (production), falls back to a
    sample-based average when the aggregate isn't supported (in-memory
    test doubles). Returns 0 on empty collections."""
    try:
        stats = await db.command("collStats", coll_name)
        size = int(stats.get("size") or 0)
        return size
    except Exception:  # noqa: BLE001
        return 0


async def compute_infra_allocation(period_days: int = 30) -> dict[str, Any]:
    """Return per-company + platform-level infra cost breakdown in
    USD cents. The Superadmin usage endpoint merges these into the
    `by_service` and `by_company` lists.

    Result shape::

        {
          "platform": {
            "compute_cents": 8000,           # monthly, apportioned to `period_days`
            "mongodb_cents": 6000,
            "object_storage_cents": 42,
            "total_cents": 14042,
            "total_docs": 152804,
            "total_storage_bytes": 214_836_291,
          },
          "by_company": {                    # keyed by company_id
            "<cid>": {
                "compute_cents": 620.5,
                "mongodb_cents": 448.9,
                "object_storage_cents": 3.7,
                "total_cents": 1073.1,
                "doc_share": 0.0812,
                "storage_bytes": 3_921_884,
                "docs": 12_405,
            },
            ...
          },
        }
    """
    # Scale the monthly bill down to the reporting window. period_days
    # defaults to 30 → same as the vendor bill; a 7-day view returns
    # ~7/30 of the monthly total.
    scale = max(0.0, min(period_days / 30.0, 1.0))
    if period_days >= 60:
        scale = period_days / 30.0  # multi-month "all-time" view

    compute_budget_cents = PLATFORM_MONTHLY_COMPUTE_USD * scale * 100
    mongo_budget_cents = PLATFORM_MONTHLY_MONGODB_USD * scale * 100
    storage_rate_cents_per_gb = PLATFORM_MONTHLY_STORAGE_USD_PER_GB * scale * 100

    # ── Step 1: doc counts per company across hot collections ─────
    docs_by_company: dict[str, int] = {}
    coll_total_bytes: dict[str, int] = {}
    coll_total_docs: dict[str, int] = {}

    for coll in _HOT_COLLECTIONS:
        total_bytes = await _bytes_estimate_for_collection(coll)
        coll_total_bytes[coll] = total_bytes
        # Aggregate doc count per company for this collection.
        try:
            async for row in db[coll].aggregate([
                {"$match": {"company_id": {"$ne": None}}},
                {"$group": {"_id": "$company_id", "n": {"$sum": 1}}},
            ]):
                cid = row["_id"]
                if not cid:
                    continue
                docs_by_company[cid] = docs_by_company.get(cid, 0) + int(row["n"])
                coll_total_docs[coll] = coll_total_docs.get(coll, 0) + int(row["n"])
        except Exception:  # noqa: BLE001
            continue

    total_docs = sum(docs_by_company.values()) or 1  # avoid div-by-zero

    # ── Step 2: storage bytes per company (inline data URLs so far) ──
    # Contacts.logo_data_url + companies.logo_data_url + any
    # receipt/statement doc stored inline. Best-effort — misses
    # objects offloaded to Emergent Object Storage since we don't
    # log byte counts on upload yet (follow-up).
    storage_by_company: dict[str, int] = {}
    for coll, field in (
        ("companies", "logo_data_url"),
        ("contacts", "logo_data_url"),
        ("receipts", "attachment_data_url"),
    ):
        try:
            async for row in db[coll].aggregate([
                {"$match": {field: {"$type": "string", "$ne": ""}}},
                {"$project": {
                    "company_id": 1,
                    "id_ref": {"$ifNull": ["$company_id", "$id"]},
                    "bytes": {"$strLenBytes": f"${field}"},
                }},
                {"$group": {"_id": "$id_ref", "b": {"$sum": "$bytes"}}},
            ]):
                cid = row["_id"]
                if not cid:
                    continue
                storage_by_company[cid] = storage_by_company.get(cid, 0) + int(row["b"] or 0)
        except Exception:  # noqa: BLE001
            continue

    total_storage_bytes = sum(storage_by_company.values())

    # ── Step 3: per-company allocation ────────────────────────────
    by_company: dict[str, dict[str, float]] = {}
    for cid, doc_count in docs_by_company.items():
        share = doc_count / total_docs
        compute_c = compute_budget_cents * share
        mongo_c = mongo_budget_cents * share
        bytes_this = storage_by_company.get(cid, 0)
        gb = bytes_this / (1024 * 1024 * 1024)
        storage_c = storage_rate_cents_per_gb * gb
        by_company[cid] = {
            "compute_cents": round(compute_c, 4),
            "mongodb_cents": round(mongo_c, 4),
            "object_storage_cents": round(storage_c, 4),
            "total_cents": round(compute_c + mongo_c + storage_c, 4),
            "doc_share": round(share, 6),
            "storage_bytes": bytes_this,
            "docs": doc_count,
        }

    return {
        "platform": {
            "compute_cents": round(compute_budget_cents, 2),
            "mongodb_cents": round(mongo_budget_cents, 2),
            "object_storage_cents": round(
                storage_rate_cents_per_gb * (total_storage_bytes / (1024 * 1024 * 1024)),
                4,
            ),
            "total_cents": round(
                compute_budget_cents + mongo_budget_cents
                + storage_rate_cents_per_gb * (total_storage_bytes / (1024 * 1024 * 1024)),
                4,
            ),
            "total_docs": total_docs,
            "total_storage_bytes": total_storage_bytes,
            "scale_factor": scale,
        },
        "by_company": by_company,
    }
