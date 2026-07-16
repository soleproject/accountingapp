"""In-process job queue smoke tests — verifies the arq→asyncio migration.

Covers:
  - enqueue_job returns a job_id + spawns the registered task
  - Status transitions: queued → running → completed
  - Exception path: registered task raises → wrapper marks failed
  - get_job / update_job round-trip
  - reconcile_stuck_jobs flips leftover queued/running to failed
  - Concurrency semaphore doesn't deadlock on many tasks
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

import job_queue  # noqa: E402
from db import db  # noqa: E402


async def _wait_status(job_id: str, target: str, timeout: float = 3.0) -> dict:
    """Poll until the job reaches `target` or timeout."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        doc = await job_queue.get_job(job_id)
        if doc and doc.get("status") == target:
            return doc
        await asyncio.sleep(0.05)
    raise AssertionError(f"Job {job_id} did not reach {target!r} within {timeout}s")


async def _cleanup(cid: str):
    await db.sync_jobs.delete_many({"company_id": cid})


# ---------- 1. Happy path — task completes ----------

async def _run_happy_path():
    cid = f"jqtest-{uuid.uuid4()}"

    async def _noop(job_id, company_id):
        await job_queue.update_job(job_id, status="running")
        await asyncio.sleep(0.02)
        await job_queue.update_job(job_id, status="completed",
                                   result={"echo": company_id})

    job_queue.register_task("_test_noop", _noop)
    try:
        jid = await job_queue.enqueue_job("_test_noop", cid)
        doc = await _wait_status(jid, "completed")
        assert doc["result"] == {"echo": cid}
    finally:
        await _cleanup(cid)


# ---------- 2. Unhandled exception → wrapper marks failed ----------

async def _run_exception_path():
    cid = f"jqtest-{uuid.uuid4()}"

    async def _boom(job_id, company_id):
        raise RuntimeError("kaboom")

    job_queue.register_task("_test_boom", _boom)
    try:
        jid = await job_queue.enqueue_job("_test_boom", cid)
        doc = await _wait_status(jid, "failed")
        assert "kaboom" in (doc.get("error") or ""), f"error missing: {doc.get('error')}"
        assert doc.get("finished_at") is not None
    finally:
        await _cleanup(cid)


# ---------- 3. Unknown task kind raises immediately ----------

async def _run_unknown_task_kind():
    cid = f"jqtest-{uuid.uuid4()}"
    try:
        try:
            await job_queue.enqueue_job("_never_registered_xyz", cid)
        except RuntimeError as e:
            assert "not registered" in str(e).lower()
            return
        raise AssertionError("Expected RuntimeError for unknown task kind")
    finally:
        await _cleanup(cid)


# ---------- 4. reconcile_stuck_jobs flips stale queued/running ----------

async def _run_reconcile_stuck():
    cid = f"jqtest-{uuid.uuid4()}"
    # Manually insert two "stuck" rows that no coroutine will finish
    for status in ("queued", "running"):
        await db.sync_jobs.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "kind": "_manual",
            "status": status, "created_at": "2020-01-01",
        })

    try:
        n = await job_queue.reconcile_stuck_jobs()
        assert n >= 2, f"expected ≥2 stuck jobs reconciled, got {n}"
        # Verify our two are now failed
        for doc in await db.sync_jobs.find({"company_id": cid}).to_list(None):
            assert doc["status"] == "failed"
            assert "process restarted" in (doc.get("error") or "").lower()
    finally:
        await _cleanup(cid)


# ---------- 5. Semaphore doesn't deadlock under load ----------

async def _run_many_concurrent():
    cid = f"jqtest-{uuid.uuid4()}"
    counter = {"n": 0}

    async def _quick(job_id, company_id):
        counter["n"] += 1
        await job_queue.update_job(job_id, status="running")
        await asyncio.sleep(0.01)
        await job_queue.update_job(job_id, status="completed")

    job_queue.register_task("_test_quick", _quick)
    try:
        jids = [await job_queue.enqueue_job("_test_quick", cid) for _ in range(30)]
        for jid in jids:
            await _wait_status(jid, "completed", timeout=5.0)
        assert counter["n"] == 30
    finally:
        await _cleanup(cid)


if __name__ == "__main__":
    async def _all():
        await _run_happy_path()
        await _run_exception_path()
        await _run_unknown_task_kind()
        await _run_reconcile_stuck()
        await _run_many_concurrent()
    asyncio.run(_all())
    print("All 5 job_queue tests passed.")
