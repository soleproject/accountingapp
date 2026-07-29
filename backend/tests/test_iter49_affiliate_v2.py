"""Iteration 49 — Affiliate v2 regression suite.

Covers:
- GET /api/share vanity slug + link_source
- PUT /api/share/slug validation, collision, reserved
- PATCH /api/pro/branding buy_page_url + validation
- GET /api/share/lookup (public) + 404
- GET /api/share/referrals (+ seeded)
- GET /api/share/report (default + custom window + seeded row)
- Tier lookup helper _lookup_payout_cents
- End-to-end webhook logic via _credit_referral_share

Run: pytest /app/backend/tests/test_iter49_affiliate_v2.py -v
"""
import os
import sys
import uuid
import asyncio
import datetime as dt

import pytest
import requests

# Read from frontend/.env since REACT_APP_BACKEND_URL isn't in the backend
# process env — same convention other iter tests use.
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

# Make backend modules importable for direct unit tests on helpers.
sys.path.insert(0, "/app/backend")

PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"


# --------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------
@pytest.fixture(scope="module")
def pro_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": PRO_EMAIL, "password": PRO_PASS},
                      timeout=15)
    assert r.status_code == 200, f"pro login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_headers(pro_token):
    return {"Authorization": f"Bearer {pro_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def pro_user_id(pro_headers):
    r = requests.get(f"{API}/auth/me", headers=pro_headers, timeout=10)
    assert r.status_code == 200
    body = r.json()
    return body.get("id") or body["user"]["id"]


# --------------------------------------------------------------------
# 1. GET /api/share — shape + vanity slug
# --------------------------------------------------------------------
class TestShareInfo:
    def test_share_returns_expected_fields(self, pro_headers):
        r = requests.get(f"{API}/share", headers=pro_headers, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("slug", "link", "link_source", "buy_page_url",
                  "referred_count", "paying_count",
                  "earnings_cents", "pending_cents"):
            assert k in d, f"missing key: {k}"
        assert d["link_source"] in ("platform", "firm_subdomain", "firm_buy_page")
        assert isinstance(d["slug"], str) and len(d["slug"]) >= 3
        # Should NOT be legacy 8-char random slug for pro@axiom.ai:
        # priya-patel-cpa or similar vanity (or user-renamed like 'priya').
        assert d["slug"] != d["slug"].upper()  # lowercase
        assert d["link"].endswith(f"ref={d['slug']}")


# --------------------------------------------------------------------
# 2. PUT /api/share/slug — validation
# --------------------------------------------------------------------
class TestSlugRename:
    def test_rename_valid(self, pro_headers):
        # Get current slug to restore later
        original = requests.get(f"{API}/share", headers=pro_headers).json()["slug"]
        new_slug = f"test-vanity-{uuid.uuid4().hex[:6]}"
        r = requests.put(f"{API}/share/slug",
                         headers=pro_headers,
                         json={"slug": new_slug}, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["slug"] == new_slug
        # verify GET /share reflects it
        got = requests.get(f"{API}/share", headers=pro_headers).json()
        assert got["slug"] == new_slug
        assert f"ref={new_slug}" in got["link"]
        # restore
        requests.put(f"{API}/share/slug",
                     headers=pro_headers, json={"slug": original})

    @pytest.mark.parametrize("bad", [
        "Priya Patel",   # spaces + uppercase
        "AB",            # too short
        "ab",            # too short
        "-leading",
        "trailing-",
        "double--dash",  # consecutive dashes rejected by tightened SLUG_RE
        "bad slug!",
        "a" * 41,        # too long
    ])
    def test_rename_invalid_shape_400(self, pro_headers, bad):
        r = requests.put(f"{API}/share/slug",
                         headers=pro_headers, json={"slug": bad}, timeout=10)
        assert r.status_code == 400, f"expected 400 for {bad!r}, got {r.status_code} {r.text}"

    @pytest.mark.parametrize("reserved", ["admin", "api", "signup", "pricing"])
    def test_rename_reserved_400(self, pro_headers, reserved):
        r = requests.put(f"{API}/share/slug",
                         headers=pro_headers, json={"slug": reserved}, timeout=10)
        assert r.status_code == 400, f"reserved {reserved} should be 400"

    def test_rename_taken_by_other_user_409(self, pro_headers):
        # Login as client and force their slug to a known lowercase vanity
        # first (client may have a legacy mixed-case slug in the DB).
        cr = requests.post(f"{API}/auth/login",
                           json={"email": "client@axiom.ai", "password": "client123"})
        assert cr.status_code == 200
        client_h = {"Authorization": f"Bearer {cr.json()['token']}",
                    "Content-Type": "application/json"}
        client_slug = f"colltest-{uuid.uuid4().hex[:6]}"
        rr = requests.put(f"{API}/share/slug", headers=client_h,
                          json={"slug": client_slug})
        assert rr.status_code == 200, rr.text
        # Now try to take client's slug as pro
        r = requests.put(f"{API}/share/slug",
                         headers=pro_headers, json={"slug": client_slug}, timeout=10)
        assert r.status_code == 409, f"expected 409, got {r.status_code} {r.text}"


# --------------------------------------------------------------------
# 3. buy_page_url on branding
# --------------------------------------------------------------------
class TestBuyPageUrl:
    def test_set_buy_page_url_updates_share_link(self, pro_headers):
        buy_url = "https://priyabooks.com/pricing"
        r = requests.patch(f"{API}/pro/branding",
                           headers=pro_headers,
                           json={"buy_page_url": buy_url}, timeout=10)
        assert r.status_code == 200, r.text
        share = requests.get(f"{API}/share", headers=pro_headers).json()
        assert share["link_source"] == "firm_buy_page"
        assert share["buy_page_url"] == buy_url
        assert share["link"].startswith(buy_url)
        assert f"ref={share['slug']}" in share["link"]

    def test_clear_buy_page_url_falls_back_to_platform(self, pro_headers):
        r = requests.patch(f"{API}/pro/branding",
                           headers=pro_headers,
                           json={"buy_page_url": ""}, timeout=10)
        assert r.status_code == 200
        share = requests.get(f"{API}/share", headers=pro_headers).json()
        assert share["link_source"] in ("platform", "firm_subdomain")
        assert share["buy_page_url"] == ""

    @pytest.mark.parametrize("bad", [
        "not-a-url",
        "ftp://x.com",
        "https://" + ("a" * 500) + ".com",  # >500 chars
    ])
    def test_invalid_buy_page_url_400(self, pro_headers, bad):
        r = requests.patch(f"{API}/pro/branding",
                           headers=pro_headers,
                           json={"buy_page_url": bad}, timeout=10)
        assert r.status_code == 400, f"expected 400 for {bad!r}, got {r.status_code}"


# --------------------------------------------------------------------
# 4. Public /share/lookup
# --------------------------------------------------------------------
class TestShareLookup:
    def test_lookup_known_slug_no_auth(self, pro_headers):
        slug = requests.get(f"{API}/share", headers=pro_headers).json()["slug"]
        r = requests.get(f"{API}/share/lookup", params={"ref": slug}, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "name" in d
        assert "firm_name" in d
        assert "firm_subdomain" in d
        assert d["name"]  # non-empty

    def test_lookup_unknown_slug_404(self):
        r = requests.get(f"{API}/share/lookup",
                         params={"ref": "no-such-slug-xyz-99999"}, timeout=10)
        assert r.status_code == 404


# --------------------------------------------------------------------
# 5. /share/referrals + seeded row
# --------------------------------------------------------------------
class TestReferralsList:
    def test_referrals_shape(self, pro_headers):
        r = requests.get(f"{API}/share/referrals", headers=pro_headers, timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert "referrals" in d
        assert isinstance(d["referrals"], list)

    def test_seeded_referred_user_appears(self, pro_headers, pro_user_id):
        """Seed a user with referred_by_user_id=pro's id + a referral_earnings row.
        Verify it appears in the list with status='paying'.
        """
        from db import db

        seeded_uid = f"TEST_ref_{uuid.uuid4().hex[:8]}"
        seeded_email = f"TEST_referred_{uuid.uuid4().hex[:6]}@example.com"
        earn_id = str(uuid.uuid4())
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()

        async def _seed():
            await db.users.insert_one({
                "id": seeded_uid,
                "email": seeded_email,
                "name": "TEST Referred User",
                "role": "client",
                "referred_by_user_id": pro_user_id,
                "created_at": now_iso,
            })
            await db.referral_earnings.insert_one({
                "id": earn_id,
                "platform_payment_id": f"TEST_pay_{uuid.uuid4().hex[:6]}",
                "referrer_user_id": pro_user_id,
                "referred_user_id": seeded_uid,
                "gross_cents": 7900,
                "share_bps": 1899,
                "share_cents": 1500,
                "currency": "usd",
                "status": "accrued",
                "created_at": now_iso,
            })

        async def _cleanup():
            await db.users.delete_one({"id": seeded_uid})
            await db.referral_earnings.delete_one({"id": earn_id})

        try:
            asyncio.get_event_loop().run_until_complete(_seed())
            r = requests.get(f"{API}/share/referrals", headers=pro_headers, timeout=10)
            assert r.status_code == 200
            rows = r.json()["referrals"]
            match = [x for x in rows if x["user_id"] == seeded_uid]
            assert match, f"seeded user not found in referrals list"
            row = match[0]
            assert row["status"] == "paying"
            assert row["payments"] == 1
            assert row["earned_cents"] == 1500
            assert row["email"] == seeded_email
        finally:
            asyncio.get_event_loop().run_until_complete(_cleanup())


# --------------------------------------------------------------------
# 6. /share/report
# --------------------------------------------------------------------
class TestShareReport:
    def test_report_default_window_shape(self, pro_headers):
        r = requests.get(f"{API}/share/report", headers=pro_headers, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("start", "end", "totals", "lines"):
            assert k in d
        for k in ("invoice_count", "gross_cents", "accrued_cents",
                  "paid_out_cents", "total_cents"):
            assert k in d["totals"]
        assert isinstance(d["lines"], list)

    def test_report_custom_window_with_seeded_row(self, pro_headers, pro_user_id):
        from db import db

        seeded_uid = f"TEST_rpt_{uuid.uuid4().hex[:8]}"
        earn_id = str(uuid.uuid4())
        now = dt.datetime.now(dt.timezone.utc)
        start = (now - dt.timedelta(hours=1)).isoformat()
        end = (now + dt.timedelta(hours=1)).isoformat()
        created = now.isoformat()

        async def _seed():
            await db.users.insert_one({
                "id": seeded_uid, "email": f"TEST_r_{uuid.uuid4().hex[:6]}@ex.com",
                "name": "TEST", "role": "client",
                "referred_by_user_id": pro_user_id, "created_at": created,
            })
            await db.referral_earnings.insert_one({
                "id": earn_id,
                "platform_payment_id": f"TEST_pay_{uuid.uuid4().hex[:6]}",
                "referrer_user_id": pro_user_id,
                "referred_user_id": seeded_uid,
                "gross_cents": 9500, "share_bps": 2105, "share_cents": 2000,
                "currency": "usd", "status": "accrued", "created_at": created,
            })

        async def _cleanup():
            await db.users.delete_one({"id": seeded_uid})
            await db.referral_earnings.delete_one({"id": earn_id})

        try:
            asyncio.get_event_loop().run_until_complete(_seed())
            r = requests.get(f"{API}/share/report",
                             headers=pro_headers,
                             params={"start": start, "end": end}, timeout=10)
            assert r.status_code == 200
            d = r.json()
            match = [l for l in d["lines"] if l["share_cents"] == 2000
                     and l["gross_cents"] == 9500]
            assert match, f"seeded earning not in lines: {d['lines']}"
            assert d["totals"]["invoice_count"] >= 1
        finally:
            asyncio.get_event_loop().run_until_complete(_cleanup())


# --------------------------------------------------------------------
# 7. Tier lookup — direct helper unit test
# --------------------------------------------------------------------
class TestPayoutTiers:
    @pytest.mark.parametrize("gross,expected", [
        (3800, (700, 1842)),
        (7900, (1500, 1899)),
        (9500, (2000, 2105)),
        (14900, (3000, 2013)),
        (5000, (1000, 2000)),  # fallback: 20% of 5000
    ])
    def test_lookup_payout_cents(self, gross, expected):
        from routes.stripe_billing import _lookup_payout_cents
        assert _lookup_payout_cents(gross) == expected


# --------------------------------------------------------------------
# 8. End-to-end: _credit_referral_share uses tier lookup
# --------------------------------------------------------------------
class TestCreditReferralShare:
    def test_credits_tiered_amount(self, pro_user_id):
        from db import db
        from routes.stripe_billing import _credit_referral_share

        payer_uid = f"TEST_payer_{uuid.uuid4().hex[:8]}"
        payment_id = f"TEST_pay_{uuid.uuid4().hex[:8]}"
        invoice = {"id": f"in_TEST_{uuid.uuid4().hex[:6]}",
                   "amount_paid": 7900, "currency": "usd"}
        payer = {"id": payer_uid, "referred_by_user_id": pro_user_id}

        async def _run():
            await _credit_referral_share(
                payment_id=payment_id, invoice=invoice, payer_user=payer,
            )
            doc = await db.referral_earnings.find_one({
                "platform_payment_id": payment_id,
                "referrer_user_id": pro_user_id,
            })
            return doc

        async def _cleanup():
            await db.referral_earnings.delete_many({"platform_payment_id": payment_id})

        try:
            doc = asyncio.get_event_loop().run_until_complete(_run())
            assert doc is not None, "no earnings row created"
            assert doc["share_cents"] == 1500, \
                f"expected tier payout 1500, got {doc['share_cents']}"
            assert doc["gross_cents"] == 7900
            assert doc["share_bps"] == 1899
        finally:
            asyncio.get_event_loop().run_until_complete(_cleanup())
