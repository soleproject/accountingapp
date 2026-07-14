"""Axiom Ledger backend regression tests."""
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    # fallback: read from frontend/.env
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                break
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"

CREDS = {
    "client": ("client@axiom.ai", "client123"),
    "client2": ("client2@axiom.ai", "client123"),
    "pro": ("pro@axiom.ai", "pro123"),
    "admin": ("admin@axiom.ai", "admin123"),
}


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"Login failed for {email}: {r.status_code} {r.text}"
    return r.json()


@pytest.fixture(scope="session")
def client_auth():
    return _login(*CREDS["client"])


@pytest.fixture(scope="session")
def client2_auth():
    return _login(*CREDS["client2"])


@pytest.fixture(scope="session")
def pro_auth():
    return _login(*CREDS["pro"])


@pytest.fixture(scope="session")
def admin_auth():
    return _login(*CREDS["admin"])


def _hdr(auth):
    return {"Authorization": f"Bearer {auth['token']}"}


@pytest.fixture(scope="session")
def client_company(client_auth):
    r = requests.get(f"{API}/companies", headers=_hdr(client_auth), timeout=30)
    assert r.status_code == 200
    comps = r.json().get("companies", r.json() if isinstance(r.json(), list) else [])
    if isinstance(comps, dict):
        comps = comps.get("companies", [])
    assert len(comps) >= 1, f"No companies for client: {r.text}"
    # find Skyward Sparks
    sky = next((c for c in comps if "Skyward" in c.get("name", "")), comps[0])
    return sky


@pytest.fixture(scope="session")
def client2_company(client2_auth):
    r = requests.get(f"{API}/companies", headers=_hdr(client2_auth), timeout=30)
    assert r.status_code == 200
    j = r.json()
    comps = j.get("companies", j) if isinstance(j, dict) else j
    assert len(comps) >= 1
    bright = next((c for c in comps if "Bright" in c.get("name", "")), comps[0])
    return bright


# ---------- Auth ----------
class TestAuth:
    def test_client_login(self):
        d = _login(*CREDS["client"])
        assert d["user"]["role"] == "client"
        assert d["user"]["email"] == "client@axiom.ai"

    def test_pro_login(self):
        d = _login(*CREDS["pro"])
        assert d["user"]["role"] == "pro"

    def test_admin_login(self):
        d = _login(*CREDS["admin"])
        assert d["user"]["role"] == "superadmin"

    def test_bad_login(self):
        r = requests.post(f"{API}/auth/login", json={"email": "x@x.com", "password": "bad"}, timeout=15)
        assert r.status_code in (400, 401, 403)

    def test_me_endpoint(self, client_auth):
        r = requests.get(f"{API}/auth/me", headers=_hdr(client_auth), timeout=15)
        assert r.status_code == 200
        j = r.json()
        u = j.get("user", j)
        assert u["email"] == "client@axiom.ai"


# ---------- Role dashboards ----------
class TestRoleDashboards:
    def test_admin_overview(self, admin_auth):
        r = requests.get(f"{API}/admin/overview", headers=_hdr(admin_auth), timeout=15)
        assert r.status_code == 200
        j = r.json()
        # stats present
        assert any(k in j for k in ("users", "companies", "stats", "user_count", "total_users"))

    def test_pro_clients_list(self, pro_auth):
        r = requests.get(f"{API}/pro/clients", headers=_hdr(pro_auth), timeout=15)
        assert r.status_code == 200
        j = r.json()
        clients = j.get("clients") if isinstance(j, dict) else j
        assert isinstance(clients, list)
        assert len(clients) >= 2


# ---------- Companies + accounts ----------
class TestCompaniesAccounts:
    def test_companies_list(self, client_auth, client_company):
        assert "Skyward" in client_company["name"]

    def test_coa_has_defaults(self, client_auth, client_company):
        r = requests.get(f"{API}/companies/{client_company['id']}/accounts",
                         headers=_hdr(client_auth), timeout=15)
        assert r.status_code == 200
        j = r.json()
        accts = j.get("accounts", j.get("items", j))
        if isinstance(j, dict) and "accounts" not in j and "items" not in j:
            accts = j
        assert len(accts) >= 30, f"Expected 30+ default accounts, got {len(accts)}"
        types = {a["type"] for a in accts}
        assert {"asset", "liability", "equity", "revenue", "expense"}.issubset(types)


