"""Regression tests — BS/P&L subtotal aggregation + Opening Balance
guardrails (Feb 28 2026).

Locks in fixes that closed the Sandbox 358d (Craig's Landscaping)
migration drift:

1. `_emit_section` rows carry a `parent_id` (not just `parent_code`)
   because QBO-imported accounts routinely store `code = ""`, making
   parent-code lookup collapse to the empty string for every parent.
2. `total_assets` / `total_liabilities` / `total_equity` are the
   running totals `_emit_section` computed, NOT a re-sum of the row
   list — re-summing either double-counts subtotals or under-counts
   deep children (Truck → Original Cost dropped $13,495 before).
3. `_refresh_subtotals` on the P&L updates each "Total X" row after
   the accrual layer tops up child amounts. Without this the
   subtotal stays at emit-time value ($480 Legal & Professional Fees
   instead of the post-accrual $1,170).
4. Opening Balance JE (`_post_opening_balances_je`) only plugs
   accounts with ZERO imported activity AND skips sales-tax
   payables. Plugging accounts with real Deposit/Purchase activity
   double-counts; plugging sales-tax accounts inflates OBE by the
   accumulated tax liability.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_account(cid, aid, qbo_id, name, _type, detail_type="",
                        parent_account_id=None, code=""):
    now = datetime.now(timezone.utc).isoformat()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "qbo_id": qbo_id, "source": "qbo",
        "code": code, "name": name, "type": _type,
        "detail_type": detail_type,
        "parent_account_id": parent_account_id,
        "active": True, "balance": 0.0,
        "created_at": now, "updated_at": now,
    })


async def _cleanup(cid):
    for coll in (db.companies, db.accounts, db.invoices, db.bills,
                 db.payments, db.transactions, db.journal_entries,
                 db.qbo_connections):
        await coll.delete_many({"company_id": cid})


def test_bs_totals_include_grandchild_activity():
    """Truck (parent, $0 direct) → Original Cost (child, $13,495)
    must contribute to Total Assets. Prior bug summed only top-level
    rows without parent_id/parent_code, so Original Cost was excluded
    as a child AND Truck's $0 direct won the parent row → Total
    Assets short by $13,495."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Truck Co"})
        await _seed_account(cid, "acct-truck", "37", "Truck", "asset",
                            "property_plant_equipment")
        await _seed_account(cid, "acct-orig", "38", "Original Cost",
                            "asset", "property_plant_equipment",
                            parent_account_id="acct-truck")
        # Post the opening balance directly via a JE (bypasses the
        # opening-balance resolver so we test the totals math cleanly).
        await db.journal_entries.insert_one({
            "id": "je-truck", "company_id": cid, "posted": True,
            "date": "2020-01-01",
            "lines": [
                {"account_id": "acct-orig", "debit": 13495.0, "credit": 0},
                # OBE side omitted — this test only cares about assets.
            ],
        })

        try:
            import reports as R
            bs = await R.compute_balance_sheet(
                cid, as_of="2026-12-31", basis="accrual")
            assert abs(bs["total_assets"] - 13495.0) < 0.02, (
                f"expected Total Assets $13,495 from Original Cost "
                f"grandchild activity, got {bs['total_assets']}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_pl_subtotal_refreshes_after_accrual():
    """After the accrual layer tops up expense child rows (Bill lines
    added to Accounting/Bookkeeper/Lawyer), the "Total Legal &
    Professional Fees" subtotal MUST reflect the new child sum. Prior
    bug left the subtotal at emit-time value."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "L&P Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test",
        })
        await _seed_account(cid, "acct-lp", "12",
                            "Legal & Professional Fees", "expense")
        await _seed_account(cid, "acct-acct", "69", "Accounting",
                            "expense", parent_account_id="acct-lp")
        await _seed_account(cid, "acct-book", "70", "Bookkeeper",
                            "expense", parent_account_id="acct-lp")
        await _seed_account(cid, "acct-ap", "84",
                            "Accounts Payable", "liability",
                            "accounts_payable")
        # L&P parent needs some direct activity so `_emit` fires and
        # creates the subtotal row. And each child needs base signed
        # activity too (via a Purchase-style JE) so kids_rows aren't
        # empty at emit time — otherwise there's no subtotal row to
        # refresh. This mirrors the real Sandbox 358d shape.
        await _seed_account(cid, "acct-cash-lp", "35", "Checking",
                            "asset", "cash_and_bank")
        await db.journal_entries.insert_one({
            "id": "je-lp-direct", "company_id": cid, "posted": True,
            "date": "2026-02-01",
            "lines": [
                {"account_id": "acct-lp",       "debit": 10.0, "credit": 0},
                {"account_id": "acct-acct",     "debit": 1.0,  "credit": 0},
                {"account_id": "acct-book",     "debit": 1.0,  "credit": 0},
                {"account_id": "acct-cash-lp",  "debit": 0,    "credit": 12.0},
            ],
        })
        # Bill against Accounting for $640.
        await db.bills.insert_one({
            "id": "bill-1", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-05", "number": "B-1",
            "total": 640.0, "balance_due": 640.0, "status": "open",
            "line_items": [
                {"amount": 640.0, "account_qbo_id": "69"},
            ],
        })
        # Bill against Bookkeeper for $55.
        await db.bills.insert_one({
            "id": "bill-2", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-10", "number": "B-2",
            "total": 55.0, "balance_due": 55.0, "status": "open",
            "line_items": [
                {"amount": 55.0, "account_qbo_id": "70"},
            ],
        })

        try:
            import reports as R
            pl = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-12-31",
                basis="accrual")
            subtotal = next((r for r in pl["expenses"]
                              if r.get("name") == "Total Legal & Professional Fees"),
                            None)
            assert subtotal is not None, "expected subtotal row"
            # L&P direct ($10) + Accounting signed ($1 + $640 bill) +
            # Bookkeeper signed ($1 + $55 bill) = $707.
            assert abs(subtotal["amount"] - 707.0) < 0.02, (
                f"expected Total L&P subtotal $707 after accrual "
                f"top-up, got {subtotal['amount']}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_opening_balance_skips_accounts_with_activity():
    """`_post_opening_balances_je` MUST NOT plug accounts that
    already carry imported ledger activity — plugging on top of
    real Deposit/Purchase txns would double-count the opening piece
    and quietly bake import bugs into OBE."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Activity Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test",
        })
        # Checking with QBO CurrentBalance $1,201 AND imported activity.
        await _seed_account(cid, "acct-check", "35", "Checking",
                            "asset", "cash_and_bank")
        # Overwrite `raw.CurrentBalance` so the opening balance
        # resolver has something to compare against.
        await db.accounts.update_one(
            {"id": "acct-check"},
            {"$set": {"raw": {"CurrentBalance": 1201.0,
                                "AccountType": "Bank"}}},
        )
        # Post real Deposit activity to Checking.
        await db.transactions.insert_one({
            "id": "dep-1", "company_id": cid, "source": "qbo",
            "txn_type": "Deposit", "posted": True,
            "date": "2026-01-15", "amount": 1201.0,
            "bank_account_id": "acct-check",
        })
        # OBE account (required by the resolver).
        await _seed_account(cid, "acct-obe", "34",
                            "Opening Balance Equity", "equity")

        try:
            from qbo_service import _post_opening_balances_je
            stats = await _post_opening_balances_je(cid)
            # Zero-line JE because Checking has activity, and OBE
            # itself is excluded from the scan.
            assert stats.get("line_count", 0) == 0, (
                f"expected line_count=0 (no eligible accounts), "
                f"got {stats}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_opening_balance_skips_sales_tax_payable():
    """Sales-tax payables (Board of Equalization, Sales Tax Payable,
    etc.) get populated automatically by QBO whenever an Invoice
    contains tax lines — they should never carry an opening
    balance plug. Otherwise OBE inflates by the accumulated
    sales-tax liability."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "SalesTax Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test",
        })
        await _seed_account(cid, "acct-boe", "90",
                            "Board of Equalization Payable", "liability",
                            "expected_payments_to_vendors")
        await db.accounts.update_one(
            {"id": "acct-boe"},
            {"$set": {"raw": {"CurrentBalance": -370.94,
                                "AccountType": "Other Current Liability",
                                "AccountSubType": "GlobalTaxPayable"}}},
        )
        await _seed_account(cid, "acct-obe", "34",
                            "Opening Balance Equity", "equity")

        try:
            from qbo_service import _post_opening_balances_je
            stats = await _post_opening_balances_je(cid)
            assert stats.get("line_count", 0) == 0, (
                f"expected line_count=0 (sales-tax skipped), "
                f"got {stats}"
            )
        finally:
            await _cleanup(cid)

    _run(go())


def test_opening_balance_plugs_zero_activity_fixed_asset():
    """The positive case: a Fixed Asset (Truck.Original Cost) with
    QBO CurrentBalance $13,495 and NO imported activity is exactly
    what the opening-balance plug exists for — post a JE."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "FA Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test",
        })
        await _seed_account(cid, "acct-orig", "38",
                            "Original Cost", "asset",
                            "property_plant_equipment")
        await db.accounts.update_one(
            {"id": "acct-orig"},
            {"$set": {"raw": {"CurrentBalance": 13495.0,
                                "AccountType": "Fixed Asset",
                                "AccountSubType": "Vehicles"}}},
        )
        await _seed_account(cid, "acct-obe", "34",
                            "Opening Balance Equity", "equity")

        try:
            from qbo_service import _post_opening_balances_je
            stats = await _post_opening_balances_je(cid)
            # Original Cost DR $13,495 + OBE CR $13,495 = 2 lines.
            assert stats.get("line_count", 0) == 2, stats
            assert abs(stats.get("gross_debits", 0) - 13495.0) < 0.02
        finally:
            await _cleanup(cid)

    _run(go())
