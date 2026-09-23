"""Cleanup job scheduler — runs the historical scan for companies
whose `/welcome` toggles opted them in.

Contract with the rest of the system
------------------------------------
* ``cleanup_jobs`` collection holds one row per company per opt-in.
  Shape (see ``routes/cleanup.py``):
    {
      id, company_id, flags: {irs, receipts, liabilities},
      months: {irs, receipts, liabilities},
      status: pending | running | complete | failed | deferred,
      scheduled_at: iso,   # when this job is first eligible to run
      started_at, completed_at, items_created, error, retries
    }
* Every ``INTERVAL`` seconds we sweep for rows with
  ``status == pending`` and ``scheduled_at <= now``, gated on:
    (a) at least one Plaid sync_jobs row is completed for the company
        (proxy for "historical data has landed"), OR
    (b) no Plaid item exists for the company (manual bookkeeping —
        no sync ever runs, just scan whatever the merchant entered).
* We cap concurrent scans at ``MAX_CONCURRENT`` to protect against a
  many-tenant thundering-herd scenario. Companies that queue past the
  cap simply wait for the next tick — jitter on ``scheduled_at``
  already spreads new opt-ins across a 0-24h window.

Env toggles
-----------
  CLEANUP_SCHEDULER_DISABLED=1  — disable the poll entirely
  CLEANUP_SCHEDULER_INTERVAL=NN — poll interval in seconds (default 300)
  CLEANUP_SCHEDULER_CONCURRENCY=N — parallel scans per tick (default 3)
"""
from __future__ import annotations
import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from db import db
from cleanup_scan import run_scan_for_company

logger = logging.getLogger("axiom.cleanup_scheduler")

SCHEDULER_INTERVAL_SECONDS = int(
    os.environ.get("CLEANUP_SCHEDULER_INTERVAL", "300"),   # 5 min
)
MAX_CONCURRENT = int(os.environ.get("CLEANUP_SCHEDULER_CONCURRENCY", "3"))

_TASK: Optional[asyncio.Task] = None
_NOW = lambda: datetime.now(timezone.utc)


async def _plaid_ready(cid: str) -> bool:
    """Return True if it's safe to scan — either the company has
    completed at least one Plaid sync or has no Plaid item at all."""
    has_item = await db.plaid_items.find_one({"company_id": cid}, {"_id": 1})
    if not has_item:
        return True   # no Plaid → no historical import to wait on
    done = await db.sync_jobs.find_one(
        {"company_id": cid, "kind": "plaid_manual_sync", "status": "completed"},
        {"_id": 1},
    )
    return bool(done)


async def _process_job(job: dict) -> None:
    """Run one job start-to-finish, updating the doc's status
    transitions on each phase. Any exception is caught and stamped
    onto the job so a re-run picks it up cleanly on the next tick."""
    jid = job["id"]
    cid = job["company_id"]
    if not await _plaid_ready(cid):
        # Push the schedule out an hour, keep status pending.
        new_at = _NOW().replace(microsecond=0).isoformat()
        await db.cleanup_jobs.update_one(
            {"id": jid},
            {"$set": {"status": "deferred", "deferred_at": new_at,
                       "defer_reason": "waiting on Plaid initial sync"},
             "$inc": {"defer_count": 1}},
        )
        # Bump scheduled_at forward ~1h so we don't hot-loop.
        from datetime import timedelta
        next_try = (_NOW() + timedelta(hours=1)).isoformat()
        await db.cleanup_jobs.update_one(
            {"id": jid},
            {"$set": {"status": "pending", "scheduled_at": next_try}},
        )
        logger.info("Cleanup deferred cid=%s next_try=%s", cid, next_try)
        return

    # Move to running atomically — if another worker already grabbed
    # it, our update matches 0 docs and we bail.
    updated = await db.cleanup_jobs.update_one(
        {"id": jid, "status": "pending"},
        {"$set": {"status": "running", "started_at": _NOW().isoformat()}},
    )
    if updated.modified_count == 0:
        return   # another worker won the race

    try:
        result = await run_scan_for_company(job)
        await db.cleanup_jobs.update_one(
            {"id": jid},
            {"$set": {
                "status": "complete",
                "completed_at": _NOW().isoformat(),
                "items_created": result.get("items_added", 0),
                "items_total":   result.get("items_total", 0),
                "batch_id":      result.get("batch_id"),
                "error": None,
            }},
        )
        logger.info(
            "Cleanup scan cid=%s items_added=%s items_total=%s",
            cid, result.get("items_added"), result.get("items_total"),
        )
    except Exception as e:   # noqa: BLE001
        logger.exception("Cleanup scan cid=%s FAILED", cid)
        await db.cleanup_jobs.update_one(
            {"id": jid},
            {"$set": {
                "status": "failed",
                "completed_at": _NOW().isoformat(),
                "error": str(e)[:500],
            }, "$inc": {"retries": 1}},
        )


async def run_once() -> dict:
    """Pick up any pending jobs whose ``scheduled_at`` has arrived,
    process up to MAX_CONCURRENT of them in parallel."""
    now_iso = _NOW().isoformat()
    cursor = db.cleanup_jobs.find({
        "status": "pending",
        "scheduled_at": {"$lte": now_iso},
    }).limit(MAX_CONCURRENT)
    jobs = [j async for j in cursor]
    if not jobs:
        return {"processed": 0}
    await asyncio.gather(*(_process_job(j) for j in jobs))
    return {"processed": len(jobs)}


async def _loop() -> None:
    logger.info(
        "Cleanup scheduler started (interval=%ss, concurrency=%s)",
        SCHEDULER_INTERVAL_SECONDS, MAX_CONCURRENT,
    )
    while True:
        try:
            summary = await run_once()
            if summary["processed"]:
                logger.info("Cleanup scheduler tick: %s", summary)
        except Exception:   # noqa: BLE001
            logger.exception("Cleanup scheduler tick failed")
        await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)


def start_scheduler() -> None:
    """Idempotent — safe to call more than once."""
    global _TASK
    if _TASK and not _TASK.done():
        return
    if os.environ.get("CLEANUP_SCHEDULER_DISABLED") == "1":
        logger.info("Cleanup scheduler disabled by env")
        return
    loop = asyncio.get_event_loop()
    _TASK = loop.create_task(_loop(), name="cleanup_scheduler")
