"""Phase 3 regression — QBO Mirror Estimate & Purchase Order push
body builders.

Estimates and POs are structurally close to Invoices/Bills; these
tests verify the delta (VendorRef vs CustomerRef, ExpirationDate
vs DueDate, TxnStatus / POStatus mapping)."""
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
    def __init__(self, contacts, accounts, items, invoices=None):
        self.contacts = _Coll(contacts)
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)
        self.invoices = _Coll(invoices or [])

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
        accounts=[{"id": "exp-1", "company_id": "cid",
                    "qbo_id": "42", "name": "Office Supplies",
                    "source": "qbo", "type": "expense"}],
        items=[{"id": "item-1", "company_id": "cid",
                 "qbo_id": "11", "name": "Widget"}],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_estimate_happy(stub_db):
    from qbo_mirror.push import _estimate_body
    est = {
        "id": "e1", "contact_id": "cust-1",
        "issue_date": "2026-08-10", "expiration_date": "2026-09-10",
        "number": "EST-100", "status": "sent",
        "line_items": [{"item_id": "item-1",
                          "quantity": 2, "rate": 50, "amount": 100}],
    }
    body = _run(_estimate_body("cid", est))
    assert body["CustomerRef"]["value"] == "77"
    assert body["ExpirationDate"] == "2026-09-10"
    assert body["TxnStatus"] == "Pending"  # "sent" → "Pending"
    assert body["Line"][0]["SalesItemLineDetail"]["ItemRef"]["value"] == "11"


def test_estimate_status_mapping(stub_db):
    from qbo_mirror.push import _estimate_body
    for local, qbo in [("accepted", "Accepted"), ("rejected", "Rejected"),
                        ("closed", "Closed"), ("converted", "Closed")]:
        est = {"contact_id": "cust-1", "issue_date": "2026-01-01",
                "status": local, "line_items": [
                    {"item_id": "item-1", "amount": 10}]}
        body = _run(_estimate_body("cid", est))
        assert body["TxnStatus"] == qbo, f"{local} → {qbo}"


def test_po_happy(stub_db):
    from qbo_mirror.push import _po_body
    po = {
        "id": "p1", "contact_id": "vend-1",
        "issue_date": "2026-08-10", "due_date": "2026-09-10",
        "number": "PO-100", "status": "open",
        "line_items": [{"expense_account_id": "exp-1",
                          "description": "Paper", "amount": 42.5}],
    }
    body = _run(_po_body("cid", po))
    assert body["VendorRef"]["value"] == "88"
    assert body["POStatus"] == "Open"
    assert body["DueDate"] == "2026-09-10"
    assert body["Line"][0][
        "AccountBasedExpenseLineDetail"]["AccountRef"]["value"] == "42"


def test_po_status_mapping(stub_db):
    from qbo_mirror.push import _po_body
    for local, qbo in [("open", "Open"), ("closed", "Closed"),
                        ("converted", "Closed")]:
        po = {"contact_id": "vend-1", "issue_date": "2026-01-01",
               "status": local, "line_items": [
                   {"expense_account_id": "exp-1", "amount": 10}]}
        body = _run(_po_body("cid", po))
        assert body["POStatus"] == qbo, f"{local} → {qbo}"


def test_estimate_missing_customer(stub_db):
    from qbo_mirror.push import _estimate_body
    with pytest.raises(ValueError, match="Customer"):
        _run(_estimate_body("cid",
                             {"contact_id": None,
                              "line_items": [{"item_id": "item-1",
                                                "amount": 10}]}))


def test_po_missing_vendor(stub_db):
    from qbo_mirror.push import _po_body
    with pytest.raises(ValueError, match="Vendor"):
        _run(_po_body("cid",
                       {"contact_id": None,
                        "line_items": [{"expense_account_id": "exp-1",
                                          "amount": 10}]}))


def test_twin_patches():
    from qbo_mirror.push import (
        _local_patch_from_qbo_estimate, _local_patch_from_qbo_po,
    )
    ep = _local_patch_from_qbo_estimate(
        {"Id": "1", "TotalAmt": 500, "TxnDate": "2026-01-01",
          "ExpirationDate": "2026-02-01", "DocNumber": "EST-1"})
    assert ep["total"] == 500.0
    assert ep["expiration_date"] == "2026-02-01"
    assert ep["number"] == "EST-1"

    pp = _local_patch_from_qbo_po(
        {"Id": "2", "TotalAmt": 300, "TxnDate": "2026-01-01",
          "DueDate": "2026-02-01", "DocNumber": "PO-1"})
    assert pp["total"] == 300.0
    assert pp["due_date"] == "2026-02-01"
    assert pp["number"] == "PO-1"


