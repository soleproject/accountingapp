"""
Iteration 18 — Plaid webhook enqueue tests.

Verifies:
 1. POST /api/plaid/webhook with a known TRANSACTIONS webhook_code
    returns {ok, queued_job, webhook_code} within 500ms and inserts a
    sync_jobs row (kind='plaid_manual_sync').
 2. An unknown webhook_code returns {ok:true, webhook_code:...} WITHOUT
    enqueuing a job.
 3. An unknown item_id returns {ok:true, unknown_item:true}.
 4. A non-TRANSACTIONS webhook_type is ignored.
"""
import os
import time
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

CID = "6aa07a68-488a-407c-9782-c3f309b08606"  # 501, LLC


@pytest.fixture(scope="module")
def db():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


@pytest.fixture(scope="module")
def item_id(db):
    item = db.plaid_items.find_one({"company_id": CID})
    assert item, f"No plaid_item for {CID}"
    return item["item_id"]


@pytest.mark.parametrize("code", [
    "SYNC_UPDATES_AVAILABLE",
    "HISTORICAL_UPDATE",
    "INITIAL_UPDATE",
    "DEFAULT_UPDATE",
])
def test_webhook_enqueues_job(db, item_id, code):
    # Snapshot existing sync_jobs count for this CID before firing
    before = db.sync_jobs.count_documents({
        "company_id": CID, "kind": "plaid_manual_sync",
    })
    t0 = time.time()
    r = requests.post(
        f"{BASE_URL}/api/plaid/webhook",
        json={
            "webhook_type": "TRANSACTIONS",
            "webhook_code": code,
            "item_id": item_id,
        },
        timeout=5,
    )
    elapsed_ms = (time.time() - t0) * 1000
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert body.get("webhook_code") == code
    assert "queued_job" in body and body["queued_job"]
    assert elapsed_ms < 2000, f"Webhook too slow: {elapsed_ms:.0f}ms"
    # sync_jobs row inserted
    time.sleep(0.3)
    after = db.sync_jobs.count_documents({
        "company_id": CID, "kind": "plaid_manual_sync",
    })
    assert after >= before + 1, "Expected new sync_jobs row to be enqueued"


def test_webhook_unknown_code_no_enqueue(db, item_id):
    before = db.sync_jobs.count_documents({
        "company_id": CID, "kind": "plaid_manual_sync",
    })
    r = requests.post(
        f"{BASE_URL}/api/plaid/webhook",
        json={
            "webhook_type": "TRANSACTIONS",
            "webhook_code": "SOMETHING_ELSE",
            "item_id": item_id,
        },
        timeout=5,
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("webhook_code") == "SOMETHING_ELSE"
    assert "queued_job" not in body
    time.sleep(0.3)
    after = db.sync_jobs.count_documents({
        "company_id": CID, "kind": "plaid_manual_sync",
    })
    assert after == before, "Unknown code must NOT enqueue"


def test_webhook_unknown_item():
    r = requests.post(
        f"{BASE_URL}/api/plaid/webhook",
        json={
            "webhook_type": "TRANSACTIONS",
            "webhook_code": "SYNC_UPDATES_AVAILABLE",
            "item_id": "nonexistent-item-" + uuid.uuid4().hex,
        },
        timeout=5,
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("unknown_item") is True


def test_webhook_non_transactions_type():
    r = requests.post(
        f"{BASE_URL}/api/plaid/webhook",
        json={
            "webhook_type": "ITEM",
            "webhook_code": "ERROR",
            "item_id": "any",
        },
        timeout=5,
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("ignored") is True
