"""In-process durable job queue — replaces the previous arq/Redis worker.

Same public API surface as before:
    await enqueue_job(kind, company_id, user_id=None, **task_kwargs) → job_id
    await get_job(job_id) → dict | None
    await update_job(job_id, **patch)

Design (Feb 2026 rewrite):
  - Every long-running task (Plaid manual sync, reset-and-resync, contact
    backfill) is still recorded in the `sync_jobs` Mongo collection — that
    remains the durable source of truth.
  - Instead of routing through Redis + a separate worker process, the task
    coroutine is now spawned with `asyncio.create_task` inside the FastAPI
    event loop. Motor/Plaid/LLM work is fully IO-bound so the loop is not
    blocked; API requests continue to be served in parallel.
  - Global `_semaphore` caps concurrent syncs at `MAX_CONCURRENT_SYNCS`
    (env-overridable, default 20) to protect the Motor connection pool and
    Anthropic rate limits. Bump this in prod when running 3k+ users: set
    `MAX_CONCURRENT_SYNCS=40` per pod × 3 pods = 120 parallel syncs.
  - On FastAPI startup, `reconcile_stuck_jobs()` marks any `queued`/`running`
    row from a previous process as failed — its retry is idempotent
    (dedupe on `(company_id, plaid_transaction_id)` unique index).

Task registration:
    from job_queue import register_task
    register_task("plaid_manual_sync", plaid_manual_sync)
"""
from __future__ import annotations
import asyncio
import os
import traceback
import uuid
from typing import Any, Awaitable, Callable

from db import db, now_iso


MAX_CONCURRENT_SYNCS = int(os.environ.get("MAX_CONCURRENT_SYNCS", "20"))
_TASK_REGISTRY: dict[str, Callable[..., Awaitable[Any]]] = {}
_active_tasks: set[asyncio.Task] = set()
_semaphore: asyncio.Semaphore | None = None

# ── Retry / DLQ policy ────────────────────────────────────────────────
#
# When a task raises we no longer instantly bury it in status=failed.
# The retry curve is deliberately front-loaded (1min / 2min / 4min /
# 8min / 16min = ~30min total window) because 90% of Plaid failures are
# transient — rate limits, item state transitions, brief network blips.
# After MAX_ATTEMPTS the row lands in `status="dlq"` for ops review.
# One-click retry is /api/admin/jobs/{id}/retry — bumps attempts back
# to 0 and re-enqueues.
MAX_ATTEMPTS = int(os.environ.get("JOB_MAX_ATTEMPTS", "5"))
_BACKOFF_MINUTES = [1, 2, 4, 8, 16]  # index = attempts_so_far


def _next_retry_delay_seconds(attempts: int) -> int:
    """Exponential backoff — attempts=1 (first failure) → 1min, etc.
    Falls back to the last entry for any attempts beyond the list."""
    idx = min(max(attempts - 1, 0), len(_BACKOFF_MINUTES) - 1)
    return _BACKOFF_MINUTES[idx] * 60


def _get_semaphore() -> asyncio.Semaphore:
    # Create lazily so we bind to the running loop, not import-time loop.
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(MAX_CONCURRENT_SYNCS)
    return _semaphore


def register_task(kind: str, fn: Callable[..., Awaitable[Any]]) -> None:
    """Register a task coroutine under `kind`. Called once at startup."""
    _TASK_REGISTRY[kind] = fn


async def enqueue_job(kind: str, company_id: str, *, user_id: str | None = None,
                      **task_kwargs: Any) -> str:
    """Insert a `sync_jobs` row, then spawn the registered task in-process.

    `kind` maps to a task registered via `register_task()`, e.g.
      - "plaid_manual_sync"
      - "plaid_reset_resync"
      - "plaid_contact_backfill"
    """
    if kind not in _TASK_REGISTRY:
        raise RuntimeError(
            f"Task kind {kind!r} not registered. Call register_task() at startup.",
        )
    job_id = str(uuid.uuid4())
    now = now_iso()
    await db.sync_jobs.insert_one({
        "id": job_id,
        "company_id": company_id,
        "user_id": user_id,
        "kind": kind,
        "status": "queued",
        "progress": None,
        "result": None,
        "error": None,
        "kwargs": task_kwargs,
        # Retry / DLQ metadata (Feb 2026). `attempts` starts at 0 and
        # increments on each execution; DLQ transition happens when it
        # crosses MAX_ATTEMPTS. `first_failed_at` gives ops a clean
        # "how long has this been failing" reading in the admin UI.
        "attempts": 0,
        "max_attempts": MAX_ATTEMPTS,
        "first_failed_at": None,
        "last_error": None,
        "next_retry_at": None,
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "finished_at": None,
    })
    fn = _TASK_REGISTRY[kind]
    task = asyncio.create_task(
        _run_wrapped(fn, job_id, company_id, task_kwargs),
        name=f"{kind}:{job_id[:8]}",
    )
    _active_tasks.add(task)
    task.add_done_callback(_active_tasks.discard)
    return job_id


