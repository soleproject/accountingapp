"""Regression — Inventory migration bits.

Covers:
  1. `qbo_service.map_item` extracts inventory-specific fields
     (QtyOnHand, AssetAccountRef, TrackQtyOnHand, InvStartDate,
     ReorderPoint) alongside the existing name/price/cost fields.
  2. `qbo_service._post_opening_inventory_je` posts a single balanced
     JE valuing on-hand inventory (qty × cost) against the 1300
     Inventory Asset + 3900 Opening Balance Equity accounts.
  3. Items with qty_on_hand=0 or cost=0 are skipped (no clutter).
  4. Re-running the migration overwrites the same JE instead of
     stacking a second one (idempotent).
  5. `InventoryAdjustment` is in PREVIEW_ENTITIES so the count tile
     surfaces in the migration preview UI.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _AsyncCursor:
    def __init__(self, rows):
        self.rows = list(rows)
    async def to_list(self, n=None, length=None):
        return list(self.rows)
    def __aiter__(self):
        self._i = 0
        return self
    async def __anext__(self):
        if self._i >= len(self.rows):
            raise StopAsyncIteration
        r = self.rows[self._i]; self._i += 1
        return r


def _match(row, q):
    for k, v in q.items():
        if k == "$or":
            if not any(_match(row, c) for c in v):
                return False
            continue
        if isinstance(v, dict):
            if "$gt" in v:
                if not (row.get(k, 0) > v["$gt"]): return False
            elif "$regex" in v:
                import re as _re
                if not row.get(k) or not _re.search(
                    v["$regex"], row[k],
                    _re.I if "i" in (v.get("$options") or "") else 0):
                    return False
            else:
                # Unknown operator → conservatively no-match.
                return False
        elif row.get(k) != v:
            return False
    return True


class _Coll:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.upserts = []
    def find(self, q, proj=None):
        return _AsyncCursor([r for r in self.rows if _match(r, q)])
    async def find_one(self, q, proj=None):
        for r in self.rows:
            if _match(r, q):
                return r
        return None
    async def update_one(self, q, upd, upsert=False):
        for r in self.rows:
            if _match(r, q):
                r.update(upd.get("$set", {}))
                return
        if upsert:
            merged = {**q, **upd.get("$set", {})}
            self.rows.append(merged)
            self.upserts.append(merged)


class _FakeDB:
    def __init__(self, accounts, items):
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)
        self.journal_entries = _Coll()
    def __getitem__(self, k): return getattr(self, k)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ─── map_item (extended) ──────────────────────────────────────────

def test_map_item_captures_inventory_fields():
    from qbo_service import map_item
    obj = {
        "Id": "42", "Name": "Widget", "Type": "Inventory",
        "UnitPrice": 25.00, "PurchaseCost": 10.00,
        "QtyOnHand": 50, "ReorderPoint": 10,
        "TrackQtyOnHand": True, "InvStartDate": "2025-01-01",
        "AssetAccountRef": {"value": "77"},
        "IncomeAccountRef": {"value": "80"},
        "ExpenseAccountRef": {"value": "81"},
        "Sku": "WID-001", "Active": True,
    }
    m = map_item("cid", "realm", obj)
    assert m["qty_on_hand"] == 50.0
    assert m["cost"] == 10.00
    assert m["price"] == 25.00
    assert m["asset_account_qbo_id"] == "77"
    assert m["track_qty_on_hand"] is True
    assert m["inv_start_date"] == "2025-01-01"
    assert m["reorder_point"] == 10.0
    assert m["sku"] == "WID-001"


def test_map_item_defaults_for_service_item():
    """Service items don't carry inventory fields — mapper must not
    crash and should leave the flags in a sensible off state."""
    from qbo_service import map_item
    obj = {"Id": "1", "Name": "Consulting", "Type": "Service",
            "UnitPrice": 150.00, "Active": True}
    m = map_item("cid", "realm", obj)
    assert m["qty_on_hand"] == 0.0
    assert m["track_qty_on_hand"] is False
    assert m["asset_account_qbo_id"] is None
    assert m["inv_start_date"] is None


# ─── Opening inventory JE ─────────────────────────────────────────

@pytest.fixture
def opening_stub(monkeypatch):
    accounts = [
        {"id": "inv-asset", "company_id": "cid", "code": "1300",
          "name": "Inventory Asset", "type": "asset"},
        {"id": "opening-eq", "company_id": "cid", "code": "3900",
          "name": "Opening Balance Equity", "type": "equity"},
    ]
    items = [
        # 50 widgets @ $10 = $500
        {"id": "w1", "company_id": "cid", "source": "qbo",
          "track_qty_on_hand": True, "qty_on_hand": 50.0,
          "cost": 10.00, "name": "Widget"},
        # 20 sprockets @ $3.50 = $70
        {"id": "s1", "company_id": "cid", "source": "qbo",
          "track_qty_on_hand": True, "qty_on_hand": 20.0,
          "cost": 3.50, "name": "Sprocket"},
        # Zero on-hand → skipped
        {"id": "z1", "company_id": "cid", "source": "qbo",
          "track_qty_on_hand": True, "qty_on_hand": 0,
          "cost": 5.00, "name": "Discontinued"},
        # Zero cost → skipped (avoids $0 clutter lines)
        {"id": "n1", "company_id": "cid", "source": "qbo",
          "track_qty_on_hand": True, "qty_on_hand": 12,
          "cost": 0, "name": "Freebie"},
        # Service item (not tracked) → skipped
        {"id": "svc1", "company_id": "cid", "source": "qbo",
          "track_qty_on_hand": False, "qty_on_hand": 0,
          "cost": 0, "name": "Consulting"},
    ]
    fake = _FakeDB(accounts, items)
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    import qbo_service as _qs
    monkeypatch.setattr(_qs, "db", fake)
    return fake, _qs


def test_opening_je_posts_balanced_debit_credit(opening_stub):
    fake, qs = opening_stub
    total = _run(qs._post_opening_inventory_je("cid"))
    assert total == 570.0  # 500 + 70
    je = fake.journal_entries.rows[0]
    assert je["total"] == 570.0
    assert len(je["lines"]) == 2
    debit = next(l for l in je["lines"] if l["debit"] > 0)
    credit = next(l for l in je["lines"] if l["credit"] > 0)
    assert debit["debit"] == 570.0
    assert debit["account_code"] == "1300"
    assert credit["credit"] == 570.0
    assert credit["account_code"] == "3900"
    # Debit + credit balance to the penny.
    assert debit["debit"] == credit["credit"]


def test_opening_je_skips_zero_qty_and_zero_cost(opening_stub):
    fake, qs = opening_stub
    _run(qs._post_opening_inventory_je("cid"))
    je = fake.journal_entries.rows[0]
    line_descs = " ".join(l["description"] for l in je.get("opening_inventory_lines", []))
    assert "Widget" in line_descs
    assert "Sprocket" in line_descs
    assert "Discontinued" not in line_descs
    assert "Freebie" not in line_descs
    assert "Consulting" not in line_descs


def test_opening_je_idempotent_id(opening_stub):
    """Re-running the migration must rewrite the same JE, not stack."""
    fake, qs = opening_stub
    _run(qs._post_opening_inventory_je("cid"))
    _run(qs._post_opening_inventory_je("cid"))
    # Only one JE exists (upsert semantics).
    assert len(fake.journal_entries.rows) == 1
    # Its id is deterministic.
    assert fake.journal_entries.rows[0]["id"].startswith("qbo-opening-inv-")


def test_opening_je_returns_zero_when_no_inventory(monkeypatch):
    """A service-only company shouldn't get an empty JE posted."""
    accounts = [{"id": "inv-asset", "company_id": "cid", "code": "1300",
                  "name": "Inventory Asset", "type": "asset"}]
    fake = _FakeDB(accounts, [])
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    import qbo_service as _qs
    monkeypatch.setattr(_qs, "db", fake)
    total = _run(_qs._post_opening_inventory_je("cid"))
    assert total == 0.0
    assert len(fake.journal_entries.rows) == 0


def test_opening_je_returns_zero_when_no_inv_asset_account(monkeypatch):
    """No 1300 Inventory Asset seeded → nothing to post to → return 0
    gracefully (don't crash the migration finisher)."""
    fake = _FakeDB([], [
        {"id": "w1", "company_id": "cid", "source": "qbo",
          "track_qty_on_hand": True, "qty_on_hand": 50.0,
          "cost": 10.00, "name": "Widget"},
    ])
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    import qbo_service as _qs
    monkeypatch.setattr(_qs, "db", fake)
    total = _run(_qs._post_opening_inventory_je("cid"))
    assert total == 0.0
    assert len(fake.journal_entries.rows) == 0


# ─── PREVIEW_ENTITIES includes InventoryAdjustment ───────────────

def test_preview_includes_inventory_adjustment():
    from qbo_service import PREVIEW_ENTITIES
    assert "InventoryAdjustment" in PREVIEW_ENTITIES
