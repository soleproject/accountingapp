"""Cockpit API endpoint tests — Phase 1.

Covers accessible-companies gating, Today feed shape+filtering,
Close Board shape, and drag-drop advance semantics."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")

PRO = {"email": "pro@axiom.ai", "password": "pro123"}
CLIENT = {"email": "client@axiom.ai", "password": "client123"}


def _login(creds):
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=30)
    assert r.status_code == 200, f"login failed for {creds['email']}: {r.status_code} {r.text[:200]}"
    return r.json().get("token") or r.json().get("access_token")


@pytest.fixture(scope="module")
def pro_token():
    return _login(PRO)


@pytest.fixture(scope="module")
def client_token():
    return _login(CLIENT)


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


# -- Access gating -----------------------------------------------------------

def test_accessible_companies_pro_ok(pro_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/accessible-companies", headers=_h(pro_token), timeout=30)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert "companies" in data
    assert isinstance(data["companies"], list)
    assert len(data["companies"]) >= 1
    c0 = data["companies"][0]
    assert "id" in c0 and "name" in c0


def test_accessible_companies_client_forbidden(client_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/accessible-companies", headers=_h(client_token), timeout=30)
    assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text[:300]}"
    body = r.json()
    detail = body.get("detail") or body.get("message") or ""
    assert "cross-client" in detail.lower() or "one book" in detail.lower(), f"unexpected msg: {detail}"


# -- Today feed --------------------------------------------------------------

def test_today_shape(pro_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/today", headers=_h(pro_token), timeout=60)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert "items" in data and "counts_by_urgency" in data and "counts_by_source" in data
    assert isinstance(data["items"], list)
    for it in data["items"][:5]:
        for k in ("id", "source", "company_id", "company_name", "urgency", "title",
                  "subtitle", "action_label", "action_route", "created_at"):
            assert k in it, f"missing key {k} in item {it}"
        assert it["urgency"] in {"red", "amber", "blue", "grey"}


def test_today_filter_urgency(pro_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/today?urgency=red", headers=_h(pro_token), timeout=60)
    assert r.status_code == 200
    data = r.json()
    for it in data["items"]:
        assert it["urgency"] == "red"


# -- Close Board -------------------------------------------------------------

VALID_PHASES = {"not_started", "cleanup", "reconciling", "adjusting",
                "client_review", "ready_to_close", "closed"}


def test_close_board_shape(pro_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/close-board?period=2026-01",
                     headers=_h(pro_token), timeout=90)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert "cards" in data and "summary" in data
    s = data["summary"]
    assert "by_phase" in s and "overdue_count" in s and "at_risk_count" in s and "total" in s
    if data["cards"]:
        c = data["cards"][0]
        for k in ("company_id", "company_name", "period", "phase", "phase_pct",
                  "close_score", "deadline_iso", "days_to_deadline",
                  "top_blockers", "portal_pending", "quick_actions"):
            assert k in c, f"missing {k}"
        assert c["phase"] in VALID_PHASES
        assert 0 <= c["phase_pct"] <= 100
        assert 0 <= c["close_score"] <= 100


def test_close_board_advance_non_closed_ok(pro_token):
    # Get a card first
    r = requests.get(f"{BASE_URL}/api/cockpit/close-board?period=2026-01",
                     headers=_h(pro_token), timeout=90)
    cards = r.json().get("cards") or []
    if not cards:
        pytest.skip("no cards to advance")
    # pick a non-closed card
    tgt = next((c for c in cards if c["phase"] != "closed"), None)
    if not tgt:
        pytest.skip("all cards closed")
    payload = {"company_id": tgt["company_id"], "period": "2026-01", "to_phase": "cleanup"}
    r2 = requests.post(f"{BASE_URL}/api/cockpit/close-board/advance",
                       headers=_h(pro_token), json=payload, timeout=60)
    assert r2.status_code == 200, r2.text[:300]
    body = r2.json()
    assert body.get("ok") is True
    assert "card" in body and body["card"]["company_id"] == tgt["company_id"]


def test_close_board_advance_closed_with_blockers_returns_409(pro_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/close-board?period=2026-01",
                     headers=_h(pro_token), timeout=90)
    cards = r.json().get("cards") or []
    # find a card with unmet pre-checkpoints (phase_pct < 100 guarantees at least one pre-check open)
    tgt = next((c for c in cards
                if c["phase"] not in ("ready_to_close", "closed", "client_review")
                and c["phase_pct"] < 80), None)
    if not tgt:
        pytest.skip("no card with unmet pre-checkpoints")
    payload = {"company_id": tgt["company_id"], "period": "2026-01", "to_phase": "closed"}
    r2 = requests.post(f"{BASE_URL}/api/cockpit/close-board/advance",
                       headers=_h(pro_token), json=payload, timeout=60)
    assert r2.status_code == 409, f"expected 409, got {r2.status_code}: {r2.text[:300]}"
    detail = r2.json().get("detail") or {}
    assert "blockers" in detail
    assert isinstance(detail["blockers"], list) and len(detail["blockers"]) >= 1


def test_today_client_forbidden(client_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/today", headers=_h(client_token), timeout=30)
    assert r.status_code == 403


def test_close_board_client_forbidden(client_token):
    r = requests.get(f"{BASE_URL}/api/cockpit/close-board?period=2026-01",
                     headers=_h(client_token), timeout=30)
    assert r.status_code == 403
