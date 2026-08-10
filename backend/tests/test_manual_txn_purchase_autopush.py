"""Regression — manual-transaction → QBO Purchase autopush qualifier.

Verifies that `_maybe_autopush_purchase` only fires for manual
transactions that a QBO Purchase can actually represent:
  - amount is negative (outflow / expense)
  - bank_account_id is present (source of funds)
  - category_account_id OR splits are populated
"""
from __future__ import annotations
import asyncio
import sys
import types
import pytest

sys.path.insert(0, "/app/backend")


def _install_stubs(monkeypatch):
    """Neutralize DB + autopush side-effects so we can inspect the
    stamp/push decision without a Mongo/QBO round-trip."""
    stamped: dict = {}
    pushed: list = []

    class _Coll:
        async def update_one(self, q, upd):
            stamped["query"] = q
            stamped["set"] = upd.get("$set") or {}

    class _FakeDB:
        transactions = _Coll()
        def __getitem__(self, k):
            return getattr(self, k)

    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", _FakeDB())

    import qbo_mirror.autopush as _ap
    def _try(cid, entity, tid):
        pushed.append((cid, entity, tid))
    monkeypatch.setattr(_ap, "try_auto_push", _try)

    from routes import transactions as _tx
    monkeypatch.setattr(_tx, "db", _FakeDB())
    return stamped, pushed, _tx


def _run(coros):
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(coros)
    finally:
        # Let the fire-and-forget task from `_maybe_autopush_purchase`
        # complete before we assert.
        pending = asyncio.all_tasks(loop)
        if pending:
            loop.run_until_complete(asyncio.gather(*pending,
                                                    return_exceptions=True))
        loop.close()


def test_outflow_expense_qualifies(monkeypatch):
    stamped, pushed, _tx = _install_stubs(monkeypatch)
    doc = {
        "id": "t1", "company_id": "cid",
        "amount": -100000.0,
        "bank_account_id": "bank-1",
        "category_account_id": "exp-1",
        "description": "Big consulting expense",
    }
    async def _drive():
        _tx._maybe_autopush_purchase("cid", "t1", doc)
    _run(_drive())
    assert stamped.get("set", {}).get("txn_type") == "Purchase"
    assert stamped["set"]["direction"] == "out"
    assert stamped["set"]["line_items"][0]["amount"] == 100000.0
    assert stamped["set"]["line_items"][0]["expense_account_id"] == "exp-1"
    assert ("cid", "purchase", "t1") in pushed


def test_inflow_does_not_qualify(monkeypatch):
    stamped, pushed, _tx = _install_stubs(monkeypatch)
    doc = {
        "id": "t2", "company_id": "cid",
        "amount": 500.0,  # positive → inflow, not a Purchase
        "bank_account_id": "bank-1",
        "category_account_id": "rev-1",
    }
    async def _drive():
        _tx._maybe_autopush_purchase("cid", "t2", doc)
    _run(_drive())
    assert not stamped
    assert not pushed


def test_missing_bank_account_does_not_qualify(monkeypatch):
    stamped, pushed, _tx = _install_stubs(monkeypatch)
    doc = {
        "id": "t3", "company_id": "cid",
        "amount": -50.0,
        "bank_account_id": None,  # no source
        "category_account_id": "exp-1",
    }
    async def _drive():
        _tx._maybe_autopush_purchase("cid", "t3", doc)
    _run(_drive())
    assert not stamped
    assert not pushed


def test_missing_category_does_not_qualify(monkeypatch):
    stamped, pushed, _tx = _install_stubs(monkeypatch)
    doc = {
        "id": "t4", "company_id": "cid",
        "amount": -50.0,
        "bank_account_id": "bank-1",
        "category_account_id": None,  # no expense category
        "splits": [],
    }
    async def _drive():
        _tx._maybe_autopush_purchase("cid", "t4", doc)
    _run(_drive())
    assert not stamped
    assert not pushed


def test_splits_qualify_without_header_category(monkeypatch):
    stamped, pushed, _tx = _install_stubs(monkeypatch)
    doc = {
        "id": "t5", "company_id": "cid",
        "amount": -300.0,
        "bank_account_id": "bank-1",
        "category_account_id": None,
        "splits": [
            {"amount": -200, "category_account_id": "exp-1", "description": "A"},
            {"amount": -100, "category_account_id": "exp-2", "description": "B"},
        ],
    }
    async def _drive():
        _tx._maybe_autopush_purchase("cid", "t5", doc)
    _run(_drive())
    lines = stamped["set"]["line_items"]
    assert len(lines) == 2
    assert lines[0]["amount"] == 200.0
    assert lines[1]["expense_account_id"] == "exp-2"
    assert ("cid", "purchase", "t5") in pushed
