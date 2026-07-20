"""Iteration 44 — AI Onboarding Coach extraction for steps 1-6.

Tests POST /api/companies/{cid}/onboarding/extract-step across the
new step schemas: qbo_link, coa_overrides, plaid_intent, veryfi_intent,
ready_confirm — plus edge cases (unknown step, empty message).
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

CLIENT2 = {"email": "client2@axiom.ai", "password": "client123"}


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{BASE_URL}/api/auth/login", json=CLIENT2, timeout=30)
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    # Find Bright Beans company id
    cr = requests.get(f"{BASE_URL}/api/companies",
                      headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert cr.status_code == 200, cr.text
    companies = cr.json().get("companies", []) or cr.json()
    if isinstance(companies, dict):
        companies = companies.get("companies", [])
    bright = next((c for c in companies if "Bright" in (c.get("name") or "")), None)
    assert bright, f"Bright Beans not found in {companies}"
    return {"token": token, "cid": bright["id"]}


def _extract(auth, step, message):
    r = requests.post(
        f"{BASE_URL}/api/companies/{auth['cid']}/onboarding/extract-step",
        headers={"Authorization": f"Bearer {auth['token']}"},
        json={"step": step, "message": message},
        timeout=60,
    )
    return r


# ---- qbo_link ----
def test_qbo_link_yes(auth):
    r = _extract(auth, "qbo_link", "Yes we already use QuickBooks Online")
    assert r.status_code == 200, r.text
    fields = r.json()["fields"]
    assert fields.get("qbo") == "yes", fields


def test_qbo_link_no(auth):
    r = _extract(auth, "qbo_link", "No, starting fresh")
    assert r.status_code == 200, r.text
    fields = r.json()["fields"]
    assert fields.get("qbo") == "no", fields


def test_qbo_link_ambiguous(auth):
    r = _extract(auth, "qbo_link", "hmm not sure yet")
    assert r.status_code == 200, r.text
    fields = r.json()["fields"]
    # ambiguous → must NOT trigger auto-advance (i.e. not 'yes' or 'no')
    assert fields.get("qbo") not in ("yes", "no"), fields


# ---- coa_overrides ----
def test_coa_overrides(auth):
    r = _extract(
        auth, "coa_overrides",
        "add a food-truck fuel account and drop consulting revenue",
    )
    assert r.status_code == 200, r.text
    f = r.json()["fields"]
    add_str = " ".join(f.get("add_hints", []) or []).lower()
    rm_str = " ".join(f.get("remove_hints", []) or []).lower()
    assert "food" in add_str or "fuel" in add_str, f
    assert "consult" in rm_str, f


# ---- plaid_intent ----
def test_plaid_skip(auth):
    r = _extract(auth, "plaid_intent", "skip this for now")
    assert r.status_code == 200, r.text
    assert r.json()["fields"].get("skip") is True, r.json()


def test_plaid_institution(auth):
    r = _extract(auth, "plaid_intent", "we bank with Chase")
    assert r.status_code == 200, r.text
    hint = (r.json()["fields"].get("institution_hint") or "").lower()
    assert "chase" in hint, r.json()


# ---- veryfi_intent ----
def test_veryfi_skip(auth):
    r = _extract(auth, "veryfi_intent", "skip, no old statements")
    assert r.status_code == 200, r.text
    assert r.json()["fields"].get("skip") is True, r.json()


# ---- ready_confirm ----
def test_ready_confirm_lets_go(auth):
    r = _extract(auth, "ready_confirm", "let's go")
    assert r.status_code == 200, r.text
    assert r.json()["fields"].get("confirm") is True, r.json()


def test_ready_confirm_yep_ready(auth):
    r = _extract(auth, "ready_confirm", "yep, ready")
    assert r.status_code == 200, r.text
    assert r.json()["fields"].get("confirm") is True, r.json()


# ---- edge cases ----
def test_unknown_step_returns_400(auth):
    r = _extract(auth, "not_a_step", "hello")
    assert r.status_code == 400, r.text


def test_empty_message_returns_200_empty_fields(auth):
    r = _extract(auth, "qbo_link", "")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("fields") == {}, body


# ---- Regression: step 0 business_profile still works ----
def test_business_profile_regression(auth):
    r = _extract(
        auth, "business_profile",
        "We are an LLC doing IT security consulting for hospitals, cash basis",
    )
    assert r.status_code == 200, r.text
    f = r.json()["fields"]
    assert (f.get("business_type") or "").upper().startswith("LLC"), f
    assert (f.get("accounting_method") or "").lower() == "cash", f
    assert "consult" in (f.get("industry") or f.get("business_description") or "").lower(), f


# ---- Reset onboarding to step 0 for the frontend E2E that follows ----
def test_reset_onboarding_state(auth):
    r = requests.patch(
        f"{BASE_URL}/api/companies/{auth['cid']}/onboarding",
        headers={"Authorization": f"Bearer {auth['token']}"},
        json={"step": 0, "complete": False, "answers": {}},
        timeout=30,
    )
    assert r.status_code == 200, r.text
