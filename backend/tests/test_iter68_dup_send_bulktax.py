"""Iter 68 — Backend tests for Duplicate Invoice/Bill, Bill Send-Email, Bulk Tax Import."""
import os
from datetime import datetime, timezone, timedelta
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = "client@axiom.ai"
PASSWORD = "client123"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def cid(client):
    r = client.get(f"{BASE_URL}/api/companies")
    assert r.status_code == 200
    companies = r.json().get("companies") or r.json()
    for c in companies:
        if "skyward" in (c.get("name", "").lower()):
            return c["id"]
    return companies[0]["id"]


def _today():
    return datetime.now(timezone.utc).date().isoformat()


def _plus_30():
    return (datetime.now(timezone.utc).date() + timedelta(days=30)).isoformat()


# ─────────── Duplicate Invoice ───────────
class TestDuplicateInvoice:
    def test_duplicate_invoice_copies_all_fields(self, client, cid):
        payload = {
            "number": "TEST_INV_DUP_68",
            "contact_name": "Cust A",
            "issue_date": "2025-06-01",
            "due_date": "2025-06-15",
            "line_items": [
                {"description": "Widget", "quantity": 2, "rate": 25, "amount": 50, "tax_rate": 10},
                {"description": "Setup fee", "quantity": 1, "rate": 100, "amount": 100},
            ],
            "tax": 0, "shipping": 7, "discount": 5, "discount_type": "amount",
            "status": "sent",
            "notes": "Public", "po_number": "PO-DUP", "terms": "Net 30",
            "internal_notes": "internal", "attachments": [{"filename": "a.pdf", "content": "AAA"}],
            "title": "Dup title", "summary": "Dup summary",
        }
        r = client.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=payload)
        assert r.status_code == 200, r.text
        src_id = r.json()["id"]
        src = r.json()["invoice"]

        try:
            r = client.post(f"{BASE_URL}/api/companies/{cid}/invoices/{src_id}/duplicate")
            assert r.status_code == 200, r.text
            new_id = r.json()["id"]
            dup = r.json()["invoice"]

            assert new_id != src_id
            assert dup["number"] != src["number"]
            assert dup["number"].startswith("INV-")
            assert dup["issue_date"] == _today()
            assert dup["due_date"] == _plus_30()
            assert dup["status"] == "draft"
            assert dup["balance_due"] == dup["total"]
            # Copied fields
            for k in ("po_number", "terms", "notes", "internal_notes", "title", "summary",
                      "discount", "discount_type", "shipping", "tax", "attachments",
                      "line_items", "contact_name", "subtotal", "total"):
                assert dup[k] == src[k], f"{k} differs: {dup[k]} vs {src[k]}"

            # Confirm persistence
            r = client.get(f"{BASE_URL}/api/companies/{cid}/invoices/{new_id}")
            assert r.status_code == 200
            assert r.json()["invoice"]["number"] == dup["number"]
            client.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{new_id}")
        finally:
            client.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{src_id}")

    def test_duplicate_invoice_404(self, client, cid):
        r = client.post(f"{BASE_URL}/api/companies/{cid}/invoices/no-such-id/duplicate")
        assert r.status_code == 404


# ─────────── Duplicate Bill ───────────
class TestDuplicateBill:
    def test_duplicate_bill_copies_all_fields(self, client, cid):
        payload = {
            "number": "TEST_BILL_DUP_68",
            "contact_name": "Vend A",
            "issue_date": "2025-05-01",
            "due_date": "2025-05-15",
            "line_items": [
                {"description": "Parts", "quantity": 3, "rate": 20, "amount": 60},
            ],
            "tax": 5, "shipping": 3, "discount": 2, "discount_type": "amount",
            "status": "paid",
            "notes": "n", "po_number": "PO-B", "terms": "Net 15",
            "internal_notes": "iN", "attachments": [], "title": "T", "summary": "S",
        }
        r = client.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload)
        assert r.status_code == 200, r.text
        src_id = r.json()["id"]
        src = r.json()["bill"]

        try:
            r = client.post(f"{BASE_URL}/api/companies/{cid}/bills/{src_id}/duplicate")
            assert r.status_code == 200, r.text
            new_id = r.json()["id"]
            dup = r.json()["bill"]
            assert new_id != src_id
            assert dup["number"] != src["number"]
            assert dup["number"].startswith("BILL-")
            assert dup["issue_date"] == _today()
            assert dup["due_date"] == _plus_30()
            assert dup["status"] == "open"
            assert dup["balance_due"] == dup["total"]
            for k in ("po_number", "terms", "notes", "internal_notes",
                      "discount", "discount_type", "shipping", "tax",
                      "line_items", "contact_name", "subtotal", "total"):
                assert dup[k] == src[k], f"{k} differs"
            client.delete(f"{BASE_URL}/api/companies/{cid}/bills/{new_id}")
        finally:
            client.delete(f"{BASE_URL}/api/companies/{cid}/bills/{src_id}")

    def test_duplicate_bill_404(self, client, cid):
        r = client.post(f"{BASE_URL}/api/companies/{cid}/bills/no-such-id/duplicate")
        assert r.status_code == 404


