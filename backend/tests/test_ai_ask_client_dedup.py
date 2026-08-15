"""Tests for the AI Ask Client scheduler's payment-signature dedup
(Feb 2026 — fixes "4 emails for the same $400 Venmo charge" bug).

Coverage:
  1. When a company has 4 duplicate transaction rows for the same real-
     world payment (same date + amount + counterparty), `_candidate_txns`
     returns AT MOST ONE — the others are collapsed by signature.
  2. After `process_company` emails about one row, all sibling duplicates
     get their `client_question_id` stamped so subsequent ticks skip them.
  3. Historical asked-transactions (any prior row with client_question_id
     set) block future candidates with the same signature — even if the
     current candidate row itself has no client_question_id yet.
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from datetime import datetime, timezone, timedelta  # noqa: E402
from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _fresh_cid() -> str:
    cid = str(uuid.uuid4())
    await db.companies.insert_one({"id": cid, "name": "Show LLC"})
    return cid


async def _mk_txn(cid: str, amount: float, date_str: str,
                  merchant: str = "VENMO", **extra) -> str:
    tid = str(uuid.uuid4())
    doc = {
        "id": tid, "company_id": cid,
        "amount": amount, "date": date_str,
        "merchant": merchant, "description": merchant,
        "needs_review": True,
        "human_reviewed": False,
        "client_question_id": None,
    }
    doc.update(extra)
    await db.transactions.insert_one(doc)
    return tid


def test_candidate_txns_dedupes_duplicates_by_payment_signature():
    async def _t():
        cid = await _fresh_cid()
        today = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        # Four rows for the exact same real-world $400 Venmo payment —
        # Plaid, QBO, manual, and a stray dupe.
        for _ in range(4):
            await _mk_txn(cid, -400.00, today, "VENMO")
        # Plus one totally unrelated txn so we can prove non-duplicates
        # are still returned.
        await _mk_txn(cid, -25.00, today, "SBUX")
        try:
            from ai_ask_client_scheduler import _candidate_txns
            candidates = await _candidate_txns(cid)
            # Expect 2: one representative of the Venmo group + the Sbux.
            sigs = set()
            for t in candidates:
                cents = int(round(float(t.get("amount") or 0) * 100))
                sigs.add((t.get("date"), cents, (t.get("merchant") or "").upper()))
            assert len(candidates) == 2, \
                f"expected 2 unique signatures, got {len(candidates)} txns"
            assert (today, -40000, "VENMO") in sigs
            assert (today, -2500, "SBUX") in sigs
        finally:
            await db.companies.delete_one({"id": cid})
            await db.transactions.delete_many({"company_id": cid})
    _run(_t())


def test_historical_asked_signatures_block_new_duplicates():
    """Once a signature has been asked-about (any prior row has
    client_question_id set), a fresh candidate row with the same
    signature is filtered out even before dedup within the batch."""
    async def _t():
        cid = await _fresh_cid()
        today = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        # Old row we already emailed about — stamped with a question id.
        await _mk_txn(cid, -400.00, today, "VENMO",
                       client_question_id="old-token")
        # NEW row for the same payment (Plaid re-import) — no
        # client_question_id yet. Should still be filtered out.
        await _mk_txn(cid, -400.00, today, "VENMO")
        try:
            from ai_ask_client_scheduler import _candidate_txns
            candidates = await _candidate_txns(cid)
            assert candidates == [], \
                f"expected new dup to be filtered by historical sig, got {candidates}"
        finally:
            await db.companies.delete_one({"id": cid})
            await db.transactions.delete_many({"company_id": cid})
    _run(_t())


def test_different_signatures_are_not_deduped():
    """Sanity — the dedup should NOT merge txns that differ in date OR
    amount OR counterparty."""
    async def _t():
        cid = await _fresh_cid()
        today = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        yesterday = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
        # Same amount + counterparty, different date → different sigs.
        await _mk_txn(cid, -400.00, today, "VENMO")
        await _mk_txn(cid, -400.00, yesterday, "VENMO")
        # Same date + counterparty, different amount → different sigs.
        await _mk_txn(cid, -401.00, today, "VENMO")
        try:
            from ai_ask_client_scheduler import _candidate_txns
            candidates = await _candidate_txns(cid)
            assert len(candidates) == 3
        finally:
            await db.companies.delete_one({"id": cid})
            await db.transactions.delete_many({"company_id": cid})
    _run(_t())
