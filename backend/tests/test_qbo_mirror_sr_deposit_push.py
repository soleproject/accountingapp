"""Phase 4b regression — QBO Mirror SalesReceipt + Deposit push
body builders + drift normalizers + manual-transaction qualifier
branching between Purchase / SalesReceipt / Deposit."""
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
                    # crude {"$ne": None} / {"$exists": True} support
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
              "name": "AutoPush Customer",
              "display_name": "AutoPush Customer"},
        ],
        accounts=[
            {"id": "bank-1", "company_id": "cid", "qbo_id": "35",
              "name": "Checking", "source": "qbo", "type": "asset"},
            {"id": "inc-1", "company_id": "cid", "qbo_id": "88",
              "name": "Consulting Revenue", "source": "qbo",
              "type": "revenue"},
        ],
        items=[
            {"id": "item-1", "company_id": "cid", "qbo_id": "44",
              "name": "Consulting Services",
              "income_account_id": "inc-1", "active": True},
        ],
    )
    import qbo_mirror.push as _push_mod
    monkeypatch.setattr(_push_mod, "db", fake)
    monkeypatch.setattr(_db_mod, "db", fake)
    return fake


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ─── SalesReceipt push body ───────────────────────────────────────

def test_sales_receipt_happy(stub_db):
    from qbo_mirror.push import _sales_receipt_body
    txn = {
        "id": "s1", "contact_id": "cust-1",
        "bank_account_id": "bank-1", "date": "2026-08-10",
        "number": "SR-100",
        "line_items": [{"category_account_id": "inc-1",
                          "description": "Aug retainer", "amount": 115000}],
    }
    body = _run(_sales_receipt_body("cid", txn))
    assert body["CustomerRef"]["value"] == "77"
    assert body["DepositToAccountRef"]["value"] == "35"
    assert body["Line"][0]["Amount"] == 115000.0
    # Item was resolved from income_account_id → item-1 (qbo_id 44).
    assert body["Line"][0][
        "SalesItemLineDetail"]["ItemRef"]["value"] == "44"
    assert body["TxnDate"] == "2026-08-10"
    assert body["DocNumber"] == "SR-100"


def test_sales_receipt_requires_customer(stub_db):
    from qbo_mirror.push import _sales_receipt_body
    with pytest.raises(ValueError, match="customer"):
        _run(_sales_receipt_body("cid",
                                   {"bank_account_id": "bank-1",
                                    "line_items": [{"amount": 10}]}))


def test_sales_receipt_requires_deposit_account(stub_db):
    from qbo_mirror.push import _sales_receipt_body
    with pytest.raises(ValueError, match="Deposit-to"):
        _run(_sales_receipt_body("cid",
                                   {"contact_id": "cust-1",
                                    "line_items": [{"amount": 10}]}))


def test_sales_receipt_twin_patch():
    from qbo_mirror.push import _local_patch_from_qbo_sales_receipt
    p = _local_patch_from_qbo_sales_receipt(
        {"Id": "9", "TotalAmt": 500, "TxnDate": "2026-01-01",
          "DocNumber": "SR-9"})
    assert p["amount"] == 500.0
    assert p["direction"] == "in"
    assert p["date"] == "2026-01-01"
    assert p["number"] == "SR-9"


# ─── Deposit push body ────────────────────────────────────────────

def test_deposit_happy(stub_db):
    from qbo_mirror.push import _deposit_body
    txn = {
        "id": "d1", "bank_account_id": "bank-1",
        "date": "2026-08-10",
        "line_items": [{"category_account_id": "inc-1",
                          "description": "Interest earned",
                          "amount": 42.75}],
    }
    body = _run(_deposit_body("cid", txn))
    assert body["DepositToAccountRef"]["value"] == "35"
    assert body["Line"][0]["Amount"] == 42.75
    assert body["Line"][0][
        "DepositLineDetail"]["AccountRef"]["value"] == "88"


def test_deposit_no_customer(stub_db):
    """Deposits don't require a customer — pure bank inflows."""
    from qbo_mirror.push import _deposit_body
    body = _run(_deposit_body("cid",
                                {"bank_account_id": "bank-1",
                                 "line_items": [{
                                     "category_account_id": "inc-1",
                                     "amount": 5}]}))
    assert "CustomerRef" not in body  # no such field on Deposit
    assert "Entity" not in body["Line"][0]["DepositLineDetail"]


def test_deposit_twin_patch():
    from qbo_mirror.push import _local_patch_from_qbo_deposit
    p = _local_patch_from_qbo_deposit(
        {"Id": "12", "TotalAmt": 100, "TxnDate": "2026-01-01"})
    assert p["amount"] == 100.0
    assert p["direction"] == "in"


