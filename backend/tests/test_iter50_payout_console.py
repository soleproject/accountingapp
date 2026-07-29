"""Iteration 50 — Superadmin affiliate payouts console regression suite.

Covers:
- GET /api/admin/affiliate/payouts (overview + auth gates)
- GET /api/admin/affiliate/payouts/{referrer_user_id} (line items + filter)
- POST /api/admin/affiliate/payouts/mark-paid (happy path, cherry-pick, idempotency)
- POST /api/admin/affiliate/payouts/{earning_id}/reverse (happy + errors)
- GET /api/admin/affiliate/history

Run: pytest /app/backend/tests/test_iter50_payout_console.py -v
"""
import os
import sys
import uuid
import asyncio
import datetime as dt

import pytest
import requests


def _read_base_url() -> str:
    env = os.environ.get("REACT_APP_BACKEND_URL")
    if env:
        return env.rstrip("/")
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not configured")


BASE_URL = _read_base_url()
API = f"{BASE_URL}/api"

sys.path.insert(0, "/app/backend")

ADMIN_EMAIL = "admin@axiom.ai"
ADMIN_PASS = "admin123"
PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"
CLIENT_EMAIL = "client@axiom.ai"


def _login(email, pw):
    r = requests.post(f"{API}/auth/login",
                      json={"email": email, "password": pw}, timeout=15)
    assert r.status_code == 200, f"login failed {email}: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers():
    tok = _login(ADMIN_EMAIL, ADMIN_PASS)
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def pro_headers():
    tok = _login(PRO_EMAIL, PRO_PASS)
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def pro_user_id(pro_headers):
    r = requests.get(f"{API}/auth/me", headers=pro_headers, timeout=10)
    assert r.status_code == 200
    d = r.json()
    return d.get("id") or d["user"]["id"]


@pytest.fixture(scope="module")
def client_user_id():
    tok = _login(CLIENT_EMAIL, "client123")
    r = requests.get(f"{API}/auth/me",
                     headers={"Authorization": f"Bearer {tok}"}, timeout=10)
    d = r.json()
    return d.get("id") or d["user"]["id"]


def _loop():
    try:
        return asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


def _seed_accrued(referrer_id, referred_id, shares):
    """Seed N accrued referral_earnings rows. Returns list of earning ids."""
    from db import db
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    ids = []
    docs = []
    for s in shares:
        eid = f"TEST_earn_{uuid.uuid4().hex[:10]}"
        ids.append(eid)
        docs.append({
            "id": eid,
            "platform_payment_id": f"TEST_pay_{uuid.uuid4().hex[:8]}",
            "referrer_user_id": referrer_id,
            "referred_user_id": referred_id,
            "gross_cents": s * 5,
            "share_bps": 2000,
            "share_cents": s,
            "currency": "usd",
            "status": "accrued",
            "created_at": now,
        })

    async def _run():
        await db.referral_earnings.insert_many(docs)
    _loop().run_until_complete(_run())
    return ids


def _cleanup_earnings(ids):
    from db import db
    async def _run():
        await db.referral_earnings.delete_many({"id": {"$in": ids}})
        await db.referral_payout_batches.delete_many({"earning_ids": {"$in": ids}})
    _loop().run_until_complete(_run())


