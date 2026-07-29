"""Iter 48 — Orphan memberships admin lens (superadmin data-drift review).

Covers:
  * GET /api/admin/orphan-memberships shape + auth gating (200/403/401).
  * duplicate_memberships detection + POST /purge-duplicates cleanup.
  * role_mismatch_client_but_pro detection + POST /fix-role-drift elevation.
  * multi_firm_staff detection using two disjoint firm partitions.
  * dangling_archived detection via POST /api/pro/staff/{uid}/archive.

All seeded data is prefixed TEST_iter48_ and cleaned up in teardown.
"""
import os
import uuid
import datetime as dt

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

_mc = MongoClient(MONGO_URL)
_db = _mc[DB_NAME]


def _now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


def H(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin@axiom.ai", "admin123")


@pytest.fixture(scope="module")
def pro_token():
    return _login("pro@axiom.ai", "pro123")


# --------------------------------------------------------------------------
# 1. Shape + auth gating
# --------------------------------------------------------------------------
REPORT_KEYS = [
    "generated_at", "totals",
    "multi_firm_staff", "role_mismatch_client_but_pro",
    "role_mismatch_pro_but_no_pro_ms", "dangling_archived",
    "duplicate_memberships",
]
TOTAL_KEYS = [
    "multi_firm_staff", "role_mismatch_client_but_pro",
    "role_mismatch_pro_but_no_pro_ms", "dangling_archived",
    "duplicate_memberships",
]


def test_report_shape_admin(admin_token):
    r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                     headers=H(admin_token), timeout=30)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    for k in REPORT_KEYS:
        assert k in body, f"missing key {k}"
    assert isinstance(body["generated_at"], str)
    assert isinstance(body["totals"], dict)
    for tk in TOTAL_KEYS:
        assert tk in body["totals"]
        assert isinstance(body["totals"][tk], int)
    for k in REPORT_KEYS:
        if k in ("generated_at", "totals"):
            continue
        assert isinstance(body[k], list), f"{k} must be list (possibly empty)"


def test_report_forbidden_for_pro(pro_token):
    r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                     headers=H(pro_token), timeout=15)
    assert r.status_code == 403, f"pro should be forbidden, got {r.status_code}"


def test_report_unauthorized_anonymous():
    r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships", timeout=15)
    assert r.status_code == 401, f"anonymous should be 401, got {r.status_code}"


def test_purge_duplicates_forbidden_for_pro(pro_token):
    r = requests.post(f"{BASE_URL}/api/admin/orphan-memberships/purge-duplicates",
                      headers=H(pro_token), timeout=15)
    assert r.status_code == 403


def test_fix_role_drift_forbidden_for_pro(pro_token):
    r = requests.post(f"{BASE_URL}/api/admin/orphan-memberships/fix-role-drift",
                      headers=H(pro_token), timeout=15)
    assert r.status_code == 403


# --------------------------------------------------------------------------
# 2. duplicate_memberships + purge
# --------------------------------------------------------------------------
def test_duplicate_detection_and_purge(admin_token):
    """Seed 2 duplicate rows on an existing (user_id, company_id, role)
    triple; verify report picks them up, purge, verify empty."""
    # Pick an existing pro membership to duplicate.
    existing = _db.memberships.find_one({"role": "pro"})
    assert existing, "no pro membership present to duplicate"
    uid, cid, role = existing["user_id"], existing["company_id"], existing["role"]

    seeded_ids = []
    for _ in range(2):
        doc = {
            "id": f"TEST_iter48_{uuid.uuid4().hex}",
            "user_id": uid,
            "company_id": cid,
            "role": role,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        _db.memberships.insert_one(doc)
        seeded_ids.append(doc["id"])

    try:
        r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                         headers=H(admin_token), timeout=30).json()
        dups = r["duplicate_memberships"]
        match = [d for d in dups if d["user_id"] == uid and d["company_id"] == cid and d["role"] == role]
        assert match, f"expected duplicate row for ({uid},{cid},{role}) not found; dups={dups}"
        assert match[0]["count"] >= 2

        pr = requests.post(f"{BASE_URL}/api/admin/orphan-memberships/purge-duplicates",
                           headers=H(admin_token), timeout=30)
        assert pr.status_code == 200
        pj = pr.json()
        assert "kept" in pj and "deleted" in pj
        assert pj["deleted"] >= 1, f"expected deleted>=1, got {pj}"
        assert isinstance(pj["kept"], int) and pj["kept"] >= 1

        r2 = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                          headers=H(admin_token), timeout=30).json()
        dups2 = [d for d in r2["duplicate_memberships"]
                 if d["user_id"] == uid and d["company_id"] == cid and d["role"] == role]
        assert not dups2, f"duplicate still present after purge: {dups2}"

        # Idempotency: 2nd purge deletes 0.
        pr2 = requests.post(f"{BASE_URL}/api/admin/orphan-memberships/purge-duplicates",
                            headers=H(admin_token), timeout=30).json()
        assert pr2["deleted"] == 0, f"purge not idempotent: {pr2}"
    finally:
        _db.memberships.delete_many({"id": {"$in": seeded_ids}})


