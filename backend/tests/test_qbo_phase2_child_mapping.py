"""Regression tests — QBO Phase 2 parity fixes (Feb 28 2026).

Locks in three fixes that closed the Item→Account child mapping drift
on QBO Test 553 LLC (from $95.72 P&L drift down to $75 residual):

1. GeneralLedger-based line stamping (`resolve_qbo_gl_line_accounts`)
   — uses QBO's own GL as source-of-truth to stamp each invoice/bill
   line's account_qbo_id, matched via (doc_num, txn_type, amount, memo).
   Fixes the Item.IncomeAccountRef reassignment drift.
2. Leaf-first account scan order — parent revenue accounts' GL rolls
   up child postings; scanning leaves first + refusing to overwrite
   `gl_verified` lines keeps children correct.
3. QBO Deposit CashBack — the top-level `CashBack` object on a
   Deposit sends part of the deposit to a second bank account,
   captured via a negative-amount split so total DR/CR balances.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_account(cid: str, aid: str, qbo_id: str | None, name: str,
                        _type: str, detail_type: str = "",
                        parent_qbo_id: str | None = None):
    now = datetime.now(timezone.utc).isoformat()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "qbo_id": qbo_id, "source": "qbo",
        "code": aid[-4:], "name": name,
        "type": _type, "detail_type": detail_type,
        "parent_qbo_id": parent_qbo_id,
        "active": True, "balance": 0.0,
        "created_at": now, "updated_at": now,
    })


async def _cleanup(cid: str):
    for coll in (db.companies, db.accounts, db.invoices, db.bills,
                 db.payments, db.transactions, db.qbo_connections):
        await coll.delete_many({"company_id": cid})


def test_flatten_gl_rows_extracts_leaf_postings():
    """`_flatten_gl_rows` walks nested Rows/Header/Summary and yields
    every leaf posting row as a normalized dict."""
    from qbo_service import _flatten_gl_rows
    payload = [
        {"Header": {"ColData": [{"value": "Beverages"}]},
         "Rows": {"Row": [
             {"ColData": [
                 {"value": "2026-04-26"}, {"value": "Invoice"},
                 {"value": "1031"}, {"value": "Freeman"},
                 {"value": "Wine Bottle"}, {"value": "AR"},
                 {"value": "275.00"}, {"value": "275.00"},
             ]},
         ]},
         "Summary": {"ColData": [{"value": "Total"}, {"value": "275"}]}},
    ]
    out = _flatten_gl_rows(payload)
    assert len(out) == 1
    r = out[0]
    assert r["doc_num"] == "1031"
    assert r["txn_type"] == "Invoice"
    assert r["memo"] == "Wine Bottle"
    assert abs(r["amount"] - 275.0) < 0.005


def test_cashback_captured_on_deposit_splits():
    """A QBO Deposit with a top-level `CashBack` object should get a
    negative-amount split for the cashback destination bank, so total
    DRs equal total CRs and the BS stays balanced."""
    async def go():
        from qbo_service import resolve_deposit_splits
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Cashback Co"})
        await _seed_account(cid, "acct-undep-c", "4",
                            "Undeposited Funds", "asset", "money_in_transit")
        await _seed_account(cid, "acct-checking-c", "35",
                            "Checking", "asset", "cash_and_bank")
        await _seed_account(cid, "acct-savings-c", "36",
                            "Savings", "asset", "cash_and_bank")

        # Deposit with two swept payments totalling $500 → Checking,
        # $200 CashBack routed to Savings. Net Checking amount = $300.
        await db.transactions.insert_one({
            "id": "dep-cb-1", "company_id": cid, "source": "qbo",
            "txn_type": "Deposit", "posted": True,
            "date": "2026-02-15",
            "amount": 300.00,
            "bank_account_id": "acct-checking-c",
            "line_items": [
                {"amount": 200.0, "linked_txns": [{"TxnId": "1"}]},
                {"amount": 300.0, "linked_txns": [{"TxnId": "2"}]},
            ],
            "raw": {
                "CashBack": {
                    "AccountRef": {"value": "36", "name": "Savings"},
                    "Amount": 200.0,
                },
            },
        })

        try:
            stats = await resolve_deposit_splits(cid)
            assert stats["cashback_captured"] == 1
            dep = await db.transactions.find_one({"id": "dep-cb-1"})
            splits = dep.get("splits") or []
            cb_splits = [s for s in splits
                         if s.get("source") == "qbo_deposit_cashback"]
            assert len(cb_splits) == 1
            assert cb_splits[0]["account_id"] == "acct-savings-c"
            # Negative-amount split ⇒ `_signed_balances` treats it as
            # a DR (positive) on the cashback bank.
            assert abs(cb_splits[0]["amount"] - (-200.0)) < 0.005

            # Verify the accounting identity holds via _signed_balances.
            import reports as R
            by = await R._signed_balances(cid, start=None,
                                           end="2026-02-28",
                                           include_pre_period=True)
            # DRs: Checking $300 (bank_account_id) + Savings $200 = $500
            assert abs(by.get("acct-checking-c", 0) - 300.00) < 0.005
            assert abs(by.get("acct-savings-c", 0) - 200.00) < 0.005
            # CRs: Undep $500 total (two line sweeps)
            assert abs(by.get("acct-undep-c", 0) - (-500.00)) < 0.005
        finally:
            await _cleanup(cid)

    _run(go())


def test_creditmemo_reduces_accrual_revenue():
    """A QBO CreditMemo issued in the period should NEGATE the line's
    income account on the P&L accrual layer — matching QBO's own P&L
    behaviour. `_signed_balances` deliberately skips CMs to avoid
    double-counting AR reduction, so the accrual walker owns this."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "CM Co"})
        await _seed_account(cid, "acct-pest", "54",
                            "Pest Control Services", "revenue", "income")
        await _seed_account(cid, "acct-ar", "84",
                            "Accounts Receivable", "asset",
                            "accounts_receivable")
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test",
        })
        # Invoice $300 billed to Pest Control.
        await db.invoices.insert_one({
            "id": "inv-cm-1", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-05", "number": "INV-1",
            "total": 300.0, "balance_due": 200.0, "status": "partial",
            "contact_name": "Test",
            "line_items": [
                {"amount": 300.0, "account_qbo_id": "54",
                 "item_qbo_id": "pest-item"},
            ],
        })
        # CreditMemo for $100 applied back to Pest Control.
        await db.transactions.insert_one({
            "id": "cm-cm-1", "company_id": cid, "source": "qbo",
            "txn_type": "CreditMemo", "posted": True,
            "date": "2026-02-15", "number": "CM-1",
            "amount": -100.0,
            "line_items": [
                {"amount": 100.0, "account_qbo_id": "54",
                 "item_qbo_id": "pest-item", "item_name": "Pest"},
            ],
        })

        try:
            import reports as R
            r = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28",
                basis="accrual",
            )
            pest_row = next((x for x in r["revenue"]
                              if x["name"] == "Pest Control Services"),
                            None)
            assert pest_row is not None
            # Invoice adds $300, CM subtracts $100 → net $200.
            assert abs(pest_row["amount"] - 200.0) < 0.02, pest_row
        finally:
            await _cleanup(cid)

    _run(go())


