"""Multi-bill Pay parity test (Mar 2026).

Mirrors the invoice multi-app flow for A/P vendor bills:

* Two open bills for the same vendor (or different vendors — irrelevant
  to the mechanic).
* One withdrawal txn covering the sum of both bills.
* POST /transactions/{tid}/receive-payment with a two-app payload.
* Assertions:
  1. Payment doc: direction='out', linked_bill_id=primary, applications=[…].
  2. Both bills flip to `paid` (balance_due=0).
  3. Txn: category_account_id → A/P, linked_payment_id set, primary linked_bill_id.
  4. Payment cap enforced (sum ≠ txn amount → 400).
  5. Mixed invoice+bill applications → 400.
"""
import uuid
import pytest
from datetime import datetime, timezone

from tests._shared_loop import run as _run
from db import db


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _seed():
    cid = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": cid, "name": "MultiBillPay Co", "created_at": _now(),
    })
    accts = [
        ("ap",    "Accounts Payable",  "liability", "accounts_payable", "2000"),
        ("ar",    "Accounts Receivable", "asset",   "accounts_receivable", "1200"),
        ("bank",  "Business Checking", "asset",     None,               "1010"),
        ("cogs",  "Cost of Goods Sold","expense",   None,               "5000"),
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
    for coll in ("companies", "accounts", "invoices", "bills",
                 "transactions", "payments", "journal_entries"):
        await db[coll].delete_many({"company_id": cid})


async def _seed_bill(cid: str, ap_id: str, number: str, amount: float, vendor_name: str = "Acme Supplies"):
    bid = f"bill-{uuid.uuid4().hex[:8]}"
    vendor_id = f"vend-{cid[:6]}"
    await db.bills.insert_one({
        "id": bid, "company_id": cid, "number": number,
        "issue_date": "2026-02-10",
        "vendor_id": vendor_id, "vendor_name": vendor_name,
        "contact_id": vendor_id, "contact_name": vendor_name,
        "line_items": [{"amount": amount, "quantity": 1, "rate": amount,
                         "expense_account_id": None}],
        "total": amount, "balance_due": amount,
        "status": "open", "posted": True,
    })
    return bid


async def _seed_txn(cid: str, bank_id: str, amount: float):
    tid = f"txn-{uuid.uuid4().hex[:8]}"
    await db.transactions.insert_one({
        "id": tid, "company_id": cid,
        "date": "2026-02-15",
        "amount": -abs(amount),  # withdrawal
        "direction": "out",
        "bank_account_id": bank_id,
        "bank_account_name": "Business Checking",
        "posted": False,
    })
    return tid


def test_multi_bill_pay_settles_both_bills():
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-1", 300.00)
            b2 = await _seed_bill(cid, ids["ap"], "BILL-2", 700.00)
            tid = await _seed_txn(cid, ids["bank"], 1000.00)

            # Call the endpoint directly through the router function.
            from routes.transactions import receive_payment_multi
            payload = {"applications": [
                {"bill_id": b1, "amount": 300.0},
                {"bill_id": b2, "amount": 700.0},
            ]}
            # Superadmin bypasses membership check.
            user = {"id": "u-test", "role": "superadmin"}
            res = await receive_payment_multi(cid, tid, payload, user)
            assert res["ok"] is True
            pay = res["payment"]
            assert pay["direction"] == "out"
            assert pay["amount"] == 1000.0
            assert pay["linked_bill_id"] in (b1, b2)
            assert pay["linked_invoice_id"] is None
            apps = pay["applications"]
            assert len(apps) == 2
            # Primary = largest (b2 = $700).
            assert pay["linked_bill_id"] == b2
            assert {a["bill_id"] for a in apps} == {b1, b2}

            # Bills flipped to paid.
            bill1 = await db.bills.find_one({"id": b1})
            bill2 = await db.bills.find_one({"id": b2})
            assert bill1["status"] == "paid"
            assert bill1["balance_due"] == 0.0
            assert bill2["status"] == "paid"
            assert bill2["balance_due"] == 0.0

            # Txn stamped: A/P category, primary linked_bill_id, posted.
            txn = await db.transactions.find_one({"id": tid})
            assert txn["category_account_id"] == ids["ap"]
            assert txn["linked_bill_id"] == b2
            assert txn["linked_payment_id"] == pay["id"]
            assert txn["direction"] == "out"
            assert txn["posted"] is True
        finally:
            await _cleanup(cid)
    _run(go())


def test_multi_bill_pay_partial_application():
    """Applying $500 to a $700 bill leaves it in `partial` with balance $200."""
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-P", 700.00)
            tid = await _seed_txn(cid, ids["bank"], 500.00)

            from routes.transactions import receive_payment_multi
            user = {"id": "u-test", "role": "superadmin"}
            res = await receive_payment_multi(
                cid, tid, {"applications": [{"bill_id": b1, "amount": 500.0}]}, user,
            )
            assert res["ok"] is True

            bill = await db.bills.find_one({"id": b1})
            assert bill["status"] == "partial"
            assert bill["balance_due"] == 200.0
        finally:
            await _cleanup(cid)
    _run(go())


def test_multi_bill_pay_rejects_cap_violation():
    """Sum of applications > txn amount → 400 (payment cap)."""
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-CAP", 500.00)
            tid = await _seed_txn(cid, ids["bank"], 300.00)  # only $300 in the bank

            from routes.transactions import receive_payment_multi
            from fastapi import HTTPException
            user = {"id": "u-test", "role": "superadmin"}
            with pytest.raises(HTTPException) as excinfo:
                await receive_payment_multi(
                    cid, tid, {"applications": [{"bill_id": b1, "amount": 500.0}]}, user,
                )
            assert excinfo.value.status_code == 400
            assert "must equal" in str(excinfo.value.detail).lower()

            # Bill untouched.
            bill = await db.bills.find_one({"id": b1})
            assert bill["balance_due"] == 500.0
            assert bill["status"] == "open"
        finally:
            await _cleanup(cid)
    _run(go())


def test_multi_bill_pay_rejects_mixed_apps():
    """Mixing invoice_id + bill_id in the same payload → 400."""
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-MIX", 200.00)
            # Seed a matching invoice too.
            inv_id = f"inv-{cid[:6]}"
            await db.invoices.insert_one({
                "id": inv_id, "company_id": cid, "number": "INV-MIX",
                "issue_date": "2026-02-10", "total": 100.0,
                "balance_due": 100.0, "status": "sent",
            })
            tid = await _seed_txn(cid, ids["bank"], 300.00)

            from routes.transactions import receive_payment_multi
            from fastapi import HTTPException
            user = {"id": "u-test", "role": "superadmin"}
            with pytest.raises(HTTPException) as excinfo:
                await receive_payment_multi(cid, tid, {"applications": [
                    {"invoice_id": inv_id, "amount": 100.0},
                    {"bill_id": b1, "amount": 200.0},
                ]}, user)
            assert excinfo.value.status_code == 400
        finally:
            await _cleanup(cid)
    _run(go())


def test_multi_bill_pay_persists_balance_on_read():
    """Regression: secondary bills in a multi-bill payment must NOT
    have their balance_due healed back to `total` on the next GET.
    Reproduces the read-side self-heal bug where bills.py ignored the
    payment's `applications` array and only summed by linked_bill_id.
    """
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-R1", 100.00)
            b2 = await _seed_bill(cid, ids["ap"], "BILL-R2", 200.00)
            tid = await _seed_txn(cid, ids["bank"], 300.00)

            from routes.transactions import receive_payment_multi
            from routes.bills import get_bill, list_bills
            user = {"id": "u-test", "role": "superadmin"}

            res = await receive_payment_multi(cid, tid, {"applications": [
                {"bill_id": b1, "amount": 100.0},
                {"bill_id": b2, "amount": 200.0},
            ]}, user)
            assert res["ok"] is True

            # GET each bill individually — self-heal must NOT reset
            # the secondary bill's balance_due.
            r1 = await get_bill(cid, b1, user)
            r2 = await get_bill(cid, b2, user)
            assert r1["bill"]["balance_due"] == 0.0, f"B1 balance drifted: {r1}"
            assert r1["bill"]["status"] == "paid"
            assert r2["bill"]["balance_due"] == 0.0, f"B2 balance drifted: {r2}"
            assert r2["bill"]["status"] == "paid"

            # List — same expectation.
            all_bills = await list_bills(cid, user)
            for b in all_bills["bills"]:
                if b["id"] in (b1, b2):
                    assert b["balance_due"] == 0.0
                    assert b["status"] == "paid"
        finally:
            await _cleanup(cid)
    _run(go())


def test_multi_bill_pay_partial_persists_on_read():
    """Partial application on a multi-bill payment: after GET, the
    remaining balance must survive the self-heal (not reset to total).
    """
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-PR1", 100.00)
            b2 = await _seed_bill(cid, ids["ap"], "BILL-PR2", 500.00)
            # Pay $100 to b1 (full) and $200 to b2 (partial) → txn total $300.
            tid = await _seed_txn(cid, ids["bank"], 300.00)

            from routes.transactions import receive_payment_multi
            from routes.bills import get_bill
            user = {"id": "u-test", "role": "superadmin"}

            await receive_payment_multi(cid, tid, {"applications": [
                {"bill_id": b1, "amount": 100.0},
                {"bill_id": b2, "amount": 200.0},
            ]}, user)

            r1 = await get_bill(cid, b1, user)
            r2 = await get_bill(cid, b2, user)
            assert r1["bill"]["balance_due"] == 0.0
            assert r1["bill"]["status"] == "paid"
            # b2 is the primary (largest app) — but the read-side must
            # still find the $200 in applications. Balance = 500 - 200 = 300.
            assert r2["bill"]["balance_due"] == 300.0, r2
            assert r2["bill"]["status"] == "partial"
        finally:
            await _cleanup(cid)
    _run(go())


def test_multi_bill_pay_wrong_direction_rejected():
    """A deposit txn cannot pay bills — must be a withdrawal."""
    async def go():
        cid, ids = await _seed()
        try:
            b1 = await _seed_bill(cid, ids["ap"], "BILL-DIR", 100.00)
            # Deposit txn (positive amount).
            tid = f"txn-{uuid.uuid4().hex[:8]}"
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "date": "2026-02-15", "amount": 100.00,  # positive = deposit
                "direction": "in", "bank_account_id": ids["bank"],
                "posted": False,
            })

            from routes.transactions import receive_payment_multi
            from fastapi import HTTPException
            user = {"id": "u-test", "role": "superadmin"}
            with pytest.raises(HTTPException) as excinfo:
                await receive_payment_multi(
                    cid, tid, {"applications": [{"bill_id": b1, "amount": 100.0}]}, user,
                )
            assert excinfo.value.status_code == 400
            assert "withdrawal" in str(excinfo.value.detail).lower()
        finally:
            await _cleanup(cid)
    _run(go())
