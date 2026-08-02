"""Backend tests for Tier 2 Weighted-Average Inventory Module.

Covers items catalog inventory fields, bill inventory hooks (weighted avg),
invoice COGS hooks, negative QOH warnings, manual adjustments, valuation
report, delta-based bill/invoice delete reversal, and draft skip.

Uses client@axiom.ai (Skyward Sparks). Cleans up items/bills/invoices at teardown.
"""
import os
import uuid
import pytest
import requests

pytestmark = pytest.mark.xdist_group("inventory_tier2_serial")

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
    assert comps
    for c in comps:
        if "Skyward" in c["name"]:
            return c["id"]
    return comps[0]["id"]


@pytest.fixture(scope="module")
def accounts(api, cid):
    """Find inventory + COGS + expense accounts."""
    r = api.get(f"{BASE_URL}/api/companies/{cid}/accounts", timeout=15)
    assert r.status_code == 200
    accts = r.json().get("accounts", [])
    inv = next((a for a in accts if "inventory" in (a.get("name") or "").lower() and a.get("type") == "asset"), None)
    cogs = next((a for a in accts if "cogs" in (a.get("name") or "").lower() or "cost of goods" in (a.get("name") or "").lower()), None)
    expense = next((a for a in accts if a.get("type") == "expense"), None)
    assert inv, "no Inventory asset account found"
    assert cogs, "no COGS account found"
    assert expense, "no expense account found"
    return {"inv": inv, "cogs": cogs, "expense": expense}


@pytest.fixture(scope="module")
def state():
    return {"item_id": None, "bill_id": None, "invoice_id": None, "invoice2_id": None}


@pytest.fixture(scope="module", autouse=True)
def cleanup(api, cid, state):
    yield
    for iid in filter(None, [state.get("invoice_id"), state.get("invoice2_id")]):
        try: api.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{iid}", timeout=15)
        except Exception: pass
    if state.get("bill_id"):
        try: api.delete(f"{BASE_URL}/api/companies/{cid}/bills/{state['bill_id']}", timeout=15)
        except Exception: pass
    if state.get("item_id"):
        try: api.delete(f"{BASE_URL}/api/companies/{cid}/items/{state['item_id']}", timeout=15)
        except Exception: pass


# ── 1. Create tracked item ────────────────────────────────────────────
def test_create_tracked_item(api, cid, accounts, state):
    name = f"TEST_INV_{uuid.uuid4().hex[:8]}"
    payload = {
        "name": name, "type": "product", "usage": "both",
        "price": 50, "expense_account_id": accounts["expense"]["id"],
        "track_inventory": True,
        "quantity_on_hand": 10, "cost_basis": 20,
        "inventory_account_id": accounts["inv"]["id"],
        "cogs_account_id": accounts["cogs"]["id"],
        "low_stock_threshold": 5,
    }
    r = api.post(f"{BASE_URL}/api/companies/{cid}/items", json=payload, timeout=15)
    assert r.status_code == 200, r.text
    item = r.json()["item"]
    assert item["track_inventory"] is True
    assert item["quantity_on_hand"] == 10
    assert item["cost_basis"] == 20
    assert item["inventory_account_id"] == accounts["inv"]["id"]
    assert item["cogs_account_id"] == accounts["cogs"]["id"]
    assert item["low_stock_threshold"] == 5
    state["item_id"] = item["id"]


