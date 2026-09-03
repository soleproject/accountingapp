"""Regression: Invoice line-tax must survive create → fetch → patch cycles.

Two bugs fixed together (see InvoiceEditor.jsx / EstimateEditor.jsx):
  1. Line tax fields (tax_id, tax_name, tax_rate, tax_amount) must persist
     in DB after create and after any patch that touches line_items.
  2. Re-saving an invoice must NOT double the rolled-up doc-level `tax`
     value. `inv.tax` on disk = doc-level input + Σ line tax. When the
     frontend re-submits without changing anything, the backend's peel-
     back logic must keep the total stable.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
CLIENT_EMAIL = "client@axiom.ai"
CLIENT_PW = "client123"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": CLIENT_EMAIL, "password": CLIENT_PW})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    token = r.json().get("token") or r.json().get("access_token")
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module")
def cid(session):
    r = session.get(f"{BASE_URL}/api/companies")
    return (r.json().get("companies") or [])[0]["id"]


@pytest.fixture(scope="module")
def tax_id(session, cid):
    # Ensure a 10% tax exists we can attach to a line.
    name = "Regression Line Tax 10%"
    r = session.get(f"{BASE_URL}/api/companies/{cid}/taxes")
    for t in (r.json().get("taxes") or []):
        if t.get("name") == name:
            return t["id"]
    r = session.post(f"{BASE_URL}/api/companies/{cid}/taxes",
                     json={"name": name, "rate": 10})
    assert r.status_code == 200, r.text
    return r.json()["tax"]["id"]


def _mk_line(tax_id):
    return {
        "description": "Line-tax regression",
        "quantity": 1, "rate": 100, "amount": 100,
        "tax_id": tax_id, "tax_name": "Regression Line Tax 10%", "tax_rate": 10,
    }


class TestLineTaxPersistence:
    def test_create_persists_line_tax_fields(self, session, cid, tax_id):
        body = {
            "contact_id": None, "contact_name": "Regression",
            "issue_date": "2026-02-01", "due_date": "2026-03-01",
            "line_items": [_mk_line(tax_id)],
            "tax": 0, "shipping": 0, "discount": 0, "discount_type": "amount",
            "status": "draft",
        }
        r = session.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=body)
        assert r.status_code == 200, r.text
        inv = r.json()["invoice"]
        TestLineTaxPersistence.iid = inv["id"]
        assert inv["tax"] == 10, f"expected rolled-up tax=10, got {inv['tax']}"
        assert inv["total"] == 110, f"expected total 110, got {inv['total']}"
        line = inv["line_items"][0]
        assert line["tax_id"] == tax_id
        assert line["tax_rate"] == 10
        assert line["tax_amount"] == 10, f"tax_amount rollup missing: {line}"

    def test_get_returns_line_tax_fields(self, session, cid):
        r = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{TestLineTaxPersistence.iid}")
        assert r.status_code == 200
        line = r.json()["invoice"]["line_items"][0]
        assert line.get("tax_id"), "tax_id lost after GET"
        assert line.get("tax_rate") == 10
        assert line.get("tax_amount") == 10

    def test_resave_does_not_double_tax(self, session, cid, tax_id):
        """Simulate the frontend load → save with no changes cycle.

        The (fixed) frontend now peels the rolled-up figure off `tax`
        before submitting, so the payload carries doc-level tax=0.
        """
        line = _mk_line(tax_id)
        line["tax_amount"] = 10  # what we'd have loaded from GET
        payload = {
            "line_items": [line],
            "tax": 0,  # doc-level only (rollup peeled off client-side)
        }
        r = session.patch(
            f"{BASE_URL}/api/companies/{cid}/invoices/{TestLineTaxPersistence.iid}",
            json=payload,
        )
        assert r.status_code == 200, r.text
        r2 = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{TestLineTaxPersistence.iid}")
        inv = r2.json()["invoice"]
        assert inv["tax"] == 10, f"tax doubled: expected 10, got {inv['tax']}"
        assert inv["total"] == 110, f"total doubled: {inv['total']}"

    def test_patch_omitting_tax_preserves_rollup(self, session, cid, tax_id):
        """If the caller PATCHes just line_items (no `tax` key at all), the
        backend peel-back logic must keep the rollup stable."""
        line = _mk_line(tax_id)
        line["tax_amount"] = 10
        r = session.patch(
            f"{BASE_URL}/api/companies/{cid}/invoices/{TestLineTaxPersistence.iid}",
            json={"line_items": [line]},
        )
        assert r.status_code == 200
        r2 = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{TestLineTaxPersistence.iid}")
        inv = r2.json()["invoice"]
        assert inv["tax"] == 10, f"tax drift when omitted from payload: {inv['tax']}"