# --------------------------------------------------------------------------
# 3. role_mismatch_client_but_pro + fix-role-drift
# --------------------------------------------------------------------------
def test_role_drift_detected_and_fixed(admin_token):
    """Flip a pro user to role='client' while leaving their pro
    memberships active — report should flag them; fix endpoint should
    elevate them back to pro."""
    # pro@axiom.ai has active pro memberships — perfect candidate.
    victim = _db.users.find_one({"email": "pro@axiom.ai"})
    assert victim, "pro@axiom.ai not present in DB"
    original_role = victim["role"]
    uid = victim["id"]

    _db.users.update_one({"id": uid}, {"$set": {"role": "client"}})
    try:
        r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                         headers=H(admin_token), timeout=30).json()
        drift = r["role_mismatch_client_but_pro"]
        assert any(x["user_id"] == uid for x in drift), \
            f"expected {uid} in role_mismatch_client_but_pro; got {drift}"

        fx = requests.post(f"{BASE_URL}/api/admin/orphan-memberships/fix-role-drift",
                           headers=H(admin_token), timeout=30)
        assert fx.status_code == 200
        fj = fx.json()
        assert "elevated" in fj and fj["elevated"] >= 1, f"expected elevated>=1, got {fj}"

        r2 = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                          headers=H(admin_token), timeout=30).json()
        assert not any(x["user_id"] == uid for x in r2["role_mismatch_client_but_pro"]), \
            "victim still flagged after fix-role-drift"

        # And user is now `pro` again in DB.
        after = _db.users.find_one({"id": uid})
        assert after["role"] == "pro"
    finally:
        _db.users.update_one({"id": uid}, {"$set": {"role": original_role}})


