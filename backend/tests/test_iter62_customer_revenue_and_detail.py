"""Iter 62 — Customer Revenue Report + Vendor/Customer Detail Drill-Down.

Backend tests:
  - GET /reports/revenue-by-customer  (mirror of spend-by-vendor for sales)
  - GET /reports/customer-detail?customer_id=X
  - GET /reports/vendor-detail?vendor_id=X
  - Both detail endpoints return 400 if neither id nor name supplied.
"""
import os, uuid, requests, pytest

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"
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


# ---------------- revenue-by-customer ----------------

def test_revenue_by_customer_basic_shape(H):
    r = requests.get(f"{BASE}/api/companies/{CID}/reports/revenue-by-customer",
                     params={"start": "2000-01-01", "end": "2100-01-01"},
                     headers=H, timeout=30)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert "rows" in body and "total" in body
    rows = body["rows"]
    for row in rows:
        for k in ("customer_name", "amount", "paid_amount", "outstanding", "invoice_count"):
            assert k in row, f"Missing {k} in {row}"
    # sorted desc
    amts = [row["amount"] for row in rows]
    assert amts == sorted(amts, reverse=True)
    # total = sum
    assert abs(sum(row["amount"] for row in rows) - body["total"]) < 0.02


def test_revenue_by_customer_math_and_exclusions(H):
    """3 invoices for a fresh customer: paid + partial + draft + out-of-range."""
    cname = f"TEST_Cust_{uuid.uuid4().hex[:6]}"
    r = requests.post(f"{BASE}/api/companies/{CID}/contacts",
                      json={"name": cname, "type": "customer"}, headers=H, timeout=20)
    assert r.status_code in (200, 201), r.text[:300]
    contact = r.json().get("contact") or r.json()
    contact_id = contact.get("id")
    assert contact_id

    def _mk_inv(total, balance_due, status, issue_date="2025-06-15"):
        payload = {
            "contact_id": contact_id,
            "contact_name": cname,
            "issue_date": issue_date,
            "due_date": issue_date,
            "line_items": [{"description": "svc", "quantity": 1,
                            "unit_price": total, "amount": total}],
            "subtotal": total,
            "total": total,
            "balance_due": balance_due,
            "status": status,
        }
        rr = requests.post(f"{BASE}/api/companies/{CID}/invoices",
                           json=payload, headers=H, timeout=20)
        assert rr.status_code in (200, 201), rr.text[:400]
        iid = (rr.json().get("invoice") or rr.json()).get("id")
        requests.patch(
            f"{BASE}/api/companies/{CID}/invoices/{iid}",
            json={"balance_due": balance_due, "status": status},
            headers=H, timeout=20,
        )
        return iid

    i1 = _mk_inv(1000.0, 0.0, "paid")           # fully paid
    i2 = _mk_inv(500.0, 500.0, "open")          # unpaid
    i3 = _mk_inv(777.0, 777.0, "draft")         # excluded
    i4 = _mk_inv(200.0, 0.0, "paid", "2019-01-01")  # out of range

    r = requests.get(f"{BASE}/api/companies/{CID}/reports/revenue-by-customer",
                     params={"start": "2025-01-01", "end": "2025-12-31"},
                     headers=H, timeout=30)
    assert r.status_code == 200
    rows = r.json()["rows"]
    ours = [x for x in rows if x["customer_name"] == cname]
    assert len(ours) == 1, f"Expected 1 row for {cname}, got {len(ours)}"
    row = ours[0]
    assert row["invoice_count"] == 2, row
    assert abs(row["amount"] - 1500.0) < 0.01, row
    assert abs(row["paid_amount"] - 1000.0) < 0.01, row
    assert abs(row["outstanding"] - 500.0) < 0.01, row

    # ---------- customer-detail ----------
    r = requests.get(f"{BASE}/api/companies/{CID}/reports/customer-detail",
                     params={"customer_id": contact_id,
                             "start": "2025-01-01", "end": "2025-12-31"},
                     headers=H, timeout=30)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    assert d["customer_name"] == cname
    assert "invoices" in d and "linked_transactions" in d and "totals" in d
    # Only 2 invoices in range (paid + open); draft excluded, out-of-range excluded
    inv_ids = {i["id"] for i in d["invoices"]}
    assert i1 in inv_ids and i2 in inv_ids
    assert i3 not in inv_ids
    assert i4 not in inv_ids
    t = d["totals"]
    assert abs(t["amount"] - 1500.0) < 0.01
    assert abs(t["paid"] - 1000.0) < 0.01
    assert abs(t["outstanding"] - 500.0) < 0.01
    assert t["invoice_count"] == 2
    # No transactions linked to these invoices
    assert isinstance(d["linked_transactions"], list)

    # Cleanup
    for iid in (i1, i2, i3, i4):
        requests.delete(f"{BASE}/api/companies/{CID}/invoices/{iid}", headers=H, timeout=15)
    requests.delete(f"{BASE}/api/companies/{CID}/contacts/{contact_id}", headers=H, timeout=15)


