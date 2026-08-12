"""Tests for the Partner Free-Spots cap (Feb 2026 policy).

Partners can allot at most 2 free spots per enterprise they provision.
Superadmin retains the full 0-10,000 range. Cap enforced on both
`POST /admin/enterprises` and `PATCH /admin/enterprises/{eid}`.
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


async def _mk_ent(partner_id: str, allot: int = 0) -> str:
    eid = str(uuid.uuid4())
    await db.enterprises.insert_one({
        "id": eid, "name": f"E-{eid[:6]}",
        "slug": f"e-{uuid.uuid4().hex[:6]}",
        "partner_id": partner_id,
        "free_user_allotment": allot,
        "default_product": "simple_start",
        "default_discount": False,
    })
    return eid


async def _wipe(uids, eids):
    for uid in uids:
        await db.users.delete_one({"id": uid})
    for eid in eids:
        await db.enterprises.delete_one({"id": eid})


def test_partner_can_create_enterprise_with_up_to_2_free_spots():
    async def _t():
        pid = await _mk_partner()
        tok = create_token(pid, "partner")
        try:
            async with await _client() as c:
                for allot in (0, 1, 2):
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": f"OK-Ent-{allot}",
                            "free_user_allotment": allot,
                        },
                    )
                    assert r.status_code == 200, r.text
                    eid = r.json()["enterprise"]["id"]
                    doc = await db.enterprises.find_one({"id": eid})
                    assert doc["free_user_allotment"] == allot
                    await db.enterprises.delete_one({"id": eid})
        finally:
            await _wipe([pid], [])
    _run(_t())


def test_partner_cannot_create_enterprise_with_3_free_spots():
    async def _t():
        pid = await _mk_partner()
        tok = create_token(pid, "partner")
        try:
            async with await _client() as c:
                r = await c.post(
                    "/api/admin/enterprises",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"name": "TooMany", "free_user_allotment": 3},
                )
            assert r.status_code == 400
            assert "free spots" in r.json().get("detail", "").lower()
            # Verify no partial-write.
            cnt = await db.enterprises.count_documents({"name": "TooMany"})
            assert cnt == 0
        finally:
            await _wipe([pid], [])
    _run(_t())


def test_partner_cannot_patch_free_spots_above_2():
    async def _t():
        pid = await _mk_partner()
        eid = await _mk_ent(pid, allot=2)
        tok = create_token(pid, "partner")
        try:
            async with await _client() as c:
                r = await c.patch(
                    f"/api/admin/enterprises/{eid}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"free_user_allotment": 5},
                )
            assert r.status_code == 400
            # Unchanged on failure.
            doc = await db.enterprises.find_one({"id": eid})
            assert doc["free_user_allotment"] == 2
        finally:
            await _wipe([pid], [eid])
    _run(_t())


def test_partner_can_patch_free_spots_to_2():
    """The cap is a ceiling, not a fixed value — partners can move
    between 0-2 freely."""
    async def _t():
        pid = await _mk_partner()
        eid = await _mk_ent(pid, allot=0)
        tok = create_token(pid, "partner")
        try:
            async with await _client() as c:
                r = await c.patch(
                    f"/api/admin/enterprises/{eid}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"free_user_allotment": 2},
                )
            assert r.status_code == 200, r.text
            doc = await db.enterprises.find_one({"id": eid})
            assert doc["free_user_allotment"] == 2
        finally:
            await _wipe([pid], [eid])
    _run(_t())


def test_superadmin_can_still_set_free_spots_above_2():
    """Superadmin bypass — the cap is partner-only. Superadmin can
    lift a partner-created enterprise beyond 2 to comp specific
    high-value clients."""
    async def _t():
        pid = await _mk_partner()
        eid = await _mk_ent(pid, allot=2)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            assert admin is not None
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/admin/enterprises/{eid}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"free_user_allotment": 500},
                )
            assert r.status_code == 200, r.text
            doc = await db.enterprises.find_one({"id": eid})
            assert doc["free_user_allotment"] == 500
        finally:
            await _wipe([pid], [eid])
    _run(_t())
