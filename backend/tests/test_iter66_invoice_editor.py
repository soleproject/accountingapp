"""Iter 66 — Full-page Invoice Editor backend tests.

Covers:
  * GET  /api/companies/{cid}/invoices/{iid}  — new single-resource endpoint
  * POST /api/companies/{cid}/invoices        — accepts po_number/terms/discount/
                                                discount_type/shipping/internal_notes/attachments
  * PATCH /api/companies/{cid}/invoices/{iid} — recomputes total with new fields
  * GET  /api/companies/{cid}/invoices/{iid}/pdf   — must still return 200 pdf
  * POST /api/companies/{cid}/invoices/{iid}/send-email — dispatch, no 500
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
CLIENT_EMAIL = "client@axiom.ai"
CLIENT_PW = "client123"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": CLIENT_EMAIL, "password": CLIENT_PW})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    token = r.json().get("token") or r.json().get("access_token")
    assert token, f"no token in login response: {r.json()}"
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module")
def cid(session):
    r = session.get(f"{BASE_URL}/api/companies")
    assert r.status_code == 200
    companies = r.json().get("companies") or []
    assert companies, "no companies for client"
    return companies[0]["id"]


@pytest.fixture(scope="module")
def contact_id(session, cid):
    r = session.get(f"{BASE_URL}/api/companies/{cid}/contacts")
    assert r.status_code == 200
    contacts = r.json().get("contacts") or []
    # Prefer a customer contact.
    for c in contacts:
        if c.get("type") in ("customer", "both") and c.get("email"):
            return c["id"]
    for c in contacts:
        if c.get("type") in ("customer", "both"):
            return c["id"]
    return contacts[0]["id"] if contacts else None


# ---------- tests ----------
class TestInvoiceEditor:
    created_iid = None

    def test_create_invoice_with_new_fields(self, session, cid, contact_id):
        body = {
            "number": "TEST_INV-9999-EDITOR",
            "contact_id": contact_id,
            "contact_name": "",
            "issue_date": "2026-01-01",
            "due_date": "2026-01-31",
            "line_items": [
                {"description": "Consulting hours", "quantity": 3, "rate": 150, "amount": 450}
            ],
            "tax": 15,
            "shipping": 25,
            "discount": 50,
            "discount_type": "amount",
            "po_number": "PO-42",
            "terms": "Net 30",
            "notes": "Thanks!",
            "internal_notes": "Do not send to Bob",
            "attachments": [],
            "status": "draft",
        }
        r = session.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=body)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "id" in data
        inv = data["invoice"]
        # subtotal 450 − discount 50 + shipping 25 + tax 15 = 440
        assert inv["subtotal"] == 450.0
        assert inv["discount_amount"] == 50.0
        assert inv["shipping"] == 25.0
        assert inv["tax"] == 15.0
        assert inv["total"] == 440.0
        assert inv["po_number"] == "PO-42"
        assert inv["terms"] == "Net 30"
        assert inv["internal_notes"] == "Do not send to Bob"
        assert inv["discount_type"] == "amount"
        TestInvoiceEditor.created_iid = data["id"]

    def test_get_single_invoice_returns_new_fields(self, session, cid):
        iid = TestInvoiceEditor.created_iid
        assert iid
        r = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}")
        assert r.status_code == 200, r.text
        inv = r.json()["invoice"]
        for k in ("po_number", "terms", "discount", "discount_type",
                  "discount_amount", "shipping", "internal_notes",
                  "attachments", "notes"):
            assert k in inv, f"missing field: {k}"
        assert inv["po_number"] == "PO-42"
        assert inv["notes"] == "Thanks!"

    def test_patch_recomputes_total_percent_discount(self, session, cid):
        iid = TestInvoiceEditor.created_iid
        # 10% of 450 = 45; total = 450 − 45 + 25 + 15 = 445
        r = session.patch(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}",
                          json={"discount": 10, "discount_type": "percent"})
        assert r.status_code == 200, r.text
        g = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}").json()["invoice"]
        assert g["discount_type"] == "percent"
        assert g["discount_amount"] == 45.0
        assert g["total"] == 445.0

    def test_patch_recomputes_with_shipping_change(self, session, cid):
        iid = TestInvoiceEditor.created_iid
        # switch back to $50 discount, shipping=100 → 450 − 50 + 100 + 15 = 515
        r = session.patch(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}",
                          json={"discount": 50, "discount_type": "amount", "shipping": 100})
        assert r.status_code == 200
        g = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}").json()["invoice"]
        assert g["shipping"] == 100.0
        assert g["discount_amount"] == 50.0
        assert g["total"] == 515.0

    def test_pdf_still_renders(self, session, cid):
        iid = TestInvoiceEditor.created_iid
        r = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}/pdf")
        assert r.status_code == 200, r.text[:200]
        assert "application/pdf" in r.headers.get("content-type", "")
        assert r.content[:4] == b"%PDF"

    def test_send_email_no_500(self, session, cid):
        iid = TestInvoiceEditor.created_iid
        r = session.post(
            f"{BASE_URL}/api/companies/{cid}/invoices/{iid}/send-email",
            params={"to": "someone@example.com"},
        )
        assert r.status_code == 200, f"send-email crashed: {r.status_code} {r.text[:400]}"
        body = r.json()
        assert body.get("status") in ("sent", "failed", "skipped_opt_out", "skipped"), body
        assert body.get("to") == "someone@example.com"
        # If it was sent and invoice was draft → status must have auto-flipped
        if body["status"] == "sent":
            g = session.get(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}").json()["invoice"]
            assert g["status"] in ("sent", "partial", "paid"), \
                f"draft should auto-flip after successful send, got {g['status']}"

    def test_zzz_cleanup(self, session, cid):
        iid = TestInvoiceEditor.created_iid
        if iid:
            session.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}")
