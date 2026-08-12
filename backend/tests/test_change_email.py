"""Tests for the self-service `POST /auth/change-email` endpoint.

Feb 2026 — Enterprise-owner Pros (and every other authenticated user)
can rotate their login email from the Enterprise settings page.
Requires the current password so a stolen JWT alone can't hijack an
account, and refuses duplicate + no-op changes.
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


async def _mk_user(email: str, password: str) -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": email.lower(),
        "name": "Test", "password": hash_password(password),
        "role": "pro",
    })
    return uid


async def _wipe(uids):
    for uid in uids:
        await db.users.delete_one({"id": uid})


def test_change_email_success_updates_the_user_doc():
    async def _t():
        old = f"old-{uuid.uuid4().hex[:6]}@example.com"
        uid = await _mk_user(old, "pw12345678")
        new = f"new-{uuid.uuid4().hex[:6]}@example.com"
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.post(
                    "/api/auth/change-email",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"current_password": "pw12345678",
                          "new_email": new},
                )
            assert r.status_code == 200, r.text
            assert r.json()["email"] == new.lower()
            u = await db.users.find_one({"id": uid})
            assert u["email"] == new.lower()
        finally:
            await _wipe([uid])
    _run(_t())


def test_change_email_rejects_wrong_password():
    async def _t():
        old = f"o-{uuid.uuid4().hex[:6]}@example.com"
        uid = await _mk_user(old, "correct-pw")
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.post(
                    "/api/auth/change-email",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"current_password": "WRONG-pw",
                          "new_email": "new@example.com"},
                )
            assert r.status_code == 400
            u = await db.users.find_one({"id": uid})
            assert u["email"] == old.lower()  # unchanged
        finally:
            await _wipe([uid])
    _run(_t())


def test_change_email_rejects_duplicate_email():
    async def _t():
        e_a = f"a-{uuid.uuid4().hex[:6]}@example.com"
        e_b = f"b-{uuid.uuid4().hex[:6]}@example.com"
        uid_a = await _mk_user(e_a, "pw12345678")
        uid_b = await _mk_user(e_b, "pw12345678")
        try:
            tok = create_token(uid_a, "pro")
            async with await _client() as c:
                r = await c.post(
                    "/api/auth/change-email",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"current_password": "pw12345678",
                          "new_email": e_b},
                )
            assert r.status_code == 400
            # Confirm A's email didn't change.
            u = await db.users.find_one({"id": uid_a})
            assert u["email"] == e_a.lower()
        finally:
            await _wipe([uid_a, uid_b])
    _run(_t())


def test_change_email_rejects_same_email():
    async def _t():
        e = f"same-{uuid.uuid4().hex[:6]}@example.com"
        uid = await _mk_user(e, "pw12345678")
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.post(
                    "/api/auth/change-email",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"current_password": "pw12345678",
                          "new_email": e},
                )
            assert r.status_code == 400
        finally:
            await _wipe([uid])
    _run(_t())


def test_change_email_is_case_insensitive_for_collision_check():
    """`AAA@X.com` collides with `aaa@x.com`."""
    async def _t():
        e_a = f"CamelCase-{uuid.uuid4().hex[:6]}@example.com"
        uid_a = await _mk_user(e_a.lower(), "pw12345678")
        uid_b = await _mk_user(f"otheremail-{uuid.uuid4().hex[:6]}@example.com", "pw12345678")
        try:
            tok = create_token(uid_b, "pro")
            async with await _client() as c:
                r = await c.post(
                    "/api/auth/change-email",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"current_password": "pw12345678",
                          # Try uppercase — must still collide with lowercase A.
                          "new_email": e_a.upper()},
                )
            assert r.status_code == 400
        finally:
            await _wipe([uid_a, uid_b])
    _run(_t())
