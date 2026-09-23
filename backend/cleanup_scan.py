"""Cleanup scan — surfaces historical (pre-today) transactions that
match the compliance flags a user opted into on `/welcome`.

Design
------
* The user's Yes/No answers on `/welcome` are persisted to
  `company.compliance_flags` (see `Welcome.jsx` → `PATCH /companies`).
* When the user clicks "Next step", the frontend also calls
  `POST /companies/{cid}/cleanup/kickoff`, which drops a row into
  `db.cleanup_jobs` with `status: "pending"` and a `scheduled_at`
  ~24h in the future (with jitter, see `cleanup.py`).
* A periodic scheduler (`cleanup_scheduler.py`) wakes up every few
  minutes, picks pending jobs whose `scheduled_at <= now`, verifies
  the company's initial Plaid historical sync has completed, and
  calls :func:`run_scan_for_company` here to do the actual work.

Result
------
We reuse the existing `client_review_batches` collection but tag the
new document with ``kind: "cleanup"`` (existing forward-looking
batches are un-tagged / read as ``"forward"`` by default). The
Cockpit's `responsibilities` endpoint reads both kinds and returns
two count buckets — the frontend renders a grey "Clean Up · X" card
whenever ``cleanup_count > 0``.

The item shape is identical to forward batches — same item_type,
same context, same open/complete UX — so **the grey card behaves
exactly like the green one**.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from db import db
from client_review import (
    ITEM_MISSING_RECEIPT, ITEM_LIABILITY_SPLIT,
    ITEM_IRS_MEALS, ITEM_IRS_TRAVEL,
)

log = logging.getLogger("axiom.cleanup_scan")

# Cap on items we surface per bucket so a merchant with 5 years of
# messy history doesn't get a 4,000-item wall of shame. Anything
# beyond this is still there in the DB — the card can say "+N more".
MAX_ITEMS_PER_BUCKET = 250


def _floor(months: int | None) -> str | None:
    """Return YYYY-MM-DD `months` back from today, or None for all-time."""
    if not months:
        return None
    now = datetime.now(timezone.utc).date()
    y, m = now.year, now.month - int(months)
    while m <= 0:
        m += 12
        y -= 1
    return f"{y:04d}-{m:02d}-{now.day:02d}"


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


async def _scan_missing_receipts(
    cid: str, months: int | None, cap: int,
) -> list[dict[str, Any]]:
    """Find historical expense transactions ≥ $75 with no receipt attached.

    Liability-account payments are excluded — they're a distinct
    workflow ("split principal vs. interest") handled by
    :func:`_scan_liability_splits`, so surfacing them in both cards
    would just double-count the same txn.
    """
    floor = _floor(months)
    liab_ids: list[str] = await db.accounts.distinct(
        "id", {"company_id": cid, "type": "liability"},
    )
    query: dict[str, Any] = {
        "company_id": cid,
        "type": "expense",
        "amount": {"$lte": -75.0},
        "$and": [
            {"$or": [{"attachments": {"$exists": False}}, {"attachments": []}]},
            {"date": {"$lt": _today_iso()}},   # strictly historical
        ],
    }
    if liab_ids:
        query["$and"].append({
            "$or": [
                {"category_account_id": {"$exists": False}},
                {"category_account_id": {"$nin": liab_ids}},
            ],
        })
    if floor:
        query["$and"].append({"date": {"$gte": floor}})
    txns = await db.transactions.find(query).sort([("date", -1)]).limit(cap).to_list(cap)
    items: list[dict[str, Any]] = []
    for t in txns:
        amount = abs(float(t.get("amount") or 0))
        items.append({
            "item_id": str(uuid.uuid4()),
            "item_type": ITEM_MISSING_RECEIPT,
            "source_id": t.get("id"),
            "source_collection": "transactions",
            "prompt": f"Missing receipt: ${amount:,.2f} on {t.get('date','')}",
            "context": {
                "date": t.get("date"),
                "amount": amount,
                "vendor": t.get("contact_name") or t.get("description") or "",
                "description": t.get("description") or "",
            },
            "answered_at": None, "answer": None,
            "deferred": False, "action_taken": None,
        })
    return items


async def _scan_liability_splits(
    cid: str, months: int | None, cap: int,
) -> list[dict[str, Any]]:
    """Find historical expense transactions posted to a liability account
    that haven't been split into principal/interest yet."""
    floor = _floor(months)
    liab_ids: list[str] = await db.accounts.distinct(
        "id", {"company_id": cid, "type": "liability"},
    )
    if not liab_ids:
        return []
    query: dict[str, Any] = {
        "company_id": cid,
        "category_account_id": {"$in": liab_ids},
        "type": "expense",
        "$or": [{"split_reviewed": False}, {"split_reviewed": {"$exists": False}}],
        "date": {"$lt": _today_iso()},
    }
    if floor:
        query["date"]["$gte"] = floor
    txns = await db.transactions.find(query).sort([("date", -1)]).limit(cap).to_list(cap)
    items: list[dict[str, Any]] = []
    for t in txns:
        amount = abs(float(t.get("amount") or 0))
        items.append({
            "item_id": str(uuid.uuid4()),
            "item_type": ITEM_LIABILITY_SPLIT,
            "source_id": t.get("id"),
            "source_collection": "transactions",
            "prompt": f"Split principal vs. interest: ${amount:,.2f} on {t.get('date','')}",
            "context": {
                "date": t.get("date"),
                "amount": amount,
                "vendor": t.get("contact_name") or t.get("description") or "",
                "account_id": t.get("category_account_id"),
            },
            "answered_at": None, "answer": None,
            "deferred": False, "action_taken": None,
        })
    return items


