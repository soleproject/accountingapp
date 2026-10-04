"""Compliance watcher — produces the per-transaction `agent_findings` the
Quick Check-in compliance types consume, and auto-closes them when the
underlying transaction no longer needs anything.

Kinds produced (one finding per transaction, deduped on meta.txn_id):
  * missing_receipt   — outflow ≥ RECEIPT_THRESHOLD with no receipt attached
  * meals_compliance  — any charge booked to a Meals account without §274
                        substantiation (IRS waives the receipt under $75,
                        never the who/why)
  * travel_compliance — any charge booked to Travel / Lodging without
                        substantiation

Also applies the direction-vs-category sanity rule: money IN booked to an
expense account (or money OUT booked to income) can't be trusted no matter
what the AI's confidence says → `needs_review=True`, `review_reason`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from db import db, now_iso

logger = logging.getLogger(__name__)

RECEIPT_THRESHOLD = 75.0
LOOKBACK_DAYS = 30
MEALS_RE = r"meal|dining|restaurant"
TRAVEL_RE = r"travel|lodging|hotel|airfare|airline|mileage"
TRANSFER_RE = r"transfer|credit card|loan|owner|equity|draw|distribution"


def _since() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).date().isoformat()


def _no_receipt() -> dict:
    return {"$and": [
        {"$or": [{"receipt_id": {"$in": [None, ""]}}, {"receipt_id": {"$exists": False}}]},
        {"$or": [{"matched_receipt_id": {"$in": [None, ""]}}, {"matched_receipt_id": {"$exists": False}}]},
        {"$or": [{"veryfi_receipt_id": {"$in": [None, ""]}}, {"veryfi_receipt_id": {"$exists": False}}]},
    ]}


def _finding(cid: str, kind: str, t: dict, title: str, detail: str, severity: str = "amber") -> dict:
    return {
        "id": str(uuid.uuid4()), "company_id": cid, "kind": kind, "severity": severity,
        "status": "open", "title": title, "detail": detail, "created_at": now_iso(),
        "source": "compliance_watcher",
        "meta": {
            "txn_id": t["id"], "txn_date": (t.get("date") or "")[:10], "amount": float(t.get("amount") or 0),
            "txn_amount": float(t.get("amount") or 0), "description": t.get("description") or "",
            "vendor": t.get("merchant") or t.get("contact_name") or "", "merchant": t.get("merchant") or "",
            "category": t.get("category_account_name") or "", "account_id": t.get("bank_account_id") or t.get("account_id"),
        },
    }


async def _existing_txn_ids(cid: str, kind: str) -> set[str]:
    return {f["meta"]["txn_id"] async for f in db.agent_findings.find(
        {"company_id": cid, "kind": kind, "meta.txn_id": {"$exists": True}}, {"meta.txn_id": 1}) if f.get("meta", {}).get("txn_id")}


async def scan_company(cid: str, since: str | None = None, limit: int = 300) -> dict:
    since = since or _since()
    base = {"company_id": cid, "date": {"$gte": since}, "posted": {"$ne": False},
            "transfer_pair_id": {"$in": [None, ""]}, "deleted_at": {"$in": [None, ""]}}
    created = {"missing_receipt": 0, "meals_compliance": 0, "travel_compliance": 0, "sanity_flagged": 0, "closed": 0}
    new: list[dict] = []

    # Only real expenses need receipts — never loan/CC payments, transfers
    # or equity moves (those are liability/equity-side categories).
    expense_ids = [a["id"] async for a in db.accounts.find({"company_id": cid, "type": {"$in": ["expense", "cogs", "other_expense"]}}, {"id": 1})]
    income_ids = [a["id"] async for a in db.accounts.find({"company_id": cid, "type": {"$in": ["income", "revenue", "other_income"]}}, {"id": 1})]

    # 1. Missing receipts ≥ threshold on expense categories.
    have = await _existing_txn_ids(cid, "missing_receipt")
    async for t in db.transactions.find({**base, "amount": {"$lte": -RECEIPT_THRESHOLD}, **_no_receipt(),
                                         "category_account_id": {"$in": expense_ids},
                                         "category_account_name": {"$not": {"$regex": TRANSFER_RE, "$options": "i"}}}).limit(limit):
        if t["id"] in have:
            continue
        who = t.get("merchant") or t.get("contact_name") or t.get("description") or "this purchase"
        new.append(_finding(cid, "missing_receipt", t, f"Receipt needed · {who} · ${abs(float(t.get('amount') or 0)):,.2f}",
                            f"Do you have the receipt for {who} on {(t.get('date') or '')[:10]}? Snap a photo or upload it."))
        created["missing_receipt"] += 1

    # 2/3. Meals + travel substantiation — any amount.
    for kind, rx, label in (("meals_compliance", MEALS_RE, "meal"), ("travel_compliance", TRAVEL_RE, "trip")):
        have = await _existing_txn_ids(cid, kind)
        async for t in db.transactions.find({**base, "amount": {"$lt": 0},
                                             "category_account_name": {"$regex": rx, "$options": "i"},
                                             "irs_substantiation": {"$in": [None, {}]}}).limit(limit):
            if t["id"] in have:
                continue
            who = t.get("merchant") or t.get("description") or "this charge"
            new.append(_finding(cid, kind, t, f"{'Meal' if label == 'meal' else 'Travel'} · {who} · ${abs(float(t.get('amount') or 0)):,.2f}",
                                f"Who was this {label} with and what was the business purpose? ({who}, {(t.get('date') or '')[:10]})"))
            created[kind] += 1
    if new:
        await db.agent_findings.insert_many(new)

    # 4. Direction-vs-category sanity: inflow → expense, outflow → income.
    for ids, amt, reason in ((expense_ids, {"$gt": 0}, "Money received but booked to an expense account"),
                             (income_ids, {"$lt": 0}, "Money paid out but booked to an income account")):
        if not ids:
            continue
        r = await db.transactions.update_many(
            {**base, "amount": amt, "category_account_id": {"$in": ids}, "needs_review": {"$ne": True},
             "human_reviewed": {"$ne": True}, "sanity_flagged_at": {"$in": [None, ""]}},
            {"$set": {"needs_review": True, "review_reason": reason, "sanity_flagged_at": now_iso()}},
        )
        created["sanity_flagged"] += r.modified_count

    # 5. Auto-close findings whose transaction is now satisfied.
    async for f in db.agent_findings.find({"company_id": cid, "status": "open", "source": "compliance_watcher",
                                           "kind": {"$in": ["missing_receipt", "meals_compliance", "travel_compliance"]}}):
        tid = (f.get("meta") or {}).get("txn_id")
        t = await db.transactions.find_one({"id": tid}, {"receipt_id": 1, "matched_receipt_id": 1, "veryfi_receipt_id": 1, "irs_substantiation": 1, "deleted_at": 1}) if tid else None
        satisfied = (t is None or t.get("deleted_at")
                     or (f["kind"] == "missing_receipt" and (t.get("receipt_id") or t.get("matched_receipt_id") or t.get("veryfi_receipt_id")))
                     or (f["kind"] != "missing_receipt" and t.get("irs_substantiation")))
        if satisfied:
            await db.agent_findings.update_one({"id": f["id"]}, {"$set": {"status": "resolved", "resolved_at": now_iso(), "resolved_by": "compliance_watcher"}})
            created["closed"] += 1
    return created


async def historical_scan(cid: str, since: str) -> dict:
    """One-time backfill: scan from `since` (YYYY-MM-DD) so older items land
    on the grey Clean Up pile via graduate_company_to_cleanup. Not run by the tick."""
    from client_review import graduate_company_to_cleanup
    r = await scan_company(cid, since=since, limit=5000)
    r["graduated"] = await graduate_company_to_cleanup(cid)
    return r


async def scan_all() -> dict:
    totals: dict[str, int] = {}
    async for c in db.companies.find({}, {"id": 1}):
        try:
            r = await scan_company(c["id"])
        except Exception:  # noqa: BLE001
            logger.exception("compliance scan failed for %s", c["id"])
            continue
        for k, v in r.items():
            totals[k] = totals.get(k, 0) + v
    return totals