def test_customer_detail_missing_params_400(H):
    r = requests.get(f"{BASE}/api/companies/{CID}/reports/customer-detail",
                     headers=H, timeout=20)
    assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text[:200]}"


def test_vendor_detail_missing_params_400(H):
    r = requests.get(f"{BASE}/api/companies/{CID}/reports/vendor-detail",
                     headers=H, timeout=20)
    assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text[:200]}"


def test_vendor_detail_by_id(H):
    """Sanity: create a vendor + bill, drill down works."""
    vname = f"TEST_Vend_{uuid.uuid4().hex[:6]}"
    r = requests.post(f"{BASE}/api/companies/{CID}/contacts",
                      json={"name": vname, "type": "vendor"}, headers=H, timeout=20)
    assert r.status_code in (200, 201)
    contact_id = (r.json().get("contact") or r.json()).get("id")

    payload = {
        "contact_id": contact_id,
        "contact_name": vname,
        "issue_date": "2025-05-10",
        "due_date": "2025-05-10",
        "line_items": [{"description": "svc", "quantity": 1, "unit_price": 250.0, "amount": 250.0}],
        "subtotal": 250.0, "total": 250.0, "balance_due": 250.0, "status": "open",
    }
    rr = requests.post(f"{BASE}/api/companies/{CID}/bills", json=payload, headers=H, timeout=20)
    assert rr.status_code in (200, 201)
    bid = (rr.json().get("bill") or rr.json()).get("id")

    r = requests.get(f"{BASE}/api/companies/{CID}/reports/vendor-detail",
                     params={"vendor_id": contact_id,
                             "start": "2025-01-01", "end": "2025-12-31"},
                     headers=H, timeout=30)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    assert d["vendor_name"] == vname
    assert any(b["id"] == bid for b in d["bills"])
    assert d["totals"]["bill_count"] >= 1
    assert d["totals"]["amount"] >= 250.0
    assert d["totals"]["outstanding"] >= 250.0

    requests.delete(f"{BASE}/api/companies/{CID}/bills/{bid}", headers=H, timeout=15)
    requests.delete(f"{BASE}/api/companies/{CID}/contacts/{contact_id}", headers=H, timeout=15)


def test_customer_detail_by_name_uncategorized_fallback(H):
    """Fallback path: query by customer_name for 'Uncategorized customer' bucket."""
    r = requests.get(f"{BASE}/api/companies/{CID}/reports/customer-detail",
                     params={"customer_name": "Uncategorized customer",
                             "start": "2000-01-01", "end": "2100-01-01"},
                     headers=H, timeout=20)
    # Either 200 with (possibly empty) results, or 200 with no invoices — must not 400/500.
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    assert "invoices" in d and "totals" in d
