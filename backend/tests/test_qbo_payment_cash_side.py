"""Regression tests — QBO Payment cash-side roll-in (Feb 26 2026).

Before this fix, QBO `Payment` entities lived in `db.payments` but were
NEVER read by any report. Cash accounts under-reported customer receipts
and vendor payouts by the full payment total; the BS only balanced
because the accrual layer's use of `ar_end` (open AR post-payment) as
"revenue accrued" happened to bring both sides down by the same amount.

Now `_signed_balances` rolls the payment cash-side through:
  - Payment IN (`direction=in`): DR the deposit account
  - BillPayment OUT (`direction=out`): CR the funding account (bank for
    check payments, credit-card liability for CC payments)

And `compute_balance_sheet` adds `payments_in - payments_out` to Net
Income as a "realized-revenue" offset so Assets = L + E still holds.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
import reports as R  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_account(cid: str, aid: str, qbo_id: str | None, name: str,
                        _type: str, detail_type: str = "", code: str = ""):
    now = datetime.now(timezone.utc).isoformat()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "qbo_id": qbo_id,
        "code": code or aid[-4:], "name": name,
        "type": _type, "detail_type": detail_type,
        "active": True, "balance": 0.0,
        "created_at": now, "updated_at": now,
    })


async def _cleanup(cid: str):
    for coll in (db.companies, db.accounts, db.invoices,
                 db.bills, db.payments, db.transactions,
                 db.journal_entries):
        await coll.delete_many({"company_id": cid})


def test_payment_in_debits_deposit_account():
    """A Payment IN (deposit_account_qbo_id → Undep) increases Undep."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "PayIn Co"})
        await _seed_account(cid, "acct-undep", "4", "Undeposited Funds",
                            "asset", "money_in_transit")
        await db.payments.insert_one({
            "id": "pay-in-1", "company_id": cid, "source": "qbo",
            "direction": "in", "date": "2026-02-01",
            "amount": 150.00,
            "deposit_account_qbo_id": "4",
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            assert abs(by.get("acct-undep", 0) - 150.00) < 0.005, (
                f"expected Undep raw +$150 from Payment IN, "
                f"got {by.get('acct-undep')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_billpayment_via_check_credits_bank():
    """BillPayment funded from CheckPayment.BankAccountRef → bank."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "BpCheck Co"})
        await _seed_account(cid, "acct-checking", "35", "Checking",
                            "asset", "cash_and_bank")
        await db.payments.insert_one({
            "id": "bp-check-1", "company_id": cid, "source": "qbo",
            "direction": "out", "date": "2026-02-05",
            "amount": 240.00,
            "deposit_account_qbo_id": None,
            "raw": {
                "PayType": "Check",
                "CheckPayment": {"BankAccountRef": {"value": "35"}},
            },
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            assert abs(by.get("acct-checking", 0) - (-240.00)) < 0.005, (
                f"expected Checking raw -$240 from Check BillPayment, "
                f"got {by.get('acct-checking')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_billpayment_via_cc_credits_creditcard():
    """BillPayment funded from CreditCardPayment.CCAccountRef → CC."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "BpCC Co"})
        await _seed_account(cid, "acct-mc", "41", "Mastercard",
                            "liability", "credit_card")
        await db.payments.insert_one({
            "id": "bp-cc-1", "company_id": cid, "source": "qbo",
            "direction": "out", "date": "2026-02-10",
            "amount": 75.50,
            "deposit_account_qbo_id": None,
            "raw": {
                "PayType": "CreditCard",
                "CreditCardPayment": {"CCAccountRef": {"value": "41"}},
            },
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            # raw -75.50 on liability → display flips positive.
            assert abs(by.get("acct-mc", 0) - (-75.50)) < 0.005, (
                f"expected Mastercard raw -$75.50 from CC BillPayment, "
                f"got {by.get('acct-mc')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_balance_sheet_stays_balanced_with_payments():
    """End-to-end: Assets = L + E after the payment cash-side + NI
    offset are applied together. This is the critical property — any
    drift would show up as a non-zero `imbalance` on the response."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "BsPay Co"})
        await _seed_account(cid, "acct-undep", "4", "Undeposited Funds",
                            "asset", "money_in_transit", code="1050")
        await _seed_account(cid, "acct-re", None, "Retained Earnings",
                            "equity", "retained_earnings", code="3100")

        # Open invoice ($200 unpaid of $250 total).
        await db.invoices.insert_one({
            "id": "inv-1", "company_id": cid,
            "issue_date": "2026-01-15",
            "contact_name": "Test Customer",
            "total": 250.0, "balance_due": 200.0, "status": "partial",
        })
        # Payment IN of $50 (the amount that brought inv-1 to partial).
        await db.payments.insert_one({
            "id": "pay-1", "company_id": cid, "source": "qbo",
            "direction": "in", "date": "2026-01-20",
            "amount": 50.0,
            "deposit_account_qbo_id": "4",
            "linked_invoice_id": "inv-1",
        })

        try:
            bs = await R.compute_balance_sheet(cid, as_of="2026-02-28",
                                               basis="accrual")
            assert bs["balanced"] is True, (
                f"BS should balance after payment cash-side + NI offset. "
                f"Assets={bs['total_assets']} "
                f"L+E={bs['total_liabilities_equity']} "
                f"imbalance={bs['imbalance']}"
            )
            # Assets = Undep $50 + AR $200 = $250
            # L+E    = OBE $0 + RE $0 + NI ($200 ar_end + $50 realized) = $250
            assert abs(bs["total_assets"] - 250.0) < 0.02
            assert abs(bs["total_liabilities_equity"] - 250.0) < 0.02
        finally:
            await _cleanup(cid)

    _run(go())
