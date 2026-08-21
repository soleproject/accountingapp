"""Regression tests — Cash-basis reports parity (Feb 28 2026).

Locks in QBO cash-basis parity on Craig's Landscaping sandbox:
1. Revenue on cash basis = payments received × invoice-line proration
   (not the accrual invoice-issued layer).
2. Expenses on cash basis = payments made × bill-line proration.
3. Inventory Asset is STRIPPED from the cash BS (QBO's convention:
   inventory is expensed at purchase on cash accounting), with the
   removed asset value rolling into Net Income as a cash expense so
   the sheet still balances.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_account(cid, aid, qbo_id, name, _type, detail_type="",
                         parent_account_id=None):
    now = datetime.now(timezone.utc).isoformat()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "qbo_id": qbo_id, "source": "qbo",
        "code": "", "name": name, "type": _type,
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


def test_cash_revenue_from_full_invoice_payment():
    """Full-payment case: Payment $500 against a $500 Invoice with
    two lines (Design $300, Services $200) must post the full line
    amounts to their respective revenue accounts on cash basis."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "CashRev Co"})
        await _seed_account(cid, "acct-design", "1", "Design income", "revenue")
        await _seed_account(cid, "acct-svc",    "2", "Services",      "revenue")
        await _seed_account(cid, "acct-ar",     "84", "A/R",          "asset",
                            "accounts_receivable")
        await db.invoices.insert_one({
            "id": "inv-1", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-01", "number": "INV-1",
            "total": 500.0, "balance_due": 0.0, "status": "paid",
            "line_items": [
                {"amount": 300.0, "account_qbo_id": "1"},
                {"amount": 200.0, "account_qbo_id": "2"},
            ],
        })
        await db.payments.insert_one({
            "id": "pay-1", "company_id": cid, "direction": "in",
            "date": "2026-02-15", "amount": 500.0,
            "linked_invoice_id": "inv-1",
        })

        try:
            import reports as R
            pl = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28", basis="cash")
            design = next((r for r in pl["revenue"]
                            if r["name"] == "Design income"), None)
            svc = next((r for r in pl["revenue"]
                          if r["name"] == "Services"), None)
            assert design and abs(design["amount"] - 300.0) < 0.02, design
            assert svc and abs(svc["amount"] - 200.0) < 0.02, svc
            assert abs(pl["total_revenue"] - 500.0) < 0.02, pl["total_revenue"]
        finally:
            await _cleanup(cid)

    _run(go())


def test_cash_revenue_partial_payment_top_down():
    """Top-down application (matches QBO): $250 payment against $500
    Invoice with lines Design $300 / Services $200 consumes lines in
    order — Design gets the full $250, Services gets $0. Prior
    proration variant would have posted Design $150 / Services $100."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "PartialPay Co"})
        await _seed_account(cid, "acct-d", "1", "Design", "revenue")
        await _seed_account(cid, "acct-s", "2", "Services", "revenue")
        await db.invoices.insert_one({
            "id": "inv-p", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-01", "number": "INV-P",
            "total": 500.0, "balance_due": 250.0, "status": "partial",
            "line_items": [
                {"amount": 300.0, "account_qbo_id": "1"},
                {"amount": 200.0, "account_qbo_id": "2"},
            ],
        })
        await db.payments.insert_one({
            "id": "pay-p", "company_id": cid, "direction": "in",
            "date": "2026-02-15", "amount": 250.0,
            "linked_invoice_id": "inv-p",
        })

        try:
            import reports as R
            pl = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28", basis="cash")
            d = next(r for r in pl["revenue"] if r["name"] == "Design")
            s_row = next((r for r in pl["revenue"]
                            if r["name"] == "Services"), None)
            # Top-down: full $250 lands on Design.
            assert abs(d["amount"] - 250.0) < 0.02, d
            # Services line untouched — either absent or $0.
            assert s_row is None or abs(s_row["amount"]) < 0.02, s_row
        finally:
            await _cleanup(cid)

    _run(go())


def test_cash_expenses_from_bill_payment():
    """Payment against a Bill posts its line-amount slice to the
    correct expense account on cash basis. Unpaid bills contribute
    nothing."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "BillPay Co"})
        await _seed_account(cid, "acct-adv", "1", "Advertising", "expense")
        await _seed_account(cid, "acct-rent", "2", "Rent", "expense")
        await db.bills.insert_one({
            "id": "bill-p", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-01", "number": "B-P",
            "total": 300.0, "balance_due": 0.0, "status": "paid",
            "line_items": [
                {"amount": 100.0, "account_qbo_id": "1"},
                {"amount": 200.0, "account_qbo_id": "2"},
            ],
        })
        # Unpaid bill — should NOT show on cash.
        await db.bills.insert_one({
            "id": "bill-u", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-05", "number": "B-U",
            "total": 500.0, "balance_due": 500.0, "status": "open",
            "line_items": [
                {"amount": 500.0, "account_qbo_id": "1"},
            ],
        })
        await db.payments.insert_one({
            "id": "pay-out", "company_id": cid, "direction": "out",
            "date": "2026-02-20", "amount": 300.0,
            "linked_bill_id": "bill-p",
        })

        try:
            import reports as R
            pl = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28", basis="cash")
            adv = next(r for r in pl["expenses"] if r["name"] == "Advertising")
            rent = next(r for r in pl["expenses"] if r["name"] == "Rent")
            assert abs(adv["amount"] - 100.0) < 0.02, adv
            assert abs(rent["amount"] - 200.0) < 0.02, rent
            # Unpaid bill contributes nothing → total = $300 only.
            assert abs(pl["total_expense"] - 300.0) < 0.02, pl["total_expense"]
        finally:
            await _cleanup(cid)

    _run(go())


