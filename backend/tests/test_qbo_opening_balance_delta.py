"""Regression tests — QBO opening-balance JE uses DELTA math.

Pre-fix (Feb 26 2026 morning), `_post_opening_balances_je` skipped any
account with existing ledger activity. Combined with the general
opener using QBO's *current* CurrentBalance (post-activity), this
meant:
  - Fixed Assets like Truck (no activity) got their opening balance
    posted correctly → BS tied.
  - Accounts WITH activity like Inventory Asset (post InventoryAdjust
    JEs) or Savings (post Deposit-5) were left alone → BS drifted by
    the amount of activity that had happened before migration.

Post-fix, the opener always posts the DELTA (QBO CurrentBalance minus
our current raw balance). If our activity already matches QBO exactly,
delta is zero → nothing posted. Otherwise the delta represents the
pre-migration opening balance, which is what we want.

The math also has to handle QBO's shared sign convention correctly:
both QBO's `CurrentBalance` and our raw ledger use negative values for
positive natural liability/equity balances. So the delta computation
compares them directly (no flip), and only maps to DR/CR by the sign
of the delta itself (not the account type).
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
import qbo_service as Q  # noqa: E402
import reports as R  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_account(cid: str, aid: str, name: str, _type: str,
                        qbo_current_balance: float,
                        qbo_id: str = "42",
                        detail_type: str = "",
                        code: str = ""):
    now = datetime.now(timezone.utc).isoformat()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "source": "qbo",
        "qbo_id": qbo_id, "code": code or aid[-4:], "name": name,
        "type": _type, "detail_type": detail_type,
        "active": True, "balance": 0.0,
        "raw": {"AccountType": _type.title(),
                 "CurrentBalance": qbo_current_balance},
        "created_at": now, "updated_at": now,
    })


async def _cleanup(cid: str):
    for coll in (db.companies, db.accounts, db.journal_entries,
                  db.transactions, db.invoices, db.bills, db.payments):
        await coll.delete_many({"company_id": cid})


def test_opening_je_zero_activity_asset_posts_full_qbo_balance():
    """Truck-like case: no imported activity, QBO CurBal = $13,495 →
    opener posts DR $13,495 / CR OBE $13,495."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "OB1 Co"})
        await _seed_account(cid, "acct-truck", "Truck", "asset",
                              qbo_current_balance=13495.0,
                              qbo_id="37", detail_type="fixed_asset")
        await _seed_account(cid, "acct-obe", "Opening Balance Equity",
                              "equity", qbo_current_balance=0.0,
                              qbo_id="34", code="3900",
                              detail_type="opening_balance_equity")
        try:
            r = await Q._post_opening_balances_je(cid)
            assert r["line_count"] >= 2
            by = await R._signed_balances(cid, start=None,
                                            end="2099-12-31",
                                            include_pre_period=True)
            assert abs(by.get("acct-truck", 0) - 13495.0) < 0.02
            assert abs(by.get("acct-obe", 0) + 13495.0) < 0.02  # -13495
        finally:
            await _cleanup(cid)

    _run(go())


def test_opening_je_zero_activity_liability_posts_credit():
    """Notes Payable, no activity, QBO CurBal = -25000 (their signed
    convention for positive natural liability). Opener should post
    CR $25,000 to Notes / DR $25,000 to OBE."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "OB2 Co"})
        await _seed_account(cid, "acct-notes", "Notes Payable",
                              "liability", qbo_current_balance=-25000.0,
                              qbo_id="43",
                              detail_type="expected_payments_to_vendors")
        await _seed_account(cid, "acct-obe", "Opening Balance Equity",
                              "equity", qbo_current_balance=0.0,
                              qbo_id="34", code="3900",
                              detail_type="opening_balance_equity")
        try:
            await Q._post_opening_balances_je(cid)
            by = await R._signed_balances(cid, start=None,
                                            end="2099-12-31",
                                            include_pre_period=True)
            # Notes Payable raw should be -25000 (credit-normal)
            assert abs(by.get("acct-notes", 0) + 25000.0) < 0.02
            # OBE raw should be +25000 (debit — offsetting)
            assert abs(by.get("acct-obe", 0) - 25000.0) < 0.02
        finally:
            await _cleanup(cid)

    _run(go())


def test_opening_je_with_activity_plugs_only_the_delta():
    """Savings-like case: QBO CurBal = $800 but we've already imported
    a Deposit contributing $600 of activity. Opener should plug just
    the $200 opening balance, NOT $800 (which would double it)."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "OB3 Co"})
        await _seed_account(cid, "acct-savings", "Savings", "asset",
                              qbo_current_balance=800.0,
                              qbo_id="36", detail_type="cash_and_bank")
        await _seed_account(cid, "acct-obe", "Opening Balance Equity",
                              "equity", qbo_current_balance=0.0,
                              qbo_id="34", code="3900",
                              detail_type="opening_balance_equity")
        # Simulate a Deposit that already posted $600 to Savings via
        # `bank_account_id`.
        now = datetime.now(timezone.utc).isoformat()
        await db.transactions.insert_one({
            "id": "dep-1", "company_id": cid, "source": "qbo",
            "txn_type": "Deposit", "number": "Deposit-5",
            "date": "2026-05-10", "amount": 600.0,
            "posted": True,
            "bank_account_id": "acct-savings",
            "bank_account_qbo_id": "36",
            "created_at": now, "updated_at": now,
        })
        try:
            await Q._post_opening_balances_je(cid)
            by = await R._signed_balances(cid, start=None,
                                            end="2099-12-31",
                                            include_pre_period=True)
            # Savings should end at $800 total ($600 from Deposit +
            # $200 opening plug). If the opener wrongly used full
            # QBO CurBal, Savings would be $1,400 here.
            assert abs(by.get("acct-savings", 0) - 800.0) < 0.02, (
                f"expected Savings=$800, got {by.get('acct-savings')}. "
                f"Opener should plug delta ($200), not full CurBal ($800)."
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_opening_je_zero_delta_posts_nothing():
    """If our imported activity already equals QBO's CurrentBalance
    (delta = 0), the opener must not post a line for that account."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "OB4 Co"})
        await _seed_account(cid, "acct-check", "Checking", "asset",
                              qbo_current_balance=1201.0,
                              qbo_id="35", detail_type="cash_and_bank")
        await _seed_account(cid, "acct-obe", "Opening Balance Equity",
                              "equity", qbo_current_balance=0.0,
                              qbo_id="34", code="3900",
                              detail_type="opening_balance_equity")
        # Simulate txns already producing exactly $1201 on Checking.
        now = datetime.now(timezone.utc).isoformat()
        await db.transactions.insert_one({
            "id": "dep-1", "company_id": cid, "source": "qbo",
            "txn_type": "Deposit", "number": "Deposit-X",
            "date": "2026-05-10", "amount": 1201.0,
            "posted": True,
            "bank_account_id": "acct-check",
            "bank_account_qbo_id": "35",
            "created_at": now, "updated_at": now,
        })
        try:
            r = await Q._post_opening_balances_je(cid)
            # No lines for Checking or OBE — nothing to plug.
            je = await db.journal_entries.find_one(
                {"id": r.get("posted_je_id")}) if r.get("posted_je_id") else None
            if je:
                names = [l.get("account_name") for l in je["lines"]]
                assert "Checking" not in names, (
                    f"Opener should skip Checking when delta=0, "
                    f"but posted a line for it. names={names}"
                )
        finally:
            await _cleanup(cid)

    _run(go())
