"""Arq worker — executes long-running Plaid tasks off the API request thread.

Tasks are named to match `job_queue.enqueue_job(kind=...)`. Every task follows
the same shape:
    1. mark job status='running' + stamp started_at
    2. do the work — may push progress updates
    3. on success → status='completed', result=<payload>, finished_at
       on failure → status='failed', error=<msg>, finished_at (arq will retry)

Idempotency: our writes dedupe on (company_id, plaid_transaction_id) unique
index, so a retry after a mid-flight worker crash never double-posts.
"""
from __future__ import annotations
import os
import asyncio
import traceback
from typing import Any

from arq.connections import RedisSettings

from db import db, now_iso
import job_queue
import plaid_service
import plaid_connect
import categorizer
import contact_resolver
from ai_service import categorize_transaction as _categorize_fn, resolve_contact_ai

_REDIS_URL = os.environ["REDIS_URL"]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def _mark_started(job_id: str) -> None:
    await job_queue.update_job(job_id, status="running", started_at=now_iso())


async def _mark_done(job_id: str, result: dict) -> None:
    await job_queue.update_job(
        job_id, status="completed", result=result, finished_at=now_iso(),
    )


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

async def plaid_manual_sync(ctx: dict, job_id: str, company_id: str) -> None:
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
        imported = await _run_sync(company_id, item, reset_cursor=False)
        await _mark_done(job_id, {"imported": imported})
    except Exception:  # noqa: BLE001
        await _mark_failed(job_id, traceback.format_exc())
        raise


# ---------------------------------------------------------------------------
# Task: reset cursor + full re-pull (used to rescue stuck items)
# ---------------------------------------------------------------------------

async def plaid_reset_resync(ctx: dict, job_id: str, company_id: str) -> None:
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
        imported = await _run_sync(company_id, item, reset_cursor=True)
        await _mark_done(job_id, {"reset": True, "imported": imported})
    except Exception:  # noqa: BLE001
        await _mark_failed(job_id, traceback.format_exc())
        raise


# ---------------------------------------------------------------------------
# Task: contact backfill (rare — used after a schema/rule change)
# ---------------------------------------------------------------------------

async def plaid_contact_backfill(ctx: dict, job_id: str, company_id: str) -> None:
    await _mark_started(job_id)
    try:
        # Import lazily so the worker doesn't drag in FastAPI middleware.
        from server import _run_contact_backfill  # type: ignore
        summary = await _run_contact_backfill(company_id)
        await _mark_done(job_id, summary)
    except ImportError:
        # Fallback: run inline via contact_resolver
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

async def _run_sync(company_id: str, item: dict, *, reset_cursor: bool) -> int:
    """Pull txns from Plaid + route through the PFC pipeline. Returns count
    of inserted rows. Reuses the exact same helpers the API used inline —
    just now runs off the request thread.
    """
    if reset_cursor:
        await db.plaid_items.update_one(
            {"id": item["id"]}, {"$set": {"cursor": None, "updated_at": now_iso()}},
        )
        item = await db.plaid_items.find_one({"id": item["id"]})

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

    # Group by mapped ledger bank
    by_bank: dict[str, list[dict]] = {}
    for t in synced["added"]:
        mapping = mappings.get(t["account_id"])
        ledger_bank = (
            next((a for a in accts if a["id"] == mapping["ledger_account_id"]),
                 fallback_bank) if mapping else fallback_bank
        )
        by_bank.setdefault(ledger_bank["id"], []).append(t)

    imported = 0
    for bank_id, txns in by_bank.items():
        ledger_bank = next(a for a in accts if a["id"] == bank_id)
        inserted, _skipped = await plaid_connect.categorize_and_insert_plaid_txns(
            company_id, txns, ledger_bank, coa, accts,
            categorize_fn=_categorize_fn, is_period_closed_fn=_is_period_closed,
        )
        imported += len(inserted)
    return imported


# ---------------------------------------------------------------------------
# Arq worker settings
# ---------------------------------------------------------------------------

async def _on_startup(ctx: dict) -> None:
    await job_queue.ensure_jobs_indexes()


class WorkerSettings:
    """Consumed by `arq worker.WorkerSettings` via supervisor."""
    functions = [
        plaid_manual_sync,
        plaid_reset_resync,
        plaid_contact_backfill,
    ]
    on_startup = _on_startup
    redis_settings = RedisSettings.from_dsn(_REDIS_URL)
    # Concurrency: 20 tasks per worker. Under load add more replicas rather
    # than raise this — MongoDB has ~100 connections/pod default.
    max_jobs = 20
    # Retries — task lasting >600s is likely deadlocked.
    job_timeout = 600
    max_tries = 3
