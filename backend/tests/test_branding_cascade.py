"""Tests for the Enterprise → Partner → Pro → Platform branding
cascade in `GET /api/branding/effective`.

The cascade rule (specific → general):
    1. If a Pro's enterprise has WL unlocked → enterprise brand wins.
    2. Else if the company's partner has WL unlocked → partner brand.
    3. Else the managing Pro's brand (WL locked or not, so firm_name
       still renders on tab titles even without WL).
    4. Else the empty Platform default.
"""
from __future__ import annotations

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_user(role: str, wl_source: str | None = None, firm_name: str | None = None) -> str:
    uid = str(uuid.uuid4())
    branding: dict = {}
    if firm_name:
        branding["firm_name"] = firm_name
    if wl_source == "comp":
        branding["whitelabel_comp"] = True
    elif wl_source == "paid":
        branding["whitelabel_paid"] = True
    await db.users.insert_one({
        "id": uid, "email": f"{role}_{uid[:6]}@example.com",
        "name": f"{role.title()} {uid[:4]}", "password": hash_password("x"),
        "role": role, "branding": branding,
    })
    return uid


async def _wipe(uids: list[str], cids: list[str], eids: list[str]):
    for uid in uids:
        await db.users.delete_one({"id": uid})
        await db.memberships.delete_many({"user_id": uid})
    for cid in cids:
        await db.companies.delete_one({"id": cid})
        await db.memberships.delete_many({"company_id": cid})
    for eid in eids:
        await db.enterprises.delete_one({"id": eid})


def test_partner_brand_wins_when_pro_wl_locked():
    """Client belongs to a company with partner_id=PARTNER (WL comped)
    and a Pro (WL not unlocked). Partner brand wins."""
    async def _t():
        partner_uid = await _mk_user("partner", wl_source="comp", firm_name="PartnerBrand")
        pro_uid = await _mk_user("pro", wl_source=None, firm_name="ProBrand")
        client_uid = await _mk_user("client")

        cid = str(uuid.uuid4())
        await db.companies.insert_one({
            "id": cid, "name": "Client Co", "owner_user_id": client_uid,
            "pro_user_id": pro_uid, "partner_id": partner_uid,
        })
        await db.memberships.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "user_id": client_uid, "role": "owner",
        })
        await db.memberships.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "user_id": pro_uid, "role": "pro",
        })

        tok = create_token(client_uid, "client")
        async with await _client() as c:
            r = await c.get("/api/branding/effective",
                            headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        assert r.json()["firm_name"] == "PartnerBrand"

        await _wipe([partner_uid, pro_uid, client_uid], [cid], [])
    _run(_t())


def test_pro_brand_wins_when_partner_wl_locked():
    """Same setup but the Partner's WL is LOCKED — falls through to
    Pro brand."""
    async def _t():
        partner_uid = await _mk_user("partner", wl_source=None, firm_name="PartnerBrand")
        pro_uid = await _mk_user("pro", wl_source="comp", firm_name="ProBrand")
        client_uid = await _mk_user("client")

        cid = str(uuid.uuid4())
        await db.companies.insert_one({
            "id": cid, "name": "Client Co", "owner_user_id": client_uid,
            "pro_user_id": pro_uid, "partner_id": partner_uid,
        })
        await db.memberships.insert_many([
            {"id": str(uuid.uuid4()), "company_id": cid,
             "user_id": client_uid, "role": "owner"},
            {"id": str(uuid.uuid4()), "company_id": cid,
             "user_id": pro_uid, "role": "pro"},
        ])
        tok = create_token(client_uid, "client")
        async with await _client() as c:
            r = await c.get("/api/branding/effective",
                            headers={"Authorization": f"Bearer {tok}"})
        assert r.json()["firm_name"] == "ProBrand"
        await _wipe([partner_uid, pro_uid, client_uid], [cid], [])
    _run(_t())


def test_enterprise_brand_wins_over_partner():
    """When the managing Pro has an enterprise_id AND that enterprise's
    owner has WL unlocked, Enterprise brand beats Partner brand — the
    specific-over-general rule."""
    async def _t():
        ent_owner_uid = await _mk_user("pro", wl_source="comp", firm_name="EntBrand")
        partner_uid = await _mk_user("partner", wl_source="comp", firm_name="PartnerBrand")
        pro_uid = await _mk_user("pro", wl_source="comp", firm_name="ProBrand")
        # Link the pro to the enterprise.
        eid = str(uuid.uuid4())
        await db.enterprises.insert_one({
            "id": eid, "name": "The Ent", "slug": f"ent-{uuid.uuid4().hex[:6]}",
            "owner_user_id": ent_owner_uid,
        })
        await db.users.update_one({"id": pro_uid}, {"$set": {"enterprise_id": eid}})

        client_uid = await _mk_user("client")
        cid = str(uuid.uuid4())
        await db.companies.insert_one({
            "id": cid, "name": "Client Co", "owner_user_id": client_uid,
            "pro_user_id": pro_uid, "partner_id": partner_uid,
        })
        await db.memberships.insert_many([
            {"id": str(uuid.uuid4()), "company_id": cid,
             "user_id": client_uid, "role": "owner"},
            {"id": str(uuid.uuid4()), "company_id": cid,
             "user_id": pro_uid, "role": "pro"},
        ])

        tok = create_token(client_uid, "client")
        async with await _client() as c:
            r = await c.get("/api/branding/effective",
                            headers={"Authorization": f"Bearer {tok}"})
        # Enterprise wins.
        assert r.json()["firm_name"] == "EntBrand"

        await _wipe(
            [ent_owner_uid, partner_uid, pro_uid, client_uid],
            [cid], [eid],
        )
    _run(_t())


def test_platform_default_when_nothing_unlocked_and_no_memberships():
    """Client with no memberships at all — empty branding."""
    async def _t():
        client_uid = await _mk_user("client")
        tok = create_token(client_uid, "client")
        async with await _client() as c:
            r = await c.get("/api/branding/effective",
                            headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        # No firm_name (or falls back to None) — this is the platform
        # default that lets the tab title show "SmartBooks".
        assert r.json().get("firm_name") in (None, "")

        await _wipe([client_uid], [], [])
    _run(_t())