# ------------------------------------------------------------------
# 1. Overview + auth gates
# ------------------------------------------------------------------
class TestOverview:
    def test_overview_shape(self, admin_headers):
        r = requests.get(f"{API}/admin/affiliate/payouts",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "affiliates" in d and isinstance(d["affiliates"], list)
        assert "totals" in d
        for k in ("affiliates", "affiliates_needing_payout",
                  "accrued_cents", "paid_out_cents", "lifetime_cents"):
            assert k in d["totals"], f"missing totals key: {k}"
        if d["affiliates"]:
            row = d["affiliates"][0]
            for k in ("referrer_user_id", "email", "name", "referral_slug",
                      "firm_name", "accrued_cents", "paid_out_cents",
                      "accrued_count", "paid_count", "unique_payers",
                      "last_activity", "needs_payout"):
                assert k in row, f"missing row key: {k}"
        # sorted by -accrued_cents
        accrued_list = [r["accrued_cents"] for r in d["affiliates"]]
        assert accrued_list == sorted(accrued_list, reverse=True)

    def test_overview_forbidden_for_pro(self, pro_headers):
        r = requests.get(f"{API}/admin/affiliate/payouts",
                         headers=pro_headers, timeout=10)
        assert r.status_code == 403, f"expected 403, got {r.status_code}"

    def test_overview_unauth_401(self):
        r = requests.get(f"{API}/admin/affiliate/payouts", timeout=10)
        assert r.status_code in (401, 403), \
            f"expected 401/403 unauth, got {r.status_code}"


# ------------------------------------------------------------------
# 2. Per-referrer line items
# ------------------------------------------------------------------
class TestPerReferrerLines:
    def test_all_lines(self, admin_headers, pro_user_id):
        r = requests.get(
            f"{API}/admin/affiliate/payouts/{pro_user_id}",
            headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "referrer" in d and d["referrer"]["user_id"] == pro_user_id
        assert "lines" in d and isinstance(d["lines"], list)
        assert "totals" in d
        for k in ("accrued_cents", "paid_out_cents"):
            assert k in d["totals"]
        if d["lines"]:
            l = d["lines"][0]
            for k in ("id", "date", "referred_email", "referred_name",
                      "gross_cents", "share_cents", "share_bps",
                      "status", "paid_out_at", "paid_out_by",
                      "external_ref", "note"):
                assert k in l, f"missing line key: {k}"

    def test_status_filter_accrued(self, admin_headers, pro_user_id, client_user_id):
        ids = _seed_accrued(pro_user_id, client_user_id, [111])
        try:
            r = requests.get(
                f"{API}/admin/affiliate/payouts/{pro_user_id}",
                headers=admin_headers, params={"status": "accrued"}, timeout=10)
            assert r.status_code == 200
            statuses = {l["status"] for l in r.json()["lines"]}
            assert statuses == {"accrued"} or not statuses
        finally:
            _cleanup_earnings(ids)

    def test_status_filter_paid_out(self, admin_headers, pro_user_id):
        r = requests.get(
            f"{API}/admin/affiliate/payouts/{pro_user_id}",
            headers=admin_headers, params={"status": "paid_out"}, timeout=10)
        assert r.status_code == 200
        statuses = {l["status"] for l in r.json()["lines"]}
        assert statuses.issubset({"paid_out"})


# ------------------------------------------------------------------
# 3. mark-paid — happy path (seed 3, mark all)
# ------------------------------------------------------------------
class TestMarkPaidHappyPath:
    def test_mark_all_accrued(self, admin_headers, pro_user_id, client_user_id):
        ids = _seed_accrued(pro_user_id, client_user_id, [700, 1500, 2000])
        try:
            # Read baseline paid_out_cents for pro
            ov = requests.get(f"{API}/admin/affiliate/payouts",
                              headers=admin_headers).json()
            base_paid = 0
            for row in ov["affiliates"]:
                if row["referrer_user_id"] == pro_user_id:
                    base_paid = row["paid_out_cents"]
                    break

            # Mark paid restricted to our seeded ids (safer than "all")
            r = requests.post(
                f"{API}/admin/affiliate/payouts/mark-paid",
                headers=admin_headers,
                json={
                    "referrer_user_id": pro_user_id,
                    "earning_ids": ids,
                    "external_ref": "WISE-TEST",
                    "note": "iter50 test",
                },
                timeout=15,
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["marked"] == 3
            assert data["amount_cents"] == 4200

            # Overview reflects new paid amount (>= because other tests
            # running in parallel may also flip rows to paid_out).
            ov2 = requests.get(f"{API}/admin/affiliate/payouts",
                               headers=admin_headers).json()
            new_paid = 0
            for row in ov2["affiliates"]:
                if row["referrer_user_id"] == pro_user_id:
                    new_paid = row["paid_out_cents"]
                    break
            assert new_paid >= base_paid + 4200

            # Confirm the specific seeded rows are now paid_out.
            det = requests.get(
                f"{API}/admin/affiliate/payouts/{pro_user_id}",
                headers=admin_headers, timeout=10).json()
            id_to_status = {l["id"]: l["status"] for l in det["lines"]}
            for eid in ids:
                assert id_to_status.get(eid) == "paid_out"

            # History includes the batch with our external_ref
            hist = requests.get(f"{API}/admin/affiliate/history",
                                headers=admin_headers,
                                params={"limit": 20}).json()
            match = [b for b in hist["batches"]
                     if b.get("external_ref") == "WISE-TEST"
                     and b["referrer"]["user_id"] == pro_user_id
                     and b["amount_cents"] == 4200]
            assert match, "batch not found in history"
            assert match[0]["invoice_count"] == 3
            assert match[0]["note"] == "iter50 test"
        finally:
            _cleanup_earnings(ids)


# ------------------------------------------------------------------
# 4. Cherry-pick semantics
# ------------------------------------------------------------------
class TestCherryPick:
    def test_only_selected_ids_move(self, admin_headers, pro_user_id, client_user_id):
        ids = _seed_accrued(pro_user_id, client_user_id, [500, 800, 1200])
        try:
            selected = [ids[0], ids[2]]  # 500 + 1200 = 1700
            r = requests.post(
                f"{API}/admin/affiliate/payouts/mark-paid",
                headers=admin_headers,
                json={
                    "referrer_user_id": pro_user_id,
                    "earning_ids": selected,
                    "external_ref": "CHERRY-1",
                }, timeout=10,
            )
            assert r.status_code == 200
            body = r.json()
            assert body["marked"] == 2
            assert body["amount_cents"] == 1700

            # Get per-referrer lines and verify statuses
            det = requests.get(
                f"{API}/admin/affiliate/payouts/{pro_user_id}",
                headers=admin_headers, timeout=10).json()
            id_to_status = {l["id"]: l["status"] for l in det["lines"]}
            assert id_to_status[ids[0]] == "paid_out"
            assert id_to_status[ids[2]] == "paid_out"
            assert id_to_status[ids[1]] == "accrued"  # untouched
        finally:
            _cleanup_earnings(ids)


# ------------------------------------------------------------------
# 5. Idempotency
# ------------------------------------------------------------------
class TestMarkPaidIdempotent:
    def test_second_call_marks_zero(self, admin_headers, pro_user_id, client_user_id):
        ids = _seed_accrued(pro_user_id, client_user_id, [333, 444])
        try:
            body = {
                "referrer_user_id": pro_user_id,
                "earning_ids": ids,
                "external_ref": "IDEMP-1",
            }
            r1 = requests.post(f"{API}/admin/affiliate/payouts/mark-paid",
                               headers=admin_headers, json=body, timeout=10)
            assert r1.status_code == 200
            assert r1.json() == {"marked": 2, "amount_cents": 777}

            r2 = requests.post(f"{API}/admin/affiliate/payouts/mark-paid",
                               headers=admin_headers, json=body, timeout=10)
            assert r2.status_code == 200
            d2 = r2.json()
            assert d2["marked"] == 0
            assert d2["amount_cents"] == 0
        finally:
            _cleanup_earnings(ids)


# ------------------------------------------------------------------
# 6. Reverse payout
# ------------------------------------------------------------------
class TestReversePayout:
    def test_reverse_flow(self, admin_headers, pro_user_id, client_user_id):
        ids = _seed_accrued(pro_user_id, client_user_id, [999])
        eid = ids[0]
        try:
            # Mark paid
            requests.post(f"{API}/admin/affiliate/payouts/mark-paid",
                          headers=admin_headers,
                          json={"referrer_user_id": pro_user_id,
                                "earning_ids": [eid],
                                "external_ref": "REV-TEST"}, timeout=10)
            # Reverse
            r = requests.post(
                f"{API}/admin/affiliate/payouts/{eid}/reverse",
                headers=admin_headers,
                json={"reason": "bounced check"}, timeout=10)
            assert r.status_code == 200, r.text
            assert r.json()["reversed"] == eid

            # Verify status is back to accrued & fields unset & log push
            from db import db
            async def _fetch():
                return await db.referral_earnings.find_one({"id": eid})
            row = _loop().run_until_complete(_fetch())
            assert row["status"] == "accrued"
            assert "paid_out_at" not in row
            assert "paid_out_by_user_id" not in row
            assert isinstance(row.get("reversal_log"), list)
            assert len(row["reversal_log"]) == 1
            assert row["reversal_log"][0]["reason"] == "bounced check"
            assert row["reversal_log"][0].get("reversed_by_user_id")
            assert row["reversal_log"][0].get("reversed_at")
        finally:
            _cleanup_earnings(ids)

    def test_reverse_accrued_row_400(self, admin_headers, pro_user_id, client_user_id):
        ids = _seed_accrued(pro_user_id, client_user_id, [222])
        try:
            r = requests.post(
                f"{API}/admin/affiliate/payouts/{ids[0]}/reverse",
                headers=admin_headers, json={"reason": "oops"}, timeout=10)
            assert r.status_code == 400
        finally:
            _cleanup_earnings(ids)

    def test_reverse_unknown_id_404(self, admin_headers):
        r = requests.post(
            f"{API}/admin/affiliate/payouts/nonexistent-earning-xyz/reverse",
            headers=admin_headers, json={"reason": "x"}, timeout=10)
        assert r.status_code == 404


# ------------------------------------------------------------------
# 7. History endpoint
# ------------------------------------------------------------------
class TestHistory:
    def test_history_shape_and_sort(self, admin_headers):
        r = requests.get(f"{API}/admin/affiliate/history",
                         headers=admin_headers,
                         params={"limit": 5}, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "batches" in d and isinstance(d["batches"], list)
        assert len(d["batches"]) <= 5
        if d["batches"]:
            b = d["batches"][0]
            for k in ("id", "paid_at", "amount_cents", "invoice_count",
                      "referrer", "paid_by", "external_ref", "note"):
                assert k in b
            for k in ("user_id", "email", "name"):
                assert k in b["referrer"]
                assert k in b["paid_by"]
            # sort check
            paid_ats = [x["paid_at"] for x in d["batches"] if x["paid_at"]]
            assert paid_ats == sorted(paid_ats, reverse=True)

    def test_history_forbidden_for_pro(self, pro_headers):
        r = requests.get(f"{API}/admin/affiliate/history",
                         headers=pro_headers, timeout=10)
        assert r.status_code == 403
