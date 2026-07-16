"""Regression test for the "Dashboard shows $0.00 for 2 minutes after a
first-connect sync" bug.

Root cause: `dashboard/metrics` and `ai/activity` cache their results in an
in-process TTLCache for 15 s. When a company was freshly connected, the
Dashboard's initial `fetchHeavy` populated the cache with the empty-state
response before the sync finished inserting txns. When the sync-status
poll then re-fired `fetchHeavy`, the server returned the stale cached
zeros for the next 15 s, and the next auto-refetch was 120 s later — so
tiles sat at $0.00 for up to 2 minutes.

Fix: `sync_tasks._mark_done` now calls `get_cache().invalidate(company_id)`
whenever a background job completes.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

import job_queue        # noqa: E402
import sync_tasks       # noqa: E402
from db import db       # noqa: E402
from infra import get_cache  # noqa: E402


async def _cleanup(cid: str):
    await db.sync_jobs.delete_many({"company_id": cid})


async def _run_cache_invalidation_on_mark_done():
    cid = f"cache-test-{uuid.uuid4()}"
    cache = get_cache()
    # Seed cache with a stale "zero" value under the same namespace the
    # Dashboard uses so we can prove it gets purged.
    key = cache.key("dash_metrics", company_id=cid, day="2026-01-01")
    cache._store[key] = {"cash_on_hand": 0.0}
    assert cache._store.get(key) is not None, "seed failed"

    # Emulate a completed sync job.
    job_id = str(uuid.uuid4())
    await db.sync_jobs.insert_one({
        "id": job_id, "company_id": cid, "kind": "plaid_manual_sync",
        "status": "running", "created_at": "2020-01-01",
    })
    try:
        await sync_tasks._mark_done(job_id, {"imported": 1871})

        # After _mark_done the cache entry for this company MUST be gone.
        assert cache._store.get(key) is None, (
            "cache entry survived _mark_done — the 2-minute-zero bug is back"
        )

        # Job doc updated to completed
        doc = await job_queue.get_job(job_id)
        assert doc["status"] == "completed"
        assert doc["result"] == {"imported": 1871}
    finally:
        await _cleanup(cid)


async def _run_cache_invalidation_scoped_to_company():
    """Invalidation must only nuke the target company's keys, never the
    neighbour's."""
    cid_target = f"cache-test-{uuid.uuid4()}"
    cid_other  = f"cache-test-{uuid.uuid4()}"
    cache = get_cache()

    k1 = cache.key("dash_metrics", company_id=cid_target, day="2026-01-01")
    k2 = cache.key("dash_metrics", company_id=cid_other,  day="2026-01-01")
    cache._store[k1] = {"cash_on_hand": 100.0}
    cache._store[k2] = {"cash_on_hand": 200.0}

    job_id = str(uuid.uuid4())
    await db.sync_jobs.insert_one({
        "id": job_id, "company_id": cid_target, "kind": "plaid_manual_sync",
        "status": "running", "created_at": "2020-01-01",
    })
    try:
        await sync_tasks._mark_done(job_id, {"imported": 1})
        assert cache._store.get(k1) is None, "target's cache entry NOT purged"
        assert cache._store.get(k2) is not None, "neighbour's cache entry was collateral-damaged"
    finally:
        await _cleanup(cid_target)
        await _cleanup(cid_other)


if __name__ == "__main__":
    async def _all():
        await _run_cache_invalidation_on_mark_done()
        await _run_cache_invalidation_scoped_to_company()
    asyncio.run(_all())
    print("Both cache-invalidation tests passed.")
