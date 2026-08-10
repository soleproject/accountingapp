"""Live HTTP integration test for the new full-page editor flow.

Covers:
  - GET /api/companies/{cid}/transactions/{tid} (new endpoint)
  - POST create_transaction editor branch for all 5 txn_types
  - Sign-flip logic (Purchase/RefundReceipt → negative)
  - CreditMemo clearing bank_account_id
  - Unknown txn_type is ignored
  - Cross-company isolation (403/404)
  - Quick-modal path (no txn_type) still accepted

Uses pro@axiom.ai / pro123 who has access to client companies.
"""
from __future__ import annotations
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def pro_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                       json={"email": "pro@axiom.ai", "password": "pro123"},
                       timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def client_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                       json={"email": "client2@axiom.ai", "password": "client123"},
                       timeout=15)
    if r.status_code != 200:
        pytest.skip(f"client2 login failed: {r.status_code}")
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_headers(pro_token):
    return {"Authorization": f"Bearer {pro_token}"}


@pytest.fixture(scope="module")
def client_headers(client_token):
    return {"Authorization": f"Bearer {client_token}"}


@pytest.fixture(scope="module")
def pro_company(pro_headers):
    """First client company visible to Priya (Skyward Sparks or Bright Beans)."""
    r = requests.get(f"{BASE_URL}/api/companies", headers=pro_headers, timeout=15)
    assert r.status_code == 200, r.text
    companies = r.json() if isinstance(r.json(), list) else r.json().get("companies", [])
    assert companies, "no companies for pro user"
    # Prefer Skyward Sparks (fully onboarded, has accounts)
    sky = next((c for c in companies if "Skyward" in (c.get("name") or "")), None)
    return sky or companies[0]


@pytest.fixture(scope="module")
def accounts(pro_headers, pro_company):
    cid = pro_company["id"]
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/accounts",
                      headers=pro_headers, timeout=15)
    assert r.status_code == 200, r.text
    js = r.json()
    rows = js if isinstance(js, list) else js.get("accounts", [])
    bank = next((a for a in rows if (a.get("type") or "").lower() == "asset"
                  and "bank" in ((a.get("name") or "") + (a.get("subtype") or "")).lower()), None)
    if not bank:
        bank = next((a for a in rows if (a.get("type") or "").lower() == "asset"), None)
    expense = next((a for a in rows if (a.get("type") or "").lower() == "expense"), None)
    revenue = next((a for a in rows if (a.get("type") or "").lower() in ("revenue", "income")), None)
    assert bank and expense and revenue, "need bank/expense/revenue accounts"
    return {"bank": bank["id"], "expense": expense["id"], "revenue": revenue["id"]}


@pytest.fixture(scope="module")
def contact_id(pro_headers, pro_company):
    cid = pro_company["id"]
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/contacts",
                      headers=pro_headers, timeout=15)
    if r.status_code != 200:
        return None
    js = r.json()
    rows = js if isinstance(js, list) else js.get("contacts", [])
    if rows:
        return rows[0]["id"]
    # Create one so downstream tests aren't skipped
    c = requests.post(f"{BASE_URL}/api/companies/{cid}/contacts",
                       headers=pro_headers,
                       json={"name": f"TEST_Contact_{uuid.uuid4().hex[:6]}",
                              "kind": "customer"},
                       timeout=15)
    if c.status_code in (200, 201):
        body = c.json()
        return body.get("id") or body.get("contact", {}).get("id")
    return None


def _post_txn(cid, headers, payload):
    return requests.post(f"{BASE_URL}/api/companies/{cid}/transactions",
                          headers=headers, json=payload, timeout=15)


def _get_txn(cid, tid, headers):
    return requests.get(f"{BASE_URL}/api/companies/{cid}/transactions/{tid}",
                         headers=headers, timeout=15)


# ─── GET single transaction ─────────────────────────────────────

def test_get_transaction_404_for_unknown(pro_headers, pro_company):
    r = _get_txn(pro_company["id"], "nonexistent-" + uuid.uuid4().hex, pro_headers)
    assert r.status_code == 404


def test_get_transaction_success_shape(pro_headers, pro_company, accounts):
    # Create a Purchase first
    payload = {
        "date": "2026-02-20",
        "description": f"TEST_GET {uuid.uuid4().hex[:6]}",
        "amount": 42.00,
        "txn_type": "Purchase",
        "bank_account_id": accounts["bank"],
        "line_items": [{"expense_account_id": accounts["expense"],
                          "description": "test", "amount": 42.00}],
        "auto_categorize": False,
    }
    r = _post_txn(pro_company["id"], pro_headers, payload)
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    assert tid

    g = _get_txn(pro_company["id"], tid, pro_headers)
    assert g.status_code == 200, g.text
    body = g.json()
    assert "transaction" in body
    txn = body["transaction"]
    assert txn["id"] == tid
    assert txn["txn_type"] == "Purchase"
    assert txn["amount"] == -42.00  # sign-flipped
    assert txn.get("posted") is True
    assert txn.get("human_reviewed") is True
    assert txn.get("line_items") and len(txn["line_items"]) == 1


# ─── Sign-flip / entity-specific behavior ───────────────────────

