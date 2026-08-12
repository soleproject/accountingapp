"""Tests for Partner-scoped access to enterprise GET / PATCH.

Feb 2026 — extended the `/admin/enterprises/{eid}` endpoints so Partners
can view + edit their OWN enterprises (`ent.partner_id == user.id`).
Superadmins retain unrestricted access. Every other role is 403; a
Partner asking for another partner's enterprise gets 404 (deliberate
enumeration guard).
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_partner() -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"partner_{uid[:6]}@example.com",
        "name": "Partner", "password": hash_password("x"),
        "role": "partner",
    })
    return uid


async def _mk_pro() -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"pro_{uid[:6]}@example.com",
        "name": "Pro", "password": hash_password("x"),
        "role": "pro",
    })
    return uid


async def _mk_enterprise(partner_id: str | None = None) -> str:
    eid = str(uuid.uuid4())
    doc: dict = {
        "id": eid, "name": f"Ent-{eid[:6]}",
        "slug": f"ent-{uuid.uuid4().hex[:6]}",
        "owner_user_id": None,
        "free_user_allotment": 0,
        "default_product": "simple_start",
        "default_discount": False,
    }
    if partner_id:
        doc["partner_id"] = partner_id
    await db.enterprises.insert_one(doc)
    return eid


async def _wipe(uids, eids):
    for uid in uids:
        await db.users.delete_one({"id": uid})
    for eid in eids:
        await db.enterprises.delete_one({"id": eid})


def test_partner_can_get_their_own_enterprise():
    async def _t():
        pid = await _mk_partner()
        eid = await _mk_enterprise(partner_id=pid)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.get(f"/api/admin/enterprises/{eid}",
                                headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["enterprise"]["id"] == eid
        finally:
            await _wipe([pid], [eid])
    _run(_t())


def test_partner_cannot_get_other_partners_enterprise_returns_404():
    async def _t():
        p_a = await _mk_partner()
        p_b = await _mk_partner()
        # Enterprise belongs to Partner B; Partner A should get 404.
        eid = await _mk_enterprise(partner_id=p_b)
        try:
            tok = create_token(p_a, "partner")
            async with await _client() as c:
                r = await c.get(f"/api/admin/enterprises/{eid}",
                                headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 404, r.text
        finally:
            await _wipe([p_a, p_b], [eid])
    _run(_t())


def test_partner_can_patch_their_own_enterprise():
    async def _t():
        pid = await _mk_partner()
        eid = await _mk_enterprise(partner_id=pid)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/admin/enterprises/{eid}",
                    json={"name": "Renamed By Partner"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
            assert r.status_code == 200, r.text
            ent = await db.enterprises.find_one({"id": eid})
            assert ent["name"] == "Renamed By Partner"
        finally:
            await _wipe([pid], [eid])
    _run(_t())


def test_partner_cannot_patch_other_partners_enterprise():
    async def _t():
        p_a = await _mk_partner()
        p_b = await _mk_partner()
        eid = await _mk_enterprise(partner_id=p_b)
        original_name = (await db.enterprises.find_one({"id": eid}))["name"]
        try:
            tok = create_token(p_a, "partner")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/admin/enterprises/{eid}",
                    json={"name": "Malicious Rename"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
            assert r.status_code == 404
            # Confirm nothing changed.
            ent = await db.enterprises.find_one({"id": eid})
            assert ent["name"] == original_name
        finally:
            await _wipe([p_a, p_b], [eid])
    _run(_t())


def test_pro_still_cannot_get_or_patch_enterprises():
    """Role gate hasn't been widened for non-partner roles."""
    async def _t():
        pro_uid = await _mk_pro()
        eid = await _mk_enterprise(partner_id=None)
        try:
            tok = create_token(pro_uid, "pro")
            async with await _client() as c:
                r_get = await c.get(f"/api/admin/enterprises/{eid}",
                                    headers={"Authorization": f"Bearer {tok}"})
                r_patch = await c.patch(
                    f"/api/admin/enterprises/{eid}",
                    json={"name": "X"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
            assert r_get.status_code == 403, r_get.text
            assert r_patch.status_code == 403, r_patch.text
        finally:
            await _wipe([pro_uid], [eid])
    _run(_t())


def test_superadmin_can_still_access_any_enterprise():
    async def _t():
        pid = await _mk_partner()
        eid = await _mk_enterprise(partner_id=pid)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            assert admin is not None, "seed superadmin missing"
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                r = await c.get(f"/api/admin/enterprises/{eid}",
                                headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
        finally:
            await _wipe([pid], [eid])
    _run(_t())
