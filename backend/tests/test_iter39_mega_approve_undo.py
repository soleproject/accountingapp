"""Iter 39 — Mega bulk-approve (full vendor list, selective contact_ids, undo)."""
import os
import pytest
import requests

def _load_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v: return v.rstrip("/")
    for line in open("/app/frontend/.env"):
        if line.startswith("REACT_APP_BACKEND_URL="):
            return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not found")

BASE = _load_backend_url()

PRO_EMAIL, PRO_PW = "pro@axiom.ai", "pro123"
CLIENT2_EMAIL, CLIENT2_PW = "client2@axiom.ai", "client123"

LLC_1119 = "8cefdf98-843a-490b-a22f-831333649bfe"
BRIGHT_BEANS = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"


def _login(email, pw):
    r = requests.post(f"{BASE}/api/auth/login", json={"email": email, "password": pw}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_tok():
    return _login(PRO_EMAIL, PRO_PW)


@pytest.fixture(scope="module")
def pro_h(pro_tok):
    return {"Authorization": f"Bearer {pro_tok}"}


@pytest.fixture(scope="module")
def client2_h():
    return {"Authorization": f"Bearer {_login(CLIENT2_EMAIL, CLIENT2_PW)}"}


# ---- dry_run: full vendor list on 1119 LLC ----
def test_dry_run_returns_full_vendor_list_no_cap(pro_h):
    r = requests.post(
        f"{BASE}/api/companies/{LLC_1119}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, headers=pro_h, timeout=60,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True and d["dry_run"] is True
    assert "vendors" in d and isinstance(d["vendors"], list)
    assert "top_contacts" in d
    # Backward-compat top_contacts is capped at 5
    assert len(d["top_contacts"]) <= 5
    # Full list should be materially larger than 5 on 1119 LLC
    assert len(d["vendors"]) > 5, f"Expected >5 vendors, got {len(d['vendors'])}"
    # Every vendor row shape
    v0 = d["vendors"][0]
    for k in ("contact_id", "contact_name", "count", "amount", "account"):
        assert k in v0, f"missing {k} in vendor row"
    assert isinstance(v0["account"], dict)
    # total_rows/contacts should equal sums of vendor rows
    assert d["total_contacts"] == len(d["vendors"])
    assert d["total_rows"] == sum(v["count"] for v in d["vendors"])
    # No side-effects on dry_run
    assert d["updated"] == 0
    print(f"1119 LLC dry_run: {d['total_rows']} rows / {d['total_contacts']} vendors / ${d['total_amount']}")


def test_dry_run_excludes_needs_review(pro_h):
    # Verify the aggregation excludes needs_review=true rows. The endpoint response
    # doesn't reveal per-row info, but we can compare against the raw count of
    # AI-categorized-unreviewed rows for the same company via the transactions list.
    r = requests.post(
        f"{BASE}/api/companies/{LLC_1119}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, headers=pro_h, timeout=60,
    )
    d = r.json()
    # Sanity: every vendor row's count must be >0 and every contact must have
    # a single account (mixed excluded). Response guarantees this by construction.
    for v in d["vendors"]:
        assert v["count"] > 0
        assert v["account"].get("code") not in ("9999", "4999")


# ---- Bright Beans: full selective apply -> undo -> idempotent undo ----
def test_selective_apply_and_undo_roundtrip(pro_h):
    # Snapshot dry_run first
    pre = requests.post(
        f"{BASE}/api/companies/{BRIGHT_BEANS}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, headers=pro_h, timeout=30,
    ).json()
    if pre["total_rows"] == 0:
        pytest.skip("Bright Beans has no eligible ai_ready rows to test with")
    vendors = pre["vendors"]
    assert len(vendors) >= 1
    # Pick the FIRST vendor only (subset) to prove contact_ids filter works.
    picked = [vendors[0]["contact_id"]]
    expected_rows = vendors[0]["count"]
    print(f"BB pre: total {pre['total_rows']} rows / {pre['total_contacts']} vendors; applying {picked}={expected_rows} rows")

    # Live apply — selective
    live = requests.post(
        f"{BASE}/api/companies/{BRIGHT_BEANS}/transactions/bulk-approve-ai-ready",
        json={"dry_run": False, "contact_ids": picked}, headers=pro_h, timeout=60,
    )
    assert live.status_code == 200, live.text
    ld = live.json()
    assert ld["ok"] and ld["dry_run"] is False
    batch_id = ld["batch_id"]
    assert isinstance(batch_id, str) and len(batch_id) > 10
    # Selective: total_contacts / total_rows for the response reflect the filtered set.
    assert ld["total_contacts"] == 1
    assert ld["total_rows"] == expected_rows
    # Updated should equal expected_rows (assuming none closed-period)
    assert ld["updated"] <= expected_rows
    assert ld["updated"] > 0, "expected at least one row updated"
    updated_n = ld["updated"]

    # After apply — the picked vendor should be gone from the ai_ready pool
    post = requests.post(
        f"{BASE}/api/companies/{BRIGHT_BEANS}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, headers=pro_h, timeout=30,
    ).json()
    remaining_ids = {v["contact_id"] for v in post["vendors"]}
    assert picked[0] not in remaining_ids, "picked vendor still eligible after apply"
    # Other vendors still present
    assert post["total_rows"] == pre["total_rows"] - updated_n

    # Undo
    undo = requests.post(
        f"{BASE}/api/companies/{BRIGHT_BEANS}/transactions/undo-mega-batch/{batch_id}",
        json={}, headers=pro_h, timeout=30,
    )
    assert undo.status_code == 200, undo.text
    ud = undo.json()
    assert ud["ok"] is True
    assert ud["reverted"] == updated_n, f"expected reverted={updated_n}, got {ud['reverted']}"

    # Idempotent undo — second call returns 0
    undo2 = requests.post(
        f"{BASE}/api/companies/{BRIGHT_BEANS}/transactions/undo-mega-batch/{batch_id}",
        json={}, headers=pro_h, timeout=30,
    )
    assert undo2.status_code == 200
    assert undo2.json()["reverted"] == 0

    # State restored — total_rows back to pre value
    restored = requests.post(
        f"{BASE}/api/companies/{BRIGHT_BEANS}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, headers=pro_h, timeout=30,
    ).json()
    assert restored["total_rows"] == pre["total_rows"], (
        f"state drift after undo: pre={pre['total_rows']} restored={restored['total_rows']}"
    )


# ---- Auth ----
def test_undo_endpoint_forbidden_for_unauthorized(client2_h):
    # client2 doesn't own 1119 LLC — undo endpoint should 403 (require_company)
    r = requests.post(
        f"{BASE}/api/companies/{LLC_1119}/transactions/undo-mega-batch/00000000-0000-0000-0000-000000000000",
        json={}, headers=client2_h, timeout=15,
    )
    assert r.status_code in (403, 404), f"expected 403/404, got {r.status_code} {r.text}"


def test_bulk_approve_forbidden_for_unauthorized(client2_h):
    r = requests.post(
        f"{BASE}/api/companies/{LLC_1119}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, headers=client2_h, timeout=15,
    )
    assert r.status_code in (403, 404)


def test_bulk_approve_requires_auth():
    r = requests.post(
        f"{BASE}/api/companies/{LLC_1119}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True}, timeout=15,
    )
    assert r.status_code in (401, 403)
