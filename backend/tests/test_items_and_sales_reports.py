"""Backend tests for Items catalog CRUD + Sales-by-item / Sales-by-category reports.

Covers the items.py router. Uses client@axiom.ai + one of their TEST_dup companies.
Cleans up its own items + invoice at teardown.
"""
import os
import uuid
import pytest
import requests

# Force serial execution: shared module-scoped state across tests.
pytestmark = pytest.mark.xdist_group("items_sales_serial")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
EMAIL = "client@axiom.ai"
PASSWORD = "client123"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def cid(api):
    r = api.get(f"{BASE_URL}/api/companies", timeout=15)
    assert r.status_code == 200
    comps = r.json()["companies"]
    assert comps, "no companies for client"
    # Prefer one named TEST_dup
    for c in comps:
        if c["name"].startswith("TEST_dup"):
            return c["id"]
    return comps[0]["id"]


@pytest.fixture(scope="module")
def revenue_account_id(api, cid):
    r = api.get(f"{BASE_URL}/api/companies/{cid}/accounts", timeout=15)
    assert r.status_code == 200
    for a in r.json().get("accounts", []):
        if a.get("type") in ("revenue", "income") and "service" in (a.get("name") or "").lower():
            return a["id"], a["name"]
    for a in r.json().get("accounts", []):
        if a.get("type") in ("revenue", "income"):
            return a["id"], a["name"]
    pytest.skip("no revenue account")


@pytest.fixture(scope="module")
def created_state():
    return {"item_ids": [], "invoice_id": None}


# --------------- Items CRUD ---------------
class TestItemsCRUD:
    def test_create_item(self, api, cid, revenue_account_id, created_state):
        acc_id, acc_name = revenue_account_id
        name = f"TEST_item_{uuid.uuid4().hex[:8]}"
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items", json={
            "name": name, "description": "Test service", "type": "service",
            "income_account_id": acc_id, "income_account_name": acc_name,
            "price": 250.0, "sku": "TEST-SKU-1", "active": True,
        }, timeout=15)
        assert r.status_code == 200, r.text
        it = r.json()["item"]
        assert it["name"] == name
        assert it["price"] == 250.0
        assert it["income_account_id"] == acc_id
        assert it["income_account_name"] == acc_name
        assert it["active"] is True
        created_state["item_ids"].append(it["id"])
        created_state["first_item_name"] = name

    def test_duplicate_name_409(self, api, cid, created_state):
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items", json={
            "name": created_state["first_item_name"], "price": 1,
        }, timeout=15)
        assert r.status_code == 409
        assert "already exists" in r.json().get("detail", "").lower()

    def test_list_sorted(self, api, cid, created_state):
        # create a second item so we can test sort
        name2 = f"TEST_item_AAA_{uuid.uuid4().hex[:6]}"
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items", json={
            "name": name2, "price": 100.0, "type": "product",
        }, timeout=15)
        assert r.status_code == 200
        created_state["item_ids"].append(r.json()["item"]["id"])
        r = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
        assert r.status_code == 200
        names = [i["name"] for i in r.json()["items"]]
        assert names == sorted(names), f"items not sorted: {names[:5]}"

    def test_patch_price_and_active(self, api, cid, created_state):
        iid = created_state["item_ids"][0]
        r = api.patch(f"{BASE_URL}/api/companies/{cid}/items/{iid}", json={"price": 999.99, "active": False}, timeout=15)
        assert r.status_code == 200, r.text
        it = r.json()["item"]
        assert it["price"] == 999.99
        assert it["active"] is False
        # verify persistence via GET list
        r2 = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
        found = [i for i in r2.json()["items"] if i["id"] == iid][0]
        assert found["price"] == 999.99 and found["active"] is False

    def test_patch_rename_conflict_409(self, api, cid, created_state):
        # rename item[0] to item[1]'s name => 409
        iid0 = created_state["item_ids"][0]
        r = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
        others = [i for i in r.json()["items"] if i["id"] != iid0 and i["name"].startswith("TEST_")]
        assert others
        r = api.patch(f"{BASE_URL}/api/companies/{cid}/items/{iid0}", json={"name": others[0]["name"]}, timeout=15)
        assert r.status_code == 409


