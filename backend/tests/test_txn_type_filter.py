"""Regression — GET /transactions?txn_type=… filter.

Verifies that the new `txn_type` query param on the transactions
list endpoint correctly narrows the Mongo query. This filter powers
both the dedicated `/sales-receipts` and `/credit-memos` list pages
plus the entity-type chip strip on the main `/transactions` page.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _Cursor:
    def __init__(self, rows):
        self.rows = rows
    def sort(self, *a, **kw): return self
    def skip(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    async def to_list(self, n=None, length=None):
        return list(self.rows)


class _TxnColl:
    def __init__(self):
        self.last_query = None
    def find(self, q, proj=None):
        self.last_query = q
        return _Cursor([])
    async def count_documents(self, q):
        return 0


class _AcctColl:
    def find(self, q, proj=None):
        return _Cursor([])


class _FakeDB:
    transactions = _TxnColl()
    accounts = _AcctColl()
    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub(monkeypatch):
    fake = _FakeDB()
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    from routes import transactions as _tx
    monkeypatch.setattr(_tx, "db", fake)
    async def _ok(*a, **kw): return None
    monkeypatch.setattr(_tx, "require_company", _ok)
    return fake, _tx


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_txn_type_filter_narrows_query(stub):
    fake, tx = stub
    _run(tx.list_transactions(
        cid="cid", user={"email": "x"}, txn_type="SalesReceipt"))
    assert fake.transactions.last_query.get("txn_type") == "SalesReceipt"


def test_txn_type_filter_absent_when_not_passed(stub):
    fake, tx = stub
    _run(tx.list_transactions(cid="cid", user={"email": "x"}))
    assert "txn_type" not in fake.transactions.last_query


@pytest.mark.parametrize("t", [
    "Purchase", "SalesReceipt", "Deposit",
    "CreditMemo", "RefundReceipt", "Transfer",
])
def test_txn_type_filter_all_editor_entities(stub, t):
    fake, tx = stub
    _run(tx.list_transactions(cid="cid", user={"email": "x"}, txn_type=t))
    assert fake.transactions.last_query["txn_type"] == t
