"""Tests for the QBO OAuth private-label return-host bug.

Bug: when a user starts the QBO OAuth flow on a private-label host
(e.g. `enterprise.accountingapp.ai`), Intuit's callback lands on the
flagship API host, and the previous code redirected the final success
response to the flagship's frontend (`app.smartbookssoftware.ai`). This
broke the label experience — the user landed on the wrong app's login
screen instead of `enterprise.accountingapp.ai/connections/qbo`.

Fix: capture `return_to_host` from the OAuth-start request headers,
persist it on the state record, and use it (with fallback to the
Intuit `redirect_uri` host, then the platform default) at every
final-redirect step.
"""
from __future__ import annotations

import sys
import uuid
from unittest.mock import patch

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_pro_and_company() -> tuple[str, str, str]:
    """Create a pro user + owned company + membership. Returns
    (user_id, token, company_id)."""
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"pro_{uid[:6]}@example.com",
        "name": "Pro", "password": hash_password("x"),
        "role": "pro",
    })
    cid = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": cid, "name": "TestCo", "owner_user_id": uid,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "user_id": uid, "company_id": cid,
        "role": "owner",
    })
    return uid, create_token(uid, "pro"), cid


async def _wipe(uids, cids):
    for uid in uids:
        await db.users.delete_one({"id": uid})
        await db.memberships.delete_many({"user_id": uid})
    for cid in cids:
        await db.companies.delete_one({"id": cid})
        await db.memberships.delete_many({"company_id": cid})
    await db.qbo_oauth_states.delete_many({"company_id": {"$in": cids}})


def test_oauth_start_captures_return_to_host_from_referer():
    """The browser's Referer is the authoritative source — that's the
    frontend page the user was on when they kicked off the flow."""
    async def _t():
        uid, tok, cid = await _mk_pro_and_company()
        try:
            with patch("routes.qbo.Q.authorization_url",
                       return_value="https://appcenter.intuit.com/consent?state=x"):
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        headers={
                            "Authorization": f"Bearer {tok}",
                            "referer": "https://enterprise.accountingapp.ai/connections/qbo",
                            # x-forwarded-host is `api.smartbookssoftware.ai`
                            # here — the ingress may rewrite the host to the
                            # flagship. Referer wins.
                            "x-forwarded-host": "api.smartbookssoftware.ai",
                        },
                    )
            assert r.status_code == 200, r.text
            rec = await db.qbo_oauth_states.find_one({"company_id": cid})
            assert rec is not None
            assert rec.get("return_to_host") == "https://enterprise.accountingapp.ai"
        finally:
            await _wipe([uid], [cid])
    _run(_t())


def test_oauth_start_uses_origin_when_referer_missing():
    """Origin covers CORS POSTs that strip Referer."""
    async def _t():
        uid, tok, cid = await _mk_pro_and_company()
        try:
            with patch("routes.qbo.Q.authorization_url",
                       return_value="https://consent"):
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        headers={
                            "Authorization": f"Bearer {tok}",
                            "origin": "https://cypherpro.accountingapp.ai",
                        },
                    )
            assert r.status_code == 200
            rec = await db.qbo_oauth_states.find_one({"company_id": cid})
            assert rec.get("return_to_host") == "https://cypherpro.accountingapp.ai"
        finally:
            await _wipe([uid], [cid])
    _run(_t())


def test_oauth_start_skips_api_host_from_forwarded_host_fallback():
    """When only `x-forwarded-host` is available AND it's an api.*
    host, we return None rather than sending the user to a bare
    non-app domain. The final redirect falls back to _APP_URL."""
    async def _t():
        uid, tok, cid = await _mk_pro_and_company()
        try:
            with patch("routes.qbo.Q.authorization_url",
                       return_value="https://consent"):
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        headers={
                            "Authorization": f"Bearer {tok}",
                            "x-forwarded-host": "api.smartbookssoftware.ai",
                        },
                    )
            assert r.status_code == 200
            rec = await db.qbo_oauth_states.find_one({"company_id": cid})
            # No usable frontend host — stored as None so the callback
            # falls through to the platform default rather than
            # bouncing to bare `smartbookssoftware.ai`.
            assert rec.get("return_to_host") is None
        finally:
            await _wipe([uid], [cid])
    _run(_t())


