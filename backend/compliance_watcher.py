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
import receipt_policy

logger = logging.getLogger(__name__)

RECEIPT_THRESHOLD = receipt_policy.RECEIPT_FLOOR
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

    # 1. Missing receipts — receipt_policy decides (point-of-sale only, never bills/transfers/P2P).
    have = await _existing_txn_ids(cid, "missing_receipt")
    cands = [t async for t in db.transactions.find({**base, "amount": {"$lte": -RECEIPT_THRESHOLD}, **_no_receipt(),
                                                    "category_account_id": {"$in": expense_ids}}).limit(limit) if t["id"] not in have]
    decisions = await receipt_policy.decide(cid, cands)
    for t in cands:
        d = decisions.get(t["id"])
        if not d or not d.flag:
            continue
        title, detail = receipt_policy.finding_text(t, d)
        f = _finding(cid, "missing_receipt", t, title, detail)
        f["meta"]["reason_code"], f["meta"]["reason_label"] = d.reason, d.label
        new.append(f)
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

    # 5. Auto-close findings whose transaction is now satisfied — or, for
    # receipts, no longer qualifies under receipt_policy.
    open_f = await db.agent_findings.find({"company_id": cid, "status": "open",
                                           "$or": [{"source": "compliance_watcher"}, {"kind": "missing_receipt"}],
                                           "kind": {"$in": ["missing_receipt", "meals_compliance", "travel_compliance"]}}).to_list(5000)
    # Seeded/legacy receipt findings carry no txn_id — resolve by amount + date so the policy can judge them.
    for f in open_f:
        meta = f.setdefault("meta", {})
        if f["kind"] == "missing_receipt" and not meta.get("txn_id") and meta.get("txn_amount") is not None and meta.get("txn_date"):
            hit = await db.transactions.find_one({"company_id": cid, "amount": float(meta["txn_amount"]), "date": meta["txn_date"],
                                                  "deleted_at": {"$in": [None, ""]}}, {"id": 1})
            if hit:
                meta["txn_id"] = hit["id"]
                await db.agent_findings.update_one({"id": f["id"]}, {"$set": {"meta.txn_id": hit["id"]}})
    tids = [(f.get("meta") or {}).get("txn_id") for f in open_f if (f.get("meta") or {}).get("txn_id")]
    txn_by_id = {t["id"]: t async for t in db.transactions.find({"id": {"$in": tids}})}
    rec_tids = {(f.get("meta") or {}).get("txn_id") for f in open_f if f["kind"] == "missing_receipt"}
    rec_decisions = await receipt_policy.decide(cid, [t for tid, t in txn_by_id.items() if tid in rec_tids])
    for f in open_f:
        tid = (f.get("meta") or {}).get("txn_id")
        t = txn_by_id.get(tid) if tid else None
        satisfied = (t is None or t.get("deleted_at")
                     or (f["kind"] == "missing_receipt" and not rec_decisions.get(tid, receipt_policy.Decision(True, "")).flag)
                     or (f["kind"] != "missing_receipt" and t.get("irs_substantiation")))
        if satisfied:
            await db.agent_findings.update_one({"id": f["id"]}, {"$set": {"status": "resolved", "resolved_at": now_iso(), "resolved_by": "compliance_watcher",
                                                                          "resolved_reason": (rec_decisions.get(tid).reason if tid in rec_decisions else "txn_gone")}})
            created["closed"] += 1
        elif f["kind"] == "missing_receipt" and tid in rec_decisions and (f.get("meta") or {}).get("reason_code") != rec_decisions[tid].reason:
            d = rec_decisions[tid]
            title, detail = receipt_policy.finding_text(t, d)
            await db.agent_findings.update_one({"id": f["id"]}, {"$set": {"title": title, "detail": detail, "meta.reason_code": d.reason, "meta.reason_label": d.label}})
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
