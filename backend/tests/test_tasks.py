"""Tasks CRUD + filter regression (Feb 2026, Phase A-1)."""
from __future__ import annotations

import sys, uuid
sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4()); cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"tk_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Tasks Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid: str, cid: str):
    for coll in ("tasks", "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_task_crud_and_filters():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Create
                r = await ac.post(f"/api/companies/{cid}/tasks", headers=_h(token),
                                    json={"title": "Follow up on INV-2023",
                                          "due_date": "2020-01-01",  # overdue
                                          "priority": "high",
                                          "entity_type": "invoice",
                                          "entity_id": "inv-abc",
                                          "entity_label": "INV-2023"})
                assert r.status_code == 200
                tid = r.json()["task"]["id"]
                assert r.json()["task"]["created_by_user_id"] == uid
                assert r.json()["task"]["assignee_user_id"] == uid

                # Missing title → 400
                r = await ac.post(f"/api/companies/{cid}/tasks", headers=_h(token),
                                    json={"title": ""})
                assert r.status_code == 400

                # Invalid priority → 400
                r = await ac.post(f"/api/companies/{cid}/tasks", headers=_h(token),
                                    json={"title": "bad", "priority": "urgent"})
                assert r.status_code == 400

                # List: default = open filter
                r = await ac.get(f"/api/companies/{cid}/tasks", headers=_h(token))
                assert r.status_code == 200
                assert r.json()["count"] == 1

                # Filter: overdue
                r = await ac.get(f"/api/companies/{cid}/tasks?filter=overdue",
                                    headers=_h(token))
                assert r.json()["count"] == 1

                # Filter: mine
                r = await ac.get(f"/api/companies/{cid}/tasks?filter=mine",
                                    headers=_h(token))
                assert r.json()["count"] == 1

                # Filter: today (not overdue, so 0)
                r = await ac.get(f"/api/companies/{cid}/tasks?filter=today",
                                    headers=_h(token))
                assert r.json()["count"] == 0

                # Filter by entity
                r = await ac.get(
                    f"/api/companies/{cid}/tasks?entity_type=invoice&entity_id=inv-abc",
                    headers=_h(token))
                assert r.json()["count"] == 1

                # Toggle complete
                r = await ac.post(
                    f"/api/companies/{cid}/tasks/{tid}/complete", headers=_h(token))
                assert r.json()["task"]["status"] == "done"
                assert r.json()["task"]["completed_at"] is not None

                # After complete: default filter (open) → 0
                r = await ac.get(f"/api/companies/{cid}/tasks", headers=_h(token))
                assert r.json()["count"] == 0
                r = await ac.get(f"/api/companies/{cid}/tasks?filter=done",
                                    headers=_h(token))
                assert r.json()["count"] == 1

                # Toggle back
                r = await ac.post(
                    f"/api/companies/{cid}/tasks/{tid}/complete", headers=_h(token))
                assert r.json()["task"]["status"] == "open"
                assert r.json()["task"]["completed_at"] is None

                # PATCH title
                r = await ac.patch(
                    f"/api/companies/{cid}/tasks/{tid}", headers=_h(token),
                    json={"title": "Renamed follow-up"})
                assert r.json()["task"]["title"] == "Renamed follow-up"

                # PATCH priority to invalid → 400
                r = await ac.patch(
                    f"/api/companies/{cid}/tasks/{tid}", headers=_h(token),
                    json={"priority": "urgent"})
                assert r.status_code == 400

                # Delete
                r = await ac.delete(
                    f"/api/companies/{cid}/tasks/{tid}", headers=_h(token))
                assert r.status_code == 200
                r = await ac.get(f"/api/companies/{cid}/tasks?filter=all",
                                    headers=_h(token))
                assert r.json()["count"] == 0
        finally:
            await _cleanup(uid, cid)
    _run(_t())