async def _scan_irs_docs(
    cid: str, months: int | None, cap: int,
) -> list[dict[str, Any]]:
    """Find agent_findings requiring §274 substantiation (meals + travel)."""
    floor = _floor(months)
    query: dict[str, Any] = {
        "company_id": cid,
        "kind": {"$in": ["meals_compliance", "travel_compliance"]},
        "status": {"$in": [None, "open", "pending"]},
    }
    # findings don't have a `date` field of their own — filter on the
    # underlying txn date stored in meta.txn_date, or the record's
    # creation timestamp as a fallback.
    date_conds: list[dict[str, Any]] = [{"meta.txn_date": {"$lt": _today_iso()}}]
    if floor:
        date_conds.append({"meta.txn_date": {"$gte": floor}})
    query["$and"] = date_conds
    findings = await db.agent_findings.find(query).sort([("created_at", -1)]).limit(cap).to_list(cap)
    items: list[dict[str, Any]] = []
    for f in findings:
        kind = f.get("kind") or ""
        meta = f.get("meta") or {}
        item_type = ITEM_IRS_MEALS if kind == "meals_compliance" else ITEM_IRS_TRAVEL
        amount = float(meta.get("amount") or 0)
        items.append({
            "item_id": str(uuid.uuid4()),
            "item_type": item_type,
            "source_id": f.get("id"),
            "source_collection": "agent_findings",
            "prompt": f.get("summary") or ("§274 meals substantiation needed"
                                            if kind == "meals_compliance"
                                            else "§274 travel substantiation needed"),
            "context": {
                "date": meta.get("txn_date"),
                "amount": amount,
                "vendor": meta.get("vendor") or "",
                "kind": "meals" if item_type == ITEM_IRS_MEALS else "travel",
            },
            "answered_at": None, "answer": None,
            "deferred": False, "action_taken": None,
        })
    return items


async def run_scan_for_company(job: dict) -> dict:
    """Run all enabled scans for a company and upsert one cleanup batch.

    Returns a dict with counts per bucket + total items created — used
    by the scheduler for logging and for the job doc's final state.
    """
    cid = job["company_id"]
    flags = job.get("flags") or {}
    months = job.get("months") or {}

    all_items: list[dict[str, Any]] = []

    if flags.get("receipts"):
        all_items += await _scan_missing_receipts(
            cid, months.get("receipts"), MAX_ITEMS_PER_BUCKET,
        )
    if flags.get("liabilities"):
        all_items += await _scan_liability_splits(
            cid, months.get("liabilities"), MAX_ITEMS_PER_BUCKET,
        )
    if flags.get("irs"):
        all_items += await _scan_irs_docs(
            cid, months.get("irs"), MAX_ITEMS_PER_BUCKET,
        )

    now_iso = datetime.now(timezone.utc).isoformat()

    # Upsert the single cleanup batch for this company. If one exists
    # already we merge — additive: existing (still-unanswered) items
    # are preserved, freshly-found ones are appended, deduped on
    # source_id + item_type.
    existing = await db.client_review_batches.find_one({
        "company_id": cid, "kind": "cleanup",
    })
    if existing:
        prior = existing.get("items") or []
        seen = {(i.get("source_id"), i.get("item_type")) for i in prior}
        merged = list(prior)
        for it in all_items:
            key = (it["source_id"], it["item_type"])
            if key in seen:
                continue
            seen.add(key)
            merged.append(it)
        await db.client_review_batches.update_one(
            {"id": existing["id"]},
            {"$set": {
                "items": merged,
                "last_scan_at": now_iso,
                "status": "open" if any(not x.get("answered_at") for x in merged) else "completed",
            }},
        )
        return {
            "batch_id": existing["id"],
            "created": False,
            "items_added": len(merged) - len(prior),
            "items_total": len(merged),
        }

    # No existing cleanup batch — create one.
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "owner_email": 1})
    client_email = (company or {}).get("owner_email") or ""
    batch = {
        "id": str(uuid.uuid4()),
        "kind": "cleanup",   # discriminator vs forward-looking
        "company_id": cid,
        "client_email": client_email,
        # Cleanup batches don't have a magic-link check-in (per the
        # product spec — clients don't see cleanup items in Quick
        # Check-in). Token is intentionally blank.
        "client_token": "",
        "items": all_items,
        "status": "open" if all_items else "empty",
        "created_at": now_iso,
        "last_scan_at": now_iso,
        "email_sent_at": None,
        "scheduled_for": None,
        "reminder_sent_at": None,
        "nudge_sent_at": None,
        "completed_at": None,
        "answer_count": 0,
        "defer_count": 0,
        "expires_at": None,   # cleanup doesn't expire — merchant works it down
    }
    if all_items:
        await db.client_review_batches.insert_one(batch)
    return {
        "batch_id": batch["id"],
        "created": True,
        "items_added": len(all_items),
        "items_total": len(all_items),
    }
