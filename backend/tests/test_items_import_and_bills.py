"""Backend tests for Items bulk-import + expense_account field + Bill-line item link.

Covers:
  - POST /api/companies/{cid}/items/import (CSV + Excel + column aliasing +
    auto-create accounts + idempotent re-import + no-name-column rejection)
  - Items now carry expense_account_id / expense_account_name (create + patch)
  - POST /api/companies/{cid}/bills persists expense_account_* on a bill line
"""
import io
import os
import uuid
import pytest
import requests

pytestmark = pytest.mark.xdist_group("items_import_serial")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
EMAIL = "client@axiom.ai"
PASSWORD = "client123"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


@pytest.fixture(scope="module")
def cid(api):
    r = api.get(f"{BASE_URL}/api/companies", timeout=15)
    assert r.status_code == 200
    for c in r.json()["companies"]:
        if c["id"] == "540fbc73-66fd-432f-a357-39db6c84c5bd":
            return c["id"]
        if c["name"].startswith("TEST_dup"):
            return c["id"]
    return r.json()["companies"][0]["id"]


@pytest.fixture(scope="module")
def state():
    return {"prefix": f"TEST_imp_{uuid.uuid4().hex[:6]}",
            "created_item_ids": set(),
            "created_bill_ids": set(),
            "auto_created_account_names": set()}


def _list_items(api, cid):
    return api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15).json()["items"]


def _list_accounts(api, cid):
    return api.get(f"{BASE_URL}/api/companies/{cid}/accounts", timeout=15).json().get("accounts", [])


# ---------------- Import: header aliasing + basic create ----------------
class TestImportBasic:
    def test_import_csv_column_aliases_and_create(self, api, cid, state):
        # Headers mix cases + aliases: 'Item Name', 'PRICE', 'Sales Price' etc.
        # Includes an intentionally-missing account so we can check auto-create.
        rev_name = f"{state['prefix']}_Rev_Acct"
        exp_name = f"{state['prefix']}_Exp_Acct"
        state["auto_created_account_names"].update({rev_name, exp_name})
        csv = (
            "Item Name,Description,Type,Account,Expense Account,SALES PRICE,SKU,Active\n"
            f"{state['prefix']}_A,Alpha svc,service,{rev_name},{exp_name},150.00,SKU-A,yes\n"
            f"{state['prefix']}_B,Beta prod,product,{rev_name},{exp_name},\"1,299.99\",SKU-B,true\n"
            f"{state['prefix']}_C,Gamma,,{rev_name},,55,,no\n"
        )
        files = {"file": ("items.csv", csv.encode("utf-8"), "text/csv")}
        data = {"create_missing_accounts": "true", "update_existing": "true"}
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items/import",
                     files=files, data=data, timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["created"] == 3, j
        assert j["updated"] == 0
        assert j["total_rows"] == 3
        assert j["errors"] == []
        # Column aliasing worked
        rc = j["resolved_columns"]
        assert rc.get("name")  # 'Item Name'
        assert rc.get("price")  # 'SALES PRICE' (alias 'salesprice')
        assert rc.get("account")
        assert rc.get("expense_account")
        # Persistence — GET items and verify fields
        items = _list_items(api, cid)
        by_name = {it["name"]: it for it in items}
        assert f"{state['prefix']}_A" in by_name
        a = by_name[f"{state['prefix']}_A"]
        assert a["price"] == 150.0
        assert a["type"] == "service"
        assert a["active"] is True
        assert a["income_account_name"] == rev_name
        assert a["expense_account_name"] == exp_name
        assert a["income_account_id"]
        assert a["expense_account_id"]
        b = by_name[f"{state['prefix']}_B"]
        assert b["price"] == 1299.99  # "$1,299.99" cleaned
        assert b["type"] == "product"
        c = by_name[f"{state['prefix']}_C"]
        assert c["active"] is False
        assert c["expense_account_id"] in (None, "", None)
        for nm in (f"{state['prefix']}_A", f"{state['prefix']}_B", f"{state['prefix']}_C"):
            state["created_item_ids"].add(by_name[nm]["id"])

    def test_auto_created_accounts_present(self, api, cid, state):
        accts = _list_accounts(api, cid)
        names = {a["name"] for a in accts}
        for auto in state["auto_created_account_names"]:
            assert auto in names, f"auto-created account missing: {auto}"

    def test_idempotent_reimport_updates(self, api, cid, state):
        # Re-run the same CSV → all 3 should be UPDATES, no new rows.
        rev_name = f"{state['prefix']}_Rev_Acct"
        exp_name = f"{state['prefix']}_Exp_Acct"
        csv = (
            "Item Name,Description,Type,Account,Expense Account,SALES PRICE,SKU,Active\n"
            f"{state['prefix']}_A,Alpha svc UPDATED,service,{rev_name},{exp_name},175.00,SKU-A,yes\n"
            f"{state['prefix']}_B,Beta prod,product,{rev_name},{exp_name},1299.99,SKU-B,true\n"
            f"{state['prefix']}_C,Gamma,,{rev_name},,55,,no\n"
        )
        files = {"file": ("items.csv", csv.encode("utf-8"), "text/csv")}
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items/import",
                     files=files, data={"create_missing_accounts": "true",
                                        "update_existing": "true"}, timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["created"] == 0
        assert j["updated"] == 3
        # Verify the description update landed
        items = _list_items(api, cid)
        a = next(i for i in items if i["name"] == f"{state['prefix']}_A")
        assert a["description"] == "Alpha svc UPDATED"
        assert a["price"] == 175.0

    def test_no_name_column_rejected(self, api, cid):
        csv = "Foo,Bar\n1,2\n"
        files = {"file": ("bad.csv", csv.encode("utf-8"), "text/csv")}
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items/import",
                     files=files, data={}, timeout=15)
        assert r.status_code == 400
        assert "name" in r.json().get("detail", "").lower()

    def test_update_existing_false_skips(self, api, cid, state):
        # With update_existing=false the same names come back as skipped.
        rev_name = f"{state['prefix']}_Rev_Acct"
        csv = (
            "name,price,account\n"
            f"{state['prefix']}_A,999,{rev_name}\n"
            f"{state['prefix']}_B,999,{rev_name}\n"
        )
        files = {"file": ("items.csv", csv.encode("utf-8"), "text/csv")}
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items/import",
                     files=files, data={"create_missing_accounts": "false",
                                        "update_existing": "false"}, timeout=30)
        assert r.status_code == 200
        j = r.json()
        assert j["created"] == 0
        assert j["updated"] == 0
        assert j["skipped"] == 2
        # Verify price NOT changed on A (still 175 from previous test)
        items = _list_items(api, cid)
        a = next(i for i in items if i["name"] == f"{state['prefix']}_A")
        assert a["price"] == 175.0, "update_existing=false should not overwrite"