async def _run_wrapped(fn: Callable[..., Awaitable[Any]], job_id: str,
                       company_id: str, kwargs: dict) -> None:
    """Task wrapper — bounded concurrency + exception guard + retry.

    The task fn manages its own status transitions (started → completed
    / failed) via `update_job`. This wrapper catches any exceptions the
    task didn't handle and applies the retry policy:

      • attempts < max_attempts  → status="retry_scheduled",
        next_retry_at = now + backoff. Schedules an in-process
        `asyncio.call_later` to re-execute.
      • attempts >= max_attempts → status="dlq". Requires manual
        one-click retry via /api/admin/jobs/{id}/retry.

    On pod restart, `reconcile_stuck_jobs` sweeps orphaned in-flight
    tasks (retry_scheduled + running) and either re-arms the timer
    (still in the retry window) or gives up (crossed max).
    """
    sem = _get_semaphore()
    async with sem:
        # Stamp the ai_usage ContextVar so every LLM / Veryfi / Resend
        # call made inside this background task gets attributed to the
        # right company (Feb 2026 fix — background jobs bypass the auth
        # dependency that normally sets this, so Plaid webhook + manual
        # sync AI costs were previously landing as "no company").
        try:
            from ai_usage import set_request_context
            doc = await db.sync_jobs.find_one(
                {"id": job_id}, {"user_id": 1},
            ) or {}
            set_request_context(user_id=doc.get("user_id"), company_id=company_id)
        except Exception:  # noqa: BLE001 — attribution is best-effort
            pass

        # Increment attempts BEFORE running so a crashed worker still
        # bumps the counter — otherwise reconcile_stuck_jobs could
        # infinitely re-arm the same job.
        await db.sync_jobs.update_one(
            {"id": job_id},
            {"$inc": {"attempts": 1},
             "$set": {"status": "running", "updated_at": now_iso()}},
        )
        try:
            await fn(job_id, company_id, **kwargs)
        except Exception:  # noqa: BLE001
            await _handle_task_failure(job_id, company_id, kwargs,
                                        traceback.format_exc())


async def _handle_task_failure(job_id: str, company_id: str, kwargs: dict,
                                trace: str) -> None:
    """Apply the retry / DLQ policy after a task raises.

    Atomic read of `attempts` + `max_attempts` before deciding —
    concurrent retries from a pod-restart race are safe: two workers
    both bump attempts, both check, one lands in dlq if the counter
    crossed.
    """
    doc = await db.sync_jobs.find_one(
        {"id": job_id}, {"attempts": 1, "max_attempts": 1, "kind": 1,
                         "first_failed_at": 1},
    ) or {}
    attempts = int(doc.get("attempts") or 1)
    max_attempts = int(doc.get("max_attempts") or MAX_ATTEMPTS)
    now = now_iso()
    first_failed = doc.get("first_failed_at") or now

    if attempts >= max_attempts:
        # DLQ.
        await db.sync_jobs.update_one(
            {"id": job_id},
            {"$set": {
                "status": "dlq",
                "last_error": trace,
                "error": trace,           # legacy field
                "first_failed_at": first_failed,
                "finished_at": now,
                "updated_at": now,
                "next_retry_at": None,
            }},
        )
        return

    # Schedule a retry.
    import datetime as _dt
    delay = _next_retry_delay_seconds(attempts)
    next_at = (_dt.datetime.now(_dt.timezone.utc)
               + _dt.timedelta(seconds=delay)).isoformat()
    await db.sync_jobs.update_one(
        {"id": job_id},
        {"$set": {
            "status": "retry_scheduled",
            "last_error": trace,
            "first_failed_at": first_failed,
            "next_retry_at": next_at,
            "updated_at": now,
        }},
    )
    # Fire an in-process timer to re-execute. If the pod dies before
    # the timer fires, reconcile_stuck_jobs picks the row up on next
    # startup and re-arms it.
    loop = asyncio.get_running_loop()
    kind = doc.get("kind")
    fn = _TASK_REGISTRY.get(kind) if kind else None
    if fn:
        async def _rearm():
            task = asyncio.create_task(
                _run_wrapped(fn, job_id, company_id, kwargs),
                name=f"{kind}:retry:{job_id[:8]}",
            )
            _active_tasks.add(task)
            task.add_done_callback(_active_tasks.discard)
        loop.call_later(delay, lambda: asyncio.create_task(_rearm()))


async def get_job(job_id: str) -> dict | None:
    """Return the current job doc (safe to serialize)."""
    doc = await db.sync_jobs.find_one({"id": job_id})
    if not doc:
        return None
    doc.pop("_id", None)
    return doc


async def update_job(job_id: str, **patch: Any) -> None:
    """Merge-update on a job. Automatically stamps `updated_at`."""
    patch["updated_at"] = now_iso()
    await db.sync_jobs.update_one({"id": job_id}, {"$set": patch})


