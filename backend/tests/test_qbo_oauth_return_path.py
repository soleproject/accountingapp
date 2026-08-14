"""Tests for the `return_path` param on the QBO OAuth start flow
(Feb 2026 — used by the onboarding wizard to keep the user inside
the wizard after Intuit consent instead of dumping them onto the
standalone /connections/qbo page).

Coverage:
  1. Path helper rejects absolute URLs (open-redirect guard).
  2. Path helper rejects protocol-relative `//host` (also open-redirect).
  3. Path helper accepts a well-formed relative path.
  4. Path is persisted on the oauth_states row.
  5. Omitting the body still works — backward-compatible with the
     legacy bare-POST caller (standalone /connections/qbo page).
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


async def _mk_pro_with_company():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "name": "Pro", "password": hash_password("x"), "role": "pro",
    })
    await db.companies.insert_one({
        "id": cid, "name": "T", "owner_user_id": uid,
        "business_type": "professional-services",
        "reporting_basis": "accrual", "accounting_mode": "advanced",
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": uid, "company_id": cid, "role": "owner",
    })
    return uid, cid


async def _wipe(uid, cid):
    await db.qbo_oauth_states.delete_many({"company_id": cid})
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})


# ─── Pure helper ──────────────────────────────────────────────────────

def test_safe_return_path_helper_accepts_valid_paths():
    from routes.qbo import _safe_return_path
    assert _safe_return_path("/onboarding") == "/onboarding"
    assert _safe_return_path("/onboarding?step=1&qbo=connected") == \
        "/onboarding?step=1&qbo=connected"


def test_safe_return_path_helper_rejects_open_redirects():
    from routes.qbo import _safe_return_path
    # Absolute URL — attacker could redirect to phishing site.
    assert _safe_return_path("https://evil.com/steal") is None
    assert _safe_return_path("http://evil.com") is None
    # Protocol-relative — same danger (`//evil.com` resolves to
    # https://evil.com in a browser).
    assert _safe_return_path("//evil.com/steal") is None
    # Junk inputs.
    assert _safe_return_path("") is None
    assert _safe_return_path(None) is None
    assert _safe_return_path("onboarding") is None  # not rooted


def test_safe_return_path_helper_truncates_absurd_lengths():
    from routes.qbo import _safe_return_path
    p = "/x" + "y" * 10000
    out = _safe_return_path(p)
    assert out is not None
    assert len(out) <= 512


# ─── Route persists return_path on the state row ──────────────────────

def test_oauth_start_persists_return_path_on_state_row():
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                # Mock the underlying SDK so we don't actually try to
                # hit Intuit — we only care about state persistence.
                with patch("qbo_service.authorization_url",
                            return_value="https://intuit.com/consent?stubbed"):
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        json={"return_path": "/onboarding?step=1&qbo=connected"},
                        headers={"Authorization": f"Bearer {tok}"},
                    )
                    assert r.status_code == 200, r.text

            # Exactly one state row was inserted for this company;
            # verify return_path landed on it.
            row = await db.qbo_oauth_states.find_one({"company_id": cid})
            assert row is not None
            assert row.get("return_path") == "/onboarding?step=1&qbo=connected"
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_oauth_start_backward_compatible_without_body():
    """Standalone /connections/qbo page still POSTs with no body. The
    endpoint must accept that and default return_path to None (which
    the callback treats as `/connections/qbo`)."""
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                with patch("qbo_service.authorization_url",
                            return_value="https://intuit.com/consent?stubbed"):
                    # Empty JSON body — mirrors the standalone page.
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        json={},
                        headers={"Authorization": f"Bearer {tok}"},
                    )
                    assert r.status_code == 200, r.text

            row = await db.qbo_oauth_states.find_one({"company_id": cid})
            assert row is not None
            assert row.get("return_path") is None
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_oauth_start_rejects_open_redirect_return_paths():
    """A malicious return_path (absolute URL) must be silently dropped —
    the row stays with return_path=None so the callback falls back to
    the safe default. Not a 400 because the frontend never sends
    these; a downgrade to None is friendlier."""
    async def _t():
        uid, cid = await _mk_pro_with_company()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                with patch("qbo_service.authorization_url",
                            return_value="https://intuit.com/consent?stubbed"):
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/oauth/start",
                        json={"return_path": "https://evil.com/steal"},
                        headers={"Authorization": f"Bearer {tok}"},
                    )
                    assert r.status_code == 200, r.text

            row = await db.qbo_oauth_states.find_one({"company_id": cid})
            assert row is not None
            assert row.get("return_path") is None
        finally:
            await _wipe(uid, cid)
    _run(_t())
