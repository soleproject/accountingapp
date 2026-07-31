"""Iteration 65 — Company branding fields + branded invoice/bill PDFs.

Covers:
- PATCH /api/companies/{cid} allows logo_data_url / address / phone / email / website / tax_id
- Unknown fields rejected with 400 (allowed-list still enforced)
- GET /api/companies/{cid}/invoices/{iid}/pdf renders plain header when no branding
- Same endpoint returns larger PDF after branding is set
- GET /api/companies/{cid}/bills/{bid}/pdf mirrors branding
"""
import os
import base64
import requests
import pytest

def _load_base_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if not v:
        try:
            with open("/app/frontend/.env") as f:
                for line in f:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        v = line.split("=", 1)[1].strip()
                        break
        except Exception:
            pass
    return (v or "").rstrip("/")


BASE_URL = _load_base_url()
assert BASE_URL, "REACT_APP_BACKEND_URL is required"

EMAIL = "client@axiom.ai"
PASSWORD = "client123"
CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"

# 1x1 transparent PNG
PNG_1x1_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
LOGO_DATA_URL = f"data:image/png;base64,{PNG_1x1_B64}"

BRANDING = {
    "logo_data_url": LOGO_DATA_URL,
    "address": "123 Test St\nSpringfield, IL 62701",
    "phone": "(555) 123-4567",
    "email": "billing@testco.com",
    "website": "testco.com",
    "tax_id": "12-3456789",
}

ORIGINAL_SNAPSHOT = {}


@pytest.fixture(scope="module")
def token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"No token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def hdr(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module", autouse=True)
def snapshot_and_restore(hdr):
    """Snapshot current branding, then restore after tests."""
    r = requests.get(f"{BASE_URL}/api/companies", headers=hdr, timeout=15)
    assert r.status_code == 200
    company = next((c for c in r.json()["companies"] if c["id"] == CID), None)
    assert company, f"Company {CID} not found for user"
    for k in ("logo_data_url", "address", "phone", "email", "website", "tax_id"):
        ORIGINAL_SNAPSHOT[k] = company.get(k) or ""
    yield
    # Restore
    requests.patch(f"{BASE_URL}/api/companies/{CID}",
                   json=ORIGINAL_SNAPSHOT, headers=hdr, timeout=15)


@pytest.fixture(scope="module")
def one_invoice_id(hdr):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/invoices", headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    invoices = body.get("invoices") if isinstance(body, dict) else body
    assert invoices, "No invoices to test PDF against"
    return invoices[0]["id"]


@pytest.fixture(scope="module")
def one_bill_id(hdr):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/bills", headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    bills = body.get("bills") if isinstance(body, dict) else body
    if not bills:
        pytest.skip("No bills exist for this company")
    return bills[0]["id"]


def _clear_branding(hdr):
    cleared = {k: "" for k in BRANDING}
    r = requests.patch(f"{BASE_URL}/api/companies/{CID}", json=cleared,
                       headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


class TestBrandingAndPdf:
    """All in one class so xdist loadscope keeps these on ONE worker
    (they all mutate the same company doc — races otherwise)."""

    def test_01_patch_rejects_unknown_field(self, hdr):
        r = requests.patch(
            f"{BASE_URL}/api/companies/{CID}",
            json={"totally_bogus_field": "x"},
            headers=hdr, timeout=15,
        )
        assert r.status_code == 400
        assert "No editable fields" in r.text

    def test_02_patch_accepts_branding_fields_round_trip(self, hdr):
        r = requests.patch(
            f"{BASE_URL}/api/companies/{CID}",
            json=BRANDING, headers=hdr, timeout=15,
        )
        assert r.status_code == 200, r.text
        doc = r.json()
        for k, v in BRANDING.items():
            assert doc.get(k) == v, f"Field {k} did not round-trip: got {doc.get(k)!r}"
        r2 = requests.get(f"{BASE_URL}/api/companies", headers=hdr, timeout=15)
        assert r2.status_code == 200
        company = next(c for c in r2.json()["companies"] if c["id"] == CID)
        for k, v in BRANDING.items():
            assert company.get(k) == v

    def test_03_invoice_pdf_plain_then_branded_grows(self, hdr, one_invoice_id):
        _clear_branding(hdr)
        r1 = requests.get(
            f"{BASE_URL}/api/companies/{CID}/invoices/{one_invoice_id}/pdf",
            headers=hdr, timeout=30,
        )
        assert r1.status_code == 200, r1.text[:400]
        assert r1.headers.get("content-type", "").startswith("application/pdf")
        assert r1.content[:5] == b"%PDF-"
        assert len(r1.content) > 500
        plain_size = len(r1.content)

        rp = requests.patch(f"{BASE_URL}/api/companies/{CID}", json=BRANDING,
                            headers=hdr, timeout=15)
        assert rp.status_code == 200
        r2 = requests.get(
            f"{BASE_URL}/api/companies/{CID}/invoices/{one_invoice_id}/pdf",
            headers=hdr, timeout=30,
        )
        assert r2.status_code == 200
        assert r2.content[:5] == b"%PDF-"
        assert len(r2.content) > plain_size, (
            f"Branded PDF ({len(r2.content)}) not larger than plain ({plain_size})"
        )

    def test_04_bill_pdf_with_branding(self, hdr, one_bill_id):
        requests.patch(f"{BASE_URL}/api/companies/{CID}", json=BRANDING,
                       headers=hdr, timeout=15)
        r = requests.get(
            f"{BASE_URL}/api/companies/{CID}/bills/{one_bill_id}/pdf",
            headers=hdr, timeout=30,
        )
        assert r.status_code == 200, r.text[:400]
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content[:5] == b"%PDF-"
        assert len(r.content) > 500

    def test_05_bill_pdf_plain(self, hdr, one_bill_id):
        _clear_branding(hdr)
        r = requests.get(
            f"{BASE_URL}/api/companies/{CID}/bills/{one_bill_id}/pdf",
            headers=hdr, timeout=30,
        )
        assert r.status_code == 200
        assert r.content[:5] == b"%PDF-"
