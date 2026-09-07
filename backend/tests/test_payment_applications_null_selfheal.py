"""Regression: `applications: null` on the payment doc must NOT
hide the payment from the read-side self-heal aggregate.

Root cause history (Mar 2026): the invoice/bill list + detail
endpoints self-heal `balance_due` by summing payments where
`applications` is missing OR empty. Pydantic's default for a
`Optional[list[dict]] = None` field is *explicit null* on the
inserted doc — which failed BOTH `$exists: False` AND `$size: 0`
in the `$or` clause. Payments recorded through the standard
Payments modal on the invoice editor became invisible to the
self-heal, and `balance_due` was reset back to `total` on the
next list read even though the write path had correctly reduced
it. This test locks in the three-branch `$or` (`missing OR null
OR empty`) so any future refactor can't reintroduce the bug.
"""
import uuid
import pytest
from datetime import datetime, timezone

from tests._shared_loop import run as _run
from db import db


def _now(): return datetime.now(timezone.utc).isoformat()


async def _seed(cid: str):
    await db.companies.insert_one({"id": cid, "name": "AppsNullFix", "created_at": _now()})
    ids = {}
    for k, name, typ, det, code in [
        ("ar",   "Accounts Receivable",  "asset",     "accounts_receivable", "1200"),
        ("bank", "Business Checking",    "asset",     "cash_and_bank",       "1010"),
        ("rev",  "Consulting Revenue",   "revenue",   None,                  "4000"),
    ]:
        aid = f"{k}-{cid[:6]}"
        await db.accounts.insert_one({
            "id": aid, "company_id": cid, "name": name, "type": typ,
            "detail_type": det, "code": code, "created_at": _now(),
        })
        ids[k] = aid
    return ids


async def _cleanup(cid: str):
    for coll in ("companies", "accounts", "invoices", "payments",
                 "journal_entries", "transactions"):
        await db[coll].delete_many({"company_id": cid})


def test_payment_with_null_applications_reduces_balance_due_on_read():
    """Invoice for $220. Payment for $110 with `applications: null`
    (the default when the client doesn't send an applications array).
    Both list and detail must report balance_due=110, status=partial.
    """
    async def go():
        cid = str(uuid.uuid4())
        try:
            ids = await _seed(cid)
            # Create invoice.
            iid = f"inv-{uuid.uuid4().hex[:8]}"
            await db.invoices.insert_one({
                "id": iid, "company_id": cid, "number": "INV-NULL",
                "issue_date": "2026-03-01", "due_date": "2026-03-31",
                "total": 220.0, "balance_due": 220.0, "status": "sent",
                "line_items": [{"quantity": 1, "rate": 220.0, "amount": 220.0}],
            })
            # Insert payment with EXPLICIT null applications — this is
            # what Pydantic serializes when the client omits the field.
            pid = f"pay-{uuid.uuid4().hex[:8]}"
            await db.payments.insert_one({
                "id": pid, "company_id": cid,
                "date": "2026-03-05", "amount": 110.0,
                "linked_invoice_id": iid, "linked_bill_id": None,
                "applications": None,   # ← the bug trigger
                "method": "check", "direction": "in",
                "posted": True, "created_at": _now(),
            })
            # Reduce balance_due on the invoice (mimics create_payment's
            # write path).
            await db.invoices.update_one(
                {"id": iid}, {"$set": {"balance_due": 110.0, "status": "partial"}},
            )

            from routes.invoices import list_invoices, get_invoice
            user = {"id": "u-test", "role": "superadmin"}

            # LIST — self-heal MUST see the payment and keep balance_due=110.
            lres = await list_invoices(cid, user)
            invs = {i["id"]: i for i in lres["invoices"]}
            assert invs[iid]["balance_due"] == 110.0, (
                f"list self-heal reset balance_due back to {invs[iid]['balance_due']}"
            )
            assert invs[iid]["status"] == "partial"

            # DETAIL — same expectation.
            dres = await get_invoice(cid, iid, user)
            assert dres["invoice"]["balance_due"] == 110.0
            assert dres["invoice"]["status"] == "partial"
        finally:
            await _cleanup(cid)
    _run(go())


def test_payment_with_missing_applications_still_works():
    """Sanity: pre-existing payments without an `applications` field
    at all (older records from before the multi-app flow) still get
    summed correctly."""
    async def go():
        cid = str(uuid.uuid4())
        try:
            ids = await _seed(cid)
            iid = f"inv-{uuid.uuid4().hex[:8]}"
            await db.invoices.insert_one({
                "id": iid, "company_id": cid, "number": "INV-LEGACY",
                "issue_date": "2026-03-01", "total": 500.0,
                "balance_due": 500.0, "status": "sent",
            })
            # Legacy payment doc — no applications field at all.
            pid = f"pay-{uuid.uuid4().hex[:8]}"
            await db.payments.insert_one({
                "id": pid, "company_id": cid,
                "date": "2026-03-05", "amount": 200.0,
                "linked_invoice_id": iid, "method": "check",
                "direction": "in", "posted": True, "created_at": _now(),
            })
            await db.invoices.update_one(
                {"id": iid}, {"$set": {"balance_due": 300.0, "status": "partial"}},
            )
            from routes.invoices import list_invoices
            user = {"id": "u-test", "role": "superadmin"}
            lres = await list_invoices(cid, user)
            invs = {i["id"]: i for i in lres["invoices"]}
            assert invs[iid]["balance_due"] == 300.0
        finally:
            await _cleanup(cid)
    _run(go())
