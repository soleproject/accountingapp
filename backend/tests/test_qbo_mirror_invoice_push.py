"""Phase 2c regression — QBO Mirror invoice push body builder.

Verifies:
  - Happy path: customer + item resolve to CustomerRef/ItemRef with
    proper Qty/UnitPrice/Amount.
  - Missing customer raises ValueError with a helpful message.
  - Missing item + no fallback Service item raises ValueError.
  - Empty line_items rejects.
  - DocNumber caps at QBO's 21-char limit.

No live QBO calls — we stub db.contacts / db.items lookups.
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
    def __init__(self, contacts, items):
        self.contacts = _Coll(contacts)
        self.items = _Coll(items)

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        contacts=[{"id": "cust-1", "company_id": "cid",
                    "qbo_id": "77", "name": "Acme",
                    "display_name": "Acme"}],
        items=[{"id": "item-1", "company_id": "cid",
                 "qbo_id": "11", "name": "Widget"}],
    )
    # Patch the `db` reference in every mirror module that uses it —
    # `from db import db` bound at import time so patching _db_mod.db
    # doesn't propagate to modules already imported.
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) \
        if False else asyncio.new_event_loop().run_until_complete(coro)


def test_happy_path(stub_db):
    from qbo_mirror.push import _invoice_body
    inv = {
        "id": "local-1", "company_id": "cid",
        "contact_id": "cust-1",
        "line_items": [{"item_id": "item-1", "description": "x",
                         "quantity": 2, "rate": 50, "amount": 100}],
        "issue_date": "2026-02-01", "due_date": "2026-03-01",
        "number": "INV-2001",
        "notes": "Thank you", "internal_notes": "note",
    }
    body = _run(_invoice_body("cid", inv))
    assert body["CustomerRef"]["value"] == "77"
    line = body["Line"][0]
    assert line["SalesItemLineDetail"]["ItemRef"]["value"] == "11"
    assert line["Amount"] == 100.0
    assert line["SalesItemLineDetail"]["Qty"] == 2
    assert line["SalesItemLineDetail"]["UnitPrice"] == 50
    assert body["TxnDate"] == "2026-02-01"
    assert body["DueDate"] == "2026-03-01"
    assert body["DocNumber"] == "INV-2001"
    assert body["CustomerMemo"]["value"] == "Thank you"
    assert body["PrivateNote"] == "note"


def test_missing_customer(stub_db):
    from qbo_mirror.push import _invoice_body
    with pytest.raises(ValueError, match="Customer"):
        _run(_invoice_body("cid", {"contact_id": None,
                                    "line_items": [{"item_id": "item-1",
                                                    "amount": 10}]}))


def test_missing_item_no_fallback(stub_db):
    from qbo_mirror.push import _invoice_body
    inv = {"contact_id": "cust-1",
           "line_items": [{"description": "x", "quantity": 1,
                            "rate": 10, "amount": 10}]}
    with pytest.raises(ValueError, match="fallback"):
        _run(_invoice_body("cid", inv))


def test_empty_line_items(stub_db):
    from qbo_mirror.push import _invoice_body
    with pytest.raises(ValueError, match="line items"):
        _run(_invoice_body("cid", {"contact_id": "cust-1",
                                    "line_items": []}))


def test_doc_number_truncation(stub_db):
    from qbo_mirror.push import _invoice_body
    inv = {"contact_id": "cust-1",
           "line_items": [{"item_id": "item-1", "amount": 5,
                            "quantity": 1, "rate": 5}],
           "number": "X" * 50}
    body = _run(_invoice_body("cid", inv))
    assert len(body["DocNumber"]) == 21
