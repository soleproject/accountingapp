"""Iter84 regression: Sales tax full end-to-end via HTTP.

Covers:
  * Bug1 - invoice pencil-edit-and-resave does not double per-line tax
  * Bug2 - tax-liability endpoint reflects collected tax
  * Feature - taxes PATCH accepts payable_account_id
  * Feature - Record Sales Tax Payment endpoint drains liability
  * Regression - plain no-tax invoice still balances
"""
import os
import requests
import pytest

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")

CLIENT_EMAIL = "client@axiom.ai"
CLIENT_PASS = "client123"
CID = "9dd28a14-a9de-4743-92ba-227f6e88d255"


@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": CLIENT_EMAIL, "password": CLIENT_PASS}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    token = r.json().get("token") or r.json().get("access_token")
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module")
def tax_id(sess):
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/taxes", timeout=30)
    assert r.status_code == 200, r.text
    taxes = r.json().get("taxes", [])
    for t in taxes:
        if float(t.get("rate", 0)) == 10.0:
            return t["id"]
    r = sess.post(f"{BASE_URL}/api/companies/{CID}/taxes",
                  json={"name": "Regression Line Tax 10%", "rate": 10}, timeout=30)
    assert r.status_code in (200, 201), r.text
    j = r.json()
    return (j.get("tax") or j).get("id")


@pytest.fixture(scope="module")
def contact_id(sess):
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/contacts", timeout=30)
    assert r.status_code == 200
    lst = r.json().get("contacts", [])
    for c in lst:
        if c.get("type") in ("customer", None):
            return c["id"]
    return lst[0]["id"] if lst else None


def _accounts(sess):
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/accounts", timeout=30)
    assert r.status_code == 200
    return r.json().get("accounts", [])


def _find(accounts, atype, name_hint=None):
    for a in accounts:
        if a.get("type", "").lower() != atype:
            continue
        if name_hint and name_hint.lower() not in (a.get("name") or "").lower():
            continue
        return a
    return None


# ------------- BUG 1 -------------
def test_bug1_edit_resave_does_not_double(sess, tax_id, contact_id):
    payload = {
        "contact_id": contact_id, "issue_date": "2026-01-10", "due_date": "2026-02-10",
        "line_items": [{
            "description": "Widget",
            "quantity": 1,
            "rate": 100,
            "amount": 100,
            "tax_id": tax_id,
            "tax_rate": 10,
            "tax_amount": 10,
        }],
    }
    r = sess.post(f"{BASE_URL}/api/companies/{CID}/invoices", json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    inv = r.json().get("invoice") or r.json()
    inv_id = inv["id"]
    assert abs(float(inv["total"]) - 110) < 0.01, f"expected 110, got {inv['total']}"

    # GET must preserve line tax fields
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)
    got = r.json().get("invoice") or r.json()
    line = got["line_items"][0]
    assert line.get("tax_id") == tax_id, f"tax_id lost: {line}"
    assert abs(float(line.get("tax_amount") or 0) - 10) < 0.01
    assert abs(float(got["total"]) - 110) < 0.01

    # Simulate the FIXED frontend cycle: peel rolled-up line-tax off inv.tax
    # before submitting (InvoiceEditor.jsx does: setTax(inv.tax - Σ line.tax_amount)).
    def _peel(payload):
        p = dict(payload)
        line_tax_sum = sum(float(l.get("tax_amount") or 0) for l in p.get("line_items", []))
        p["tax"] = round(float(p.get("tax") or 0) - line_tax_sum, 2)
        return p

    resave1 = _peel(got)
    r = sess.patch(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", json=resave1, timeout=30)
    assert r.status_code == 200, r.text
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)
    got2 = r.json().get("invoice") or r.json()
    assert abs(float(got2["total"]) - 110) < 0.01, f"DOUBLING BUG: total={got2['total']}"
    assert abs(float(got2["tax"]) - 10) < 0.01, f"tax drift after resave: {got2['tax']}"

    # A second resave (also peeled)
    resave2 = _peel(got2)
    r = sess.patch(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", json=resave2, timeout=30)
    assert r.status_code == 200
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)
    got3 = r.json().get("invoice") or r.json()
    assert abs(float(got3["total"]) - 110) < 0.01, f"DOUBLING after 2nd resave: {got3['total']}"

    # cleanup
    sess.delete(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)


# ------------- BUG 2: liability endpoint -------------
def test_bug2_tax_liability_endpoint_returns_shape(sess):
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-liability", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "total" in data or "accounts" in data or "payables" in data


def test_bug2_creating_invoice_increments_tax_liability(sess, tax_id, contact_id):
    before = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-liability", timeout=30).json()
    before_total = float(before.get("total") or 0)

    payload = {
        "contact_id": contact_id, "issue_date": "2026-01-10", "due_date": "2026-02-10",
        "line_items": [{
            "description": "T", "quantity": 1, "rate": 250, "amount": 250,
            "tax_id": tax_id, "tax_rate": 10, "tax_amount": 25,
        }],
    }
    r = sess.post(f"{BASE_URL}/api/companies/{CID}/invoices", json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    inv = r.json().get("invoice") or r.json()
    inv_id = inv["id"]

    after = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-liability", timeout=30).json()
    after_total = float(after.get("total") or 0)
    delta = after_total - before_total
    assert abs(delta - 25) < 0.01, f"expected +25 delta, got {delta} (before={before_total} after={after_total})"

    # ensure JE posted (verify via GET after creation)
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)
    got = r.json().get("invoice") or r.json()
    assert got.get("posted") is True, "invoice should be posted"

    sess.delete(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)


