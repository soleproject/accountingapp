"""Iteration 5 backend tests: dashboard/metrics + POST /pro/clients."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                break
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    return r.json()


def _hdr(auth):
    return {"Authorization": f"Bearer {auth['token']}"}


@pytest.fixture(scope="module")
def client_auth():
    return _login("client@axiom.ai", "client123")


@pytest.fixture(scope="module")
def pro_auth():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def client_company(client_auth):
    r = requests.get(f"{API}/companies", headers=_hdr(client_auth), timeout=30)
    j = r.json()
    comps = j.get("companies", j) if isinstance(j, dict) else j
    return next((c for c in comps if "Skyward" in c.get("name", "")), comps[0])


class TestDashboardMetrics:
    def test_metrics_shape_and_types(self, client_auth, client_company):
        cid = client_company["id"]
        r = requests.get(f"{API}/companies/{cid}/dashboard/metrics",
                         headers=_hdr(client_auth), timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        expected = ["cash_on_hand", "outstanding_invoices", "overdue_invoices",
                    "invoice_count", "outstanding_bills", "overdue_bills",
                    "bill_count", "cash_in_30d", "cash_out_30d", "net_cash_30d",
                    "activity_count_30d"]
        for k in expected:
            assert k in j, f"missing key {k}: {list(j.keys())}"
            assert isinstance(j[k], (int, float)), f"{k} not numeric: {type(j[k])}"

    def test_metrics_forbidden_without_company_access(self, client_company):
        r = requests.get(f"{API}/companies/{client_company['id']}/dashboard/metrics", timeout=30)
        assert r.status_code in (401, 403)


class TestProCreateClient:
    def test_create_client_flow(self, pro_auth):
        ts = int(time.time() * 1000)
        email = f"testflow-{ts}@example.com"
        payload = {
            "client_name": "TEST Flow Client",
            "client_email": email,
            "client_password": "flowpass123",
            "company_name": f"TEST_Co_{ts}",
            "business_type": "SaaS",
            "business_description": "Auto test create",
            "reporting_basis": "accrual",
        }
        r = requests.post(f"{API}/pro/clients", headers=_hdr(pro_auth), json=payload, timeout=60)
        assert r.status_code in (200, 201), r.text
        j = r.json()
        assert "company_id" in j and "client_id" in j
        company_id = j["company_id"]

        # Appears in list
        rl = requests.get(f"{API}/pro/clients", headers=_hdr(pro_auth), timeout=30)
        assert rl.status_code == 200
        clients = rl.json().get("clients", [])
        assert any(c["id"] == company_id for c in clients), "new company missing from Pro list"

        # Client can log in
        new_login = _login(email, "flowpass123")
        assert new_login["user"]["role"] == "client"
        assert new_login["user"]["email"] == email

        # CoA seeded (>=30)
        ar = requests.get(f"{API}/companies/{company_id}/accounts",
                         headers={"Authorization": f"Bearer {new_login['token']}"}, timeout=30)
        assert ar.status_code == 200
        aj = ar.json()
        accts = aj.get("accounts", aj)
        assert len(accts) >= 30, f"CoA has only {len(accts)} accounts"

        # Pro has membership on new company (can see via /companies)
        rc = requests.get(f"{API}/companies", headers=_hdr(pro_auth), timeout=30)
        pro_comps = rc.json().get("companies", [])
        assert any(c["id"] == company_id for c in pro_comps), "pro missing membership on new company"

    def test_duplicate_email_returns_400(self, pro_auth):
        payload = {
            "client_name": "Dup",
            "client_email": "client@axiom.ai",  # already exists
            "client_password": "x",
            "company_name": "TEST_dup",
        }
        r = requests.post(f"{API}/pro/clients", headers=_hdr(pro_auth), json=payload, timeout=30)
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"

    def test_client_role_forbidden(self):
        client_auth = _login("client@axiom.ai", "client123")
        payload = {
            "client_name": "X", "client_email": f"nope-{int(time.time())}@example.com",
            "client_password": "x", "company_name": "TEST_nope",
        }
        r = requests.post(f"{API}/pro/clients", headers=_hdr(client_auth), json=payload, timeout=30)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"
