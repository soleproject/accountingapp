"""Phase 4 regression — QBO Mirror Purchase push body + drift
normalizer. Purchases (cash/check/credit-card spending) live in the
shared `db.transactions` collection with `txn_type: "Purchase"`."""
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
    def __init__(self, contacts, accounts, items=None):
        self.contacts = _Coll(contacts)
        self.accounts = _Coll(accounts)
        self.items = _Coll(items or [])

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        contacts=[
            {"id": "vend-1", "company_id": "cid", "qbo_id": "88",
              "name": "SupplyCo", "display_name": "SupplyCo"},
        ],
        accounts=[
            {"id": "bank-1", "company_id": "cid", "qbo_id": "35",
              "name": "Checking", "source": "qbo", "type": "asset"},
            {"id": "exp-1", "company_id": "cid", "qbo_id": "42",
              "name": "Office Supplies", "source": "qbo",
              "type": "expense"},
        ],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_purchase_happy(stub_db):
    from qbo_mirror.push import _purchase_body
    txn = {
        "id": "t1", "bank_account_id": "bank-1",
        "contact_id": "vend-1", "payment_type": "CreditCard",
        "date": "2026-08-10", "number": "P-100",
        "memo": "monthly office run",
        "line_items": [{"expense_account_id": "exp-1",
                          "description": "Paper", "amount": 42.5}],
    }
    body = _run(_purchase_body("cid", txn))
    assert body["AccountRef"]["value"] == "35"
    assert body["PaymentType"] == "CreditCard"
    assert body["EntityRef"]["value"] == "88"
    assert body["EntityRef"]["type"] == "Vendor"
    assert body["TxnDate"] == "2026-08-10"
    assert body["DocNumber"] == "P-100"
    assert body["Line"][0]["Amount"] == 42.5
    assert body["Line"][0][
        "AccountBasedExpenseLineDetail"]["AccountRef"]["value"] == "42"
    assert "Credit" not in body  # default direction = out


def test_purchase_credit_refund(stub_db):
    """`direction='in'` (or `credit=True`) means a vendor refund —
    QBO exposes this via `Credit: True` on the Purchase doc."""
    from qbo_mirror.push import _purchase_body
    txn = {
        "bank_account_id": "bank-1", "direction": "in",
        "line_items": [{"expense_account_id": "exp-1", "amount": 20}],
    }
    body = _run(_purchase_body("cid", txn))
    assert body["Credit"] is True


def test_purchase_payment_type_defaults_to_cash(stub_db):
    from qbo_mirror.push import _purchase_body
    txn = {
        "bank_account_id": "bank-1",
        "line_items": [{"expense_account_id": "exp-1", "amount": 5}],
    }
    body = _run(_purchase_body("cid", txn))
    assert body["PaymentType"] == "Cash"


def test_purchase_missing_source_account(stub_db):
    from qbo_mirror.push import _purchase_body
    with pytest.raises(ValueError, match="Source account"):
        _run(_purchase_body("cid",
                             {"bank_account_id": None,
                              "line_items": [{"expense_account_id": "exp-1",
                                                "amount": 10}]}))


def test_purchase_absolute_amount(stub_db):
    """Local `amount` may be negative (sign convention for outflows).
    The QBO Line Amount must always be positive."""
    from qbo_mirror.push import _purchase_body
    txn = {
        "bank_account_id": "bank-1",
        "line_items": [{"expense_account_id": "exp-1", "amount": -100}],
    }
    body = _run(_purchase_body("cid", txn))
    assert body["Line"][0]["Amount"] == 100.0


def test_purchase_twin_patch():
    from qbo_mirror.push import _local_patch_from_qbo_purchase
    p = _local_patch_from_qbo_purchase(
        {"Id": "9", "TotalAmt": 100, "TxnDate": "2026-01-01",
          "DocNumber": "P-1", "PaymentType": "CreditCard"})
    assert p["amount"] == -100.0  # outflow → negative
    assert p["direction"] == "out"
    assert p["date"] == "2026-01-01"
    assert p["payment_type"] == "CreditCard"

    # Credit=True means vendor refund → positive, direction=in.
    r = _local_patch_from_qbo_purchase(
        {"Id": "10", "TotalAmt": 50, "TxnDate": "2026-01-02",
          "Credit": True})
    assert r["amount"] == 50.0
    assert r["direction"] == "in"


def test_purchase_drift_normalizer_symmetry():
    """Local `amount` is signed; QBO `TotalAmt` is absolute. The
    normalizer must strip the sign so drift-detection compares like
    with like. Also verifies the same fake-number synthesis both
    sides use when DocNumber is empty."""
    from qbo_mirror.engine import (
        _norm_purchase_local, _norm_purchase_qbo,
    )
    local = _norm_purchase_local({
        "qbo_id": "173", "number": "",
        "date": "2026-08-10", "amount": -42.50,
    })
    qbo = _norm_purchase_qbo({
        "Id": "173", "DocNumber": "",
        "TxnDate": "2026-08-10", "TotalAmt": 42.50,
    })
    assert local["number"] == qbo["number"] == "Purchase-173"
    assert local["total"] == qbo["total"] == 42.5
    assert local["natural_key"] == qbo["natural_key"]
