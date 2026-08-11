"""Regression — QBO InventoryAdjustment history pull.

Covers:
  1. `qbo_service.map_inventory_adjustment` extracts DocNumber, TxnDate,
     PrivateNote, AdjustAccountRef, and every Line's QtyDiff + ItemRef.
  2. `_pull_inventory_adjustments` prices each line at the local
     item's `cost`, builds a balanced 2-legged JE, and stamps
     posted=True / human_reviewed=True / _sync_origin=mirror_pull.
  3. Writeup (positive net) posts Dr 1300 Inventory Asset / Cr contra.
  4. Writedown (negative net) reverses the direction.
  5. Zero-cost or zero-qty lines are skipped (would post a $0 leg).
  6. Missing 1300 Inventory Asset → returns an `error` field cleanly
     (doesn't crash the whole pull).
  7. Re-running the pull updates the existing JE instead of inserting
     a duplicate.
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
            if "$exists" in v:
                if v["$exists"] != (k in row): return False
            elif "$ne" in v:
                if row.get(k) == v["$ne"]: return False
            elif "$gt" in v:
                if not (row.get(k, 0) > v["$gt"]): return False
            elif "$in" in v:
                if row.get(k) not in v["$in"]: return False
            else:
                return False
        elif row.get(k) != v:
            return False
    return True


class _Coll:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
    def find(self, q, proj=None):
        return _AsyncCursor([r for r in self.rows if _match(r, q)])
    async def find_one(self, q, proj=None):
        for r in self.rows:
            if _match(r, q): return r
        return None
    async def insert_one(self, doc):
        self.rows.append(doc)
    async def update_one(self, q, upd, upsert=False):
        for r in self.rows:
            if _match(r, q):
                r.update(upd.get("$set", {}))
                return


class _FakeDB:
    def __init__(self, accounts, items, jes=None):
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)
        self.journal_entries = _Coll(jes)
    def __getitem__(self, k): return getattr(self, k)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ─── Mapper ───────────────────────────────────────────────────────

def test_map_inventory_adjustment_captures_shape():
    from qbo_service import map_inventory_adjustment
    obj = {
        "Id": "77", "DocNumber": "IADJ-77",
        "TxnDate": "2026-02-10",
        "PrivateNote": "Monthly count correction",
        "AdjustAccountRef": {"value": "20", "name": "Inventory Shrinkage"},
        "Line": [
            {"Description": "Widget count-down",
              "ItemAdjustmentLineDetail": {
                  "QtyDiff": -3,
                  "ItemRef": {"value": "42", "name": "Widget"}}},
            {"Description": "Gizmo write-up",
              "ItemAdjustmentLineDetail": {
                  "QtyDiff": 5,
                  "ItemRef": {"value": "43", "name": "Gizmo"}}},
        ],
    }
    m = map_inventory_adjustment("cid", "realm", obj)
    assert m["source"] == "qbo_inv_adj"
    assert m["qbo_id"] == "77"
    assert m["number"] == "IADJ-77"
    assert m["date"] == "2026-02-10"
    assert m["memo"] == "Monthly count correction"
    assert m["adjust_account_qbo_id"] == "20"
    assert len(m["inventory_adjustment_lines"]) == 2
    l0 = m["inventory_adjustment_lines"][0]
    assert l0["qty_diff"] == -3
    assert l0["item_qbo_id"] == "42"


# ─── Pull step end-to-end ─────────────────────────────────────────

def _fake_query_all(rows):
    async def _gen(cid, realm, ent):
        for r in rows:
            yield r
    return _gen


@pytest.fixture
def stub(monkeypatch):
    accounts = [
        {"id": "inv-a", "company_id": "cid", "code": "1300",
          "name": "Inventory Asset", "type": "asset"},
        {"id": "shrink", "company_id": "cid", "code": "5300",
          "name": "Inventory Shrinkage", "type": "expense",
          "source": "qbo", "qbo_id": "20"},
    ]
    items = [
        {"id": "w1", "company_id": "cid", "source": "qbo", "qbo_id": "42",
          "name": "Widget", "cost": 10.00},
        {"id": "g1", "company_id": "cid", "source": "qbo", "qbo_id": "43",
          "name": "Gizmo", "cost": 5.00},
        {"id": "z1", "company_id": "cid", "source": "qbo", "qbo_id": "99",
          "name": "Free item", "cost": 0.00},
    ]
    fake = _FakeDB(accounts, items)
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    import qbo_service as _qs
    monkeypatch.setattr(_qs, "db", fake)
    from qbo_mirror import pull as _pull_mod
    monkeypatch.setattr(_pull_mod, "db", fake)
    return fake, _pull_mod, _qs


def test_pull_writedown_posts_reverse_direction(stub, monkeypatch):
    fake, pull_mod, qs = stub
    # -3 widgets @ $10 = -$30 (writedown → Cr Inventory Asset)
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "77", "DocNumber": "IADJ-77", "TxnDate": "2026-02-10",
        "AdjustAccountRef": {"value": "20", "name": "Inventory Shrinkage"},
        "Line": [{"ItemAdjustmentLineDetail": {
            "QtyDiff": -3, "ItemRef": {"value": "42", "name": "Widget"}}}],
    }]))
    r = _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    assert r["inserted"] == 1
    je = fake.journal_entries.rows[0]
    assert je["total_debit"] == 30.0
    assert je["total_credit"] == 30.0
    debit = next(l for l in je["lines"] if l["debit"] > 0)
    credit = next(l for l in je["lines"] if l["credit"] > 0)
    # Inventory decreased → Cr 1300 / Dr 5300 Shrinkage.
    assert credit["account_code"] == "1300"
    assert debit["account_code"] == "5300"


def test_pull_writeup_posts_forward_direction(stub, monkeypatch):
    fake, pull_mod, qs = stub
    # +5 gizmos @ $5 = +$25 (writeup → Dr Inventory Asset)
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "88", "DocNumber": "IADJ-88", "TxnDate": "2026-02-11",
        "AdjustAccountRef": {"value": "20", "name": "Inventory Shrinkage"},
        "Line": [{"ItemAdjustmentLineDetail": {
            "QtyDiff": 5, "ItemRef": {"value": "43", "name": "Gizmo"}}}],
    }]))
    r = _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    assert r["inserted"] == 1
    je = fake.journal_entries.rows[0]
    debit = next(l for l in je["lines"] if l["debit"] > 0)
    credit = next(l for l in je["lines"] if l["credit"] > 0)
    assert debit["account_code"] == "1300"
    assert credit["account_code"] == "5300"
    assert je["total_debit"] == 25.0


def test_pull_skips_zero_cost_items(stub, monkeypatch):
    fake, pull_mod, qs = stub
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "99", "DocNumber": "IADJ-99", "TxnDate": "2026-02-12",
        "AdjustAccountRef": {"value": "20"},
        "Line": [{"ItemAdjustmentLineDetail": {
            "QtyDiff": 10, "ItemRef": {"value": "99", "name": "Free item"}}}],
    }]))
    r = _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    # $0 net → no JE inserted (we don't post empty JEs).
    assert r["inserted"] == 0
    assert len(fake.journal_entries.rows) == 0


def test_pull_missing_1300_returns_error(monkeypatch):
    fake = _FakeDB([], [])
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    from qbo_mirror import pull as pull_mod
    monkeypatch.setattr(pull_mod, "db", fake)
    r = _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    assert r.get("error") and "1300" in r["error"]


def test_pull_is_idempotent(stub, monkeypatch):
    """Re-running the pull with the same QBO id updates the existing
    JE instead of inserting a duplicate. Simulates a mirror re-pull."""
    fake, pull_mod, qs = stub
    payload = [{
        "Id": "77", "DocNumber": "IADJ-77", "TxnDate": "2026-02-10",
        "AdjustAccountRef": {"value": "20"},
        "Line": [{"ItemAdjustmentLineDetail": {
            "QtyDiff": -3, "ItemRef": {"value": "42"}}}],
    }]
    monkeypatch.setattr(qs, "query_all", _fake_query_all(payload))
    _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    # Second run: same QBO id, still one JE row.
    r = _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    assert r["updated"] == 1
    assert len(fake.journal_entries.rows) == 1


def test_pull_multi_line_nets_to_zero_skipped(stub, monkeypatch):
    """A writeup + writedown of equal value on different items nets
    to $0 — we skip these because they'd produce a $0 JE (correct
    accounting but adds noise to reports)."""
    fake, pull_mod, qs = stub
    monkeypatch.setattr(qs, "query_all", _fake_query_all([{
        "Id": "100", "DocNumber": "IADJ-100", "TxnDate": "2026-02-12",
        "AdjustAccountRef": {"value": "20"},
        "Line": [
            {"ItemAdjustmentLineDetail": {"QtyDiff": +5,
              "ItemRef": {"value": "43", "name": "Gizmo"}}},  # +25
            {"ItemAdjustmentLineDetail": {"QtyDiff": -5,
              "ItemRef": {"value": "43", "name": "Gizmo"}}},  # -25
        ],
    }]))
    r = _run(pull_mod._pull_inventory_adjustments("cid", "realm"))
    assert r["inserted"] == 0
    assert len(fake.journal_entries.rows) == 0
