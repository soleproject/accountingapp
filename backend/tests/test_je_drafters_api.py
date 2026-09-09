"""AI JE Drafters — HTTP-level integration test against the live backend.

Exercises the scan → list → patch → approve/reject flow for Bright Beans
Coffee Co. plus role gating for the client user.
"""
import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"  # Bright Beans Coffee Co.
PERIOD = "2026-02"


def _login(email: str, password: str) -> requests.Session:
    s = requests.Session()
    r = s.post(f"{BASE}/api/auth/login",
               json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("access_token") or r.json().get("token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


@pytest.fixture(scope="module")
def pro():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def client():
    return _login("client@axiom.ai", "client123")


# ---------- Scan ----------

def test_scan_returns_bright_beans_drafts(pro):
    r = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
                 json={"period": PERIOD}, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["period"] == PERIOD
    assert "by_kind" in data and "drafts" in data
    assert data["count"] >= 1, f"expected ≥1 draft, got {data}"
    kinds = {d["drafter_kind"] for d in data["drafts"]}
    assert "prepaid_amort" in kinds, f"expected prepaid_amort in {kinds}"
    for d in data["drafts"]:
        # Balanced double entry
        dr = sum(float(l.get("debit") or 0) for l in d["lines"])
        cr = sum(float(l.get("credit") or 0) for l in d["lines"])
        assert abs(dr - cr) < 0.01, f"unbalanced draft {d['id']}: dr={dr} cr={cr}"
        assert d["status"] == "pending"
        assert 0.0 <= d["confidence"] <= 1.0
        assert "source" in d


def test_scan_is_idempotent(pro):
    r1 = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
                  json={"period": PERIOD}, timeout=30)
    c1 = r1.json()["count"]
    r2 = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
                  json={"period": PERIOD}, timeout=30)
    c2 = r2.json()["count"]
    assert c1 == c2, f"non-idempotent scan: {c1} then {c2}"


def test_scan_bad_period(pro):
    r = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
                 json={"period": "202602"}, timeout=15)
    assert r.status_code in (400, 422)


# ---------- List ----------

def test_list_pending(pro):
    r = pro.get(f"{BASE}/api/companies/{CID}/je-drafters",
                params={"period": PERIOD, "status": "pending"}, timeout=15)
    assert r.status_code == 200
    data = r.json()
    assert "drafts" in data and "counts" in data
    for k in ("pending", "approved", "rejected"):
        assert k in data["counts"]


# ---------- Patch ----------

def test_patch_unbalanced_lines_returns_400(pro):
    pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
             json={"period": PERIOD}, timeout=30)
    lst = pro.get(f"{BASE}/api/companies/{CID}/je-drafters",
                  params={"period": PERIOD, "status": "pending"}).json()
    if not lst["drafts"]:
        pytest.skip("no pending drafts")
    did = lst["drafts"][0]["id"]
    r = pro.patch(f"{BASE}/api/companies/{CID}/je-drafters/{did}",
                  json={"lines": [
                      {"account_id": "x", "debit": 100, "credit": 0},
                      {"account_id": "y", "debit": 0, "credit": 50},
                  ]}, timeout=15)
    assert r.status_code == 400


def test_patch_memo_ok(pro):
    lst = pro.get(f"{BASE}/api/companies/{CID}/je-drafters",
                  params={"period": PERIOD, "status": "pending"}).json()
    if not lst["drafts"]:
        pytest.skip("no pending drafts")
    did = lst["drafts"][0]["id"]
    r = pro.patch(f"{BASE}/api/companies/{CID}/je-drafters/{did}",
                  json={"memo": "TEST_updated memo"}, timeout=15)
    assert r.status_code == 200


# ---------- Approve / Reject ----------

def test_approve_posts_and_second_approve_400(pro):
    pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
             json={"period": PERIOD}, timeout=30)
    lst = pro.get(f"{BASE}/api/companies/{CID}/je-drafters",
                  params={"period": PERIOD, "status": "pending"}).json()
    prepaids = [d for d in lst["drafts"] if d["drafter_kind"] == "prepaid_amort"]
    if not prepaids:
        pytest.skip("no prepaid drafts")
    did = prepaids[0]["id"]
    r = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/{did}/approve", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body.get("je_id")
    # Double-approve
    r2 = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/{did}/approve", timeout=15)
    assert r2.status_code == 400


def test_reject_then_reject_404(pro):
    pro.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
             json={"period": PERIOD}, timeout=30)
    lst = pro.get(f"{BASE}/api/companies/{CID}/je-drafters",
                  params={"period": PERIOD, "status": "pending"}).json()
    if not lst["drafts"]:
        pytest.skip("no pending drafts")
    did = lst["drafts"][-1]["id"]
    r = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/{did}/reject", timeout=15)
    assert r.status_code == 200
    r2 = pro.post(f"{BASE}/api/companies/{CID}/je-drafters/{did}/reject", timeout=15)
    assert r2.status_code == 404


def test_patch_on_rejected_returns_400(pro):
    lst = pro.get(f"{BASE}/api/companies/{CID}/je-drafters",
                  params={"period": PERIOD, "status": "rejected"}).json()
    if not lst["drafts"]:
        pytest.skip("no rejected drafts")
    did = lst["drafts"][0]["id"]
    r = pro.patch(f"{BASE}/api/companies/{CID}/je-drafters/{did}",
                  json={"memo": "nope"}, timeout=15)
    assert r.status_code == 400


# ---------- Role gating ----------

def test_client_role_gated_403(client):
    r = client.post(f"{BASE}/api/companies/{CID}/je-drafters/scan",
                    json={"period": PERIOD}, timeout=15)
    assert r.status_code == 403
    r2 = client.get(f"{BASE}/api/companies/{CID}/je-drafters",
                    params={"period": PERIOD}, timeout=15)
    assert r2.status_code == 403