# ── 2. Bill inventory hook → weighted-avg ─────────────────────────────
def test_bill_inventory_hook_weighted_average(api, cid, accounts, state):
    assert state["item_id"]
    bill_payload = {
        "number": f"TEST_B_{uuid.uuid4().hex[:6]}",
        "contact_name": "TEST Vendor",
        "issue_date": "2026-01-15", "due_date": "2026-02-15",
        "status": "open",
        "line_items": [{
            "item_id": state["item_id"], "description": "receive stock",
            "quantity": 5, "rate": 30, "amount": 150,
            "expense_account_id": accounts["expense"]["id"],
            "expense_account_name": accounts["expense"]["name"],
        }],
    }
    r = api.post(f"{BASE_URL}/api/companies/{cid}/bills", json=bill_payload, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    state["bill_id"] = body["id"]

    # Verify hooks were persisted
    br = api.get(f"{BASE_URL}/api/companies/{cid}/bills/{state['bill_id']}", timeout=15)
    assert br.status_code == 200
    bill = br.json()["bill"]
    hooks = bill.get("inventory_hooks") or []
    assert len(hooks) == 1, f"expected 1 hook, got {hooks}"
    assert hooks[0].get("je_id")

    # Verify item QOH=15, cost=23.3333
    ir = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it = next(x for x in ir.json()["items"] if x["id"] == state["item_id"])
    assert it["quantity_on_hand"] == 15, f"expected 15, got {it['quantity_on_hand']}"
    assert abs(it["cost_basis"] - 23.3333) < 0.01, f"expected 23.3333, got {it['cost_basis']}"


# ── 3. Invoice COGS hook ──────────────────────────────────────────────
def test_invoice_cogs_hook(api, cid, state):
    assert state["item_id"]
    inv_payload = {
        "number": f"TEST_I_{uuid.uuid4().hex[:6]}",
        "contact_name": "TEST Customer",
        "issue_date": "2026-01-16", "due_date": "2026-02-16",
        "status": "sent",
        "line_items": [{
            "item_id": state["item_id"], "description": "sale",
            "quantity": 3, "rate": 50, "amount": 150,
        }],
    }
    r = api.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=inv_payload, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    state["invoice_id"] = body["id"]
    warnings = body.get("inventory_warnings")
    assert warnings == [], f"unexpected warnings: {warnings}"

    # QOH should drop to 12
    ir = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it = next(x for x in ir.json()["items"] if x["id"] == state["item_id"])
    assert it["quantity_on_hand"] == 12, f"expected 12, got {it['quantity_on_hand']}"
    assert abs(it["cost_basis"] - 23.3333) < 0.01


# ── 4. Negative QOH warning (still saves) ─────────────────────────────
def test_negative_qoh_warning(api, cid, state):
    assert state["item_id"]
    inv_payload = {
        "number": f"TEST_INEG_{uuid.uuid4().hex[:6]}",
        "contact_name": "TEST Customer 2",
        "issue_date": "2026-01-17", "due_date": "2026-02-17",
        "status": "sent",
        "line_items": [{
            "item_id": state["item_id"], "description": "big sale",
            "quantity": 100, "rate": 50, "amount": 5000,
        }],
    }
    r = api.post(f"{BASE_URL}/api/companies/{cid}/invoices", json=inv_payload, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    state["invoice2_id"] = body["id"]
    warnings = body.get("inventory_warnings") or []
    assert len(warnings) >= 1, "expected negative QOH warning"
    assert "quantity on hand" in warnings[0].lower() or "negative" in warnings[0].lower() or "would leave" in warnings[0].lower()

    # Cleanup this one immediately so state doesn't affect later tests
    api.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{state['invoice2_id']}", timeout=15)
    state["invoice2_id"] = None


# ── 5. Manual adjustment ──────────────────────────────────────────────
def test_manual_adjustment(api, cid, state):
    assert state["item_id"]
    ir = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_before = next(x for x in ir.json()["items"] if x["id"] == state["item_id"])
    pre_qoh = it_before["quantity_on_hand"]

    payload = {"item_id": state["item_id"], "reason": "recount",
               "qty_delta": 2, "memo": "Found extra"}
    r = api.post(f"{BASE_URL}/api/companies/{cid}/inventory-management/adjustments",
                 json=payload, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("movement_id")
    # je_id may be present (posted) since value_delta != 0

    ir2 = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_after = next(x for x in ir2.json()["items"] if x["id"] == state["item_id"])
    assert it_after["quantity_on_hand"] == pre_qoh + 2

    # Movements includes adjustment
    mv = api.get(f"{BASE_URL}/api/companies/{cid}/inventory-management/movements",
                 params={"item_id": state["item_id"]}, timeout=15)
    assert mv.status_code == 200
    rows = mv.json()["rows"]
    assert any(r["kind"] == "adjustment" for r in rows)


# ── 6. Valuation report ───────────────────────────────────────────────
def test_valuation_report(api, cid, state):
    r = api.get(f"{BASE_URL}/api/companies/{cid}/inventory-management/valuation", timeout=15)
    assert r.status_code == 200
    body = r.json()
    rows = body["rows"]
    # Verify sort by value desc
    for i in range(1, len(rows)):
        assert rows[i-1]["value"] >= rows[i]["value"]
    # Verify total_value = sum(qoh*cost)
    expected_total = round(sum(r["qoh"] * r["cost_basis"] for r in rows), 2)
    assert abs(body["total_value"] - expected_total) < 0.02

    # Our item present with low_stock flag correctness
    our = next((r for r in rows if r["item_id"] == state["item_id"]), None)
    assert our is not None
    # Our QOH is 14 with threshold 5 → low_stock False
    assert our["low_stock"] == (our["qoh"] <= 5)


# ── 7. Bill delete reversal ───────────────────────────────────────────
def test_bill_delete_reversal(api, cid, state):
    assert state["bill_id"]
    ir_before = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_before = next(x for x in ir_before.json()["items"] if x["id"] == state["item_id"])
    pre_qoh = it_before["quantity_on_hand"]

    r = api.delete(f"{BASE_URL}/api/companies/{cid}/bills/{state['bill_id']}", timeout=15)
    assert r.status_code == 200
    bill_id = state["bill_id"]
    state["bill_id"] = None  # don't try to double-delete in cleanup

    ir_after = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_after = next(x for x in ir_after.json()["items"] if x["id"] == state["item_id"])
    # Bill added 5 → reversal should subtract 5
    assert it_after["quantity_on_hand"] == pre_qoh - 5, \
        f"expected {pre_qoh - 5}, got {it_after['quantity_on_hand']}"

    # Reversal movement recorded
    mv = api.get(f"{BASE_URL}/api/companies/{cid}/inventory-management/movements",
                 params={"item_id": state["item_id"]}, timeout=15)
    rows = mv.json()["rows"]
    assert any(r["kind"] == "reversal" for r in rows), "no reversal movement recorded"


# ── 8. Invoice delete reversal (delta-based) ──────────────────────────
def test_invoice_delete_delta_reversal(api, cid, state):
    """QOH before invoice delete + 3 (sold qty) == QOH after."""
    assert state["invoice_id"]
    ir_before = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_before = next(x for x in ir_before.json()["items"] if x["id"] == state["item_id"])
    pre_qoh = it_before["quantity_on_hand"]

    r = api.delete(f"{BASE_URL}/api/companies/{cid}/invoices/{state['invoice_id']}", timeout=15)
    assert r.status_code == 200
    state["invoice_id"] = None

    ir_after = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_after = next(x for x in ir_after.json()["items"] if x["id"] == state["item_id"])
    assert it_after["quantity_on_hand"] == pre_qoh + 3, \
        f"expected {pre_qoh + 3}, got {it_after['quantity_on_hand']}"


# ── 11. Draft skip ────────────────────────────────────────────────────
def test_draft_bill_does_not_commit(api, cid, accounts, state):
    assert state["item_id"]
    ir = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_before = next(x for x in ir.json()["items"] if x["id"] == state["item_id"])
    pre_qoh = it_before["quantity_on_hand"]

    draft = {
        "number": f"TEST_DRAFT_{uuid.uuid4().hex[:6]}",
        "contact_name": "TEST DraftV",
        "issue_date": "2026-01-18", "due_date": "2026-02-18",
        "status": "draft",
        "line_items": [{
            "item_id": state["item_id"], "description": "draft",
            "quantity": 7, "rate": 30, "amount": 210,
            "expense_account_id": accounts["expense"]["id"],
        }],
    }
    r = api.post(f"{BASE_URL}/api/companies/{cid}/bills", json=draft, timeout=15)
    assert r.status_code == 200
    draft_bid = r.json()["id"]

    ir2 = api.get(f"{BASE_URL}/api/companies/{cid}/items", timeout=15)
    it_after = next(x for x in ir2.json()["items"] if x["id"] == state["item_id"])
    assert it_after["quantity_on_hand"] == pre_qoh, "draft bill should NOT change QOH"

    api.delete(f"{BASE_URL}/api/companies/{cid}/bills/{draft_bid}", timeout=15)