# --------------------------------------------------------------------------
# 4. multi_firm_staff (two disjoint firm partitions)
# --------------------------------------------------------------------------
def test_multi_firm_staff_detection(admin_token):
    """Create two brand-new companies each anchored by a *different*
    exclusive pro (no shared pros ⇒ two disjoint firm partitions).
    Add a third user with pro memberships on BOTH — must show up in
    multi_firm_staff with firm_count>=2."""
    # Seed pros + companies + memberships.
    pro_a = {"id": f"TEST_iter48_pa_{uuid.uuid4().hex}",
             "email": f"TEST_iter48_pa_{uuid.uuid4().hex[:8]}@example.com",
             "name": "TEST_iter48 Pro A", "role": "pro",
             "created_at": _now_iso()}
    pro_b = {"id": f"TEST_iter48_pb_{uuid.uuid4().hex}",
             "email": f"TEST_iter48_pb_{uuid.uuid4().hex[:8]}@example.com",
             "name": "TEST_iter48 Pro B", "role": "pro",
             "created_at": _now_iso()}
    victim = {"id": f"TEST_iter48_vic_{uuid.uuid4().hex}",
              "email": f"TEST_iter48_vic_{uuid.uuid4().hex[:8]}@example.com",
              "name": "TEST_iter48 Victim", "role": "pro",
              "created_at": _now_iso()}
    co_a = {"id": f"TEST_iter48_ca_{uuid.uuid4().hex}",
            "name": "TEST_iter48 Co A", "created_at": _now_iso()}
    co_b = {"id": f"TEST_iter48_cb_{uuid.uuid4().hex}",
            "name": "TEST_iter48 Co B", "created_at": _now_iso()}

    _db.users.insert_many([pro_a, pro_b, victim])
    _db.companies.insert_many([co_a, co_b])

    ms_docs = [
        # Pro A anchors company A only.
        {"id": f"TEST_iter48_m_{uuid.uuid4().hex}", "user_id": pro_a["id"],
         "company_id": co_a["id"], "role": "pro", "created_at": _now_iso()},
        # Pro B anchors company B only.
        {"id": f"TEST_iter48_m_{uuid.uuid4().hex}", "user_id": pro_b["id"],
         "company_id": co_b["id"], "role": "pro", "created_at": _now_iso()},
        # Victim is a pro on BOTH.
        {"id": f"TEST_iter48_m_{uuid.uuid4().hex}", "user_id": victim["id"],
         "company_id": co_a["id"], "role": "pro", "created_at": _now_iso()},
        {"id": f"TEST_iter48_m_{uuid.uuid4().hex}", "user_id": victim["id"],
         "company_id": co_b["id"], "role": "pro", "created_at": _now_iso()},
    ]
    _db.memberships.insert_many(ms_docs)

    try:
        r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                         headers=H(admin_token), timeout=30).json()
        mfs = [x for x in r["multi_firm_staff"] if x["user_id"] == victim["id"]]
        assert mfs, f"victim not in multi_firm_staff; got users {[m['user_id'] for m in r['multi_firm_staff']]}"
        row = mfs[0]
        assert row["firm_count"] >= 2
        assert row["email"] == victim["email"]
        cids = {c["id"] for c in row["companies"]}
        assert co_a["id"] in cids and co_b["id"] in cids
    finally:
        _db.memberships.delete_many({"id": {"$in": [m["id"] for m in ms_docs]}})
        _db.companies.delete_many({"id": {"$in": [co_a["id"], co_b["id"]]}})
        _db.users.delete_many({"id": {"$in": [pro_a["id"], pro_b["id"], victim["id"]]}})


# --------------------------------------------------------------------------
# 5. dangling_archived via /pro/staff/{uid}/archive
# --------------------------------------------------------------------------
def test_dangling_archived_via_archive_endpoint(admin_token, pro_token):
    """Archive an existing firm-staff via the pro API — report should
    surface the archived membership with company_name and archived_at
    populated. Unarchive to restore."""
    # Find a firm-staff of pro@axiom.ai (a pro user, not pro@axiom.ai
    # themselves) with an active pro membership on one of pro's clients.
    pro_user = _db.users.find_one({"email": "pro@axiom.ai"})
    assert pro_user
    my_ms = list(_db.memberships.find({"user_id": pro_user["id"], "role": "pro"}))
    my_cids = [m["company_id"] for m in my_ms]

    # Find another pro-role membership on any of pro's client companies,
    # for a user that is NOT pro@axiom.ai and NOT archived.
    staff_ms = _db.memberships.find_one({
        "role": "pro",
        "company_id": {"$in": my_cids},
        "user_id": {"$ne": pro_user["id"]},
        "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}],
    })
    if not staff_ms:
        pytest.skip("no active firm-staff under pro@axiom.ai to archive")

    staff_uid = staff_ms["user_id"]
    staff_cid = staff_ms["company_id"]

    ar = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/archive",
                       headers=H(pro_token), timeout=15)
    assert ar.status_code == 200, ar.text[:300]
    assert ar.json().get("archived", 0) >= 1

    try:
        r = requests.get(f"{BASE_URL}/api/admin/orphan-memberships",
                         headers=H(admin_token), timeout=30).json()
        matches = [d for d in r["dangling_archived"]
                   if d["user_id"] == staff_uid and d["company_id"] == staff_cid]
        assert matches, f"archived membership not surfaced; dangling={r['dangling_archived']}"
        row = matches[0]
        assert row["company_name"], "company_name should be populated"
        assert row["archived_at"], "archived_at should be populated"
        assert row["role"] == "pro"
    finally:
        # Restore.
        requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/unarchive",
                      headers=H(pro_token), timeout=15)
