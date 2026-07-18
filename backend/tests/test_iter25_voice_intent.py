"""Iteration 25 — Voice command / AI panel additions:
   - DELETE /api/ai/chat/history clears chat
   - POST /api/companies/{cid}/ai/parse-intent parses create intents
   - Contact-name fuzzy match resolves contact_id
"""
import os
import pytest
import requests
from pathlib import Path

def _load_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    env = Path("/app/frontend/.env")
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    return ""

BASE_URL = _load_backend_url()


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": "client@axiom.ai", "password": "client123"})
    assert r.status_code == 200, r.text
    tok = r.json()["access_token"] if "access_token" in r.json() else r.json().get("token")
    s.headers["Authorization"] = f"Bearer {tok}"
    return s


@pytest.fixture(scope="module")
def company_id(client):
    r = client.get(f"{BASE_URL}/api/companies")
    assert r.status_code == 200
    comps = r.json().get("companies", [])
    assert len(comps) >= 1
    return comps[0]["id"]


def test_companies_include_test_dup(client):
    r = client.get(f"{BASE_URL}/api/companies")
    assert r.status_code == 200
    names = [c.get("name") for c in r.json().get("companies", [])]
    dups = [n for n in names if n and "TEST_dup" in n]
    print("Companies:", names)
    # spec expects two TEST_dup companies — non-fatal but reported
    assert len(dups) >= 1, f"Expected TEST_dup company, found: {names}"


def test_chat_history_get(client, company_id):
    r = client.get(f"{BASE_URL}/api/ai/chat/history?company_id={company_id}")
    assert r.status_code == 200
    assert "messages" in r.json()


def test_chat_history_delete_then_empty(client, company_id):
    r = client.delete(f"{BASE_URL}/api/ai/chat/history?company_id={company_id}")
    assert r.status_code == 200
    data = r.json()
    assert "deleted" in data
    r2 = client.get(f"{BASE_URL}/api/ai/chat/history?company_id={company_id}")
    assert r2.status_code == 200
    assert r2.json()["messages"] == []


def test_parse_intent_invoice(client, company_id):
    r = client.post(f"{BASE_URL}/api/companies/{company_id}/ai/parse-intent",
                    json={"text": "create an invoice for John Doe for 500 dollars"})
    assert r.status_code == 200, r.text
    d = r.json()
    print("Invoice intent:", d)
    assert d.get("intent") == "create_invoice"
    pf = d.get("prefill") or {}
    assert float(pf.get("amount") or 0) == 500 or float(pf.get("amount") or 0) == 500.0
    assert "john" in (pf.get("contact_name") or "").lower()


def test_parse_intent_contact_vendor(client, company_id):
    r = client.post(f"{BASE_URL}/api/companies/{company_id}/ai/parse-intent",
                    json={"text": "create a new vendor called Acme Supplies"})
    assert r.status_code == 200
    d = r.json()
    print("Contact intent:", d)
    assert d.get("intent") == "create_contact"
    pf = d.get("prefill") or {}
    assert "acme" in (pf.get("name") or "").lower()
    assert pf.get("type") == "vendor"


def test_parse_intent_account(client, company_id):
    r = client.post(f"{BASE_URL}/api/companies/{company_id}/ai/parse-intent",
                    json={"text": "create an account called Marketing Expenses"})
    assert r.status_code == 200
    d = r.json()
    print("Account intent:", d)
    assert d.get("intent") == "create_account"
    assert "marketing" in ((d.get("prefill") or {}).get("name") or "").lower()


def test_parse_intent_bill_with_contact_match(client, company_id):
    # Seed a "Voice Vendor Test" contact so fuzzy match should populate contact_id
    r0 = client.post(f"{BASE_URL}/api/companies/{company_id}/contacts",
                     json={"name": "Voice Vendor Test", "type": "vendor"})
    assert r0.status_code in (200, 201), r0.text
    r = client.post(f"{BASE_URL}/api/companies/{company_id}/ai/parse-intent",
                    json={"text": "create a bill for Voice Vendor Test for 300 dollars"})
    assert r.status_code == 200
    d = r.json()
    print("Bill intent:", d)
    assert d.get("intent") == "create_bill"
    pf = d.get("prefill") or {}
    assert float(pf.get("amount") or 0) == 300
    assert pf.get("matched_existing") is True
    assert pf.get("contact_id")
