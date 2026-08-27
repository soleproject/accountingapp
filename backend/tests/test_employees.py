"""Employees CRUD + role-defaults + permissions (Feb 2026, Phase B-1)."""
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
        "id": uid, "email": f"emp_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Team Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for coll in ("employees", "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_employees_crud_and_permissions():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Create
                r = await ac.post(f"/api/companies/{cid}/employees",
                    headers=_h(token),
                    json={"name": "Sarah K.", "email": "sarah@example.com",
                          "role": "field_employee", "hourly_cost_rate": 45.0,
                          "title": "Foreman"})
                assert r.status_code == 200
                eid = r.json()["employee"]["id"]
                assert r.json()["employee"]["email"] == "sarah@example.com"

                # Missing name → 400
                r = await ac.post(f"/api/companies/{cid}/employees",
                    headers=_h(token), json={"name": ""})
                assert r.status_code == 400

                # Duplicate email → 409
                r = await ac.post(f"/api/companies/{cid}/employees",
                    headers=_h(token),
                    json={"name": "Sarah K II", "email": "SARAH@example.com"})
                assert r.status_code == 409

                # Invalid role → 400
                r = await ac.post(f"/api/companies/{cid}/employees",
                    headers=_h(token),
                    json={"name": "Bad", "role": "ceo"})
                assert r.status_code == 400

                # List
                r = await ac.get(f"/api/companies/{cid}/employees",
                    headers=_h(token))
                assert r.json()["count"] == 1

                # Effective permissions — role defaults for field_employee
                r = await ac.get(
                    f"/api/companies/{cid}/employees/{eid}/permissions",
                    headers=_h(token))
                p = r.json()
                assert p["role"] == "field_employee"
                assert p["role_defaults"]["accounting"] is False
                assert p["role_defaults"]["team"] is True
                assert p["effective"]["accounting"] is False

                # Override: grant accounting access
                r = await ac.patch(
                    f"/api/companies/{cid}/employees/{eid}",
                    headers=_h(token),
                    json={"permission_overrides": {"accounting": True}})
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/employees/{eid}/permissions",
                    headers=_h(token))
                p = r.json()
                assert p["overrides"]["accounting"] is True
                assert p["effective"]["accounting"] is True
                # Role default still says false — overrides win.
                assert p["role_defaults"]["accounting"] is False

                # Role change refreshes defaults
                r = await ac.patch(
                    f"/api/companies/{cid}/employees/{eid}",
                    headers=_h(token), json={"role": "manager"})
                assert r.json()["employee"]["role"] == "manager"
                r = await ac.get(
                    f"/api/companies/{cid}/employees/{eid}/permissions",
                    headers=_h(token))
                assert r.json()["role_defaults"]["accounting"] is True

                # Soft-delete
                r = await ac.delete(
                    f"/api/companies/{cid}/employees/{eid}", headers=_h(token))
                assert r.json()["archived"] is True
                r = await ac.get(f"/api/companies/{cid}/employees",
                    headers=_h(token))
                assert r.json()["count"] == 0
                r = await ac.get(
                    f"/api/companies/{cid}/employees?include_inactive=true",
                    headers=_h(token))
                assert r.json()["count"] == 1
        finally:
            await _cleanup(uid, cid)
    _run(_t())
