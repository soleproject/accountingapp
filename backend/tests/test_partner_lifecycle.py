"""Tests for the Feb 2026 Partner archive / unarchive / hard-delete
endpoints.

Superadmin can:
  • POST /superadmin/partners/{id}/archive   → soft-delete (reversible)
  • POST /superadmin/partners/{id}/unarchive → restore
  • DELETE /superadmin/partners/{id}         → hard-delete with cascade
    (blocks with 409 when the tree has transactions unless
    ?force=true is passed)

Archived partners are blocked from `POST /auth/login`.
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


async def _mk_partner(email: str | None = None) -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": email or f"p_{uid[:6]}@example.com",
        "name": "Partner", "password": hash_password("pw12345678"),
        "role": "partner",
    })
    return uid


async def _mk_ent_and_company(pid: str, *, with_txn: bool = False) -> tuple[str, str]:
    eid = str(uuid.uuid4())
    await db.enterprises.insert_one({
        "id": eid, "name": f"E-{eid[:6]}",
        "slug": f"e-{uuid.uuid4().hex[:6]}",
        "partner_id": pid,
    })
    cid = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": cid, "name": f"C-{cid[:6]}",
        "partner_id": pid, "enterprise_id": eid,
    })
    if with_txn:
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "amount": 100, "description": "test",
        })
    return eid, cid


async def _wipe(pids, extra_users=None, extra_ents=None, extra_cids=None):
    for pid in pids:
        await db.users.delete_one({"id": pid})
    for uid in (extra_users or []):
        await db.users.delete_one({"id": uid})
    for eid in (extra_ents or []):
        await db.enterprises.delete_one({"id": eid})
    for cid in (extra_cids or []):
        await db.companies.delete_one({"id": cid})
        await db.transactions.delete_many({"company_id": cid})


def test_superadmin_can_archive_a_partner():
    async def _t():
        pid = await _mk_partner()
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                r = await c.post(f"/api/superadmin/partners/{pid}/archive",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            u = await db.users.find_one({"id": pid})
            assert u["status"] == "archived"
            assert u.get("archived_at")
            assert u.get("archived_by") == admin["id"]
        finally:
            await _wipe([pid])
    _run(_t())


def test_archived_partner_cannot_log_in():
    async def _t():
        email = f"archive-me-{uuid.uuid4().hex[:6]}@example.com"
        pid = await _mk_partner(email=email)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                await c.post(f"/api/superadmin/partners/{pid}/archive",
                             headers={"Authorization": f"Bearer {tok}"})
                # Try to log in — must fail with 403 + code=account_archived.
                r = await c.post("/api/auth/login",
                                 json={"email": email, "password": "pw12345678"})
            assert r.status_code == 403
            detail = r.json().get("detail") or {}
            assert detail.get("code") == "account_archived"
        finally:
            await _wipe([pid])
    _run(_t())


def test_superadmin_can_unarchive_partner():
    async def _t():
        email = f"restore-me-{uuid.uuid4().hex[:6]}@example.com"
        pid = await _mk_partner(email=email)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                await c.post(f"/api/superadmin/partners/{pid}/archive",
                             headers={"Authorization": f"Bearer {tok}"})
                r = await c.post(f"/api/superadmin/partners/{pid}/unarchive",
                                 headers={"Authorization": f"Bearer {tok}"})
                assert r.status_code == 200
                # Login now works.
                r_login = await c.post("/api/auth/login",
                                       json={"email": email,
                                             "password": "pw12345678"})
            assert r_login.status_code == 200
            u = await db.users.find_one({"id": pid})
            assert "status" not in u or u.get("status") is None
        finally:
            await _wipe([pid])
    _run(_t())


def test_hard_delete_without_txn_succeeds_and_cascades():
    async def _t():
        pid = await _mk_partner()
        eid, cid = await _mk_ent_and_company(pid, with_txn=False)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                r = await c.delete(f"/api/superadmin/partners/{pid}",
                                   headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200, r.text
            d = r.json()["deleted"]
            assert d["enterprises"] >= 1
            assert d["companies"] >= 1
            assert d["users"] >= 1  # the partner user itself
            # Verify actual DB state — everything gone.
            assert await db.users.find_one({"id": pid}) is None
            assert await db.enterprises.find_one({"id": eid}) is None
            assert await db.companies.find_one({"id": cid}) is None
        finally:
            await _wipe([pid], extra_ents=[eid], extra_cids=[cid])
    _run(_t())


def test_hard_delete_with_active_txns_is_blocked_without_force():
    async def _t():
        pid = await _mk_partner()
        eid, cid = await _mk_ent_and_company(pid, with_txn=True)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                r = await c.delete(f"/api/superadmin/partners/{pid}",
                                   headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 409, r.text
            detail = r.json().get("detail") or {}
            assert detail.get("code") == "cascade_blocked_active_data"
            assert detail.get("counts", {}).get("transactions") >= 1
            # Partner still exists.
            assert await db.users.find_one({"id": pid}) is not None
        finally:
            await _wipe([pid], extra_ents=[eid], extra_cids=[cid])
    _run(_t())


def test_hard_delete_with_force_succeeds_even_with_txns():
    async def _t():
        pid = await _mk_partner()
        eid, cid = await _mk_ent_and_company(pid, with_txn=True)
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            tok = create_token(admin["id"], "superadmin")
            async with await _client() as c:
                r = await c.delete(
                    f"/api/superadmin/partners/{pid}?force=true",
                    headers={"Authorization": f"Bearer {tok}"},
                )
            assert r.status_code == 200
            d = r.json()["deleted"]
            assert d["forced"] is True
            assert d["transactions"] >= 1
            # Everything cascaded.
            assert await db.users.find_one({"id": pid}) is None
            assert await db.enterprises.find_one({"id": eid}) is None
            assert await db.companies.find_one({"id": cid}) is None
            assert await db.transactions.count_documents({"company_id": cid}) == 0
        finally:
            await _wipe([pid], extra_ents=[eid], extra_cids=[cid])
    _run(_t())


def test_delete_non_partner_returns_404():
    async def _t():
        # Non-existent partner id.
        admin = await db.users.find_one({"email": "admin@axiom.ai"})
        tok = create_token(admin["id"], "superadmin")
        async with await _client() as c:
            r = await c.delete(f"/api/superadmin/partners/{uuid.uuid4()}",
                               headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 404
    _run(_t())
