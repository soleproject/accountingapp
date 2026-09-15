"""
Regression tests for Vendor Credit ⇄ Bill and Credit Memo ⇄ Invoice
auto-apply coherence across the full lifecycle:
    create → PATCH relink → PATCH amount-change → PATCH clear → delete
    plus manual unlink endpoints and PATCH idempotency.
"""
import os
import uuid
import pytest
import requests

_raw = os.environ.get("REACT_APP_BACKEND_URL")
if not _raw:
    # Load from frontend/.env as a fallback for local pytest runs.
    _p = "/app/frontend/.env"
    if os.path.exists(_p):
        with open(_p) as _f:
            for _line in _f:
                if _line.startswith("REACT_APP_BACKEND_URL="):
                    _raw = _line.split("=", 1)[1].strip()
                    break
BASE_URL = (_raw or "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL not set"
PRO_EMAIL = "pro@axiom.ai"
PRO_PASS  = "pro123"


# ------------------------------- fixtures -------------------------------
def _login(email, pw):
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": pw}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers():
    return {"Authorization": f"Bearer {_login(PRO_EMAIL, PRO_PASS)}",
            "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def cid(headers):
    """Pick a company the Pro can access. Prefer Bright Beans, else the
    first available company from /api/companies."""
    r = requests.get(f"{BASE_URL}/api/companies", headers=headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    companies = data.get("companies") if isinstance(data, dict) else data
    assert companies, "Pro has no companies to test against"
    for c in companies:
        if "bright beans" in (c.get("name") or "").lower():
            return c["id"]
    for c in companies:
        if "skyward" in (c.get("name") or "").lower():
            return c["id"]
    return companies[0]["id"]


# ------------------------------- helpers --------------------------------
def _create_bill(headers, cid, total=1000.0, tag=""):
    payload = {
        "number": f"TEST-BILL-{tag}-{uuid.uuid4().hex[:6]}",
        "contact_name": "TEST_Vendor",
        "issue_date": "2026-01-05",
        "due_date":   "2026-02-05",
        "status": "open",
        "line_items": [{"description": "widgets", "quantity": 1,
                        "rate": total, "amount": total}],
        "tax": 0.0,
    }
    r = requests.post(f"{BASE_URL}/api/companies/{cid}/bills",
                      headers=headers, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _get_bill(headers, cid, bid):
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/bills/{bid}",
                     headers=headers, timeout=30)
    assert r.status_code == 200, r.text
    b = r.json()
    return b.get("bill") or b


def _create_invoice(headers, cid, total=1000.0, tag=""):
    payload = {
        "number": f"TEST-INV-{tag}-{uuid.uuid4().hex[:6]}",
        "contact_name": "TEST_Customer",
        "issue_date": "2026-01-05",
        "due_date":   "2026-02-05",
        "status": "sent",
        "line_items": [{"description": "consulting", "quantity": 1,
                        "rate": total, "amount": total}],
        "tax": 0.0,
    }
    r = requests.post(f"{BASE_URL}/api/companies/{cid}/invoices",
                      headers=headers, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _get_invoice(headers, cid, iid):
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}",
                     headers=headers, timeout=30)
    assert r.status_code == 200, r.text
    i = r.json()
    return i.get("invoice") or i


def _create_vendor_credit(headers, cid, amount, linked_bill_id=None):
    payload = {
        "date": "2026-01-10",
        "description": "TEST_VendorCredit",
        "amount": amount,
        "txn_type": "VendorCredit",
        "contact_name": "TEST_Vendor",
    }
    if linked_bill_id:
        payload["linked_bill_id"] = linked_bill_id
    r = requests.post(f"{BASE_URL}/api/companies/{cid}/transactions",
                      headers=headers, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("id") or (j.get("transaction") or {}).get("id")


def _create_credit_memo(headers, cid, amount, linked_invoice_id=None):
    payload = {
        "date": "2026-01-10",
        "description": "TEST_CreditMemo",
        "amount": amount,
        "txn_type": "CreditMemo",
        "contact_name": "TEST_Customer",
    }
    if linked_invoice_id:
        payload["linked_invoice_id"] = linked_invoice_id
    r = requests.post(f"{BASE_URL}/api/companies/{cid}/transactions",
                      headers=headers, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("id") or (j.get("transaction") or {}).get("id")


def _patch_txn(headers, cid, tid, patch):
    r = requests.patch(f"{BASE_URL}/api/companies/{cid}/transactions/{tid}",
                       headers=headers, json=patch, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# ============================ VendorCredit ⇄ Bill ============================
class TestVendorCreditCreate:
    def test_create_with_link_decrements_bill(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-create")
        tid = _create_vendor_credit(headers, cid, 300.0, linked_bill_id=bid)
        b = _get_bill(headers, cid, bid)
        assert abs(b["balance_due"] - 700.0) < 0.01, b
        assert b["status"] == "partial"
        assert tid in (b.get("applied_vendor_credit_ids") or [])

    def test_create_full_amount_marks_paid(self, headers, cid):
        bid = _create_bill(headers, cid, total=500.0, tag="vc-paid")
        _create_vendor_credit(headers, cid, 500.0, linked_bill_id=bid)
        b = _get_bill(headers, cid, bid)
        assert b["balance_due"] < 0.01
        assert b["status"] == "paid"


class TestVendorCreditPatchRelink:
    def test_patch_relink_bill_a_to_bill_b(self, headers, cid):
        bidA = _create_bill(headers, cid, total=1000.0, tag="vc-A")
        bidB = _create_bill(headers, cid, total=1000.0, tag="vc-B")
        tid  = _create_vendor_credit(headers, cid, 300.0, linked_bill_id=bidA)

        # Sanity: A decremented.
        a0 = _get_bill(headers, cid, bidA)
        assert abs(a0["balance_due"] - 700.0) < 0.01

        # Relink A → B (same amount)
        _patch_txn(headers, cid, tid, {"linked_bill_id": bidB})

        a1 = _get_bill(headers, cid, bidA)
        b1 = _get_bill(headers, cid, bidB)
        assert abs(a1["balance_due"] - 1000.0) < 0.01, f"A not restored: {a1}"
        assert a1["status"] == "open"
        assert tid not in (a1.get("applied_vendor_credit_ids") or [])
        assert abs(b1["balance_due"] - 700.0) < 0.01, f"B not applied: {b1}"
        assert b1["status"] == "partial"
        assert tid in (b1.get("applied_vendor_credit_ids") or [])

    def test_patch_clear_link_reverses_only(self, headers, cid):
        bidA = _create_bill(headers, cid, total=1000.0, tag="vc-clear")
        tid  = _create_vendor_credit(headers, cid, 400.0, linked_bill_id=bidA)

        _patch_txn(headers, cid, tid, {"linked_bill_id": ""})

        a = _get_bill(headers, cid, bidA)
        assert abs(a["balance_due"] - 1000.0) < 0.01
        assert a["status"] == "open"
        assert tid not in (a.get("applied_vendor_credit_ids") or [])

        # Verify the txn's linked_bill_id is null now
        r = requests.get(f"{BASE_URL}/api/companies/{cid}/transactions/{tid}",
                         headers=headers, timeout=30)
        if r.status_code == 200:
            t = r.json()
            t = t.get("transaction") or t
            assert t.get("linked_bill_id") in (None, "")


class TestVendorCreditPatchAmount:
    def test_amount_increase_reduces_balance_more(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-amt-up")
        tid = _create_vendor_credit(headers, cid, 300.0, linked_bill_id=bid)
        # balance now 700
        _patch_txn(headers, cid, tid, {"amount": 500.0})
        b = _get_bill(headers, cid, bid)
        assert abs(b["balance_due"] - 500.0) < 0.01, b
        assert b["status"] == "partial"

    def test_amount_decrease_restores_balance(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-amt-dn")
        tid = _create_vendor_credit(headers, cid, 400.0, linked_bill_id=bid)
        # balance 600
        _patch_txn(headers, cid, tid, {"amount": 100.0})
        b = _get_bill(headers, cid, bid)
        assert abs(b["balance_due"] - 900.0) < 0.01, b
        assert b["status"] == "partial"

    def test_amount_to_full_marks_paid(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-amt-full")
        tid = _create_vendor_credit(headers, cid, 200.0, linked_bill_id=bid)
        _patch_txn(headers, cid, tid, {"amount": 1000.0})
        b = _get_bill(headers, cid, bid)
        assert b["balance_due"] < 0.01
        assert b["status"] == "paid"


class TestVendorCreditPatchIdempotent:
    def test_noop_patch_does_not_double_apply(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-idem")
        tid = _create_vendor_credit(headers, cid, 250.0, linked_bill_id=bid)
        b0 = _get_bill(headers, cid, bid)
        # Same amount, same link
        _patch_txn(headers, cid, tid, {"amount": 250.0,
                                       "linked_bill_id": bid})
        b1 = _get_bill(headers, cid, bid)
        assert abs(b1["balance_due"] - b0["balance_due"]) < 0.01, (b0, b1)
        # applied_vendor_credit_ids should contain the tid exactly once
        applied = b1.get("applied_vendor_credit_ids") or []
        assert applied.count(tid) == 1, applied

    def test_repeat_noop_patch_twice(self, headers, cid):
        bid = _create_bill(headers, cid, total=800.0, tag="vc-idem2")
        tid = _create_vendor_credit(headers, cid, 200.0, linked_bill_id=bid)
        for _ in range(3):
            _patch_txn(headers, cid, tid, {"description": "TEST_noop"})
        b = _get_bill(headers, cid, bid)
        assert abs(b["balance_due"] - 600.0) < 0.01, b


class TestVendorCreditDeleteAndUnlink:
    def test_delete_reverses_bill(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-del")
        tid = _create_vendor_credit(headers, cid, 400.0, linked_bill_id=bid)
        r = requests.delete(f"{BASE_URL}/api/companies/{cid}/transactions/{tid}",
                            headers=headers, timeout=30)
        assert r.status_code in (200, 204), r.text
        b = _get_bill(headers, cid, bid)
        assert abs(b["balance_due"] - 1000.0) < 0.01
        assert tid not in (b.get("applied_vendor_credit_ids") or [])

    def test_manual_unlink_endpoint(self, headers, cid):
        bid = _create_bill(headers, cid, total=1000.0, tag="vc-unlink")
        tid = _create_vendor_credit(headers, cid, 300.0, linked_bill_id=bid)
        r = requests.post(
            f"{BASE_URL}/api/companies/{cid}/bills/{bid}/unlink-credit/{tid}",
            headers=headers, timeout=30)
        assert r.status_code == 200, r.text
        b = _get_bill(headers, cid, bid)
        assert abs(b["balance_due"] - 1000.0) < 0.01
        assert tid not in (b.get("applied_vendor_credit_ids") or [])


# ============================ CreditMemo ⇄ Invoice ==========================
class TestCreditMemoCreate:
    def test_create_with_link_decrements_invoice(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-create")
        tid = _create_credit_memo(headers, cid, 300.0, linked_invoice_id=iid)
        i = _get_invoice(headers, cid, iid)
        assert abs(i["balance_due"] - 700.0) < 0.01, i
        assert i["status"] == "partial"
        assert tid in (i.get("applied_credit_memo_ids") or [])


class TestCreditMemoPatchRelink:
    def test_relink_invoice_a_to_b(self, headers, cid):
        iA = _create_invoice(headers, cid, total=1000.0, tag="cm-A")
        iB = _create_invoice(headers, cid, total=1000.0, tag="cm-B")
        tid = _create_credit_memo(headers, cid, 300.0, linked_invoice_id=iA)

        _patch_txn(headers, cid, tid, {"linked_invoice_id": iB})

        a = _get_invoice(headers, cid, iA)
        b = _get_invoice(headers, cid, iB)
        assert abs(a["balance_due"] - 1000.0) < 0.01, a
        assert a["status"] in ("open", "sent")
        assert tid not in (a.get("applied_credit_memo_ids") or [])
        assert abs(b["balance_due"] - 700.0) < 0.01, b
        assert b["status"] == "partial"
        assert tid in (b.get("applied_credit_memo_ids") or [])

    def test_clear_link_reverses_only(self, headers, cid):
        iA = _create_invoice(headers, cid, total=1000.0, tag="cm-clear")
        tid = _create_credit_memo(headers, cid, 400.0, linked_invoice_id=iA)

        _patch_txn(headers, cid, tid, {"linked_invoice_id": ""})

        a = _get_invoice(headers, cid, iA)
        assert abs(a["balance_due"] - 1000.0) < 0.01
        assert tid not in (a.get("applied_credit_memo_ids") or [])


class TestCreditMemoPatchAmount:
    def test_amount_increase(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-amt-up")
        tid = _create_credit_memo(headers, cid, 300.0, linked_invoice_id=iid)
        _patch_txn(headers, cid, tid, {"amount": 500.0})
        i = _get_invoice(headers, cid, iid)
        assert abs(i["balance_due"] - 500.0) < 0.01, i

    def test_amount_decrease(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-amt-dn")
        tid = _create_credit_memo(headers, cid, 400.0, linked_invoice_id=iid)
        _patch_txn(headers, cid, tid, {"amount": 100.0})
        i = _get_invoice(headers, cid, iid)
        assert abs(i["balance_due"] - 900.0) < 0.01, i

    def test_amount_to_full_marks_paid(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-amt-full")
        tid = _create_credit_memo(headers, cid, 200.0, linked_invoice_id=iid)
        _patch_txn(headers, cid, tid, {"amount": 1000.0})
        i = _get_invoice(headers, cid, iid)
        assert i["balance_due"] < 0.01
        assert i["status"] == "paid"


class TestCreditMemoPatchIdempotent:
    def test_noop_patch(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-idem")
        tid = _create_credit_memo(headers, cid, 250.0, linked_invoice_id=iid)
        i0 = _get_invoice(headers, cid, iid)
        _patch_txn(headers, cid, tid, {"amount": 250.0,
                                       "linked_invoice_id": iid})
        i1 = _get_invoice(headers, cid, iid)
        assert abs(i1["balance_due"] - i0["balance_due"]) < 0.01
        applied = i1.get("applied_credit_memo_ids") or []
        assert applied.count(tid) == 1, applied


class TestCreditMemoDeleteAndUnlink:
    def test_delete_reverses_invoice(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-del")
        tid = _create_credit_memo(headers, cid, 400.0, linked_invoice_id=iid)
        r = requests.delete(f"{BASE_URL}/api/companies/{cid}/transactions/{tid}",
                            headers=headers, timeout=30)
        assert r.status_code in (200, 204), r.text
        i = _get_invoice(headers, cid, iid)
        assert abs(i["balance_due"] - 1000.0) < 0.01
        assert tid not in (i.get("applied_credit_memo_ids") or [])

    def test_manual_unlink_endpoint(self, headers, cid):
        iid = _create_invoice(headers, cid, total=1000.0, tag="cm-unlink")
        tid = _create_credit_memo(headers, cid, 300.0, linked_invoice_id=iid)
        r = requests.post(
            f"{BASE_URL}/api/companies/{cid}/invoices/{iid}/unlink-credit-memo/{tid}",
            headers=headers, timeout=30)
        assert r.status_code == 200, r.text
        i = _get_invoice(headers, cid, iid)
        assert abs(i["balance_due"] - 1000.0) < 0.01
        assert tid not in (i.get("applied_credit_memo_ids") or [])
