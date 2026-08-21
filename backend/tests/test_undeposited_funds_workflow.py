"""Regression tests — Undeposited Funds two-step workflow (Feb 28 2026).

QBO models customer receipts as a two-step flow:
  1. Receive Payment → sits in Undeposited Funds
  2. Bank Deposit → sweeps UF into an actual bank account

Axiom mirrors this. Three behaviors this suite locks in:
  A. QBO Payment IN with no `DepositToAccountRef` falls through to the
     company's Undeposited Funds account in reports.
  B. Native payments (source != qbo) with no `deposit_to_account_id`
     and no `source_transaction_id` still keep the Balance Sheet
     balanced — the cash-side DR posts to UF.
  C. Native payments paired with a bank transaction
     (`source_transaction_id`) are NOT double-posted — the txn already
     handled the cash side.

Plus `resolve_payment_undeposited` backfills the `deposit_*` fields on
legacy rows so downstream reports become idempotent.
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


def test_qbo_payment_in_no_deposit_ref_falls_back_to_undep():
    """A QBO Payment IN with `deposit_account_qbo_id=None` and no
    CheckPayment/CC refs in `raw` should still DR the company's
    Undeposited Funds account (via the reports-layer fallback) —
    otherwise the held cash silently vanishes from the BS."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "UF Fallback Co"})
        await _seed_account(cid, "acct-undep", "4", "Undeposited Funds",
                            "asset", "money_in_transit")
        await db.payments.insert_one({
            "id": "pay-noref", "company_id": cid, "source": "qbo",
            "direction": "in", "date": "2026-02-01",
            "amount": 300.00,
            "deposit_account_qbo_id": None,
            "raw": {},  # no CheckPayment/CC hints
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            assert abs(by.get("acct-undep", 0) - 300.00) < 0.005, (
                f"expected Undep +$300 from UF fallback, "
                f"got {by.get('acct-undep')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_native_payment_no_deposit_account_uses_undep():
    """Native payment (source != qbo) with `deposit_to_account_id`
    unset and no paired transaction posts its cash side to UF."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Native UF Co"})
        await _seed_account(cid, "acct-undep-n", None, "Undeposited Funds",
                            "asset", "money_in_transit")
        await db.payments.insert_one({
            "id": "pay-native-1", "company_id": cid,
            "direction": "in", "date": "2026-02-05",
            "amount": 125.50,
            # No source_transaction_id, no deposit_to_account_id.
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            assert abs(by.get("acct-undep-n", 0) - 125.50) < 0.005, (
                f"expected Undep +$125.50 from native UF fallback, "
                f"got {by.get('acct-undep-n')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_native_payment_with_deposit_to_posts_to_selected_bank():
    """When the user explicitly picks a bank on the Record Payment
    modal, cash DRs THAT bank — not Undeposited Funds."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Direct Deposit Co"})
        await _seed_account(cid, "acct-undep-d", None, "Undeposited Funds",
                            "asset", "money_in_transit")
        await _seed_account(cid, "acct-checking-d", None, "Checking",
                            "asset", "cash_and_bank")
        await db.payments.insert_one({
            "id": "pay-native-2", "company_id": cid,
            "direction": "in", "date": "2026-02-06",
            "amount": 400.00,
            "deposit_to_account_id": "acct-checking-d",
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            assert abs(by.get("acct-checking-d", 0) - 400.00) < 0.005, (
                f"expected Checking +$400 from direct deposit, "
                f"got {by.get('acct-checking-d')}"
            )
            # UF should NOT be touched.
            assert abs(by.get("acct-undep-d", 0)) < 0.005, (
                f"UF should stay $0 when a bank is picked, "
                f"got {by.get('acct-undep-d')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_native_payment_paired_with_txn_not_double_posted():
    """A native payment linked to a bank transaction via
    `source_transaction_id` must NOT post its own cash side —
    the transaction already did. Double-posting would inflate
    the bank account by 2x the payment amount."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Paired Co"})
        await _seed_account(cid, "acct-checking-p", None, "Checking",
                            "asset", "cash_and_bank")
        await _seed_account(cid, "acct-undep-p", None, "Undeposited Funds",
                            "asset", "money_in_transit")
        # Bank transaction — the "real" cash-in.
        await db.transactions.insert_one({
            "id": "txn-1", "company_id": cid, "posted": True,
            "txn_type": "Deposit", "date": "2026-02-10",
            "amount": 500.00,
            "bank_account_id": "acct-checking-p",
        })
        # Native payment paired to that txn.
        await db.payments.insert_one({
            "id": "pay-paired", "company_id": cid,
            "direction": "in", "date": "2026-02-10",
            "amount": 500.00,
            "source_transaction_id": "txn-1",
            # deposit_to_account_id would be UF if create_payment auto-filled,
            # but the paired-txn short-circuit must beat it either way.
            "deposit_to_account_id": "acct-undep-p",
        })

        try:
            by = await R._signed_balances(cid, start=None,
                                          end="2026-02-28",
                                          include_pre_period=True)
            # Checking should be $500 (from the txn), NOT $1000.
            assert abs(by.get("acct-checking-p", 0) - 500.00) < 0.005, (
                f"expected Checking $500 (no double-post), "
                f"got {by.get('acct-checking-p')}"
            )
            # UF should be untouched.
            assert abs(by.get("acct-undep-p", 0)) < 0.005, (
                f"UF should stay $0 when payment is paired, "
                f"got {by.get('acct-undep-p')}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_resolve_payment_undeposited_backfills_stamps():
    """The backfill resolver stamps `deposit_to_account_id` on native
    payments and `deposit_account_qbo_id` on QBO payments that lack a
    resolvable cash-side reference. Idempotent — re-runs stamp zero."""
    async def go():
        from qbo_service import resolve_payment_undeposited
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Backfill Co"})
        await _seed_account(cid, "acct-undep-b", "4", "Undeposited Funds",
                            "asset", "money_in_transit")
        # A QBO payment missing the deposit ref.
        await db.payments.insert_one({
            "id": "pay-qbo-b", "company_id": cid, "source": "qbo",
            "direction": "in", "date": "2026-02-01",
            "amount": 90.00,
            "deposit_account_qbo_id": None,
            "raw": {},
        })
        # A native payment missing the deposit ref, no paired txn.
        await db.payments.insert_one({
            "id": "pay-native-b", "company_id": cid,
            "direction": "in", "date": "2026-02-02",
            "amount": 60.00,
        })

        try:
            stats1 = await resolve_payment_undeposited(cid)
            assert stats1["undep_found"] is True
            assert stats1["qbo_stamped"] == 1, stats1
            assert stats1["native_stamped"] == 1, stats1

            qbo = await db.payments.find_one({"id": "pay-qbo-b"})
            assert qbo.get("deposit_account_qbo_id") == "4"
            assert qbo.get("held_in_undeposited") is True

            nat = await db.payments.find_one({"id": "pay-native-b"})
            assert nat.get("deposit_to_account_id") == "acct-undep-b"
            assert nat.get("held_in_undeposited") is True

            # Idempotency — a second run should stamp nothing new.
            stats2 = await resolve_payment_undeposited(cid)
            assert stats2["qbo_stamped"] == 0, stats2
            assert stats2["native_stamped"] == 0, stats2
        finally:
            await _cleanup(cid)

    _run(go())
