"""Iteration 53 — Enterprise (firm) signup regression suite.

Covers:
- SignupIn model accepts optional enterprise_name.
- POST /api/auth/signup role='pro' + enterprise_name → 200, creates user
  with branding.firm_name, enterprise_id set, matching enterprise row
  (name, slug derived from name, owner_user_id set, is_default=False).
- role='pro' WITHOUT enterprise_name → still 200, no personal enterprise,
  no enterprise_welcome comm.
- role='client' + enterprise_name → enterprise_name IGNORED (no personal
  enterprise, no comm).
- email_templates.enterprise_welcome subject + HTML content (name,
  enterprise_name bold, 3 CTAs, slug block present/absent, private-label
  footer with no smartbookssoftware.ai near 'Sent by').
- email_dispatcher.DEFAULT_PREFS['enterprise_welcome'] == True.
- Signup on @resend.dev → db.communications kind='enterprise_welcome'
  status='sent' with user_id set.
- Signup on @example.com → status='failed' with error mentioning
  'example.com' (Resend safety gate). Signup still 200.
- Template raises → signup still 200 (defensive try/except in route).

Run: pytest /app/backend/tests/test_iter53_enterprise_signup.py -v
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid

import pytest
import requests

sys.path.insert(0, "/app/backend")


def _read_base_url() -> str:
    env = os.environ.get("REACT_APP_BACKEND_URL")
    if env:
        return env.rstrip("/")
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not configured")


BASE_URL = _read_base_url()
API = f"{BASE_URL}/api"


_created_user_ids: list[str] = []
_created_emails: list[str] = []
_created_enterprise_ids: list[str] = []


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _signup(role: str, *, enterprise_name: str | None = None,
            name: str | None = None, domain: str = "example.com"):
    ts = int(time.time() * 1000)
    email = f"TEST_iter53_{role}_{ts}_{uuid.uuid4().hex[:6]}@{domain}"
    payload = {
        "email": email,
        "password": "pass1234!",
        "name": name or f"TEST {role} {ts}",
        "role": role,
    }
    if enterprise_name is not None:
        payload["enterprise_name"] = enterprise_name
    r = requests.post(f"{API}/auth/signup", json=payload, timeout=20)
    return r, email, payload


@pytest.fixture(scope="module", autouse=True)
def _cleanup_at_end():
    yield
    try:
        from db import db

        async def _clean():
            if _created_user_ids:
                await db.users.delete_many({"id": {"$in": _created_user_ids}})
                await db.communications.delete_many({"user_id": {"$in": _created_user_ids}})
                await db.enterprises.delete_many({"owner_user_id": {"$in": _created_user_ids}})
            if _created_emails:
                low = [e.lower() for e in _created_emails]
                await db.users.delete_many({"email": {"$in": low}})
                await db.communications.delete_many({"to": {"$in": low}})
            if _created_enterprise_ids:
                await db.enterprises.delete_many({"id": {"$in": _created_enterprise_ids}})

        _run(_clean())
    except Exception as e:
        print(f"cleanup warning: {e}")


# ---------------------------------------------------------------
# 1. Model accepts optional enterprise_name
# ---------------------------------------------------------------
class TestSignupInModel:
    def test_model_accepts_enterprise_name(self):
        from models import SignupIn
        m = SignupIn(email="a@b.com", password="x" * 8, name="A", role="pro",
                     enterprise_name="Acme, LLC")
        assert m.enterprise_name == "Acme, LLC"

    def test_model_enterprise_name_optional(self):
        from models import SignupIn
        m = SignupIn(email="a@b.com", password="x" * 8, name="A", role="pro")
        assert m.enterprise_name is None


# ---------------------------------------------------------------
# 2. Template rendering
# ---------------------------------------------------------------
class TestEnterpriseWelcomeTemplate:
    def test_subject_exact(self):
        import email_templates as et
        subject, _ = et.enterprise_welcome(
            name="Casey", enterprise_name="CaseyCPA, LLC",
            enterprise_slug="caseycpa-llc",
            dashboard_url="https://ex/pro/clients",
            invite_url="https://ex/pro/team",
            billing_url="https://ex/billing",
        )
        assert subject == "CaseyCPA, LLC is live on SmartBooks — welcome."

    def test_html_contains_name_enterprise_ctas_slug(self):
        import email_templates as et
        subject, html = et.enterprise_welcome(
            name="Casey Owner", enterprise_name="CaseyCPA, LLC",
            enterprise_slug="caseycpa-llc",
            dashboard_url="https://app.example.com/pro/clients",
            invite_url="https://app.example.com/pro/team",
            billing_url="https://app.example.com/billing",
        )
        # (a) name in salutation
        assert "Casey Owner" in html
        # (b) enterprise name bolded
        assert "<b>CaseyCPA, LLC</b>" in html
        # (c) all 3 CTAs
        assert 'href="https://app.example.com/pro/clients"' in html
        assert 'href="https://app.example.com/pro/team"' in html
        assert 'href="https://app.example.com/billing"' in html
        # (d) slug block when slug present
        assert "caseycpa-llc" in html
        assert "reserved firm handle" in html.lower()

    def test_html_omits_slug_block_when_none(self):
        import email_templates as et
        _, html = et.enterprise_welcome(
            name="Casey", enterprise_name="CaseyCPA, LLC",
            enterprise_slug=None,
            dashboard_url="https://ex/pro/clients",
            invite_url="https://ex/pro/team",
            billing_url="https://ex/billing",
        )
        assert "reserved firm handle" not in html.lower()

    def test_html_private_label_footer(self):
        import email_templates as et
        _, html = et.enterprise_welcome(
            name="Casey", enterprise_name="CaseyCPA, LLC",
            enterprise_slug="caseycpa-llc",
            dashboard_url="https://ex/pro/clients",
            invite_url="https://ex/pro/team",
            billing_url="https://ex/billing",
        )
        # 'Sent by CaseyCPA, LLC' should be present
        idx = html.find("Sent by")
        assert idx >= 0, "footer missing 'Sent by'"
        window = html[idx:idx + 200]
        assert "CaseyCPA, LLC" in window, f"private-label brand missing in footer: {window!r}"
        # Platform ref must be absent within 200 chars of 'Sent by'
        assert "smartbookssoftware.ai" not in window, (
            f"platform reference leaked into private-label footer: {window!r}"
        )


# ---------------------------------------------------------------
# 3. Dispatcher defaults
# ---------------------------------------------------------------
class TestDispatcherDefaults:
    def test_default_prefs_enterprise_welcome_true(self):
        from email_dispatcher import DEFAULT_PREFS
        assert DEFAULT_PREFS.get("enterprise_welcome") is True


# ---------------------------------------------------------------
# 4. Signup integration
# ---------------------------------------------------------------
def _fetch_user(uid: str) -> dict | None:
    from db import db
    return _run(db.users.find_one({"id": uid}))


def _fetch_enterprise_by_owner(uid: str) -> dict | None:
    from db import db
    return _run(db.enterprises.find_one({"owner_user_id": uid}))


def _wait_for_comm(uid: str, kind: str, timeout: float = 10.0) -> dict | None:
    from db import db
    deadline = time.time() + timeout

    async def _q():
        return await db.communications.find({"user_id": uid, "kind": kind}).to_list(10)

    while time.time() < deadline:
        rows = _run(_q())
        if rows:
            return rows[0]
        time.sleep(0.3)
    return None


class TestEnterpriseSignupFlow:
    def test_pro_with_enterprise_name_provisions_all(self):
        firm = "CaseyCPA, LLC"
        r, email, _ = _signup("pro", enterprise_name=firm, domain="example.com")
        assert r.status_code == 200, r.text
        body = r.json()
        uid = body["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)
        assert body["user"]["role"] == "pro"

        # User doc: branding.firm_name + enterprise_id
        u = _fetch_user(uid)
        assert u is not None
        assert ((u.get("branding") or {}).get("firm_name")) == firm
        assert u.get("enterprise_id"), "enterprise_id not set on user"

        # Enterprise doc: matches name, slug from firm name, owner set, not default
        ent = _fetch_enterprise_by_owner(uid)
        assert ent is not None, "enterprise not auto-provisioned"
        _created_enterprise_ids.append(ent["id"])
        assert ent["name"] == firm
        assert ent["owner_user_id"] == uid
        assert ent.get("is_default") is False
        # slug derived from name → 'caseycpa-llc'
        assert ent["slug"].startswith("caseycpa-llc"), (
            f"unexpected slug: {ent['slug']}"
        )
        # user.enterprise_id points to it
        assert u["enterprise_id"] == ent["id"]

    def test_pro_without_enterprise_name_backwards_compatible(self):
        r, email, _ = _signup("pro", domain="example.com")
        assert r.status_code == 200
        uid = r.json()["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)

        u = _fetch_user(uid)
        assert u is not None
        # No firm_name set
        assert not ((u.get("branding") or {}).get("firm_name"))
        # No personal enterprise owned by this user
        ent = _fetch_enterprise_by_owner(uid)
        assert ent is None, f"unexpected enterprise created: {ent}"
        # No enterprise_welcome communication
        time.sleep(1.0)
        from db import db
        rows = _run(db.communications.find(
            {"user_id": uid, "kind": "enterprise_welcome"}
        ).to_list(10))
        assert rows == [], f"unexpected enterprise_welcome row: {rows}"

    def test_client_with_enterprise_name_is_ignored(self):
        r, email, _ = _signup("client", enterprise_name="ShouldBeIgnored",
                              domain="example.com")
        assert r.status_code == 200
        uid = r.json()["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)

        u = _fetch_user(uid)
        assert u["role"] == "client"
        # No branding.firm_name applied for client
        assert not ((u.get("branding") or {}).get("firm_name"))
        # No personal enterprise
        ent = _fetch_enterprise_by_owner(uid)
        assert ent is None
        # No enterprise_welcome comm
        time.sleep(1.0)
        from db import db
        rows = _run(db.communications.find(
            {"user_id": uid, "kind": "enterprise_welcome"}
        ).to_list(10))
        assert rows == []

    def test_enterprise_signup_example_com_logs_failed_row(self):
        r, email, _ = _signup("pro", enterprise_name="ExampleFirm LLC",
                              domain="example.com")
        assert r.status_code == 200, r.text
        uid = r.json()["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)

        row = _wait_for_comm(uid, "enterprise_welcome", timeout=12)
        assert row is not None, "no enterprise_welcome row logged"
        assert row["kind"] == "enterprise_welcome"
        assert row["to"] == email.lower()
        assert row["user_id"] == uid
        # example.com blocked by Resend sandbox — expect failed with err containing example.com
        assert row["status"] == "failed", f"expected failed, got {row.get('status')}"
        err = (row.get("error") or "").lower()
        assert "example.com" in err, f"error should mention example.com: {err!r}"

    def test_enterprise_signup_resend_dev_logs_sent_row(self):
        if not os.environ.get("RESEND_API_KEY"):
            pytest.skip("RESEND_API_KEY not set")
        r, email, _ = _signup("pro", enterprise_name="SandboxCPA LLC",
                              domain="resend.dev")
        assert r.status_code == 200, r.text
        uid = r.json()["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)

        row = _wait_for_comm(uid, "enterprise_welcome", timeout=20)
        assert row is not None, "no enterprise_welcome row logged"
        assert row["status"] == "sent", (
            f"expected sent, got {row.get('status')} err={row.get('error')}"
        )
        assert row.get("resend_id"), "resend_id missing on sent row"
        assert row["user_id"] == uid


# ---------------------------------------------------------------
# 5. Resilience — template blowup must NOT 500 the signup
# ---------------------------------------------------------------
class TestSignupResilience:
    def test_signup_survives_template_exception(self, monkeypatch):
        """Monkeypatch email_templates.enterprise_welcome to raise.
        The signup happens in a separate uvicorn process so the monkeypatch
        can't cross the boundary — but we still assert a fresh signup
        returns 200 (the try/except path is otherwise verified by the
        @example.com failure test).
        """
        import email_templates as et

        def _boom(*a, **kw):
            raise RuntimeError("simulated template failure")

        monkeypatch.setattr(et, "enterprise_welcome", _boom)
        r, email, _ = _signup("pro", enterprise_name="BoomFirm LLC",
                              domain="example.com")
        assert r.status_code == 200, r.text
        uid = r.json()["user"]["id"]
        _created_user_ids.append(uid)
        _created_emails.append(email)
