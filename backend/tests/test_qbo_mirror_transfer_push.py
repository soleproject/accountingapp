"""Phase 4d regression — QBO Mirror Transfer push body builder,
drift normalizer, and twin patch. Transfers are bank-to-bank moves
with no line items — a single credit + single debit encoded via
FromAccountRef / ToAccountRef / Amount."""
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
            ok = True
            for k, v in q.items():
                if isinstance(v, dict):
                    if "$ne" in v and r.get(k) == v["$ne"]:
                        ok = False
                        break
                    if "$exists" in v:
                        if v["$exists"] and k not in r:
                            ok = False
                            break
                elif r.get(k) != v:
                    ok = False
                    break
            if ok:
                return r
        return None


class _FakeDB:
    def __init__(self, accounts):
        self.accounts = _Coll(accounts)
        self.contacts = _Coll([])
        self.items = _Coll([])

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        accounts=[
            {"id": "chk-1", "company_id": "cid", "qbo_id": "35",
              "name": "Business Checking", "source": "qbo",
              "type": "asset"},
            {"id": "sav-1", "company_id": "cid", "qbo_id": "36",
              "name": "Business Savings", "source": "qbo",
              "type": "asset"},
            {"id": "cash-1", "company_id": "cid",
              "name": "Petty Cash", "type": "asset"},  # no qbo_id
        ],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ─── Transfer push body ───────────────────────────────────────────

def test_transfer_happy(stub_db):
    from qbo_mirror.push import _transfer_body
    txn = {
        "id": "t1", "bank_account_id": "chk-1",
        "transfer_to_account_id": "sav-1",
        "amount": 2500.00, "date": "2026-02-15",
        "memo": "Monthly savings sweep",
    }
    body = _run(_transfer_body("cid", txn))
    assert body["FromAccountRef"]["value"] == "35"
    assert body["FromAccountRef"]["name"] == "Business Checking"
    assert body["ToAccountRef"]["value"] == "36"
    assert body["ToAccountRef"]["name"] == "Business Savings"
    assert body["Amount"] == 2500.00
    assert body["TxnDate"] == "2026-02-15"
    assert body["PrivateNote"] == "Monthly savings sweep"


def test_transfer_uses_absolute_amount(stub_db):
    """Transfers must always POST a positive Amount even if the
    local row stored the outflow leg as a negative number."""
    from qbo_mirror.push import _transfer_body
    body = _run(_transfer_body("cid", {
        "bank_account_id": "chk-1",
        "transfer_to_account_id": "sav-1",
        "amount": -1000.00,
    }))
    assert body["Amount"] == 1000.00


def test_transfer_requires_from_account(stub_db):
    from qbo_mirror.push import _transfer_body
    with pytest.raises(ValueError, match="Source"):
        _run(_transfer_body("cid", {
            "transfer_to_account_id": "sav-1", "amount": 100,
        }))


def test_transfer_requires_to_account(stub_db):
    from qbo_mirror.push import _transfer_body
    with pytest.raises(ValueError, match="Destination"):
        _run(_transfer_body("cid", {
            "bank_account_id": "chk-1", "amount": 100,
        }))


def test_transfer_requires_synced_accounts(stub_db):
    """Both accounts must have a qbo_id — a local-only 'Petty Cash'
    row can't be transferred to since QBO doesn't know it exists."""
    from qbo_mirror.push import _transfer_body
    with pytest.raises(ValueError, match="Destination"):
        _run(_transfer_body("cid", {
            "bank_account_id": "chk-1",
            "transfer_to_account_id": "cash-1",  # no qbo_id
            "amount": 100,
        }))


def test_transfer_requires_nonzero_amount(stub_db):
    from qbo_mirror.push import _transfer_body
    with pytest.raises(ValueError, match="non-zero"):
        _run(_transfer_body("cid", {
            "bank_account_id": "chk-1",
            "transfer_to_account_id": "sav-1",
            "amount": 0,
        }))


def test_transfer_memo_fallback_chain(stub_db):
    """PrivateNote should fall back memo → notes → description."""
    from qbo_mirror.push import _transfer_body
    body = _run(_transfer_body("cid", {
        "bank_account_id": "chk-1",
        "transfer_to_account_id": "sav-1",
        "amount": 50,
        "description": "Fallback text",
    }))
    assert body["PrivateNote"] == "Fallback text"


def test_transfer_omits_optional_fields_when_absent(stub_db):
    from qbo_mirror.push import _transfer_body
    body = _run(_transfer_body("cid", {
        "bank_account_id": "chk-1",
        "transfer_to_account_id": "sav-1",
        "amount": 50,
    }))
    assert "TxnDate" not in body
    assert "PrivateNote" not in body


# ─── Twin patch (QBO → local) ─────────────────────────────────────

def test_transfer_twin_patch():
    from qbo_mirror.push import _local_patch_from_qbo_transfer
    p = _local_patch_from_qbo_transfer({
        "Id": "77", "Amount": 2500.00, "TxnDate": "2026-02-15",
    })
    assert p["amount"] == 2500.00
    assert p["direction"] == "transfer"
    assert p["date"] == "2026-02-15"


def test_transfer_twin_patch_absolute_value():
    """QBO always returns positive Amount, but we double-guard."""
    from qbo_mirror.push import _local_patch_from_qbo_transfer
    p = _local_patch_from_qbo_transfer({
        "Id": "77", "Amount": -100.0,
    })
    assert p["amount"] == 100.0


def test_transfer_twin_patch_no_date():
    from qbo_mirror.push import _local_patch_from_qbo_transfer
    p = _local_patch_from_qbo_transfer({"Id": "77", "Amount": 10})
    assert "date" not in p
    assert p["direction"] == "transfer"


# ─── Autopush wiring ──────────────────────────────────────────────

def test_transfer_registered_in_autopush_entity_meta():
    """Guard rail — Transfer must be plumbed into the shared
    entity map so PATCH/DELETE cascades know where to look."""
    from qbo_mirror.autopush import _ENTITY_META
    assert "transfer" in _ENTITY_META
    path, key, coll, _ = _ENTITY_META["transfer"]
    assert path == "transfer"
    assert key == "Transfer"
    assert coll == "transactions"


def test_transfer_registered_in_push_dispatch():
    """Guard rail — run_push's entity dispatch must know transfer."""
    from qbo_mirror import push as _push_mod
    # `_push_transfers` is the private per-entity worker; existence
    # asserts the module-level function survived any refactor.
    assert hasattr(_push_mod, "_push_transfers")