# ─── Drift normalizers ────────────────────────────────────────────

def test_sales_receipt_drift_normalizer_symmetry():
    from qbo_mirror.engine import (
        _norm_sales_receipt_local, _norm_sales_receipt_qbo,
    )
    local = _norm_sales_receipt_local({
        "qbo_id": "9", "number": "", "date": "2026-08-10",
        "amount": 500.0,
    })
    qbo = _norm_sales_receipt_qbo({
        "Id": "9", "DocNumber": "", "TxnDate": "2026-08-10",
        "TotalAmt": 500.0,
    })
    # Both sides synthesize `SalesReceipt-{id}` to match what the
    # QBO importer stamps into `number` on imported rows.
    assert local["number"] == qbo["number"] == "SalesReceipt-9"
    assert local["natural_key"] == qbo["natural_key"]


def test_deposit_drift_normalizer_symmetry():
    from qbo_mirror.engine import (
        _norm_deposit_local, _norm_deposit_qbo,
    )
    local = _norm_deposit_local({
        "qbo_id": "12", "number": "", "date": "2026-08-10",
        "amount": 100.0,
    })
    qbo = _norm_deposit_qbo({
        "Id": "12", "DocNumber": "", "TxnDate": "2026-08-10",
        "TotalAmt": 100.0,
    })
    # Matches importer's `Deposit-{id}` synthesis.
    assert local["number"] == qbo["number"] == "Deposit-12"
    assert local["natural_key"] == qbo["natural_key"]


def test_new_entities_registered_in_drift_fields():
    """Guard against the same class of bug that hit Purchases."""
    from qbo_mirror.engine import _DRIFT_FIELDS
    assert "sales_receipts" in _DRIFT_FIELDS
    assert "deposits" in _DRIFT_FIELDS


# ─── Manual-transaction qualifier (branching) ─────────────────────

def _install_tx_stubs(monkeypatch):
    stamped: dict = {}
    pushed: list = []

    class _CollUpd:
        async def update_one(self, q, upd):
            stamped["query"] = q
            stamped["set"] = upd.get("$set") or {}

    class _FDB:
        transactions = _CollUpd()
        def __getitem__(self, k):
            return getattr(self, k)

    import db as _db_mod2
    monkeypatch.setattr(_db_mod2, "db", _FDB())

    import qbo_mirror.autopush as _ap
    def _try(cid, entity, tid):
        pushed.append((cid, entity, tid))
    monkeypatch.setattr(_ap, "try_auto_push", _try)

    from routes import transactions as _tx
    monkeypatch.setattr(_tx, "db", _FDB())
    return stamped, pushed, _tx


def _drive(coros):
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(coros)
        pending = asyncio.all_tasks(loop)
        if pending:
            loop.run_until_complete(asyncio.gather(*pending,
                                                    return_exceptions=True))
    finally:
        loop.close()


def test_qualifier_inflow_with_customer_stamps_sales_receipt(monkeypatch):
    stamped, pushed, _tx = _install_tx_stubs(monkeypatch)
    doc = {
        "id": "t1", "company_id": "cid",
        "amount": 115000.0,
        "bank_account_id": "bank-1",
        "contact_id": "cust-1",
        "category_account_id": "inc-1",
        "description": "Big customer receipt",
    }
    async def _r():
        _tx._maybe_autopush_purchase("cid", "t1", doc)
    _drive(_r())
    assert stamped["set"]["txn_type"] == "SalesReceipt"
    assert stamped["set"]["direction"] == "in"
    assert stamped["set"]["line_items"][0]["amount"] == 115000.0
    assert ("cid", "sales_receipt", "t1") in pushed


def test_qualifier_inflow_without_customer_stamps_deposit(monkeypatch):
    stamped, pushed, _tx = _install_tx_stubs(monkeypatch)
    doc = {
        "id": "t2", "company_id": "cid",
        "amount": 500.0,
        "bank_account_id": "bank-1",
        "contact_id": None,  # no customer → Deposit
        "category_account_id": "inc-1",
    }
    async def _r():
        _tx._maybe_autopush_purchase("cid", "t2", doc)
    _drive(_r())
    assert stamped["set"]["txn_type"] == "Deposit"
    assert stamped["set"]["direction"] == "in"
    assert ("cid", "deposit", "t2") in pushed