# ---------- Transactions ----------
class TestTransactions:
    def test_list_transactions(self, client_auth, client_company):
        r = requests.get(f"{API}/companies/{client_company['id']}/transactions",
                         headers=_hdr(client_auth), timeout=30)
        assert r.status_code == 200
        j = r.json()
        txns = j.get("transactions", j.get("items", j))
        assert isinstance(txns, list)
        assert len(txns) >= 50, f"Expected ~90 seed txns, got {len(txns)}"

    def test_add_transaction_ai_categorizes(self, client_auth, client_company):
        payload = {
            "date": "2025-06-15",
            "merchant": "TEST_Amazon Web Services",
            "amount": -123.45,
            "description": "AWS monthly hosting",
        }
        r = requests.post(f"{API}/companies/{client_company['id']}/transactions",
                          headers=_hdr(client_auth), json=payload, timeout=60)
        assert r.status_code in (200, 201), r.text
        j = r.json()
        txn = j.get("transaction", j)
        # Must have a GAAP account assigned
        assert txn.get("category_account_code") or txn.get("category_account_name"), \
            f"AI didn't assign category: {j}"


# ---------- Rules apply_to_existing ----------
class TestRules:
    def test_rules_list(self, client_auth, client_company):
        r = requests.get(f"{API}/companies/{client_company['id']}/rules",
                         headers=_hdr(client_auth), timeout=15)
        assert r.status_code == 200
        assert "rules" in r.json()

    def test_apply_to_existing_recategorizes(self, client_auth, client_company):
        cid = client_company["id"]
        # Pick a merchant that exists in txns
        r = requests.get(f"{API}/companies/{cid}/transactions",
                         headers=_hdr(client_auth), timeout=30)
        txns = r.json().get("transactions", r.json().get("items", r.json()))
        # Find an unreviewed transaction
        unreviewed = [t for t in txns if not t.get("human_reviewed")]
        assert unreviewed, "Need unreviewed transactions"
        target = unreviewed[0]
        merchant = target["merchant"]
        # Get an account code (pick an expense account)
        ar = requests.get(f"{API}/companies/{cid}/accounts", headers=_hdr(client_auth), timeout=15)
        aj = ar.json()
        accts = aj.get("accounts", aj.get("items", aj))
        expense_acct = next(a for a in accts if a["type"] == "expense")
        payload = {
            "match_type": "merchant_contains",
            "match_value": merchant,
            "account_code": expense_acct["code"],
            "apply_to_existing": True,
        }
        cr = requests.post(f"{API}/companies/{cid}/rules",
                           headers=_hdr(client_auth), json=payload, timeout=60)
        assert cr.status_code in (200, 201), cr.text
        applied = cr.json().get("applied", 0)
        assert applied >= 1, f"Rule applied to 0 txns: {cr.json()}"

        # Verify: GET target txn and check category
        r2 = requests.get(f"{API}/companies/{cid}/transactions", headers=_hdr(client_auth), timeout=30)
        t2 = r2.json().get("transactions", r2.json().get("items", r2.json()))
        updated = next(t for t in t2 if t["id"] == target["id"])
        assert updated["category_account_code"] == expense_acct["code"], \
            f"Txn not recategorized: {updated.get('category_account_code')} != {expense_acct['code']}"


# ---------- Reports (JSON + PDF) ----------
REPORTS = ["income-statement", "balance-sheet", "trial-balance", "general-ledger", "cash-flow"]


@pytest.mark.parametrize("kind", REPORTS)
def test_report_json(client_auth, client_company, kind):
    r = requests.get(f"{API}/companies/{client_company['id']}/reports/{kind}",
                     headers=_hdr(client_auth), timeout=30)
    assert r.status_code == 200, f"{kind}: {r.text}"
    j = r.json()
    assert isinstance(j, dict) and len(j) > 0


@pytest.mark.parametrize("kind", REPORTS)
def test_report_pdf(client_auth, client_company, kind):
    r = requests.get(f"{API}/companies/{client_company['id']}/reports/{kind}/pdf",
                     headers=_hdr(client_auth), timeout=60)
    assert r.status_code == 200, f"{kind} pdf: {r.status_code}"
    ct = r.headers.get("content-type", "")
    assert "pdf" in ct.lower(), f"{kind} content-type not pdf: {ct}"
    assert r.content[:4] == b"%PDF", f"{kind} not a PDF file"


