"""Regression: feedback tests must not send real emails.

Feb 25 2026 incident — pytest suite ran against the shared DB and
`_notify_superadmins` fanned out to every superadmin row it found,
including the real production ops inbox. Result: 15+ real Resend
emails landed in a real Gmail account during a CI/test run.

Root causes (both fixed):
  1. `_notify_superadmins` iterated ALL superadmin rows without
     filtering out test-shaped users OR checking whether the
     submitter was a test user.
  2. `email_dispatcher.dispatch()` had no safety guard for reserved
     test domains (@example.com, @example.org, .test, .invalid,
     .localhost — per RFC 2606/6761).

These tests lock the guards.
"""
from __future__ import annotations

import sys
import uuid
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def test_feedback_submission_from_example_com_does_not_email_real_superadmins():
    """Regression: a bug report posted by a `@example.com` user must NOT
    trigger `send_email` — even if there are real superadmin rows in
    the DB. `_notify_superadmins` short-circuits at the top."""
    async def _t():
        # Seed a "real" superadmin (a non-test email that would receive
        # a real email if the guard failed).
        real_admin_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": real_admin_uid, "email": "ops@realdomain.io",
            "name": "Real Ops", "password": hash_password("x"),
            "role": "superadmin",
        })
        # And a test-shaped submitter.
        client_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": client_uid, "email": f"fb_{client_uid[:6]}@example.com",
            "name": "Feedback Tester", "password": hash_password("x"),
            "role": "client",
        })
        tok = create_token(client_uid, "client")
        try:
            # Patch send_email at the module level so we can assert it
            # was never called with a real email address.
            with patch("email_service.send_email", new_callable=AsyncMock) as mocked:
                mocked.return_value = {"id": "test-resend-id"}
                async with await _client() as c:
                    r = await c.post(
                        "/api/feedback",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"type": "bug", "title": "leak-test"},
                    )
                    assert r.status_code == 200, r.text
                # The submitter was @example.com → the notify
                # short-circuit fires → send_email is never called.
                assert mocked.call_count == 0, (
                    f"send_email was called {mocked.call_count} times — "
                    f"real superadmins would have received email"
                )
        finally:
            await db.users.delete_one({"id": real_admin_uid})
            await db.users.delete_one({"id": client_uid})
            await db.feedback_items.delete_many({"user_id": client_uid})
    _run(_t())


def test_dispatcher_skips_all_test_recipient_addresses():
    """Direct unit test: dispatch() must skip a call with recipients
    that are entirely test-shaped, without touching send_email."""
    async def _t():
        from email_dispatcher import dispatch
        with patch("email_dispatcher.send_email", new_callable=AsyncMock) as mocked:
            resp = await dispatch(
                kind="feedback_new_submission",
                to="fake_user@example.com",
                subject="test", html="<p>x</p>",
            )
            assert resp["status"] == "skipped_test_recipient"
            assert mocked.call_count == 0
    _run(_t())


def test_dispatcher_skips_reserved_domains_variety():
    """The reserved-domain check must catch .test, .invalid,
    .localhost, and .example.* per RFC 2606/6761."""
    async def _t():
        from email_dispatcher import dispatch
        for addr in (
            "user@example.com",
            "user@example.org",
            "user@example.net",
            "user@my.test",
            "user@x.invalid",
            "user@my.localhost",
        ):
            with patch("email_dispatcher.send_email", new_callable=AsyncMock) as mocked:
                resp = await dispatch(
                    kind="feedback_new_submission",
                    to=addr, subject="t", html="<p>x</p>",
                )
                assert resp["status"] == "skipped_test_recipient", \
                    f"{addr} was not skipped"
                assert mocked.call_count == 0
    _run(_t())


def test_dispatcher_still_sends_to_real_addresses():
    """Sanity — the guard must NOT block real production addresses."""
    async def _t():
        from email_dispatcher import dispatch
        with patch("email_dispatcher.send_email", new_callable=AsyncMock) as mocked:
            mocked.return_value = {"id": "real-resend-id"}
            resp = await dispatch(
                kind="feedback_new_submission",
                to="ops@realdomain.io",
                subject="ping", html="<p>y</p>",
            )
            # Should have flowed through to send_email
            assert resp["status"] == "sent"
            assert mocked.call_count == 1
    _run(_t())


def test_reporter_reply_from_test_user_does_not_email_real_superadmins():
    """Regression: when a test-shaped reporter posts a follow-up on
    their feedback, the `_notify_superadmins_of_reporter_reply`
    fanout must NOT reach any real superadmin."""
    async def _t():
        # Real superadmin who must NOT receive an email
        real_admin_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": real_admin_uid, "email": "ops@realdomain.io",
            "name": "Real Ops", "password": hash_password("x"),
            "role": "superadmin",
        })
        # Test-shaped client reporter
        client_uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": client_uid, "email": f"fb_{client_uid[:6]}@example.com",
            "name": "Feedback Tester", "password": hash_password("x"),
            "role": "client",
        })
        tok = create_token(client_uid, "client")
        fid = None
        try:
            with patch("email_service.send_email", new_callable=AsyncMock) as mocked:
                mocked.return_value = {"id": "test-resend-id"}
                async with await _client() as c:
                    r = await c.post(
                        "/api/feedback",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"type": "bug", "title": "reporter-reply-leak"},
                    )
                    assert r.status_code == 200, r.text
                    fid = r.json()["id"]
                    # Reporter posts a follow-up
                    r2 = await c.post(
                        f"/api/feedback/{fid}/reply",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"note": "one more thing"},
                    )
                    assert r2.status_code == 200, r2.text
                # Neither path may have sent to a real recipient
                assert mocked.call_count == 0, (
                    f"send_email was called {mocked.call_count} times — "
                    f"reporter-reply fanout leaked to real superadmins"
                )
        finally:
            await db.users.delete_one({"id": real_admin_uid})
            await db.users.delete_one({"id": client_uid})
            if fid:
                await db.feedback_items.delete_one({"id": fid})
    _run(_t())
