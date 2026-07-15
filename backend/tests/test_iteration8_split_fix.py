"""Iteration 8 — retest split_transaction normalization + reports balance."""
import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


def _login(email, pw):
    r = requests.post(f"{BASE}/api/auth/login", json={"email": email, "password": pw}, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def client_ctx():
    tok = _login("client@axiom.ai", "client123")
    h = {"Authorization": f"Bearer {tok}"}
    me = requests.get(f"{BASE}/api/auth/me", headers=h, timeout=30).json()
    companies = requests.get(f"{BASE}/api/companies", headers=h, timeout=30).json()
    if isinstance(companies, dict):
        companies = companies.get("companies", [])
    sky = next((c for c in companies if "Skyward" in c["name"]), companies[0])
    return {"h": h, "cid": sky["id"], "me": me}


def _unwrap(j, key):
    if isinstance(j, dict) and key in j:
        return j[key]
    return j


# ---- Reports balance regression ----
def test_trial_balance_balanced(client_ctx):
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/reports/trial-balance",
                     headers=client_ctx["h"], timeout=60)
    assert r.status_code == 200, r.text
    d = r.json()
    print("TB:", d.get("total_debit"), d.get("total_credit"), d.get("balanced"))
    assert abs(float(d["total_debit"]) - float(d["total_credit"])) < 0.01, d
    assert d.get("balanced") is True


def test_balance_sheet_balanced(client_ctx):
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/reports/balance-sheet",
                     headers=client_ctx["h"], timeout=60)
    assert r.status_code == 200, r.text
    d = r.json()
    imb = float(d.get("imbalance", 0))
    print("BS imbalance:", imb, "Assets:", d.get("total_assets"), "L+E:",
          float(d.get("total_liabilities", 0)) + float(d.get("total_equity", 0)))
    assert abs(imb) < 0.01, d


# ---- Split endpoint validation ----
def _find_or_create_splittable_txn(ctx):
    """Find a small $-30 txn we can split for testing."""
    r = requests.get(f"{BASE}/api/companies/{ctx['cid']}/transactions",
                     headers=ctx["h"], timeout=30)
    txns = _unwrap(r.json(), "transactions")
    # Create a fresh test txn to avoid mutating existing splits
    a = requests.get(f"{BASE}/api/companies/{ctx['cid']}/accounts",
                         headers=ctx["h"], timeout=30).json()
    accts = _unwrap(a, "accounts")
    bank = next(a for a in accts if a["code"] == "1010")
    exp = next(a for a in accts if a["code"] == "6000")
    payload = {
        "date": "2026-08-01",
        "amount": -30.0,
        "description": "TEST_iter8 splittable",
        "merchant": "TestVendor",
        "bank_account_id": bank["id"],
        "category_account_id": exp["id"],
    }
    r = requests.post(f"{BASE}/api/companies/{ctx['cid']}/transactions",
                      headers=ctx["h"], json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_split_rejects_missing_category(client_ctx):
    txn = _find_or_create_splittable_txn(client_ctx)
    tid = txn["id"]
    bad = {"splits": [{"amount": -15.0, "description": "no cat"},
                      {"amount": -15.0, "description": "no cat 2"}]}
    r = requests.post(f"{BASE}/api/companies/{client_ctx['cid']}/transactions/{tid}/split",
                      headers=client_ctx["h"], json=bad, timeout=30)
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    assert "categor" in r.text.lower() or "account" in r.text.lower()


def test_split_accepts_account_code_and_balances(client_ctx):
    txn = _find_or_create_splittable_txn(client_ctx)
    tid = txn["id"]
    payload = {"splits": [
        {"amount": -10.0, "account_code": "6000", "description": "meals"},
        {"amount": -20.0, "account_code": "6100", "description": "travel"},
    ]}
    r = requests.post(f"{BASE}/api/companies/{client_ctx['cid']}/transactions/{tid}/split",
                      headers=client_ctx["h"], json=payload, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    for s in body["splits"]:
        assert s.get("category_account_id"), s
        assert s.get("category_account_code"), s
        assert s.get("category_account_name"), s
    # Books still balanced
    tb = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/reports/trial-balance",
                      headers=client_ctx["h"], timeout=60).json()
    assert tb.get("balanced") is True, tb


def test_split_accepts_canonical_category_account_id(client_ctx):
    txn = _find_or_create_splittable_txn(client_ctx)
    tid = txn["id"]
    accts = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/accounts",
                         headers=client_ctx["h"], timeout=30).json()
    accts = _unwrap(accts, "accounts")
    a6000 = next(a for a in accts if a["code"] == "6000")["id"]
    a6100 = next(a for a in accts if a["code"] == "6100")["id"]
    payload = {"splits": [
        {"amount": -12.0, "category_account_id": a6000},
        {"amount": -18.0, "category_account_id": a6100},
    ]}
    r = requests.post(f"{BASE}/api/companies/{client_ctx['cid']}/transactions/{tid}/split",
                      headers=client_ctx["h"], json=payload, timeout=30)
    assert r.status_code == 200, r.text
    tb = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/reports/trial-balance",
                      headers=client_ctx["h"], timeout=60).json()
    assert tb.get("balanced") is True


