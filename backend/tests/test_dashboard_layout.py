"""Dashboard layout — per-user drag/pin/hide persistence (Feb 2026, Phase D-2)."""
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
    await db.users.insert_one({"id": uid, "email": f"l_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "Layout Tester"})
    await db.companies.insert_one({"id": cid, "name": "Layout Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    await db.dashboard_layouts.delete_many({"user_id": uid})
    await db.memberships.delete_many({"user_id": uid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_dashboard_layout_roundtrip():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # First visit → empty scaffold.
                r = await ac.get(f"/api/companies/{cid}/dashboard-layout",
                                  headers=_h(token))
                assert r.status_code == 200
                assert r.json()["widgets"] == []

                # PATCH sets a layout.
                r = await ac.patch(
                    f"/api/companies/{cid}/dashboard-layout",
                    headers=_h(token),
                    json={"widgets": [
                        {"id": "kpi.pipeline", "pinned": True},
                        {"id": "module.finance"},
                        {"id": "kpi.revenue_mtd", "hidden": True},
                    ]})
                assert r.status_code == 200
                data = r.json()
                assert data["ok"] is True
                assert [w["id"] for w in data["widgets"]] == [
                    "kpi.pipeline", "module.finance", "kpi.revenue_mtd"]
                assert data["widgets"][0]["pinned"] is True
                assert data["widgets"][2]["hidden"] is True

                # GET returns the persisted layout.
                r = await ac.get(f"/api/companies/{cid}/dashboard-layout",
                                  headers=_h(token))
                assert [w["id"] for w in r.json()["widgets"]] == [
                    "kpi.pipeline", "module.finance", "kpi.revenue_mtd"]

                # Duplicates in the payload get collapsed to first hit.
                r = await ac.patch(
                    f"/api/companies/{cid}/dashboard-layout",
                    headers=_h(token),
                    json={"widgets": [
                        {"id": "a"}, {"id": "b"}, {"id": "a", "pinned": True},
                    ]})
                assert [w["id"] for w in r.json()["widgets"]] == ["a", "b"]
                # The FIRST occurrence's flags win — so 'a' stays unpinned.
                assert r.json()["widgets"][0]["pinned"] is False

                # Garbage widgets (missing id, wrong type) are dropped.
                r = await ac.patch(
                    f"/api/companies/{cid}/dashboard-layout",
                    headers=_h(token),
                    json={"widgets": [
                        {"id": "valid"}, {"pinned": True}, "not a dict",
                        {"id": 123}, {"id": ""},
                    ]})
                assert [w["id"] for w in r.json()["widgets"]] == ["valid"]

                # Non-list widgets → 400.
                r = await ac.patch(
                    f"/api/companies/{cid}/dashboard-layout",
                    headers=_h(token), json={"widgets": "nope"})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_dashboard_layout_is_per_user():
    """User A's layout shouldn't leak into user B's response."""
    async def _t():
        a_uid, a_tok, cid = await _mk_env()
        b_uid = str(uuid.uuid4())
        await db.users.insert_one({"id": b_uid, "email": f"b_{b_uid[:6]}@e.com",
                                     "password": hash_password("x"), "role": "client",
                                     "name": "B"})
        await db.memberships.insert_one({"company_id": cid, "user_id": b_uid,
                                            "role": "member"})
        b_tok = create_token(b_uid, "client")
        try:
            async with await _client() as ac:
                await ac.patch(f"/api/companies/{cid}/dashboard-layout",
                                headers=_h(a_tok),
                                json={"widgets": [{"id": "kpi.pipeline",
                                                    "pinned": True}]})
                r = await ac.get(f"/api/companies/{cid}/dashboard-layout",
                                  headers=_h(b_tok))
                assert r.json()["widgets"] == []
        finally:
            await db.users.delete_one({"id": b_uid})
            await _cleanup(a_uid, cid)
    _run(_t())
