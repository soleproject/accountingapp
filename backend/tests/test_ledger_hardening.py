"""Regression tests for the Feb 2026 ledger-hardening pass.

Covers:
  • `insert_je` computes correct header totals from lines
  • `insert_je` refuses to write an unbalanced JE
  • `ledger_transaction()` yields a value safe to pass as `session=`
  • The soft-cap `check_spend_cap` logs but doesn't raise below hard-block

Follows the manual `_run()` pattern from `test_ai_usage.py` because
pytest-asyncio-vs-Motor loop management is flakey in this repo.
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from db import db, insert_je, ledger_transaction  # noqa: E402
from ai_usage import check_spend_cap, AiSpendCapExceeded  # noqa: E402


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# ---------------------------------------------------------------------
# insert_je
# ---------------------------------------------------------------------

def test_insert_je_computes_header_totals_from_lines():
    """The bug we fixed: 6 JEs shipped with total_debit=total_credit=0
    while lines summed to real numbers. `insert_je` must overwrite any
    caller-provided header totals so lines and header can never disagree.
    """
    async def _t():
        cid = f"__test__{uuid.uuid4().hex[:8]}"
        je_id = await insert_je({
            "company_id": cid,
            "date": "2026-08-01",
            "memo": "test — header totals",
            # Deliberately WRONG header values — helper must overwrite.
            "total_debit": 0, "total_credit": 0,
            "lines": [
                {"account_id": "a", "debit": 100.00, "credit": 0.0},
                {"account_id": "b", "debit": 0.0,   "credit": 100.00},
            ],
        })
        try:
            doc = await db.journal_entries.find_one({"id": je_id})
            assert doc is not None
            assert doc["total_debit"] == 100.00
            assert doc["total_credit"] == 100.00
        finally:
            await db.journal_entries.delete_one({"id": je_id})
    _run(_t())


def test_insert_je_refuses_unbalanced_write():
    """A JE that fails debit=credit must never hit disk."""
    async def _t():
        cid = f"__test__{uuid.uuid4().hex[:8]}"
        bad = {
            "company_id": cid,
            "date": "2026-08-01",
            "memo": "test — unbalanced",
            "lines": [
                {"account_id": "a", "debit": 100.00, "credit": 0.0},
                {"account_id": "b", "debit": 0.0,   "credit":  50.00},  # off
            ],
        }
        with pytest.raises(ValueError, match="unbalanced"):
            await insert_je(bad)
        n = await db.journal_entries.count_documents({"company_id": cid})
        assert n == 0, f"unbalanced JE was written to disk (n={n})"
    _run(_t())


# ---------------------------------------------------------------------
# ledger_transaction fallback safety
# ---------------------------------------------------------------------

def test_ledger_transaction_yields_safe_session():
    """Preview Mongo is single-node → the helper yields None; on Atlas
    it yields a real session. Both must be safe to pass as `session=`."""
    async def _t():
        async with ledger_transaction() as session:
            cid = f"__test__{uuid.uuid4().hex[:8]}"
            je_id = await insert_je({
                "company_id": cid,
                "date": "2026-08-01",
                "memo": "test — txn safety",
                "lines": [
                    {"account_id": "a", "debit": 1.0, "credit": 0.0},
                    {"account_id": "b", "debit": 0.0, "credit": 1.0},
                ],
            }, session=session)
            try:
                doc = await db.journal_entries.find_one({"id": je_id})
                assert doc is not None
            finally:
                await db.journal_entries.delete_one({"id": je_id})
    _run(_t())


# ---------------------------------------------------------------------
# Soft AI-spend cap
# ---------------------------------------------------------------------

async def _seed_test_company(spent_cents: float, cap_usd: float,
                             hard_block: bool = False) -> str:
    cid = f"__test_cap_{uuid.uuid4().hex[:8]}"
    period = datetime.now(timezone.utc).strftime("%Y-%m")
    await db.companies.insert_one({
        "id": cid,
        "name": f"cap-test-{cid[-6:]}",
        "ai_spend": {period: float(spent_cents)},
        "ai_spend_cap_cents": float(cap_usd) * 100.0,
        "ai_spend_hard_block": hard_block,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return cid


async def _cleanup(cid: str) -> None:
    await db.companies.delete_one({"id": cid})


def test_soft_cap_under_80pct_is_silent():
    async def _t():
        cid = await _seed_test_company(spent_cents=100, cap_usd=5.0)  # 20%
        try:
            await check_spend_cap(cid)
            doc = await db.companies.find_one({"id": cid})
            assert not doc.get("ai_spend_over_cap_events")
        finally:
            await _cleanup(cid)
    _run(_t())


def test_soft_cap_at_90pct_warns_but_allows():
    async def _t():
        cid = await _seed_test_company(spent_cents=450, cap_usd=5.0)  # 90%
        try:
            await check_spend_cap(cid)  # must NOT raise
            doc = await db.companies.find_one({"id": cid})
            # Not over yet — no counter latched.
            assert not doc.get("ai_spend_over_cap_events")
        finally:
            await _cleanup(cid)
    _run(_t())


def test_soft_cap_over_100pct_latches_counter_but_allows():
    """User-requested behaviour: at/over cap, log + latch a counter,
    but LET THE CALL THROUGH. Only hard_block should 402."""
    async def _t():
        cid = await _seed_test_company(spent_cents=600, cap_usd=5.0)  # 120%
        try:
            await check_spend_cap(cid)  # must NOT raise (soft)
            doc = await db.companies.find_one({"id": cid})
            period = datetime.now(timezone.utc).strftime("%Y-%m")
            assert (doc.get("ai_spend_over_cap_events") or {}).get(period, 0) >= 1
        finally:
            await _cleanup(cid)
    _run(_t())


def test_hard_block_over_cap_raises_402_signal():
    """hard_block=true → next call raises AiSpendCapExceeded."""
    async def _t():
        cid = await _seed_test_company(spent_cents=600, cap_usd=5.0, hard_block=True)
        try:
            with pytest.raises(AiSpendCapExceeded) as exc_info:
                await check_spend_cap(cid)
            assert exc_info.value.company_id == cid
            assert exc_info.value.spent_cents == 600
            assert exc_info.value.cap_cents == 500
        finally:
            await _cleanup(cid)
    _run(_t())


def test_cap_zero_means_unlimited():
    """cap=0 must be a no-op regardless of spend."""
    async def _t():
        cid = await _seed_test_company(spent_cents=99999, cap_usd=0)
        try:
            await check_spend_cap(cid)  # unlimited — never raises
        finally:
            await _cleanup(cid)
    _run(_t())


def test_none_company_id_is_noop():
    """Platform-level LLM jobs don't have a company scope — no-op."""
    async def _t():
        await check_spend_cap(None)
        await check_spend_cap("")
    _run(_t())