def test_deep_account_signed_balance_swept_into_pl():
    """A grandchild-level revenue account with direct Purchase
    activity (Purchase categorized to a revenue leaf) MUST show up
    on the P&L with its raw signed balance included. Without the
    `_sweep_deep_accounts` pass, `_emit` walks parent + one level of
    children only and drops any deeper leaf's signed balance."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "DeepAcct Co"})
        # 3-level hierarchy: FoodBev(45) → FoodSupplies(46) → Takeout(49)
        await _seed_account(cid, "acct-45", "45",
                            "Food & Beverage Sales", "revenue", "income")
        await _seed_account(cid, "acct-46", "46",
                            "Food & Supplies", "revenue", "income",
                            parent_qbo_id="45")
        await _seed_account(cid, "acct-49", "49",
                            "Takeout", "revenue", "income",
                            parent_qbo_id="46")
        # Wire local parent_account_id
        await db.accounts.update_one({"id": "acct-46"},
                                     {"$set": {"parent_account_id": "acct-45"}})
        await db.accounts.update_one({"id": "acct-49"},
                                     {"$set": {"parent_account_id": "acct-46"}})
        await _seed_account(cid, "acct-checking-d", "35",
                            "Checking", "asset", "cash_and_bank")
        # Purchase categorized to grandchild Takeout: $50 outflow.
        await db.transactions.insert_one({
            "id": "purch-d-1", "company_id": cid, "source": "qbo",
            "txn_type": "Purchase", "posted": True,
            "date": "2026-02-10", "amount": -50.0,
            "bank_account_id": "acct-checking-d",
            "category_account_id": "acct-49",
        })

        try:
            import reports as R
            r = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28",
                basis="accrual",
            )
            takeout = next((x for x in r["revenue"]
                             if x["name"] == "Takeout"), None)
            assert takeout is not None, (
                "Takeout row must exist on P&L with -$50 from purchase"
            )
            # Purchase to a revenue leaf reduces its display revenue.
            assert abs(takeout["amount"] - (-50.0)) < 0.02, takeout
        finally:
            await _cleanup(cid)

    _run(go())
