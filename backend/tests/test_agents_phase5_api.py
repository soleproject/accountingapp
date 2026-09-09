"""Cockpit Phase 5A — Agent Platform HTTP integration tests.

Hits the live preview URL (REACT_APP_BACKEND_URL) as an accounting Pro user
(pro@axiom.ai/pro123) and exercises every endpoint listed in the review
request:
  - GET  /api/cockpit/agents/templates    (6 canonical keys)
  - GET  /api/cockpit/agents              (list + wake-on-request tick)
  - POST /api/cockpit/agents              (create from template)
  - POST /api/cockpit/agents/{id}/run-now
  - GET  /api/cockpit/agents/{id}/runs
  - GET  /api/cockpit/agent-findings?status=open
  - PATCH /api/cockpit/agent-findings/{id} (resolve)
  - GET  /api/cockpit/today                (source=agent overlay)
  - PATCH /api/cockpit/agents/{id}         (disable)
  - DELETE /api/cockpit/agents/{id}        (cascade to runs + findings)
"""
import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = "pro@axiom.ai"
PASSWORD = "pro123"

EXPECTED_TEMPLATE_KEYS = {
    "cleanup_sweep", "je_auto_drafter", "advisor_report_send",
    "tax_1099_watcher", "portal_chase", "signoff_reminder",
}


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"Cannot login as {EMAIL}: {r.status_code} {r.text}")
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"login response missing token: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def client(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def company_id(client):
    r = client.get(f"{BASE}/api/cockpit/accessible-companies", timeout=20)
    assert r.status_code == 200, r.text
    companies = r.json().get("companies") or []
    assert companies, "pro user has no accessible companies"
    return companies[0]["id"]


# --- Templates -----------------------------------------------------------

def test_templates_returns_six_canonical(client):
    r = client.get(f"{BASE}/api/cockpit/agents/templates", timeout=20)
    assert r.status_code == 200, r.text
    tmpls = r.json().get("templates") or []
    keys = {t["key"] for t in tmpls}
    assert keys == EXPECTED_TEMPLATE_KEYS, keys
    for t in tmpls:
        assert "run" not in t  # callable must be stripped
        assert t.get("default_schedule") in {"hourly","daily","weekly","monthly","quarterly"}


# --- Full lifecycle: create → run-now → list runs → finding → today → disable → delete

@pytest.fixture(scope="module")
def created_agent(client, company_id):
    body = {
        "template_key": "cleanup_sweep",
        "company_id": company_id,
        "schedule": "daily",
        "config": {"min_uncategorized": 1},
        "enabled": True,
    }
    r = client.post(f"{BASE}/api/cockpit/agents", json=body, timeout=20)
    assert r.status_code == 200, r.text
    agent = r.json().get("agent")
    assert agent and agent.get("id")
    assert agent["template_key"] == "cleanup_sweep"
    assert agent["company_id"] == company_id
    assert agent["schedule"] == "daily"
    # default_config merged
    assert "min_uncategorized" in agent["config"]
    yield agent
    # Teardown: delete (idempotent)
    try:
        client.delete(f"{BASE}/api/cockpit/agents/{agent['id']}", timeout=20)
    except Exception:
        pass


def test_list_agents_includes_created(client, created_agent):
    r = client.get(f"{BASE}/api/cockpit/agents", timeout=30)
    assert r.status_code == 200, r.text
    ids = {a["id"] for a in r.json().get("agents", [])}
    assert created_agent["id"] in ids


def test_run_now_returns_ok_and_run_id(client, created_agent):
    r = client.post(f"{BASE}/api/cockpit/agents/{created_agent['id']}/run-now",
                    timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("ok") is True
    assert data.get("run_id")
    assert "findings_count" in data
    # Stash findings_count for downstream test
    pytest.findings_count = data["findings_count"]


def test_runs_lists_success(client, created_agent):
    r = client.get(f"{BASE}/api/cockpit/agents/{created_agent['id']}/runs", timeout=20)
    assert r.status_code == 200, r.text
    runs = r.json().get("runs") or []
    assert runs, "no runs after run-now"
    assert runs[0]["status"] == "success"
    assert runs[0]["agent_id"] == created_agent["id"]


def test_open_findings_visible_and_can_resolve(client, created_agent, company_id):
    fc = getattr(pytest, "findings_count", 0)
    if fc == 0:
        pytest.skip("No uncategorized txns on this company; findings_count=0")
    r = client.get(f"{BASE}/api/cockpit/agent-findings",
                   params={"status": "open"}, timeout=20)
    assert r.status_code == 200, r.text
    findings = r.json().get("findings") or []
    mine = [f for f in findings if f.get("agent_id") == created_agent["id"]]
    assert mine, "created agent's finding not in open list"
    fid = mine[0]["id"]
    title = mine[0]["title"]

    # today feed must surface source=agent card with matching title
    tr = client.get(f"{BASE}/api/cockpit/today", timeout=30)
    assert tr.status_code == 200, tr.text
    items = tr.json().get("items") or []
    agent_items = [i for i in items if i.get("source") == "agent"
                   and i.get("finding_id") == fid]
    assert agent_items, "agent finding not overlayed in today feed"
    assert agent_items[0]["title"] == title

    # resolve it
    pr = client.patch(f"{BASE}/api/cockpit/agent-findings/{fid}",
                      json={"status": "resolved"}, timeout=20)
    assert pr.status_code == 200, pr.text
    # gone from open list
    r2 = client.get(f"{BASE}/api/cockpit/agent-findings",
                    params={"status": "open"}, timeout=20)
    still = [f for f in (r2.json().get("findings") or []) if f["id"] == fid]
    assert not still, "resolved finding still appears in open list"


def test_disable_prevents_tick(client, created_agent):
    r = client.patch(f"{BASE}/api/cockpit/agents/{created_agent['id']}",
                     json={"enabled": False}, timeout=20)
    assert r.status_code == 200, r.text
    assert r.json()["agent"]["enabled"] is False
    # Sanity: calling today feed (which ticks) should not launch a new run
    prev_runs = client.get(f"{BASE}/api/cockpit/agents/{created_agent['id']}/runs",
                           timeout=20).json().get("runs", [])
    client.get(f"{BASE}/api/cockpit/today", timeout=30)
    new_runs = client.get(f"{BASE}/api/cockpit/agents/{created_agent['id']}/runs",
                          timeout=20).json().get("runs", [])
    # tick_due_agents ignores disabled agents; run count unchanged
    assert len(new_runs) == len(prev_runs), \
        f"disabled agent still ticked: {len(prev_runs)} -> {len(new_runs)}"


def test_delete_cascades_runs_and_findings(client, created_agent):
    aid = created_agent["id"]
    r = client.delete(f"{BASE}/api/cockpit/agents/{aid}", timeout=20)
    assert r.status_code == 200, r.text
    # runs endpoint should 404 now (agent gone)
    rr = client.get(f"{BASE}/api/cockpit/agents/{aid}/runs", timeout=20)
    assert rr.status_code == 404
    # findings scoped to this agent gone from any status
    fr = client.get(f"{BASE}/api/cockpit/agent-findings",
                    params={"status": "all"}, timeout=20)
    remaining = [f for f in (fr.json().get("findings") or [])
                 if f.get("agent_id") == aid]
    assert not remaining, f"findings still linger after agent delete: {remaining}"
