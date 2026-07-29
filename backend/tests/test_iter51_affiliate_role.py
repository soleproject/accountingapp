"""Iteration 51 — Affiliate role + upgrade regression suite.

Covers:
- POST /api/auth/signup role=affiliate (200, token, slug auto-minted on /share)
- POST /api/auth/signup role=superadmin (400)
- POST /api/auth/signup role=client / role=pro still work
- Affiliate token can hit /api/share, /api/share/slug, /api/share/referrals,
  /api/share/report, /api/auth/me
- Affiliate token gets 403 on /api/pro/clients, /api/admin/affiliate/payouts,
  /api/pro/team; /api/companies returns {companies: []} (200)
- POST /api/affiliate/upgrade — 200 flips role, slug + earnings preserved
- POST /api/affiliate/upgrade — idempotent for client role
- POST /api/affiliate/upgrade without auth — 401

Run: pytest /app/backend/tests/test_iter51_affiliate_role.py -v
"""
import os
import sys
import uuid
import time
import asyncio
import datetime as dt

import pytest
import requests


def _read_base_url() -> str:
    env = os.environ.get("REACT_APP_BACKEND_URL")
    if env:
        return env.rstrip("/")
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except FileNotFoundError:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not configured")


BASE_URL = _read_base_url()
API = f"{BASE_URL}/api"

sys.path.insert(0, "/app/backend")


# --------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------
_created_user_ids: list[str] = []
_created_emails: list[str] = []
_created_earning_ids: list[str] = []


def _signup(role: str, name: str | None = None):
    ts = int(time.time() * 1000)
    email = f"TEST_aff_{role}_{ts}_{uuid.uuid4().hex[:6]}@example.com"
    payload = {
        "email": email,
        "password": "affpass1234",
        "name": name or f"TEST {role.title()} {ts}",
        "role": role,
    }
    r = requests.post(f"{API}/auth/signup", json=payload, timeout=15)
    return r, email, payload


@pytest.fixture(scope="module")
def affiliate_session():
    r, email, payload = _signup("affiliate", name="Alex Affiliate")
    assert r.status_code == 200, f"affiliate signup failed: {r.status_code} {r.text}"
    body = r.json()
    _created_emails.append(email)
    _created_user_ids.append(body["user"]["id"])
    return {
        "token": body["token"],
        "user": body["user"],
        "email": email,
        "headers": {
            "Authorization": f"Bearer {body['token']}",
            "Content-Type": "application/json",
        },
    }


@pytest.fixture(scope="module", autouse=True)
def _cleanup_at_end():
    yield
    try:
        from db import db

        async def _clean():
            if _created_user_ids:
                await db.users.delete_many({"id": {"$in": _created_user_ids}})
            if _created_emails:
                await db.users.delete_many({"email": {"$in": [e.lower() for e in _created_emails]}})
            if _created_earning_ids:
                await db.referral_earnings.delete_many({"id": {"$in": _created_earning_ids}})

        asyncio.get_event_loop().run_until_complete(_clean())
    except Exception as e:
        print(f"cleanup warning: {e}")


