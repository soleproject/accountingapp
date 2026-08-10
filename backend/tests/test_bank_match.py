"""Regression — silent bank-feed ↔ editor-authored matcher.

Verifies the strict pairing rules in `bank_match.auto_match_bank_feed`:
  - Same bank + absolute amount + date within ±3 days → PAIRED.
  - Different bank / amount / >3 days → NOT paired.
  - Sign mismatch (outflow bank vs inflow editor) → NOT paired.
  - Editor row already matched → skipped (idempotent).
  - Bank row from QBO (has `_sync_origin=qbo`) → we only scan Plaid rows.
  - Multiple bank rows in one batch each pair with their own editor row.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")


class _AsyncCursor:
    def __init__(self, rows):
        self.rows = rows
    def __aiter__(self):
        self._i = 0
        return self
    async def __anext__(self):
        if self._i >= len(self.rows):
            raise StopAsyncIteration
        r = self.rows[self._i]
        self._i += 1
        return r


class _TxnColl:
    def __init__(self, rows):
        self.rows = list(rows)
        self.updates = []

    def find(self, q):
        # Very tight matcher — enough for these focused tests. Supports
        # $in on `id` (used to fetch the freshly-inserted Plaid batch).
        def _ok(row):
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
                    if "$gte" in v and row.get(k, "") < v["$gte"]:
                        return False
                    if "$lte" in v and row.get(k, "") > v["$lte"]:
                        return False
                elif row.get(k) != v:
                    return False
            return True
        return _AsyncCursor([r for r in self.rows if _ok(r)])

    async def find_one(self, q):
        # Reuse `find` semantics but pull the first hit. Also handle
        # `$or` at the top level (used by the matcher for amount sign).
        or_clauses = q.pop("$or", None)
        for r in self.rows:
            ok = True
            for k, v in q.items():
                if isinstance(v, dict):
                    if "$in" in v and r.get(k) not in v["$in"]:
                        ok = False; break
                    if "$exists" in v:
                        want = v["$exists"]
                        has = k in r
                        if want != has:
                            ok = False; break
                    if "$ne" in v and r.get(k) == v["$ne"]:
                        ok = False; break
                    if "$gte" in v and r.get(k, "") < v["$gte"]:
                        ok = False; break
                    if "$lte" in v and r.get(k, "") > v["$lte"]:
                        ok = False; break
                elif r.get(k) != v:
                    ok = False; break
            if not ok:
                continue
            if or_clauses:
                if not any(all(r.get(kk) == vv for kk, vv in c.items())
                             for c in or_clauses):
                    continue
            return r
        return None

    async def update_one(self, q, upd):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items()):
                r.update(upd.get("$set", {}))
                self.updates.append((q, upd))
                return
                
class _FakeDB:
    def __init__(self, rows):
        self.transactions = _TxnColl(rows)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _setup(monkeypatch, rows):
    fake = _FakeDB(rows)
    import db as _db_mod
    monkeypatch.setattr(_db_mod, "db", fake)
    import bank_match as _bm
    monkeypatch.setattr(_bm, "db", fake)
    return fake, _bm


# ─── Happy paths ──────────────────────────────────────────────────

def test_matches_same_bank_amount_date(monkeypatch):
    rows = [
        # Bank-feed row (Plaid) — outflow, -125.
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -125.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        # Editor-authored Purchase — outflow, -125, same bank, +1 day.
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -125.00,
          "date": "2026-02-16", "txn_type": "Purchase"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats == {"matched": 1, "scanned": 1}
    # Both rows carry the pair pointer.
    bank_row = next(r for r in fake.transactions.rows if r["id"] == "bank-1")
    ed_row = next(r for r in fake.transactions.rows if r["id"] == "ed-1")
    assert bank_row["matched_bank_txn_id"] == "bank-1"
    assert bank_row["matched_editor_txn_id"] == "ed-1"
    assert ed_row["matched_bank_txn_id"] == "bank-1"
    assert ed_row["hidden_by_match"] is True


def test_matches_sales_receipt_inflow(monkeypatch):
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00,
          "date": "2026-02-15", "txn_type": "SalesReceipt"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats["matched"] == 1


# ─── Rejections ───────────────────────────────────────────────────

def test_different_bank_no_match(monkeypatch):
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-DIFFERENT", "amount": -100.00,
          "date": "2026-02-15", "txn_type": "Purchase"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats["matched"] == 0


def test_different_amount_no_match(monkeypatch):
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -99.99,  # off by a cent
          "date": "2026-02-15", "txn_type": "Purchase"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats["matched"] == 0


def test_too_far_apart_no_match(monkeypatch):
    """5 days apart — outside the ±3-day window."""
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-20", "txn_type": "Purchase"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats["matched"] == 0


def test_sign_mismatch_no_match(monkeypatch):
    """Bank outflow + Editor inflow (Sales Receipt) with the same abs
    amount → same absolute amount but opposite sign. Must not pair
    or we'd merge an unrelated Purchase and SalesReceipt just because
    the dollar amounts happen to coincide."""
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 100.00,
          "date": "2026-02-15", "txn_type": "SalesReceipt"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats["matched"] == 0


def test_editor_already_matched_skipped(monkeypatch):
    """If the editor row was already paired to an earlier bank txn,
    don't rob Peter to pay Paul."""
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "txn_type": "Purchase",
          "matched_bank_txn_id": "some-other-bank"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    assert stats["matched"] == 0


def test_bank_side_also_skips_when_prematched(monkeypatch):
    """If the bank row was already matched (e.g. re-run of the
    matcher), it's excluded from the outer scan."""
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1",
          "matched_bank_txn_id": "self"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "txn_type": "Purchase"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1"]))
    # Nothing scanned (already matched) → nothing to do.
    assert stats["matched"] == 0
    assert stats["scanned"] == 0


def test_empty_id_list_shortcircuits(monkeypatch):
    fake, bm = _setup(monkeypatch, [])
    stats = _run(bm.auto_match_bank_feed("cid", []))
    assert stats == {"matched": 0, "scanned": 0}


def test_batch_pairs_multiple(monkeypatch):
    """Two bank rows in one batch, each gets its own editor pair."""
    rows = [
        {"id": "bank-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "plaid_transaction_id": "P1"},
        {"id": "bank-2", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00,
          "date": "2026-02-16", "plaid_transaction_id": "P2"},
        {"id": "ed-1", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": -100.00,
          "date": "2026-02-15", "txn_type": "Purchase"},
        {"id": "ed-2", "company_id": "cid",
          "bank_account_id": "chk-1", "amount": 250.00,
          "date": "2026-02-16", "txn_type": "SalesReceipt"},
    ]
    fake, bm = _setup(monkeypatch, rows)
    stats = _run(bm.auto_match_bank_feed("cid", ["bank-1", "bank-2"]))
    assert stats == {"matched": 2, "scanned": 2}
