"""Quota enforcement tests: seats (users) + connected_accounts.

Covers:
- GET /api/companies/{cid}/entitlements returns usage + quotas (and quotas=None without preview for superadmin).
- POST /invites 402 quota_exceeded on 2nd invite under simple_start preview; passes with assistant preview; passes shadow.
- POST /plaid/connect-account returns 400 (not 402) when quota passes.
- Admin events show quota_users row for Bright Beans.
- Cleanup: delete all qa-quota-* invites created.
"""
import os
import pytest
import requests

BRIGHT_BEANS_CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"


def _backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if not v:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    v = line.split("=", 1)[1].strip()
                    break
    return (v or "").rstrip("/")


BASE_URL = _backend_url()
API = f"{BASE_URL}/api"


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_h():
    return {"Authorization": f"Bearer {_login('pro@axiom.ai', 'pro123')}"}


@pytest.fixture(scope="module")
def admin_h():
    return {"Authorization": f"Bearer {_login('admin@axiom.ai', 'admin123')}"}


@pytest.fixture(scope="module", autouse=True)
def _cleanup_pending(pro_h):
    """Pre-clean any leftover qa-quota-* invites before and after."""
    def _purge():
        try:
            r = requests.get(f"{API}/companies/{BRIGHT_BEANS_CID}/team", headers=pro_h, timeout=20)
            if r.status_code == 200:
                data = r.json()
                invites = data.get("pending_invites") or data.get("invites") or []
                for inv in invites:
                    email = (inv.get("email") or "").lower()
                    if email.startswith("qa-quota-") or email.startswith("qa-ui-quota"):
                        iid = inv.get("id") or inv.get("invite_id")
                        if iid:
                            requests.delete(f"{API}/invites/{iid}", headers=pro_h, timeout=20)
        except Exception as e:
            print(f"cleanup warn: {e}")
    _purge()
    yield
    _purge()


def test_entitlements_usage_and_quotas_pro_simple_start(pro_h):
    r = requests.get(
        f"{API}/companies/{BRIGHT_BEANS_CID}/entitlements",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        timeout=20,
    )
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert "usage" in body, body
    usage = body["usage"]
    assert "users" in usage and "connected_accounts" in usage
    assert isinstance(usage["users"], int)
    assert isinstance(usage["connected_accounts"], int)
    assert body.get("quotas"), f"quotas should be present under preview: {body}"
    q = body["quotas"]
    # Core = 1 user / 3 accounts
    assert q.get("users") == 1, q
    assert q.get("connected_accounts") == 3, q


def test_entitlements_quotas_null_for_admin_no_preview(admin_h):
    r = requests.get(f"{API}/companies/{BRIGHT_BEANS_CID}/entitlements", headers=admin_h, timeout=20)
    assert r.status_code == 200
    body = r.json()
    # superadmin all-access → no preview, quotas should be None/null
    assert body.get("quotas") is None, f"expected null quotas for superadmin, got {body.get('quotas')}"


