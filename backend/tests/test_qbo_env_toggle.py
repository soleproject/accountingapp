"""Tests for the per-company QBO env (sandbox ↔ production) toggle
(Feb 2026).

Coverage:
  1. `_norm_env` / `api_base_for` — pure helpers pick the right base URL.
  2. `env_from_connection` — legacy rows without `env` fall back to
     sandbox (matches the startup backfill).
  3. GET /qbo/env returns default production for a company with no
     `qbo_env` set and no connection.
  4. PATCH /qbo/env flips the value.
  5. PATCH /qbo/env is REJECTED with 409 while a connection is active
     (per the lock-first design decision — prevents orphaned tokens).
  6. After disconnecting, PATCH succeeds.
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


async def _mk_pro_with_company() -> tuple[str, str]:
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "name": "Pro", "password": hash_password("x"),
        "role": "pro",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Test Co", "owner_user_id": uid,
        "business_type": "professional-services",
        "reporting_basis": "accrual", "accounting_mode": "advanced",
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": uid, "company_id": cid, "role": "owner",
    })
    return uid, cid


async def _wipe(uid: str, cid: str):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})
    await db.qbo_connections.delete_many({"company_id": cid})


# ─── Pure helpers ─────────────────────────────────────────────────────

def test_norm_env_defaults_to_platform_default():
    from qbo_service import _norm_env, QBO_ENV_DEFAULT
    assert _norm_env("sandbox") == "sandbox"
    assert _norm_env("production") == "production"
    assert _norm_env(None) == QBO_ENV_DEFAULT
    assert _norm_env("") == QBO_ENV_DEFAULT
    assert _norm_env("garbage") == QBO_ENV_DEFAULT


def test_api_base_for_returns_correct_urls():
    from qbo_service import api_base_for
    assert "sandbox" in api_base_for("sandbox")
    assert "sandbox" not in api_base_for("production")
    assert api_base_for("production").endswith("/v3")


def test_env_from_connection_legacy_rows_fallback_to_sandbox():
    """A connection row that predates the dual-env rollout has no
    `env` field. The resolver must default those to sandbox so their
    tokens keep hitting the sandbox API base — matches the startup
    backfill."""
    from qbo_service import env_from_connection
    # Legacy row with neither `env` nor `environment` → sandbox
    # (matches the startup backfill's assumption).
    assert env_from_connection({"realm_id": "x"}) == "sandbox"
    assert env_from_connection({"environment": "sandbox"}) == "sandbox"
    assert env_from_connection({"env": "production"}) == "production"


# ─── HTTP endpoints ───────────────────────────────────────────────────

def test_get_qbo_env_defaults_to_production_for_new_company():
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/qbo/env",
                    headers={"Authorization": f"Bearer {tok}"},
                )
            assert r.status_code == 200, r.text
            j = r.json()
            assert j["env"] == "production"
            assert j["locked"] is False
            assert j["connection_env"] is None
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_patch_qbo_env_flips_value_and_get_reflects_it():
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{cid}/qbo/env",
                    json={"env": "sandbox"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                assert r.json()["env"] == "sandbox"

                r2 = await c.get(
                    f"/api/companies/{cid}/qbo/env",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r2.json()["env"] == "sandbox"

                r3 = await c.patch(
                    f"/api/companies/{cid}/qbo/env",
                    json={"env": "production"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r3.status_code == 200
                assert r3.json()["env"] == "production"
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_patch_qbo_env_rejected_while_connected():
    """Locking the toggle while a QBO connection is live prevents
    accidentally orphaning tokens (they'd fail auth against the wrong
    Intuit app). User must disconnect first."""
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            await db.qbo_connections.insert_one({
                "company_id": cid, "realm_id": "12345",
                "env": "sandbox", "environment": "sandbox",
                "status": "connected",
                "access_token_enc": b"fake",
                "refresh_token_enc": b"fake",
                "access_expires_at": "2099-01-01T00:00:00+00:00",
                "refresh_expires_at": "2099-01-01T00:00:00+00:00",
            })
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{cid}/qbo/env",
                    json={"env": "production"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 409, r.text
                assert "disconnect" in r.text.lower()

                r2 = await c.get(
                    f"/api/companies/{cid}/qbo/env",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                j = r2.json()
                assert j["locked"] is True
                assert j["connection_env"] == "sandbox"
                assert "disconnect" in (j["lock_reason"] or "").lower()
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_patch_qbo_env_gracefully_coerces_invalid_value():
    """Invalid env strings coerce to production (safe fallback) rather
    than 400. The frontend never sends garbage; graceful coercion is
    the friendlier UX for any accidental typo."""
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{cid}/qbo/env",
                    json={"env": "garbage"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200
                assert r.json()["env"] == "production"
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_disconnect_then_flip_env_succeeds():
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            # Seed a disconnected connection row (like a user who just
            # clicked Disconnect).
            await db.qbo_connections.insert_one({
                "company_id": cid, "realm_id": "12345",
                "env": "sandbox", "environment": "sandbox",
                "status": "disconnected",
                "access_token_enc": None, "refresh_token_enc": None,
            })
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{cid}/qbo/env",
                    json={"env": "production"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                assert r.json()["env"] == "production"
        finally:
            await _wipe(uid, cid)
    _run(_t())


# ─── Missing-cred guardrail ───────────────────────────────────────────

def test_auth_client_raises_actionable_error_when_prod_creds_missing():
    """When QBO_CLIENT_ID_PROD is unset (fresh deploy without env
    vars), `_auth_client(env='production')` must raise a RuntimeError
    naming the missing var — NOT silently build an AuthClient with
    client_id=None (which sends the user to Intuit's cryptic error
    page)."""
    import qbo_service as Q
    from unittest.mock import patch as _patch
    with _patch.object(Q, "QBO_CLIENT_ID_PROD", None), \
         _patch.object(Q, "QBO_CLIENT_SECRET_PROD", None):
        try:
            Q._auth_client(env="production")
        except RuntimeError as e:
            msg = str(e)
            assert "QBO PRODUCTION credentials not configured" in msg
            assert "QBO_CLIENT_ID_PROD" in msg
            assert "QBO_CLIENT_SECRET_PROD" in msg
            return
        raise AssertionError(
            "_auth_client should have raised RuntimeError with missing prod creds",
        )


def test_auth_client_raises_actionable_error_when_sandbox_creds_missing():
    import qbo_service as Q
    from unittest.mock import patch as _patch
    with _patch.object(Q, "QBO_CLIENT_ID", None), \
         _patch.object(Q, "QBO_CLIENT_SECRET", None):
        try:
            Q._auth_client(env="sandbox")
        except RuntimeError as e:
            msg = str(e)
            assert "QBO SANDBOX credentials not configured" in msg
            assert "QBO_CLIENT_ID" in msg  # sandbox var name has no _PROD suffix
            assert "_PROD" not in msg      # must NOT reference prod vars
            return
        raise AssertionError(
            "_auth_client should have raised RuntimeError with missing sandbox creds",
        )


def test_oauth_start_returns_500_with_actionable_detail_when_creds_missing():
    """The route surfaces the RuntimeError as a 500 with the
    'add these env vars' message — no dead state row created."""
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            # Force the target env to production, then null out its creds.
            await db.companies.update_one(
                {"id": cid}, {"$set": {"qbo_env": "production"}},
            )
            import qbo_service as Q
            from unittest.mock import patch as _patch
            tok = create_token(uid, "pro")
            state_count_before = await db.qbo_oauth_states.count_documents({})
            with _patch.object(Q, "QBO_CLIENT_ID_PROD", None), \
                 _patch.object(Q, "QBO_CLIENT_SECRET_PROD", None):
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        headers={"Authorization": f"Bearer {tok}"},
                    )
                    assert r.status_code == 500, r.text
                    assert "QBO_CLIENT_ID_PROD" in r.text
            # No dead state row was inserted.
            state_count_after = await db.qbo_oauth_states.count_documents({})
            assert state_count_after == state_count_before
        finally:
            await _wipe(uid, cid)
    _run(_t())
