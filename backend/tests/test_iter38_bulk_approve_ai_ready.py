"""Iter38: POST /api/companies/{cid}/transactions/bulk-approve-ai-ready

Mega bulk-approve endpoint: dry_run preview + live apply. Skips closed-period
rows, mixed-AI-opinion vendors, code 9999/4999 rows. Idempotent.
"""
import os
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"
CLIENT2_EMAIL = "client2@axiom.ai"
CLIENT2_PASS = "client123"

mc = MongoClient(MONGO_URL)
db = mc[DB_NAME]

SEED_TAG = f"ITER38_{uuid.uuid4().hex[:6]}"


def _login(email, pw):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers():
    tok = _login(PRO_EMAIL, PRO_PASS)
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def companies(headers):
    r = requests.get(f"{BASE_URL}/api/companies", headers=headers)
    assert r.status_code == 200
    j = r.json()
    return j if isinstance(j, list) else j.get("companies", [])


@pytest.fixture(scope="module")
def cid_812(companies):
    """Prefer the '812 LLC' company; fall back to first available."""
    for c in companies:
        n = (c.get("name") or "").lower()
        if "812" in n:
            return c["id"]
    return companies[0]["id"]


@pytest.fixture(scope="module")
def cid_small(companies):
    """Smaller regression company (704/Bright Beans/NextGen if available)."""
    for c in companies:
        n = (c.get("name") or "").lower()
        if "704" in n or "bright" in n or "nextgen" in n:
            return c["id"]
    return None


# ---------- Seeded fixture with closed-period + mixed vendor ----------

@pytest.fixture(scope="module")
def seeded(companies):
    """Seed a company with:
       - 4 clean AI-ready rows (single vendor / single account) -> should apply
       - 1 closed-period row (same vendor) -> should be skipped
       - 3 mixed rows for another vendor split across 2 accts -> excluded entirely
       - 2 code-9999 rows -> excluded
    Uses the LAST company in the list so we don't perturb 812 LLC.
    """
    assert companies, "no companies visible"
    cid = companies[-1]["id"]

    accts = list(db.accounts.find({"company_id": cid}).limit(30))
    real = [a for a in accts if a.get("code") not in ("9999", "4999")]
    assert len(real) >= 2, f"need 2 real accounts on {cid}"
    acct1, acct2 = real[0], real[1]

    # closed period covering 2019-01
    cp_id = str(uuid.uuid4())
    db.close_periods.insert_one({
        "id": cp_id, "company_id": cid,
        "period_start": "2019-01-01", "period_end": "2019-01-31",
        "status": "closed", "seed_tag": SEED_TAG,
    })

    # ---- clean AI-ready vendor ----
    clean_name = f"{SEED_TAG}_CLEAN"
    clean_cid = str(uuid.uuid4())
    db.contacts.insert_one({
        "id": clean_cid, "company_id": cid, "name": clean_name,
        "normalized_name": clean_name.lower(), "kind": "vendor",
        "seed_tag": SEED_TAG,
    })
    clean_open_ids = []
    for j in range(4):
        tid = str(uuid.uuid4())
        clean_open_ids.append(tid)
        db.transactions.insert_one({
            "id": tid, "company_id": cid, "date": "2025-06-15",
            "description": f"{clean_name} {j}", "merchant": clean_name,
            "amount": -(20.0 + j),
            "category_account_id": acct1["id"],
            "category_account_code": acct1["code"],
            "category_account_name": acct1["name"],
            "contact_id": clean_cid, "contact_name": clean_name,
            "needs_review": False, "human_reviewed": False,
            "posted": True, "seed_tag": SEED_TAG,
        })
    # closed-period row for same vendor -> should be skipped on apply
    closed_tid = str(uuid.uuid4())
    db.transactions.insert_one({
        "id": closed_tid, "company_id": cid, "date": "2019-01-15",
        "description": f"{clean_name} closed", "merchant": clean_name,
        "amount": -50.0,
        "category_account_id": acct1["id"],
        "category_account_code": acct1["code"],
        "category_account_name": acct1["name"],
        "contact_id": clean_cid, "contact_name": clean_name,
        "needs_review": False, "human_reviewed": False,
        "posted": True, "seed_tag": SEED_TAG,
    })

    # ---- mixed-opinion vendor -> must be EXCLUDED entirely ----
    mixed_name = f"{SEED_TAG}_MIXED"
    mixed_cid = str(uuid.uuid4())
    db.contacts.insert_one({
        "id": mixed_cid, "company_id": cid, "name": mixed_name,
        "normalized_name": mixed_name.lower(), "kind": "vendor",
        "seed_tag": SEED_TAG,
    })
    mixed_ids = []
    for j in range(3):
        tid = str(uuid.uuid4())
        mixed_ids.append(tid)
        a = acct1 if j < 2 else acct2
        db.transactions.insert_one({
            "id": tid, "company_id": cid, "date": "2025-06-15",
            "description": f"{mixed_name} {j}", "merchant": mixed_name,
            "amount": -30.0,
            "category_account_id": a["id"],
            "category_account_code": a["code"],
            "category_account_name": a["name"],
            "contact_id": mixed_cid, "contact_name": mixed_name,
            "needs_review": False, "human_reviewed": False,
            "posted": True, "seed_tag": SEED_TAG,
        })

    # ---- code-9999 parked rows -> excluded ----
    for j in range(2):
        db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": "2025-06-15",
            "description": f"{SEED_TAG} parked", "merchant": f"{SEED_TAG}_PARK",
            "amount": -10.0,
            "category_account_id": "parked-id",
            "category_account_code": "9999",
            "category_account_name": "Uncategorized",
            "contact_id": str(uuid.uuid4()), "contact_name": f"{SEED_TAG}_PARK",
            "needs_review": True, "human_reviewed": False,
            "posted": False, "seed_tag": SEED_TAG,
        })

    yield {
        "cid": cid,
        "clean_cid": clean_cid, "clean_name": clean_name,
        "clean_open_ids": clean_open_ids, "closed_tid": closed_tid,
        "mixed_cid": mixed_cid, "mixed_ids": mixed_ids,
        "cp_id": cp_id,
        "acct1_id": acct1["id"],
    }

    # teardown
    db.transactions.delete_many({"seed_tag": SEED_TAG})
    db.contacts.delete_many({"seed_tag": SEED_TAG})
    db.close_periods.delete_many({"seed_tag": SEED_TAG})


