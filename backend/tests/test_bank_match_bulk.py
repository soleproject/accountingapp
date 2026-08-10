"""Regression — bulk Bank Match Review endpoints.

`POST /bank-matches/bulk-confirm` and `POST /bank-matches/bulk-unlink`
must:
  - Only touch rows in the passed `bank_ids` list (no filter-based
    ambiguity).
  - Update the editor counterpart of every bank row in the batch.
  - Return a truthful `confirmed` / `unlinked` count in the payload.
  - Handle empty / malformed input gracefully (return 0, not 500).
  - Skip rows that aren't actually matched (defensive against a UI
    that sends stale ids).
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


def _matches(row, q):
    for k, v in q.items():
        if isinstance(v, dict):
            if "$in" in v and row.get(k) not in v["$in"]:
                return False
            if "$exists" in v:
                has = k in row
                if v["$exists"] != has:
                    return False
        elif row.get(k) != v:
            return False
    return True


class _AsyncCursor:
    def __init__(self, rows):
        self.rows = list(rows)
    def __aiter__(self):
        self._i = 0
        return self
    async def __anext__(self):
        if self._i >= len(self.rows):
            raise StopAsyncIteration
        r = self.rows[self._i]; self._i += 1
        return r


class _TxnColl:
    def __init__(self, rows):
        self.rows = list(rows)
    def find(self, q):
        return _AsyncCursor([r for r in self.rows if _matches(r, q)])
    async def update_many(self, q, upd):
        n = 0
        for r in self.rows:
            if _matches(r, q):
                for k, v in upd.get("$set", {}).items():
                    r[k] = v
                for k in upd.get("$unset", {}):
                    r.pop(k, None)
                n += 1
        class _R: modified_count = n
        return _R()


class _FakeDB:
    def __init__(self, rows):
        self.transactions = _TxnColl(rows)


def _seed_pairs():
    """Two unconfirmed + one confirmed + one unmatched (control)."""
    return [
        # Pair A (unconfirmed)
        {"id": "bank-A", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "matched_bank_txn_id": "bank-A",
          "matched_editor_txn_id": "ed-A",
          "matched_at": "2026-02-15T00:00:00Z"},
        {"id": "ed-A", "company_id": "cid",
          "matched_bank_txn_id": "bank-A", "txn_type": "Purchase",
          "hidden_by_match": True},
        # Pair B (unconfirmed)
        {"id": "bank-B", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00,
          "matched_bank_txn_id": "bank-B",
          "matched_editor_txn_id": "ed-B",
          "matched_at": "2026-02-16T00:00:00Z"},
        {"id": "ed-B", "company_id": "cid",
          "matched_bank_txn_id": "bank-B", "txn_type": "SalesReceipt",
          "hidden_by_match": True},
        # Pair C (already confirmed — should still confirm cleanly, no-op)
        {"id": "bank-C", "company_id": "cid",
          "amount": 50.00,
          "matched_bank_txn_id": "bank-C",
          "matched_editor_txn_id": "ed-C",
          "match_confirmed": True},
        {"id": "ed-C", "company_id": "cid",
          "matched_bank_txn_id": "bank-C", "txn_type": "Deposit",
          "match_confirmed": True},
        # Unmatched control — must never be touched.
        {"id": "solo", "company_id": "cid", "amount": 42.00},
    ]


@pytest.fixture
def stub(monkeypatch):
    fake = _FakeDB(_seed_pairs())
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    from routes import transactions as _tx
    monkeypatch.setattr(_tx, "db", fake)
    async def _ok(*a, **kw): return None
    monkeypatch.setattr(_tx, "require_company", _ok)
    return fake, _tx


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ─── bulk-confirm ─────────────────────────────────────────────────

def test_bulk_confirm_stamps_all_selected(stub):
    fake, tx = stub
    r = _run(tx.bulk_confirm_bank_matches(
        cid="cid",
        payload={"bank_ids": ["bank-A", "bank-B"]},
        user={"email": "x"}))
    assert r["confirmed"] == 2
    for eid in ("bank-A", "ed-A", "bank-B", "ed-B"):
        row = next(x for x in fake.transactions.rows if x["id"] == eid)
        assert row["match_confirmed"] is True
        assert "match_confirmed_at" in row


def test_bulk_confirm_ignores_unmatched_ids(stub):
    """Passing an unmatched row id must NOT explode — it just doesn't
    count. Protects against a stale UI submitting the wrong id."""
    fake, tx = stub
    r = _run(tx.bulk_confirm_bank_matches(
        cid="cid",
        payload={"bank_ids": ["bank-A", "solo", "nope"]},
        user={"email": "x"}))
    assert r["confirmed"] == 1  # only bank-A


def test_bulk_confirm_empty_list_is_noop(stub):
    fake, tx = stub
    r = _run(tx.bulk_confirm_bank_matches(
        cid="cid", payload={"bank_ids": []}, user={"email": "x"}))
    assert r == {"ok": True, "confirmed": 0}


def test_bulk_confirm_ignores_non_string_ids(stub):
    """Defensive — the endpoint filters out anything that isn't a
    string so a client bug can't send `None` or `123` and confuse
    the Mongo `$in`."""
    fake, tx = stub
    r = _run(tx.bulk_confirm_bank_matches(
        cid="cid",
        payload={"bank_ids": [None, 123, "bank-A"]},
        user={"email": "x"}))
    assert r["confirmed"] == 1


# ─── bulk-unlink ──────────────────────────────────────────────────

def test_bulk_unlink_wipes_all_selected(stub):
    fake, tx = stub
    r = _run(tx.bulk_unlink_bank_matches(
        cid="cid",
        payload={"bank_ids": ["bank-A", "bank-B"]},
        user={"email": "x"}))
    assert r["unlinked"] == 2
    for bid, eid in (("bank-A", "ed-A"), ("bank-B", "ed-B")):
        bank = next(x for x in fake.transactions.rows if x["id"] == bid)
        editor = next(x for x in fake.transactions.rows if x["id"] == eid)
        assert "matched_editor_txn_id" not in bank
        assert "matched_bank_txn_id" not in bank
        assert "matched_bank_txn_id" not in editor
        assert "hidden_by_match" not in editor
        # Tombstones on both sides so the silent matcher won't re-pair.
        assert "match_unlinked_at" in bank
        assert "match_unlinked_at" in editor


def test_bulk_unlink_empty_list_is_noop(stub):
    fake, tx = stub
    r = _run(tx.bulk_unlink_bank_matches(
        cid="cid", payload={"bank_ids": []}, user={"email": "x"}))
    assert r == {"ok": True, "unlinked": 0}


def test_bulk_unlink_leaves_unrelated_rows_alone(stub):
    """The unmatched `solo` row and the unrelated Pair C must survive
    an unlink of Pair A + Pair B."""
    fake, tx = stub
    _run(tx.bulk_unlink_bank_matches(
        cid="cid",
        payload={"bank_ids": ["bank-A", "bank-B"]},
        user={"email": "x"}))
    solo = next(r for r in fake.transactions.rows if r["id"] == "solo")
    bank_c = next(r for r in fake.transactions.rows if r["id"] == "bank-C")
    assert "match_unlinked_at" not in solo
    assert "match_unlinked_at" not in bank_c
    assert bank_c.get("match_confirmed") is True
