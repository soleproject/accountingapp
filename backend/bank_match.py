"""Silent bank-feed ↔ editor-authored transaction matcher.

**Problem** (identified 2026-02-20): A CPA can create a `SalesReceipt`
or `Purchase` via the full-page editors, and Plaid can later pull
the *same* money movement from the bank feed. We now carry two
rows for one event → cash on Balance Sheet is inflated, reports
double-count.

**Design constraints from product**:

  1. **Never touch the Plaid hot path.** Regular users see identical
     ingestion speed. The matcher runs as a fire-and-forget task
     *after* `insert_many` returns.
  2. **Zero user-facing UI in Simple mode.** The company owner sees
     bank-feed rows only; matched editor rows are hidden from the
     ledger via a `matched_bank_txn_id` server-side filter that the
     Transactions endpoint already respects (well — will, once we
     wire the filter; see `transactions.py::list_transactions`).
  3. **Silent.** No toasts, no notifications. Log only.
  4. **Deterministic.** Same amount + bank + date window → same match
     every time. No LLM. No fuzzy matching that could pair unrelated
     transactions.

**Matching rules** (strict):

  - `bank_account_id` equal on both sides (must be the same bank).
  - Absolute amount equal to the cent.
  - Date within ±3 days (banks post 1-2 business days late; weekends
    push out to 3 for Sunday-initiated ACH).
  - Bank side has `plaid_transaction_id` (came from a real bank feed).
  - Editor side has `txn_type` ∈ {Purchase, SalesReceipt, Deposit,
    CreditMemo, RefundReceipt} (was authored via the editor branch).
  - Neither side already carries `matched_bank_txn_id` (idempotent —
    we never re-match a pair).

**What we DON'T match**:
  - Two bank-feed rows to each other (that's `detect_transfers`'s job).
  - Two editor rows to each other (nonsense).
  - Rows with `_sync_origin=qbo` (came from QBO — different lineage).
"""
from __future__ import annotations
from datetime import datetime, timedelta
from typing import Optional
import logging

from db import db, now_iso

log = logging.getLogger(__name__)

_EDITOR_TYPES = ("Purchase", "SalesReceipt", "Deposit",
                  "CreditMemo", "RefundReceipt")
_MATCH_WINDOW_DAYS = 3


def _parse_iso(s: str) -> Optional[datetime]:
    """Loose ISO-8601 parser — the ledger stores dates as either
    `YYYY-MM-DD` or full timestamps depending on origin."""
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d")
    except ValueError:
        return None


async def auto_match_bank_feed(
    company_id: str, plaid_txn_ids: list[str],
) -> dict:
    """For each Plaid txn we just inserted, look for an editor-authored
    row within the ±3-day window that has the same bank + amount +
    isn't already matched. Link them via a shared
    `matched_bank_txn_id` if found.

    Args:
      company_id: scope to a single tenant.
      plaid_txn_ids: local `id`s of the freshly-inserted bank rows.
                     Passing IDs (not raw docs) keeps the matcher
                     independent of the ingestion payload shape.

    Returns a small stats dict for logging/tests:
      { "matched": N, "scanned": N }
    """
    if not plaid_txn_ids:
        return {"matched": 0, "scanned": 0}
    matched = 0
    scanned = 0
    async for bank_row in db.transactions.find({
        "company_id": company_id,
        "id": {"$in": plaid_txn_ids},
        "matched_bank_txn_id": {"$exists": False},
    }):
        scanned += 1
        bank_dt = _parse_iso(bank_row.get("date"))
        if not bank_dt:
            continue
        # Date window on both sides. Store as ISO strings for a fast
        # $gte/$lte range scan (dates are stored as strings, and
        # `YYYY-MM-DD` sorts lexicographically → range works).
        date_from = (bank_dt - timedelta(days=_MATCH_WINDOW_DAYS)).strftime("%Y-%m-%d")
        date_to = (bank_dt + timedelta(days=_MATCH_WINDOW_DAYS)).strftime("%Y-%m-%d")
        bank_amt = round(abs(float(bank_row.get("amount", 0) or 0)), 2)
        if bank_amt == 0:
            continue
        # Editor candidate: same bank, absolute amount matches to the
        # cent, txn_type is one of the editor-authored kinds, not yet
        # matched, not from QBO pull (we don't want to swallow a
        # QBO-mirrored row into a Plaid pair — different lineage).
        cand = await db.transactions.find_one({
            "company_id": company_id,
            "bank_account_id": bank_row.get("bank_account_id"),
            "txn_type": {"$in": list(_EDITOR_TYPES)},
            "matched_bank_txn_id": {"$exists": False},
            "plaid_transaction_id": {"$exists": False},
            "date": {"$gte": date_from, "$lte": date_to},
            "$or": [
                {"amount": bank_amt},
                {"amount": -bank_amt},
            ],
        })
        if not cand:
            continue
        # Amount sign guard — outflow editor rows are stored negative,
        # inflow positive. The bank row has its own sign convention
        # (negative = outflow). Require sign agreement so we don't
        # pair an outbound Purchase with an inbound bank deposit
        # that just happens to be the same absolute amount.
        bank_signed = float(bank_row.get("amount", 0) or 0)
        cand_signed = float(cand.get("amount", 0) or 0)
        if (bank_signed < 0) != (cand_signed < 0):
            continue
        # Link them. `matched_bank_txn_id` on both rows points to the
        # BANK row's id — that's the canonical anchor because the
        # bank row is the actual money movement.
        anchor_id = bank_row["id"]
        stamp = now_iso()
        await db.transactions.update_one(
            {"id": bank_row["id"], "company_id": company_id},
            {"$set": {
                "matched_bank_txn_id": anchor_id,
                "matched_editor_txn_id": cand["id"],
                "matched_at": stamp,
            }},
        )
        await db.transactions.update_one(
            {"id": cand["id"], "company_id": company_id},
            {"$set": {
                "matched_bank_txn_id": anchor_id,
                "matched_at": stamp,
                # Editor row hides from the default ledger view once
                # matched — the bank row carries the cash movement.
                "hidden_by_match": True,
            }},
        )
        matched += 1
        log.info("auto_match_bank_feed: paired bank=%s ↔ editor=%s (%s $%.2f)",
                  bank_row["id"], cand["id"],
                  cand.get("txn_type"), bank_amt)
    return {"matched": matched, "scanned": scanned}
