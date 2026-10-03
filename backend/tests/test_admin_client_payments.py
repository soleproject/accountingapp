"""Tests for Superadmin → Client Payments endpoints."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")


def _login(email, password):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"Login failed for {email}: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def admin():
    return _login("admin@axiom.ai", "admin123")


@pytest.fixture(scope="module")
def pro():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def listing(admin):
    r = admin.get(f"{BASE_URL}/api/admin/client-payments", timeout=60)
    assert r.status_code == 200, r.text
    return r.json()


def test_list_requires_auth():
    r = requests.get(f"{BASE_URL}/api/admin/client-payments", timeout=30)
    assert r.status_code in (401, 403)


def test_list_forbidden_for_non_superadmin(pro):
    r = pro.get(f"{BASE_URL}/api/admin/client-payments", timeout=30)
    assert r.status_code == 403


def test_list_shape(listing):
    for k in ("metrics", "attention", "rows", "stripe_mode"):
        assert k in listing


def _find(rows, name):
    return next((r for r in rows if r.get("company_name") == name), None)


def test_qa_trial_bakery(listing):
    row = _find(listing["rows"], "QA Trial Bakery LLC")
    assert row, "QA Trial Bakery LLC missing"
    assert row["status"] == "trialing"
    assert row["cadence"] == "annual"
    assert row["amount_cents"] == 99000
    assert row["next_charge_at"] == row["trial_end"]
    assert row["enterprise_name"] == "CypherPro"


def test_qa_late_plumbing(listing):
    row = _find(listing["rows"], "QA Late Plumbing Inc")
    assert row, "QA Late Plumbing Inc missing"
    assert row["status"] == "past_due"
    assert row["last_failure"] is not None
    assert row["ltv_cents"] == 15800


def test_qa_steady_dental(listing):
    row = _find(listing["rows"], "QA Steady Dental PC")
    assert row, "QA Steady Dental PC missing"
    assert row["status"] == "active"
    assert row["ltv_cents"] == 19000


def test_metrics(listing):
    m = listing["metrics"]
    # Per request: mrr_cents == 7900 + 3800 = 11700
    assert m["mrr_cents"] == 11700, f"mrr_cents got {m['mrr_cents']}"
    assert m["past_due"] == 1
    assert m["past_due_cents"] == 7900
    assert m["trialing"] == 1


def test_attention_order(listing):
    att = listing["attention"]
    assert att, "attention is empty"
    assert att[0]["company_name"] == "QA Late Plumbing Inc"


def test_detail_dental(admin, listing):
    row = _find(listing["rows"], "QA Steady Dental PC")
    cid = row["company_id"]
    r = admin.get(f"{BASE_URL}/api/admin/client-payments/{cid}", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(["client", "payments", "timeline"]).issubset(data.keys())
    payments = data["payments"]
    assert len(payments) == 5, f"expected 5 payments, got {len(payments)}"
    # newest first
    paids = [p.get("paid_at") for p in payments]
    assert paids == sorted(paids, reverse=True)
    for p in payments:
        assert p.get("product_label") == "Core"
    labels = [t["label"] for t in data["timeline"]]
    assert any(l.startswith("Company created") for l in labels)
    assert any(l == "Paid $38.00" for l in labels)


def test_detail_404(admin):
    r = admin.get(f"{BASE_URL}/api/admin/client-payments/does-not-exist-xyz", timeout=30)
    assert r.status_code == 404


def test_backfill(admin):
    r = admin.post(f"{BASE_URL}/api/admin/client-payments/backfill", timeout=120)
    assert r.status_code == 200, r.text
    data = r.json()
    for k in ("synced", "failed", "total"):
        assert k in data
    assert isinstance(data["failed"], list)
    # Seeded sub_qa_* ids should fail
    failed_ids = [f.get("company_id") for f in data["failed"]]
    assert data["failed"], "expected at least one failed row for fake sub ids"
