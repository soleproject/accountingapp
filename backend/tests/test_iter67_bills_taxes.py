"""Iter 67 — Backend regression for Bills full-page editor parity + Tax Library CRUD.

Covers:
- POST/GET/PATCH /api/companies/{cid}/bills with new fields (po_number, terms,
  discount, discount_type, shipping, internal_notes, attachments, title, summary)
- _sum_lines total math via bills endpoints (per-line tax + shipping + discount).
- Tax Library CRUD: list/create/rename/delete + 409 on delete-while-referenced.
"""
import os
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = "client@axiom.ai"
PASSWORD = "client123"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, r.json()
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def cid(client):
    r = client.get(f"{BASE_URL}/api/companies")
    assert r.status_code == 200, r.text
    companies = r.json().get("companies") or r.json()
    assert companies, "No companies for client"
    # Prefer Skyward Sparks
    for c in companies:
        if "skyward" in (c.get("name", "").lower()):
            return c["id"]
    return companies[0]["id"]


# ------------------- Tax Library -------------------

class TestTaxLibrary:
    def test_list_empty_or_ok(self, client, cid):
        r = client.get(f"{BASE_URL}/api/companies/{cid}/taxes")
        assert r.status_code == 200
        assert "taxes" in r.json()

    def test_create_rename_delete(self, client, cid):
        # Create
        r = client.post(f"{BASE_URL}/api/companies/{cid}/taxes",
                        json={"name": "TEST_HST_67", "rate": 13})
        assert r.status_code == 200, r.text
        tax = r.json()["tax"]
        assert tax["name"] == "TEST_HST_67"
        assert tax["rate"] == 13
        tid = tax["id"]

        # Verify persisted
        r = client.get(f"{BASE_URL}/api/companies/{cid}/taxes")
        names = [t["name"] for t in r.json()["taxes"]]
        assert "TEST_HST_67" in names

        # Rename
        r = client.patch(f"{BASE_URL}/api/companies/{cid}/taxes/{tid}",
                         json={"name": "TEST_HST_67_v2", "rate": 15})
        assert r.status_code == 200, r.text

        r = client.get(f"{BASE_URL}/api/companies/{cid}/taxes")
        after = {t["id"]: t for t in r.json()["taxes"]}
        assert after[tid]["name"] == "TEST_HST_67_v2"
        assert after[tid]["rate"] == 15

        # Delete
        r = client.delete(f"{BASE_URL}/api/companies/{cid}/taxes/{tid}")
        assert r.status_code == 200

        r = client.get(f"{BASE_URL}/api/companies/{cid}/taxes")
        assert tid not in [t["id"] for t in r.json()["taxes"]]

    def test_delete_refuses_when_in_use(self, client, cid):
        # Create a tax
        r = client.post(f"{BASE_URL}/api/companies/{cid}/taxes",
                        json={"name": "TEST_LOCK_67", "rate": 7})
        assert r.status_code == 200
        tid = r.json()["tax"]["id"]
        try:
            # Create a bill referencing the tax on a line
            payload = {
                "issue_date": "2026-01-15",
                "due_date": "2026-01-30",
                "line_items": [{
                    "description": "Locked line",
                    "quantity": 1, "rate": 100, "amount": 100,
                    "tax_id": tid, "tax_name": "TEST_LOCK_67", "tax_rate": 7,
                }],
                "status": "open",
                "number": "TEST_BILL_LOCK_67",
            }
            r = client.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload)
            assert r.status_code == 200, r.text
            bid = r.json()["id"]
            try:
                # Delete should 409
                r = client.delete(f"{BASE_URL}/api/companies/{cid}/taxes/{tid}")
                assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text}"
            finally:
                client.delete(f"{BASE_URL}/api/companies/{cid}/bills/{bid}")
        finally:
            client.delete(f"{BASE_URL}/api/companies/{cid}/taxes/{tid}")

    def test_invalid_rate(self, client, cid):
        r = client.post(f"{BASE_URL}/api/companies/{cid}/taxes",
                        json={"name": "TEST_BAD_67", "rate": 150})
        assert r.status_code == 400


# ------------------- Bills full-page editor -------------------

class TestBillEditorBackend:
    def test_create_get_patch_bill_full_fields(self, client, cid):
        payload = {
            "number": "TEST_BILL_67",
            "contact_name": "Acme Vendor",
            "issue_date": "2026-01-10",
            "due_date": "2026-01-25",
            "line_items": [
                {"description": "Office supplies", "quantity": 2, "rate": 50, "amount": 100,
                 "tax_rate": 10},
                {"description": "Consulting", "quantity": 1, "rate": 200, "amount": 200},
            ],
            "tax": 0,
            "shipping": 5,
            "discount": 10,
            "discount_type": "amount",
            "status": "open",
            "notes": "Public notes here",
            "po_number": "PO-9",
            "terms": "Net 15",
            "internal_notes": "Internal only",
            "attachments": [],
            "title": "January bill",
            "summary": "Test summary",
        }
        r = client.post(f"{BASE_URL}/api/companies/{cid}/bills", json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        bid = body["id"]
        bill = body["bill"]

        # Math: subtotal 300, per-line tax = 100*10% = 10; disc 10 amt; shipping 5.
        # total = 300 - 10 + 5 + 10 = 305
        assert bill["subtotal"] == 300
        assert bill["tax"] == 10
        assert bill["shipping"] == 5
        assert bill["discount_amount"] == 10
        assert bill["total"] == 305
        assert bill["balance_due"] == 305
        assert bill["po_number"] == "PO-9"
        assert bill["terms"] == "Net 15"
        assert bill["internal_notes"] == "Internal only"
        assert bill["title"] == "January bill"
        assert bill["summary"] == "Test summary"

        try:
            # GET single
            r = client.get(f"{BASE_URL}/api/companies/{cid}/bills/{bid}")
            assert r.status_code == 200
            b = r.json()["bill"]
            for k in ("po_number", "terms", "discount", "discount_type", "shipping",
                      "internal_notes", "attachments", "title", "summary"):
                assert k in b, f"missing field {k}"

            # PATCH: change discount to 20% and shipping to 15
            # NOTE: send tax=0 explicitly (mirrors frontend BillEditor.buildBody)
            # to avoid the stored-tax-includes-line-tax double-count on partial
            # patches. See report action_items.
            r = client.patch(f"{BASE_URL}/api/companies/{cid}/bills/{bid}",
                             json={"discount": 20, "discount_type": "percent",
                                   "shipping": 15, "tax": 0})
            assert r.status_code == 200

            r = client.get(f"{BASE_URL}/api/companies/{cid}/bills/{bid}")
            b = r.json()["bill"]
            # subtotal 300, disc 20% = 60, ship 15, per-line tax 10
            # total = 300 - 60 + 15 + 10 = 265
            assert b["discount_amount"] == 60
            assert b["shipping"] == 15
            assert b["tax"] == 10
            assert b["total"] == 265
        finally:
            client.delete(f"{BASE_URL}/api/companies/{cid}/bills/{bid}")
