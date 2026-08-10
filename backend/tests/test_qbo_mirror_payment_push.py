"""Phase 2e regression — QBO Mirror payment push body builders.

Verifies both directions:
  - Customer Payment (in): CustomerRef + LinkedTxn[Invoice] +
    DepositToAccountRef.
  - Bill Payment (out): VendorRef + LinkedTxn[Bill] + PayType=Check
    + CheckPayment.BankAccountRef.
  - Missing customer/vendor rejects.
  - Missing linked invoice/bill rejects.
  - Un-synced linked doc rejects.
  - BillPayment without bank account rejects (QBO requires it).
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")

import db as _db_mod  # noqa: E402


class _Coll:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    async def find_one(self, q: dict, proj=None, sort=None):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items()
                   if not isinstance(v, dict)):
                return r
        return None


class _FakeDB:
    def __init__(self, contacts, accounts, invoices, bills):
        self.contacts = _Coll(contacts)
        self.accounts = _Coll(accounts)
        self.invoices = _Coll(invoices)
        self.bills = _Coll(bills)
        self.items = _Coll([])

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        contacts=[
            {"id": "cust-1", "company_id": "cid", "qbo_id": "77",
              "name": "Acme", "display_name": "Acme"},
            {"id": "vend-1", "company_id": "cid", "qbo_id": "88",
              "name": "SupplyCo", "display_name": "SupplyCo"},
        ],
        accounts=[{"id": "bank-1", "company_id": "cid",
                    "qbo_id": "35", "name": "Checking",
                    "source": "qbo", "type": "bank"}],
        invoices=[{"id": "inv-1", "company_id": "cid",
                    "qbo_id": "1040"}],
        bills=[{"id": "bill-1", "company_id": "cid",
                 "qbo_id": "2020"}],
    )
    monkeypatch.setattr(_db_mod, "db", fake)
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_payment_in_happy(stub_db):
    from qbo_mirror.push import _payment_body_in
    p = {"id": "p1", "contact_id": "cust-1", "amount": 500,
         "date": "2026-02-01", "linked_invoice_id": "inv-1",
         "bank_account_id": "bank-1", "memo": "check #1234"}
    body = _run(_payment_body_in("cid", p))
    assert body["CustomerRef"]["value"] == "77"
    assert body["TotalAmt"] == 500.0
    assert body["Line"][0]["LinkedTxn"][0] == {
        "TxnType": "Invoice", "TxnId": "1040"}
    assert body["DepositToAccountRef"]["value"] == "35"
    assert body["TxnDate"] == "2026-02-01"
    assert body["PrivateNote"] == "check #1234"


def test_payment_in_no_customer(stub_db):
    from qbo_mirror.push import _payment_body_in
    with pytest.raises(ValueError, match="Customer"):
        _run(_payment_body_in("cid",
                              {"contact_id": None, "amount": 10,
                               "linked_invoice_id": "inv-1"}))


def test_payment_in_no_invoice(stub_db):
    from qbo_mirror.push import _payment_body_in
    with pytest.raises(ValueError, match="linked invoice"):
        _run(_payment_body_in("cid",
                              {"contact_id": "cust-1", "amount": 10}))


def test_payment_in_unsynced_invoice(stub_db):
    from qbo_mirror.push import _payment_body_in
    # Point at a non-existent invoice id.
    with pytest.raises(ValueError, match="not synced"):
        _run(_payment_body_in("cid",
                              {"contact_id": "cust-1", "amount": 10,
                               "linked_invoice_id": "inv-doesnt-exist"}))


def test_payment_out_happy(stub_db):
    from qbo_mirror.push import _payment_body_out
    p = {"id": "p2", "contact_id": "vend-1", "amount": 300,
         "date": "2026-02-01", "linked_bill_id": "bill-1",
         "bank_account_id": "bank-1", "memo": "ck 900"}
    body = _run(_payment_body_out("cid", p))
    assert body["VendorRef"]["value"] == "88"
    assert body["PayType"] == "Check"
    assert body["TotalAmt"] == 300.0
    assert body["Line"][0]["LinkedTxn"][0] == {
        "TxnType": "Bill", "TxnId": "2020"}
    assert body["CheckPayment"]["BankAccountRef"]["value"] == "35"
    assert body["TxnDate"] == "2026-02-01"


def test_payment_out_falls_back_to_default_bank(stub_db):
    """When the payment doesn't specify a bank_account_id, we fall
    back to a QBO-side bank account (the fixture has "Checking")
    rather than blocking the push."""
    from qbo_mirror.push import _payment_body_out
    body = _run(_payment_body_out(
        "cid",
        {"contact_id": "vend-1", "amount": 10,
         "linked_bill_id": "bill-1"}))
    # Falls back to the Checking account (qbo_id=35 in fixture).
    assert body["CheckPayment"]["BankAccountRef"]["value"] == "35"


def test_payment_out_no_bank_at_all(monkeypatch, stub_db):
    """If there's truly no QBO bank account, we still fail loudly."""
    from qbo_mirror.push import _payment_body_out
    # Wipe accounts so the fallback finds nothing.
    stub_db.accounts.rows = []
    with pytest.raises(ValueError, match="no default"):
        _run(_payment_body_out(
            "cid",
            {"contact_id": "vend-1", "amount": 10,
             "linked_bill_id": "bill-1"}))


def test_payment_out_no_bill(stub_db):
    from qbo_mirror.push import _payment_body_out
    with pytest.raises(ValueError, match="linked bill"):
        _run(_payment_body_out("cid",
                                {"contact_id": "vend-1", "amount": 10,
                                 "bank_account_id": "bank-1"}))


def test_twin_patch_shape():
    from qbo_mirror.push import _local_patch_from_qbo_payment
    p = _local_patch_from_qbo_payment(
        {"Id": "1", "TotalAmt": 250, "TxnDate": "2026-02-01"})
    assert p["amount"] == 250.0
    assert p["date"] == "2026-02-01"
