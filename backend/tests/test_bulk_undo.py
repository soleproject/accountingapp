"""Regression — bulk-action Undo (bulk_undo.py + /bulk-actions/*).

Covers the March 2026 recovery path built after a superadmin
accidentally bulk-set the wrong contact on 25 live rows:

  1. bulk-set-contact now snapshots the pre-image and returns
     `undo_token`.
  2. bulk-reclassify does the same.
  3. `POST /bulk-actions/{undo_id}/undo` restores every row to the
     snapshot's pre-image and marks the snapshot consumed.
  4. Consumed snapshots refuse a second undo.

Uses the same `_shared_loop` pattern + auth stubs as
`test_bulk_reclassify_contact.py`.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402


async def _seed(cid: str):
    src = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6000",
           "name": "Uncat Exp", "type": "expense"}
    dst = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6100",
           "name": "Office", "type": "expense"}
    await db.accounts.insert_many([src, dst])

    old_c = {"id": str(uuid.uuid4()), "company_id": cid, "name": "OldVendor",
             "normalized_name": "oldvendor",
             "created_at": now_iso(), "updated_at": now_iso()}
    new_c = {"id": str(uuid.uuid4()), "company_id": cid, "name": "NewVendor",
             "normalized_name": "newvendor",
             "created_at": now_iso(), "updated_at": now_iso()}
    await db.contacts.insert_many([old_c, new_c])

    rows = []
    for _ in range(3):
        rows.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "amount": -10.0, "date": "2026-02-15",
            "category_account_id": src["id"],
            "category_account_code": src["code"],
            "category_account_name": src["name"],
            "contact_id": old_c["id"],
            "contact_name": old_c["name"],
            "posted": False, "needs_review": True, "human_reviewed": False,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    await db.transactions.insert_many(rows)
    return {
        "src": src, "dst": dst, "old_c": old_c, "new_c": new_c,
        "ids": [r["id"] for r in rows],
    }


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.rule_candidates.delete_many({"company_id": cid})
    await db.bulk_action_snapshots.delete_many({"company_id": cid})


def _install_stubs(monkeypatch):
    import routes.transactions as tx_mod

    async def _noop_require_company(user, cid): return None
    async def _open(cid, date): return False
    async def _noop_invalidate(cid): return None
    async def _noop_log(cid, kind, count): return None

    monkeypatch.setattr(tx_mod, "require_company", _noop_require_company)
    monkeypatch.setattr(tx_mod, "is_period_closed", _open)
    monkeypatch.setattr(tx_mod, "_invalidate_dash", _noop_invalidate)
    monkeypatch.setattr(tx_mod, "log_ai", _noop_log)


def test_bulk_set_contact_snapshots_and_undoes(monkeypatch):
    from routes.transactions import bulk_set_contact, undo_bulk_action
    _install_stubs(monkeypatch)

    async def go():
        cid = f"undo-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            # Fire the "accidental" bulk change → OldVendor → NewVendor.
            res = await bulk_set_contact(cid, {
                "transaction_ids": s["ids"],
                "contact_id": s["new_c"]["id"],
            }, user={"id": "u1", "email": "u1@t", "role": "pro"})

            assert res["updated"] == 3
            token = res["undo_token"]
            assert token, "undo_token missing"

            # Sanity — mutation actually landed.
            after = await db.transactions.find(
                {"id": {"$in": s["ids"]}, "company_id": cid}
            ).to_list(10)
            assert all(t["contact_id"] == s["new_c"]["id"] for t in after)

            # Undo.
            un = await undo_bulk_action(cid, token,
                user={"id": "u2", "email": "u2@t", "role": "pro"})
            assert un["ok"] is True
            assert un["restored"] == 3

            restored = await db.transactions.find(
                {"id": {"$in": s["ids"]}, "company_id": cid}
            ).to_list(10)
            for t in restored:
                assert t["contact_id"] == s["old_c"]["id"]
                assert t["contact_name"] == "OldVendor"

            # Second undo → 400 (already consumed).
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as ei:
                await undo_bulk_action(cid, token,
                    user={"id": "u2", "email": "u2@t", "role": "pro"})
            assert ei.value.status_code == 400
        finally:
            await _cleanup(cid)
    run(go())


def test_bulk_reclassify_snapshots_and_undoes(monkeypatch):
    from routes.transactions import bulk_reclassify, undo_bulk_action
    _install_stubs(monkeypatch)

    async def go():
        cid = f"undo-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            res = await bulk_reclassify(cid, {
                "transaction_ids": s["ids"],
                "category_account_id": s["dst"]["id"],
                "contact_id": s["new_c"]["id"],
            }, user={"id": "u1", "email": "u1@t", "role": "pro"})

            assert res["updated"] == 3
            token = res["undo_token"]
            assert token

            un = await undo_bulk_action(cid, token,
                user={"id": "u2", "email": "u2@t", "role": "pro"})
            assert un["ok"] is True
            assert un["restored"] == 3

            rows = await db.transactions.find(
                {"id": {"$in": s["ids"]}, "company_id": cid}
            ).to_list(10)
            for t in rows:
                assert t["category_account_code"] == "6000"    # restored
                assert t["contact_id"] == s["old_c"]["id"]    # restored
                assert t["human_reviewed"] is False
        finally:
            await _cleanup(cid)
    run(go())
