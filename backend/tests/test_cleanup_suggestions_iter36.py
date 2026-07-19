"""Iter36: Cleanup Copilot auto-advance fixes — backend side.

Tests:
- top_actions cap raised to 50 (was 8)
- top_actions sorted by count DESC across kinds
- flagged_batch pinned last (or absent if flagged==0)
- Regression: >=3 threshold, only unreviewed rows, flagged included when >0
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

client = MongoClient(MONGO_URL)
db = client[DB_NAME]

SEED_TAG = f"ITER36_{uuid.uuid4().hex[:6]}"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": PRO_EMAIL, "password": PRO_PASS})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def test_cid(headers):
    """Pick a company owned by pro user for seeding. Use 704 LLC if visible, else first."""
    r = requests.get(f"{BASE_URL}/api/companies", headers=headers)
    assert r.status_code == 200
    companies = r.json() if isinstance(r.json(), list) else r.json().get("companies", [])
    assert companies, "no companies"
    # Prefer 704 LLC
    preferred = "65c43432-305d-4419-8037-bfbcfa7de748"
    ids = [c["id"] for c in companies]
    return preferred if preferred in ids else companies[0]["id"]


@pytest.fixture(scope="module")
def seeded(test_cid):
    """Seed 12 synthetic contacts with varying tx counts (5..16) uncategorized,
    plus 3 contacts with split-by-contact drift (3+ distinct categories,
    unreviewed). Also ensure some flagged rows exist."""
    cid = test_cid
    # Grab a couple category account ids for the split contacts.
    accts = list(db.accounts.find({"company_id": cid}).limit(20))
    # pick 4 non-uncategorized accts
    real_accts = [a for a in accts if a.get("code") not in ("9999", "4999")][:4]
    assert len(real_accts) >= 3, "need 3+ real accounts to build split scenario"

    contact_docs = []
    txn_docs = []

    # 12 uncat contacts — counts 5..16
    for i in range(12):
        cname = f"{SEED_TAG}_UNCAT_{i:02d}"
        cid_key = str(uuid.uuid4())
        contact_docs.append({
            "id": cid_key, "company_id": cid, "name": cname,
            "normalized_name": cname.lower(),
            "kind": "vendor", "seed_tag": SEED_TAG,
        })
        n = 5 + i  # 5,6,7,...,16
        for j in range(n):
            txn_docs.append({
                "id": str(uuid.uuid4()), "company_id": cid,
                "date": "2025-06-15",
                "description": f"{cname} txn {j}",
                "merchant": cname,
                "amount": -(10.0 + j),
                "bank_account_id": None,
                "category_account_id": None,
                "category_account_code": None,
                "category_account_name": None,
                "contact_id": cid_key,
                "contact_name": cname,
                "needs_review": True,
                "human_reviewed": False,
                "posted": False,
                "seed_tag": SEED_TAG,
            })

    # 3 split-by-contact contacts (each with 3-5 distinct categories,
    # 1 unreviewed txn per category)
    for i in range(3):
        cname = f"{SEED_TAG}_SPLIT_{i:02d}"
        cid_key = str(uuid.uuid4())
        contact_docs.append({
            "id": cid_key, "company_id": cid, "name": cname,
            "normalized_name": cname.lower(),
            "kind": "vendor", "seed_tag": SEED_TAG,
        })
        n_cats = 3 + i  # 3,4,5
        for k in range(n_cats):
            a = real_accts[k % len(real_accts)]
            txn_docs.append({
                "id": str(uuid.uuid4()), "company_id": cid,
                "date": "2025-06-15",
                "description": f"{cname} split txn {k}",
                "merchant": cname,
                "amount": -(50.0 + k),
                "bank_account_id": None,
                "category_account_id": a["id"],
                "category_account_code": a["code"],
                "category_account_name": a["name"],
                "contact_id": cid_key,
                "contact_name": cname,
                "needs_review": False,
                "human_reviewed": False,
                "posted": True,
                "seed_tag": SEED_TAG,
            })

    # One below-threshold contact (2 rows) - should NOT show up
    cname = f"{SEED_TAG}_BELOW"
    below_cid = str(uuid.uuid4())
    contact_docs.append({"id": below_cid, "company_id": cid, "name": cname, "normalized_name": cname.lower(), "seed_tag": SEED_TAG})
    for j in range(2):
        txn_docs.append({
            "id": str(uuid.uuid4()), "company_id": cid, "date": "2025-06-15",
            "description": cname, "merchant": cname, "amount": -5.0,
            "category_account_id": None,
            "contact_id": below_cid, "contact_name": cname,
            "needs_review": True, "human_reviewed": False, "posted": False,
            "seed_tag": SEED_TAG,
        })

    # A flagged row (needs_review True)
    txn_docs.append({
        "id": str(uuid.uuid4()), "company_id": cid, "date": "2025-06-15",
        "description": f"{SEED_TAG}_FLAG", "merchant": f"{SEED_TAG}_FLAG",
        "amount": -99.0, "category_account_id": None,
        "contact_id": None, "contact_name": None,
        "needs_review": True, "human_reviewed": False, "posted": False,
        "seed_tag": SEED_TAG,
    })

    if contact_docs:
        db.contacts.insert_many(contact_docs)
    if txn_docs:
        db.transactions.insert_many(txn_docs)

    yield {"cid": cid, "n_uncat_contacts": 12, "n_split_contacts": 3}

    # Cleanup
    db.contacts.delete_many({"seed_tag": SEED_TAG})
    db.transactions.delete_many({"seed_tag": SEED_TAG})


def _get_suggestions(cid, headers):
    r = requests.get(
        f"{BASE_URL}/api/companies/{cid}/transactions/cleanup-suggestions",
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestCleanupSuggestions:
    def test_cap_raised_to_50(self, seeded, headers):
        data = _get_suggestions(seeded["cid"], headers)
        actions = data["top_actions"]
        assert len(actions) <= 50
        # We seeded 12 uncat + 3 split = 15 contact-scoped actions minimum.
        contact_scoped = [a for a in actions if a["kind"] in ("contact_in_uncat", "contact_split")]
        # Some may pre-exist too. But we need at least 15.
        seed_uncat = [a for a in actions if a.get("contact_name", "").startswith(f"{SEED_TAG}_UNCAT")]
        seed_split = [a for a in actions if a.get("contact_name", "").startswith(f"{SEED_TAG}_SPLIT")]
        assert len(seed_uncat) == 12, f"expected 12 seeded uncat contacts, got {len(seed_uncat)}: {[a['contact_name'] for a in seed_uncat]}"
        assert len(seed_split) == 3, f"expected 3 seeded split contacts, got {len(seed_split)}"
        assert len(contact_scoped) >= 15

    def test_sorted_by_count_desc_across_kinds(self, seeded, headers):
        data = _get_suggestions(seeded["cid"], headers)
        actions = data["top_actions"]
        # Exclude flagged_batch (pinned last)
        ranked = [a for a in actions if a["kind"] != "flagged_batch"]
        counts = [a["count"] for a in ranked]
        assert counts == sorted(counts, reverse=True), f"not desc: {counts}"

    def test_flagged_batch_pinned_last(self, seeded, headers):
        data = _get_suggestions(seeded["cid"], headers)
        actions = data["top_actions"]
        flagged_idx = [i for i, a in enumerate(actions) if a["kind"] == "flagged_batch"]
        # There is a seeded flag, so it should be present
        assert flagged_idx, "flagged_batch should be present since flagged > 0"
        assert flagged_idx[0] == len(actions) - 1, "flagged_batch must be last"

    def test_threshold_and_unreviewed_filter(self, seeded, headers):
        data = _get_suggestions(seeded["cid"], headers)
        actions = data["top_actions"]
        # The 2-row BELOW contact must NOT appear
        below_present = any(a.get("contact_name", "").endswith("_BELOW") for a in actions)
        assert not below_present, "below-threshold contact leaked into top_actions"
        # Every contact_in_uncat/contact_split must have count >= 3
        for a in actions:
            if a["kind"] in ("contact_in_uncat", "contact_split"):
                assert a["count"] >= 3

    def test_progress_shape(self, seeded, headers):
        data = _get_suggestions(seeded["cid"], headers)
        prog = data["progress"]
        for k in ("total", "reviewed", "ai_categorized", "uncategorized", "flagged", "pct_reviewed"):
            assert k in prog
        assert prog["flagged"] >= 1
