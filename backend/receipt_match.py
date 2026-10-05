"""
receipt_match — link AI-scanned receipts to bank/CC transactions.

The AI Receipts flow can save a receipt BEFORE the matching bank/CC
transaction has landed via Plaid (e.g. user snaps a receipt in-store
before the CC ACH clears), or AFTER (user categorizes a Plaid-imported
transaction, then decides to attach receipt detail).

To keep the ledger honest — never DR expense from two sources for the
same purchase — we:

  * At receipt save time, look for a transaction on the same
    (bank_account_id, date, abs(amount)). If found, copy the receipt's
    line-item split onto the transaction, link both docs, and REVERSE
    the receipt's own JE (transaction becomes source of truth).

  * At Plaid ingest time (after new transactions are inserted), scan
    for unmatched receipts on the same key. Same treatment.

Personal-account path: if the user chose "Personal Account" in the
paid-from resolver, we auto-create/return a liability account
`2350 · Due to Owner` and stamp the receipt with `paid_personally=True`.
The receipt still posts a JE (DR expense / CR Due to Owner) because
there's no matching bank transaction — the company genuinely owes the
owner until reimbursement.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db

logger = logging.getLogger(__name__)


# Cent-level tolerance for amount comparison. Plaid rounds to cents;
# receipts are user-typed so allow $0.01 slop for OCR rounding.
_AMT_TOL = 0.01

# Owner-liability defaults. "Due to Owner" is the conventional US
# small-business bookkeeping label; code 2350 sits between AP (2100)
# and taxes (2400) in a standard CoA.
_OWNER_LIABILITY_CODE = "2350"
_OWNER_LIABILITY_NAME = "Due to Owner"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_or_create_owner_liability(company_id: str) -> dict:
    """Find the Due-to-Owner liability account, or create it if it
    doesn't exist yet. Returns the account dict.

    Called by the paid-from resolver when the user picks "Personal
    Account" — the receipt's credit side lands here so the ledger
    reflects that the company still owes the owner for the purchase.
    """
    # First pass — match by NAME (never by code, since 2350 varies by
    # CoA seed — some templates use it for Payroll Liabilities, etc.).
    hit = await db.accounts.find_one({
        "company_id": company_id,
        "type": "liability",
        "$or": [
            {"name": {"$regex": r"^due\s+to\s+owner", "$options": "i"}},
            {"name": {"$regex": r"^owner.*reimburs", "$options": "i"}},
            {"name": {"$regex": r"^owner\s+loan(s)?\s+payable",
                      "$options": "i"}},
        ],
    })
    if hit:
        return hit

    # Not found — pick a free code in the 2350-2399 band. Fall back to
    # a stable string code if every numeric slot is taken (rare).
    chosen_code = None
    for c in [str(n) for n in range(2350, 2400)]:
        taken = await db.accounts.find_one({"company_id": company_id, "code": c})
        if not taken:
            chosen_code = c
            break
    if not chosen_code:
        chosen_code = "OWNER-LIAB"

    # Create it. Use a stable id and mimic the shape used by other seed
    # accounts. `parent_id=None` since we're creating it as a top-level
    # current liability.
    doc = {
        "id":          f"owner-liab-{uuid.uuid4().hex[:12]}",
        "company_id":  company_id,
        "code":        chosen_code,
        "name":        _OWNER_LIABILITY_NAME,
        "type":        "liability",
        "subtype":     "current_liability",
        "detail_type": "other_current_liabilities",
        "parent_id":   None,
        "active":      True,
        "created_at":  _now_iso(),
        "updated_at":  _now_iso(),
        # Auditors will pick this up as system-generated so the CoA
        # cleanup pass doesn't try to merge it into an existing bucket.
        "system_generated":     True,
        "auto_created_purpose": "owner_reimbursement_receipt",
    }
    await db.accounts.insert_one(doc)
    logger.info("owner-liability account created for company %s: %s",
                company_id, doc["id"])
    return doc


# Fuzzy matching (Oct 2026) — mirrors how Dext/Hubdoc/QBO pair receipts:
# ±DATE_WINDOW days, exact-or-tip amount tolerance, merchant-name
# similarity and same-account bonus, rolled into a 0-100 score.
_DATE_WINDOW_DAYS = 5
_TIP_MAX_RATIO = 1.30          # card charge may exceed receipt by up to 30% (tip)
HIGH_CONFIDENCE = 85           # auto-link
MEDIUM_CONFIDENCE = 55         # show as "Suggested match"

_STOP = {"the", "inc", "llc", "ltd", "co", "corp", "store", "pos", "purchase", "debit", "card", "payment", "online", "www", "com"}


def _tokens(s: Optional[str]) -> set[str]:
    import re as _re
    return {t for t in _re.findall(r"[a-z0-9]+", (s or "").lower()) if len(t) > 1 and t not in _STOP and not t.isdigit()}


def _name_sim(a: Optional[str], b: Optional[str]) -> Optional[float]:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return None
    inter = len(ta & tb)
    if inter == 0:
        # prefix containment ("starbucks" vs "starbucks #1234 seattle")
        return 1.0 if any(x.startswith(y) or y.startswith(x) for x in ta for y in tb if min(len(x), len(y)) >= 4) else 0.0
    return inter / min(len(ta), len(tb))


def _days_between(a: str, b: str) -> Optional[int]:
    try:
        return abs((datetime.fromisoformat(a[:10]) - datetime.fromisoformat(b[:10])).days)
    except Exception:  # noqa: BLE001
        return None


def _date_range(date: str) -> tuple[str, str]:
    from datetime import timedelta
    d = datetime.fromisoformat(date[:10])
    return (d - timedelta(days=_DATE_WINDOW_DAYS)).date().isoformat(), (d + timedelta(days=_DATE_WINDOW_DAYS)).date().isoformat()


def score_pair(*, r_amount: float, r_date: str, r_merchant: Optional[str], r_account: Optional[str],
               t_amount: float, t_date: str, t_desc: Optional[str], t_accounts: set[str]) -> tuple[int, list[str]]:
    """Score how likely a receipt and a transaction are the same purchase."""
    ra, ta = abs(float(r_amount or 0)), abs(float(t_amount or 0))
    if not ra or not ta:
        return 0, []
    pts, why = 0, []
    diff = abs(ra - ta)
    if diff <= _AMT_TOL:
        pts += 50; why.append("exact amount")
    elif diff / ra <= 0.01:
        pts += 40; why.append("amount within 1%")
    elif ra < ta <= ra * _TIP_MAX_RATIO:
        pts += 25; why.append(f"amount +${ta - ra:.2f} (tip?)")
    else:
        return 0, []
    days = _days_between(r_date, t_date)
    if days is None or days > _DATE_WINDOW_DAYS:
        return 0, []
    # Same-day gets a clear edge over a 1-day neighbour so an exact-date
    # twin charge (same merchant, same amount, next day) doesn't force
    # the "ambiguous" path. Two charges on the SAME day still tie → suggest.
    pts += {0: 35, 1: 20, 2: 12, 3: 12}.get(days, 6)
    why.append("same day" if days == 0 else f"{days} day{'s' if days != 1 else ''} apart")
    if r_account:
        if r_account in t_accounts:
            pts += 15; why.append("same account")
        else:
            pts -= 10
    sim = _name_sim(r_merchant, t_desc)
    if sim is not None:
        if sim >= 0.8:
            pts += 20; why.append("merchant matches")
        elif sim >= 0.5:
            pts += 10; why.append("merchant similar")
        elif sim == 0.0:
            pts -= 5
    return max(0, pts), why  # uncapped so near-twins keep their gap


def _confidence(score: int) -> Optional[str]:
    if score >= HIGH_CONFIDENCE:
        return "high"
    if score >= MEDIUM_CONFIDENCE:
        return "medium"
    return None


async def rank_transactions_for_receipt(
    company_id: str, *, account_id: Optional[str], date: str, amount: float,
    merchant: Optional[str] = None, limit: int = 5,
) -> list[dict]:
    """Unmatched transactions within the window, scored and sorted."""
    if not (date and amount):
        return []
    lo, hi = _date_range(date)
    amt = abs(float(amount))
    cursor = db.transactions.find({
        "company_id": company_id,
        "date": {"$gte": lo, "$lte": hi},
        "$or": [{"matched_receipt_id": {"$in": [None, ""]}}, {"matched_receipt_id": {"$exists": False}}],
    }, {"_id": 0})
    out = []
    async for t in cursor:
        ta = abs(float(t.get("amount") or 0))
        if ta < amt - 0.5 or ta > amt * _TIP_MAX_RATIO + 0.5:
            continue
        score, why = score_pair(
            r_amount=amt, r_date=date, r_merchant=merchant, r_account=account_id,
            t_amount=ta, t_date=t.get("date") or "", t_desc=t.get("description") or t.get("merchant_name"),
            t_accounts={t.get("bank_account_id"), t.get("plaid_account_id")} - {None, ""},
        )
        conf = _confidence(score)
        if conf:
            out.append({"txn": t, "score": score, "confidence": conf, "reasons": why})
    out.sort(key=lambda x: -x["score"])
    return out[:limit]


async def rank_receipts_for_transaction(company_id: str, txn: dict, *, limit: int = 5) -> list[dict]:
    """Unmatched receipts that plausibly belong to this transaction."""
    date, amt = txn.get("date") or "", abs(float(txn.get("amount") or 0))
    if not (date and amt):
        return []
    lo, hi = _date_range(date)
    cursor = db.receipts.find({
        "company_id": company_id,
        "date": {"$gte": lo, "$lte": hi},
        "$or": [{"matched_transaction_id": {"$in": [None, ""]}}, {"matched_transaction_id": {"$exists": False}}],
    }, {"_id": 0, "attachment_data_url": 0})
    t_accounts = {txn.get("bank_account_id"), txn.get("plaid_account_id")} - {None, ""}
    out = []
    async for r in cursor:
        score, why = score_pair(
            r_amount=r.get("amount") or 0, r_date=r.get("date") or "", r_merchant=r.get("merchant"),
            r_account=r.get("payment_account_id"), t_amount=amt, t_date=date,
            t_desc=txn.get("description") or txn.get("merchant_name"), t_accounts=t_accounts,
        )
        conf = _confidence(score)
        if conf:
            out.append({"receipt": r, "score": score, "confidence": conf, "reasons": why})
    out.sort(key=lambda x: -x["score"])
    return out[:limit]


async def find_matching_transaction(
    company_id: str, account_id: str, date: str, amount: float, merchant: Optional[str] = None,
) -> Optional[dict]:
    """High-confidence transaction for a receipt (auto-link), else None."""
    ranked = await rank_transactions_for_receipt(
        company_id, account_id=account_id, date=date, amount=amount, merchant=merchant, limit=2)
    if ranked and ranked[0]["confidence"] == "high" and (len(ranked) == 1 or ranked[0]["score"] - ranked[1]["score"] >= 10):
        return ranked[0]["txn"]
    return None


async def find_pending_receipt_match(
    company_id: str, account_id: str, date: str, amount: float, description: Optional[str] = None,
) -> Optional[dict]:
    """Symmetric to `find_matching_transaction` — called from Plaid ingest
    when a new transaction lands. High-confidence unmatched receipt or None."""
    ranked = await rank_receipts_for_transaction(company_id, {
        "date": date, "amount": amount, "description": description,
        "bank_account_id": account_id, "plaid_account_id": account_id,
    }, limit=2)
    if ranked and ranked[0]["confidence"] == "high" and (len(ranked) == 1 or ranked[0]["score"] - ranked[1]["score"] >= 10):
        return await db.receipts.find_one({"id": ranked[0]["receipt"]["id"]})
    return None


async def link_receipt_to_transaction(
    company_id: str, receipt: dict, txn: dict, *, notify_user: bool = False,
) -> None:
    """Cross-link a receipt and a transaction, copy the receipt's line-
    item split onto the transaction (transactions live directly on the
    GL — no JE indirection — so this is what makes the reporting
    accurate), and reverse the receipt's own JE if one was posted.

    This is the "no doubling" core: after this runs, the P&L reflects
    the receipt's split exactly once, via the transaction's
    `line_items` (which downstream reports & QBO push both honor).
    """
    rid = receipt.get("id")
    tid = txn.get("id")
    if not (rid and tid):
        return

    now = _now_iso()

    # 1. Copy the receipt's line_items onto the transaction. Prefer
    #    the receipt's edited split; fall back to a single line with
    #    the receipt's `category_account_id`.
    lines = receipt.get("line_items") or []
    if not lines and receipt.get("category_account_id"):
        lines = [{
            "description":  receipt.get("merchant") or "",
            "amount":       float(receipt.get("amount") or 0),
            "account_id":   receipt.get("category_account_id"),
            "account_code": "",
            "account_name": "",
        }]

    # Normalize to the shape the QBO push + reports expect
    # (`category_account_id` per line — see qbo_mirror/push._purchase_body).
    norm_lines = []
    for l in lines:
        aid = l.get("account_id") or l.get("category_account_id") or \
              l.get("expense_account_id")
        if not aid:
            continue
        norm_lines.append({
            "description":         l.get("description") or "",
            "amount":              float(l.get("amount") or 0),
            "account_id":          aid,
            "category_account_id": aid,      # for downstream compat
            "expense_account_id":  aid,      # QBO push shape
            "account_code":        l.get("account_code") or "",
            "account_name":        l.get("account_name") or "",
        })

    # 2. Pick the biggest bucket as the transaction's top-level
    #    `category_account_id` so single-line reports (that don't
    #    iterate `line_items`) still land on the right account.
    top_account_id = txn.get("category_account_id")
    if norm_lines:
        buckets: dict = {}
        for l in norm_lines:
            buckets[l["account_id"]] = buckets.get(l["account_id"], 0) \
                                        + abs(l["amount"])
        top_account_id = max(buckets.items(), key=lambda kv: kv[1])[0]

    # UI shape: the Edit modal + table render `splits` (signed, with
    # category_* fields) and `attachments[]` — mirror line_items into both
    # so a matched receipt shows exactly like a hand-entered split.
    sign = -1.0 if float(txn.get("amount") or 0) < 0 else 1.0
    acct_names = {}
    async for a in db.accounts.find({"company_id": company_id,
                                     "id": {"$in": list({l["account_id"] for l in norm_lines})}},
                                    {"_id": 0, "id": 1, "code": 1, "name": 1}):
        acct_names[a["id"]] = a
    splits = [{
        "amount": round(sign * abs(l["amount"]), 2),
        "category_account_id": l["account_id"],
        "category_account_code": l.get("account_code") or acct_names.get(l["account_id"], {}).get("code", ""),
        "category_account_name": l.get("account_name") or acct_names.get(l["account_id"], {}).get("name", ""),
        "description": l.get("description") or "",
    } for l in norm_lines] if len(norm_lines) > 1 else []
    top_name = acct_names.get(top_account_id, {}).get("name") if top_account_id else None
    attachments = list(txn.get("attachments") or [])
    if receipt.get("attachment_data_url") and not any(a.get("receipt_id") == rid for a in attachments):
        data_url = receipt["attachment_data_url"]
        attachments.append({
            "id": str(uuid.uuid4()), "receipt_id": rid,
            "filename": receipt.get("attachment_filename") or "receipt",
            "size": int(len(data_url) * 0.75), "mime": (data_url.split(";")[0].split(":")[-1] if data_url.startswith("data:") else "image/*"),
            "data_url": data_url, "kind": "receipt", "uploaded_at": now, "uploaded_by": "receipt:match",
        })

    await db.transactions.update_one(
        {"id": tid, "company_id": company_id},
        {"$set": {
            "line_items":            norm_lines,
            "splits":                splits,
            "attachments":           attachments,
            "matched_receipt_id":    rid,
            "receipt_id":            rid,   # legacy alias some views read
            "category_account_id":   top_account_id,
            **({"category_account_name": top_name} if top_name else {}),
            "attachment_data_url":   receipt.get("attachment_data_url")
                                     or txn.get("attachment_data_url"),
            "attachment_filename":   receipt.get("attachment_filename")
                                     or txn.get("attachment_filename"),
            "receipt_ai_narrative":  receipt.get("ai_narrative"),
            "human_reviewed":        True,
            "updated_at":            now,
        }},
    )

    # 3. Reverse the receipt's JE if one was posted. Transactions own
    #    reporting — the receipt is now attachment/metadata only.
    if receipt.get("posted") or receipt.get("posted_je_id"):
        try:
            from posting_service import reverse_document_je
            await reverse_document_je(company_id, "receipt", rid)
        except Exception:  # noqa: BLE001
            logger.exception(
                "receipt JE reverse failed during match for %s", rid)

    # 4. Stamp the receipt with its match link so future PATCHes /
    #    displays know this receipt is attached to a transaction.
    await db.receipts.update_one(
        {"id": rid, "company_id": company_id},
        {"$set": {
            "matched_transaction_id": tid,
            "matched_at":             now,
            "updated_at":             now,
        }},
    )

    logger.info(
        "receipt %s linked to transaction %s (%d line item split)",
        rid, tid, len(norm_lines),
    )
    if notify_user:
        await notify_receipt_matched(company_id, receipt, txn)


async def unlink_receipt_from_transaction(company_id: str, rid: str, tid: str) -> None:
    """Receipt deleted → transaction goes back to uncategorized / needs review."""
    now = _now_iso()
    txn = await db.transactions.find_one({"id": tid, "company_id": company_id})
    if not txn or rid not in (txn.get("matched_receipt_id"), txn.get("receipt_id")):
        return
    attachments = [a for a in (txn.get("attachments") or []) if a.get("receipt_id") != rid]
    await db.transactions.update_one(
        {"id": tid, "company_id": company_id},
        {"$set": {
            "line_items": [], "splits": [], "attachments": attachments,
            "category_account_id": None, "category_account_name": None,
            "attachment_data_url": None, "attachment_filename": None,
            "receipt_ai_narrative": None,
            "human_reviewed": False, "needs_review": True, "updated_at": now,
        },
         "$unset": {"matched_receipt_id": "", "receipt_id": ""}},
    )


async def unmatch_receipt_for_deleted_transaction(company_id: str, tid: str) -> int:
    """Transaction deleted → its receipt goes back to unmatched."""
    r = await db.receipts.update_many(
        {"company_id": company_id, "matched_transaction_id": tid},
        {"$set": {"matched_transaction_id": None, "matched_at": None, "match_transaction_id": None,
                  "updated_at": _now_iso()}})
    return r.modified_count


async def notify_receipt_matched(company_id: str, receipt: dict, txn: dict) -> None:
    """Bell notification for a match the user didn't watch happen (Plaid
    landed the charge after the receipt was snapped). Goes to whoever
    uploaded the receipt, else the company owner(s)."""
    try:
        from routes.notifications import notify
        amt = abs(float(txn.get("amount") or 0))
        who = (txn.get("merchant") or txn.get("merchant_name") or txn.get("description")
               or receipt.get("vendor") or "a transaction")
        targets = [receipt.get("uploaded_by")] if receipt.get("uploaded_by") else [
            m["user_id"] async for m in db.memberships.find(
                {"company_id": company_id, "role": "owner"}, {"_id": 0, "user_id": 1})]
        for uid in targets:
            await notify(
                company_id, uid, "receipt_matched",
                f"Receipt matched: {who} · ${amt:,.2f}",
                f"The {receipt.get('vendor') or 'receipt'} you uploaded is now attached to the "
                f"{txn.get('date') or ''} bank transaction.",
                link=f"/accounting/transactions?focus={txn.get('id')}",
                source={"type": "receipt_match", "id": f"{receipt.get('id')}:{txn.get('id')}"},
            )
    except Exception:  # noqa: BLE001 — never break the match itself
        logger.exception("receipt_matched notification failed")