def test_cash_bs_strips_inventory_asset():
    """QBO cash BS convention: inventory is expensed at purchase, not
    tracked as an asset. Strip Inventory Asset from the cash BS and
    roll its value into Net Income so the sheet stays balanced."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Inv Cash Co"})
        await _seed_account(cid, "acct-check-cbs", "1", "Checking", "asset",
                            "cash_and_bank")
        await _seed_account(cid, "acct-inv-cbs", "2", "Inventory Asset",
                            "asset", "inventory")
        await _seed_account(cid, "acct-obe-cbs", "34",
                            "Opening Balance Equity", "equity")
        # DR Inventory $500, CR OBE $500 (a synthesized opening posting).
        await db.journal_entries.insert_one({
            "id": "je-inv-cbs", "company_id": cid, "posted": True,
            "date": "2026-01-01",
            "lines": [
                {"account_id": "acct-inv-cbs", "debit": 500.0, "credit": 0},
                {"account_id": "acct-obe-cbs", "debit": 0, "credit": 500.0},
            ],
        })

        try:
            import reports as R
            bs = await R.compute_balance_sheet(
                cid, as_of="2026-02-28", basis="cash")
            # Inventory Asset MUST NOT appear.
            has_inv = any(r["name"] == "Inventory Asset"
                          for r in bs["assets"])
            assert not has_inv, (
                "Inventory Asset should be stripped from cash BS"
            )
            # And it must NOT be counted in total_assets.
            assert abs(bs["total_assets"]) < 0.02, (
                f"expected Total Assets $0 (checking $0 + inventory "
                f"stripped), got {bs['total_assets']}"
            )
            # Sheet must still balance.
            assert bs["balanced"], bs["imbalance"]
        finally:
            await _cleanup(cid)

    _run(go())

def test_sales_tax_populates_payable_from_invoice_tax_lines():
    """Invoice `TxnTaxDetail.TaxLine` entries route to the correct
    sales-tax-payable account based on the tax rate's agency name."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "SalesTax Co"})
        await _seed_account(cid, "acct-rev-st", "1", "Sales", "revenue")
        await _seed_account(cid, "acct-ar-st", "84", "A/R", "asset",
                            "accounts_receivable")
        now = datetime.now(timezone.utc).isoformat()
        await db.accounts.insert_one({
            "id": "acct-boe-st", "company_id": cid, "qbo_id": "90",
            "source": "qbo", "code": "",
            "name": "Board of Equalization Payable",
            "type": "liability", "detail_type": "",
            "raw": {"AccountSubType": "GlobalTaxPayable"},
            "active": True, "created_at": now, "updated_at": now,
        })
        await db.tax_rates.insert_one({
            "company_id": cid, "qbo_id": "3", "source": "qbo",
            "name": "California", "rate": 8.0,
            "agency_qbo_id": "2",
            "agency_name": "Board of Equalization",
        })
        await db.invoices.insert_one({
            "id": "inv-st", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-05", "number": "INV-ST",
            "total": 108.0, "balance_due": 108.0, "status": "open",
            "line_items": [
                {"amount": 100.0, "account_qbo_id": "1"},
            ],
            "raw": {"TxnTaxDetail": {
                "TotalTax": 8.0,
                "TaxLine": [{
                    "Amount": 8.0,
                    "DetailType": "TaxLineDetail",
                    "TaxLineDetail": {"TaxRateRef": {"value": "3"},
                                        "NetAmountTaxable": 100.0}}]}},
        })

        try:
            import reports as R
            bs = await R.compute_balance_sheet(
                cid, as_of="2026-02-28", basis="accrual")
            boe = next((r for r in bs["liabilities"]
                         if r["name"] == "Board of Equalization Payable"),
                        None)
            assert boe is not None, "expected BoE Payable row on BS"
            assert abs(boe["amount"] - 8.0) < 0.02, boe
        finally:
            await db.tax_rates.delete_many({"company_id": cid})
            await _cleanup(cid)

    _run(go())




