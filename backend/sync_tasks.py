"""In-process sync tasks — executed by `job_queue.enqueue_job()`.

Replaces the previous `worker.py` arq module. Same task functions, just no
`ctx` first argument (no arq redis pool) and no `WorkerSettings` class.

Every task manages its own status transitions via `job_queue.update_job`;
the enqueue wrapper only catches un-caught exceptions as a safety net.
"""
from __future__ import annotations
import traceback

from db import db, now_iso
import job_queue
import plaid_service
import plaid_connect
import contact_resolver
from ai_service import categorize_transaction as _categorize_fn, resolve_contact_ai


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def _mark_started(job_id: str) -> None:
    await job_queue.update_job(job_id, status="running", started_at=now_iso())


async def _mark_done(job_id: str, result: dict) -> None:
    # Fetch the job so we know which company's caches to invalidate.
    doc = await db.sync_jobs.find_one({"id": job_id}, {"company_id": 1})
    await job_queue.update_job(
        job_id, status="completed", result=result, finished_at=now_iso(),
    )
    # Purge every cache entry scoped to this company (dashboard/metrics,
    # ai/activity, income-statement, balance-sheet, …) so the Dashboard
    # sees fresh numbers the moment the client refetches — otherwise the
    # 15 s TTL would leave tiles showing "0" for up to 2 minutes after a
    # first-connect sync finishes.
    if doc and doc.get("company_id"):
        try:
            from infra import get_cache
            get_cache().invalidate(doc["company_id"])
        except Exception:  # noqa: BLE001 — cache miss is safe
            pass


async def _mark_failed(job_id: str, err: str) -> None:
    await job_queue.update_job(
        job_id, status="failed", error=err, finished_at=now_iso(),
    )


async def _is_period_closed(company_id: str, txn_date: str) -> bool:
    """Match `server._is_period_closed` semantics without importing server.py
    (which would drag in the entire FastAPI app)."""
    doc = await db.fiscal_periods.find_one({
        "company_id": company_id, "status": "closed",
        "start_date": {"$lte": txn_date}, "end_date": {"$gte": txn_date},
    })
    return doc is not None


# ---------------------------------------------------------------------------
# Task: run one Plaid sync cycle (cursor-based delta)
# ---------------------------------------------------------------------------

async def plaid_manual_sync(job_id: str, company_id: str) -> None:
    """Cursor-based delta sync — the "hey, anything new since last time?"
    version. Fast, typically <2 seconds. Runs the PFC-first pipeline for
    every new row.
    """
    await _mark_started(job_id)
    try:
        item = await db.plaid_items.find_one({"company_id": company_id})
        if not item:
            await _mark_failed(job_id, "No Plaid item linked")
            return
        imported = await _run_sync(company_id, item, reset_cursor=False, job_id=job_id)
        await _mark_done(job_id, {"imported": imported})
    except Exception:  # noqa: BLE001
        await _mark_failed(job_id, traceback.format_exc())
        raise


# ---------------------------------------------------------------------------
# Task: reset cursor + full re-pull (used to rescue stuck items)
# ---------------------------------------------------------------------------

async def plaid_reset_resync(job_id: str, company_id: str) -> None:
    """Nuclear option — nulls the stored Plaid cursor and re-pages the entire
    730-day history through the pipeline. Dedupes on
    `(company_id, plaid_transaction_id)`, so it's safe to re-run.
    """
    await _mark_started(job_id)
    try:
        item = await db.plaid_items.find_one({"company_id": company_id})
        if not item:
            await _mark_failed(job_id, "No Plaid item linked")
            return
        imported = await _run_sync(company_id, item, reset_cursor=True, job_id=job_id)
        await _mark_done(job_id, {"reset": True, "imported": imported})
    except Exception:  # noqa: BLE001
        await _mark_failed(job_id, traceback.format_exc())
        raise


# ---------------------------------------------------------------------------
# Task: contact backfill (rare — used after a schema/rule change)
# ---------------------------------------------------------------------------

async def plaid_contact_backfill(job_id: str, company_id: str) -> None:
    await _mark_started(job_id)
    try:
        # Import lazily so the task doesn't pull in FastAPI middleware at
        # module import time.
        from server import _run_contact_backfill  # type: ignore
        summary = await _run_contact_backfill(company_id)
        await _mark_done(job_id, summary)
    except ImportError:
        assigned = await _run_contact_backfill_inline(company_id)
        await _mark_done(job_id, {"assigned_contact_id": assigned})
    except Exception:  # noqa: BLE001
        await _mark_failed(job_id, traceback.format_exc())
        raise


