"""Tests for Affiliate Sales Center (leads routing, center, toolkit, admin editor, cron drips).

Covers:
- POST /api/public/leads routing by role + firm context (avery-affiliate → axiompartners)
- GET /api/affiliate/center payload shape for affiliate@axiom.ai
- /api/affiliate/leads CRUD (manual lead, patch, activity)
- /api/affiliate/toolkit and /api/admin/affiliate/toolkit editor
- /api/admin/affiliate/settings (walkthrough booking slug)
- /api/public/affiliate-program (payouts + faq)
- /api/cron/affiliate-drips (auth, dry-run, preview, steps)
"""
import os
import uuid
import pytest
import requests

def _read_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not set")


BASE = _read_backend_url()
API = f"{BASE}/api"

ADMIN = ("admin@axiom.ai", "admin123")
AFF   = ("affiliate@axiom.ai", "aff123")
PRO   = ("pro@axiom.ai", "pro123")


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed {email}: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def aff_token():
    return _login(*AFF)


@pytest.fixture(scope="module")
def pro_token():
    return _login(*PRO)


def _h(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# ---------- Public leads routing -----------------------------------------
class TestPublicLeads:
    def test_business_owner_with_firm_affiliate_returns_firm_contact(self):
        email = f"TEST_bo_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{API}/public/leads", json={
            "name": "Test Owner", "email": email, "role": "business_owner",
            "ref_slug": "avery-affiliate", "company_name": "Test Co",
            "variant": "owner",
        }, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ok"] is True
        assert d["next"] == "firm_contact", f"expected firm_contact got {d}"
        assert d.get("signup_url")

    def test_accounting_pro_without_slug_setting_returns_call(self, admin_token):
        # Ensure slug is empty first
        requests.put(f"{API}/admin/affiliate/settings",
                     headers=_h(admin_token),
                     json={"settings": {"walkthrough_booking_slug": ""}}, timeout=20)
        email = f"TEST_pro_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{API}/public/leads", json={
            "name": "Test Pro", "email": email, "role": "accounting_pro",
            "ref_slug": "avery-affiliate", "variant": "pro",
        }, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["next"] == "call", f"expected call got {d}"

    def test_accounting_pro_with_slug_set_returns_book(self, admin_token):
        # Find a valid booking slug
        s = requests.get(f"{API}/admin/affiliate/settings", headers=_h(admin_token), timeout=20).json()
        slugs = [b["slug"] for b in s.get("booking_slugs", [])]
        if not slugs:
            pytest.skip("No booking slugs configured")
        # Prefer alex-admin if present else first
        slug = "alex-admin" if "alex-admin" in slugs else slugs[0]
        put = requests.put(f"{API}/admin/affiliate/settings", headers=_h(admin_token),
                           json={"settings": {"walkthrough_booking_slug": slug}}, timeout=20)
        assert put.status_code == 200, put.text
        try:
            email = f"TEST_pro2_{uuid.uuid4().hex[:8]}@example.com"
            r = requests.post(f"{API}/public/leads", json={
                "name": "Test Pro2", "email": email, "role": "accounting_pro",
                "variant": "pro",
            }, timeout=20)
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["next"] == "book", f"expected book got {d}"
            assert d.get("booking_url") and f"/book/{slug}" in d["booking_url"]
        finally:
            # Reset
            requests.put(f"{API}/admin/affiliate/settings", headers=_h(admin_token),
                         json={"settings": {"walkthrough_booking_slug": ""}}, timeout=20)

    def test_invalid_role_rejected(self):
        r = requests.post(f"{API}/public/leads", json={
            "name": "X Y", "email": f"TEST_x_{uuid.uuid4().hex[:6]}@example.com",
            "role": "bogus",
        }, timeout=20)
        assert r.status_code in (400, 422), r.status_code


# ---------- Affiliate Center ---------------------------------------------
class TestAffiliateCenter:
    def test_center_shape(self, aff_token):
        r = requests.get(f"{API}/affiliate/center", headers=_h(aff_token), timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        for key in ("slug", "link", "links", "stats", "today", "pipeline", "counts", "stages"):
            assert key in d, f"missing {key}"
        for lk in ("my_link", "my_link_owner", "my_link_pro", "my_link_enterprise"):
            assert lk in d["links"]
        assert d["stages"] == ["new", "contacted", "signed_up", "trial_ending", "paying", "lost"]

    def test_lead_submitted_via_public_appears_in_pipeline(self, aff_token):
        email = f"TEST_pipe_{uuid.uuid4().hex[:8]}@example.com"
        requests.post(f"{API}/public/leads", json={
            "name": "Pipe Lead", "email": email, "role": "business_owner",
            "ref_slug": "avery-affiliate",
        }, timeout=20)
        r = requests.get(f"{API}/affiliate/center", headers=_h(aff_token), timeout=20)
        pipe = r.json()["pipeline"]
        match = [p for p in pipe if p["email"] == email.lower()]
        assert match, f"lead {email} not found in pipeline"
        assert match[0]["stage"] == "new"
        assert match[0].get("next") and "label" in match[0]["next"]


# ---------- Affiliate lead CRUD -----------------------------------------
class TestAffiliateLeadCRUD:
    def test_manual_lead_phone_only(self, aff_token):
        r = requests.post(f"{API}/affiliate/leads",
                          headers=_h(aff_token),
                          json={"name": "Phone Only", "phone": "+15555550123"}, timeout=20)
        assert r.status_code in (200, 201), r.text
        d = r.json()
        assert d["ok"] is True
        assert d["lead"]["source"] == "manual"

    def test_manual_lead_missing_email_and_phone(self, aff_token):
        r = requests.post(f"{API}/affiliate/leads",
                          headers=_h(aff_token),
                          json={"name": "No Contact"}, timeout=20)
        assert r.status_code == 400

    def test_patch_status_dead_moves_to_lost(self, aff_token):
        # Create a lead
        em = f"TEST_dead_{uuid.uuid4().hex[:8]}@example.com"
        c = requests.post(f"{API}/affiliate/leads", headers=_h(aff_token),
                          json={"name": "To Die", "email": em}, timeout=20)
        lead_id = c.json()["lead"]["id"]
        p = requests.patch(f"{API}/affiliate/leads/{lead_id}", headers=_h(aff_token),
                           json={"status": "dead"}, timeout=20)
        assert p.status_code == 200, p.text
        # Verify in pipeline
        center = requests.get(f"{API}/affiliate/center", headers=_h(aff_token), timeout=20).json()
        row = next((r for r in center["pipeline"] if r["email"] == em.lower()), None)
        assert row and row["stage"] == "lost"

    def test_activity_text_flips_new_to_contacted(self, aff_token):
        em = f"TEST_act_{uuid.uuid4().hex[:8]}@example.com"
        c = requests.post(f"{API}/affiliate/leads", headers=_h(aff_token),
                          json={"name": "Act Lead", "email": em}, timeout=20)
        lead_id = c.json()["lead"]["id"]
        a = requests.post(f"{API}/affiliate/leads/{lead_id}/activity", headers=_h(aff_token),
                          json={"kind": "text"}, timeout=20)
        assert a.status_code == 200, a.text
        center = requests.get(f"{API}/affiliate/center", headers=_h(aff_token), timeout=20).json()
        row = next((r for r in center["pipeline"] if r["email"] == em.lower()), None)
        assert row and row["stage"] == "contacted"

    def test_other_affiliate_cannot_patch(self, aff_token, pro_token):
        em = f"TEST_cross_{uuid.uuid4().hex[:8]}@example.com"
        c = requests.post(f"{API}/affiliate/leads", headers=_h(aff_token),
                          json={"name": "Cross", "email": em}, timeout=20)
        lead_id = c.json()["lead"]["id"]
        r = requests.patch(f"{API}/affiliate/leads/{lead_id}", headers=_h(pro_token),
                           json={"status": "dead"}, timeout=20)
        assert r.status_code == 404

    def test_invalid_activity_kind(self, aff_token):
        em = f"TEST_invk_{uuid.uuid4().hex[:8]}@example.com"
        c = requests.post(f"{API}/affiliate/leads", headers=_h(aff_token),
                          json={"name": "Inv", "email": em}, timeout=20)
        lead_id = c.json()["lead"]["id"]
        r = requests.post(f"{API}/affiliate/leads/{lead_id}/activity", headers=_h(aff_token),
                          json={"kind": "bogus"}, timeout=20)
        assert r.status_code == 400


# ---------- Toolkit (affiliate view + admin editor) ----------------------
class TestToolkit:
    def test_affiliate_toolkit_shape(self, aff_token):
        r = requests.get(f"{API}/affiliate/toolkit", headers=_h(aff_token), timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        tk = d["toolkit"]
        for sec in ("pitches", "who_first", "templates", "objections", "social", "faq"):
            assert sec in tk, f"missing section {sec}"
        tpl_ids = {t["id"] for t in tk["templates"]}
        for tid in ("sms_first_owner", "sms_trial_ending", "email_intro_ask"):
            assert tid in tpl_ids
        for t in tk["templates"]:
            for k in ("channel", "stage", "audience", "body"):
                assert k in t, f"template {t.get('id')} missing {k}"
        ctx = d["ctx"]
        for k in ("my_link", "my_link_owner", "my_link_pro", "my_link_enterprise", "affiliate_name"):
            assert k in ctx
        assert isinstance(d.get("merge_fields"), list) and len(d["merge_fields"]) > 0

    def test_admin_get_toolkit(self, admin_token):
        r = requests.get(f"{API}/admin/affiliate/toolkit", headers=_h(admin_token), timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert "toolkit" in d and "defaults" in d and "overrides" in d

    def test_admin_put_toolkit_override_and_reset(self, admin_token, aff_token):
        # Override who_first
        put = requests.put(f"{API}/admin/affiliate/toolkit", headers=_h(admin_token),
                           json={"toolkit": {"who_first": [{"title": "X", "body": "Y"}]}}, timeout=20)
        assert put.status_code == 200, put.text
        # Affiliate sees the single custom item while other sections intact
        aff_view = requests.get(f"{API}/affiliate/toolkit", headers=_h(aff_token), timeout=20).json()
        assert len(aff_view["toolkit"]["who_first"]) == 1
        assert aff_view["toolkit"]["who_first"][0]["title"] == "X"
        assert len(aff_view["toolkit"]["pitches"]) >= 3  # defaults intact
        # Unknown section
        bad = requests.put(f"{API}/admin/affiliate/toolkit", headers=_h(admin_token),
                           json={"toolkit": {"nonexistent": [{"a": 1}]}}, timeout=20)
        assert bad.status_code == 400
        # Reset
        rst = requests.delete(f"{API}/admin/affiliate/toolkit/who_first",
                              headers=_h(admin_token), timeout=20)
        assert rst.status_code == 200
        aff_view2 = requests.get(f"{API}/affiliate/toolkit", headers=_h(aff_token), timeout=20).json()
        assert len(aff_view2["toolkit"]["who_first"]) == 5

    def test_admin_settings_invalid_slug(self, admin_token):
        r = requests.put(f"{API}/admin/affiliate/settings", headers=_h(admin_token),
                         json={"settings": {"walkthrough_booking_slug": "zzz-does-not-exist-xyz"}}, timeout=20)
        assert r.status_code == 400

    def test_non_superadmin_cannot_edit_toolkit(self, pro_token):
        r = requests.get(f"{API}/admin/affiliate/toolkit", headers=_h(pro_token), timeout=20)
        assert r.status_code == 403


# ---------- Public program & cron ----------------------------------------
class TestPublicProgramAndCron:
    def test_public_affiliate_program(self):
        r = requests.get(f"{API}/public/affiliate-program", timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert "payouts" in d and "faq" in d
        assert len(d["payouts"]) == 5
        pp = next((p for p in d["payouts"] if p["plan"] == "Practice Partner"), None)
        assert pp and pp["price_cents"] == 34900 and pp["payout_cents"] == 12500

    def test_cron_without_bearer(self):
        r = requests.post(f"{API}/cron/affiliate-drips", timeout=20)
        assert r.status_code == 401

    def test_cron_wrong_bearer(self):
        r = requests.post(f"{API}/cron/affiliate-drips",
                          headers={"Authorization": "Bearer wrong"}, timeout=20)
        assert r.status_code == 401

    def test_cron_steps(self, admin_token):
        r = requests.get(f"{API}/cron/affiliate-drips/steps", headers=_h(admin_token), timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert "A" in d and "B" in d

    def test_cron_trigger_dry_run(self, admin_token):
        r = requests.post(f"{API}/cron/affiliate-drips/trigger?dry=true",
                          headers=_h(admin_token), timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("a_considered", "a_sent", "b_considered", "b_sent", "plan"):
            assert k in d
        for p in d["plan"]:
            assert p["status"] in ("would_send", "no_template")

    def test_cron_preview_html(self, admin_token):
        r = requests.get(f"{API}/cron/affiliate-drips/preview?loop=A&step=a2_bank",
                         headers=_h(admin_token), timeout=20)
        assert r.status_code == 200
        assert "Subject:" in r.text

    def test_cron_preview_unknown_step(self, admin_token):
        r = requests.get(f"{API}/cron/affiliate-drips/preview?loop=A&step=zzz_fake",
                         headers=_h(admin_token), timeout=20)
        assert r.status_code == 404
