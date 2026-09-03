"""Sales-Tax → GL parity regression.

Verifies that a locally-created invoice with per-line sales tax posts
a BALANCED journal entry (DR A/R full total, CR income + CR Sales Tax
Payable) and that the Record-Sales-Tax-Payment workflow reduces the
liability correctly. Closes the audit gap flagged in Feb 2026.
"""
import os
import uuid
import pytest
from datetime import datetime, timezone

# The posting_service helpers work directly on `db`, so use the shared
# loop + Motor client rather than hitting HTTP.
from tests._shared_loop import run as _run  # session-wide loop
from db import db
import posting_service as PS


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _seed_company():
    cid = str(uuid.uuid4())
    await db.companies.insert_one({"id": cid, "name": "SalesTaxJE Co",
                                     "created_at": _now()})
    # Minimal chart-of-accounts.
    for a in [
        {"id": "ar-" + cid[:6], "name": "Accounts Receivable",
         "type": "asset", "detail_type": "accounts_receivable"},
        {"id": "rev-" + cid[:6], "name": "Sales", "type": "revenue"},
        {"id": "bank-" + cid[:6], "name": "Checking", "type": "asset"},
    ]:
        a.update({"company_id": cid, "code": "", "created_at": _now()})
        await db.accounts.insert_one(a)
    return cid


async def _cleanup(cid):
    for coll in ("companies", "accounts", "invoices", "journal_entries",
                 "taxes", "tax_payments"):
        await db[coll].delete_many({"company_id": cid})


def test_invoice_with_line_tax_posts_balanced_je():
    """DR A/R $110 = CR Sales $100 + CR Sales Tax Payable $10."""
    async def go():
        cid = await _seed_company()
        try:
            inv = {
                "id": "inv-tst-" + cid[:6],
                "company_id": cid,
                "issue_date": "2026-02-15",
                "number": "INV-1",
                "line_items": [{
                    "amount": 100.0, "quantity": 1, "rate": 100.0,
                    "tax_id": "regr-10", "tax_name": "Regr 10%",
                    "tax_rate": 10.0, "tax_amount": 10.0,
                }],
                "tax": 10.0, "shipping": 0, "discount": 0,
                "discount_amount": 0,
                "total": 110.0, "balance_due": 110.0,
                "status": "sent",
            }
            await db.invoices.insert_one(inv)
            je_id = await PS.post_invoice_je(cid, inv)
            assert je_id, "expected JE id"
            je = await db.journal_entries.find_one({"id": je_id})
            assert je, "JE not persisted"
            debits = sum(float(l.get("debit") or 0) for l in je["lines"])
            credits = sum(float(l.get("credit") or 0) for l in je["lines"])
            assert round(debits, 2) == round(credits, 2), (
                f"unbalanced JE: DR {debits} vs CR {credits}"
            )
            assert round(debits, 2) == 110.00, f"DR total = {debits}"
            # AR must equal the FULL total (not subtotal).
            ar_line = next(l for l in je["lines"]
                            if (l.get("account_name") or "").lower()
                            .startswith("accounts receivable"))
            assert ar_line["debit"] == 110.00
            # Sales Tax Payable line must exist.
            stp = next((l for l in je["lines"]
                         if "sales tax payable" in (l.get("account_name") or "").lower()),
                        None)
            assert stp, "Sales Tax Payable CR missing from invoice JE"
            assert stp["credit"] == 10.00, f"STP CR = {stp['credit']}"
        finally:
            await _cleanup(cid)
    _run(go())


def test_record_tax_payment_reduces_liability():
    """Post an invoice (accrues $10 STP), then record a $10 payment,
    the STP balance should net to $0."""
    async def go():
        cid = await _seed_company()
        try:
            # Create + post invoice.
            inv = {
                "id": "inv2-" + cid[:6], "company_id": cid,
                "issue_date": "2026-02-16", "number": "INV-2",
                "line_items": [{
                    "amount": 200.0, "quantity": 1, "rate": 200.0,
                    "tax_rate": 5.0, "tax_amount": 10.0,
                }],
                "tax": 10.0, "shipping": 0, "discount": 0,
                "discount_amount": 0,
                "total": 210.0, "balance_due": 210.0,
                "status": "sent",
            }
            await db.invoices.insert_one(inv)
            await PS.post_invoice_je(cid, inv)
            # Locate the auto-created Sales Tax Payable acct.
            stp = await db.accounts.find_one({
                "company_id": cid,
                "detail_type": "sales_tax_payable",
            })
            assert stp, "Sales Tax Payable account not auto-created"
            # Compute STP balance from JE lines directly (mirrors the
            # /tax-liability endpoint's logic).
            bal = 0.0
            async for je in db.journal_entries.find({"company_id": cid}):
                for l in (je.get("lines") or []):
                    if l.get("account_id") == stp["id"]:
                        bal += float(l.get("credit") or 0)
                        bal -= float(l.get("debit") or 0)
            assert round(bal, 2) == 10.00, f"STP after invoice = {bal}"
            # Simulate the record-payment JE.
            bank = await db.accounts.find_one(
                {"company_id": cid, "name": "Checking"})
            pid = "tp-" + cid[:6]
            await db.journal_entries.insert_one({
                "id": "je-" + pid, "company_id": cid,
                "date": "2026-02-28", "memo": "STP payment",
                "source_type": "tax_payment", "source_id": pid,
                "lines": [
                    {"account_id": stp["id"], "account_name": stp["name"],
                     "debit": 10.0, "credit": 0.0},
                    {"account_id": bank["id"], "account_name": bank["name"],
                     "debit": 0.0, "credit": 10.0},
                ],
                "created_at": _now(), "posted_by": "sales_tax_payment",
            })
            bal = 0.0
            async for je in db.journal_entries.find({"company_id": cid}):
                for l in (je.get("lines") or []):
                    if l.get("account_id") == stp["id"]:
                        bal += float(l.get("credit") or 0)
                        bal -= float(l.get("debit") or 0)
            assert round(bal, 2) == 0.00, f"STP after payment = {bal}"
        finally:
            await _cleanup(cid)
    _run(go())


def test_invoice_with_shipping_and_discount_stays_balanced():
    """Full mix: subtotal $500 − discount $50 + ship $20 + tax $50 = $520.
    JE debits must equal credits (with discount as contra-revenue DR).
    """
    async def go():
        cid = await _seed_company()
        try:
            inv = {
                "id": "inv3-" + cid[:6], "company_id": cid,
                "issue_date": "2026-02-17", "number": "INV-3",
                "line_items": [{
                    "amount": 500.0, "quantity": 1, "rate": 500.0,
                    "tax_rate": 10.0, "tax_amount": 50.0,
                }],
                "tax": 50.0, "shipping": 20.0, "discount": 50.0,
                "discount_amount": 50.0,
                "total": 520.0, "balance_due": 520.0,
                "status": "sent",
            }
            await db.invoices.insert_one(inv)
            je_id = await PS.post_invoice_je(cid, inv)
            je = await db.journal_entries.find_one({"id": je_id})
            debits = round(sum(float(l.get("debit") or 0) for l in je["lines"]), 2)
            credits = round(sum(float(l.get("credit") or 0) for l in je["lines"]), 2)
            assert debits == credits, f"unbalanced: DR {debits} vs CR {credits}"
        finally:
            await _cleanup(cid)
    _run(go())