async def _run_contact_backfill_inline(company_id: str) -> int:
    """Simple inline contact backfill — for txns missing contact_id, run
    fast-path resolver on merchant_name. Idempotent.
    """
    to_fix = [t async for t in db.transactions.find({
        "company_id": company_id, "contact_id": None,
        "merchant_name": {"$ne": None},
    })]
    if not to_fix:
        return 0
    results = await contact_resolver.resolve_contacts_batch(
        company_id, to_fix, ai_fallback_fn=resolve_contact_ai, concurrency=5,
    )
    assigned = 0
    for t, r in zip(to_fix, results):
        if r.get("contact_id"):
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {
                    "contact_id": r["contact_id"],
                    "contact_name": r.get("contact_name"),
                    "updated_at": now_iso(),
                }},
            )
            assigned += 1
    return assigned


# ---------------------------------------------------------------------------
# Shared sync body — used by both manual_sync + reset_resync
# ---------------------------------------------------------------------------

async def _run_sync(company_id: str, item: dict, *, reset_cursor: bool,
                    job_id: str | None = None) -> int:
    """Pull txns from Plaid + route through the PFC pipeline. Returns count
    of inserted rows.

    Emits progress updates to `sync_jobs.progress` at stage boundaries so the
    Dashboard Sync Pill can display "Downloading…" / "Categorizing X of Y".
    """
    async def _emit(stage: str, current: int, total: int | None) -> None:
        if job_id:
            await job_queue.update_job(job_id, progress={
                "stage": stage, "current": current, "total": total,
            })

    if reset_cursor:
        await db.plaid_items.update_one(
            {"id": item["id"]}, {"$set": {"cursor": None, "updated_at": now_iso()}},
        )
        item = await db.plaid_items.find_one({"id": item["id"]})

    await _emit("downloading", 0, None)

    cursor = item.get("cursor") if not reset_cursor else None
    synced = plaid_service.sync_transactions(item["access_token"], cursor)
    await db.plaid_items.update_one({"id": item["id"]}, {"$set": {
        "cursor": synced["next_cursor"], "updated_at": now_iso(),
    }})
    await plaid_connect._apply_sync_balance_snapshot(item, synced.get("accounts") or [])
    item = await db.plaid_items.find_one({"id": item["id"]}) or item

    # Pending→posted transitions
    for rt in synced.get("removed") or []:
        rid = rt.get("transaction_id") if isinstance(rt, dict) else rt
        if rid:
            await db.transactions.delete_one({
                "company_id": company_id, "plaid_transaction_id": rid,
            })

    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    fallback_bank = next((a for a in accts if a["code"] == "1010"), None)
    if not fallback_bank:
        return 0
    mappings = item.get("account_mappings") or {}

    by_bank: dict[str, list[dict]] = {}
    for t in synced["added"]:
        mapping = mappings.get(t["account_id"])
        ledger_bank = (
            next((a for a in accts if a["id"] == mapping["ledger_account_id"]),
                 fallback_bank) if mapping else fallback_bank
        )
        by_bank.setdefault(ledger_bank["id"], []).append(t)

    total_target = len(synced["added"])
    await _emit("categorizing", 0, total_target)

    imported = 0
    for bank_id, txns in by_bank.items():
        ledger_bank = next(a for a in accts if a["id"] == bank_id)
        inserted, _skipped = await plaid_connect.categorize_and_insert_plaid_txns(
            company_id, txns, ledger_bank, coa, accts,
            categorize_fn=_categorize_fn, is_period_closed_fn=_is_period_closed,
        )
        imported += len(inserted)
        await _emit("categorizing", imported, total_target)
    return imported


# ---------------------------------------------------------------------------
# Registration — called from FastAPI startup
# ---------------------------------------------------------------------------

def register_all() -> None:
    """Register every task with the in-process job queue. Idempotent."""
    job_queue.register_task("plaid_manual_sync", plaid_manual_sync)
    job_queue.register_task("plaid_reset_resync", plaid_reset_resync)
    job_queue.register_task("plaid_contact_backfill", plaid_contact_backfill)


__all__ = [
    "plaid_manual_sync",
    "plaid_reset_resync",
    "plaid_contact_backfill",
    "register_all",
]
