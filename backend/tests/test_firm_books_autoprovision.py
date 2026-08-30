"""Firm Books auto-provision on Enterprise create + Login backfill.

Round 7.23 (Feb 2026) — closes the gap where enterprises created via
the superadmin "Add Enterprise" endpoint left their owner Pro without
a Firm Books company (the /auth/register path did it automatically,
this one didn't). Two regression guards:

  1. `test_admin_create_enterprise_provisions_firm_books` — hitting
     POST /api/admin/enterprises must land a Firm Books company for
     the newly-created owner.
  2. `test_login_backfills_firm_books_for_orphan_pro` — a Pro who
     somehow lacks a Firm Books company (e.g. created before this fix
     shipped) heals themselves on the next successful login.
"""
from __future__ import annotations

import sys
import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest  # noqa: F401 — keeps `pytest -x` happy on collection

sys.path.insert(0, "/app/backend")

from db import db                                     # noqa: E402
from auth import create_token, hash_password           # noqa: E402
from tests._shared_loop import run as _run             # noqa: E402


async def _client():
    from server import app
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_superadmin():
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"sa_{uid[:6]}@example.com",
        "name": "SA", "password": hash_password("x"),
        "role": "superadmin",
    })
    return uid, create_token(uid, "superadmin")


async def _cleanup_owner(email: str):
    """Remove the Pro (+ their Firm Books company + enterprise) created
    inside the test so successive runs don't accumulate cruft."""
    email = email.lower()
    u = await db.users.find_one({"email": email})
    if not u:
        return
    await db.companies.delete_many({"owner_user_id": u["id"]})
    await db.enterprises.delete_many({"owner_user_id": u["id"]})
    await db.users.delete_one({"id": u["id"]})


def test_admin_create_enterprise_provisions_firm_books():
    """The superadmin create-enterprise flow must land a Firm Books
    company for the newly-provisioned owner Pro so their company
    selector isn't empty on first login."""
    async def _t():
        sa_uid, sa_tok = await _mk_superadmin()
        owner_email = f"ownera_{uuid.uuid4().hex[:8]}@example.com"
        try:
            with patch("routes.auth.mint_password_set_token",
                        AsyncMock(return_value="token123")), \
                 patch("email_dispatcher.dispatch",
                        AsyncMock(return_value={"status": "sent", "error": None})):
                async with await _client() as c:
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {sa_tok}"},
                        json={
                            "name": f"AutoProvision Corp {uuid.uuid4().hex[:6]}",
                            "slug": f"autoprovision-{uuid.uuid4().hex[:6]}",
                            "owner_name": "New Owner",
                            "owner_email": owner_email,
                        },
                    )
            assert r.status_code == 200, r.text
            # Owner Pro should exist.
            owner = await db.users.find_one({"email": owner_email})
            assert owner is not None, "owner Pro not provisioned"
            # AND they should now have a Firm Books company.
            fb = await db.companies.find_one({
                "owner_user_id": owner["id"], "is_firm_books": True,
            })
            assert fb is not None, (
                "expected Firm Books auto-provision after admin.create_enterprise"
            )
        finally:
            await _cleanup_owner(owner_email)
            await db.users.delete_one({"id": sa_uid})
    _run(_t())


def test_login_backfills_firm_books_for_orphan_pro():
    """A Pro who somehow lacks a Firm Books company (created before this
    fix) should have one created transparently on their next login."""
    async def _t():
        # Provision an orphan Pro — a valid pro user with NO Firm Books.
        uid = str(uuid.uuid4())
        email = f"orph_{uid[:8]}@example.com"
        await db.users.insert_one({
            "id": uid, "email": email, "name": "Orphan Pro",
            "password": hash_password("secret"), "role": "pro",
        })
        try:
            # Sanity: no Firm Books before login.
            pre = await db.companies.find_one({
                "owner_user_id": uid, "is_firm_books": True,
            })
            assert pre is None
            async with await _client() as c:
                r = await c.post(
                    "/api/auth/login",
                    json={"email": email, "password": "secret"},
                )
            assert r.status_code == 200, r.text
            # Login should have healed the missing Firm Books.
            post = await db.companies.find_one({
                "owner_user_id": uid, "is_firm_books": True,
            })
            assert post is not None, (
                "expected Firm Books backfill on Pro login for the orphan case"
            )
        finally:
            await db.companies.delete_many({"owner_user_id": uid})
            await db.users.delete_one({"id": uid})
    _run(_t())