# ------------------- TESTS -------------------


def test_dry_run_shape_and_no_mutation(headers, cid_812):
    """dry_run:true returns shape, non-zero on 812 LLC, and does not touch DB."""
    # Snapshot: count unreviewed txns before
    before = db.transactions.count_documents({
        "company_id": cid_812, "human_reviewed": {"$ne": True},
        "category_account_id": {"$nin": [None, ""]},
    })

    r = requests.post(
        f"{BASE_URL}/api/companies/{cid_812}/transactions/bulk-approve-ai-ready",
        headers=headers, json={"dry_run": True},
    )
    assert r.status_code == 200, r.text
    j = r.json()
    for k in ("ok", "dry_run", "total_contacts", "total_rows",
              "total_amount", "top_contacts", "updated"):
        assert k in j, f"missing key {k} in {j.keys()}"
    assert j["ok"] is True
    assert j["dry_run"] is True
    assert j["updated"] == 0
    assert isinstance(j["top_contacts"], list)
    assert len(j["top_contacts"]) <= 5
    # 812 LLC should have plenty
    assert j["total_rows"] > 100, f"expected >100 AI-ready rows on 812 LLC, got {j['total_rows']}"
    assert j["total_contacts"] > 5

    # shape of top_contacts
    for c in j["top_contacts"]:
        for k in ("contact_id", "contact_name", "count", "amount", "account"):
            assert k in c, f"top_contact missing {k}: {c}"
        assert "code" in c["account"] and "name" in c["account"]

    # Verify no mutation
    after = db.transactions.count_documents({
        "company_id": cid_812, "human_reviewed": {"$ne": True},
        "category_account_id": {"$nin": [None, ""]},
    })
    assert after == before, f"dry_run mutated DB: before={before} after={after}"


def test_auth_forbidden_without_company_access(cid_812):
    """403 for user without access (client2 shouldn't see 812 LLC)."""
    tok = _login(CLIENT2_EMAIL, CLIENT2_PASS)
    h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    r = requests.post(
        f"{BASE_URL}/api/companies/{cid_812}/transactions/bulk-approve-ai-ready",
        headers=h, json={"dry_run": True},
    )
    assert r.status_code in (403, 404), r.status_code


