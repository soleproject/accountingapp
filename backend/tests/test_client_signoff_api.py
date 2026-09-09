"""Phase 4B — Client Sign-off Loop API integration tests.

Hits the public preview URL end-to-end. Uses the seeded Bright Beans
portal token and the pro account to validate:
  - GET /api/portal/{token} exposes pending_signoffs
  - POST /api/portal/{token}/signoff/{rid} approve/reject flows
  - POST /api/portal/{token}/signoff/{rid}/questions flow + validation
  - GET /api/cockpit/close-board surfaces client_signoff on card
  - GET /api/cockpit/today includes signoff_client items
"""
import os
import uuid
from datetime import datetime, timezone

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
PORTAL_TOKEN = "eitPZGXUabOzlDhy0-TOi9SapCfUuXBQ"
BRIGHT_BEANS_CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"


# --- helpers ---------------------------------------------------------------

def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    return body.get("token") or body.get("access_token")


@pytest.fixture(scope="module")
def pro_token():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def pro_headers(pro_token):
    return {"Authorization": f"Bearer {pro_token}"}


# --- 1. Portal exposes pending_signoffs ------------------------------------

def test_portal_home_shape():
    r = requests.get(f"{BASE_URL}/api/portal/{PORTAL_TOKEN}", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "pending_signoffs" in body
    assert isinstance(body["pending_signoffs"], list)
    # Bright Beans has 2026-01 sent-to-client, so at least 1 pending unless already approved.
    # We only check shape / types here; approve test below flips it.
    for item in body["pending_signoffs"]:
        assert {"report_id", "period", "status"}.issubset(item.keys())
        assert item["status"] == "awaiting_approval"


# --- 2. Ensure clean starting state + trigger a sendable report ------------

def _ensure_sent_report(pro_headers):
    """Return a report_id for period 2026-01 on Bright Beans that is sent to
    client and NOT yet signed off. Regenerate + resend if needed."""
    # Reset signoff state via direct API: regenerate report (creates new rid),
    # then send-to-portal.
    r = requests.post(
        f"{BASE_URL}/api/companies/{BRIGHT_BEANS_CID}/advisor-reports/generate",
        headers=pro_headers,
        params={"ym": "2026-01", "basis": "accrual"},
        timeout=90,
    )
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    r2 = requests.post(
        f"{BASE_URL}/api/companies/{BRIGHT_BEANS_CID}/advisor-reports/{rid}/send-to-portal",
        headers=pro_headers,
        params={"to_email": "owner@brightbeans.example"},
        timeout=30,
    )
    assert r2.status_code == 200, r2.text
    return rid


@pytest.fixture(scope="module")
def fresh_report_id(pro_headers):
    return _ensure_sent_report(pro_headers)


def test_pending_signoff_after_send(fresh_report_id):
    r = requests.get(f"{BASE_URL}/api/portal/{PORTAL_TOKEN}", timeout=30)
    body = r.json()
    rids = [s["report_id"] for s in body["pending_signoffs"]]
    assert fresh_report_id in rids
    match = next(s for s in body["pending_signoffs"] if s["report_id"] == fresh_report_id)
    assert match["period"] == "2026-01"
    assert "kpis" in match
    assert "narrative" in match


# --- 3. 400 when report not sent -------------------------------------------

def test_approve_rejects_unsent_report(pro_headers):
    # Generate a fresh report but DO NOT send it.
    r = requests.post(
        f"{BASE_URL}/api/companies/{BRIGHT_BEANS_CID}/advisor-reports/generate",
        headers=pro_headers,
        params={"ym": "2025-11", "basis": "accrual"},
        timeout=90,
    )
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    resp = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{rid}",
        json={"note": "LGTM"},
        timeout=30,
    )
    assert resp.status_code == 400, resp.text


# --- 4. 404 for foreign report ---------------------------------------------

def test_approve_rejects_foreign_report():
    fake_rid = str(uuid.uuid4())
    resp = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{fake_rid}",
        json={"note": "hi"},
        timeout=30,
    )
    assert resp.status_code == 404


# --- 5. Empty question -> 400 ----------------------------------------------

