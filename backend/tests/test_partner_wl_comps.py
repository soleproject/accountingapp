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


# ---------------------------------------------------------------------------
# Inline row-toggle path — `POST /admin/pros/{pro_id}/whitelabel-comp`
# now accepts `partner` role, with the same 2-comp quota and a scope check
# so partners can only flip pros in their own tree.
# ---------------------------------------------------------------------------

def test_partner_can_grant_wl_comp_via_admin_endpoint():
    async def _t():
        pid = await _mk_partner()
        # Give the partner a Pro in their tree.
        pro_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": pro_uid,
            "email": f"pro-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Pro In Tree", "password": hash_password("x"),
            "role": "pro", "partner_id": pid,
        })
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.post(
                    f"/api/admin/pros/{pro_uid}/whitelabel-comp",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"granted": True},
                )
            assert r.status_code == 200, r.text
            pro = await db.users.find_one({"id": pro_uid})
            assert (pro.get("branding") or {}).get("whitelabel_comp") is True
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_cannot_grant_wl_comp_on_pro_outside_their_tree():
    async def _t():
        p_a = await _mk_partner()
        p_b = await _mk_partner()
        # Pro belongs to Partner B.
        pro_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": pro_uid,
            "email": f"pro-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Not In A's Tree", "password": hash_password("x"),
            "role": "pro", "partner_id": p_b,
        })
        try:
            tok_a = create_token(p_a, "partner")
            async with await _client() as c:
                r = await c.post(
                    f"/api/admin/pros/{pro_uid}/whitelabel-comp",
                    headers={"Authorization": f"Bearer {tok_a}"},
                    json={"granted": True},
                )
            # 404 (enumeration guard) — never reveal that the pro exists
            # under another partner.
            assert r.status_code == 404
            pro = await db.users.find_one({"id": pro_uid})
            assert not (pro.get("branding") or {}).get("whitelabel_comp")
        finally:
            await _wipe([p_a, p_b])
    _run(_t())


def test_partner_grant_rejected_when_quota_exhausted():
    async def _t():
        pid = await _mk_partner()
        # Two pros ALREADY comp'd — quota is full.
        comped_ids = []
        for _ in range(2):
            u = str(uuid.uuid4())
            await db.users.insert_one({
                "id": u,
                "email": f"c-{uuid.uuid4().hex[:6]}@example.com",
                "name": "Comped", "password": hash_password("x"),
                "role": "pro", "partner_id": pid,
                "branding": {"whitelabel_comp": True},
            })
            comped_ids.append(u)
        # Third pro in tree, NOT yet comped.
        target = str(uuid.uuid4())
        await db.users.insert_one({
            "id": target,
            "email": f"t-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Target", "password": hash_password("x"),
            "role": "pro", "partner_id": pid,
        })
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.post(
                    f"/api/admin/pros/{target}/whitelabel-comp",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"granted": True},
                )
            assert r.status_code == 400
            tgt = await db.users.find_one({"id": target})
            assert not (tgt.get("branding") or {}).get("whitelabel_comp")
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_can_revoke_wl_comp_even_at_quota():
    """Revoking is unbounded — quota only gates GRANTS."""
    async def _t():
        pid = await _mk_partner()
        # Two comp'd pros in the tree.
        pros = []
        for _ in range(2):
            u = str(uuid.uuid4())
            await db.users.insert_one({
                "id": u,
                "email": f"c-{uuid.uuid4().hex[:6]}@example.com",
                "name": "Comped", "password": hash_password("x"),
                "role": "pro", "partner_id": pid,
                "branding": {"whitelabel_comp": True},
            })
            pros.append(u)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.post(
                    f"/api/admin/pros/{pros[0]}/whitelabel-comp",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"granted": False},
                )
            assert r.status_code == 200, r.text
            p = await db.users.find_one({"id": pros[0]})
            assert (p.get("branding") or {}).get("whitelabel_comp") is False
            # After revoke, quota is used=1/2.
            async with await _client() as c:
                r_q = await c.get("/api/partner/wl-comps",
                                  headers={"Authorization": f"Bearer {tok}"})
            assert r_q.json()["used"] == 1
        finally:
            await _wipe([pid])
    _run(_t())


def test_partner_enterprises_endpoint_returns_owner_wl_status():
    """`GET /partner/enterprises` surfaces `owner_whitelabel_comp` on
    each row so the frontend can render the toggle state."""
    async def _t():
        pid = await _mk_partner()
        owner = str(uuid.uuid4())
        await db.users.insert_one({
            "id": owner,
            "email": f"o-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Ent Owner", "password": hash_password("x"),
            "role": "pro", "partner_id": pid,
            "branding": {"whitelabel_comp": True},
        })
        eid = str(uuid.uuid4())
        await db.enterprises.insert_one({
            "id": eid, "name": "OwnerEnt", "slug": f"o-{uuid.uuid4().hex[:6]}",
            "partner_id": pid, "owner_user_id": owner,
        })
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.get("/api/partner/enterprises",
                                headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            rows = {e["id"]: e for e in r.json()["enterprises"]}
            row = rows[eid]
            assert row["owner_user_id"] == owner
            assert row["owner_whitelabel_comp"] is True
            assert row["owner_email"].startswith("o-")
        finally:
            await _wipe([pid])
    _run(_t())