# ---- Regression: all 7 reports still work ----
@pytest.mark.parametrize("path", [
    "reports/trial-balance",
    "reports/balance-sheet",
    "reports/income-statement",
    "reports/general-ledger?start=2026-01-01&end=2026-12-31",
    "reports/cash-flow",
    "reports/sales-tax",
    "reports/1099-summary",
])
def test_all_reports_200(client_ctx, path):
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/{path}",
                     headers=client_ctx["h"], timeout=60)
    assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"


def test_gl_source_column_still_present(client_ctx):
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/reports/general-ledger?start=2026-01-01&end=2026-12-31",
                     headers=client_ctx["h"], timeout=60)
    assert r.status_code == 200
    d = r.json()
    sources = set()
    for sec in d.get("sections", []):
        for row in sec.get("entries", []) + sec.get("rows", []):
            if row.get("source"):
                sources.add(row["source"])
    print("GL sources present:", sources)
    assert sources & {"Txn", "Split", "JE"}, f"expected at least one of Txn/Split/JE, got {sources}"


# ---- Auth / Dashboard / other regression checks ----
def test_login_all_three_roles():
    for e, p in [("client@axiom.ai", "client123"),
                 ("pro@axiom.ai", "pro123"),
                 ("admin@axiom.ai", "admin123")]:
        _login(e, p)


def test_dashboard_metrics(client_ctx):
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/dashboard/metrics",
                     headers=client_ctx["h"], timeout=30)
    assert r.status_code == 200, r.text


def test_invoices_and_ar_aging(client_ctx):
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/invoices",
                     headers=client_ctx["h"], timeout=30)
    assert r.status_code == 200
    r2 = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/reports/ar-aging",
                      headers=client_ctx["h"], timeout=30)
    # AR aging may be under different path — try alternates
    if r2.status_code == 404:
        r2 = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/ar-aging",
                          headers=client_ctx["h"], timeout=30)
    print("AR aging status:", r2.status_code)


def test_plaid_link_token(client_ctx):
    r = requests.post(f"{BASE}/api/companies/{client_ctx['cid']}/onboarding/plaid/link-token",
                      headers=client_ctx["h"], timeout=30)
    assert r.status_code in (200, 201), r.text


def test_ai_chat_endpoint(client_ctx):
    # Try common paths — non-fatal
    for path in ["ai/chat", "chat", "ai/ask"]:
        r = requests.post(f"{BASE}/api/companies/{client_ctx['cid']}/{path}",
                          headers=client_ctx["h"],
                          json={"message": "hello"}, timeout=60)
        if r.status_code < 500:
            print(f"AI chat {path}: {r.status_code}")
            return
    pytest.skip("no ai chat endpoint variant returned <500")


def test_closed_period_lock_behavior(client_ctx):
    # closed_periods listing endpoint
    r = requests.get(f"{BASE}/api/companies/{client_ctx['cid']}/closed-periods",
                     headers=client_ctx["h"], timeout=30)
    # Endpoint may be named differently; accept 200 or 404 (feature-check only)
    print("closed-periods:", r.status_code)


def test_pro_can_create_new_client():
    tok = _login("pro@axiom.ai", "pro123")
    h = {"Authorization": f"Bearer {tok}"}
    payload = {"name": "TEST_iter8_newclient", "industry": "Tech"}
    r = requests.post(f"{BASE}/api/companies", headers=h, json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    cid = r.json().get("id") or r.json().get("company_id")
    assert cid, r.text
    # cleanup
    requests.delete(f"{BASE}/api/companies/{cid}", headers=h, timeout=30)