def test_cash_multi_payment_advances_line_pointer():
    """MULTI-PAYMENT bug fix (Aug 21 2026): Two payments on the same
    invoice must advance the top-down consumption pointer cumulatively
    — the second payment must NOT restart from the top of the invoice
    lines. Prior bug on Sandbox 358d Craig's Landscaping: Invoice 1004
    ($20 + $24 + $1,750 + $400 = $2,194 subtotal) paid by P1=$694 and
    P2=$1,500 posted Sprinklers 2x ($88 vs QBO $44), Sod double-
    counted, and Services $400 was never reached (drift -$400).
    """
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "MultiPay Co"})
        await _seed_account(cid, "acct-sp", "1", "Sales of Product",
                            "revenue")
        await _seed_account(cid, "acct-plants", "2", "Plants", "revenue")
        await _seed_account(cid, "acct-svc", "3", "Services", "revenue")
        await db.invoices.insert_one({
            "id": "inv-mp", "company_id": cid, "source": "qbo",
            "issue_date": "2026-07-13", "number": "1004",
            "total": 2194.0, "balance_due": 0.0, "status": "paid",
            "line_items": [
                {"amount": 20.0,   "account_qbo_id": "1"},
                {"amount": 24.0,   "account_qbo_id": "1"},
                {"amount": 1750.0, "account_qbo_id": "2"},
                {"amount": 400.0,  "account_qbo_id": "3"},
            ],
        })
        # Two payments — must be treated cumulatively.
        await db.payments.insert_one({
            "id": "pay-mp1", "company_id": cid, "direction": "in",
            "date": "2026-07-18", "amount": 694.0,
            "linked_invoice_id": "inv-mp",
        })
        await db.payments.insert_one({
            "id": "pay-mp2", "company_id": cid, "direction": "in",
            "date": "2026-07-25", "amount": 1500.0,
            "linked_invoice_id": "inv-mp",
        })

        try:
            import reports as R
            pl = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-12-31", basis="cash")
            def _amt(name):
                row = next((r for r in pl["revenue"]
                             if r["name"] == name), None)
                return row["amount"] if row else 0.0
            # Both payments in window -> total paid $2,194 -> full
            # top-down consumption reaches every line.
            assert abs(_amt("Sales of Product") - 44.0) < 0.02, (
                f"Sales of Product should be $44 (once), got {_amt('Sales of Product')}"
            )
            assert abs(_amt("Plants") - 1750.0) < 0.02, (
                f"Plants should be $1,750 (once), got {_amt('Plants')}"
            )
            assert abs(_amt("Services") - 400.0) < 0.02, (
                f"Services should be $400 (reached by second payment), "
                f"got {_amt('Services')}"
            )
            assert abs(pl["total_revenue"] - 2194.0) < 0.02, pl["total_revenue"]
        finally:
            await _cleanup(cid)

    _run(go())


