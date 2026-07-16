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
  - Global `_semaphore` caps concurrent syncs at `MAX_CONCURRENT_SYNCS` (20)
    to protect the Motor connection pool and Anthropic rate limits.
  - On FastAPI startup, `reconcile_stuck_jobs()` marks any `queued`/`running`
    row from a previous process as failed — its retry is idempotent
    (dedupe on `(company_id, plaid_transaction_id)` unique index).

Task registration:
    from job_queue import register_task
    register_task("plaid_manual_sync", plaid_manual_sync)
"""
from __future__ import annotations
import asyncio
import traceback
import uuid
from typing import Any, Awaitable, Callable

from db import db, now_iso


MAX_CONCURRENT_SYNCS = 20
_TASK_REGISTRY: dict[str, Callable[..., Awaitable[Any]]] = {}
_active_tasks: set[asyncio.Task] = set()
_semaphore: asyncio.Semaphore | None = None


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
    """Task wrapper — bounded concurrency + top-level exception guard.

    The registered task fn is expected to manage its own status transitions
    (started → completed/failed) via `update_job`. This wrapper only catches
    exceptions the task failed to catch itself, so a job never gets stuck
    in `running` after a raise.
    """
    sem = _get_semaphore()
    async with sem:
        try:
            await fn(job_id, company_id, **kwargs)
        except Exception:  # noqa: BLE001 — safety net
            await update_job(
                job_id, status="failed",
                error=traceback.format_exc(),
                finished_at=now_iso(),
            )


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


async def reconcile_stuck_jobs() -> int:
    """Mark any `queued`/`running` job from a previous process as failed.

    Called on FastAPI startup. In-flight tasks lose their coroutine when the
    process dies; without this those rows would appear "syncing forever" in
    the Dashboard sync pill. Idempotent retries via the API endpoint are
    always safe because Plaid inserts dedupe on
    `(company_id, plaid_transaction_id)`.
    """
    now = now_iso()
    result = await db.sync_jobs.update_many(
        {"status": {"$in": ["queued", "running"]}},
        {"$set": {
            "status": "failed",
            "error": "process restarted before completion — re-run to retry",
            "finished_at": now,
            "updated_at": now,
        }},
    )
    return result.modified_count


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


__all__ = [
    "enqueue_job",
    "get_job",
    "update_job",
    "register_task",
    "reconcile_stuck_jobs",
    "ensure_jobs_indexes",
]