# ------------- Feature: payable_account_id linkage -------------
def test_feature_tax_patch_accepts_payable_account_id(sess, tax_id):
    accts = _accounts(sess)
    liabs = [a for a in accts if a.get("type", "").lower() == "liability"]
    assert liabs, "need a liability account"
    target = liabs[0]["id"]
    r = sess.patch(f"{BASE_URL}/api/companies/{CID}/taxes/{tax_id}",
                   json={"payable_account_id": target}, timeout=30)
    assert r.status_code == 200, r.text
    # readback
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/taxes", timeout=30)
    got = next(t for t in r.json().get("taxes", []) if t["id"] == tax_id)
    assert got.get("payable_account_id") == target, f"payable_account_id not persisted: {got}"
    # RESET to null so subsequent tests use the default Sales Tax Payable
    sess.patch(f"{BASE_URL}/api/companies/{CID}/taxes/{tax_id}",
               json={"payable_account_id": None}, timeout=30)


# ------------- Record Sales Tax Payment -------------
def test_tax_payments_endpoint_lists(sess):
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-payments", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "payments" in body or isinstance(body, list)


def test_record_tax_payment_drains_liability(sess, tax_id, contact_id):
    # First measure baseline liability (may be negative due to accumulated
    # test-run drainage). Then create a $1000 line × 10% tax = $100 CR so
    # the new balance is guaranteed strictly-positive above baseline.
    baseline = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-liability", timeout=30).json()
    base_total = float(baseline.get("total") or 0)

    payload = {
        "contact_id": contact_id, "issue_date": "2026-01-10", "due_date": "2026-02-10",
        "line_items": [{
            "description": "for-payment", "quantity": 1, "rate": 1000, "amount": 1000,
            "tax_id": tax_id, "tax_rate": 10, "tax_amount": 100,
        }],
    }
    r = sess.post(f"{BASE_URL}/api/companies/{CID}/invoices", json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    inv_id = (r.json().get("invoice") or r.json())["id"]

    liab = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-liability", timeout=30).json()
    accts = liab.get("accounts") or []
    assert accts, f"no STP accounts: {liab}"
    top = accts[0]
    total_after = float(liab.get("total") or 0)
    delta = total_after - base_total
    assert abs(delta - 100) < 0.01, f"expected +100 delta on STP, got {delta}"

    pay_acct_id = top["id"]
    bank = next((a for a in _accounts(sess)
                 if a.get("type", "").lower() == "asset"
                 and (a.get("subtype") == "cash_and_bank" or "bank" in (a.get("name") or "").lower()
                      or "cash" in (a.get("name") or "").lower())), None)
    assert bank, "need a bank/cash account"

    # Pay $100 (the delta we just created)
    pay_payload = {
        "payable_account_id": pay_acct_id,
        "bank_account_id": bank["id"],
        "amount": 100.0,
        "date": "2026-01-15",
        "memo": "TEST_iter84 payment",
    }
    r = sess.post(f"{BASE_URL}/api/companies/{CID}/tax-payments", json=pay_payload, timeout=30)
    assert r.status_code in (200, 201), f"tax-payments POST failed: {r.status_code} {r.text}"

    liab2 = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-liability", timeout=30).json()
    total_after_pay = float(liab2.get("total") or 0)
    # Balance should drop by exactly $100 (back to baseline)
    assert abs(total_after_pay - base_total) < 0.01, (
        f"expected STP to drop back to baseline {base_total}, got {total_after_pay}"
    )

    # verify payment appears in list
    lst = sess.get(f"{BASE_URL}/api/companies/{CID}/tax-payments", timeout=30).json()
    payments = lst.get("payments") or (lst if isinstance(lst, list) else [])
    assert any(abs(float(p.get("amount", 0)) - 100.0) < 0.01
               and "TEST_iter84" in (p.get("memo") or "")
               for p in payments), f"new payment not in list: {payments[:3]}"

    sess.delete(f"{BASE_URL}/api/companies/{CID}/invoices/{inv_id}", timeout=30)


# ------------- Regression: plain no-tax invoice -------------
def test_regression_plain_no_tax_invoice(sess, contact_id):
    payload = {
        "contact_id": contact_id, "issue_date": "2026-01-10", "due_date": "2026-02-10",
        "line_items": [{"description": "Plain", "quantity": 1, "rate": 50, "amount": 50}],
    }
    r = sess.post(f"{BASE_URL}/api/companies/{CID}/invoices", json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    inv = r.json().get("invoice") or r.json()
    assert abs(float(inv["total"]) - 50) < 0.01
    assert float(inv.get("tax") or 0) == 0
    # verify JE actually posted for the plain invoice (via GET on the doc)
    r = sess.get(f"{BASE_URL}/api/companies/{CID}/invoices/{inv['id']}", timeout=30)
    got = r.json().get("invoice") or r.json()
    assert got.get("posted") is True, f"plain invoice not posted: {got}"
    sess.delete(f"{BASE_URL}/api/companies/{CID}/invoices/{inv['id']}", timeout=30)
