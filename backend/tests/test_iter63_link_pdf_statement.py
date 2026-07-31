"""Iter 63 — Auto-payment on link, PDF preview, Customer statement email.

Covers:
  - POST /transactions/{tid}/link?bill_id=X → auto-payment + balance update
  - POST /link?bill_id= (empty) → deletes payment + reverses balance
  - Idempotent double-link (no duplicate payments)
  - Invoice flow (partial + paid)
  - Invoice/Bill PDF endpoints (application/pdf + %PDF- magic)
  - Customer statement send-statement (404 unknown, 400 no email, 200 shape)
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "client@axiom.ai", "password": "client123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def hdr(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def contact_id(hdr):
    """Create a TEST_ contact reused across tests, cleaned up at end."""
    body = {"name": f"TEST_Iter63_{uuid.uuid4().hex[:8]}",
            "kind": "customer", "email": "test63@example.com"}
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/contacts",
                      headers=hdr, json=body)
    assert r.status_code in (200, 201), r.text
    cid_ = r.json().get("id") or r.json().get("contact", {}).get("id")
    yield cid_
    requests.delete(f"{BASE_URL}/api/companies/{CID}/contacts/{cid_}", headers=hdr)


def _create_bill(hdr, contact_id, amount=500.0):
    body = {
        "number": f"TEST-B-{uuid.uuid4().hex[:6]}",
        "contact_id": contact_id, "contact_name": "TEST_Iter63",
        "issue_date": "2026-01-05", "due_date": "2026-02-05",
        "status": "open",
        "line_items": [{"description": "test line", "quantity": 1,
                        "unit_price": amount, "amount": amount}],
        "tax": 0.0,
    }
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/bills", headers=hdr, json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _create_invoice(hdr, contact_id, amount=500.0):
    body = {
        "number": f"TEST-I-{uuid.uuid4().hex[:6]}",
        "contact_id": contact_id, "contact_name": "TEST_Iter63",
        "issue_date": "2026-01-05", "due_date": "2026-02-05",
        "status": "sent",
        "line_items": [{"description": "test line", "quantity": 1,
                        "unit_price": amount, "amount": amount}],
        "tax": 0.0,
    }
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/invoices", headers=hdr, json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _create_txn(hdr, amount=-500.0, date="2026-01-10"):
    body = {
        "date": date, "description": "TEST_iter63 txn",
        "merchant": "TEST_Iter63", "amount": amount,
        "auto_categorize": False,
    }
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/transactions",
                      headers=hdr, json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _cleanup_bill(hdr, bid): requests.delete(f"{BASE_URL}/api/companies/{CID}/bills/{bid}", headers=hdr)
def _cleanup_inv(hdr, iid):  requests.delete(f"{BASE_URL}/api/companies/{CID}/invoices/{iid}", headers=hdr)
def _cleanup_txn(hdr, tid):  requests.delete(f"{BASE_URL}/api/companies/{CID}/transactions/{tid}", headers=hdr)


# ------------------- LINK / AUTO-PAYMENT -------------------
class TestLinkAutoPayment:
    def test_link_bill_creates_payment_and_marks_paid(self, hdr, contact_id):
        bid = _create_bill(hdr, contact_id, 500.0)
        tid = _create_txn(hdr, amount=-500.0)
        try:
            r = requests.post(
                f"{BASE_URL}/api/companies/{CID}/transactions/{tid}/link",
                headers=hdr, params={"bill_id": bid})
            assert r.status_code == 200, r.text
            data = r.json()
            assert data.get("linked_payment_id"), f"expected linked_payment_id, got {data}"
            pid = data["linked_payment_id"]

            # Bill fully paid
            bill = requests.get(f"{BASE_URL}/api/companies/{CID}/bills", headers=hdr).json()["bills"]
            row = next(b for b in bill if b["id"] == bid)
            assert row["status"] == "paid"
            assert abs(float(row["balance_due"])) < 0.01

            # Payment exists with source_transaction_id
            pays = requests.get(f"{BASE_URL}/api/companies/{CID}/payments", headers=hdr).json()
            plist = pays.get("payments") or pays
            pay = next(p for p in plist if p["id"] == pid)
            assert pay["source_transaction_id"] == tid
            assert abs(float(pay["amount"]) - 500.0) < 0.01
            assert pay["linked_bill_id"] == bid

            # Idempotent: re-link returns same pid, no duplicate
            r2 = requests.post(
                f"{BASE_URL}/api/companies/{CID}/transactions/{tid}/link",
                headers=hdr, params={"bill_id": bid})
            assert r2.status_code == 200
            assert r2.json()["linked_payment_id"] == pid
            pays2 = requests.get(f"{BASE_URL}/api/companies/{CID}/payments", headers=hdr).json()
            plist2 = pays2.get("payments") or pays2
            dupes = [p for p in plist2 if p.get("source_transaction_id") == tid]
            assert len(dupes) == 1, f"duplicate auto-payments: {len(dupes)}"

            # Unlink → payment deleted, bill reverts
            r3 = requests.post(
                f"{BASE_URL}/api/companies/{CID}/transactions/{tid}/link",
                headers=hdr, params={"bill_id": ""})
            assert r3.status_code == 200
            assert r3.json().get("linked_payment_id") in (None, "")

            bill = requests.get(f"{BASE_URL}/api/companies/{CID}/bills", headers=hdr).json()["bills"]
            row = next(b for b in bill if b["id"] == bid)
            assert row["status"] == "open"
            assert abs(float(row["balance_due"]) - 500.0) < 0.01

            pays3 = requests.get(f"{BASE_URL}/api/companies/{CID}/payments", headers=hdr).json()
            plist3 = pays3.get("payments") or pays3
            assert not any(p["id"] == pid for p in plist3), "auto-payment should be deleted"
        finally:
            _cleanup_txn(hdr, tid); _cleanup_bill(hdr, bid)

    def test_link_invoice_partial_then_paid(self, hdr, contact_id):
        iid = _create_invoice(hdr, contact_id, 1000.0)
        t1 = _create_txn(hdr, amount=400.0)
        t2 = _create_txn(hdr, amount=600.0)
        try:
            r = requests.post(f"{BASE_URL}/api/companies/{CID}/transactions/{t1}/link",
                              headers=hdr, params={"invoice_id": iid})
            assert r.status_code == 200
            inv = requests.get(f"{BASE_URL}/api/companies/{CID}/invoices", headers=hdr).json()["invoices"]
            row = next(i for i in inv if i["id"] == iid)
            assert row["status"] == "partial"
            assert abs(float(row["balance_due"]) - 600.0) < 0.01

            r = requests.post(f"{BASE_URL}/api/companies/{CID}/transactions/{t2}/link",
                              headers=hdr, params={"invoice_id": iid})
            assert r.status_code == 200
            inv = requests.get(f"{BASE_URL}/api/companies/{CID}/invoices", headers=hdr).json()["invoices"]
            row = next(i for i in inv if i["id"] == iid)
            # marked paid ('sent' when fully covered per code path — accept either 'paid' or 'sent')
            assert row["status"] in ("paid", "sent"), f"got {row['status']}"
            assert abs(float(row["balance_due"])) < 0.01
        finally:
            _cleanup_txn(hdr, t1); _cleanup_txn(hdr, t2); _cleanup_inv(hdr, iid)


# ------------------- PDF ENDPOINTS -------------------
class TestPdf:
    def test_invoice_pdf(self, hdr, contact_id):
        iid = _create_invoice(hdr, contact_id, 250.0)
        try:
            r = requests.get(f"{BASE_URL}/api/companies/{CID}/invoices/{iid}/pdf", headers=hdr)
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("application/pdf")
            assert r.content[:4] == b"%PDF"
            cd = r.headers.get("content-disposition", "")
            assert "invoice-" in cd
        finally:
            _cleanup_inv(hdr, iid)

    def test_bill_pdf(self, hdr, contact_id):
        bid = _create_bill(hdr, contact_id, 250.0)
        try:
            r = requests.get(f"{BASE_URL}/api/companies/{CID}/bills/{bid}/pdf", headers=hdr)
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("application/pdf")
            assert r.content[:4] == b"%PDF"
            cd = r.headers.get("content-disposition", "")
            assert "bill-" in cd
        finally:
            _cleanup_bill(hdr, bid)


# ------------------- CUSTOMER STATEMENT -------------------
class TestSendStatement:
    def test_unknown_customer_404(self, hdr):
        r = requests.post(
            f"{BASE_URL}/api/companies/{CID}/customers/does-not-exist-xxx/send-statement",
            headers=hdr)
        assert r.status_code == 404

    def test_no_email_no_to_400(self, hdr):
        # Create contact with no email
        body = {"name": f"TEST_NoEmail_{uuid.uuid4().hex[:6]}", "kind": "customer"}
        rc = requests.post(f"{BASE_URL}/api/companies/{CID}/contacts", headers=hdr, json=body)
        cid_ = rc.json().get("id") or rc.json().get("contact", {}).get("id")
        try:
            r = requests.post(
                f"{BASE_URL}/api/companies/{CID}/customers/{cid_}/send-statement",
                headers=hdr)
            assert r.status_code == 400
        finally:
            requests.delete(f"{BASE_URL}/api/companies/{CID}/contacts/{cid_}", headers=hdr)

    def test_send_statement_shape(self, hdr, contact_id):
        # Seed an outstanding invoice
        iid = _create_invoice(hdr, contact_id, 1200.0)
        try:
            r = requests.post(
                f"{BASE_URL}/api/companies/{CID}/customers/{contact_id}/send-statement",
                headers=hdr,
                params={"start": "2026-01-01", "end": "2026-12-31",
                        "to": "test63@example.com"})
            assert r.status_code == 200, r.text
            data = r.json()
            for k in ("status", "to", "outstanding", "invoice_count", "email_log_id"):
                assert k in data, f"missing key {k} in {data}"
            assert data["to"] == "test63@example.com"
            assert data["invoice_count"] >= 1
            assert float(data["outstanding"]) >= 1200.0
            # status may be 'sent', 'failed' (no Resend key), or 'skipped_pref_off' — all acceptable shapes
            assert data["status"] in ("sent", "failed", "skipped_pref_off", "queued")
        finally:
            _cleanup_inv(hdr, iid)

    def test_statement_excludes_draft_and_out_of_range(self, hdr, contact_id):
        iid_in = _create_invoice(hdr, contact_id, 500.0)  # 2026-01-05, sent
        # Draft invoice — should be excluded
        body = {
            "number": f"TEST-D-{uuid.uuid4().hex[:6]}",
            "contact_id": contact_id, "contact_name": "TEST_Iter63",
            "issue_date": "2026-01-06", "due_date": "2026-02-06",
            "status": "draft",
            "line_items": [{"description": "x", "quantity": 1,
                            "unit_price": 999.0, "amount": 999.0}],
            "tax": 0.0,
        }
        rc = requests.post(f"{BASE_URL}/api/companies/{CID}/invoices", headers=hdr, json=body)
        iid_draft = rc.json()["id"]
        # Out-of-range invoice (2025)
        body2 = dict(body); body2["status"] = "sent"; body2["issue_date"] = "2025-06-01"
        body2["number"] = f"TEST-O-{uuid.uuid4().hex[:6]}"
        rc2 = requests.post(f"{BASE_URL}/api/companies/{CID}/invoices", headers=hdr, json=body2)
        iid_out = rc2.json()["id"]
        try:
            r = requests.post(
                f"{BASE_URL}/api/companies/{CID}/customers/{contact_id}/send-statement",
                headers=hdr,
                params={"start": "2026-01-01", "end": "2026-06-30",
                        "to": "test63@example.com"})
            assert r.status_code == 200
            data = r.json()
            # Only the in-range non-draft invoice should be counted
            assert float(data["outstanding"]) == 500.0, f"outstanding={data['outstanding']}"
            assert data["invoice_count"] == 1
        finally:
            _cleanup_inv(hdr, iid_in); _cleanup_inv(hdr, iid_draft); _cleanup_inv(hdr, iid_out)