def test_question_rejects_empty(fresh_report_id):
    resp = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{fresh_report_id}/questions",
        json={"question": "   "},
        timeout=30,
    )
    assert resp.status_code == 400


# --- 6. Question flow -> questioned + today feed red -----------------------

def _fresh_current_month_report(pro_headers, period):
    r = requests.post(
        f"{BASE_URL}/api/companies/{BRIGHT_BEANS_CID}/advisor-reports/generate",
        headers=pro_headers, params={"ym": period, "basis": "accrual"}, timeout=90,
    )
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    r2 = requests.post(
        f"{BASE_URL}/api/companies/{BRIGHT_BEANS_CID}/advisor-reports/{rid}/send-to-portal",
        headers=pro_headers, params={"to_email": "owner@brightbeans.example"}, timeout=30,
    )
    assert r2.status_code == 200, r2.text
    return rid


def _current_ym():
    n = datetime.now(timezone.utc)
    return f"{n.year:04d}-{n.month:02d}"


def test_question_flow_and_today_red(fresh_report_id, pro_headers):
    # First — test the questioned status on the seeded 2026-01 report.
    resp = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{fresh_report_id}/questions",
        json={"question": "Why is marketing so high?"},
        timeout=30,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "questioned"
    assert body["question_id"]

    # For the today feed we need a report in the CURRENT period (server only
    # surfaces prior + current month in the today feed).
    period = _current_ym()
    rid = _fresh_current_month_report(pro_headers, period)
    q = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{rid}/questions",
        json={"question": f"Why is marketing so high in {period}?"},
        timeout=30,
    )
    assert q.status_code == 200, q.text

    tf = requests.get(f"{BASE_URL}/api/cockpit/today", headers=pro_headers, timeout=30)
    assert tf.status_code == 200, tf.text
    items = tf.json().get("items", [])
    matched = [i for i in items if i.get("source") == "signoff_client"
               and i.get("company_id") == BRIGHT_BEANS_CID]
    assert any(i.get("urgency") == "red" for i in matched), (
        f"No red signoff_client item found for Bright Beans in {period}. matched={matched}"
    )


# --- 7. Approve flow -> pending clears, close-board green, today blue ------

def test_approve_flow(fresh_report_id, pro_headers):
    resp = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{fresh_report_id}",
        json={"note": "LGTM"},
        timeout=30,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "approved", "period": "2026-01"}

    # portal_home no longer lists this rid
    home = requests.get(f"{BASE_URL}/api/portal/{PORTAL_TOKEN}", timeout=30).json()
    rids = [s["report_id"] for s in home["pending_signoffs"]]
    assert fresh_report_id not in rids

    # close-board card has client_signoff.status=approved
    cb = requests.get(
        f"{BASE_URL}/api/cockpit/close-board?period=2026-01",
        headers=pro_headers, timeout=30,
    )
    assert cb.status_code == 200, cb.text
    cards = cb.json().get("cards") or cb.json().get("companies") or []
    bb = next((c for c in cards if c.get("company_id") == BRIGHT_BEANS_CID or c.get("id") == BRIGHT_BEANS_CID), None)
    assert bb is not None, f"Bright Beans card not found. cards ids: {[c.get('company_id') or c.get('id') for c in cards]}"
    assert bb.get("client_signoff", {}).get("status") == "approved", bb.get("client_signoff")
    assert bb["client_signoff"].get("approved_at")

    # For today feed blue, approve a fresh CURRENT-month report.
    period = _current_ym()
    rid = _fresh_current_month_report(pro_headers, period)
    a = requests.post(
        f"{BASE_URL}/api/portal/{PORTAL_TOKEN}/signoff/{rid}",
        json={"note": "LGTM"}, timeout=30,
    )
    assert a.status_code == 200, a.text

    tf = requests.get(f"{BASE_URL}/api/cockpit/today", headers=pro_headers, timeout=30)
    items = tf.json().get("items", [])
    matched = [i for i in items if i.get("source") == "signoff_client"
               and i.get("company_id") == BRIGHT_BEANS_CID]
    assert any(i.get("urgency") == "blue" for i in matched), (
        f"No blue signoff_client item. matched={matched}"
    )
