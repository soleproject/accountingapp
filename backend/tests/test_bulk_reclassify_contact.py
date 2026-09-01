"""Regression — bulk-reclassify now accepts an optional `contact_id` to
retag transactions in the same call that changes their category account.

The route is defined in `routes/transactions.py` and hits three collections
(accounts, contacts, transactions) plus the dashboard-invalidator + rule
candidate machinery. To keep the test hermetic we stub `require_company`,
`is_period_closed`, `_invalidate_dash`, and `log_ai` on the route module,
then hit real MongoDB via the shared motor loop.

Locks in:
  - Both category AND contact fields land on every editable row when
    `contact_id` is supplied.
  - Category-only calls still work (no contact_id → no contact_id/name
    mutation, existing values preserved).
  - Unknown contact ids raise 404 without mutating any transaction.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402


async def _seed(cid: str, *, contact_name="Original Vendor"):
    """Seed 2 txns with a category + contact so we can assert bulk change."""
    src_acct = {
        "id": str(uuid.uuid4()), "company_id": cid, "code": "6000",
        "name": "Uncategorized Expense", "type": "expense",
    }
    dst_acct = {
        "id": str(uuid.uuid4()), "company_id": cid, "code": "6100",
        "name": "Office Supplies", "type": "expense",
    }
    await db.accounts.insert_many([src_acct, dst_acct])

    old_contact = {
        "id": str(uuid.uuid4()), "company_id": cid, "name": contact_name,
        "normalized_name": contact_name.lower().strip(),
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    new_contact = {
        "id": str(uuid.uuid4()), "company_id": cid, "name": "Staples",
        "normalized_name": "staples",
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.contacts.insert_many([old_contact, new_contact])

    txns = []
    for _ in range(2):
        txns.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "amount": -50.0, "date": "2026-02-15",
            "category_account_id": src_acct["id"],
            "category_account_code": src_acct["code"],
            "category_account_name": src_acct["name"],
            "contact_id": old_contact["id"],
            "contact_name": old_contact["name"],
            "posted": False, "needs_review": True, "human_reviewed": False,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    await db.transactions.insert_many(txns)
    return {
        "src_acct_id": src_acct["id"], "dst_acct_id": dst_acct["id"],
        "old_contact_id": old_contact["id"],
        "new_contact_id": new_contact["id"],
        "txn_ids": [t["id"] for t in txns],
    }


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.rule_candidates.delete_many({"company_id": cid})


def _install_stubs(monkeypatch):
    """Neutralise auth + closed-period + dashboard side effects."""
    import routes.transactions as tx_mod

    async def _noop_require_company(user, cid): return None
    async def _open(cid, date): return False
    async def _noop_invalidate(cid): return None
    async def _noop_log(cid, kind, count): return None

    monkeypatch.setattr(tx_mod, "require_company", _noop_require_company)
    monkeypatch.setattr(tx_mod, "is_period_closed", _open)
    monkeypatch.setattr(tx_mod, "_invalidate_dash", _noop_invalidate)
    monkeypatch.setattr(tx_mod, "log_ai", _noop_log)


def test_bulk_reclassify_updates_contact_when_provided(monkeypatch):
    from routes.transactions import bulk_reclassify

    _install_stubs(monkeypatch)

    async def go():
        cid = f"brc-{uuid.uuid4().hex[:8]}"
        try:
            seed = await _seed(cid)
            res = await bulk_reclassify(cid, {
                "transaction_ids": seed["txn_ids"],
                "category_account_id": seed["dst_acct_id"],
                "contact_id": seed["new_contact_id"],
            }, user={"id": "test", "email": "t@t", "role": "pro"})

            assert res["ok"] is True
            assert res["updated"] == 2
            assert res["contact_applied"] == "Staples"

            rows = await db.transactions.find(
                {"id": {"$in": seed["txn_ids"]}, "company_id": cid}
            ).to_list(10)
            assert len(rows) == 2
            for r in rows:
                assert r["category_account_code"] == "6100"
                assert r["contact_id"] == seed["new_contact_id"]
                assert r["contact_name"] == "Staples"
                assert r["human_reviewed"] is True
                assert r["needs_review"] is False
        finally:
            await _cleanup(cid)
    run(go())


def test_bulk_reclassify_no_contact_keeps_existing(monkeypatch):
    from routes.transactions import bulk_reclassify

    _install_stubs(monkeypatch)

    async def go():
        cid = f"brc-{uuid.uuid4().hex[:8]}"
        try:
            seed = await _seed(cid, contact_name="KeepMe Vendor")
            res = await bulk_reclassify(cid, {
                "transaction_ids": seed["txn_ids"],
                "category_account_id": seed["dst_acct_id"],
                # contact_id intentionally omitted
            }, user={"id": "test", "email": "t@t", "role": "pro"})

            assert res["updated"] == 2
            assert res["contact_applied"] is None

            rows = await db.transactions.find(
                {"id": {"$in": seed["txn_ids"]}, "company_id": cid}
            ).to_list(10)
            for r in rows:
                # Category flipped …
                assert r["category_account_code"] == "6100"
                # … but the pre-existing contact stayed put.
                assert r["contact_id"] == seed["old_contact_id"]
                assert r["contact_name"] == "KeepMe Vendor"
        finally:
            await _cleanup(cid)
    run(go())


def test_bulk_reclassify_unknown_contact_404(monkeypatch):
    from fastapi import HTTPException
    from routes.transactions import bulk_reclassify

    _install_stubs(monkeypatch)

    async def go():
        cid = f"brc-{uuid.uuid4().hex[:8]}"
        try:
            seed = await _seed(cid)
            with pytest.raises(HTTPException) as ei:
                await bulk_reclassify(cid, {
                    "transaction_ids": seed["txn_ids"],
                    "category_account_id": seed["dst_acct_id"],
                    "contact_id": "does-not-exist",
                }, user={"id": "test", "email": "t@t", "role": "pro"})
            assert ei.value.status_code == 404

            # Assert no mutation happened on the transactions.
            rows = await db.transactions.find(
                {"id": {"$in": seed["txn_ids"]}, "company_id": cid}
            ).to_list(10)
            for r in rows:
                assert r["category_account_code"] == "6000"  # unchanged
                assert r["contact_id"] == seed["old_contact_id"]
        finally:
            await _cleanup(cid)
    run(go())
