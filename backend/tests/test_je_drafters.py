"""AI JE Drafters — end-to-end pytest for the prepaid + accrual detectors
and the approve → post-to-ledger loop.
"""
import uuid
import pytest

from tests._shared_loop import run as _run
from db import db, insert_je
from routes.je_drafters import (
    _draft_prepaid_amortizations,
    _draft_recurring_accruals,
    approve_draft,
    _guess_expense_account_name,
)


async def _cleanup(cid: str):
    for coll in (
        "companies", "contacts", "accounts", "transactions",
        "journal_entries", "je_drafts",
    ):
        await db[coll].delete_many({"company_id": cid})


def test_prepaid_amortization_drafts_1_of_12():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            # Prepaid Rent asset + Rent Expense.
            await db.accounts.insert_one({
                "id": "prepaid1", "company_id": cid,
                "name": "Prepaid Rent", "type": "other_current_asset",
                "subtype": "prepaid", "active": True,
            })
            await db.accounts.insert_one({
                "id": "rentexp", "company_id": cid,
                "name": "Rent Expense", "type": "expense",
                "active": True,
            })
            # Post a $12,000 prepaid balance on 2026-01-01.
            await insert_je({
                "company_id": cid, "date": "2026-01-01",
                "memo": "Prepay",
                "lines": [
                    {"account_id": "prepaid1", "debit": 12000, "credit": 0},
                    {"account_id": "rentexp",  "debit": 0, "credit": 12000},
                ], "posted": True,
            })

            drafts = await _draft_prepaid_amortizations(cid, 2026, 2)
            assert len(drafts) == 1
            d = drafts[0]
            # Balance BEFORE Feb is $12k; the credit above artificially
            # zeroes it, but this test seeds only one JE. Recompute:
            # actually the seed JE puts +12k debit prepaid, -12k credit
            # rentexp so prepaid balance is +12k. Monthly = 1000.
            assert d["amount"] == 1000.0
            # Debit expense, credit prepaid — the direction that
            # amortizes the asset off the books.
            assert d["lines"][0]["debit"] == 1000.0
            assert d["lines"][0]["account_id"] == "rentexp"
            assert d["lines"][1]["credit"] == 1000.0
            assert d["lines"][1]["account_id"] == "prepaid1"
            assert d["confidence"] >= 0.7
        finally:
            await _cleanup(cid)
    _run(go())


def test_prepaid_skips_zero_balance():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.accounts.insert_one({
                "id": "prepaid1", "company_id": cid,
                "name": "Prepaid Insurance", "type": "other_current_asset",
                "subtype": "prepaid", "active": True,
            })
            drafts = await _draft_prepaid_amortizations(cid, 2026, 2)
            assert drafts == []
        finally:
            await _cleanup(cid)
    _run(go())


def test_recurring_accrual_drafts_when_pattern_present_but_month_missing():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.contacts.insert_one({
                "id": "v1", "company_id": cid,
                "name": "Comcast", "normalized_name": f"c-{uuid.uuid4().hex[:6]}",
            })
            await db.accounts.insert_one({
                "id": "utilexp", "company_id": cid,
                "name": "Utilities Expense", "type": "expense", "active": True,
            })
            await db.accounts.insert_one({
                "id": "ap1", "company_id": cid,
                "name": "Accounts Payable", "type": "liability",
                "subtype": "accounts_payable", "active": True,
            })
            # 5 consecutive months, close month (Feb 2026) missing.
            for date_ in ["2025-09-15", "2025-10-15", "2025-11-15",
                          "2025-12-15", "2026-01-15"]:
                await db.transactions.insert_one({
                    "id": f"tx-{date_}", "company_id": cid,
                    "contact_id": "v1", "account_id": "utilexp",
                    "date": date_, "amount": -285.00, "direction": "out",
                    "description": "Internet", "posted": True,
                })
            drafts = await _draft_recurring_accruals(cid, 2026, 2, lookback=6)
            assert len(drafts) == 1
            d = drafts[0]
            assert d["amount"] == 285.0
            assert d["lines"][0]["account_id"] == "utilexp"
            assert d["lines"][1]["account_id"] == "ap1"
            assert d["confidence"] >= 0.85  # 0.5 + 5*0.08 = 0.9
        finally:
            await _cleanup(cid)
    _run(go())


def test_recurring_accrual_skips_when_close_month_already_posted():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.contacts.insert_one({
                "id": "v1", "company_id": cid, "name": "Netflix",
                "normalized_name": f"n-{uuid.uuid4().hex[:6]}",
            })
            await db.accounts.insert_one({
                "id": "subs", "company_id": cid,
                "name": "Subscriptions", "type": "expense", "active": True,
            })
            for date_ in ["2025-09-01", "2025-10-01", "2025-11-01",
                          "2025-12-01", "2026-01-01", "2026-02-01"]:
                await db.transactions.insert_one({
                    "id": f"tx-{date_}", "company_id": cid,
                    "contact_id": "v1", "account_id": "subs",
                    "date": date_, "amount": -15.99, "direction": "out",
                    "description": "Netflix", "posted": True,
                })
            drafts = await _draft_recurring_accruals(cid, 2026, 2, lookback=6)
            # Feb IS posted → no accrual needed.
            assert drafts == []
        finally:
            await _cleanup(cid)
    _run(go())


def test_approve_draft_posts_to_journal_entries():
    async def go():
        from types import SimpleNamespace
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.companies.insert_one({"id": cid, "name": "T"})
            # Membership so require_company passes.
            uid = f"u-{uuid.uuid4().hex[:8]}"
            await db.memberships.insert_one({
                "user_id": uid, "company_id": cid, "role": "pro",
            })
            await db.accounts.insert_one({
                "id": "expA", "company_id": cid, "name": "Rent",
                "type": "expense", "active": True,
            })
            await db.accounts.insert_one({
                "id": "prepA", "company_id": cid, "name": "Prepaid Rent",
                "type": "other_current_asset", "active": True,
            })
            draft_id = str(uuid.uuid4())
            await db.je_drafts.insert_one({
                "id": draft_id, "company_id": cid, "period": "2026-02",
                "drafter_kind": "prepaid_amort", "status": "pending",
                "date": "2026-02-28",
                "memo": "Amortize prepaid rent 2026-02",
                "lines": [
                    {"account_id": "expA", "debit": 1000, "credit": 0},
                    {"account_id": "prepA", "debit": 0, "credit": 1000},
                ],
                "amount": 1000,
            })
            user = {"id": uid, "email": "pro@t", "role": "pro"}
            r = await approve_draft(cid, draft_id, user=user)
            assert r["ok"] is True
            je = await db.journal_entries.find_one({"id": r["je_id"]})
            assert je is not None
            assert je["total_debit"] == 1000.0
            assert je["total_credit"] == 1000.0
            assert je["source"] == "je_drafter"
            assert je["source_drafter_kind"] == "prepaid_amort"

            # Draft flipped.
            d = await db.je_drafts.find_one({"id": draft_id})
            assert d["status"] == "approved"
            assert d["posted_je_id"] == r["je_id"]
        finally:
            await _cleanup(cid)
            await db.memberships.delete_many({"company_id": cid})
    _run(go())


def test_guess_expense_account_name():
    assert _guess_expense_account_name("Prepaid Rent") == "Rent Expense"
    assert _guess_expense_account_name("Prepaid Insurance") == "Insurance Expense"
    assert _guess_expense_account_name("Nothing here") is None
