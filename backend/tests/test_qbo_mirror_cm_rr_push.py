"""Phase 4c regression — QBO Mirror CreditMemo + RefundReceipt push
body builders + drift normalizers + PATCH/DELETE propagation."""
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
                        ok = False; break
                    if "$exists" in v and v["$exists"] and k not in r:
                        ok = False; break
                elif r.get(k) != v:
                    ok = False; break
            if ok: return r
        return None


class _FakeDB:
    def __init__(self, contacts, accounts, items):
        self.contacts = _Coll(contacts)
        self.accounts = _Coll(accounts)
        self.items = _Coll(items)

    def __getitem__(self, k):
        return getattr(self, k)


@pytest.fixture
def stub_db(monkeypatch):
    fake = _FakeDB(
        contacts=[
            {"id": "cust-1", "company_id": "cid", "qbo_id": "77",
              "name": "Refund Customer", "display_name": "Refund Customer"},
        ],
        accounts=[
            {"id": "bank-1", "company_id": "cid", "qbo_id": "35",
              "name": "Checking", "source": "qbo", "type": "asset"},
            {"id": "inc-1", "company_id": "cid", "qbo_id": "88",
              "name": "Revenue", "source": "qbo", "type": "revenue"},
        ],
        items=[
            {"id": "item-1", "company_id": "cid", "qbo_id": "44",
              "name": "Consulting", "income_account_id": "inc-1",
              "active": True},
        ],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_credit_memo_happy(stub_db):
    from qbo_mirror.push import _credit_memo_body
    txn = {
        "id": "cm1", "contact_id": "cust-1", "date": "2026-08-10",
        "number": "CM-100",
        "line_items": [{"category_account_id": "inc-1",
                          "description": "Goodwill credit", "amount": 250}],
    }
    body = _run(_credit_memo_body("cid", txn))
    assert body["CustomerRef"]["value"] == "77"
    assert "DepositToAccountRef" not in body   # no cash side on CM
    assert body["Line"][0]["Amount"] == 250.0
    assert body["Line"][0]["SalesItemLineDetail"]["ItemRef"]["value"] == "44"
    assert body["DocNumber"] == "CM-100"


def test_credit_memo_requires_customer(stub_db):
    from qbo_mirror.push import _credit_memo_body
    with pytest.raises(ValueError, match="customer"):
        _run(_credit_memo_body("cid",
                                 {"line_items": [{"amount": 10}]}))


def test_credit_memo_twin_patch():
    from qbo_mirror.push import _local_patch_from_qbo_credit_memo
    p = _local_patch_from_qbo_credit_memo(
        {"Id": "7", "TotalAmt": 250, "TxnDate": "2026-01-01",
          "DocNumber": "CM-7"})
    assert p["amount"] == 250.0
    assert p["direction"] == "in"
    assert p["date"] == "2026-01-01"


def test_refund_receipt_happy(stub_db):
    from qbo_mirror.push import _refund_receipt_body
    txn = {
        "id": "rr1", "contact_id": "cust-1", "bank_account_id": "bank-1",
        "date": "2026-08-10", "number": "RR-100",
        "line_items": [{"category_account_id": "inc-1",
                          "description": "Product return", "amount": 500}],
    }
    body = _run(_refund_receipt_body("cid", txn))
    assert body["CustomerRef"]["value"] == "77"
    assert body["DepositToAccountRef"]["value"] == "35"
    assert body["Line"][0]["Amount"] == 500.0
    assert body["DocNumber"] == "RR-100"


def test_refund_receipt_requires_customer_and_bank(stub_db):
    from qbo_mirror.push import _refund_receipt_body
    with pytest.raises(ValueError, match="customer"):
        _run(_refund_receipt_body("cid",
                                    {"bank_account_id": "bank-1",
                                     "line_items": [{"amount": 10}]}))
    with pytest.raises(ValueError, match="Source account"):
        _run(_refund_receipt_body("cid",
                                    {"contact_id": "cust-1",
                                     "line_items": [{"amount": 10}]}))


def test_refund_receipt_twin_patch_is_signed_out():
    """RefundReceipt is a cash outflow to a customer → local `amount`
    must be NEGATIVE and `direction: "out"`."""
    from qbo_mirror.push import _local_patch_from_qbo_refund_receipt
    p = _local_patch_from_qbo_refund_receipt(
        {"Id": "9", "TotalAmt": 500, "TxnDate": "2026-01-01",
          "DocNumber": "RR-9"})
    assert p["amount"] == -500.0
    assert p["direction"] == "out"


def test_credit_memo_drift_normalizer_symmetry():
    from qbo_mirror.engine import (
        _norm_credit_memo_local, _norm_credit_memo_qbo,
    )
    local = _norm_credit_memo_local({
        "qbo_id": "7", "number": "", "date": "2026-08-10",
        "amount": 250.0,
    })
    qbo = _norm_credit_memo_qbo({
        "Id": "7", "DocNumber": "", "TxnDate": "2026-08-10",
        "TotalAmt": 250.0,
    })
    assert local["number"] == qbo["number"] == "CreditMemo-7"
    assert local["natural_key"] == qbo["natural_key"]


def test_refund_receipt_drift_normalizer_symmetry():
    from qbo_mirror.engine import (
        _norm_refund_receipt_local, _norm_refund_receipt_qbo,
    )
    local = _norm_refund_receipt_local({
        "qbo_id": "9", "number": "", "date": "2026-08-10",
        "amount": -500.0,  # local signed
    })
    qbo = _norm_refund_receipt_qbo({
        "Id": "9", "DocNumber": "", "TxnDate": "2026-08-10",
        "TotalAmt": 500.0,  # QBO absolute
    })
    assert local["number"] == qbo["number"] == "RefundReceipt-9"
    assert local["total"] == qbo["total"] == 500.0
    assert local["natural_key"] == qbo["natural_key"]


def test_new_entities_registered_everywhere():
    """Guard against forgetting to register the new entities in every
    place — the same class of bug that hit Purchases twice."""
    from qbo_mirror.engine import _DRIFT_FIELDS
    from qbo_mirror.autopush import _HANDLERS, _ENTITY_META, _ENTITY_TO_CFG_KEY
    for k in ("credit_memos", "refund_receipts"):
        assert k in _DRIFT_FIELDS, k
    for k in ("credit_memo", "refund_receipt"):
        assert k in _HANDLERS, k
        assert k in _ENTITY_META, k
        assert k in _ENTITY_TO_CFG_KEY, k
