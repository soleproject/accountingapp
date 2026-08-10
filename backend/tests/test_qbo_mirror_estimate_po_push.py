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
    def __init__(self, contacts, accounts, items):
        self.contacts = _Coll(contacts)
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)

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