# --------------------------------------------------------------------
# 1. Signup role validation
# --------------------------------------------------------------------
class TestSignupRoles:
    def test_signup_affiliate_returns_token_and_user(self, affiliate_session):
        u = affiliate_session["user"]
        assert u["role"] == "affiliate"
        assert u["email"] == affiliate_session["email"].lower()
        assert affiliate_session["token"]

    def test_signup_affiliate_auto_mints_slug_on_share(self, affiliate_session):
        r = requests.get(f"{API}/share", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert isinstance(d.get("slug"), str) and len(d["slug"]) >= 3
        assert d["slug"] == d["slug"].lower()
        # Vanity slug should be based on the name — "alex" prefix
        assert "alex" in d["slug"].lower(), f"expected vanity slug based on name: {d['slug']}"

    def test_signup_superadmin_rejected_400(self):
        r, _, _ = _signup("superadmin")
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"
        assert "role" in r.text.lower() or "unsupported" in r.text.lower()

    def test_signup_client_still_works(self):
        r, email, _ = _signup("client")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["user"]["role"] == "client"
        _created_user_ids.append(body["user"]["id"])
        _created_emails.append(email)

    def test_signup_pro_still_works(self):
        r, email, _ = _signup("pro")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["user"]["role"] == "pro"
        _created_user_ids.append(body["user"]["id"])
        _created_emails.append(email)


# --------------------------------------------------------------------
# 2. Affiliate can access share endpoints + auth/me
# --------------------------------------------------------------------
class TestAffiliateAllowedEndpoints:
    def test_get_share(self, affiliate_session):
        r = requests.get(f"{API}/share", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 200, r.text

    def test_put_share_slug(self, affiliate_session):
        new_slug = f"test-aff-{uuid.uuid4().hex[:6]}"
        r = requests.put(
            f"{API}/share/slug",
            headers=affiliate_session["headers"],
            json={"slug": new_slug},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        assert r.json()["slug"] == new_slug

    def test_get_share_referrals(self, affiliate_session):
        r = requests.get(f"{API}/share/referrals", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 200, r.text
        assert "referrals" in r.json()

    def test_get_share_report(self, affiliate_session):
        r = requests.get(f"{API}/share/report", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "totals" in d and "lines" in d

    def test_get_auth_me(self, affiliate_session):
        r = requests.get(f"{API}/auth/me", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        u = body.get("user") or body
        assert u["role"] == "affiliate"


# --------------------------------------------------------------------
# 3. Affiliate is blocked from role-gated endpoints
# --------------------------------------------------------------------
class TestAffiliateBlockedEndpoints:
    def test_pro_clients_403(self, affiliate_session):
        r = requests.get(f"{API}/pro/clients", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_admin_affiliate_payouts_403(self, affiliate_session):
        r = requests.get(
            f"{API}/admin/affiliate/payouts",
            headers=affiliate_session["headers"],
            timeout=10,
        )
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_pro_team_403(self, affiliate_session):
        r = requests.get(f"{API}/pro/team", headers=affiliate_session["headers"], timeout=10)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_companies_returns_empty(self, affiliate_session):
        r = requests.get(f"{API}/companies", headers=affiliate_session["headers"], timeout=10)
        # Uses get_current_user, not a role gate — expect 200 with empty list
        assert r.status_code == 200, f"expected 200, got {r.status_code} {r.text}"
        d = r.json()
        companies = d.get("companies", d if isinstance(d, list) else [])
        assert companies == [] or companies == {} or len(companies) == 0


# --------------------------------------------------------------------
# 4. Affiliate upgrade endpoint
# --------------------------------------------------------------------
class TestAffiliateUpgrade:
    def test_upgrade_no_auth_401(self):
        r = requests.post(f"{API}/affiliate/upgrade", timeout=10)
        assert r.status_code == 401, f"expected 401, got {r.status_code} {r.text}"

    def test_upgrade_affiliate_flips_role_preserves_slug_and_earnings(self):
        # Fresh affiliate for this test
        r, email, _ = _signup("affiliate", name="Beta Affiliate")
        assert r.status_code == 200, r.text
        body = r.json()
        token = body["token"]
        uid = body["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        # Mint slug via /share
        share = requests.get(f"{API}/share", headers=headers, timeout=10).json()
        pre_slug = share["slug"]
        assert pre_slug

        # Seed a referral_earnings row so we can prove it survives
        from db import db

        earn_id = str(uuid.uuid4())
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()

        async def _seed_earning():
            await db.referral_earnings.insert_one(
                {
                    "id": earn_id,
                    "platform_payment_id": f"TEST_pay_{uuid.uuid4().hex[:6]}",
                    "referrer_user_id": uid,
                    "referred_user_id": f"TEST_dummy_{uuid.uuid4().hex[:6]}",
                    "gross_cents": 7900,
                    "share_bps": 1899,
                    "share_cents": 1500,
                    "currency": "usd",
                    "status": "accrued",
                    "created_at": now_iso,
                }
            )

        asyncio.get_event_loop().run_until_complete(_seed_earning())
        _created_earning_ids.append(earn_id)

        # Upgrade
        r = requests.post(f"{API}/affiliate/upgrade", headers=headers, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["user"]["role"] == "client"
        assert d["user"]["id"] == uid
        assert d.get("token"), "upgrade should return a fresh token"

        # Verify DB flip + upgraded_from_affiliate_at set
        async def _check_db():
            u = await db.users.find_one({"id": uid})
            earn = await db.referral_earnings.find_one({"id": earn_id})
            return u, earn

        u, earn = asyncio.get_event_loop().run_until_complete(_check_db())
        assert u is not None
        assert u["role"] == "client"
        assert u.get("upgraded_from_affiliate_at"), "upgraded_from_affiliate_at not set"
        # Earning row intact
        assert earn is not None
        assert earn["share_cents"] == 1500
        assert earn["referrer_user_id"] == uid

        # Slug preserved — hit /share with the NEW token (post-upgrade role)
        new_headers = {
            "Authorization": f"Bearer {d['token']}",
            "Content-Type": "application/json",
        }
        share2 = requests.get(f"{API}/share", headers=new_headers, timeout=10).json()
        assert share2["slug"] == pre_slug, (
            f"slug changed after upgrade: {pre_slug} -> {share2['slug']}"
        )

    def test_upgrade_client_is_idempotent_no_downgrade(self):
        # Signup a client, then hit /affiliate/upgrade — role should stay 'client'
        r, email, _ = _signup("client")
        assert r.status_code == 200
        body = r.json()
        uid = body["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)
        headers = {"Authorization": f"Bearer {body['token']}", "Content-Type": "application/json"}

        r2 = requests.post(f"{API}/affiliate/upgrade", headers=headers, timeout=10)
        assert r2.status_code == 200, r2.text
        d = r2.json()
        assert d["user"]["role"] == "client"
        assert d["user"]["id"] == uid

    def test_upgrade_pro_is_idempotent_no_downgrade(self):
        r, email, _ = _signup("pro")
        assert r.status_code == 200
        body = r.json()
        uid = body["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)
        headers = {"Authorization": f"Bearer {body['token']}", "Content-Type": "application/json"}

        r2 = requests.post(f"{API}/affiliate/upgrade", headers=headers, timeout=10)
        assert r2.status_code == 200, r2.text
        assert r2.json()["user"]["role"] == "pro"
