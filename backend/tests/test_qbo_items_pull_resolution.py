"""Regression — _pull_items resolves local account ids and sets
`track_inventory`.

Two bugs shipped in the initial inventory migration:
  1. `_UPDATE_FIELDS["items"]` was ["name","sku","price","active"] —
     didn't include the inventory fields, so re-pulls never healed
     items migrated before the mapper patch shipped.
  2. `map_item` stored QBO's account refs as `qbo_id` strings but the
     local inventory system (`inventory_service.py`) filters on
     `inventory_account_id` (LOCAL id) and `track_inventory` (internal
     flag distinct from QBO's `TrackQtyOnHand`). So the Inventory
     Management page showed "0 tracked items" even for real QBO
     Inventory-type items.

These tests lock in the fix so both bugs stay fixed.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _AsyncCursor:
    def __init__(self, rows):
        self.rows = list(rows)
    async def to_list(self, n=None, length=None): return list(self.rows)
    def __aiter__(self):
        self._i = 0; return self
    async def __anext__(self):
        if self._i >= len(self.rows):
            raise StopAsyncIteration
        r = self.rows[self._i]; self._i += 1
        return r


class _Coll:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
    def find(self, q, proj=None):
        def _ok(row):
            for k, v in q.items():
                if isinstance(v, dict):
                    continue
                if row.get(k) != v: return False
            return True
        return _AsyncCursor([r for r in self.rows if _ok(r)])
    async def find_one(self, q, proj=None):
        for r in self.rows:
            ok = True
            for k, v in q.items():
                if isinstance(v, dict): continue
                if r.get(k) != v:
                    ok = False; break
            if ok: return r
        return None
    async def insert_one(self, doc):
        self.rows.append(doc)
    async def update_one(self, q, upd, upsert=False):
        for r in self.rows:
            ok = True
            for k, v in q.items():
                if r.get(k) != v: ok = False; break
            if ok:
                r.update(upd.get("$set", {}))
                return


class _FakeDB:
    def __init__(self, accounts, items):
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)
    def __getitem__(self, k): return getattr(self, k)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _fake_query_all(rows):
    async def _gen(cid, realm, ent):
        for r in rows:
            yield r
    return _gen


@pytest.fixture
def stub(monkeypatch):
    fake = _FakeDB(
        accounts=[
            {"id": "inv-a", "company_id": "cid", "source": "qbo",
              "qbo_id": "77", "code": "1300", "name": "Inventory Asset"},
            {"id": "cogs-a", "company_id": "cid", "source": "qbo",
              "qbo_id": "80", "code": "5000", "name": "COGS"},
            {"id": "inc-a", "company_id": "cid", "source": "qbo",
              "qbo_id": "81", "code": "4000", "name": "Sales"},
        ],
        items=[],
    )
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    from qbo_mirror import pull as pull_mod
    monkeypatch.setattr(pull_mod, "db", fake)
    import qbo_service as qs
    monkeypatch.setattr(qs, "db", fake)
    return fake, pull_mod, qs


def test_pull_items_resolves_local_ids(stub, monkeypatch):
    fake, pull_mod, qs = stub
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "42", "Name": "Widget", "Type": "Inventory",
        "UnitPrice": 25, "PurchaseCost": 10, "QtyOnHand": 50,
        "TrackQtyOnHand": True,
        "AssetAccountRef":   {"value": "77"},
        "IncomeAccountRef":  {"value": "81"},
        "ExpenseAccountRef": {"value": "80"},
        "Active": True,
    }]))
    r = _run(pull_mod._pull_items("cid", "realm"))
    assert r["inserted"] == 1
    item = fake.items.rows[0]
    # Local ids resolved from QBO refs.
    assert item["inventory_account_id"] == "inv-a"
    assert item["cogs_account_id"] == "cogs-a"
    assert item["expense_account_id"] == "cogs-a"
    assert item["income_account_id"] == "inc-a"
    # Internal `track_inventory` flag set (powers Inventory page).
    assert item["track_inventory"] is True


def test_pull_items_service_type_not_tracked(stub, monkeypatch):
    """Service items must NOT flip track_inventory on — they'd
    pollute the Inventory Management page's tracked count."""
    fake, pull_mod, qs = stub
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "1", "Name": "Consulting", "Type": "Service",
        "UnitPrice": 150, "Active": True,
    }]))
    _run(pull_mod._pull_items("cid", "realm"))
    item = fake.items.rows[0]
    assert item["track_inventory"] is False


def test_pull_items_repull_heals_pre_patch_row(stub, monkeypatch):
    """Existing row migrated before the fix — no track_inventory,
    no inventory_account_id — must get updated on the next pull.
    Locks in that `_UPDATE_FIELDS["items"]` includes the inventory
    fields so re-pulls actually update them."""
    fake, pull_mod, qs = stub
    # Pre-patch row already in DB (name only, no inventory fields).
    fake.items.rows.append({
        "id": "qbo-cid-item-42", "company_id": "cid",
        "source": "qbo", "qbo_id": "42", "name": "Widget",
        "item_type": "Service",  # stale mis-tag from old mapper
    })
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "42", "Name": "Widget", "Type": "Inventory",
        "UnitPrice": 25, "PurchaseCost": 10, "QtyOnHand": 50,
        "TrackQtyOnHand": True,
        "AssetAccountRef": {"value": "77"},
        "Active": True,
    }]))
    r = _run(pull_mod._pull_items("cid", "realm"))
    assert r["updated"] == 1
    item = fake.items.rows[0]
    assert item["track_inventory"] is True
    assert item["inventory_account_id"] == "inv-a"
    assert item["qty_on_hand"] == 50
    assert item["cost"] == 10
    assert item["item_type"] == "Inventory"  # corrected


def test_update_fields_include_inventory():
    """Guard rail — the `_UPDATE_FIELDS["items"]` list must contain
    every inventory-relevant field or re-pulls silently skip them."""
    from qbo_mirror.pull import _UPDATE_FIELDS
    fields = set(_UPDATE_FIELDS["items"])
    for expected in ("cost", "qty_on_hand", "track_qty_on_hand",
                       "asset_account_qbo_id", "item_type"):
        assert expected in fields, f"Missing {expected}"
