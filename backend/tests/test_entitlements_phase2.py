"""Phase 2 entitlement gating tests: 402s with X-Plan-Preview, quotas, admin events."""
import os
import pytest
import requests

def _load_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if not v:
        try:
            with open("/app/frontend/.env") as f:
                for line in f:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        v = line.split("=", 1)[1].strip()
                        break
        except Exception:
            pass
    return (v or "").rstrip("/")

BASE_URL = _load_backend_url()
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"
API = f"{BASE_URL}/api"


def _login(email: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed {email}: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_token():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin@axiom.ai", "admin123")


@pytest.fixture(scope="module")
def pro_company_id(pro_token):
    r = requests.get(f"{API}/companies", headers={"Authorization": f"Bearer {pro_token}"}, timeout=20)
    assert r.status_code == 200
    comps = r.json()
    if isinstance(comps, dict):
        comps = comps.get("companies") or comps.get("items") or []
    assert len(comps) > 0, "pro has no companies"
    return comps[0]["id"]


# Endpoint definitions: (method, path_tmpl, json_body, expected_min_plan)
GATED_ENDPOINTS = [
    ("GET",  "/companies/{cid}/reports/sales-tax", None, "advanced"),
    ("GET",  "/companies/{cid}/projections/cashflow", None, "assistant"),
    ("POST", "/companies/{cid}/rules/mine", {}, "bookkeeper"),
    ("POST", "/companies/{cid}/rules/suggest-from-txns", {"transaction_ids": []}, "bookkeeper"),
    ("POST", "/companies/{cid}/inventory-management/adjustments", {}, "advanced"),
    ("POST", "/companies/{cid}/month-close/2026-09/checkpoint", {}, "bookkeeper"),
    ("POST", "/companies/{cid}/cleanup/kickoff", {}, "bookkeeper"),
    ("POST", "/companies/{cid}/owner-dashboard/catchup", {}, "bookkeeper"),
    ("POST", "/companies/{cid}/book-reviews", {}, "bookkeeper"),
    ("POST", "/companies/{cid}/invoices/nonexistent-id/followup-schedule", {}, "bookkeeper"),
]


def _req(method, url, token, body=None, preview=None):
    headers = {"Authorization": f"Bearer {token}"}
    if preview:
        headers["X-Plan-Preview"] = preview
    if method == "GET":
        return requests.get(url, headers=headers, timeout=30)
    headers["Content-Type"] = "application/json"
    return requests.request(method, url, headers=headers, json=body, timeout=30)


@pytest.mark.parametrize("method,path_tmpl,body,min_plan", GATED_ENDPOINTS)
def test_simple_start_preview_returns_402(pro_token, pro_company_id, method, path_tmpl, body, min_plan):
    url = f"{API}{path_tmpl.format(cid=pro_company_id)}"
    r = _req(method, url, pro_token, body, preview="simple_start")
    assert r.status_code == 402, f"{method} {path_tmpl} expected 402, got {r.status_code}: {r.text[:200]}"
    data = r.json()
    detail = data.get("detail") or data
    assert detail.get("code") == "upgrade_required", f"wrong code: {detail}"
    assert detail.get("min_plan") == min_plan, f"wrong min_plan for {path_tmpl}: expected {min_plan} got {detail.get('min_plan')}"


@pytest.mark.parametrize("method,path_tmpl,body,min_plan", GATED_ENDPOINTS)
def test_advanced_preview_no_402(pro_token, pro_company_id, method, path_tmpl, body, min_plan):
    url = f"{API}{path_tmpl.format(cid=pro_company_id)}"
    r = _req(method, url, pro_token, body, preview="advanced")
    assert r.status_code != 402, f"{method} {path_tmpl} should NOT be 402 with advanced preview, got {r.status_code}"


@pytest.mark.parametrize("method,path_tmpl,body,min_plan", GATED_ENDPOINTS)
def test_no_preview_shadow_no_402(pro_token, pro_company_id, method, path_tmpl, body, min_plan):
    url = f"{API}{path_tmpl.format(cid=pro_company_id)}"
    r = _req(method, url, pro_token, body)
    assert r.status_code != 402, f"{method} {path_tmpl} should NOT be 402 in shadow mode, got {r.status_code}"


# Quotas by preview tier
@pytest.mark.parametrize("preview,expected", [
    ("assistant",    {"companies": 1, "users": 3, "accountant": True, "connected_accounts": 6}),
    ("simple_start", {"users": 1, "connected_accounts": 3}),
    ("bookkeeper",   {"users": 5, "connected_accounts": None}),
])
def test_entitlements_quotas(pro_token, pro_company_id, preview, expected):
    url = f"{API}/companies/{pro_company_id}/entitlements"
    r = _req("GET", url, pro_token, preview=preview)
    assert r.status_code == 200, f"ent get failed: {r.status_code} {r.text[:200]}"
    q = r.json().get("quotas")
    assert q is not None, f"quotas missing from entitlements response for {preview}"
    for k, v in expected.items():
        assert q.get(k) == v, f"preview={preview} quotas.{k} expected {v} got {q.get(k)}"


def test_admin_entitlements_events_as_admin(admin_token):
    r = requests.get(f"{API}/admin/entitlements/events?days=30",
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
    data = r.json()
    for key in ("enforce", "totals", "by_feature", "by_plan", "rows"):
        assert key in data, f"missing key {key}"
    assert data["enforce"] is False
    for k in ("events", "shadow", "enforced", "companies"):
        assert k in data["totals"]
    if data["rows"]:
        row = data["rows"][0]
        for k in ("company_name", "feature", "plan_label", "min_plan", "count", "shadow", "enforced", "users", "last_at"):
            assert k in row, f"row missing key {k}"


def test_admin_entitlements_events_forbidden_for_pro(pro_token):
    r = requests.get(f"{API}/admin/entitlements/events?days=30",
                     headers={"Authorization": f"Bearer {pro_token}"}, timeout=20)
    assert r.status_code == 403, f"expected 403, got {r.status_code}"


def test_admin_entitlements_days_validation(admin_token):
    r = requests.get(f"{API}/admin/entitlements/events?days=0",
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=20)
    assert r.status_code == 422, f"expected 422 for days=0, got {r.status_code}"