# ---------------- Import: Excel .xlsx ----------------
class TestImportExcel:
    def test_import_xlsx(self, api, cid, state):
        pd = pytest.importorskip("pandas")
        pytest.importorskip("openpyxl")
        df = pd.DataFrame([
            {"Name": f"{state['prefix']}_XLSX_1", "PRICE": 42.5, "Type": "service"},
            {"Name": f"{state['prefix']}_XLSX_2", "PRICE": "100", "Type": "product"},
        ])
        buf = io.BytesIO()
        df.to_excel(buf, index=False, engine="openpyxl")
        buf.seek(0)
        files = {"file": ("items.xlsx", buf.getvalue(),
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items/import",
                     files=files,
                     data={"create_missing_accounts": "false", "update_existing": "true"},
                     timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["created"] == 2, j
        items = _list_items(api, cid)
        by_name = {i["name"]: i for i in items}
        x1 = by_name[f"{state['prefix']}_XLSX_1"]
        assert x1["price"] == 42.5
        assert x1["type"] == "service"
        for nm in (f"{state['prefix']}_XLSX_1", f"{state['prefix']}_XLSX_2"):
            state["created_item_ids"].add(by_name[nm]["id"])


# ---------------- Item CRUD: expense_account_* ----------------
class TestItemExpenseAccount:
    def test_create_item_with_expense_account_id_only(self, api, cid, state):
        # Grab any expense/COGS account
        accts = _list_accounts(api, cid)
        exp = next((a for a in accts if a.get("type") in ("expense", "cogs")), None)
        assert exp, "no expense account available in TEST_dup"
        nm = f"{state['prefix']}_ExpItem"
        r = api.post(f"{BASE_URL}/api/companies/{cid}/items", json={
            "name": nm, "price": 10.0, "expense_account_id": exp["id"],
        }, timeout=15)
        assert r.status_code == 200, r.text
        it = r.json()["item"]
        # Backend should backfill expense_account_name from CoA
        assert it["expense_account_id"] == exp["id"]
        assert it["expense_account_name"] == exp["name"]
        state["created_item_ids"].add(it["id"])
        state["_exp_item_id"] = it["id"]
        state["_exp_acct"] = exp

    def test_patch_expense_account_backfills_name(self, api, cid, state):
        iid = state["_exp_item_id"]
        accts = _list_accounts(api, cid)
        expenses = [a for a in accts if a.get("type") in ("expense", "cogs")]
        assert len(expenses) >= 1
        target = expenses[-1]
        r = api.patch(f"{BASE_URL}/api/companies/{cid}/items/{iid}",
                      json={"expense_account_id": target["id"]}, timeout=15)
        assert r.status_code == 200, r.text
        it = r.json()["item"]
        assert it["expense_account_id"] == target["id"]
        assert it["expense_account_name"] == target["name"]


# ---------------- Bill line persists expense_account_* ----------------
class TestBillLineExpenseAccount:
    def test_create_bill_with_item_flows_expense_account(self, api, cid, state):
        # Pick a vendor contact (or create one)
        r = api.get(f"{BASE_URL}/api/companies/{cid}/contacts", timeout=15)
        contacts = r.json().get("contacts", [])
        vendor = next((c for c in contacts if c.get("kind") in ("vendor", "supplier")), None)
        if not vendor:
            rc = api.post(f"{BASE_URL}/api/companies/{cid}/contacts",
                          json={"name": f"{state['prefix']}_Vendor", "kind": "vendor"}, timeout=15)
            assert rc.status_code in (200, 201), rc.text
            vendor = rc.json().get("contact", rc.json())
            state["_vendor_id_created"] = vendor["id"]
        item = api.get(f"{BASE_URL}/api/companies/{cid}/items/",
                       timeout=15) if False else None
        # Use the expense-account item we created above
        items = _list_items(api, cid)
        the_item = next(i for i in items if i["id"] == state["_exp_item_id"])
        payload = {
            "vendor_id": vendor["id"],
            "issue_date": "2026-01-20",
            "due_date": "2026-02-20",
            "status": "open",
            "line_items": [{
                "item_id": the_item["id"],
                "item_name": the_item["name"],
                "description": the_item["description"] or the_item["name"],
                "expense_account_id": the_item["expense_account_id"],
                "expense_account_name": the_item["expense_account_name"],
                "category": the_item["expense_account_name"],
                "quantity": 1,
                "rate": 250.0,
                "amount": 250.0,
            }],
        }
        r = api.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload, timeout=20)
        # Some backends use contact_id instead of vendor_id — retry
        if r.status_code >= 400:
            payload["contact_id"] = vendor["id"]
            payload.pop("vendor_id", None)
            r = api.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload, timeout=20)
        assert r.status_code in (200, 201), r.text
        bill = r.json().get("bill", r.json())
        state["created_bill_ids"].add(bill["id"])

        # GET the bill back and verify the line carries item_id + expense_account fields
        lst = api.get(f"{BASE_URL}/api/companies/{cid}/bills", timeout=15).json()
        bills = lst.get("bills", lst if isinstance(lst, list) else [])
        fetched = next((b for b in bills if b["id"] == bill["id"]), None)
        assert fetched, "created bill not retrievable"
        lines = fetched.get("line_items") or fetched.get("lines") or []
        assert lines, f"no line_items on bill: {fetched}"
        li = lines[0]
        assert li.get("item_id") == the_item["id"]
        assert li.get("expense_account_id") == the_item["expense_account_id"]
        assert li.get("expense_account_name") == the_item["expense_account_name"]


# ---------------- Cleanup ----------------
def test_zzz_cleanup(api, cid, state):
    for bid in list(state.get("created_bill_ids", [])):
        api.delete(f"{BASE_URL}/api/companies/{cid}/bills/{bid}", timeout=15)
    for iid in list(state.get("created_item_ids", [])):
        api.delete(f"{BASE_URL}/api/companies/{cid}/items/{iid}", timeout=15)
    # Auto-created accounts: delete by name where possible
    accts = _list_accounts(api, cid)
    for a in accts:
        if a["name"] in state.get("auto_created_account_names", set()):
            api.delete(f"{BASE_URL}/api/companies/{cid}/accounts/{a['id']}", timeout=15)
    if state.get("_vendor_id_created"):
        api.delete(f"{BASE_URL}/api/companies/{cid}/contacts/{state['_vendor_id_created']}", timeout=15)
