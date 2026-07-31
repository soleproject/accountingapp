"""Iter 61 — Vendor Spend Report + Txn Link inline (Edit Modal).

Backend tests:
  - GET /reports/spend-by-vendor
      * aggregates bills by contact (uses bill.total, paid = total - balance_due)
      * excludes draft/void
      * filters by start/end date
      * missing contact -> 'Uncategorized vendor'
  - POST /transactions/{tid}/link
      * setting bill_id / invoice_id persists
      * empty string clears
"""
import os, uuid, requests, pytest

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"   # TEST_dup (per review request)
EMAIL = "client@axiom.ai"
PASSWORD = "client123"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, r.text
    return tok


@pytest.fixture(scope="module")
def H(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ---------------- spend-by-vendor ----------------

def test_spend_by_vendor_basic(H):
    r = requests.get(f"{BASE}/api/companies/{CID}/reports/spend-by-vendor",
                     params={"start": "2000-01-01", "end": "2100-01-01"},
                     headers=H, timeout=30)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert "rows" in body and "total" in body
    rows = body["rows"]
    # Fields present
    for row in rows:
        for k in ("vendor_name", "amount", "paid_amount", "outstanding", "bill_count"):
            assert k in row, f"Missing {k} in {row}"
    # Sorted desc by amount
    amts = [r["amount"] for r in rows]
    assert amts == sorted(amts, reverse=True)
    # total matches sum
    assert abs(sum(r["amount"] for r in rows) - body["total"]) < 0.02


def test_spend_by_vendor_math_and_exclusions(H):
    """Create 3 bills for a fresh vendor: paid+partial+draft; verify math and exclusions."""
    vname = f"TEST_Vendor_{uuid.uuid4().hex[:6]}"
    # Create contact (vendor)
    r = requests.post(f"{BASE}/api/companies/{CID}/contacts",
                      json={"name": vname, "type": "vendor"}, headers=H, timeout=20)
    assert r.status_code in (200, 201), r.text[:300]
    contact = r.json().get("contact") or r.json()
    contact_id = contact.get("id")
    assert contact_id

    def _mk_bill(total, balance_due, status, issue_date="2025-06-15"):
        payload = {
            "contact_id": contact_id,
            "contact_name": vname,
            "issue_date": issue_date,
            "due_date": issue_date,
            "line_items": [{"description": "svc", "quantity": 1,
                            "unit_price": total, "amount": total}],
            "subtotal": total,
            "total": total,
            "balance_due": balance_due,
            "status": status,
        }
        rr = requests.post(f"{BASE}/api/companies/{CID}/bills",
                           json=payload, headers=H, timeout=20)
        assert rr.status_code in (200, 201), rr.text[:400]
        bid = (rr.json().get("bill") or rr.json()).get("id")
        # Force balance_due + status on the persisted doc — creation endpoint
        # may re-derive balance_due from total ignoring the request value.
        requests.patch(
            f"{BASE}/api/companies/{CID}/bills/{bid}",
            json={"balance_due": balance_due, "status": status},
            headers=H, timeout=20,
        )
        return bid

    b1 = _mk_bill(500.0, 0.0, "paid")           # fully paid
    b2 = _mk_bill(300.0, 300.0, "open")         # unpaid
    b3 = _mk_bill(999.0, 999.0, "draft")        # excluded
    b4 = _mk_bill(100.0, 0.0, "paid", "2019-01-01")  # out of range

    r = requests.get(f"{BASE}/api/companies/{CID}/reports/spend-by-vendor",
                     params={"start": "2025-01-01", "end": "2025-12-31"},
                     headers=H, timeout=30)
    assert r.status_code == 200
    rows = r.json()["rows"]
    ours = [x for x in rows if x["vendor_name"] == vname]
    assert len(ours) == 1, f"Expected 1 row for {vname}, got {len(ours)}: {ours}"
    row = ours[0]
    assert row["bill_count"] == 2, row
    assert abs(row["amount"] - 800.0) < 0.01, row
    assert abs(row["paid_amount"] - 500.0) < 0.01, row
    assert abs(row["outstanding"] - 300.0) < 0.01, row

    # Cleanup
    for bid in (b1, b2, b3, b4):
        requests.delete(f"{BASE}/api/companies/{CID}/bills/{bid}", headers=H, timeout=15)
    requests.delete(f"{BASE}/api/companies/{CID}/contacts/{contact_id}", headers=H, timeout=15)


def test_spend_by_vendor_uncategorized_bucket(H):
    """Bill with no contact_id/contact_name -> Uncategorized vendor."""
    payload = {
        "issue_date": "2025-07-01",
        "due_date": "2025-07-01",
        "line_items": [{"description": "orphan", "quantity": 1,
                        "unit_price": 77.0, "amount": 77.0}],
        "subtotal": 77.0, "total": 77.0, "balance_due": 77.0,
        "status": "open",
    }
    r = requests.post(f"{BASE}/api/companies/{CID}/bills",
                      json=payload, headers=H, timeout=20)
    if r.status_code not in (200, 201):
        pytest.skip(f"Backend rejected orphan bill: {r.status_code} {r.text[:200]}")
    bid = (r.json().get("bill") or r.json()).get("id")

    r = requests.get(f"{BASE}/api/companies/{CID}/reports/spend-by-vendor",
                     params={"start": "2025-07-01", "end": "2025-07-31"},
                     headers=H, timeout=30)
    assert r.status_code == 200
    names = [row["vendor_name"] for row in r.json()["rows"]]
    assert "Uncategorized vendor" in names, names

    requests.delete(f"{BASE}/api/companies/{CID}/bills/{bid}", headers=H, timeout=15)


# ---------------- link endpoint ----------------

def test_link_transaction_set_and_clear(H):
    # Grab one txn
    r = requests.get(f"{BASE}/api/companies/{CID}/transactions",
                     params={"limit": 1}, headers=H, timeout=20)
    assert r.status_code == 200
    txns = r.json().get("transactions") or []
    if not txns:
        pytest.skip("No transactions in test company")
    tid = txns[0]["id"]

    # Get a bill id
    r = requests.get(f"{BASE}/api/companies/{CID}/bills", headers=H, timeout=20)
    bills = r.json().get("bills") or []
    if not bills:
        pytest.skip("No bills in test company")
    bill_id = bills[0]["id"]

    # Set link
    r = requests.post(
        f"{BASE}/api/companies/{CID}/transactions/{tid}/link",
        params={"bill_id": bill_id}, headers=H, timeout=20,
    )
    assert r.status_code == 200, r.text[:300]

    # Verify persisted
    r = requests.get(f"{BASE}/api/companies/{CID}/transactions",
                     params={"limit": 500}, headers=H, timeout=20)
    row = next((t for t in r.json()["transactions"] if t["id"] == tid), None)
    assert row and row.get("linked_bill_id") == bill_id

    # Clear via empty string
    r = requests.post(
        f"{BASE}/api/companies/{CID}/transactions/{tid}/link",
        params={"bill_id": ""}, headers=H, timeout=20,
    )
    assert r.status_code == 200

    r = requests.get(f"{BASE}/api/companies/{CID}/transactions",
                     params={"limit": 500}, headers=H, timeout=20)
    row = next((t for t in r.json()["transactions"] if t["id"] == tid), None)
    assert row and (row.get("linked_bill_id") in (None, "")), row
