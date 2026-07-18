"""Iteration 27: Refactor smoke tests - verify all key endpoints still work after server.py split."""
import os
import json
import requests
import pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
CID_351 = "51f35d57-eec7-4662-b26e-11b37ccb71ff"
CITI_ACCT = "6ccfc8a3-b57d-417f-96a0-b25d26c5624f"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE}/api/auth/login", json={"email": "pro@axiom.ai", "password": "pro123"}, timeout=15)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def h(token):
    return {"Authorization": f"Bearer {token}"}


def test_health():
    assert requests.get(f"{BASE}/api/health", timeout=10).status_code == 200


def test_ready():
    assert requests.get(f"{BASE}/api/ready", timeout=10).status_code == 200


def test_auth_me(h):
    r = requests.get(f"{BASE}/api/auth/me", headers=h, timeout=10)
    assert r.status_code == 200
    body = r.json()
    user = body.get("user", body)
    assert user.get("email") == "pro@axiom.ai"


def test_companies(h):
    r = requests.get(f"{BASE}/api/companies", headers=h, timeout=10)
    assert r.status_code == 200


@pytest.mark.parametrize("path", [
    "/accounts",
    "/transactions",
    "/contacts",
    "/rules",
    "/invoices",
    "/bills",
    "/dashboard/metrics",
    "/dashboard/attention",
    "/reports/balance-sheet",
    "/reports/income-statement",
    "/reports/trial-balance",
    "/reports/general-ledger",
    "/reports/cash-flow",
])
def test_company_endpoints(h, path):
    r = requests.get(f"{BASE}/api/companies/{CID_351}{path}", headers=h, timeout=30)
    assert r.status_code == 200, f"{path} => {r.status_code} {r.text[:200]}"


def test_account_detail(h):
    r = requests.get(f"{BASE}/api/companies/{CID_351}/reports/account-detail",
                     params={"account_id": CITI_ACCT}, headers=h, timeout=30)
    assert r.status_code == 200, r.text[:200]


def test_pro_clients(h):
    r = requests.get(f"{BASE}/api/pro/clients", headers=h, timeout=15)
    assert r.status_code == 200


def test_pro_firm_attention(h):
    r = requests.get(f"{BASE}/api/pro/firm-attention", headers=h, timeout=15)
    assert r.status_code == 200


def test_ai_diagnose(h):
    r = requests.get(f"{BASE}/api/companies/{CID_351}/ai/diagnose", headers=h, timeout=30)
    assert r.status_code == 200


def test_balance_sheet_has_citi(h):
    r = requests.get(f"{BASE}/api/companies/{CID_351}/reports/balance-sheet", headers=h, timeout=30)
    assert r.status_code == 200
    body = json.dumps(r.json())
    assert "Citi" in body or "2110" in body, "Citi/2110 not present in balance sheet"


def test_patch_transaction_category(h):
    # Get one transaction, patch its category
    r = requests.get(f"{BASE}/api/companies/{CID_351}/transactions?limit=5", headers=h, timeout=15)
    assert r.status_code == 200
    txns = r.json()
    items = txns.get("transactions") or txns.get("items") or (txns if isinstance(txns, list) else [])
    if not items:
        pytest.skip("no transactions")
    tid = items[0].get("id") or items[0].get("_id")
    orig_cat = items[0].get("category_account_id")
    # get an alt category
    ra = requests.get(f"{BASE}/api/companies/{CID_351}/accounts", headers=h, timeout=15).json()
    accts_list = ra.get("accounts") if isinstance(ra, dict) else ra
    alt = None
    for a in accts_list:
        aid = a.get("id") or a.get("_id")
        if aid and aid != orig_cat:
            alt = aid
            break
    assert alt, "no alt account"
    r = requests.patch(f"{BASE}/api/companies/{CID_351}/transactions/{tid}",
                       json={"category_account_id": alt}, headers=h, timeout=15)
    assert r.status_code in (200, 204), f"{r.status_code} {r.text[:200]}"


def test_journal_entry_post(h):
    # get two GL accounts
    ra = requests.get(f"{BASE}/api/companies/{CID_351}/accounts", headers=h, timeout=15).json()
    accts = ra.get("accounts") if isinstance(ra, dict) else ra
    ids = [a.get("id") or a.get("_id") for a in accts][:2]
    if len(ids) < 2:
        pytest.skip("need 2 accounts")
    payload = {
        "date": "2026-03-15",
        "memo": "TEST_iter27 refactor smoke",
        "lines": [
            {"account_id": ids[0], "debit": 1.0, "credit": 0.0},
            {"account_id": ids[1], "debit": 0.0, "credit": 1.0},
        ],
    }
    r = requests.post(f"{BASE}/api/companies/{CID_351}/journal-entries", json=payload, headers=h, timeout=15)
    assert r.status_code in (200, 201), f"{r.status_code} {r.text[:300]}"
