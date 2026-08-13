"""Tests for enterprise archive / unarchive / hard-delete.

Feb 2026 — partners can wind down enterprises they own using the same
archive-first / hard-delete-with-force pattern used at the partner
lifecycle level. Partner scope enforced via
`_require_enterprise_access` (partners see 404 for enterprises they
don't own).
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
        "id": uid, "email": f"p_{uid[:6]}@example.com",
        "name": "P", "password": hash_password("x"),
        "role": "partner",
    })
    return uid


async def _mk_ent(pid: str, *, with_owner: bool = False, with_txn: bool = False) -> tuple[str, str | None, str | None]:
    eid = str(uuid.uuid4())
    owner_uid = None
    if with_owner:
        owner_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": owner_uid,
            "email": f"o-{uuid.uuid4().hex[:6]}@example.com",
            "name": "Owner", "password": hash_password("x"),
            "role": "pro", "partner_id": pid,
        })
    await db.enterprises.insert_one({
        "id": eid, "name": f"E-{eid[:6]}",
        "slug": f"e-{uuid.uuid4().hex[:6]}",
        "partner_id": pid, "owner_user_id": owner_uid,
    })
    cid = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": cid, "name": f"C-{cid[:6]}",
        "enterprise_id": eid, "partner_id": pid,
    })
    if with_txn:
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "amount": 100, "description": "t",
        })
    return eid, owner_uid, cid


async def _wipe(uids, eids, cids):
    for u in uids:
        await db.users.delete_one({"id": u})
    for e in eids:
        await db.enterprises.delete_one({"id": e})
    for c in cids:
        await db.companies.delete_one({"id": c})
        await db.transactions.delete_many({"company_id": c})


def test_partner_can_archive_own_enterprise_and_blocks_owner_login():
    async def _t():
        pid = await _mk_partner()
        eid, owner_uid, cid = await _mk_ent(pid, with_owner=True)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.post(f"/api/admin/enterprises/{eid}/archive",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200, r.text
            ent = await db.enterprises.find_one({"id": eid})
            assert ent["status"] == "archived"
            owner = await db.users.find_one({"id": owner_uid})
            assert owner["status"] == "archived"
        finally:
            await _wipe([pid, owner_uid], [eid], [cid])
    _run(_t())


def test_partner_can_unarchive_own_enterprise():
    async def _t():
        pid = await _mk_partner()
        eid, owner_uid, cid = await _mk_ent(pid, with_owner=True)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                await c.post(f"/api/admin/enterprises/{eid}/archive",
                             headers={"Authorization": f"Bearer {tok}"})
                r = await c.post(f"/api/admin/enterprises/{eid}/unarchive",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            ent = await db.enterprises.find_one({"id": eid})
            assert "status" not in ent or ent.get("status") is None
            owner = await db.users.find_one({"id": owner_uid})
            assert "status" not in owner or owner.get("status") is None
        finally:
            await _wipe([pid, owner_uid], [eid], [cid])
    _run(_t())


def test_partner_cannot_archive_other_partners_enterprise():
    async def _t():
        p_a = await _mk_partner()
        p_b = await _mk_partner()
        eid, owner_uid, cid = await _mk_ent(p_b, with_owner=False)
        try:
            tok_a = create_token(p_a, "partner")
            async with await _client() as c:
                r = await c.post(f"/api/admin/enterprises/{eid}/archive",
                                 headers={"Authorization": f"Bearer {tok_a}"})
            assert r.status_code == 404  # enumeration guard
            ent = await db.enterprises.find_one({"id": eid})
            assert "status" not in ent
        finally:
            await _wipe([p_a, p_b], [eid], [cid])
    _run(_t())


def test_partner_hard_delete_without_txns_cascades():
    async def _t():
        pid = await _mk_partner()
        eid, owner_uid, cid = await _mk_ent(pid, with_owner=True)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.delete(f"/api/admin/enterprises/{eid}",
                                   headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200, r.text
            d = r.json()["deleted"]
            assert d["companies"] >= 1
            assert d["users"] >= 1
            assert await db.enterprises.find_one({"id": eid}) is None
            assert await db.companies.find_one({"id": cid}) is None
            assert await db.users.find_one({"id": owner_uid}) is None
        finally:
            await _wipe([pid], [], [])
    _run(_t())


def test_partner_hard_delete_with_txns_blocked_without_force():
    async def _t():
        pid = await _mk_partner()
        eid, owner_uid, cid = await _mk_ent(pid, with_owner=True, with_txn=True)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.delete(f"/api/admin/enterprises/{eid}",
                                   headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 409
            detail = r.json().get("detail") or {}
            assert detail.get("code") == "cascade_blocked_active_data"
            assert detail.get("counts", {}).get("transactions") >= 1
            # Everything still exists.
            assert await db.enterprises.find_one({"id": eid}) is not None
            assert await db.companies.find_one({"id": cid}) is not None
        finally:
            await _wipe([pid, owner_uid], [eid], [cid])
    _run(_t())


def test_partner_hard_delete_with_force_succeeds():
    async def _t():
        pid = await _mk_partner()
        eid, owner_uid, cid = await _mk_ent(pid, with_owner=True, with_txn=True)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as c:
                r = await c.delete(f"/api/admin/enterprises/{eid}?force=true",
                                   headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            d = r.json()["deleted"]
            assert d["forced"] is True
            assert d["transactions"] >= 1
            assert await db.enterprises.find_one({"id": eid}) is None
            assert await db.transactions.count_documents({"company_id": cid}) == 0
        finally:
            await _wipe([pid], [], [])
    _run(_t())


def test_partner_cannot_delete_other_partners_enterprise():
    async def _t():
        p_a = await _mk_partner()
        p_b = await _mk_partner()
        eid, _, cid = await _mk_ent(p_b, with_owner=False)
        try:
            tok_a = create_token(p_a, "partner")
            async with await _client() as c:
                r = await c.delete(f"/api/admin/enterprises/{eid}",
                                   headers={"Authorization": f"Bearer {tok_a}"})
            assert r.status_code == 404
            assert await db.enterprises.find_one({"id": eid}) is not None
        finally:
            await _wipe([p_a, p_b], [eid], [cid])
    _run(_t())
