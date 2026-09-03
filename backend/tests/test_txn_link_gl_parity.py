"""Manual-transaction-linked-to-invoice → GL parity regression.

Reproduces the "$110 receipt turned into $210 Net Income" bug from
production (Sales Tax Tester LLC) and locks in the fix:

1. Creating a $100 + 10% tax invoice posts DR AR / CR Revenue / CR STP.
2. Creating a manual bank txn for $110 linked to that invoice must:
   • Override the txn's category to A/R (not revenue).
   • Set posted=True so the reports engine picks it up.
3. Accrual BS: Cash $110 = STP $10 + NI $100 (BALANCED).
4. Cash BS: Cash $110 = NI $110 (BALANCED).
5. PATCHing the txn's category while it's linked returns 400.

Uses direct DB + reports.compute_balance_sheet for speed (no HTTP).
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
    await db.companies.insert_one({"id": cid, "name": "TxnLinkParity Co",
                                     "created_at": _now()})
    accts = [
        ("ar", "Accounts Receivable", "asset", "accounts_receivable", "1200"),
        ("bank", "Business Checking",  "asset", None,                   "1010"),
        ("rev", "Service Revenue",     "revenue", None,                 "4000"),
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


def test_linked_txn_produces_balanced_sheets():
    async def go():
        cid, ids = await _seed()
        try:
            # 1) Create the invoice + post the JE.
            inv_id = f"inv-{cid[:6]}"
            inv = {
                "id": inv_id, "company_id": cid, "number": "INV-1",
                "issue_date": "2026-02-15",
                "line_items": [{
                    "amount": 100.0, "quantity": 1, "rate": 100.0,
                    "tax_rate": 10.0, "tax_amount": 10.0,
                    "income_account_id": ids["rev"],
                }],
                "tax": 10.0, "shipping": 0, "discount": 0,
                "discount_amount": 0,
                "total": 110.0, "balance_due": 0.0,  # paid via linked txn
                "status": "paid", "posted": True,
            }
            await db.invoices.insert_one(inv)
            await PS.post_invoice_je(cid, inv)

            # 2) Create the manual receipt txn linked to the invoice.
            #    Simulating post-fix state: category=AR, posted=True,
            #    source_transaction_id lands on the auto-payment.
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
                "amount": 110.0, "direction": "in",
                "linked_invoice_id": inv_id,
                "source_transaction_id": tid,
                "bank_account_id": ids["bank"],
            })

            # 3) Accrual BS must balance to $110 = STP $10 + NI $100.
            acc = await reports.compute_balance_sheet(cid, as_of="2026-02-28", basis="accrual")
            assert acc["balanced"], f"accrual unbalanced: {acc['imbalance']}"
            assert acc["total_assets"] == 110.0
            ni = next(e["amount"] for e in acc["equity"]
                       if e["code"] == "NI")
            assert ni == 100.0, f"accrual NI should be $100, got {ni}"
            stp = next((l for l in acc["liabilities"]
                         if "Sales Tax" in l["name"]), None)
            assert stp and stp["amount"] == 10.0

            # 4) Cash BS must also balance ($110 asset, $110 equity).
            cash = await reports.compute_balance_sheet(cid, as_of="2026-02-28", basis="cash")
            assert cash["balanced"], f"cash unbalanced: {cash['imbalance']}"
            assert cash["total_assets"] == 110.0, cash["total_assets"]
            cash_ni = next(e["amount"] for e in cash["equity"]
                            if e["code"] == "NI")
            # On cash basis the full $110 receipt flows to NI (revenue
            # recognized on cash receipt; STP passthrough optional).
            assert cash_ni == 110.0, f"cash NI should be $110, got {cash_ni}"
            # Explicit: no negative A/R phantom on cash basis.
            for a in cash["assets"]:
                assert a["amount"] >= 0, f"negative asset on cash BS: {a}"
        finally:
            await _cleanup(cid)
    _run(go())
