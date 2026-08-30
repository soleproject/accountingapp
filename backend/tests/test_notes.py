"""Notes CRUD (Feb 2026, Phase B-2)."""
from __future__ import annotations
import sys, uuid
sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4()); cid = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"n_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client"})
    await db.companies.insert_one({"id": cid, "name": "Notes Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for c in ("notes", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_notes_crud():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Missing body → 400
                r = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                    json={"body": "", "entity_type": "employee", "entity_id": "e1"})
                assert r.status_code == 400

                # Create
                r = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                    json={"body": "First note", "entity_type": "employee",
                          "entity_id": "e1"})
                assert r.status_code == 200
                nid = r.json()["note"]["id"]
                assert r.json()["note"]["pinned"] is False

                # Second, pinned
                r = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                    json={"body": "Pinned note", "entity_type": "employee",
                          "entity_id": "e1", "pinned": True})
                assert r.status_code == 200

                # Note on a different entity — invisible to e1 query
                await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                    json={"body": "Other", "entity_type": "project",
                          "entity_id": "p1"})

                # List for e1: 2 notes, pinned first
                r = await ac.get(
                    f"/api/companies/{cid}/notes?entity_type=employee&entity_id=e1",
                    headers=_h(token))
                assert r.json()["count"] == 2
                assert r.json()["notes"][0]["pinned"] is True

                # Missing filter → 422 (fastapi query missing)
                r = await ac.get(f"/api/companies/{cid}/notes", headers=_h(token))
                assert r.status_code == 422

                # Patch body
                r = await ac.patch(f"/api/companies/{cid}/notes/{nid}",
                    headers=_h(token), json={"body": "Edited"})
                assert r.json()["note"]["body"] == "Edited"

                # Toggle pin
                r = await ac.patch(f"/api/companies/{cid}/notes/{nid}",
                    headers=_h(token), json={"pinned": True})
                assert r.json()["note"]["pinned"] is True

                # Empty body via patch → 400
                r = await ac.patch(f"/api/companies/{cid}/notes/{nid}",
                    headers=_h(token), json={"body": ""})
                assert r.status_code == 400

                # Delete
                r = await ac.delete(f"/api/companies/{cid}/notes/{nid}",
                    headers=_h(token))
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/notes?entity_type=employee&entity_id=e1",
                    headers=_h(token))
                assert r.json()["count"] == 1
        finally:
            await _cleanup(uid, cid)
    _run(_t())
