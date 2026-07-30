"""Iteration 54 — Plan comparison / white-label waitlist regression suite.

Covers:
- POST /api/pro/branding/whitelabel-waitlist as pro@axiom.ai → {joined: True}
- Persists ISO timestamp at users.branding.whitelabel_waitlist_at
- Idempotent — second call refreshes the timestamp
- Requires role pro/superadmin — 403 for client, 401 for anonymous
- Superadmin can call it too

Run: pytest /app/backend/tests/test_iter54_plan_comparison.py -v
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import time

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

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


def _login(email, password):
    r = requests.post(f"{API}/auth/login",
                      json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


def H(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _run(coro):
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _fetch_user_by_email(email: str) -> dict | None:
    from db import db
    return _run(db.users.find_one({"email": email.lower()}))


@pytest.fixture(scope="module")
def pro_token():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def client_token():
    return _login("client@axiom.ai", "client123")


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin@axiom.ai", "admin123")


class TestWhitelabelWaitlist:
    def test_pro_can_join_waitlist_and_persist(self, pro_token):
        r = requests.post(f"{API}/pro/branding/whitelabel-waitlist",
                          headers=H(pro_token), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"joined": True}, body

        u = _fetch_user_by_email("pro@axiom.ai")
        assert u is not None
        ts = (u.get("branding") or {}).get("whitelabel_waitlist_at")
        assert ts, f"whitelabel_waitlist_at not set: {u.get('branding')}"
        assert ISO_RE.match(str(ts)), f"not an ISO timestamp: {ts!r}"

    def test_repeat_call_refreshes_timestamp(self, pro_token):
        # First call
        r1 = requests.post(f"{API}/pro/branding/whitelabel-waitlist",
                           headers=H(pro_token), timeout=15)
        assert r1.status_code == 200
        u1 = _fetch_user_by_email("pro@axiom.ai")
        ts1 = (u1.get("branding") or {}).get("whitelabel_waitlist_at")
        assert ts1

        time.sleep(1.1)  # ensure clock advances at second resolution
        r2 = requests.post(f"{API}/pro/branding/whitelabel-waitlist",
                           headers=H(pro_token), timeout=15)
        assert r2.status_code == 200
        assert r2.json() == {"joined": True}
        u2 = _fetch_user_by_email("pro@axiom.ai")
        ts2 = (u2.get("branding") or {}).get("whitelabel_waitlist_at")
        assert ts2
        assert ts2 >= ts1, f"timestamp regressed: {ts1} → {ts2}"
        # Prefer strictly greater when clock moved
        assert ts2 != ts1, "timestamp did not refresh across calls"

    def test_client_forbidden(self, client_token):
        r = requests.post(f"{API}/pro/branding/whitelabel-waitlist",
                          headers=H(client_token), timeout=15)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text[:200]}"

    def test_anonymous_unauthorized(self):
        r = requests.post(f"{API}/pro/branding/whitelabel-waitlist",
                          headers={"Content-Type": "application/json"}, timeout=15)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_superadmin_can_call(self, admin_token):
        r = requests.post(f"{API}/pro/branding/whitelabel-waitlist",
                          headers=H(admin_token), timeout=15)
        assert r.status_code == 200, r.text
        assert r.json() == {"joined": True}
