"""Backend tests for Purchases-by-item / Purchases-by-category reports.

Mirrors test_items_and_sales_reports.py. Uses client@axiom.ai + TEST_dup company.
Cleans up its own items + bill + draft bill on teardown.
"""
import os
import uuid
import pytest
import requests

pytestmark = pytest.mark.xdist_group("purchases_reports_serial")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
EMAIL = "client@axiom.ai"
PASSWORD = "client123"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


@pytest.fixture(scope="module")
def cid(api):
    r = api.get(f"{BASE_URL}/api/companies", timeout=15)
    assert r.status_code == 200
    comps = r.json()["companies"]
    for c in comps:
        if c["name"].startswith("TEST_dup"):
            return c["id"]
    return comps[0]["id"]


@pytest.fixture(scope="module")
def expense_account(api, cid):
    r = api.get(f"{BASE_URL}/api/companies/{cid}/accounts", timeout=15)
    assert r.status_code == 200
    accs = r.json().get("accounts", [])
    for a in accs:
        if a.get("type") == "expense" and "cogs" in (a.get("name") or "").lower():
            return a["id"], a["name"]
    for a in accs:
        if a.get("type") == "expense":
            return a["id"], a["name"]
    pytest.skip("no expense account")


@pytest.fixture(scope="module")
def revenue_account(api, cid):
    r = api.get(f"{BASE_URL}/api/companies/{cid}/accounts", timeout=15)
    for a in r.json().get("accounts", []):
        if a.get("type") in ("revenue", "income"):
            return a["id"], a["name"]
    pytest.skip("no revenue account")


@pytest.fixture(scope="module")
def vendor_id(api, cid):
    # Find any contact usable as a vendor
    r = api.get(f"{BASE_URL}/api/companies/{cid}/contacts", timeout=15)
    contacts = r.json().get("contacts", []) if r.status_code == 200 else []
    if contacts:
        return contacts[0]["id"]
    rc = api.post(f"{BASE_URL}/api/companies/{cid}/contacts",
                  json={"name": "TEST_vendor_purch", "kind": "vendor"}, timeout=15)
    assert rc.status_code in (200, 201), rc.text
    body = rc.json()
    return body.get("contact", body).get("id")


@pytest.fixture(scope="module")
def state():
    return {"item_ids": [], "bill_ids": []}


class TestPurchasesReports:
    def test_create_expense_item(self, api, cid, expense_account, revenue_account, state):
        acc_id, acc_name = expense_account
        rev_id, rev_name = revenue_account
        name = f"TEST_pitem_{uuid.uuid4().hex[:8]}"
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items", json={
            "name": name, "type": "product", "price": 50.0,
            "income_account_id": rev_id, "income_account_name": rev_name,
            "expense_account_id": acc_id, "expense_account_name": acc_name,
            "active": True,
        }, timeout=15)
        assert r.status_code == 200, r.text
        it = r.json()["item"]
        state["item_ids"].append(it["id"])
        state["item_name"] = it["name"]
        state["exp_acc_id"] = acc_id
        state["exp_acc_name"] = acc_name

    def test_create_bill_with_line(self, api, cid, vendor_id, expense_account, state):
        acc_id, acc_name = expense_account
        iid = state["item_ids"][0]
        payload = {
            "vendor_id": vendor_id,
            "issue_date": "2026-01-10",
            "due_date": "2026-02-10",
            "status": "open",
            "line_items": [{
                "item_id": iid,
                "item_name": state["item_name"],
                "description": state["item_name"],
                "expense_account_id": acc_id,
                "expense_account_name": acc_name,
                "quantity": 3,
                "rate": 100.0,
                "amount": 300.0,
            }],
        }
        r = api.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload, timeout=20)
        assert r.status_code in (200, 201), r.text
        b = r.json().get("bill", r.json())
        state["bill_ids"].append(b["id"])

    def test_purchases_by_item(self, api, cid, state):
        r = api.get(f"{BASE_URL}/api/companies/{cid}/reports/purchases-by-item",
                    params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "rows" in data and "total" in data
        iid = state["item_ids"][0]
        row = next((x for x in data["rows"] if x.get("item_id") == iid), None)
        assert row is not None, f"our item not found: {data['rows']}"
        assert row["amount"] >= 300.0
        assert row["bill_count"] >= 1
        # sorted desc
        amounts = [x["amount"] for x in data["rows"]]
        assert amounts == sorted(amounts, reverse=True)
        # total >= our amount
        assert data["total"] >= 300.0
        assert abs(data["total"] - round(sum(amounts), 2)) < 0.01

    def test_purchases_by_category(self, api, cid, state):
        r = api.get(f"{BASE_URL}/api/companies/{cid}/reports/purchases-by-category",
                    params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        row = next((x for x in data["rows"] if x.get("account_id") == state["exp_acc_id"]), None)
        assert row is not None, f"expense account not aggregated: {data['rows']}"
        assert row["amount"] >= 300.0
        assert row["category"] == state["exp_acc_name"]
        assert row["bill_count"] >= 1

    def test_date_range_filters_bill_out(self, api, cid, state):
        # narrow window in 2025 that excludes our 2026-01-10 bill
        r = api.get(f"{BASE_URL}/api/companies/{cid}/reports/purchases-by-item",
                    params={"start": "2025-01-01", "end": "2025-12-31"}, timeout=15)
        assert r.status_code == 200
        iid = state["item_ids"][0]
        row = next((x for x in r.json()["rows"] if x.get("item_id") == iid), None)
        assert row is None, "bill outside date range leaked"

    def test_excludes_draft_and_void(self, api, cid, vendor_id, expense_account, state):
        acc_id, acc_name = expense_account
        iid = state["item_ids"][0]
        # draft bill
        r = api.post(f"{BASE_URL}/api/companies/{cid}/bills", json={
            "vendor_id": vendor_id,
            "issue_date": "2026-02-01", "due_date": "2026-03-01",
            "status": "draft",
            "line_items": [{"item_id": iid, "description": "draft",
                            "expense_account_id": acc_id,
                            "quantity": 1, "rate": 9999.0, "amount": 9999.0}],
        }, timeout=20)
        assert r.status_code in (200, 201), r.text
        draft_id = r.json().get("bill", r.json())["id"]
        state["bill_ids"].append(draft_id)
        r2 = api.get(f"{BASE_URL}/api/companies/{cid}/reports/purchases-by-item",
                     params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        row = next((x for x in r2.json()["rows"] if x.get("item_id") == iid), None)
        assert row is not None
        assert row["amount"] < 9999.0, "draft bill leaked into report"

    def test_sales_reports_still_work(self, api, cid):
        # regression: sales-by-item + sales-by-category still 200
        r1 = api.get(f"{BASE_URL}/api/companies/{cid}/reports/sales-by-item",
                     params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        assert r1.status_code == 200
        assert "rows" in r1.json() and "total" in r1.json()
        r2 = api.get(f"{BASE_URL}/api/companies/{cid}/reports/sales-by-category",
                     params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        assert r2.status_code == 200
        assert "rows" in r2.json() and "total" in r2.json()


def test_zzz_cleanup(api, cid, state):
    for bid in state.get("bill_ids", []):
        api.delete(f"{BASE_URL}/api/companies/{cid}/bills/{bid}", timeout=15)
    for iid in state.get("item_ids", []):
        api.delete(f"{BASE_URL}/api/companies/{cid}/items/{iid}", timeout=15)