def test_cash_pre_period_payment_advances_pointer_without_posting():
    """A payment BEFORE the report window advances the consumption
    pointer but does NOT post revenue. A later in-window payment
    then attributes only to lines it actually consumes."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "PrePeriod Co"})
        await _seed_account(cid, "acct-a", "1", "Line A", "revenue")
        await _seed_account(cid, "acct-b", "2", "Line B", "revenue")
        await db.invoices.insert_one({
            "id": "inv-pp", "company_id": cid, "source": "qbo",
            "issue_date": "2026-01-15", "number": "INV-PP",
            "total": 500.0, "balance_due": 0.0, "status": "paid",
            "line_items": [
                {"amount": 300.0, "account_qbo_id": "1"},
                {"amount": 200.0, "account_qbo_id": "2"},
            ],
        })
        # Payment BEFORE window (Jan) - advances pointer past Line A.
        await db.payments.insert_one({
            "id": "pay-pre", "company_id": cid, "direction": "in",
            "date": "2026-01-20", "amount": 300.0,
            "linked_invoice_id": "inv-pp",
        })
        # Payment IN window (Feb) - should hit Line B only.
        await db.payments.insert_one({
            "id": "pay-in", "company_id": cid, "direction": "in",
            "date": "2026-02-15", "amount": 200.0,
            "linked_invoice_id": "inv-pp",
        })

        try:
            import reports as R
            pl = await R.compute_income_statement(
                cid, start="2026-02-01", end="2026-02-28", basis="cash")
            a = next((r for r in pl["revenue"]
                        if r["name"] == "Line A"), None)
            b = next((r for r in pl["revenue"]
                        if r["name"] == "Line B"), None)
            # Line A payment was pre-period -> NOT posted here.
            assert a is None or abs(a["amount"]) < 0.02, (
                f"Line A should be $0 in Feb window, got {a}"
            )
            # Line B $200 fully in-window.
            assert b and abs(b["amount"] - 200.0) < 0.02, (
                f"Line B should be $200, got {b}"
            )
            assert abs(pl["total_revenue"] - 200.0) < 0.02, pl["total_revenue"]
        finally:
            await _cleanup(cid)

    _run(go())



def test_credit_memo_tax_reversal_zeroes_payable():
    """CreditMemo `TxnTaxDetail.TaxLine` must be SUBTRACTED from the
    same sales-tax-payable so a fully credited invoice leaves no
    phantom tax on the BS. Craig's Landscaping regression: BoE Payable
    was $38.50 too high because a $38.50 CM reversal was ignored.
    """
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "CM Tax Co"})
        await _seed_account(cid, "acct-rev-cm", "1", "Sales", "revenue")
        await _seed_account(cid, "acct-ar-cm", "84", "A/R", "asset",
                            "accounts_receivable")
        now = datetime.now(timezone.utc).isoformat()
        await db.accounts.insert_one({
            "id": "acct-boe-cm", "company_id": cid, "qbo_id": "90",
            "source": "qbo", "code": "",
            "name": "Board of Equalization Payable",
            "type": "liability", "detail_type": "",
            "raw": {"AccountSubType": "GlobalTaxPayable"},
            "active": True, "created_at": now, "updated_at": now,
        })
        await db.tax_rates.insert_one({
            "company_id": cid, "qbo_id": "3", "source": "qbo",
            "name": "California", "rate": 8.0,
            "agency_qbo_id": "2",
            "agency_name": "Board of Equalization",
        })
        # Invoice with $8 tax
        await db.invoices.insert_one({
            "id": "inv-cm", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-05", "number": "INV-CM",
            "total": 108.0, "balance_due": 108.0, "status": "open",
            "line_items": [{"amount": 100.0, "account_qbo_id": "1"}],
            "raw": {"TxnTaxDetail": {
                "TotalTax": 8.0,
                "TaxLine": [{
                    "Amount": 8.0, "DetailType": "TaxLineDetail",
                    "TaxLineDetail": {"TaxRateRef": {"value": "3"},
                                       "NetAmountTaxable": 100.0}}]}},
        })
        # CreditMemo reversing the same $8 tax line
        await db.transactions.insert_one({
            "id": "cm-1", "company_id": cid, "source": "qbo",
            "txn_type": "CreditMemo",
            "date": "2026-02-10", "amount": 108.0,
            "raw": {"TxnTaxDetail": {
                "TotalTax": 8.0,
                "TaxLine": [{
                    "Amount": 8.0, "DetailType": "TaxLineDetail",
                    "TaxLineDetail": {"TaxRateRef": {"value": "3"},
                                       "NetAmountTaxable": 100.0}}]}},
        })

        try:
            import reports as R
            bs = await R.compute_balance_sheet(
                cid, as_of="2026-02-28", basis="accrual")
            boe = next((r for r in bs["liabilities"]
                         if r["name"] == "Board of Equalization Payable"),
                        None)
            # Invoice +$8, CM -$8 → net $0 on the payable → row should
            # be absent (or effectively zero).
            assert boe is None or abs(boe["amount"]) < 0.02, (
                f"expected BoE Payable to net to $0 after CM reversal, "
                f"got {boe}"
            )
        finally:
            await db.tax_rates.delete_many({"company_id": cid})
            await _cleanup(cid)

    _run(go())


def test_refund_receipt_tax_reversal_zeroes_payable():
    """RefundReceipt `TxnTaxDetail.TaxLine` must also reverse tax on
    the payable (money already refunded to customer means the tax
    collected was never truly owed to the agency)."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "RR Tax Co"})
        await _seed_account(cid, "acct-rev-rr", "1", "Sales", "revenue")
        await _seed_account(cid, "acct-ar-rr", "84", "A/R", "asset",
                            "accounts_receivable")
        now = datetime.now(timezone.utc).isoformat()
        await db.accounts.insert_one({
            "id": "acct-az-rr", "company_id": cid, "qbo_id": "91",
            "source": "qbo", "code": "",
            "name": "Arizona Dept of Revenue Payable",
            "type": "liability", "detail_type": "",
            "raw": {"AccountSubType": "GlobalTaxPayable"},
            "active": True, "created_at": now, "updated_at": now,
        })
        await db.tax_rates.insert_one({
            "company_id": cid, "qbo_id": "5", "source": "qbo",
            "name": "Arizona", "rate": 6.0,
            "agency_qbo_id": "4",
            "agency_name": "Arizona Dept of Revenue",
        })
        # Invoice with $6 tax
        await db.invoices.insert_one({
            "id": "inv-rr", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-05", "number": "INV-RR",
            "total": 106.0, "balance_due": 106.0, "status": "open",
            "line_items": [{"amount": 100.0, "account_qbo_id": "1"}],
            "raw": {"TxnTaxDetail": {
                "TotalTax": 6.0,
                "TaxLine": [{
                    "Amount": 6.0, "DetailType": "TaxLineDetail",
                    "TaxLineDetail": {"TaxRateRef": {"value": "5"},
                                       "NetAmountTaxable": 100.0}}]}},
        })
        # RefundReceipt reversing $6 tax
        await db.transactions.insert_one({
            "id": "rr-1", "company_id": cid, "source": "qbo",
            "txn_type": "RefundReceipt",
            "date": "2026-02-10", "amount": 106.0,
            "raw": {"TxnTaxDetail": {
                "TotalTax": 6.0,
                "TaxLine": [{
                    "Amount": 6.0, "DetailType": "TaxLineDetail",
                    "TaxLineDetail": {"TaxRateRef": {"value": "5"},
                                       "NetAmountTaxable": 100.0}}]}},
        })

        try:
            import reports as R
            bs = await R.compute_balance_sheet(
                cid, as_of="2026-02-28", basis="accrual")
            az = next((r for r in bs["liabilities"]
                         if r["name"] == "Arizona Dept of Revenue Payable"),
                        None)
            assert az is None or abs(az["amount"]) < 0.02, (
                f"expected AZ Payable to net to $0 after RR reversal, "
                f"got {az}"
            )
        finally:
            await db.tax_rates.delete_many({"company_id": cid})
            await _cleanup(cid)

    _run(go())