def test_oauth_callback_success_redirects_to_return_to_host():
    """The core fix — a state record carrying `return_to_host` must
    make the SUCCESS redirect land on that host, not the flagship."""
    async def _t():
        uid, _tok, cid = await _mk_pro_and_company()
        state = "test_state_" + uuid.uuid4().hex[:10]
        from datetime import datetime, timezone, timedelta
        await db.qbo_oauth_states.insert_one({
            "state": state, "company_id": cid, "user_id": uid,
            "redirect_uri": None,
            "return_to_host": "https://enterprise.accountingapp.ai",
            "expires_at": (datetime.now(timezone.utc)
                           + timedelta(minutes=10)).isoformat(),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        try:
            fake_tokens = {
                "access_token": "at_x", "refresh_token": "rt_x",
                "expires_in": 3600, "x_refresh_token_expires_in": 8640000,
            }
            with patch("routes.qbo.Q.exchange_code",
                       return_value=fake_tokens), \
                 patch("routes.qbo.Q.save_connection",
                       return_value=None):
                async with await _client() as c:
                    r = await c.get(
                        "/api/qbo/oauth/callback",
                        params={"code": "abc", "state": state,
                                "realmId": "9999"},
                        follow_redirects=False,
                    )
            assert r.status_code == 302
            loc = r.headers.get("location", "")
            assert loc.startswith("https://enterprise.accountingapp.ai/"), (
                f"success redirect should land on the label host, got: {loc}"
            )
            assert "qbo=connected" in loc
            assert "realm=9999" in loc
        finally:
            await _wipe([uid], [cid])
    _run(_t())


def test_oauth_callback_error_also_redirects_to_return_to_host():
    """Error paths already worked when redirect_uri carried an api.*
    host, but shared-host labels rely on `return_to_host`."""
    async def _t():
        uid, _tok, cid = await _mk_pro_and_company()
        state = "test_state_" + uuid.uuid4().hex[:10]
        from datetime import datetime, timezone, timedelta
        await db.qbo_oauth_states.insert_one({
            "state": state, "company_id": cid, "user_id": uid,
            "redirect_uri": None,
            "return_to_host": "https://enterprise.accountingapp.ai",
            "expires_at": (datetime.now(timezone.utc)
                           + timedelta(minutes=10)).isoformat(),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        try:
            async with await _client() as c:
                # Simulate an Intuit error redirect — user clicked "No thanks".
                r = await c.get(
                    "/api/qbo/oauth/callback",
                    params={"error": "access_denied", "state": state},
                    follow_redirects=False,
                )
            assert r.status_code == 302
            loc = r.headers.get("location", "")
            assert loc.startswith("https://enterprise.accountingapp.ai/")
            assert "qbo_error" in loc
        finally:
            await _wipe([uid], [cid])
    _run(_t())


def test_oauth_callback_falls_back_to_platform_when_no_return_host():
    """Legacy state records without `return_to_host` still work —
    fall back to the platform default (previous behaviour)."""
    async def _t():
        uid, _tok, cid = await _mk_pro_and_company()
        state = "test_state_" + uuid.uuid4().hex[:10]
        from datetime import datetime, timezone, timedelta
        await db.qbo_oauth_states.insert_one({
            "state": state, "company_id": cid, "user_id": uid,
            "redirect_uri": None,  # legacy — no return_to_host key.
            "expires_at": (datetime.now(timezone.utc)
                           + timedelta(minutes=10)).isoformat(),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        try:
            fake_tokens = {
                "access_token": "at_x", "refresh_token": "rt_x",
                "expires_in": 3600, "x_refresh_token_expires_in": 8640000,
            }
            with patch("routes.qbo.Q.exchange_code",
                       return_value=fake_tokens), \
                 patch("routes.qbo.Q.save_connection",
                       return_value=None):
                async with await _client() as c:
                    r = await c.get(
                        "/api/qbo/oauth/callback",
                        params={"code": "abc", "state": state,
                                "realmId": "9999"},
                        follow_redirects=False,
                    )
            assert r.status_code == 302
            loc = r.headers.get("location", "")
            # Falls back to the QBO_APP_URL env (SmartBooks by default).
            assert "/connections/qbo" in loc
            assert "qbo=connected" in loc
        finally:
            await _wipe([uid], [cid])
    _run(_t())
