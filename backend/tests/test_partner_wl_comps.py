"""Tests for the Partner white-label comp quota (max 2 total).

Feb 2026 policy — a Partner can burn white-label comps for up to 2
enterprise owners across their entire tree. Enforced in
`POST /admin/enterprises` when `comp_owner_whitelabel=True`.
Introspection is via `GET /partner/wl-comps`.

Superadmin bypass — they can grant comps freely via the existing
`POST /admin/pros/{pro_id}/whitelabel-comp` endpoint (partner cap
does not apply).
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


async def _wipe(uids: list[str]):
    for uid in uids:
        await db.users.delete_one({"id": uid})
        await db.users.delete_many({"partner_id": uid})
        # Sweep any enterprises the tests created.
        await db.enterprises.delete_many({"partner_id": uid})


def test_partner_wl_comps_endpoint_shows_zero_initially():
    async def _t():
        pid = await _mk_partner()
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.get("/api/partner/wl-comps",
                                headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200, r.text
            d = r.json()
            assert d == {"used": 0, "cap": 2, "remaining": 2}
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_can_comp_first_two_enterprise_owners():
    async def _t():
        pid = await _mk_partner()
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                for i in (1, 2):
                    email = f"owner-{i}-{uuid.uuid4().hex[:6]}@example.com"
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": f"Ent-{i}",
                            "owner_email": email,
                            "owner_name": f"Owner {i}",
                            "comp_owner_whitelabel": True,
                        },
                    )
                    assert r.status_code == 200, r.text
                    assert r.json()["comp_applied"] is True
                # Quota shows fully used.
                r_q = await c.get("/api/partner/wl-comps",
                                  headers={"Authorization": f"Bearer {tok}"})
                assert r_q.json() == {"used": 2, "cap": 2, "remaining": 0}
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_third_comp_is_rejected_and_rolls_back_enterprise():
    async def _t():
        pid = await _mk_partner()
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                # Burn both comps.
                for i in (1, 2):
                    email = f"owner-{i}-{uuid.uuid4().hex[:6]}@example.com"
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": f"Ent-{i}",
                            "owner_email": email,
                            "owner_name": f"Owner {i}",
                            "comp_owner_whitelabel": True,
                        },
                    )
                    assert r.status_code == 200
                # Third attempt should 400 AND roll back the enterprise
                # and its provisioned owner so we don't leave a
                # partially-configured record behind.
                email3 = f"owner-3-{uuid.uuid4().hex[:6]}@example.com"
                r3 = await c.post(
                    "/api/admin/enterprises",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "name": "Ent-3-rollback",
                        "owner_email": email3,
                        "owner_name": "Owner 3",
                        "comp_owner_whitelabel": True,
                    },
                )
            assert r3.status_code == 400
            cnt_ent = await db.enterprises.count_documents({"name": "Ent-3-rollback"})
            cnt_user = await db.users.count_documents({"email": email3})
            assert cnt_ent == 0, "enterprise should be rolled back"
            assert cnt_user == 0, "owner should be rolled back"
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_can_create_enterprise_without_comping_when_at_cap():
    """The cap only rejects when `comp_owner_whitelabel=True`. A
    partner at the cap can still provision more enterprises without
    comping — they just don't get the free WL flag."""
    async def _t():
        pid = await _mk_partner()
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                # Fill the cap.
                for i in (1, 2):
                    await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": f"Ent-{i}",
                            "owner_email": f"o{i}-{uuid.uuid4().hex[:6]}@ex.com",
                            "owner_name": f"O{i}",
                            "comp_owner_whitelabel": True,
                        },
                    )
                # Third enterprise WITHOUT comp — should succeed.
                r = await c.post(
                    "/api/admin/enterprises",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "name": "NoComp-Ent",
                        "owner_email": f"nocomp-{uuid.uuid4().hex[:6]}@ex.com",
                        "owner_name": "NoComp",
                        "comp_owner_whitelabel": False,
                    },
                )
            assert r.status_code == 200, r.text
            assert r.json()["comp_applied"] is False
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_comp_flag_without_owner_is_ignored_gracefully():
    """`comp_owner_whitelabel` is a no-op when there's no owner user
    to stamp it on — the request should still succeed (no owner is
    not an error state)."""
    async def _t():
        pid = await _mk_partner()
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.post(
                    "/api/admin/enterprises",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "name": "NoOwner-Ent",
                        "comp_owner_whitelabel": True,
                    },
                )
            assert r.status_code == 200, r.text
            assert r.json()["comp_applied"] is False
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_wl_comp_idempotent_when_owner_already_comped():
    """Attaching an EXISTING pro who already carries a comp doesn't
    burn a new slot — the count stays the same and `comp_applied` is
    False since we didn't add a new one."""
    async def _t():
        pid = await _mk_partner()
        # Pre-create a Pro who already has a comp attributed to
        # someone else (e.g. superadmin) — pre-set partner_id so it
        # counts in this partner's tree.
        pro_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": pro_uid,
            "email": f"prealready-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Already Comped",
            "password": hash_password("x"),
            "role": "pro",
            "partner_id": pid,
            "branding": {"whitelabel_comp": True},
        })
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                # Attach this existing pro as the owner of a new
                # enterprise, requesting a comp.
                r = await c.post(
                    "/api/admin/enterprises",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "name": "Reattach-Ent",
                        "owner_user_id": pro_uid,
                        "comp_owner_whitelabel": True,
                    },
                )
                assert r.status_code == 200, r.text
                assert r.json()["comp_applied"] is False  # already had it
                # Quota still shows 1 used (not 2).
                r_q = await c.get("/api/partner/wl-comps",
                                  headers={"Authorization": f"Bearer {tok}"})
                assert r_q.json()["used"] == 1
        finally:
            await _wipe([pid])
    _run(_t())
