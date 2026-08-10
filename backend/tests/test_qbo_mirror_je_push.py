"""Phase 2f regression — QBO Mirror journal-entry push body builder.

Verifies:
  - Happy path: debit + credit lines resolve to proper
    JournalEntryLineDetail with PostingType and AccountRef.
  - Both-debit-and-credit-on-same-line rejects.
  - Unbalanced JE (debits != credits) rejects.
  - Unmapped account rejects.
  - Empty JE rejects.
  - DocNumber caps at 21 chars.
  - Twin patch stamps date + number + memo.
"""
from __future__ import annotations
import asyncio
import sys
import pytest

sys.path.insert(0, "/app/backend")

import db as _db_mod  # noqa: E402


class _Coll:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    async def find_one(self, q: dict, proj=None, sort=None):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items()
                   if not isinstance(v, dict)):
                return r
        return None


class _FakeDB:
    def __init__(self, accounts):
        self.accounts = _Coll(accounts)
        self.contacts = _Coll([])
        self.items = _Coll([])
        self.invoices = _Coll([])
        self.bills = _Coll([])

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        accounts=[
            {"id": "cash-1", "company_id": "cid", "qbo_id": "35",
              "name": "Checking", "source": "qbo", "type": "bank"},
            {"id": "rent-1", "company_id": "cid", "qbo_id": "77",
              "name": "Rent Expense", "source": "qbo",
              "type": "expense"},
        ],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_happy_path(stub_db):
    from qbo_mirror.push import _journal_entry_body
    je = {
        "id": "je-1", "company_id": "cid",
        "date": "2026-08-10", "number": "JE-42",
        "memo": "Rent expense recognition",
        "lines": [
            {"account_id": "rent-1", "debit": 3000, "credit": 0,
              "description": "August rent"},
            {"account_id": "cash-1", "debit": 0, "credit": 3000,
              "description": "August rent"},
        ],
    }
    body = _run(_journal_entry_body("cid", je))
    # Two lines, matching PostingType and Amount
    assert len(body["Line"]) == 2
    assert body["Line"][0]["JournalEntryLineDetail"]["PostingType"] == "Debit"
    assert body["Line"][0]["JournalEntryLineDetail"]["AccountRef"]["value"] == "77"
    assert body["Line"][0]["Amount"] == 3000.0
    assert body["Line"][1]["JournalEntryLineDetail"]["PostingType"] == "Credit"
    assert body["Line"][1]["JournalEntryLineDetail"]["AccountRef"]["value"] == "35"
    assert body["TxnDate"] == "2026-08-10"
    assert body["DocNumber"] == "JE-42"
    assert body["PrivateNote"] == "Rent expense recognition"


def test_debit_and_credit_on_same_line_rejects(stub_db):
    from qbo_mirror.push import _journal_entry_body
    je = {"lines": [{"account_id": "rent-1", "debit": 10, "credit": 10}]}
    with pytest.raises(ValueError, match="one or the other"):
        _run(_journal_entry_body("cid", je))


def test_unbalanced_rejects(stub_db):
    from qbo_mirror.push import _journal_entry_body
    je = {"lines": [
        {"account_id": "rent-1", "debit": 100, "credit": 0},
        {"account_id": "cash-1", "debit": 0, "credit": 50},
    ]}
    with pytest.raises(ValueError, match="unbalanced"):
        _run(_journal_entry_body("cid", je))


def test_unmapped_account_rejects(stub_db):
    from qbo_mirror.push import _journal_entry_body
    je = {"lines": [
        {"account_id": "does-not-exist", "debit": 10, "credit": 0},
        {"account_id": "cash-1", "debit": 0, "credit": 10},
    ]}
    with pytest.raises(ValueError, match="account not synced"):
        _run(_journal_entry_body("cid", je))


def test_empty_je_rejects(stub_db):
    from qbo_mirror.push import _journal_entry_body
    with pytest.raises(ValueError, match="no lines"):
        _run(_journal_entry_body("cid", {"lines": []}))


def test_doc_number_truncation(stub_db):
    from qbo_mirror.push import _journal_entry_body
    je = {"number": "X" * 50, "lines": [
        {"account_id": "rent-1", "debit": 10, "credit": 0},
        {"account_id": "cash-1", "debit": 0, "credit": 10},
    ]}
    body = _run(_journal_entry_body("cid", je))
    assert len(body["DocNumber"]) == 21


def test_twin_patch_shape():
    from qbo_mirror.push import _local_patch_from_qbo_je
    twin = {"Id": "99", "TxnDate": "2026-08-10", "DocNumber": "JE-42",
             "PrivateNote": "test"}
    p = _local_patch_from_qbo_je(twin)
    assert p["date"] == "2026-08-10"
    assert p["number"] == "JE-42"
    assert p["memo"] == "test"


def test_account_name_fallback(stub_db):
    """When account_id is missing but account_name matches a local
    account name, resolution still succeeds. This handles legacy
    JE imports where lines carry only a name."""
    from qbo_mirror.push import _journal_entry_body
    je = {"lines": [
        {"account_name": "Rent Expense", "debit": 10, "credit": 0},
        {"account_name": "Checking",     "debit": 0,  "credit": 10},
    ]}
    body = _run(_journal_entry_body("cid", je))
    assert body["Line"][0]["JournalEntryLineDetail"]["AccountRef"]["value"] == "77"
    assert body["Line"][1]["JournalEntryLineDetail"]["AccountRef"]["value"] == "35"
