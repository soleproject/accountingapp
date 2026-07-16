"""Durable job queue backed by Redis + Arq.

Design:
  - Every long-running task (Plaid manual sync, reset-and-resync, contact
    backfill) becomes an Arq task. The API returns `{job_id}` in <50ms; a
    background worker executes the task; the frontend polls `/jobs/{id}`.
  - Every enqueue also writes a durable `sync_jobs` row (Mongo) so job status
    survives Redis eviction / worker crashes.
  - Idempotency: our transaction writes already dedupe on
    `(company_id, plaid_transaction_id)`, so retries never double-post.

Public API:
    await enqueue_job(kind, company_id, user_id=None, **task_kwargs) → job_id
    await get_job(job_id) → dict | None
    await update_job(job_id, **patch)
"""
from __future__ import annotations
import os
import uuid
from typing import Any

from arq import create_pool
from arq.connections import RedisSettings

from db import db, now_iso


_REDIS_URL = os.environ["REDIS_URL"]
_settings = RedisSettings.from_dsn(_REDIS_URL)

_pool = None  # lazily-created shared ArqRedis pool


async def _get_pool():
    global _pool
    if _pool is None:
        _pool = await create_pool(_settings)
    return _pool


async def enqueue_job(kind: str, company_id: str, *, user_id: str | None = None,
                      **task_kwargs: Any) -> str:
    """Insert a `sync_jobs` row, then enqueue the matching Arq task.

    `kind` maps directly to an Arq task name (see `worker.py`), e.g.
      - "plaid_manual_sync"
      - "plaid_reset_resync"
      - "plaid_contact_backfill"
    """
    job_id = str(uuid.uuid4())
    now = now_iso()
    await db.sync_jobs.insert_one({
        "id": job_id,
        "company_id": company_id,
        "user_id": user_id,
        "kind": kind,
        "status": "queued",             # queued | running | completed | failed
        "progress": None,               # optional {stage: str, current, total}
        "result": None,                 # task's return payload on success
        "error": None,                  # error message on failure
        "kwargs": task_kwargs,
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "finished_at": None,
    })
    pool = await _get_pool()
    await pool.enqueue_job(kind, job_id, company_id, **task_kwargs)
    return job_id


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


async def ensure_jobs_indexes() -> None:
    """Idempotent index setup. TTL keeps completed jobs for 7 days."""
    try:
        await db.sync_jobs.create_index("id", unique=True, name="jobs_id_uniq")
    except Exception:  # noqa: BLE001 — index already exists
        pass
    try:
        await db.sync_jobs.create_index(
            [("company_id", 1), ("kind", 1), ("created_at", -1)],
            name="jobs_by_company_kind_date",
        )
    except Exception:  # noqa: BLE001
        pass
    # Covers the Dashboard Sync-Pill hot path
    # `find_one({company_id, status ∈ [queued, running]}, sort=created_at DESC)`
    # and its companion `find_one({company_id, status ∈ [completed, failed]},
    # sort=finished_at DESC)`. Two focused compound indexes avoid a full
    # collection scan even under 3k+ concurrent pill polls.
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
    # Auto-expire finished jobs 7 days after completion.
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
    "ensure_jobs_indexes",
]