def test_quota_402_invites_flow(pro_h):
    # 0 → 1 under simple_start: 200
    r1 = requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/invites",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        json={"email": "qa-quota-1@example.com", "role": "viewer"},
        timeout=20,
    )
    assert r1.status_code == 200, f"first invite should succeed: {r1.status_code} {r1.text[:200]}"

    # usage.users should now be 1
    e = requests.get(
        f"{API}/companies/{BRIGHT_BEANS_CID}/entitlements",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        timeout=20,
    ).json()
    assert e["usage"]["users"] == 1, e["usage"]

    # 2nd invite under simple_start → 402 quota_exceeded
    r2 = requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/invites",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        json={"email": "qa-quota-2@example.com", "role": "viewer"},
        timeout=20,
    )
    assert r2.status_code == 402, f"expected 402 got {r2.status_code} {r2.text[:300]}"
    detail = r2.json().get("detail", {})
    assert detail.get("code") == "quota_exceeded", detail
    assert detail.get("feature") == "quota_users", detail
    assert detail.get("kind") == "users", detail
    assert detail.get("used") == 1, detail
    assert detail.get("limit") == 1, detail
    assert detail.get("min_plan") == "assistant", detail
    assert detail.get("min_plan_label") == "AI Assistant", detail
    assert detail.get("min_plan_price") == 79, detail
    assert detail.get("next_limit") == 3, detail

    # Same 2nd invite with assistant preview → NOT 402
    r3 = requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/invites",
        headers={**pro_h, "X-Plan-Preview": "assistant"},
        json={"email": "qa-quota-2@example.com", "role": "viewer"},
        timeout=20,
    )
    assert r3.status_code != 402, f"assistant preview must not 402: {r3.status_code} {r3.text[:200]}"
    assert r3.status_code in (200, 201, 400, 409), r3.text[:200]

    # Same POST shadow (no preview header) → NOT 402
    r4 = requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/invites",
        headers=pro_h,
        json={"email": "qa-quota-3@example.com", "role": "viewer"},
        timeout=20,
    )
    assert r4.status_code != 402, f"shadow must not 402: {r4.status_code} {r4.text[:200]}"


def test_connect_account_quota_passes_returns_400(pro_h):
    # Verify usage.connected_accounts == 0 first
    e = requests.get(
        f"{API}/companies/{BRIGHT_BEANS_CID}/entitlements",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        timeout=20,
    ).json()
    assert e["usage"]["connected_accounts"] == 0, e["usage"]

    r = requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/plaid/connect-account",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        json={},
        timeout=20,
    )
    # quota passes (0<3) → dependency should NOT 402; should be 400 for missing plaid_account_id
    assert r.status_code == 400, f"expected 400 plaid_account_id required, got {r.status_code} {r.text[:200]}"
    txt = r.text.lower()
    assert "plaid_account_id" in txt, r.text[:200]


def test_admin_events_includes_quota_users(admin_h, pro_h):
    # Clean all pending invites to reset usage.users = 0
    tr = requests.get(f"{API}/companies/{BRIGHT_BEANS_CID}/team", headers=pro_h, timeout=20)
    if tr.status_code == 200:
        for inv in (tr.json().get("pending_invites") or tr.json().get("invites") or []):
            iid = inv.get("id") or inv.get("invite_id")
            if iid:
                requests.delete(f"{API}/invites/{iid}", headers=pro_h, timeout=20)

    # Create 1 invite under simple_start to reach used=1
    requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/invites",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        json={"email": "qa-quota-admin1@example.com", "role": "viewer"},
        timeout=20,
    )
    # Now trigger a 402 (used=1, limit=1)
    r402 = requests.post(
        f"{API}/companies/{BRIGHT_BEANS_CID}/invites",
        headers={**pro_h, "X-Plan-Preview": "simple_start"},
        json={"email": "qa-quota-admin2@example.com", "role": "viewer"},
        timeout=20,
    )
    assert r402.status_code == 402, r402.text[:200]

    r = requests.get(f"{API}/admin/entitlements/events?days=7", headers=admin_h, timeout=30)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    rows = body.get("rows") or body.get("events") or []
    by_feature = body.get("by_feature") or {}
    assert "quota_users" in by_feature or any(
        rr.get("feature") == "quota_users" for rr in rows
    ), f"quota_users not in events: features={list(by_feature.keys())}"

    match = [rr for rr in rows if rr.get("feature") == "quota_users" and rr.get("company_id") == BRIGHT_BEANS_CID]
    assert match, f"no quota_users row for Bright Beans"
    row = match[0]
    # Latest state: used=1, limit=1, min_plan assistant (since assistant limit=3 covers 1+1)
    assert row.get("limit") == 1, row
    assert row.get("min_plan") == "assistant", row
    assert (row.get("enforced") or 0) >= 1, row


def test_admin_events_pro_forbidden(pro_h):
    r = requests.get(f"{API}/admin/entitlements/events?days=7", headers=pro_h, timeout=20)
    assert r.status_code == 403, f"pro should get 403, got {r.status_code}"
