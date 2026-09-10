"""Tests for the 5 Client Cockpit Cards endpoints (iter 93)."""
import os
import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()).rstrip("/")
CID = "cc23a18f-4ac0-4cf3-9d33-95bc540351a0"  # Category Test 1 LLC


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@axiom.ai", "password": "admin123"},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}"}


def test_waiting_on_client(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/waiting-on-client",
                     headers=headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "threads" in data and "counts" in data
    counts = data["counts"]
    for k in ("total", "email", "portal", "meeting", "stale_7d"):
        assert k in counts, f"missing counts.{k}"
    assert isinstance(data["threads"], list)


def test_waiting_channel_filter(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/waiting-on-client",
                     headers=headers, params={"channel": "portal"}, timeout=30)
    assert r.status_code == 200
    for row in r.json()["threads"]:
        assert row["channel"] == "portal"


def test_waiting_q_filter(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/waiting-on-client",
                     headers=headers, params={"q": "zzzxxnoresult123"}, timeout=30)
    assert r.status_code == 200
    assert r.json()["counts"]["total"] == 0


def test_client_answers(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/client-answers",
                     headers=headers, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert "threads" in data and "counts" in data
    for k in ("total", "needs_review", "reviewed"):
        assert k in data["counts"]


def test_client_answers_review_state(headers):
    for st in ("all", "needs_review", "reviewed"):
        r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/client-answers",
                         headers=headers, params={"review_state": st}, timeout=30)
        assert r.status_code == 200, f"review_state={st}: {r.text}"


def test_cashflow_snapshot(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/cashflow-snapshot",
                     headers=headers, timeout=60)
    assert r.status_code == 200, r.text
    data = r.json()
    for k in ("health", "cash_today", "runway_days", "snapshots",
             "burn_reconciliation", "biggest_events", "open_link"):
        assert k in data, f"missing {k}"
    assert data["health"] in ("healthy", "warning", "critical")
    assert data["open_link"] == "/accounting/projections"
    # Health-runway invariant
    rw = data["runway_days"]
    h = data["health"]
    if rw is None or rw > 120:
        assert h == "healthy"
    elif rw <= 60:
        assert h == "critical"
    else:
        assert h == "warning"


def test_assigned_agents(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/assigned-agents",
                     headers=headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "client_agents" in data and "firm_agents" in data
    for k in ("client_total", "client_enabled", "firm_total", "firm_enabled"):
        assert k in data["counts"]
    assert isinstance(data["client_agents"], list)
    assert isinstance(data["firm_agents"], list)


def test_followup_empty_message(headers):
    # First find a pending thread
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/waiting-on-client",
                     headers=headers, timeout=30)
    threads = r.json()["threads"]
    if not threads:
        pytest.skip("no pending threads to test followup")
    qid = threads[0]["id"]
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/threads/{qid}/followup",
                      headers=headers, json={"message": "   "}, timeout=30)
    assert r.status_code == 400


def test_followup_success_and_answered_reject(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/waiting-on-client",
                     headers=headers, timeout=30)
    threads = r.json()["threads"]
    if not threads:
        pytest.skip("no pending threads")
    qid = threads[0]["id"]
    prev_count = threads[0]["chat_msg_count"]
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/threads/{qid}/followup",
                      headers=headers, json={"message": "TEST_ followup nudge"}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["chat_msg_count"] == prev_count + 1

    # Answered-thread rejection
    ans = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/client-answers",
                       headers=headers, timeout=30).json()["threads"]
    if ans:
        r2 = requests.post(
            f"{BASE_URL}/api/companies/{CID}/cockpit-cards/threads/{ans[0]['id']}/followup",
            headers=headers, json={"message": "should reject"}, timeout=30)
        assert r2.status_code == 400


def test_followup_404(headers):
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/threads/does-not-exist/followup",
                      headers=headers, json={"message": "hi"}, timeout=30)
    assert r.status_code == 404
