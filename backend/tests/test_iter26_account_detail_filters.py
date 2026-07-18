"""
Iteration 26 — Account Detail filter query param tests
Validates new q, min_amount, max_amount, contact_id params on
/api/companies/{cid}/reports/account-detail (JSON + PDF).
"""
import os
import pytest
import requests
from pathlib import Path

def _load_env():
    env_path = Path("/app/frontend/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
_load_env()

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = "pro@axiom.ai"
PASSWORD = "pro123"
TARGET_COMPANY_NAME = "351 LLC"
TARGET_CODE = "2110"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def company_id(headers):
    r = requests.get(f"{BASE}/api/companies", headers=headers)
    assert r.status_code == 200
    payload = r.json()
    items = payload.get("companies") if isinstance(payload, dict) else payload
    for c in items or []:
        if c.get("name") == TARGET_COMPANY_NAME:
            return c["id"]
    pytest.skip(f"{TARGET_COMPANY_NAME} not accessible to {EMAIL}")


@pytest.fixture(scope="module")
def citi_account_id(headers, company_id):
    r = requests.get(f"{BASE}/api/companies/{company_id}/accounts", headers=headers)
    assert r.status_code == 200
    payload = r.json()
    items = payload.get("accounts") if isinstance(payload, dict) else payload
    for a in items or []:
        if str(a.get("code")) == TARGET_CODE:
            return a["id"]
    pytest.skip(f"Account code {TARGET_CODE} not found in {TARGET_COMPANY_NAME}")


class TestAccountDetailFilters:
    def _get(self, headers, cid, aid, **params):
        r = requests.get(
            f"{BASE}/api/companies/{cid}/reports/account-detail",
            headers=headers,
            params={"account_id": aid, **{k: v for k, v in params.items() if v is not None}},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def test_base_no_filters(self, headers, company_id, citi_account_id):
        data = self._get(headers, company_id, citi_account_id)
        assert data.get("account") is not None
        assert data["account"]["code"] == TARGET_CODE
        assert isinstance(data.get("rows"), list)
        assert data.get("count", len(data["rows"])) >= 0
        # Store for later comparison
        assert len(data["rows"]) > 0, "Expected transactions in Citi Card for 351 LLC"

    def test_q_narrows_or_matches(self, headers, company_id, citi_account_id):
        base = self._get(headers, company_id, citi_account_id)
        filtered = self._get(headers, company_id, citi_account_id, q="citi")
        assert isinstance(filtered.get("rows"), list)
        # q filter should never expand the set
        assert len(filtered["rows"]) <= len(base["rows"])

    def test_q_impossible_returns_empty(self, headers, company_id, citi_account_id):
        data = self._get(headers, company_id, citi_account_id, q="zzz_no_match_needle_xyz")
        assert data["rows"] == []

    def test_min_amount_filter(self, headers, company_id, citi_account_id):
        base = self._get(headers, company_id, citi_account_id)
        filtered = self._get(headers, company_id, citi_account_id, min_amount=50)
        assert len(filtered["rows"]) <= len(base["rows"])
        for r in filtered["rows"]:
            assert abs(float(r["amount"])) >= 50 - 0.001

    def test_max_amount_filter(self, headers, company_id, citi_account_id):
        filtered = self._get(headers, company_id, citi_account_id, max_amount=10)
        for r in filtered["rows"]:
            assert abs(float(r["amount"])) <= 10 + 0.001

    def test_range_filter(self, headers, company_id, citi_account_id):
        filtered = self._get(headers, company_id, citi_account_id, min_amount=5, max_amount=100)
        for r in filtered["rows"]:
            v = abs(float(r["amount"]))
            assert 5 - 0.001 <= v <= 100 + 0.001

    def test_contact_id_filter(self, headers, company_id, citi_account_id):
        base = self._get(headers, company_id, citi_account_id)
        # Pick a contact_id present in base if any
        cids = [r for r in base["rows"] if r.get("contact_name")]
        # Fetch contacts to resolve id
        r = requests.get(f"{BASE}/api/companies/{company_id}/contacts", headers=headers)
        assert r.status_code == 200
        payload = r.json()
        contacts = payload.get("contacts") if isinstance(payload, dict) else payload
        if not contacts or not cids:
            pytest.skip("No contact data available")
        # Just verify endpoint accepts the param without crashing
        target = contacts[0]["id"]
        data = self._get(headers, company_id, citi_account_id, contact_id=target)
        assert isinstance(data.get("rows"), list)

    def test_date_range_still_works(self, headers, company_id, citi_account_id):
        data = self._get(headers, company_id, citi_account_id,
                         start="2025-01-01", end="2025-12-31")
        assert isinstance(data.get("rows"), list)
        for r in data["rows"]:
            assert "2025-01-01" <= r["date"] <= "2025-12-31"

    def test_pdf_accepts_new_params(self, headers, company_id, citi_account_id):
        r = requests.get(
            f"{BASE}/api/companies/{company_id}/reports/account-detail/pdf",
            headers=headers,
            params={"account_id": citi_account_id, "q": "citi", "min_amount": 5,
                    "max_amount": 10000},
        )
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert len(r.content) > 100


class TestBalanceSheetRegression:
    def test_bs_balances(self, headers, company_id):
        r = requests.get(f"{BASE}/api/companies/{company_id}/reports/balance-sheet",
                         headers=headers)
        assert r.status_code == 200
        d = r.json()
        # totals should be self-consistent
        total_assets = d.get("total_assets", 0)
        total_liab = d.get("total_liabilities", 0)
        total_eq = d.get("total_equity", 0)
        assert abs(total_assets - (total_liab + total_eq)) < 1.0, \
            f"BS out of balance: A={total_assets} L={total_liab} E={total_eq}"

    def test_bs_has_liability_children(self, headers, company_id):
        r = requests.get(f"{BASE}/api/companies/{company_id}/reports/balance-sheet",
                         headers=headers)
        assert r.status_code == 200
        d = r.json()
        liab = d.get("liabilities") or []
        # Look for 2100 with children including 2110
        codes = []
        def collect(items):
            for it in items:
                codes.append(str(it.get("code")))
                for ch in it.get("children") or []:
                    codes.append(str(ch.get("code")))
        collect(liab)
        assert "2110" in codes, f"Expected 2110 in liability tree, got {codes}"


class TestOtherReportsRegression:
    @pytest.mark.parametrize("path", [
        "reports/income-statement", "reports/trial-balance",
        "reports/general-ledger", "reports/cash-flow",
    ])
    def test_reports_render(self, headers, company_id, path):
        r = requests.get(f"{BASE}/api/companies/{company_id}/{path}", headers=headers)
        assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"
        assert isinstance(r.json(), dict)