def test_estimate_converted_includes_linked_invoice(monkeypatch):
    """When a converted estimate has a `converted_invoice_id` and
    the target invoice has a `qbo_id`, the pushed body must set
    TxnStatus="Closed" AND a LinkedTxn back-reference to the invoice
    — mirroring what QBO does natively for convert-to-invoice."""
    fake = _FakeDB(
        contacts=[{"id": "cust-1", "company_id": "cid", "qbo_id": "77",
                    "name": "Acme", "display_name": "Acme"}],
        accounts=[],
        items=[{"id": "item-1", "company_id": "cid",
                 "qbo_id": "11", "name": "Widget"}],
        invoices=[{"id": "inv-abc", "company_id": "cid", "qbo_id": "555"}],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    from qbo_mirror.push import _estimate_body
    est = {
        "id": "e1", "contact_id": "cust-1",
        "issue_date": "2026-08-10", "status": "converted",
        "converted_invoice_id": "inv-abc",
        "line_items": [{"item_id": "item-1", "amount": 100}],
    }
    body = _run(_estimate_body("cid", est))
    assert body["TxnStatus"] == "Closed"
    assert body["LinkedTxn"] == [{"TxnType": "Invoice", "TxnId": "555"}]


def test_po_converted_includes_linked_bill(monkeypatch):
    """Same LinkedTxn behaviour for PO→Bill conversion — the pushed
    PO body must include POStatus="Closed" and LinkedTxn pointing at
    the resulting bill."""
    class _FDB(_FakeDB):
        def __init__(self, contacts, accounts, items, invoices=None, bills=None):
            super().__init__(contacts=contacts, accounts=accounts,
                             items=items, invoices=invoices)
            self.bills = _Coll(bills or [])
    fake = _FDB(
        contacts=[{"id": "vend-1", "company_id": "cid", "qbo_id": "88",
                    "name": "SupplyCo", "display_name": "SupplyCo"}],
        accounts=[{"id": "exp-1", "company_id": "cid",
                    "qbo_id": "42", "name": "Office Supplies",
                    "source": "qbo", "type": "expense"}],
        items=[],
        bills=[{"id": "bill-abc", "company_id": "cid", "qbo_id": "999"}],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    from qbo_mirror.push import _po_body
    po = {
        "id": "p1", "contact_id": "vend-1",
        "issue_date": "2026-08-10", "status": "converted",
        "converted_bill_id": "bill-abc",
        "line_items": [{"expense_account_id": "exp-1", "amount": 10}],
    }
    body = _run(_po_body("cid", po))
    assert body["POStatus"] == "Closed"
    assert body["LinkedTxn"] == [{"TxnType": "Bill", "TxnId": "999"}]


def test_estimate_converted_without_invoice_qbo_id_omits_linked(monkeypatch):
    """If the invoice hasn't been synced yet, LinkedTxn should NOT
    be emitted (QBO would reject an unknown TxnId). Status alone still
    flips to Closed so the estimate leaves 'Pending'."""
    fake = _FakeDB(
        contacts=[{"id": "cust-1", "company_id": "cid", "qbo_id": "77",
                    "name": "Acme", "display_name": "Acme"}],
        accounts=[],
        items=[{"id": "item-1", "company_id": "cid",
                 "qbo_id": "11", "name": "Widget"}],
        invoices=[{"id": "inv-abc", "company_id": "cid"}],  # no qbo_id
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    from qbo_mirror.push import _estimate_body
    est = {
        "id": "e1", "contact_id": "cust-1",
        "issue_date": "2026-08-10", "status": "converted",
        "converted_invoice_id": "inv-abc",
        "line_items": [{"item_id": "item-1", "amount": 100}],
    }
    body = _run(_estimate_body("cid", est))
    assert body["TxnStatus"] == "Closed"
    assert "LinkedTxn" not in body


def test_drift_normalizer_maps_converted_to_closed():
    """Local `status='converted'` on an estimate must not surface as
    field drift after we push Closed to QBO. The engine's
    normalizer should treat both as equivalent."""
    from qbo_mirror.engine import (
        _norm_estimate_local, _norm_estimate_qbo,
        _norm_po_local, _norm_po_qbo,
        _norm_bill_local, _norm_bill_qbo,
        _norm_invoice_local, _norm_invoice_qbo,
    )
    local = _norm_estimate_local({
        "number": "EST-100", "issue_date": "2026-08-10",
        "total": 100.0, "status": "converted", "qbo_id": "999",
    })
    qbo = _norm_estimate_qbo({
        "Id": "999", "DocNumber": "EST-100", "TxnDate": "2026-08-10",
        "TotalAmt": 100.0, "TxnStatus": "Closed",
    })
    assert local["status"] == qbo["status"] == "closed"

    # PO converted → closed equivalence
    po_local = _norm_po_local({
        "number": "PO-100", "issue_date": "2026-08-10",
        "total": 50.0, "status": "converted", "qbo_id": "12",
    })
    po_qbo = _norm_po_qbo({
        "Id": "12", "DocNumber": "PO-100", "TxnDate": "2026-08-10",
        "TotalAmt": 50.0, "POStatus": "Closed",
    })
    assert po_local["status"] == po_qbo["status"] == "closed"

    # Bills / invoices with empty local number but qbo_id must
    # synthesize the same fake number as the QBO side.
    b_local = _norm_bill_local({
        "number": "", "qbo_id": "173", "issue_date": "2026-08-10",
        "total": 5650, "balance_due": 5650,
    })
    b_qbo = _norm_bill_qbo({
        "Id": "173", "DocNumber": "", "TxnDate": "2026-08-10",
        "TotalAmt": 5650, "Balance": 5650,
    })
    assert b_local["number"] == b_qbo["number"] == "BILL-173"
    assert b_local["natural_key"] == b_qbo["natural_key"]

    i_local = _norm_invoice_local({
        "number": "", "qbo_id": "42", "issue_date": "2026-01-01",
        "total": 100, "balance_due": 100,
    })
    i_qbo = _norm_invoice_qbo({
        "Id": "42", "DocNumber": "", "TxnDate": "2026-01-01",
        "TotalAmt": 100, "Balance": 100,
    })
    assert i_local["number"] == i_qbo["number"] == "INV-42"
    assert i_local["natural_key"] == i_qbo["natural_key"]

