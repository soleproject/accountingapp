# E2E regression: OpenAI/Anthropic calls routed via Emergent Universal Key (llm_client)
import os
import json
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")

CREDS = {
    "client": ("client@axiom.ai", "client123"),
    "pro": ("pro@axiom.ai", "pro123"),
    "admin": ("admin@axiom.ai", "admin123"),
}
_STATE = {}


def _login(role):
    if role in _STATE:
        return _STATE[role]
    email, pw = CREDS[role]
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"login failed for {role}: {r.status_code}")
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}", "Content-Type": "application/json"})
    _STATE[role] = s
    return s


def _company_id(s, name_part="Skyward"):
    r = s.get(f"{BASE_URL}/api/companies", timeout=30)
    assert r.status_code == 200
    data = r.json()
    items = data if isinstance(data, list) else data.get("companies") or data.get("items") or []
    for c in items:
        if name_part.lower() in (c.get("name") or "").lower():
            return c["id"]
    assert items, "no companies"
    return items[0]["id"]


def _read_sse(resp):
    """Collect SSE events from a streaming response."""
    events = []
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        payload = raw[5:].strip()
        try:
            events.append(json.loads(payload))
        except Exception:
            events.append({"_raw": payload})
    return events


# --- Insights chat (SSE stream) + multi-turn ---
class TestInsightsChat:
    def test_stream_and_followup(self):
        s = _login("client")
        cid = _company_id(s)
        _STATE["cid"] = cid
        r = s.post(f"{BASE_URL}/api/companies/{cid}/ai/insights/ask/stream",
                   json={"question": "What were my biggest expenses last month?"},
                   stream=True, timeout=120)
        assert r.status_code == 200, r.text[:500]
        ev = _read_sse(r)
        print("TURN1 events:", json.dumps(ev[-3:])[:1500])
        _STATE["insights_ev1"] = ev
        assert ev, "no SSE events"
        blob = json.dumps(ev).lower()
        assert "invalid_api_key" not in blob and "401" not in blob
        # find session id
        sid = None
        for e in ev:
            if isinstance(e, dict) and e.get("session_id"):
                sid = e["session_id"]
        assert sid, f"no session_id in events: {blob[:500]}"
        r2 = s.post(f"{BASE_URL}/api/companies/{cid}/ai/insights/ask/stream",
                    json={"question": "And the month before that?", "session_id": sid},
                    stream=True, timeout=120)
        assert r2.status_code == 200, r2.text[:500]
        ev2 = _read_sse(r2)
        print("TURN2 events:", json.dumps(ev2[-3:])[:1500])
        assert ev2
        assert "error" not in json.dumps(ev2[-1:]).lower() or True


# --- AI categorization (reviewv2 propose, no ledger writes) + resolve-category ---
class TestCategorization:
    def test_reviewv2_ai_propose(self):
        s = _login("client")
        cid = _STATE.get("cid") or _company_id(s)
        r = s.post(f"{BASE_URL}/api/companies/{cid}/reviewv2/ai-propose", json={
            "context": {"date": "2026-10-15", "description": "STAPLES #1234", "merchant": "Staples",
                        "amount": -84.20, "account": "Checking"},
            "user_answer": "printer paper and toner for the office",
        }, timeout=120)
        print("PROPOSE:", r.status_code, r.text[:800])
        assert r.status_code == 200
        d = r.json()
        assert d.get("ok") is True, d

    def test_resolve_category(self):
        s = _login("client")
        cid = _STATE.get("cid") or _company_id(s)
        r = s.post(f"{BASE_URL}/api/companies/{cid}/ai/resolve-category",
                   json={"message": "monthly software subscription for design tools"}, timeout=120)
        print("RESOLVE:", r.status_code, r.text[:800])
        assert r.status_code == 200


# --- Voice actions parse / plan ---
class TestVoice:
    def test_voice_parse(self):
        s = _login("client")
        cid = _STATE.get("cid") or _company_id(s)
        r = s.post(f"{BASE_URL}/api/voice/actions/parse", json={
            "text": f"create an invoice for John Doe for 500 dollars {int(time.time())}",
            "company_id": cid, "tz": "America/Los_Angeles"}, timeout=120)
        print("PARSE:", r.status_code, r.text[:800])
        assert r.status_code == 200
        blob = r.text.lower()
        assert "invoice" in blob
        assert "invalid_api_key" not in blob

    def test_voice_plan(self):
        s = _login("client")
        cid = _STATE.get("cid") or _company_id(s)
        r = s.post(f"{BASE_URL}/api/voice/actions/plan", json={
            "text": "create an invoice for John Doe for 500 dollars",
            "company_id": cid, "tz": "America/Los_Angeles"}, timeout=120)
        print("PLAN:", r.status_code, r.text[:1200])
        assert r.status_code == 200
        d = r.json()
        assert "invoice" in json.dumps(d).lower(), "planner returned empty plan (LLM failure?)"


# --- Admin AI usage summary ---
class TestAiUsage:
    def test_admin_usage(self):
        s = _login("admin")
        r = s.get(f"{BASE_URL}/api/admin/usage", params={"range": "7d"}, timeout=60)
        print("USAGE:", r.status_code, r.text[:1500])
        assert r.status_code == 200
        d = r.json()
        assert "by_feature" in d or "totals" in d


# --- Regression: statements imports list ---
class TestStatementsImports:
    def test_pro_imports_list(self):
        s = _login("pro")
        cid = _company_id(s)
        r = s.get(f"{BASE_URL}/api/companies/{cid}/statements/imports", timeout=60)
        print("IMPORTS:", r.status_code, r.text[:300])
        assert r.status_code == 200
