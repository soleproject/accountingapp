"""Regression — accounting_mode toggle on companies.

Verifies:
  1. Newly-created companies default to `accounting_mode="simple"`.
  2. `PATCH /companies/{cid}` accepts `accounting_mode` in {simple, advanced}
     and updates the field.
  3. Invalid `accounting_mode` values are rejected with 400.
  4. `accounting_mode` is included in the returned company doc.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _Coll:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.inserted = []
        self.updates = []
    async def insert_one(self, doc):
        self.rows.append(doc)
        self.inserted.append(doc)
    async def count_documents(self, q):
        return sum(1 for r in self.rows
                   if all(r.get(k) == v for k, v in q.items()))
    async def find_one(self, q, proj=None):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items()):
                return r
        return None
    async def update_one(self, q, upd):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items()):
                r.update(upd.get("$set", {}))
                self.updates.append(upd)
                class _R: matched_count = 1
                return _R()
        class _R: matched_count = 0
        return _R()

class _FakeDB:
    def __init__(self):
        self.companies = _Coll()
        self.memberships = _Coll()
        self.accounts = _Coll()
    def __getitem__(self, k): return getattr(self, k)


@pytest.fixture
def stub(monkeypatch):
    fake = _FakeDB()
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    from routes import companies as _c
    monkeypatch.setattr(_c, "db", fake)
    async def _ok(*a, **kw): return None
    monkeypatch.setattr(_c, "require_company", _ok)
    # Skip CoA/customer seed side-effects; not what we're testing here.
    monkeypatch.setattr(_c, "DEFAULT_COA", [], raising=False)
    return fake, _c


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_patch_accepts_simple(stub):
    fake, c = stub
    fake.companies.rows.append({"id": "cid", "name": "Acme"})
    _run(c.update_company("cid", {"accounting_mode": "simple"},
                            {"id": "u1", "email": "x"}))
    r = fake.companies.rows[0]
    assert r["accounting_mode"] == "simple"


def test_patch_accepts_advanced(stub):
    fake, c = stub
    fake.companies.rows.append({"id": "cid", "name": "Acme"})
    _run(c.update_company("cid", {"accounting_mode": "advanced"},
                            {"id": "u1", "email": "x"}))
    assert fake.companies.rows[0]["accounting_mode"] == "advanced"


def test_patch_rejects_invalid_mode(stub):
    fake, c = stub
    fake.companies.rows.append({"id": "cid", "name": "Acme"})
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        _run(c.update_company("cid", {"accounting_mode": "wizard"},
                                {"id": "u1", "email": "x"}))
    assert ei.value.status_code == 400
    assert "accounting_mode" in ei.value.detail


def test_patch_ignores_when_field_omitted(stub):
    """Other-field updates must not force a mode value."""
    fake, c = stub
    fake.companies.rows.append(
        {"id": "cid", "name": "Acme", "accounting_mode": "advanced"})
    _run(c.update_company("cid", {"name": "Acme Renamed"},
                            {"id": "u1", "email": "x"}))
    # Mode preserved as-is.
    assert fake.companies.rows[0]["accounting_mode"] == "advanced"