# ---------- Journal Entries ----------
class TestJournalEntries:
    def test_create_balanced_je(self, client_auth, client_company):
        cid = client_company["id"]
        ar = requests.get(f"{API}/companies/{cid}/accounts", headers=_hdr(client_auth), timeout=15)
        aj = ar.json()
        accts = aj.get("accounts", aj.get("items", aj))
        cash = next(a for a in accts if a["type"] == "asset")
        rev = next(a for a in accts if a["type"] == "revenue")
        payload = {
            "date": "2025-06-30",
            "memo": "TEST JE",
            "lines": [
                {"account_code": cash["code"], "debit": 100, "credit": 0},
                {"account_code": rev["code"], "debit": 0, "credit": 100},
            ],
        }
        r = requests.post(f"{API}/companies/{cid}/journal-entries",
                          headers=_hdr(client_auth), json=payload, timeout=15)
        assert r.status_code in (200, 201), r.text


# ---------- Onboarding mock endpoints ----------
class TestOnboarding:
    def test_mock_plaid_returns_3_accounts(self, client2_auth, client2_company):
        cid = client2_company["id"]
        r = requests.post(f"{API}/companies/{cid}/onboarding/mock-plaid",
                          headers=_hdr(client2_auth), json={}, timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        accts = j.get("accounts") or j.get("items") or []
        assert len(accts) == 3, f"Expected 3 mock plaid accounts, got {len(accts)}"

    def test_mock_veryfi(self, client2_auth, client2_company):
        cid = client2_company["id"]
        r = requests.post(f"{API}/companies/{cid}/onboarding/mock-veryfi",
                          headers=_hdr(client2_auth), json={}, timeout=30)
        assert r.status_code == 200, r.text


# ---------- Generic CRUD lists ----------
GENERIC_LISTS = ["contacts", "invoices", "bills", "payments", "receipts",
                 "journal-entries", "inventory", "assets", "loans", "tags",
                 "reconciliations", "book-reviews", "close-periods"]


@pytest.mark.parametrize("path", GENERIC_LISTS)
def test_list_endpoints(client_auth, client_company, path):
    r = requests.get(f"{API}/companies/{client_company['id']}/{path}",
                     headers=_hdr(client_auth), timeout=15)
    assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"


# ---------- Real Plaid (Sandbox) integration ----------
class TestPlaidReal:
    def test_link_token_returns_sandbox_token(self, client_auth, client_company):
        cid = client_company["id"]
        r = requests.post(f"{API}/companies/{cid}/onboarding/plaid/link-token",
                          headers=_hdr(client_auth), json={}, timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert "link_token" in j
        tok = j["link_token"]
        assert isinstance(tok, str) and len(tok) > 10
        assert tok.startswith("link-sandbox-"), f"Expected sandbox token, got: {tok[:40]}"

    def test_exchange_missing_public_token_returns_400(self, client_auth, client_company):
        cid = client_company["id"]
        r = requests.post(f"{API}/companies/{cid}/onboarding/plaid/exchange",
                          headers=_hdr(client_auth), json={}, timeout=30)
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


# ---------- Real Veryfi upload ----------
# Minimal valid PDF (single blank page) - hex-safe
MIN_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n"
    b"4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (Test Statement) Tj ET\nendstream endobj\n"
    b"xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n"
    b"0000000101 00000 n \n0000000178 00000 n \n"
    b"trailer<</Size 5/Root 1 0 R>>\nstartxref\n270\n%%EOF\n"
)


class TestVeryfiReal:
    def test_upload_requires_auth(self, client_company):
        cid = client_company["id"]
        files = {"file": ("test.pdf", MIN_PDF, "application/pdf")}
        r = requests.post(f"{API}/companies/{cid}/onboarding/veryfi/upload",
                          files=files, timeout=60)
        assert r.status_code in (401, 403), f"Expected 401/403 without token, got {r.status_code}"

    def test_upload_valid_pdf_returns_imported_key(self, client_auth, client_company):
        cid = client_company["id"]
        files = {"file": ("test_statement.pdf", MIN_PDF, "application/pdf")}
        r = requests.post(f"{API}/companies/{cid}/onboarding/veryfi/upload",
                          headers=_hdr(client_auth), files=files, timeout=120)
        # Must NOT be 500 for a valid PDF
        assert r.status_code != 500, f"Veryfi upload returned 500: {r.text[:500]}"
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:500]}"
        j = r.json()
        assert "imported" in j, f"Missing 'imported' key in response: {j}"
        assert isinstance(j["imported"], int), f"'imported' not int: {type(j['imported'])}"
