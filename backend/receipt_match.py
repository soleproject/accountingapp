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


async def find_matching_transaction(
    company_id: str, account_id: str, date: str, amount: float,
) -> Optional[dict]:
    """Return a `db.transactions` doc that likely represents the same
    real-world purchase as the given receipt, or None.

    Match rule: same company, same account (Plaid or manual — both
    `bank_account_id` and `plaid_account_id` are checked), same date,
    absolute amount within $_AMT_TOL. Skip transactions already linked
    to a different receipt.
    """
    if not (account_id and date and amount):
        return None
    amt = abs(float(amount))
    cursor = db.transactions.find({
        "company_id": company_id,
        "date": date,
        "$or": [
            {"bank_account_id":  account_id},
            {"plaid_account_id": account_id},
        ],
        "matched_receipt_id": {"$in": [None, ""]},
    })
    async for t in cursor:
        if abs(abs(float(t.get("amount") or 0)) - amt) <= _AMT_TOL:
            return t
    # Second pass — allow the "matched_receipt_id" field to be missing
    # entirely (older transactions predate the field).
    cursor = db.transactions.find({
        "company_id": company_id,
        "date": date,
        "$or": [
            {"bank_account_id":  account_id},
            {"plaid_account_id": account_id},
        ],
        "matched_receipt_id": {"$exists": False},
    })
    async for t in cursor:
        if abs(abs(float(t.get("amount") or 0)) - amt) <= _AMT_TOL:
            return t
    return None


async def find_pending_receipt_match(
    company_id: str, account_id: str, date: str, amount: float,
) -> Optional[dict]:
    """Symmetric to `find_matching_transaction` — called from Plaid
    ingest when a new transaction lands. Returns an unmatched receipt
    (already saved with its own JE) that should now be linked to this
    transaction.
    """
    if not (account_id and date and amount):
        return None
    amt = abs(float(amount))
    cursor = db.receipts.find({
        "company_id": company_id,
        "date": date,
        "payment_account_id": account_id,
        "matched_transaction_id": {"$in": [None, ""]},
    })
    async for r in cursor:
        if abs(abs(float(r.get("amount") or 0)) - amt) <= _AMT_TOL:
            return r
    cursor = db.receipts.find({
        "company_id": company_id,
        "date": date,
        "payment_account_id": account_id,
        "matched_transaction_id": {"$exists": False},
    })
    async for r in cursor:
        if abs(abs(float(r.get("amount") or 0)) - amt) <= _AMT_TOL:
            return r
    return None


async def link_receipt_to_transaction(
    company_id: str, receipt: dict, txn: dict,
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

    await db.transactions.update_one(
        {"id": tid, "company_id": company_id},
        {"$set": {
            "line_items":            norm_lines,
            "matched_receipt_id":    rid,
            "receipt_id":            rid,   # legacy alias some views read
            "category_account_id":   top_account_id,
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
            "updated_at":             now,
        }},
    )

    logger.info(
        "receipt %s linked to transaction %s (%d line item split)",
        rid, tid, len(norm_lines),
    )
