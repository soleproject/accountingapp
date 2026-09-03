"""Cash-basis GAAP parity — sales-tax passthrough + local invoice revenue.

Locks in two March 2026 fixes:

1. On cash basis, Sales Tax collected must recognize as a LIABILITY
   (not revenue) from the moment the linked payment lands — matches
   QBO / GAAP ASC 606. Previously the entire receipt inflated NI and
   STP silently sat at $0 on the cash BS.

2. Native (non-QBO) invoice line items that don't stamp an explicit
   `income_account_id` — either because the line was created without
   picking an account, or because the linked item has no default —
   must still recognize revenue on cash basis. Previously the
   allocator only matched on `account_qbo_id`, so native companies
   read $0 revenue on cash IS even after fully paying the invoice.
"""
import asyncio
import uuid
import pytest
from datetime import datetime, timezone

from tests._shared_loop import run as _run
from db import db
import reports
import posting_service as PS


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _seed():
    cid = str(uuid.uuid4())
    await db.companies.insert_one({"id": cid, "name": "CashParity Co",
                                     "created_at": _now()})
    accts = [
        ("ar",   "Accounts Receivable", "asset",    "accounts_receivable", "1200"),
        ("bank", "Business Checking",   "asset",    None,                    "1010"),
        ("rev",  "Service Revenue",     "revenue",  None,                    "4000"),
    ]
    ids = {}
    for k, name, typ, det, code in accts:
        aid = f"{k}-{cid[:6]}"
        await db.accounts.insert_one({
            "id": aid, "company_id": cid, "name": name,
            "type": typ, "detail_type": det, "code": code,
            "created_at": _now(),
        })
        ids[k] = aid
    return cid, ids


async def _cleanup(cid):
    for coll in ("companies", "accounts", "invoices", "journal_entries",
                 "taxes", "tax_payments", "transactions", "payments"):
        await db[coll].delete_many({"company_id": cid})


def test_cash_bs_and_is_gaap_parity_on_linked_receipt():
    """Full loop: $100 line + 10% tax invoice, linked $110 receipt.

    * BS accrual: Cash $110 = STP $10 + NI $100.
    * BS cash:    Cash $110 = STP $10 + NI $100 (STP recognized on receipt).
    * IS accrual: Revenue $100.
    * IS cash:    Revenue $100 (line has no income_account_id — must
                  fall back to primary revenue account).
    """
    async def go():
        cid, ids = await _seed()
        try:
            inv_id = f"inv-{cid[:6]}"
            inv = {
                "id": inv_id, "company_id": cid, "number": "INV-1",
                "issue_date": "2026-02-15",
                "line_items": [{
                    "description": "Local line, no explicit income acct",
                    "amount": 100.0, "quantity": 1, "rate": 100.0,
                    "tax_rate": 10.0, "tax_amount": 10.0,
                    "income_account_id": None,  # intentional — trigger fallback
                }],
                "tax": 10.0, "shipping": 0, "discount": 0,
                "discount_amount": 0,
                "total": 110.0, "balance_due": 0.0,
                "status": "paid", "posted": True,
            }
            await db.invoices.insert_one(inv)
            await PS.post_invoice_je(cid, inv)

            tid = f"txn-{cid[:6]}"
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "date": "2026-02-16", "amount": 110.0, "direction": "in",
                "bank_account_id": ids["bank"], "bank_account_name": "Business Checking",
                "category_account_id": ids["ar"],
                "category_account_code": "1200",
                "category_account_name": "Accounts Receivable",
                "linked_invoice_id": inv_id,
                "posted": True, "source": "manual",
                "txn_type": "SalesReceipt",
            })
            pid = f"pay-{cid[:6]}"
            await db.payments.insert_one({
                "id": pid, "company_id": cid, "date": "2026-02-16",
                "amount": 110.0, "direction": "in",  # explicit direction
                "linked_invoice_id": inv_id,
                "source_transaction_id": tid,
                "bank_account_id": ids["bank"],
            })

            # BS — both bases balanced, STP shows on both.
            for basis in ("accrual", "cash"):
                r = await reports.compute_balance_sheet(cid, as_of="2026-02-28", basis=basis)
                assert r["balanced"], f"{basis} BS unbalanced: {r['imbalance']}"
                assert r["total_assets"] == 110.0
                stp = next((l for l in r["liabilities"]
                             if "Sales Tax" in l["name"]), None)
                assert stp and stp["amount"] == 10.0, (
                    f"{basis} STP missing on BS — GAAP requires "
                    f"tax collected to sit as liability regardless of "
                    f"basis. Got: {r['liabilities']}"
                )
                ni = next(e["amount"] for e in r["equity"] if e["code"] == "NI")
                assert ni == 100.0, f"{basis} NI = {ni} (expected 100)"

            # IS — both bases recognize $100 revenue.
            for basis in ("accrual", "cash"):
                r = await reports.compute_income_statement(
                    cid, start="2026-02-01", end="2026-02-28", basis=basis)
                assert r["total_revenue"] == 100.0, (
                    f"{basis} IS revenue = {r['total_revenue']} "
                    f"(expected 100). This means the payment allocator "
                    f"failed to attach the receipt to the invoice's "
                    f"revenue account."
                )
        finally:
            await _cleanup(cid)
    _run(go())
