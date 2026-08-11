"""Tests for the Partner role — Phase 1 MVP.

Covers:
  * POST /superadmin/partners creates a user (role=partner), sidecar
    row, and auto-provisions Partner Books.
  * Partner Books is delete-protected (403 without override, deletes
    with force_partner_books=true).
  * GET /partner/summary is scoped to the caller — Partner A cannot
    see Partner B's stats.
  * Partner CANNOT hit /superadmin/partners (403 not 404).
  * PATCH /superadmin/partners/{id} updates branding + slug uniquely.
  * Duplicate email → 409 with a helpful message.
"""
from __future__ import annotations

import asyncio
import sys
import uuid

import pytest

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


async def _admin_token() -> str:
    """Look up (or create) the seeded superadmin and mint a JWT."""
    u = await db.users.find_one({"email": "admin@axiom.ai"})
    assert u is not None, "seed superadmin missing"
    return create_token(u["id"], u["role"])


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --------------------------------------------------------------------------
# Superadmin — create + list
# --------------------------------------------------------------------------

def test_create_partner_provisions_books_and_returns_stats():
    async def _t():
        token = await _admin_token()
        email = f"p_create_{uuid.uuid4().hex[:8]}@example.com"
        async with await _client() as c:
            r = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "name": "Test Partner Co",
                    "email": email,
                    "display_name": "TestBrand",
                    "subdomain": f"tb-{uuid.uuid4().hex[:6]}",
                },
            )
        assert r.status_code == 200, r.text
        body = r.json()
        pid = body["partner"]["id"]
        assert body["partner"]["role"] == "partner"
        assert body["partner"]["display_name"] == "TestBrand"
        assert body["partner"]["stats"]["has_partner_books"] is True
        assert body["partner_books_company_id"]

        # DB shape
        user = await db.users.find_one({"id": pid})
        assert user["role"] == "partner"
        assert user["must_set_password"] is True
        assert user["branding"]["firm_name"] == "TestBrand"
        # Sidecar
        sidecar = await db.partners.find_one({"id": pid})
        assert sidecar is not None
        # Partner Books
        books = await db.companies.find_one({"id": body["partner_books_company_id"]})
        assert books["is_partner_books"] is True
        assert books["partner_id"] == pid
        assert books["owner_user_id"] == pid

        # cleanup
        await db.users.delete_one({"id": pid})
        await db.partners.delete_one({"id": pid})
        await db.companies.delete_one({"id": books["id"]})
        await db.memberships.delete_many({"user_id": pid})
        await db.accounts.delete_many({"company_id": books["id"]})
        await db.password_set_tokens.delete_many({"user_id": pid})
        await db.communications.delete_many({"user_id": pid})
    _run(_t())


def test_create_partner_duplicate_email_returns_409():
    async def _t():
        token = await _admin_token()
        email = f"p_dup_{uuid.uuid4().hex[:8]}@example.com"
        async with await _client() as c:
            r1 = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": "A", "email": email, "display_name": "A"},
            )
            assert r1.status_code == 200
            pid = r1.json()["partner"]["id"]

            r2 = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": "B", "email": email, "display_name": "B"},
            )
            assert r2.status_code == 409
            assert "already exists" in r2.json()["detail"]

        # cleanup
        books = await db.companies.find_one({"owner_user_id": pid})
        await db.users.delete_one({"id": pid})
        await db.partners.delete_one({"id": pid})
        if books:
            await db.companies.delete_one({"id": books["id"]})
            await db.accounts.delete_many({"company_id": books["id"]})
        await db.memberships.delete_many({"user_id": pid})
        await db.password_set_tokens.delete_many({"user_id": pid})
        await db.communications.delete_many({"user_id": pid})
    _run(_t())


def test_create_partner_with_non_partner_email_returns_409():
    """If the email already belongs to a client/pro/superadmin, we
    refuse — role changes are explicit, not a side effect of a create."""
    async def _t():
        token = await _admin_token()
        # Seed a client user with a known email.
        email = f"p_client_{uuid.uuid4().hex[:8]}@example.com"
        client_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": client_uid, "email": email, "name": "Existing Client",
            "password": hash_password("x"), "role": "client",
        })
        try:
            async with await _client() as c:
                r = await c.post(
                    "/api/superadmin/partners",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"name": "Promote", "email": email},
                )
            assert r.status_code == 409
            assert "client" in r.json()["detail"]
        finally:
            await db.users.delete_one({"id": client_uid})
    _run(_t())


