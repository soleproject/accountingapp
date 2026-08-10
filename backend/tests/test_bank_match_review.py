"""Regression — Bank Match Review endpoints.

Covers `GET /bank-matches`, `POST /bank-matches/{id}/confirm`, and
`POST /bank-matches/{id}/unlink` on `routes/transactions.py`.

The review UI lets a CPA in Advanced mode audit every silent-matched
pair (see `bank_match.py`). These tests lock in:
  - The list endpoint returns pairs shaped as `{bank, editor, matched_at,
    confirmed}` with both sides fully hydrated in one round-trip.
  - Status filter narrows to unconfirmed by default; confirmed and all
    each pull from the same collection with different predicates.
  - Confirm stamps both sides with `match_confirmed=True` + timestamp.
  - Unlink wipes all four match fields from both sides AND sets
    `match_unlinked_at` on both — the tombstone flag that prevents the
    silent matcher from re-pairing them on the next Plaid sync.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _AsyncCursor:
    def __init__(self, rows):
        self.rows = list(rows)
    def sort(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    async def to_list(self, length=None, **kw):
        return list(self.rows)
    def __aiter__(self):
        self._i = 0
        return self
    async def __anext__(self):
        if self._i >= len(self.rows):
            raise StopAsyncIteration
        r = self.rows[self._i]; self._i += 1
        return r


def _matches(row, q):
    for k, v in q.items():
        if isinstance(v, dict):
            if "$in" in v and row.get(k) not in v["$in"]:
                return False
            if "$exists" in v:
                want = v["$exists"]
                has = k in row
                if want != has:
                    return False
            if "$ne" in v and row.get(k) == v["$ne"]:
                return False
        elif row.get(k) != v:
            return False
    return True


class _TxnColl:
    def __init__(self, rows):
        self.rows = list(rows)
    def find(self, q):
        return _AsyncCursor([r for r in self.rows if _matches(r, q)])
    async def find_one(self, q, proj=None):
        for r in self.rows:
            if _matches(r, q):
                return r
        return None
    async def update_one(self, q, upd):
        for r in self.rows:
            if _matches(r, q):
                for k, v in upd.get("$set", {}).items():
                    r[k] = v
                for k in upd.get("$unset", {}):
                    r.pop(k, None)
                class _R: matched_count = 1
                return _R()
        class _R: matched_count = 0
        return _R()


class _FakeDB:
    def __init__(self, rows):
        self.transactions = _TxnColl(rows)


@pytest.fixture
def stub(monkeypatch):
    # Two matched pairs — one confirmed, one still pending review.
    rows = [
        # Pair A (unconfirmed)
        {"id": "bank-A", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00, "date": "2026-02-15",
          "plaid_transaction_id": "P-A",
          "matched_bank_txn_id": "bank-A", "matched_editor_txn_id": "ed-A",
          "matched_at": "2026-02-15T12:00:00Z"},
        {"id": "ed-A", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00, "date": "2026-02-15",
          "txn_type": "Purchase",
          "matched_bank_txn_id": "bank-A", "hidden_by_match": True,
          "matched_at": "2026-02-15T12:00:00Z"},
        # Pair B (already confirmed)
        {"id": "bank-B", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00, "date": "2026-02-16",
          "plaid_transaction_id": "P-B",
          "matched_bank_txn_id": "bank-B", "matched_editor_txn_id": "ed-B",
          "matched_at": "2026-02-16T12:00:00Z",
          "match_confirmed": True,
          "match_confirmed_at": "2026-02-17T09:00:00Z"},
        {"id": "ed-B", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00, "date": "2026-02-16",
          "txn_type": "SalesReceipt",
          "matched_bank_txn_id": "bank-B", "hidden_by_match": True,
          "match_confirmed": True},
        # A totally unrelated row — should NEVER appear in any /bank-matches
        # response since it isn't a matched pair.
        {"id": "solo", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -42.00, "date": "2026-02-15"},
    ]
    fake = _FakeDB(rows)
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    from routes import transactions as _tx
    monkeypatch.setattr(_tx, "db", fake)
    async def _ok(*a, **kw): return None
    monkeypatch.setattr(_tx, "require_company", _ok)
    return fake, _tx


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ─── list_bank_matches ────────────────────────────────────────────

def test_default_status_returns_unconfirmed_only(stub):
    fake, tx = stub
    r = _run(tx.list_bank_matches(cid="cid", status=None,
                                    user={"email": "x"}))
    ids = [p["bank"]["id"] for p in r["pairs"]]
    assert ids == ["bank-A"]  # confirmed pair B excluded
    assert r["count"] == 1


def test_status_confirmed_returns_only_confirmed(stub):
    fake, tx = stub
    r = _run(tx.list_bank_matches(cid="cid", status="confirmed",
                                    user={"email": "x"}))
    assert [p["bank"]["id"] for p in r["pairs"]] == ["bank-B"]


def test_status_all_returns_both(stub):
    fake, tx = stub
    r = _run(tx.list_bank_matches(cid="cid", status="all",
                                    user={"email": "x"}))
    got = sorted(p["bank"]["id"] for p in r["pairs"])
    assert got == ["bank-A", "bank-B"]


def test_pairs_include_both_sides(stub):
    fake, tx = stub
    r = _run(tx.list_bank_matches(cid="cid", status="all",
                                    user={"email": "x"}))
    for p in r["pairs"]:
        assert p["bank"] is not None
        assert p["editor"] is not None
        # Editor side must actually reference the bank side (sanity).
        assert p["editor"]["matched_bank_txn_id"] == p["bank"]["id"]


def test_confirmed_flag_reflected(stub):
    fake, tx = stub
    r = _run(tx.list_bank_matches(cid="cid", status="all",
                                    user={"email": "x"}))
    by = {p["bank"]["id"]: p["confirmed"] for p in r["pairs"]}
    assert by["bank-A"] is False
    assert by["bank-B"] is True


# ─── confirm_bank_match ───────────────────────────────────────────

def test_confirm_stamps_both_sides(stub):
    fake, tx = stub
    _run(tx.confirm_bank_match(cid="cid", bank_id="bank-A",
                                 user={"email": "x"}))
    bank = next(r for r in fake.transactions.rows if r["id"] == "bank-A")
    ed = next(r for r in fake.transactions.rows if r["id"] == "ed-A")
    assert bank["match_confirmed"] is True
    assert ed["match_confirmed"] is True
    assert "match_confirmed_at" in bank
    assert "match_confirmed_at" in ed


def test_confirm_404_when_not_matched(stub):
    fake, tx = stub
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        _run(tx.confirm_bank_match(cid="cid", bank_id="solo",
                                     user={"email": "x"}))
    assert ei.value.status_code == 404


# ─── unlink_bank_match ────────────────────────────────────────────

def test_unlink_wipes_match_fields_on_both_sides(stub):
    fake, tx = stub
    _run(tx.unlink_bank_match(cid="cid", bank_id="bank-A",
                                user={"email": "x"}))
    bank = next(r for r in fake.transactions.rows if r["id"] == "bank-A")
    ed = next(r for r in fake.transactions.rows if r["id"] == "ed-A")
    # Match pointers gone from both.
    for k in ("matched_bank_txn_id", "matched_editor_txn_id",
                "matched_at", "match_confirmed"):
        assert k not in bank
    for k in ("matched_bank_txn_id", "matched_at",
                "hidden_by_match", "match_confirmed"):
        assert k not in ed
    # Tombstone set on both to block re-pairing on next sync.
    assert "match_unlinked_at" in bank
    assert "match_unlinked_at" in ed


def test_unlink_404_when_no_pair(stub):
    fake, tx = stub
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        _run(tx.unlink_bank_match(cid="cid", bank_id="does-not-exist",
                                    user={"email": "x"}))
    assert ei.value.status_code == 404


def test_unlink_then_confirm_404s(stub):
    """After unlink the pair no longer exists → confirm on the same
    id must 404 (proves unlink truly severed the pointer, not just
    the display state)."""
    fake, tx = stub
    _run(tx.unlink_bank_match(cid="cid", bank_id="bank-A",
                                user={"email": "x"}))
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        _run(tx.confirm_bank_match(cid="cid", bank_id="bank-A",
                                     user={"email": "x"}))
    assert ei.value.status_code == 404
