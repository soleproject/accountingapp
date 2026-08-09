"""Phase 2d regression — QBO Mirror bill push body builder.

Verifies:
  - Happy path: vendor + expense account resolve to VendorRef +
    AccountBasedExpenseLineDetail.AccountRef.
  - Missing vendor raises ValueError.
  - Missing expense account + no fallback raises ValueError.
  - Empty line_items rejects.
  - DocNumber caps at QBO's 21-char limit.

No live QBO calls — we stub db.contacts / db.accounts lookups.
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
    def __init__(self, contacts, accounts):
        self.contacts = _Coll(contacts)
        self.accounts = _Coll(accounts)
        self.items = _Coll([])

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        contacts=[{"id": "vend-1", "company_id": "cid",
                    "qbo_id": "88", "name": "SupplyCo",
                    "display_name": "SupplyCo"}],
        accounts=[{"id": "acct-1", "company_id": "cid",
                    "qbo_id": "42", "name": "Office Supplies"}],
    )
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_happy_path(stub_db):
    from qbo_mirror.push import _bill_body
    bill = {
        "id": "local-b1", "company_id": "cid",
        "contact_id": "vend-1",
        "line_items": [{"expense_account_id": "acct-1",
                         "description": "Paper", "amount": 42.5}],
        "issue_date": "2026-02-01", "due_date": "2026-03-01",
        "number": "BILL-5001",
        "internal_notes": "urgent",
    }
    body = _run(_bill_body("cid", bill))
    assert body["VendorRef"]["value"] == "88"
    line = body["Line"][0]
    assert line["DetailType"] == "AccountBasedExpenseLineDetail"
    assert line["AccountBasedExpenseLineDetail"]["AccountRef"]["value"] == "42"
    assert line["Amount"] == 42.5
    assert body["TxnDate"] == "2026-02-01"
    assert body["DueDate"] == "2026-03-01"
    assert body["DocNumber"] == "BILL-5001"
    assert body["PrivateNote"] == "urgent"


def test_missing_vendor(stub_db):
    from qbo_mirror.push import _bill_body
    with pytest.raises(ValueError, match="Vendor"):
        _run(_bill_body("cid",
                        {"contact_id": None,
                         "line_items": [{"expense_account_id": "acct-1",
                                           "amount": 5}]}))


def test_missing_expense_account_no_fallback(stub_db):
    from qbo_mirror.push import _bill_body
    bill = {"contact_id": "vend-1",
            "line_items": [{"description": "x", "amount": 10}]}
    with pytest.raises(ValueError, match="fallback"):
        _run(_bill_body("cid", bill))


def test_empty_line_items(stub_db):
    from qbo_mirror.push import _bill_body
    with pytest.raises(ValueError, match="line items"):
        _run(_bill_body("cid", {"contact_id": "vend-1",
                                 "line_items": []}))


def test_doc_number_truncation(stub_db):
    from qbo_mirror.push import _bill_body
    bill = {"contact_id": "vend-1",
            "line_items": [{"expense_account_id": "acct-1",
                              "amount": 5}],
            "number": "Y" * 50}
    body = _run(_bill_body("cid", bill))
    assert len(body["DocNumber"]) == 21


def test_twin_patch_shape():
    from qbo_mirror.push import _local_patch_from_qbo_bill
    twin = {"Id": "99", "TotalAmt": 250, "Balance": 100,
             "TxnDate": "2026-02-01", "DueDate": "2026-03-01",
             "DocNumber": "BILL-9"}
    p = _local_patch_from_qbo_bill(twin)
    assert p["total"] == 250.0
    assert p["balance"] == 100.0
    assert p["balance_due"] == 100.0
    assert p["status"] == "open"
    assert p["number"] == "BILL-9"
    # Paid case
    twin2 = {**twin, "Balance": 0}
    assert _local_patch_from_qbo_bill(twin2)["status"] == "paid"