# --------------- Sales reports ---------------
class TestSalesReports:
    def test_create_invoice_with_item_link(self, api, cid, revenue_account_id, created_state):
        acc_id, acc_name = revenue_account_id
        # Need a contact — pick or create one
        r = api.get(f"{BASE_URL}/api/companies/{cid}/contacts", timeout=15)
        contacts = r.json().get("contacts", []) if r.status_code == 200 else []
        if contacts:
            contact_id = contacts[0]["id"]
        else:
            rc = api.post(f"{BASE_URL}/api/companies/{cid}/contacts",
                          json={"name": "TEST_customer", "kind": "customer"}, timeout=15)
            assert rc.status_code in (200, 201), rc.text
            contact_id = rc.json().get("contact", rc.json()).get("id")

        # Use the second item (the one still active)
        iid = created_state["item_ids"][1]
        r = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
        item = [i for i in r.json()["items"] if i["id"] == iid][0]

        payload = {
            "contact_id": contact_id,
            "issue_date": "2026-01-15",
            "due_date": "2026-02-15",
            "status": "sent",
            "line_items": [{
                "item_id": item["id"],
                "item_name": item["name"],
                "description": item["description"] or item["name"],
                "income_account_id": acc_id,
                "income_account_name": acc_name,
                "quantity": 2,
                "rate": 100.0,
                "amount": 200.0,
            }],
        }
        r = api.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=payload, timeout=20)
        assert r.status_code in (200, 201), r.text
        inv = r.json().get("invoice", r.json())
        created_state["invoice_id"] = inv["id"]

    def test_sales_by_item(self, api, cid, created_state):
        r = api.get(f"{BASE_URL}/api/companies/{cid}/reports/sales-by-item",
                    params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "rows" in data and "total" in data
        # row for our item present
        iid = created_state["item_ids"][1]
        row = next((r for r in data["rows"] if r.get("item_id") == iid), None)
        assert row is not None, f"our item not found in rows: {data['rows']}"
        assert row["amount"] >= 200.0
        # sorted desc
        amounts = [r["amount"] for r in data["rows"]]
        assert amounts == sorted(amounts, reverse=True)
        # total == sum
        assert abs(data["total"] - round(sum(amounts), 2)) < 0.01

    def test_sales_by_category(self, api, cid, revenue_account_id, created_state):
        acc_id, acc_name = revenue_account_id
        r = api.get(f"{BASE_URL}/api/companies/{cid}/reports/sales-by-category",
                    params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        row = next((r for r in data["rows"] if r.get("account_id") == acc_id), None)
        assert row is not None, f"revenue account not aggregated: {data['rows']}"
        assert row["amount"] >= 200.0
        assert row["category"] == acc_name

    def test_excludes_draft(self, api, cid, revenue_account_id, created_state):
        # Create a draft invoice and confirm it's NOT in sales
        acc_id, acc_name = revenue_account_id
        r = api.get(f"{BASE_URL}/api/companies/{cid}/contacts", timeout=15)
        contact_id = r.json()["contacts"][0]["id"]
        iid = created_state["item_ids"][1]
        payload = {
            "contact_id": contact_id,
            "issue_date": "2026-03-01",
            "due_date": "2026-04-01",
            "status": "draft",
            "line_items": [{
                "item_id": iid,
                "description": "draft line",
                "income_account_id": acc_id,
                "quantity": 1, "rate": 5555.0, "amount": 5555.0,
            }],
        }
        r = api.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=payload, timeout=20)
        draft_id = r.json().get("invoice", r.json())["id"]
        # Sales by item — should NOT reflect this 5555 amount for our item
        r = api.get(f"{BASE_URL}/api/companies/{cid}/reports/sales-by-item",
                    params={"start": "2026-01-01", "end": "2026-12-31"}, timeout=15)
        row = next((x for x in r.json()["rows"] if x.get("item_id") == iid), None)
        assert row is None or row["amount"] < 5555, "draft invoice leaked into sales report"
        # cleanup
        api.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{draft_id}", timeout=15)


# --------------- Delete + cleanup ---------------
def test_zzz_cleanup(api, cid, created_state):
    if created_state.get("invoice_id"):
        api.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{created_state['invoice_id']}", timeout=15)
    for iid in created_state.get("item_ids", []):
        r = api.delete(f"{BASE_URL}/api/companies/{cid}/items/{iid}", timeout=15)
        assert r.status_code == 200
    # Verify items removed
    r = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    remaining_ids = {i["id"] for i in r.json()["items"]}
    for iid in created_state.get("item_ids", []):
        assert iid not in remaining_ids