def test_qualifier_outflow_still_stamps_purchase(monkeypatch):
    """Regression — the refactor to unified qualifier must not break
    the original Purchase path."""
    stamped, pushed, _tx = _install_tx_stubs(monkeypatch)
    doc = {
        "id": "t3", "company_id": "cid",
        "amount": -100.0,
        "bank_account_id": "bank-1",
        "category_account_id": "exp-1",
    }
    async def _r():
        _tx._maybe_autopush_purchase("cid", "t3", doc)
    _drive(_r())
    assert stamped["set"]["txn_type"] == "Purchase"
    assert ("cid", "purchase", "t3") in pushed


def test_qualifier_deposit_needs_category(monkeypatch):
    """No customer + no category → cannot infer source account → skip."""
    stamped, pushed, _tx = _install_tx_stubs(monkeypatch)
    doc = {
        "id": "t4", "company_id": "cid",
        "amount": 50.0,
        "bank_account_id": "bank-1",
        "contact_id": None,
        "category_account_id": None,
        "splits": [],
    }
    async def _r():
        _tx._maybe_autopush_purchase("cid", "t4", doc)
    _drive(_r())
    assert not stamped
    assert not pushed


def test_derive_refresh_updates_line_items_on_amount_change(monkeypatch):
    """Regression — the bug the user reported: editing a mirrored
    transaction's `amount` used to leave `line_items[]` stale, so the
    QBO push replayed the OLD amount and the twin-patch response
    reverted the local field. `_derive_mirror_stamp` must recompute
    `line_items` from the current header on every call."""
    from routes.transactions import _derive_mirror_stamp
    # Existing doc had $115k stamped at create-time.
    doc_before = {
        "id": "t", "company_id": "cid",
        "amount": 115000.0,
        "bank_account_id": "bank-1",
        "contact_id": None,  # Deposit path
        "category_account_id": "inc-1",
        "line_items": [{"category_account_id": "inc-1", "amount": 115000.0}],
        "qbo_id": "999", "txn_type": "Deposit",
    }
    # User edits header amount → $200. `line_items` in the DB is stale.
    doc_after = {**doc_before, "amount": 200.0}
    entity, txn_type, refresh = _derive_mirror_stamp(doc_after)
    assert entity == "deposit"
    assert txn_type == "Deposit"
    assert refresh["line_items"][0]["amount"] == 200.0  # ← the fix
    # Sign inversion also flips the branch: $200 outflow → Purchase.
    doc_flipped = {**doc_after, "amount": -200.0}
    entity_out, _t, refresh_out = _derive_mirror_stamp(doc_flipped)
    assert entity_out == "purchase"
    assert refresh_out["line_items"][0]["expense_account_id"] == "inc-1"


def test_derive_flip_from_sales_receipt_to_deposit():
    """Regression — the stranded qbo_id bug. A SalesReceipt whose
    customer gets cleared should re-classify to Deposit. The PATCH
    branch then knows the txn_type flipped and must delete the old
    QBO SalesReceipt + push a fresh Deposit (see PATCH endpoint)."""
    from routes.transactions import _derive_mirror_stamp
    doc = {
        "amount": 100.0, "bank_account_id": "bank-1",
        "contact_id": None,  # customer cleared → no longer SalesReceipt
        "category_account_id": "inc-1",
        "qbo_id": "38", "txn_type": "SalesReceipt",
    }
    entity, txn_type, _refresh = _derive_mirror_stamp(doc)
    assert entity == "deposit"
    assert txn_type == "Deposit"
    # The PATCH branch (transactions.update_transaction) must see
    # old_type != new_type here and trigger delete-old + push-new
    # rather than silently flipping txn_type while keeping qbo_id.


def test_mirror_relevant_fields_gate():
    """Regression — the user's suspicion: approving/unapproving a
    transaction should NOT trigger any mirror push/pull. The PATCH
    endpoint gates the mirror block on `_MIRROR_RELEVANT_FIELDS`
    intersecting the incoming update. Local-only fields like
    `human_reviewed`, `tags`, `assigned_to`, `internal_notes` must
    not appear in the set."""
    from routes.transactions import _MIRROR_RELEVANT_FIELDS
    # Must-be-relevant (any of these changes → push):
    for k in ("amount", "date", "description", "contact_id",
              "bank_account_id", "category_account_id", "splits",
              "line_items", "payment_type", "number"):
        assert k in _MIRROR_RELEVANT_FIELDS, k
    # Must NOT trigger a push (local review state only):
    for k in ("human_reviewed", "needs_review", "posted", "tags",
              "assigned_to", "internal_notes", "reviewed_at",
              "approved_by"):
        assert k not in _MIRROR_RELEVANT_FIELDS, k