# ─────────── Bill Send Email ───────────
class TestBillSendEmail:
    def test_send_with_to_override(self, client, cid):
        payload = {
            "number": "TEST_BILL_SEND_68",
            "contact_name": "Vend Send",
            "issue_date": "2025-01-01",
            "due_date": "2025-01-15",
            "line_items": [{"description": "x", "quantity": 1, "rate": 10, "amount": 10}],
            "status": "open",
        }
        r = client.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload)
        assert r.status_code == 200
        bid = r.json()["id"]
        try:
            r = client.post(
                f"{BASE_URL}/api/companies/{cid}/bills/{bid}/send-email",
                params={"to": "test-vendor@example.com"},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert "status" in body
            assert body["to"] == "test-vendor@example.com"
            assert "email_log_id" in body
        finally:
            client.delete(f"{BASE_URL}/api/companies/{cid}/bills/{bid}")

    def test_send_without_email_400(self, client, cid):
        # Create a bill with no contact_id (no email lookup possible), no override
        payload = {
            "number": "TEST_BILL_NO_EMAIL_68",
            "contact_name": "NoEmail Vendor",
            "issue_date": "2025-01-01",
            "due_date": "2025-01-15",
            "line_items": [{"description": "x", "quantity": 1, "rate": 10, "amount": 10}],
            "status": "open",
        }
        r = client.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload)
        bid = r.json()["id"]
        try:
            r = client.post(f"{BASE_URL}/api/companies/{cid}/bills/{bid}/send-email")
            assert r.status_code == 400, r.text
            assert "email" in r.text.lower()
        finally:
            client.delete(f"{BASE_URL}/api/companies/{cid}/bills/{bid}")

    def test_send_404_unknown_bill(self, client, cid):
        r = client.post(f"{BASE_URL}/api/companies/{cid}/bills/no-such/send-email",
                        params={"to": "x@y.com"})
        assert r.status_code == 404


# ─────────── Bulk Tax Import ───────────
class TestBulkTaxImport:
    def test_bulk_import_flow(self, client, cid):
        # Cleanup residuals from prior runs
        r = client.get(f"{BASE_URL}/api/companies/{cid}/taxes")
        for t in r.json().get("taxes", []):
            if t["name"] in ("GST", "HST"):
                client.delete(f"{BASE_URL}/api/companies/{cid}/taxes/{t['id']}")

        rows = [
            {"name": "GST", "rate": 5},
            {"name": "HST", "rate": 13},
            {"name": "BAD", "rate": 999},
            {"name": "", "rate": 0},
        ]
        r = client.post(f"{BASE_URL}/api/companies/{cid}/taxes/bulk-import",
                        json={"rows": rows})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 2
        assert body["updated"] == 0
        assert body["total_rows"] == 4
        assert len(body["skipped"]) == 2
        reasons = {s["row"]: s["reason"] for s in body["skipped"]}
        assert reasons[3] == "rate must be between 0 and 100"
        assert reasons[4] == "name is empty"

        # Idempotent re-import: same rows
        r = client.post(f"{BASE_URL}/api/companies/{cid}/taxes/bulk-import",
                        json={"rows": rows})
        b2 = r.json()
        assert b2["created"] == 0
        assert b2["updated"] == 0
        assert len(b2["skipped"]) == 2

        # Modify GST rate → updated=1
        rows[0]["rate"] = 6
        r = client.post(f"{BASE_URL}/api/companies/{cid}/taxes/bulk-import",
                        json={"rows": rows})
        b3 = r.json()
        assert b3["created"] == 0
        assert b3["updated"] == 1
        assert len(b3["skipped"]) == 2

        # Confirm GST rate persisted
        r = client.get(f"{BASE_URL}/api/companies/{cid}/taxes")
        taxes = {t["name"]: t for t in r.json()["taxes"]}
        assert taxes["GST"]["rate"] == 6
        assert taxes["HST"]["rate"] == 13

        # Cleanup
        for name in ("GST", "HST"):
            if name in taxes:
                client.delete(f"{BASE_URL}/api/companies/{cid}/taxes/{taxes[name]['id']}")