def test_purchase_flips_sign(pro_headers, pro_company, accounts):
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_PUR {uuid.uuid4().hex[:6]}",
        "amount": 100.00,
        "txn_type": "Purchase",
        "bank_account_id": accounts["bank"],
        "line_items": [{"expense_account_id": accounts["expense"], "amount": 100.00}],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    g = _get_txn(pro_company["id"], tid, pro_headers).json()["transaction"]
    assert g["txn_type"] == "Purchase"
    assert g["amount"] == -100.00
    assert g["posted"] is True


def test_sales_receipt_stays_positive(pro_headers, pro_company, accounts, contact_id):
    if not contact_id:
        pytest.skip("no contact")
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_SR {uuid.uuid4().hex[:6]}",
        "amount": 250.00,
        "txn_type": "SalesReceipt",
        "bank_account_id": accounts["bank"],
        "contact_id": contact_id,
        "line_items": [{"category_account_id": accounts["revenue"], "amount": 250.00}],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    g = _get_txn(pro_company["id"], tid, pro_headers).json()["transaction"]
    assert g["txn_type"] == "SalesReceipt"
    assert g["amount"] == 250.00
    assert g["posted"] is True


def test_deposit_positive_no_contact(pro_headers, pro_company, accounts):
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_DEP {uuid.uuid4().hex[:6]}",
        "amount": 60.00,
        "txn_type": "Deposit",
        "bank_account_id": accounts["bank"],
        "line_items": [{"category_account_id": accounts["revenue"], "amount": 60.00}],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    g = _get_txn(pro_company["id"], tid, pro_headers).json()["transaction"]
    assert g["txn_type"] == "Deposit"
    assert g["amount"] == 60.00
    assert g["posted"] is True


def test_credit_memo_clears_bank(pro_headers, pro_company, accounts, contact_id):
    if not contact_id:
        pytest.skip("no contact")
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_CM {uuid.uuid4().hex[:6]}",
        "amount": 80.00,
        "txn_type": "CreditMemo",
        "bank_account_id": accounts["bank"],  # backend must clear
        "contact_id": contact_id,
        "linked_invoice_id": "inv-fake-99",
        "line_items": [{"category_account_id": accounts["revenue"], "amount": 80.00}],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    g = _get_txn(pro_company["id"], tid, pro_headers).json()["transaction"]
    assert g["txn_type"] == "CreditMemo"
    assert g["amount"] == 80.00
    assert g.get("bank_account_id") in (None, "")
    assert g.get("linked_invoice_id") == "inv-fake-99"
    assert g["posted"] is True


def test_refund_receipt_flips_sign(pro_headers, pro_company, accounts, contact_id):
    if not contact_id:
        pytest.skip("no contact")
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_RR {uuid.uuid4().hex[:6]}",
        "amount": 30.00,
        "txn_type": "RefundReceipt",
        "bank_account_id": accounts["bank"],
        "contact_id": contact_id,
        "line_items": [{"category_account_id": accounts["revenue"], "amount": 30.00}],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    g = _get_txn(pro_company["id"], tid, pro_headers).json()["transaction"]
    assert g["txn_type"] == "RefundReceipt"
    assert g["amount"] == -30.00
    assert g["posted"] is True


# ─── Guard cases ─────────────────────────────────────────────────

def test_unknown_txn_type_ignored(pro_headers, pro_company, accounts):
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_UNK {uuid.uuid4().hex[:6]}",
        "amount": 15.00,
        "txn_type": "NotARealType",
        "bank_account_id": accounts["bank"],
        "category_account_id": accounts["expense"],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")
    g = _get_txn(pro_company["id"], tid, pro_headers).json()["transaction"]
    assert g.get("txn_type") != "NotARealType"


def test_quick_modal_path_still_works(pro_headers, pro_company, accounts):
    """POST without txn_type — negative amt + bank + category. Row must be
    created; qualifier will stamp txn_type in the background (not asserted here)."""
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_QUICK {uuid.uuid4().hex[:6]}",
        "amount": -22.50,
        "bank_account_id": accounts["bank"],
        "category_account_id": accounts["expense"],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    body = r.json()
    tid = body.get("id") or body.get("transaction", {}).get("id")
    assert tid
    g = _get_txn(pro_company["id"], tid, pro_headers)
    assert g.status_code == 200


# ─── Cross-company isolation ─────────────────────────────────────

def test_cross_company_get_denied(pro_headers, client_headers, pro_company, accounts):
    # Create as pro under pro_company
    r = _post_txn(pro_company["id"], pro_headers, {
        "date": "2026-02-20",
        "description": f"TEST_ISO {uuid.uuid4().hex[:6]}",
        "amount": 10.00,
        "txn_type": "Purchase",
        "bank_account_id": accounts["bank"],
        "line_items": [{"expense_account_id": accounts["expense"], "amount": 10.00}],
        "auto_categorize": False,
    })
    assert r.status_code in (200, 201), r.text
    tid = r.json().get("id") or r.json().get("transaction", {}).get("id")

    # client2 (owns Bright Beans, not Skyward) tries to GET Skyward txn.
    # Expect 403 (require_company denies) or 404 (not visible in that cid path).
    g = requests.get(f"{BASE_URL}/api/companies/{pro_company['id']}/transactions/{tid}",
                      headers=client_headers, timeout=15)
    assert g.status_code in (403, 404), g.status_code
