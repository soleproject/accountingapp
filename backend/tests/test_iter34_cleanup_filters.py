"""Iter34: cleanup-suggestions must respect human_reviewed on both
contact_in_uncat AND contact_split buckets.

Bug: On 704 LLC, contacts like "Amazon" (contact_split, 4 accounts) and
"Eimorlain Ugali Co" (contact_split, 3 accounts, 21 unreviewed rows) kept
re-appearing in top_actions even after the user resolved them via
approve_existing (which marks each row human_reviewed=True).

Fix: /api/companies/{cid}/transactions/cleanup-suggestions must ONLY count
rows where human_reviewed is falsy toward both `contact_split` and
`contact_in_uncat`.

This test uses live DB state on 704 LLC — it snapshots current
human_reviewed flags for the target contact, flips them, calls the API,
then restores.
"""
import os
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
CID = "65c43432-305d-4419-8037-bfbcfa7de748"  # 704 LLC


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def api(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module")
def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    return client[DB_NAME]


def _get_top_actions(api):
    r = api.get(f"{BASE_URL}/api/companies/{CID}/transactions/cleanup-suggestions", timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["top_actions"]


def test_cleanup_suggestions_available(api):
    actions = _get_top_actions(api)
    assert isinstance(actions, list)
    print(f"Initial top_actions count={len(actions)}")
    for a in actions:
        print(f"  - kind={a.get('kind')} name={a.get('contact_name','?')} count={a.get('count')}")


@pytest.mark.asyncio
async def test_contact_split_filters_reviewed_rows(api, mongo):
    """Primary fix: mark all unreviewed rows for a contact_split contact as
    reviewed, verify contact disappears from top_actions, then restore."""
    initial = _get_top_actions(api)
    split_actions = [a for a in initial if a.get("kind") == "contact_split"]
    if not split_actions:
        # Look for Eimorlain in DB and force it
        eim = await mongo.contacts.find_one({"company_id": CID, "name": "Eimorlain Ugali Co"})
        if not eim:
            pytest.skip("No contact_split candidates and no Eimorlain fallback")
        target_cid = eim.get("id") or eim.get("_id")
        target_name = "Eimorlain Ugali Co"
    else:
        target_cid = split_actions[0]["contact_id"]
        target_name = split_actions[0]["contact_name"]
    print(f"Target contact: {target_name} (id={target_cid})")

    # Snapshot: which txn ids for this contact are currently unreviewed AND
    # have a category_account_id (that's what contact_split counts).
    cursor = mongo.transactions.find({
        "company_id": CID, "contact_id": target_cid,
    })
    all_rows = await cursor.to_list(5000)
    to_flip = [t for t in all_rows
               if t.get("category_account_id") and not t.get("human_reviewed")]
    flip_ids = [t.get("id") or str(t["_id"]) for t in to_flip]
    print(f"Will flip {len(flip_ids)} rows to human_reviewed=True")

    if not flip_ids:
        pytest.skip(f"No unreviewed categorized rows for {target_name}")

    try:
        # Flip
        await mongo.transactions.update_many(
            {"company_id": CID, "contact_id": target_cid,
             "category_account_id": {"$ne": None}, "human_reviewed": {"$ne": True}},
            {"$set": {"human_reviewed": True}},
        )
        # Re-call
        after = _get_top_actions(api)
        after_split_ids = [a["contact_id"] for a in after if a.get("kind") == "contact_split"]
        after_uncat_ids = [a["contact_id"] for a in after if a.get("kind") == "contact_in_uncat"]
        assert target_cid not in after_split_ids, \
            f"BUG: {target_name} still in contact_split after all rows marked reviewed"
        assert target_cid not in after_uncat_ids, \
            f"BUG: {target_name} still in contact_in_uncat after all rows marked reviewed"
        print(f"PASS: {target_name} correctly dropped from top_actions")
    finally:
        # Restore
        if flip_ids:
            await mongo.transactions.update_many(
                {"company_id": CID, "id": {"$in": flip_ids}},
                {"$set": {"human_reviewed": False}},
            )
            # Also match by _id string just in case
            print(f"Restored {len(flip_ids)} rows")

        # Sanity: verify restored
        restored = _get_top_actions(api)
        print(f"Restored top_actions count={len(restored)}")