def test_list_partners_returns_created_partner():
    async def _t():
        token = await _admin_token()
        email = f"p_list_{uuid.uuid4().hex[:8]}@example.com"
        async with await _client() as c:
            r = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": "ListTest", "email": email, "display_name": "LT"},
            )
            pid = r.json()["partner"]["id"]

            r2 = await c.get(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert r2.status_code == 200
        body = r2.json()
        assert body["count"] >= 1
        ids = [p["id"] for p in body["partners"]]
        assert pid in ids

        # cleanup
        books = await db.companies.find_one({"owner_user_id": pid})
        await db.users.delete_one({"id": pid})
        await db.partners.delete_one({"id": pid})
        if books:
            await db.companies.delete_one({"id": books["id"]})
            await db.accounts.delete_many({"company_id": books["id"]})
        await db.memberships.delete_many({"user_id": pid})
        await db.password_set_tokens.delete_many({"user_id": pid})
        await db.communications.delete_many({"user_id": pid})
    _run(_t())


def test_patch_partner_updates_branding():
    async def _t():
        token = await _admin_token()
        email = f"p_patch_{uuid.uuid4().hex[:8]}@example.com"
        async with await _client() as c:
            r = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": "PatchMe", "email": email, "display_name": "PM"},
            )
            pid = r.json()["partner"]["id"]

            r2 = await c.patch(
                f"/api/superadmin/partners/{pid}",
                headers={"Authorization": f"Bearer {token}"},
                json={"display_name": "PatchedName", "primary_color": "#ff0000"},
            )
        assert r2.status_code == 200
        assert r2.json()["partner"]["display_name"] == "PatchedName"
        assert r2.json()["partner"]["primary_color"] == "#ff0000"

        # cleanup
        books = await db.companies.find_one({"owner_user_id": pid})
        await db.users.delete_one({"id": pid})
        await db.partners.delete_one({"id": pid})
        if books:
            await db.companies.delete_one({"id": books["id"]})
            await db.accounts.delete_many({"company_id": books["id"]})
        await db.memberships.delete_many({"user_id": pid})
        await db.password_set_tokens.delete_many({"user_id": pid})
        await db.communications.delete_many({"user_id": pid})
    _run(_t())


# --------------------------------------------------------------------------
# Partner Books — delete protection
# --------------------------------------------------------------------------

