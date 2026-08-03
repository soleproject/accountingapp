"""Retry + DLQ tests for the Feb 2026 job_queue hardening.

What we're testing:
  • A failing task retries once with a scheduled next_retry_at
  • Attempts counter is monotonically incremented
  • After MAX_ATTEMPTS the row lands in status="dlq" and STOPS retrying
  • DLQ retry_dlq_job resets counter + re-runs the task
  • reconcile_stuck_jobs re-arms retry_scheduled rows on restart

We monkey-patch the retry backoff to 0 seconds so tests don't wait.
"""
import asyncio
import sys
import uuid

import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

import job_queue  # noqa: E402
from job_queue import (  # noqa: E402
    enqueue_job, register_task, get_job,
    reconcile_stuck_jobs, retry_dlq_job,
)
from db import db  # noqa: E402


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# Speed up tests — 0-second backoff means retries happen immediately.
def setup_module(_mod):
    job_queue._BACKOFF_MINUTES = [0, 0, 0, 0, 0]
    # Force max attempts to 3 for compact tests.
    job_queue.MAX_ATTEMPTS = 3


def teardown_module(_mod):
    # Purge test rows.
    _run(db.sync_jobs.delete_many({"kind": {"$regex": "^__test_"}}))


# ---------------------------------------------------------------------
# Test fixtures — a task that fails N times then succeeds
# ---------------------------------------------------------------------

_call_counts: dict[str, int] = {}


async def _flaky_task_success_after_2(job_id, company_id, **kw):
    """Fails on attempts 1-2, succeeds on attempt 3."""
    cnt = _call_counts.get(job_id, 0) + 1
    _call_counts[job_id] = cnt
    if cnt <= 2:
        raise RuntimeError(f"simulated failure on attempt {cnt}")
    from job_queue import update_job
    from db import now_iso
    await update_job(job_id, status="completed", result={"ok": True, "attempts": cnt},
                     finished_at=now_iso())


async def _always_fails(job_id, company_id, **kw):
    _call_counts[job_id] = _call_counts.get(job_id, 0) + 1
    raise RuntimeError(f"simulated always-fail on attempt {_call_counts[job_id]}")


register_task("__test_flaky_2", _flaky_task_success_after_2)
register_task("__test_always_fails", _always_fails)


# ---------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------

def test_flaky_task_retries_and_eventually_succeeds():
    """Two failures → retry_scheduled twice → 3rd attempt succeeds."""
    async def _t():
        cid = f"__test__{uuid.uuid4().hex[:8]}"
        jid = await enqueue_job("__test_flaky_2", cid)
        # Give the loop time to work through the retries (all 0s backoff).
        for _ in range(20):
            await asyncio.sleep(0.15)
            doc = await get_job(jid)
            if doc.get("status") in ("completed", "dlq"):
                break
        assert doc["status"] == "completed", f"expected completed, got {doc['status']}"
        assert doc["attempts"] == 3
        assert doc["result"] == {"ok": True, "attempts": 3}
    _run(_t())


def test_always_failing_task_lands_in_dlq_after_max_attempts():
    """Fails 3 times → status=dlq, no further retries scheduled."""
    async def _t():
        cid = f"__test__{uuid.uuid4().hex[:8]}"
        jid = await enqueue_job("__test_always_fails", cid)
        for _ in range(25):
            await asyncio.sleep(0.15)
            doc = await get_job(jid)
            if doc.get("status") == "dlq":
                break
        assert doc["status"] == "dlq", f"expected dlq, got {doc['status']}"
        assert doc["attempts"] == 3    # MAX_ATTEMPTS
        assert doc["last_error"] and "simulated always-fail" in doc["last_error"]
        assert doc["first_failed_at"]
        assert doc["next_retry_at"] is None
        # Stays put — additional wait should not change status
        await asyncio.sleep(0.5)
        doc2 = await get_job(jid)
        assert doc2["status"] == "dlq"
        assert doc2["attempts"] == 3
    _run(_t())


def test_dlq_retry_resets_counter_and_reexecutes():
    async def _t():
        cid = f"__test__{uuid.uuid4().hex[:8]}"
        jid = await enqueue_job("__test_always_fails", cid)
        for _ in range(25):
            await asyncio.sleep(0.15)
            doc = await get_job(jid)
            if doc.get("status") == "dlq":
                break
        assert doc["status"] == "dlq"
        # Now retry — resets attempts to 0, tries again 3 more times, back to dlq
        _call_counts.pop(jid, None)
        res = await retry_dlq_job(jid)
        assert res["ok"] is True
        for _ in range(25):
            await asyncio.sleep(0.15)
            doc = await get_job(jid)
            if doc.get("status") == "dlq":
                break
        assert doc["status"] == "dlq"
        assert doc["attempts"] == 3
    _run(_t())


def test_reconcile_re_arms_retry_scheduled():
    """A row parked in status=retry_scheduled with next_retry_at in the
    past must be fired immediately by reconcile_stuck_jobs. Simulates
    pod restart mid-backoff-window."""
    async def _t():
        import datetime as _dt
        cid = f"__test__{uuid.uuid4().hex[:8]}"
        jid = str(uuid.uuid4())
        # Hand-craft the row as if a prior process failed once and
        # scheduled a retry that was due before the pod restarted.
        past = (_dt.datetime.now(_dt.timezone.utc)
                - _dt.timedelta(seconds=1)).isoformat()
        _call_counts.pop(jid, None)
        await db.sync_jobs.insert_one({
            "id": jid, "company_id": cid, "user_id": None,
            "kind": "__test_flaky_2", "status": "retry_scheduled",
            "attempts": 1, "max_attempts": 3,
            "kwargs": {}, "created_at": past, "updated_at": past,
            "started_at": None, "finished_at": None,
            "next_retry_at": past, "first_failed_at": past,
            "last_error": "prior failure",
        })
        _call_counts[jid] = 1  # pretend one attempt happened pre-restart
        report = await reconcile_stuck_jobs()
        assert report["retries_rehydrated"] >= 1
        # The scheduled retry fires ~immediately (0s backoff in test),
        # then _flaky_task_success_after_2 wants attempt 3 to pass — but
        # we only get one re-arm from reconcile. Let it run:
        for _ in range(20):
            await asyncio.sleep(0.15)
            doc = await get_job(jid)
            if doc.get("status") in ("completed", "dlq"):
                break
        # After re-arm, one more attempt runs → attempt 2 in the counter
        # → still fails per _flaky logic (fails on attempts 1-2), enters
        # retry_scheduled OR reaches attempt 3 depending on how quickly
        # the loop drove it. Either way it must NOT be stuck in the
        # original retry_scheduled state.
        assert doc["status"] != "retry_scheduled" or doc["attempts"] > 1
    _run(_t())
