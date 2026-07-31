"""Backend tests for Items `usage` field (sales/purchases/both) — filters,
default, PATCH validation, backfill inference, and CSV import parsing."""
import os
import io
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"
EMAIL = "client@axiom.ai"
PASSWORD = "client123"

created_item_ids: list[str] = []


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    token = r.json().get("access_token") or r.json().get("token")
    if token:
        s.headers.update({"Authorization": f"Bearer {token}"})
    yield s
    # Cleanup
    for iid in created_item_ids:
        try:
            s.delete(f"{BASE_URL}/api/companies/{CID}/items/{iid}")
        except Exception:
            pass


def _make(api, name, **extra):
    payload = {"name": name, "type": "service", "price": 10.0, **extra}
    r = api.post(f"{BASE_URL}/api/companies/{CID}/items", json=payload)
    assert r.status_code == 200, f"Create failed: {r.status_code} {r.text}"
    item = r.json()["item"]
    created_item_ids.append(item["id"])
    return item


# --- Default & explicit usage on create ---

def test_create_defaults_usage_to_sales(api):
    tag = uuid.uuid4().hex[:8]
    it = _make(api, f"TEST_item_default_{tag}")
    assert it["usage"] == "sales"


def test_create_explicit_purchases(api):
    tag = uuid.uuid4().hex[:8]
    it = _make(api, f"TEST_item_purchases_{tag}", usage="purchases")
    assert it["usage"] == "purchases"


def test_create_explicit_both(api):
    tag = uuid.uuid4().hex[:8]
    it = _make(api, f"TEST_item_both_{tag}", usage="both")
    assert it["usage"] == "both"


# --- GET filter semantics ---

def test_list_filter_sales_includes_sales_and_both(api):
    tag = uuid.uuid4().hex[:8]
    s_it = _make(api, f"TEST_item_flt_s_{tag}", usage="sales")
    p_it = _make(api, f"TEST_item_flt_p_{tag}", usage="purchases")
    b_it = _make(api, f"TEST_item_flt_b_{tag}", usage="both")

    r = api.get(f"{BASE_URL}/api/companies/{CID}/items?usage=sales")
    assert r.status_code == 200
    ids = {i["id"] for i in r.json()["items"]}
    assert s_it["id"] in ids
    assert b_it["id"] in ids
    assert p_it["id"] not in ids


def test_list_filter_purchases_includes_purchases_and_both(api):
    tag = uuid.uuid4().hex[:8]
    s_it = _make(api, f"TEST_item_fp_s_{tag}", usage="sales")
    p_it = _make(api, f"TEST_item_fp_p_{tag}", usage="purchases")
    b_it = _make(api, f"TEST_item_fp_b_{tag}", usage="both")

    r = api.get(f"{BASE_URL}/api/companies/{CID}/items?usage=purchases")
    assert r.status_code == 200
    ids = {i["id"] for i in r.json()["items"]}
    assert p_it["id"] in ids
    assert b_it["id"] in ids
    assert s_it["id"] not in ids


def test_list_no_filter_has_usage_backfilled(api):
    r = api.get(f"{BASE_URL}/api/companies/{CID}/items")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) > 0
    for it in items:
        assert it.get("usage") in ("sales", "purchases", "both"), f"Missing usage on {it.get('name')}"


# --- PATCH validation and update semantics ---

def test_patch_invalid_usage_returns_400(api):
    tag = uuid.uuid4().hex[:8]
    it = _make(api, f"TEST_item_patchbad_{tag}")
    r = api.patch(f"{BASE_URL}/api/companies/{CID}/items/{it['id']}", json={"usage": "invalid"})
    assert r.status_code == 400
    detail = r.json().get("detail", "")
    assert "usage must be one of" in detail
    assert "sales" in detail and "purchases" in detail and "both" in detail


def test_patch_usage_sales_to_purchases_flips_filter(api):
    tag = uuid.uuid4().hex[:8]
    it = _make(api, f"TEST_item_flip_{tag}", usage="sales")
    iid = it["id"]

    # Initially appears in sales
    r = api.get(f"{BASE_URL}/api/companies/{CID}/items?usage=sales")
    assert iid in {i["id"] for i in r.json()["items"]}

    # Flip to purchases
    r = api.patch(f"{BASE_URL}/api/companies/{CID}/items/{iid}", json={"usage": "purchases"})
    assert r.status_code == 200
    assert r.json()["item"]["usage"] == "purchases"

    # Now in purchases, not in sales
    r = api.get(f"{BASE_URL}/api/companies/{CID}/items?usage=purchases")
    assert iid in {i["id"] for i in r.json()["items"]}
    r = api.get(f"{BASE_URL}/api/companies/{CID}/items?usage=sales")
    assert iid not in {i["id"] for i in r.json()["items"]}


# --- CSV import ---

def test_csv_import_explicit_usage_column(api):
    tag = uuid.uuid4().hex[:8]
    csv_content = (
        "name,type,price,usage\n"
        f"TEST_csv_s_{tag},service,10,sales\n"
        f"TEST_csv_p_{tag},service,20,purchases\n"
        f"TEST_csv_b_{tag},service,30,both\n"
    )
    files = {"file": ("items.csv", csv_content, "text/csv")}
    r = api.post(f"{BASE_URL}/api/companies/{CID}/items/import", files=files)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("created", 0) + data.get("updated", 0) >= 3

    r = api.get(f"{BASE_URL}/api/companies/{CID}/items")
    by_name = {i["name"]: i for i in r.json()["items"]}
    assert by_name[f"TEST_csv_s_{tag}"]["usage"] == "sales"
    assert by_name[f"TEST_csv_p_{tag}"]["usage"] == "purchases"
    assert by_name[f"TEST_csv_b_{tag}"]["usage"] == "both"
    for k in (f"TEST_csv_s_{tag}", f"TEST_csv_p_{tag}", f"TEST_csv_b_{tag}"):
        created_item_ids.append(by_name[k]["id"])


def test_csv_import_infers_usage_from_accounts(api):
    """When no Usage column present, infer from which account slots are populated.
    We use free-form account names (auto-created); expense-only → purchases."""
    tag = uuid.uuid4().hex[:8]
    csv_content = (
        "name,type,price,expenseaccount\n"
        f"TEST_csv_inf_exp_{tag},service,15,TEST Exp Cat {tag}\n"
    )
    files = {"file": ("items.csv", csv_content, "text/csv")}
    r = api.post(f"{BASE_URL}/api/companies/{CID}/items/import", files=files)
    assert r.status_code == 200, r.text

    r = api.get(f"{BASE_URL}/api/companies/{CID}/items")
    by_name = {i["name"]: i for i in r.json()["items"]}
    item = by_name.get(f"TEST_csv_inf_exp_{tag}")
    assert item is not None
    assert item["usage"] == "purchases", f"expected purchases (expense-only), got {item['usage']}"
    created_item_ids.append(item["id"])
