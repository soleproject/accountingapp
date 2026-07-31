"""Iteration 64 — Link cascade delete tests.

Covers:
- DELETE invoice cascades linked payments + clears txn back-refs.
- DELETE bill cascades linked payments + clears txn back-refs.
- DELETE transaction reverses linked payment balance impact + deletes payment.
- Idempotency (no linked payment => payments_deleted=0).
- Report consistency (purchases-by-category / revenue-by-customer).
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"
CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"
CLIENT_EMAIL = "client@axiom.ai"
CLIENT_PW = "client123"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json={"email": CLIENT_EMAIL, "password": CLIENT_PW})
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


def _mk_invoice(sess, total=300.0, marker="TEST"):
    payload = {
        "number": f"TEST-INV-{uuid.uuid4().hex[:6]}",
        "contact_name": f"{marker}_Cust_{uuid.uuid4().hex[:4]}",
        "issue_date": "2026-01-05",
        "due_date": "2026-02-05",
        "status": "sent",
        "line_items": [{"description": "svc", "quantity": 1, "unit_price": total, "amount": total}],
        "tax": 0,
    }
    r = sess.post(f"{API}/companies/{CID}/invoices", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["id"], payload["contact_name"]


def _mk_bill(sess, total=200.0, marker="TEST"):
    payload = {
        "number": f"TEST-BILL-{uuid.uuid4().hex[:6]}",
        "contact_name": f"{marker}_Vend_{uuid.uuid4().hex[:4]}",
        "issue_date": "2026-01-06",
        "due_date": "2026-02-06",
        "status": "open",
        "line_items": [{"description": "svc", "quantity": 1, "unit_price": total, "amount": total,
                        "expense_account_name": f"{marker}_Cat_{uuid.uuid4().hex[:4]}"}],
        "tax": 0,
    }
    r = sess.post(f"{API}/companies/{CID}/bills", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["id"], payload["contact_name"], payload["line_items"][0]["expense_account_name"]


def _mk_txn(sess, amount, description):
    payload = {
        "date": "2026-01-10",
        "description": description,
        "merchant": description,
        "amount": amount,
        "auto_categorize": False,
    }
    r = sess.post(f"{API}/companies/{CID}/transactions", json=payload)
    assert r.status_code == 200, r.text
    return r.json().get("id") or r.json().get("transaction", {}).get("id")


def _link_txn(sess, tid, invoice_id=None, bill_id=None):
    params = {}
    if invoice_id is not None:
        params["invoice_id"] = invoice_id
    if bill_id is not None:
        params["bill_id"] = bill_id
    r = sess.post(f"{API}/companies/{CID}/transactions/{tid}/link", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _get_txn(sess, tid):
    r = sess.get(f"{API}/companies/{CID}/transactions", params={"limit": 5000})
    assert r.status_code == 200
    for t in r.json().get("transactions", r.json().get("items", [])):
        if t.get("id") == tid:
            return t
    return None


def _get_invoice(sess, iid):
    r = sess.get(f"{API}/companies/{CID}/invoices")
    assert r.status_code == 200
    for i in r.json()["invoices"]:
        if i["id"] == iid:
            return i
    return None


def _get_bill(sess, bid):
    r = sess.get(f"{API}/companies/{CID}/bills")
    assert r.status_code == 200
    for i in r.json()["bills"]:
        if i["id"] == bid:
            return i
    return None


def _payments_for_doc(sess, field, doc_id):
    r = sess.get(f"{API}/companies/{CID}/payments")
    assert r.status_code == 200, r.text
    return [p for p in r.json().get("payments", []) if p.get(field) == doc_id]


# ---------------- Tests ----------------

class TestInvoiceDeleteCascade:
    def test_invoice_delete_cascades_payment_and_clears_txn(self, session):
        iid, _ = _mk_invoice(session, total=300.0)
        tid = _mk_txn(session, 300.0, "TEST cascade inv pay")
        link_res = _link_txn(session, tid, invoice_id=iid)
        pid = link_res.get("linked_payment_id")
        assert pid, f"Auto-payment not created: {link_res}"

        # Sanity: invoice paid
        inv = _get_invoice(session, iid)
        assert inv["status"] == "paid"
        assert abs(float(inv["balance_due"])) < 0.01

        # DELETE invoice
        r = session.delete(f"{API}/companies/{CID}/invoices/{iid}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("payments_deleted") == 1, body
        assert body.get("transactions_cleared") == 1, body

        # Payment gone
        pays = _payments_for_doc(session, "linked_invoice_id", iid)
        assert pays == []

        # Transaction back-refs cleared
        txn = _get_txn(session, tid)
        assert txn is not None
        assert txn.get("linked_invoice_id") in (None, "")
        assert txn.get("linked_payment_id") in (None, "")

        # cleanup
        session.delete(f"{API}/companies/{CID}/transactions/{tid}")

    def test_invoice_delete_no_payments_returns_zero(self, session):
        iid, _ = _mk_invoice(session, total=99.0)
        r = session.delete(f"{API}/companies/{CID}/invoices/{iid}")
        assert r.status_code == 200
        body = r.json()
        assert body.get("payments_deleted") == 0
        assert body.get("transactions_cleared") == 0


class TestBillDeleteCascade:
    def test_bill_delete_cascades_payment_and_clears_txn(self, session):
        bid, _, _ = _mk_bill(session, total=200.0)
        tid = _mk_txn(session, 200.0, "TEST cascade bill pay")
        link_res = _link_txn(session, tid, bill_id=bid)
        pid = link_res.get("linked_payment_id")
        assert pid, f"Auto-payment not created: {link_res}"

        bill = _get_bill(session, bid)
        assert bill["status"] == "paid"

        r = session.delete(f"{API}/companies/{CID}/bills/{bid}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("payments_deleted") == 1, body
        assert body.get("transactions_cleared") == 1, body

        assert _payments_for_doc(session, "linked_bill_id", bid) == []
        txn = _get_txn(session, tid)
        assert txn.get("linked_bill_id") in (None, "")
        assert txn.get("linked_payment_id") in (None, "")

        session.delete(f"{API}/companies/{CID}/transactions/{tid}")

    def test_bill_delete_no_payments_returns_zero(self, session):
        bid, _, _ = _mk_bill(session, total=50.0)
        r = session.delete(f"{API}/companies/{CID}/bills/{bid}")
        assert r.status_code == 200
        body = r.json()
        assert body.get("payments_deleted") == 0
        assert body.get("transactions_cleared") == 0

    def test_bill_delete_reflected_in_purchases_by_category(self, session):
        bid, _, cat_name = _mk_bill(session, total=444.44)
        # Confirm the bill's category appears in report
        r = session.get(f"{API}/companies/{CID}/reports/purchases-by-category",
                        params={"start": "2026-01-01", "end": "2026-01-31"})
        assert r.status_code == 200
        rows_before = r.json()["rows"]
        assert any(row["category"] == cat_name and abs(row["amount"] - 444.44) < 0.01
                   for row in rows_before), "category not in report before delete"

        # Delete bill
        r = session.delete(f"{API}/companies/{CID}/bills/{bid}")
        assert r.status_code == 200

        # Category should no longer show up
        r = session.get(f"{API}/companies/{CID}/reports/purchases-by-category",
                        params={"start": "2026-01-01", "end": "2026-01-31"})
        rows_after = r.json()["rows"]
        assert not any(row["category"] == cat_name for row in rows_after), \
            "deleted bill's category still in purchases-by-category"


class TestTransactionDeleteCascade:
    def test_txn_delete_reverses_invoice_payment(self, session):
        iid, cust_name = _mk_invoice(session, total=300.0)
        tid = _mk_txn(session, 300.0, "TEST txn del inv rev")
        link_res = _link_txn(session, tid, invoice_id=iid)
        assert link_res.get("linked_payment_id")

        inv = _get_invoice(session, iid)
        assert inv["status"] == "paid"
        assert abs(float(inv["balance_due"])) < 0.01

        # Delete txn
        r = session.delete(f"{API}/companies/{CID}/transactions/{tid}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("payments_deleted") == 1, body

        # Invoice reverted
        inv2 = _get_invoice(session, iid)
        assert abs(float(inv2["balance_due"]) - 300.0) < 0.01, inv2
        assert inv2["status"] in ("sent", "open", "partial"), inv2["status"]

        # Payment removed
        assert _payments_for_doc(session, "linked_invoice_id", iid) == []

        # revenue-by-customer: outstanding back to 300
        r = session.get(f"{API}/companies/{CID}/reports/revenue-by-customer",
                        params={"start": "2026-01-01", "end": "2026-01-31"})
        assert r.status_code == 200
        rows = r.json()["rows"]
        match = [row for row in rows if row["customer_name"] == cust_name]
        assert match, f"customer {cust_name} missing in report"
        assert abs(match[0]["outstanding"] - 300.0) < 0.01, match[0]

        session.delete(f"{API}/companies/{CID}/invoices/{iid}")

    def test_txn_delete_reverses_bill_payment(self, session):
        bid, _, _ = _mk_bill(session, total=150.0)
        tid = _mk_txn(session, 150.0, "TEST txn del bill rev")
        _link_txn(session, tid, bill_id=bid)

        bill = _get_bill(session, bid)
        assert bill["status"] == "paid"

        r = session.delete(f"{API}/companies/{CID}/transactions/{tid}")
        assert r.status_code == 200, r.text
        assert r.json().get("payments_deleted") == 1

        bill2 = _get_bill(session, bid)
        assert abs(float(bill2["balance_due"]) - 150.0) < 0.01
        assert bill2["status"] in ("open", "partial")

        session.delete(f"{API}/companies/{CID}/bills/{bid}")

    def test_txn_delete_no_payment_returns_zero(self, session):
        tid = _mk_txn(session, 12.34, "TEST no-link txn")
        r = session.delete(f"{API}/companies/{CID}/transactions/{tid}")
        assert r.status_code == 200
        assert r.json().get("payments_deleted") == 0
