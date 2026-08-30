"""Phase create/update accepts notes, estimated_revenue, estimated_cost (Jan 2026)."""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    contact_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"pex_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "PhaseX Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "features": {"classes_enabled": False,
                     "projects_enabled": True,
                     "budgets_enabled": False},
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Cust", "type": "customer",
    })
    return uid, create_token(uid, "client"), cid, contact_id


async def _cleanup(uid: str, cid: str):
    for coll in ("projects", "project_phases", "contacts", "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_phase_create_persists_new_fields():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "P", "contact_id": contact_id})
                pid = r.json()["project"]["id"]

                r = await ac.post(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token),
                    json={"name": "Phase A",
                          "notes": "install pipes",
                          "estimated_revenue": 5000,
                          "estimated_cost": 3200,
                          "start_date": "2026-02-01",
                          "end_date": "2026-02-15"})
                assert r.status_code == 200, r.text
                ph = r.json()["phase"]
                assert ph["notes"] == "install pipes"
                assert ph["estimated_revenue"] == 5000.0
                assert ph["estimated_cost"] == 3200.0
                assert ph["start_date"] == "2026-02-01"
                assert ph["end_date"] == "2026-02-15"

                # GET verifies persistence
                r = await ac.get(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token))
                got = r.json()["phases"][0]
                assert got["notes"] == "install pipes"
                assert got["estimated_revenue"] == 5000.0
                assert got["estimated_cost"] == 3200.0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_phase_update_clears_estimate_fields_with_empty_string():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "P", "contact_id": contact_id})
                pid = r.json()["project"]["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token),
                    json={"name": "Phase B",
                          "estimated_revenue": 100,
                          "estimated_cost": 80})
                phid = r.json()["phase"]["id"]

                # Clear both via empty string
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}/phases/{phid}",
                    headers=_h(token),
                    json={"estimated_revenue": "", "estimated_cost": "",
                          "notes": "updated notes"})
                assert r.status_code == 200
                ph = r.json()["phase"]
                assert ph["estimated_revenue"] is None
                assert ph["estimated_cost"] is None
                assert ph["notes"] == "updated notes"

                # Clear via null
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}/phases/{phid}",
                    headers=_h(token),
                    json={"estimated_revenue": 999})
                assert r.json()["phase"]["estimated_revenue"] == 999.0
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}/phases/{phid}",
                    headers=_h(token),
                    json={"estimated_revenue": None})
                assert r.json()["phase"]["estimated_revenue"] is None
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_project_create_still_accepts_notes():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "PN", "contact_id": contact_id,
                          "notes": "big remodel",
                          "description": "big remodel",
                          "estimated_revenue": 12000,
                          "start_date": "2026-03-01",
                          "end_date": "2026-04-01"})
                assert r.status_code == 200, r.text
                proj = r.json()["project"]
                # Either notes or description should be preserved
                assert (proj.get("notes") == "big remodel"
                        or proj.get("description") == "big remodel")
        finally:
            await _cleanup(uid, cid)

    _run(_t())
