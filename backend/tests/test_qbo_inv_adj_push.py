"""Regression — QBO InventoryAdjustment outbound push (mirror).

Closes the bi-directional loop for inventory: local adjustments
(created via `inventory_service.apply_adjustment`) push to QBO's
`InventoryAdjustment` entity via `push._inventory_adjustment_body`
and `autopush._push_one_inventory_adjustment`.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _Coll:
    def __init__(self, rows):
        self.rows = list(rows)
    async def find_one(self, q, proj=None):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items() if not isinstance(v, dict)):
                return r
        return None


class _FakeDB:
    def __init__(self, accounts, items):
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)
    def __getitem__(self, k): return getattr(self, k)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture
def stub(monkeypatch):
    fake = _FakeDB(
        accounts=[
            {"id": "contra", "company_id": "cid", "code": "6500",
              "name": "Inventory Adjustments", "qbo_id": "45",
              "type": "expense"},
        ],
        items=[
            {"id": "w1", "company_id": "cid", "name": "Widget",
              "qbo_id": "42"},
            {"id": "g1", "company_id": "cid", "name": "Gizmo",
              "qbo_id": "43"},
            {"id": "local1", "company_id": "cid", "name": "LocalOnly"},
        ],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake, _push_mod


# ─── Body builder ─────────────────────────────────────────────────

def test_body_writedown_shape(stub):
    fake, push_mod = stub
    doc = {
        "id": "je-1", "company_id": "cid",
        "date": "2026-02-15", "memo": "Monthly shrink",
        "contra_account_id": "contra",
        "inventory_account_id": "inv-1300",
        "inventory_adjustment_lines": [{
            "item_id": "w1", "item_name": "Widget",
            "qty_diff": -3, "cost": 10.00, "description": "damaged",
        }],
    }
    body = _run(push_mod._inventory_adjustment_body("cid", doc))
    assert body["AdjustAccountRef"]["value"] == "45"
    assert body["Line"][0]["DetailType"] == "ItemAdjustmentLineDetail"
    assert body["Line"][0]["ItemAdjustmentLineDetail"]["QtyDiff"] == -3
    assert body["Line"][0]["ItemAdjustmentLineDetail"]["ItemRef"]["value"] == "42"
    assert body["TxnDate"] == "2026-02-15"
    assert body["PrivateNote"] == "Monthly shrink"


def test_body_writeup_shape(stub):
    fake, push_mod = stub
    doc = {
        "id": "je-2", "company_id": "cid", "date": "2026-02-16",
        "contra_account_id": "contra",
        "inventory_adjustment_lines": [{
            "item_id": "g1", "item_name": "Gizmo",
            "qty_diff": 5, "cost": 5.00,
        }],
    }
    body = _run(push_mod._inventory_adjustment_body("cid", doc))
    assert body["Line"][0]["ItemAdjustmentLineDetail"]["QtyDiff"] == 5


def test_body_multiline(stub):
    fake, push_mod = stub
    doc = {
        "id": "je-3", "company_id": "cid",
        "contra_account_id": "contra",
        "inventory_adjustment_lines": [
            {"item_id": "w1", "qty_diff": -2, "cost": 10, "item_name": "Widget"},
            {"item_id": "g1", "qty_diff": 4,  "cost": 5,  "item_name": "Gizmo"},
        ],
    }
    body = _run(push_mod._inventory_adjustment_body("cid", doc))
    assert len(body["Line"]) == 2


def test_body_skips_qbo_unsynced_item(stub):
    """A line referencing an item that hasn't been mirrored to QBO
    yet is silently dropped — the push worker will emit a `failed`
    row and the CPA can push items first + retry."""
    fake, push_mod = stub
    doc = {
        "id": "je-4", "company_id": "cid",
        "contra_account_id": "contra",
        "inventory_adjustment_lines": [
            {"item_id": "w1", "qty_diff": -1, "cost": 10, "item_name": "Widget"},
            # local1 has no qbo_id → skipped
            {"item_id": "local1", "qty_diff": -1, "cost": 10,
              "item_name": "LocalOnly"},
        ],
    }
    body = _run(push_mod._inventory_adjustment_body("cid", doc))
    assert len(body["Line"]) == 1


def test_body_requires_contra_synced(stub):
    """If the Inventory Adjustments contra account itself isn't
    mirrored, we can't reference it — must raise so the push worker
    surfaces a `failed` entry instead of silently posting garbage."""
    fake, push_mod = stub
    # Nuke the contra account's qbo_id so it looks unsynced.
    fake.accounts.rows[0]["qbo_id"] = None
    doc = {
        "id": "je-5", "company_id": "cid",
        "contra_account_id": "contra",
        "inventory_adjustment_lines": [
            {"item_id": "w1", "qty_diff": -1, "cost": 10, "item_name": "Widget"},
        ],
    }
    with pytest.raises(ValueError, match="Contra"):
        _run(push_mod._inventory_adjustment_body("cid", doc))


def test_body_requires_at_least_one_synced_line(stub):
    """Every line points at an unsynced item → the whole push fails
    fast rather than posting an empty QBO adjustment."""
    fake, push_mod = stub
    doc = {
        "id": "je-6", "company_id": "cid",
        "contra_account_id": "contra",
        "inventory_adjustment_lines": [
            {"item_id": "local1", "qty_diff": -1, "cost": 10,
              "item_name": "LocalOnly"},
        ],
    }
    with pytest.raises(ValueError, match="item"):
        _run(push_mod._inventory_adjustment_body("cid", doc))


def test_body_requires_nonzero_qty(stub):
    """A line with QtyDiff=0 is skipped (would be a QBO validation
    error). If all lines have zero qty → we raise."""
    fake, push_mod = stub
    doc = {
        "id": "je-7", "company_id": "cid",
        "contra_account_id": "contra",
        "inventory_adjustment_lines": [
            {"item_id": "w1", "qty_diff": 0, "cost": 10, "item_name": "Widget"},
        ],
    }
    with pytest.raises(ValueError):
        _run(push_mod._inventory_adjustment_body("cid", doc))


def test_body_docnumber_truncated(stub):
    """QBO caps DocNumber at 21 chars — we must send within limit."""
    fake, push_mod = stub
    doc = {
        "id": "je-8", "company_id": "cid",
        "contra_account_id": "contra",
        "number": "SUPER-LONG-DOC-NUMBER-EXCEEDS-QBO-LIMIT",
        "inventory_adjustment_lines": [
            {"item_id": "w1", "qty_diff": -1, "cost": 10, "item_name": "Widget"},
        ],
    }
    body = _run(push_mod._inventory_adjustment_body("cid", doc))
    assert len(body["DocNumber"]) <= 21


# ─── Twin patch ───────────────────────────────────────────────────

def test_twin_patch_reflects_qbo_authoritative_fields():
    from qbo_mirror.push import _local_patch_from_qbo_inventory_adjustment
    p = _local_patch_from_qbo_inventory_adjustment({
        "Id": "77", "DocNumber": "INVADJ-77", "TxnDate": "2026-02-15",
    })
    assert p["number"] == "INVADJ-77"
    assert p["date"] == "2026-02-15"


def test_twin_patch_omits_missing_fields():
    from qbo_mirror.push import _local_patch_from_qbo_inventory_adjustment
    p = _local_patch_from_qbo_inventory_adjustment({"Id": "77"})
    assert "number" not in p
    assert "date" not in p


# ─── Autopush wiring ──────────────────────────────────────────────

def test_inventory_adjustment_registered_in_autopush():
    from qbo_mirror.autopush import _ENTITY_META
    assert "inventory_adjustment" in _ENTITY_META
    path, key, coll, _ = _ENTITY_META["inventory_adjustment"]
    assert path == "inventoryadjustment"
    assert key == "InventoryAdjustment"
    assert coll == "journal_entries"


def test_inventory_adjustment_in_push_module():
    from qbo_mirror import push as p
    assert hasattr(p, "_push_inventory_adjustments")
    assert hasattr(p, "_inventory_adjustment_body")
    assert hasattr(p, "_local_patch_from_qbo_inventory_adjustment")
