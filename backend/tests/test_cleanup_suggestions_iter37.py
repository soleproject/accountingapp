"""Iter37: contact_ai_ready action — surfaces contacts whose AI-categorized
unreviewed rows land all in the same account, so the user can bulk-approve
in one tap.

Tests:
- contact_ai_ready appears when a contact has >= 3 AI-cat'd unreviewed rows
  in a single account (and no contact_in_uncat/contact_split conflict).
- Adaptive threshold: falls to >=2 when total contact-scoped actions < 5.
- Deduped against contact_in_uncat / contact_split (no vendor appears twice).
- 812 LLC (if visible) returns many top_actions incl. contact_ai_ready kinds.
- Shape: {kind, contact_id, contact_name, count, total_amount, account:{id,code,name}, label, why}
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

SEED_TAG = f"ITER37_{uuid.uuid4().hex[:6]}"


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
def companies(headers):
    r = requests.get(f"{BASE_URL}/api/companies", headers=headers)
    assert r.status_code == 200
    j = r.json()
    return j if isinstance(j, list) else j.get("companies", [])


@pytest.fixture(scope="module")
def test_cid(companies):
    assert companies, "no companies visible to pro user"
    return companies[0]["id"]


@pytest.fixture(scope="module")
def seeded_ai_ready(test_cid):
    """Seed one contact with 4 AI-categorized-unreviewed rows all in same account."""
    cid = test_cid
    accts = list(db.accounts.find({"company_id": cid}).limit(20))
    real = [a for a in accts if a.get("code") not in ("9999", "4999")]
    assert real, "need at least 1 real account"
    acct = real[0]

    cname = f"{SEED_TAG}_AIREADY"
    cid_key = str(uuid.uuid4())
    contact_doc = {
        "id": cid_key, "company_id": cid, "name": cname,
        "normalized_name": cname.lower(), "kind": "vendor",
        "seed_tag": SEED_TAG,
    }
    txns = []
    for j in range(4):
        txns.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": "2025-06-15", "description": f"{cname} {j}",
            "merchant": cname, "amount": -(20.0 + j),
            "bank_account_id": None,
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "contact_id": cid_key, "contact_name": cname,
            "needs_review": False, "human_reviewed": False,
            "posted": True, "seed_tag": SEED_TAG,
        })

    # Also seed a "conflict" contact — has BOTH uncat rows (>=3) AND AI-ready
    # rows (>=3). Must appear ONLY as contact_in_uncat, not contact_ai_ready.
    conflict_name = f"{SEED_TAG}_CONFLICT"
    conflict_key = str(uuid.uuid4())
    contact_doc2 = {
        "id": conflict_key, "company_id": cid, "name": conflict_name,
        "normalized_name": conflict_name.lower(), "kind": "vendor",
        "seed_tag": SEED_TAG,
    }
    for j in range(4):
        txns.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": "2025-06-15", "description": f"{conflict_name} uncat {j}",
            "merchant": conflict_name, "amount": -10.0,
            "category_account_id": None,
            "category_account_code": None,
            "category_account_name": None,
            "contact_id": conflict_key, "contact_name": conflict_name,
            "needs_review": True, "human_reviewed": False,
            "posted": False, "seed_tag": SEED_TAG,
        })
    for j in range(4):
        txns.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": "2025-06-15", "description": f"{conflict_name} ai {j}",
            "merchant": conflict_name, "amount": -15.0,
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "contact_id": conflict_key, "contact_name": conflict_name,
            "needs_review": False, "human_reviewed": False,
            "posted": True, "seed_tag": SEED_TAG,
        })

    db.contacts.insert_many([contact_doc, contact_doc2])
    db.transactions.insert_many(txns)

    yield {
        "cid": cid,
        "ai_ready_contact_id": cid_key,
        "ai_ready_name": cname,
        "conflict_contact_id": conflict_key,
        "conflict_name": conflict_name,
        "acct": {"id": acct["id"], "code": acct["code"], "name": acct["name"]},
    }

    db.contacts.delete_many({"seed_tag": SEED_TAG})
    db.transactions.delete_many({"seed_tag": SEED_TAG})


def _get(cid, headers):
    r = requests.get(
        f"{BASE_URL}/api/companies/{cid}/transactions/cleanup-suggestions",
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestContactAiReady:
    def test_ai_ready_action_appears(self, seeded_ai_ready, headers):
        data = _get(seeded_ai_ready["cid"], headers)
        actions = data["top_actions"]
        match = [a for a in actions
                 if a.get("kind") == "contact_ai_ready"
                 and a.get("contact_id") == seeded_ai_ready["ai_ready_contact_id"]]
        assert match, f"contact_ai_ready NOT found for seeded contact. Kinds seen: {set(a['kind'] for a in actions)}"
        a = match[0]
        # Shape
        assert a["contact_name"] == seeded_ai_ready["ai_ready_name"]
        assert a["count"] == 4
        assert "total_amount" in a and a["total_amount"] > 0
        assert "account" in a
        assert a["account"]["id"] == seeded_ai_ready["acct"]["id"]
        assert a["account"]["code"] == seeded_ai_ready["acct"]["code"]
        assert a["account"]["name"] == seeded_ai_ready["acct"]["name"]
        assert "label" in a and "why" in a

    def test_dedupe_against_contact_in_uncat(self, seeded_ai_ready, headers):
        """The CONFLICT vendor should surface as contact_in_uncat but NOT
        as contact_ai_ready (dedupe check)."""
        data = _get(seeded_ai_ready["cid"], headers)
        conflict_id = seeded_ai_ready["conflict_contact_id"]
        conflict_actions = [a for a in data["top_actions"]
                             if a.get("contact_id") == conflict_id]
        kinds = {a["kind"] for a in conflict_actions}
        assert "contact_in_uncat" in kinds, f"expected contact_in_uncat for conflict vendor, got {kinds}"
        assert "contact_ai_ready" not in kinds, f"conflict vendor was NOT deduped: {kinds}"

    def test_sort_order_and_shape(self, seeded_ai_ready, headers):
        data = _get(seeded_ai_ready["cid"], headers)
        actions = data["top_actions"]
        # All non-flagged actions sorted by count desc
        ranked = [a for a in actions if a["kind"] != "flagged_batch"]
        counts = [a["count"] for a in ranked]
        assert counts == sorted(counts, reverse=True)
        # Every contact_ai_ready has required fields
        for a in actions:
            if a["kind"] == "contact_ai_ready":
                assert a["contact_id"]
                assert a["count"] >= 2  # threshold could be adaptive
                assert a["account"] and a["account"].get("id")


class TestLargeCompany812:
    """Regression: verify 812 LLC (if visible) yields many contact_ai_ready
    top_actions, not just flagged_batch."""

    def test_812_llc_ai_ready_present(self, companies, headers):
        target = next((c for c in companies if "812" in c.get("name", "")), None)
        if not target:
            pytest.skip("812 LLC not visible to pro user")
        data = _get(target["id"], headers)
        actions = data["top_actions"]
        assert len(actions) > 1, f"812 LLC only has {len(actions)} actions (expected >1)"
        ai_ready = [a for a in actions if a["kind"] == "contact_ai_ready"]
        # Main agent reported top 10 are all contact_ai_ready
        assert len(ai_ready) >= 3, f"expected multiple contact_ai_ready on 812 LLC, got {len(ai_ready)}. Kinds: {[a['kind'] for a in actions[:15]]}"
        # Sanity on top entry
        top = ai_ready[0]
        assert top["count"] >= 3
        assert top["account"] and top["account"].get("code")
        print(f"812 LLC top ai_ready: {top['contact_name']} count={top['count']} acct={top['account']}")

    def test_812_llc_desc_sort(self, companies, headers):
        target = next((c for c in companies if "812" in c.get("name", "")), None)
        if not target:
            pytest.skip("812 LLC not visible")
        data = _get(target["id"], headers)
        ranked = [a for a in data["top_actions"] if a["kind"] != "flagged_batch"]
        counts = [a["count"] for a in ranked]
        assert counts == sorted(counts, reverse=True)