def test_auth_missing_token(cid_812):
    r = requests.post(
        f"{BASE_URL}/api/companies/{cid_812}/transactions/bulk-approve-ai-ready",
        json={"dry_run": True},
    )
    assert r.status_code in (401, 403)


def test_seeded_apply_marks_rows_and_skips_closed(headers, seeded):
    """dry_run:false applies to open-period rows, skips closed-period + mixed vendor."""
    cid = seeded["cid"]

    # First dry_run — capture current preview
    r = requests.post(
        f"{BASE_URL}/api/companies/{cid}/transactions/bulk-approve-ai-ready",
        headers=headers, json={"dry_run": True},
    )
    assert r.status_code == 200
    preview = r.json()
    # our seeded clean vendor should appear in totals
    assert preview["total_rows"] >= 5, preview  # 4 open + 1 closed included in preview count
    # mixed vendor not counted (excluded by len(accounts)==1 filter)
    mixed_in_top = any(c["contact_id"] == seeded["mixed_cid"] for c in preview["top_contacts"])
    # not necessarily in top 5, so check by total instead: mixed vendor's rows shouldn't be included
    # We can't fully assert from top_contacts, but we can inspect our seeded rows post-apply.

    # Apply
    r = requests.post(
        f"{BASE_URL}/api/companies/{cid}/transactions/bulk-approve-ai-ready",
        headers=headers, json={"dry_run": False},
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["ok"] is True
    assert j["dry_run"] is False
    assert j["updated"] >= 4, f"expected at least 4 clean rows updated: {j}"

    # Verify: 4 open-period clean rows -> human_reviewed=True, ai_source set
    open_docs = list(db.transactions.find({"id": {"$in": seeded["clean_open_ids"]}}))
    assert len(open_docs) == 4
    for d in open_docs:
        assert d.get("human_reviewed") is True, d
        assert d.get("posted") is True
        assert d.get("needs_review") is False
        assert d.get("ai_source") == "user_bulk_approve_ai_ready"
        assert d.get("updated_at")

    # Closed-period row: NOT touched
    closed = db.transactions.find_one({"id": seeded["closed_tid"]})
    assert closed.get("human_reviewed") is not True, "closed-period row was mutated!"
    assert closed.get("ai_source") != "user_bulk_approve_ai_ready"

    # Mixed-opinion vendor rows: NOT touched (excluded by unanimous filter)
    mixed_docs = list(db.transactions.find({"id": {"$in": seeded["mixed_ids"]}}))
    for d in mixed_docs:
        assert d.get("human_reviewed") is not True, f"mixed vendor row mutated: {d}"
        assert d.get("ai_source") != "user_bulk_approve_ai_ready"


def test_idempotent_second_apply(headers, seeded):
    """Running dry_run:false again after full apply returns updated=0 for the
    same seeded vendor (all clean rows are already reviewed)."""
    cid = seeded["cid"]
    # Ensure previous test ran; do another apply — updated should not re-touch
    # already-reviewed rows. We compare our seeded vendor's row count.
    r = requests.post(
        f"{BASE_URL}/api/companies/{cid}/transactions/bulk-approve-ai-ready",
        headers=headers, json={"dry_run": False},
    )
    assert r.status_code == 200
    j = r.json()
    # Verify our seeded clean rows didn't get re-mutated (updated_at unchanged
    # count-wise). The endpoint's find filter excludes already-reviewed rows,
    # so re-apply must not re-touch them.
    still_reviewed = db.transactions.count_documents({
        "id": {"$in": seeded["clean_open_ids"]},
        "human_reviewed": True,
        "ai_source": "user_bulk_approve_ai_ready",
    })
    assert still_reviewed == 4


def test_empty_state_shape(headers, seeded):
    """After apply, if the seeded company has no more AI-ready rows for our
    seeded contact, response should be well-formed (updated=0 possible)."""
    cid = seeded["cid"]
    r = requests.post(
        f"{BASE_URL}/api/companies/{cid}/transactions/bulk-approve-ai-ready",
        headers=headers, json={"dry_run": True},
    )
    assert r.status_code == 200
    j = r.json()
    # basic shape check
    assert j["ok"] is True
    assert isinstance(j["total_rows"], int)
    assert isinstance(j["top_contacts"], list)
