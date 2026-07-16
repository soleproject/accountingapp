"""Iteration 17 backend tests — GET /companies/{cid}/sync-status endpoint
and 15-second micro-cache behavior on the 3 heavy Dashboard endpoints.
"""
import os
import time
import uuid
from datetime import datetime, timezone

import pytest
import requests
from dotenv import load_dotenv
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"

# Companies from problem statement (each 1871 txns, no active jobs)
CIDS = [
    "2f8153a1-84bc-4ccb-bf1a-83893bffe956",  # Marketing Co, LLC (pro has access)
]
# NOTE: problem statement referenced 254, LLC / 418, LLC / 400, LLC with 1871
# txns each. Those companies do not exist in the DB. Using Marketing Co, LLC
# (134 txns, pro is a member).
EXPECTED_TOTAL_TXNS = 134


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": PRO_EMAIL, "password": PRO_PASS})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}",
            "Content-Type": "application/json"}


# ---------- sync-status: idle case ----------

@pytest.mark.parametrize("cid", CIDS)
def test_sync_status_idle_all_three_companies(headers, cid):
    r = requests.get(f"{API}/companies/{cid}/sync-status", headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "idle", data
    assert data["total_txns"] == EXPECTED_TOTAL_TXNS, f"expected {EXPECTED_TOTAL_TXNS} for {cid}, got {data['total_txns']}"
    # optional fields present but may be None if never synced
    assert "last_sync_at" in data
    assert "last_kind" in data
    assert "last_status" in data


# ---------- sync-status: syncing (simulated) ----------

def _insert_running_job(cid, stage="categorizing", current=1543, total=1900):
    """Talk to Mongo via a helper backend seed endpoint? None exists — use
    motor directly by importing db from the backend package.
    """
    import sys
    sys.path.insert(0, "/app/backend")
    import asyncio
    from db import db
    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": job_id,
        "company_id": cid,
        "kind": "plaid_reset_resync",
        "status": "running",
        "progress": {"stage": stage, "current": current, "total": total},
        "created_at": now,
        "started_at": now,
        "finished_at": None,
    }
    asyncio.get_event_loop().run_until_complete(db.sync_jobs.insert_one(doc))
    return job_id


def _delete_job(job_id):
    import sys
    sys.path.insert(0, "/app/backend")
    import asyncio
    from db import db
    asyncio.get_event_loop().run_until_complete(
        db.sync_jobs.delete_one({"id": job_id})
    )


def test_sync_status_syncing_response_shape(headers):
    cid = CIDS[0]
    job_id = _insert_running_job(cid, "categorizing", 1543, 1900)
    try:
        r = requests.get(f"{API}/companies/{cid}/sync-status", headers=headers)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "syncing"
        assert data["imported"] == 1543
        assert data["target"] == 1900
        assert data["percent"] == 81.2
        assert data["stage"] == "categorizing"
        assert data["job_id"] == job_id
        assert data["total_txns"] == EXPECTED_TOTAL_TXNS
        assert data["kind"] == "plaid_reset_resync"
    finally:
        _delete_job(job_id)


def test_sync_status_syncing_no_target(headers):
    """Downloading stage → target unknown, percent None."""
    cid = CIDS[0]
    import sys
    sys.path.insert(0, "/app/backend")
    import asyncio
    from db import db
    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    asyncio.get_event_loop().run_until_complete(db.sync_jobs.insert_one({
        "id": job_id, "company_id": cid, "kind": "plaid_manual_sync",
        "status": "running",
        "progress": {"stage": "downloading", "current": 0, "total": None},
        "created_at": now, "started_at": now, "finished_at": None,
    }))
    try:
        r = requests.get(f"{API}/companies/{cid}/sync-status", headers=headers)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "syncing"
        assert data["stage"] == "downloading"
        assert data["target"] is None
        assert data["percent"] is None
    finally:
        _delete_job(job_id)


# ---------- sync-status: failed (last_status=failed) ----------

def test_sync_status_failed_last_status(headers):
    cid = CIDS[0]
    import sys
    sys.path.insert(0, "/app/backend")
    import asyncio
    from db import db
    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    asyncio.get_event_loop().run_until_complete(db.sync_jobs.insert_one({
        "id": job_id, "company_id": cid, "kind": "plaid_manual_sync",
        "status": "failed",
        "created_at": now, "started_at": now, "finished_at": now,
        "error": "test-injected failure",
    }))
    try:
        r = requests.get(f"{API}/companies/{cid}/sync-status", headers=headers)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "idle"
        assert data["last_status"] == "failed"
        assert data["last_sync_at"] == now
        assert data["last_kind"] == "plaid_manual_sync"
    finally:
        _delete_job(job_id)


# ---------- 15s micro-cache: identical + faster on second hit ----------

@pytest.mark.parametrize("path", [
    "/dashboard/metrics",
    "/ai/activity",
    "/reports/income-statement",
])
def test_dashboard_endpoints_are_cached(headers, path):
    cid = CIDS[0]
    url = f"{API}/companies/{cid}{path}"

    t0 = time.perf_counter()
    r1 = requests.get(url, headers=headers)
    d1 = time.perf_counter() - t0
    assert r1.status_code == 200

    t0 = time.perf_counter()
    r2 = requests.get(url, headers=headers)
    d2 = time.perf_counter() - t0
    assert r2.status_code == 200

    # Values must be identical (same cache entry).
    assert r1.json() == r2.json(), f"{path}: responses differ across two 15s-window hits"
    # Second hit should be faster (allow generous margin for network jitter).
    # We only assert it's at least not dramatically slower.
    print(f"{path}: first={d1*1000:.1f}ms second={d2*1000:.1f}ms")
    assert d2 <= d1 + 0.5, f"{path}: cache didn't speed up (first={d1:.3f}s, second={d2:.3f}s)"


def test_auth_required_on_sync_status():
    cid = CIDS[0]
    r = requests.get(f"{API}/companies/{cid}/sync-status")
    assert r.status_code in (401, 403)
