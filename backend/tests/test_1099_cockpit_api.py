"""1099 Cockpit — API integration tests (iteration 88)."""
import os
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE:
    # Fallback to internal for CI
    BASE = "http://localhost:8001"

PRO = {"email": "pro@axiom.ai", "password": "pro123"}
CLIENT = {"email": "client@axiom.ai", "password": "client123"}
CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"  # Bright Beans Coffee Co.


def _login(creds):
    r = requests.post(f"{BASE}/api/auth/login", json=creds, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_token():
    return _login(PRO)


@pytest.fixture(scope="module")
def client_token():
    return _login(CLIENT)


@pytest.fixture(scope="module")
def pro_hdr(pro_token):
    return {"Authorization": f"Bearer {pro_token}"}


@pytest.fixture(scope="module")
def client_hdr(client_token):
    return {"Authorization": f"Bearer {client_token}"}


# Cross rollup ---------------------------------------------------------------

def test_cross_summary_pro_200(pro_hdr):
    r = requests.get(f"{BASE}/api/cockpit/1099/summary?year=2026", headers=pro_hdr, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["year"] == 2026
    assert d["threshold"] == 600
    for k in ("needs_1099", "on_watch", "missing_w9", "missing_tin", "companies_with_activity"):
        assert k in d["totals"]
    assert isinstance(d["per_company"], list)
    # Ensure Bright Beans present with activity
    matches = [c for c in d["per_company"] if c["company_id"] == CID]
    assert matches, f"Bright Beans not in per_company: {d['per_company']}"


def test_cross_summary_client_forbidden(client_hdr):
    r = requests.get(f"{BASE}/api/cockpit/1099/summary?year=2026", headers=client_hdr, timeout=30)
    assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"


# Per-company vendors --------------------------------------------------------

def test_vendors_list_pro_200(pro_hdr):
    r = requests.get(f"{BASE}/api/companies/{CID}/1099/vendors?year=2026", headers=pro_hdr, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["year"] == 2026 and d["threshold"] == 600
    vendors = d["vendors"]
    assert d["count"] == len(vendors)
    # Sorted needs_1099 first, then on_watch, then rest
    keys = [(0 if v["needs_1099"] else 1 if v["on_watch"] else 2) for v in vendors]
    assert keys == sorted(keys), f"vendors not sorted: {keys}"
    # Each vendor has expected fields
    if vendors:
        v = vendors[0]
        for f in ("contact_id", "vendor_name", "email", "total_paid", "txn_count",
                  "is_1099_vendor", "w9_on_file", "has_tin", "needs_1099",
                  "on_watch", "threshold_gap", "issues"):
            assert f in v, f"missing {f}"
    # Verify seeded vendors present
    names = [v["vendor_name"] for v in vendors]
    assert any("ACME" in n for n in names), f"ACME missing: {names}"


# Request W9 ------------------------------------------------------------------

def test_request_w9_creates_question(pro_hdr):
    # find ACME
    r = requests.get(f"{BASE}/api/companies/{CID}/1099/vendors?year=2026", headers=pro_hdr, timeout=30)
    acme = next((v for v in r.json()["vendors"] if "ACME" in v["vendor_name"]), None)
    assert acme, "ACME vendor not found"
    r = requests.post(
        f"{BASE}/api/companies/{CID}/1099/vendors/{acme['contact_id']}/request-w9",
        headers=pro_hdr, timeout=30,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True
    assert d.get("question_id") and d.get("magic_url", "").startswith("/q/")


# Preview + PDF ---------------------------------------------------------------

def test_preview_and_pdf(pro_hdr):
    r = requests.get(f"{BASE}/api/companies/{CID}/1099/vendors?year=2026", headers=pro_hdr, timeout=30)
    acme = next((v for v in r.json()["vendors"] if "ACME" in v["vendor_name"]), None)
    assert acme
    r = requests.get(
        f"{BASE}/api/companies/{CID}/1099/preview/{acme['contact_id']}?year=2026",
        headers=pro_hdr, timeout=30,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["form_type"] == "1099-NEC"
    assert d["year"] == 2026
    assert "payer" in d and "recipient" in d
    assert "box_1_nonemployee_compensation" in d

    r = requests.get(
        f"{BASE}/api/companies/{CID}/1099/pdf/{acme['contact_id']}?year=2026",
        headers=pro_hdr, timeout=30,
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("application/pdf")
    assert "attachment" in r.headers.get("content-disposition", "").lower()
    assert len(r.content) > 1024, f"PDF too small: {len(r.content)} bytes"