async def reconcile_stuck_jobs() -> dict:
    """Recover in-flight and pending-retry jobs after a pod restart.

    Three transitions:
      • `queued` / `running` from a prior process → `failed` (with the
        idempotent retry-safe error; user can click retry in the UI).
        In-flight tasks lose their coroutine when the process dies.
      • `retry_scheduled` with `next_retry_at` in the past → re-arm
        the retry immediately (fire the task now).
      • `retry_scheduled` with `next_retry_at` in the future → re-arm
        the in-process timer for the remaining delay so the retry
        happens at the originally-scheduled wall clock time even
        across restarts.

    Idempotent retries via Plaid dedupe (`(company_id, plaid_transaction_id)`
    unique index) mean re-execution can never double-import.
    """
    import datetime as _dt
    now_dt = _dt.datetime.now(_dt.timezone.utc)
    now = now_dt.isoformat()

    # (a) queued/running from prior process → mark failed. The user's
    # existing "retry" button + Plaid dedupe make this safe to surface.
    stuck = await db.sync_jobs.update_many(
        {"status": {"$in": ["queued", "running"]}},
        {"$set": {
            "status": "failed",
            "error": "process restarted before completion — re-run to retry",
            "finished_at": now,
            "updated_at": now,
        }},
    )

    # (b)+(c) rehydrate retry timers. Read the rows first so we can
    # schedule the loop.call_later with the right remaining delay.
    rehydrated = 0
    loop = asyncio.get_running_loop()
    async for row in db.sync_jobs.find({"status": "retry_scheduled"}):
        kind = row.get("kind")
        fn = _TASK_REGISTRY.get(kind) if kind else None
        if not fn:
            continue
        job_id = row["id"]; cid = row["company_id"]
        kw = row.get("kwargs") or {}
        try:
            due_at = _dt.datetime.fromisoformat(row.get("next_retry_at") or now)
        except Exception:
            due_at = now_dt
        delay = max(0, int((due_at - now_dt).total_seconds()))

        async def _rearm(_fn=fn, _job=job_id, _cid=cid, _kw=kw, _kind=kind):
            task = asyncio.create_task(
                _run_wrapped(_fn, _job, _cid, _kw),
                name=f"{_kind}:retry:{_job[:8]}",
            )
            _active_tasks.add(task)
            task.add_done_callback(_active_tasks.discard)
        loop.call_later(delay, lambda _f=_rearm: asyncio.create_task(_f()))
        rehydrated += 1

    return {
        "stuck_marked_failed": stuck.modified_count,
        "retries_rehydrated": rehydrated,
    }


async def ensure_jobs_indexes() -> None:
    """Idempotent index setup. TTL keeps completed jobs for 7 days."""
    try:
        await db.sync_jobs.create_index("id", unique=True, name="jobs_id_uniq")
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.sync_jobs.create_index(
            [("company_id", 1), ("kind", 1), ("created_at", -1)],
            name="jobs_by_company_kind_date",
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.sync_jobs.create_index(
            [("company_id", 1), ("status", 1), ("created_at", -1)],
            name="jobs_by_company_status_created",
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.sync_jobs.create_index(
            [("company_id", 1), ("status", 1), ("finished_at", -1)],
            name="jobs_by_company_status_finished",
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.sync_jobs.create_index(
            "finished_at", expireAfterSeconds=7 * 86400,
            name="jobs_ttl_finished",
        )
    except Exception:  # noqa: BLE001
        pass
    # DLQ + retry surface — ops queries these directly, and the
    # rehydration path scans by status.
    try:
        await db.sync_jobs.create_index(
            [("status", 1), ("first_failed_at", -1)],
            name="jobs_status_first_failed",
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.sync_jobs.create_index(
            [("status", 1), ("next_retry_at", 1)],
            name="jobs_status_next_retry",
        )
    except Exception:  # noqa: BLE001
        pass


async def retry_dlq_job(job_id: str) -> dict:
    """One-click DLQ retry — bumps attempts back to 0, clears the
    retry timer, re-enqueues. Idempotent. Caller (an admin endpoint)
    is responsible for auth."""
    doc = await db.sync_jobs.find_one({"id": job_id})
    if not doc:
        return {"ok": False, "reason": "not_found"}
    if doc.get("status") not in ("dlq", "failed"):
        return {"ok": False, "reason": f"job status is {doc.get('status')}, not eligible"}
    kind = doc.get("kind")
    fn = _TASK_REGISTRY.get(kind)
    if not fn:
        return {"ok": False, "reason": f"task kind {kind!r} not registered"}
    now = now_iso()
    await db.sync_jobs.update_one(
        {"id": job_id},
        {"$set": {
            "status": "queued", "attempts": 0,
            "last_error": None, "next_retry_at": None,
            "finished_at": None, "updated_at": now,
        }},
    )
    task = asyncio.create_task(
        _run_wrapped(fn, job_id, doc["company_id"], doc.get("kwargs") or {}),
        name=f"{kind}:manual_retry:{job_id[:8]}",
    )
    _active_tasks.add(task)
    task.add_done_callback(_active_tasks.discard)
    return {"ok": True, "job_id": job_id}


__all__ = [
    "enqueue_job",
    "get_job",
    "update_job",
    "register_task",
    "reconcile_stuck_jobs",
    "ensure_jobs_indexes",
    "retry_dlq_job",
    "MAX_ATTEMPTS",
]