def test_cash_and_accrual_disagree_on_unpaid_invoice():
    """A fundamental cash-vs-accrual property: an unpaid invoice
    contributes revenue on accrual but zero on cash."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Unpaid Co"})
        await _seed_account(cid, "acct-svc", "1", "Services", "revenue")
        await _seed_account(cid, "acct-ar", "84", "A/R", "asset",
                            "accounts_receivable")
        await db.invoices.insert_one({
            "id": "inv-u", "company_id": cid, "source": "qbo",
            "issue_date": "2026-02-01", "number": "INV-U",
            "total": 250.0, "balance_due": 250.0, "status": "open",
            "line_items": [
                {"amount": 250.0, "account_qbo_id": "1"},
            ],
        })

        try:
            import reports as R
            pl_a = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28", basis="accrual")
            pl_c = await R.compute_income_statement(
                cid, start="2026-01-01", end="2026-02-28", basis="cash")
            assert abs(pl_a["total_revenue"] - 250.0) < 0.02, (
                f"accrual should count unpaid invoice, "
                f"got {pl_a['total_revenue']}"
            )
            assert abs(pl_c["total_revenue"]) < 0.02, (
                f"cash should NOT count unpaid invoice, "
                f"got {pl_c['total_revenue']}"
            )
        finally:
            await _cleanup(cid)

    _run(go())
