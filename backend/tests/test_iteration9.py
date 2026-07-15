"""Iter9 tests: A/P aging, GL txn_id/je_id, invoice+bill PATCH, TB/BS balance regression."""
import os
import requests
import pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE}/api"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json={"email": "client@axiom.ai", "password": "client123"})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def cid(client):
    r = client.get(f"{API}/companies")
    assert r.status_code == 200
    companies = r.json()["companies"]
    sky = next(c for c in companies if "Skyward" in c["name"])
    return sky["id"]


# ---------- New feature: A/P aging ----------

class TestAPAging:
    def test_ap_aging_endpoint(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/reports/ap-aging")
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("buckets", "lines", "total", "as_of"):
            assert k in data, f"missing key {k}"
        b = data["buckets"]
        for k in ("current", "1_30", "31_60", "61_90", "over_90"):
            assert k in b
        # sum of buckets ~= total
        s = sum(float(b[k]) for k in b)
        assert abs(s - float(data["total"])) < 0.02, f"bucket sum {s} != total {data['total']}"

    def test_ar_aging_still_works(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/reports/ar-aging")
        assert r.status_code == 200
        assert "buckets" in r.json()


# ---------- New feature: GL entries carry txn_id/je_id ----------

class TestGLSourceIds:
    def test_gl_entries_have_ids(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/reports/general-ledger")
        assert r.status_code == 200
        gl = r.json()
        accts = gl.get("sections") or gl.get("accounts") or []
        assert accts, "no accounts/sections in GL"
        found_txn = found_je = False
        for a in accts:
            for e in a.get("entries", []):
                src = e.get("source")
                if src in ("Txn", "Split"):
                    assert e.get("txn_id"), f"Txn entry missing txn_id: {e}"
                    found_txn = True
                elif src == "JE":
                    assert e.get("je_id"), f"JE entry missing je_id: {e}"
                    found_je = True
        assert found_txn, "no Txn/Split entries found to verify"
        # JE may or may not exist; only assert if present entries
        _ = found_je


# ---------- New feature: Invoice PATCH ----------

class TestInvoiceEdit:
    def test_patch_invoice_status_and_lines(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/invoices")
        assert r.status_code == 200
        invs = r.json()["invoices"]
        assert invs, "no invoices seeded"
        inv = invs[0]
        iid = inv["id"]
        original_lines = inv["line_items"]
        original_tax = inv.get("tax", 0)
        original_notes = inv.get("notes", "")
        try:
            new_lines = [{"description": "TEST_iter9 edit", "quantity": 2, "rate": 55.50, "amount": 111.00}]
            r = client.patch(f"{API}/companies/{cid}/invoices/{iid}",
                             json={"line_items": new_lines, "tax": 0, "notes": "TEST_iter9"})
            assert r.status_code == 200, r.text
            r = client.get(f"{API}/companies/{cid}/invoices")
            upd = next(x for x in r.json()["invoices"] if x["id"] == iid)
            assert abs(float(upd["total"]) - 111.00) < 0.01, f"total not recalculated: {upd['total']}"
            assert upd.get("notes") == "TEST_iter9"
        finally:
            client.patch(f"{API}/companies/{cid}/invoices/{iid}",
                         json={"line_items": original_lines, "tax": original_tax, "notes": original_notes})


# ---------- New feature: Bill PATCH ----------

class TestBillEdit:
    def test_patch_bill(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/bills")
        assert r.status_code == 200
        bills = r.json()["bills"]
        assert bills, "no bills seeded"
        b = bills[0]
        bid = b["id"]
        original_lines = b["line_items"]
        original_tax = b.get("tax", 0)
        try:
            new_lines = [{"description": "TEST_iter9 bill edit", "quantity": 1, "rate": 77.25, "amount": 77.25}]
            r = client.patch(f"{API}/companies/{cid}/bills/{bid}",
                            json={"line_items": new_lines, "tax": 0})
            assert r.status_code == 200, r.text
            r = client.get(f"{API}/companies/{cid}/bills")
            upd = next(x for x in r.json()["bills"] if x["id"] == bid)
            assert abs(float(upd["total"]) - 77.25) < 0.01
        finally:
            client.patch(f"{API}/companies/{cid}/bills/{bid}",
                        json={"line_items": original_lines, "tax": original_tax})


# ---------- Regression: TB / BS balanced ----------

class TestBooksIntegrity:
    def test_trial_balance_balanced(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/reports/trial-balance")
        assert r.status_code == 200
        tb = r.json()
        assert abs(float(tb["total_debit"]) - float(tb["total_credit"])) < 0.01, \
            f"TB not balanced: {tb['total_debit']} vs {tb['total_credit']}"

    def test_balance_sheet_balanced(self, client, cid):
        r = client.get(f"{API}/companies/{cid}/reports/balance-sheet")
        assert r.status_code == 200
        bs = r.json()
        imb = float(bs.get("imbalance", 0))
        assert abs(imb) < 0.01, f"BS imbalance: {imb}"


# ---------- Regression sweep ----------

class TestRegressionReports:
    @pytest.mark.parametrize("path", [
        "reports/income-statement",
        "reports/cash-flow",
        "reports/sales-tax",
        "reports/1099-summary",
        "dashboard/metrics",
        "transactions",
        "accounts",
        "journal-entries",
        "contacts",
    ])
    def test_endpoints_ok(self, client, cid, path):
        r = client.get(f"{API}/companies/{cid}/{path}")
        assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text[:200]}"

    def test_plaid_link_token(self, client, cid):
        r = client.post(f"{API}/companies/{cid}/onboarding/plaid/link-token", json={})
        assert r.status_code == 200, r.text
        assert "link_token" in r.json() or "linkToken" in r.json()