def test_partner_books_delete_requires_force_flag():
    async def _t():
        token = await _admin_token()
        email = f"p_del_{uuid.uuid4().hex[:8]}@example.com"
        async with await _client() as c:
            r = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": "DelTest", "email": email, "display_name": "DT"},
            )
            pid = r.json()["partner"]["id"]
            books_id = r.json()["partner_books_company_id"]
            books = await db.companies.find_one({"id": books_id})
            bname = books["name"]

            # Attempt delete without override — expect 403 with a
            # message that mentions the override flag.
            from urllib.parse import quote
            r_del = await c.delete(
                f"/api/companies/{books_id}?confirm={quote(bname)}",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r_del.status_code == 403
            assert "force_partner_books" in r_del.json()["detail"]

            # With override → succeeds.
            r_del2 = await c.delete(
                f"/api/companies/{books_id}?confirm={quote(bname)}&force_partner_books=true",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r_del2.status_code == 200, r_del2.text

        # cleanup (books already deleted)
        await db.users.delete_one({"id": pid})
        await db.partners.delete_one({"id": pid})
        await db.memberships.delete_many({"user_id": pid})
        await db.password_set_tokens.delete_many({"user_id": pid})
        await db.communications.delete_many({"user_id": pid})
    _run(_t())


# --------------------------------------------------------------------------
# Scoping — Partner A cannot see Partner B's data
# --------------------------------------------------------------------------

def test_partner_summary_is_scoped_to_caller():
    async def _t():
        admin_tok = await _admin_token()
        # Create two partners.
        pids: list[str] = []
        books_ids: list[str] = []
        async with await _client() as c:
            for label in ("A", "B"):
                r = await c.post(
                    "/api/superadmin/partners",
                    headers={"Authorization": f"Bearer {admin_tok}"},
                    json={
                        "name": f"Scope{label}",
                        "email": f"p_scope_{label}_{uuid.uuid4().hex[:8]}@example.com",
                        "display_name": f"Scope-{label}",
                    },
                )
                pids.append(r.json()["partner"]["id"])
                books_ids.append(r.json()["partner_books_company_id"])

            # Seed a client company under Partner A only.
            client_cid = str(uuid.uuid4())
            await db.companies.insert_one({
                "id": client_cid, "name": "Scope A Client Co",
                "owner_user_id": "fake-owner",
                "partner_id": pids[0],
                "created_at": "2026-01-01T00:00:00+00:00",
            })

            # Partner A's summary — sees 1 client.
            tok_a = create_token(pids[0], "partner")
            r_a = await c.get(
                "/api/partner/summary",
                headers={"Authorization": f"Bearer {tok_a}"},
            )
            assert r_a.status_code == 200
            assert r_a.json()["partner"]["stats"]["clients"] == 1

            # Partner B's summary — sees 0 clients (scoping works).
            tok_b = create_token(pids[1], "partner")
            r_b = await c.get(
                "/api/partner/summary",
                headers={"Authorization": f"Bearer {tok_b}"},
            )
            assert r_b.status_code == 200
            assert r_b.json()["partner"]["stats"]["clients"] == 0

        # cleanup
        await db.companies.delete_one({"id": client_cid})
        for pid, bid in zip(pids, books_ids):
            await db.users.delete_one({"id": pid})
            await db.partners.delete_one({"id": pid})
            await db.companies.delete_one({"id": bid})
            await db.accounts.delete_many({"company_id": bid})
            await db.memberships.delete_many({"user_id": pid})
            await db.password_set_tokens.delete_many({"user_id": pid})
            await db.communications.delete_many({"user_id": pid})
    _run(_t())


def test_partner_cannot_access_superadmin_partners_endpoint():
    """A partner-role JWT MUST get 403 on the superadmin surface."""
    async def _t():
        admin_tok = await _admin_token()
        email = f"p_403_{uuid.uuid4().hex[:8]}@example.com"
        async with await _client() as c:
            r = await c.post(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {admin_tok}"},
                json={"name": "NoAdmin", "email": email, "display_name": "NA"},
            )
            pid = r.json()["partner"]["id"]

            partner_tok = create_token(pid, "partner")
            r_forbid = await c.get(
                "/api/superadmin/partners",
                headers={"Authorization": f"Bearer {partner_tok}"},
            )
            assert r_forbid.status_code == 403

        # cleanup
        books = await db.companies.find_one({"owner_user_id": pid})
        await db.users.delete_one({"id": pid})
        await db.partners.delete_one({"id": pid})
        if books:
            await db.companies.delete_one({"id": books["id"]})
            await db.accounts.delete_many({"company_id": books["id"]})
        await db.memberships.delete_many({"user_id": pid})
        await db.password_set_tokens.delete_many({"user_id": pid})
        await db.communications.delete_many({"user_id": pid})
    _run(_t())


def test_partner_books_provisioning_is_idempotent():
    """Calling ensure_partner_books_company_for_partner twice must
    return the same company id — protects against the 3-copies bug
    Firm Books hit in production."""
    async def _t():
        import partners as _p
        # Seed a partner user directly.
        pid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": pid, "email": f"idemp_{uuid.uuid4().hex[:6]}@example.com",
            "name": "Idempotent Partner", "password": hash_password("x"),
            "role": "partner", "branding": {"firm_name": "Idemp"},
        })
        try:
            books_1 = await _p.ensure_partner_books_company_for_partner(pid)
            books_2 = await _p.ensure_partner_books_company_for_partner(pid)
            books_3 = await _p.ensure_partner_books_company_for_partner(pid)
            assert books_1["id"] == books_2["id"] == books_3["id"]

            # Only ONE company doc exists for this partner.
            count = await db.companies.count_documents({
                "owner_user_id": pid, "is_partner_books": True,
            })
            assert count == 1

            # cleanup books
            await db.accounts.delete_many({"company_id": books_1["id"]})
            await db.companies.delete_one({"id": books_1["id"]})
            await db.memberships.delete_many({"user_id": pid})
        finally:
            await db.users.delete_one({"id": pid})
    _run(_t())
