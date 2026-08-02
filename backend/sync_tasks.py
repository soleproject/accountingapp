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
            await get_cache().ainvalidate(doc["company_id"])
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

async def plaid_manual_sync(
    job_id: str, company_id: str, webhook_code: str | None = None,
) -> None:
    """Cursor-based delta sync — the "hey, anything new since last time?"
    version. Fast, typically <2 seconds. Runs the PFC-first pipeline for
    every new row.

    `webhook_code` (when set) tells the sync worker WHICH Plaid event
    triggered this run. Opening balance JEs are only posted after
    `HISTORICAL_UPDATE` because that's the event that guarantees the
    historical backfill (up to 24 months) has landed. Firing on
    `INITIAL_UPDATE` would anchor the JE ~30 days back, which is wrong
    once the historical data expands the date range.
    """
    await _mark_started(job_id)
    try:
        item = await db.plaid_items.find_one({"company_id": company_id})
        if not item:
            await _mark_failed(job_id, "No Plaid item linked")
            return
        imported = await _run_sync(
            company_id, item, reset_cursor=False, job_id=job_id,
            trigger=webhook_code,
        )
        await _mark_done(job_id, {"imported": imported,
                                  "webhook_code": webhook_code})
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
        imported = await _run_sync(
            company_id, item, reset_cursor=True, job_id=job_id,
            # A full re-page always brings complete history, so treat it
            # as equivalent to HISTORICAL_UPDATE for OBE JE posting.
            trigger="HISTORICAL_UPDATE",
        )
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
                    job_id: str | None = None,
                    trigger: str | None = None) -> int:
    """Pull txns from Plaid + route through the PFC pipeline. Returns count
    of inserted rows.

    Emits progress updates to `sync_jobs.progress` at stage boundaries so the
    Dashboard Sync Pill can display "Downloading…" / "Categorizing X of Y".

    `trigger` is the Plaid webhook code (`INITIAL_UPDATE`,
    `HISTORICAL_UPDATE`, `DEFAULT_UPDATE`, `SYNC_UPDATES_AVAILABLE`) that
    kicked off this sync — used to decide whether to post the deferred
    opening balance JEs at the end. Reset-resync (nuclear re-pull)
    passes `trigger="HISTORICAL_UPDATE"` to force the post since a full
    re-page always brings the complete history.
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
    synced = plaid_service.sync_transactions(plaid_service.token_from_item(item), cursor)
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

    # Post-sync: auto-detect internal transfers between company-owned bank
    # accounts. If the user linked BOTH sides of a transfer via Plaid, this
    # collapses the pair to the Inter-Account Transfer equity account so
    # neither leg pollutes the P&L. Silent on failure — never blocks the
    # sync from returning.
    if imported > 0:
        try:
            from routes.transactions import detect_transfer_pairs
            await _emit("detecting_transfers", imported, total_target)
            await detect_transfer_pairs(company_id, dry_run=False)
        except Exception as e:
            import logging
            logging.getLogger("axiom.app").warning(
                "internal-transfer detector failed after sync for cid=%s: %s", company_id, e
            )

    # Post-sync: opening-balance JE for each Plaid-linked ledger account
    # — only after HISTORICAL_UPDATE (or a manual reset-resync). This is
    # the "everything is downloaded" signal, so anchoring the JE at
    # (oldest_txn_date - 1) is correct. Skipped on INITIAL_UPDATE +
    # DEFAULT_UPDATE + SYNC_UPDATES_AVAILABLE because those either lack
    # historical depth or represent normal delta refreshes.
    if trigger == "HISTORICAL_UPDATE":
        await _post_deferred_plaid_opening_balances(company_id, item)
        # Persist the "historical backfill has landed" marker so any
        # future connect-time replay knows OBE JEs are safe to post
        # (see `plaid_connect.sync_plaid_history_for_account`).
        await db.plaid_items.update_one(
            {"id": item["id"]},
            {"$set": {"historical_update_received": True,
                      "historical_update_at": now_iso(),
                      "updated_at": now_iso()}},
        )
        # Re-run the auto-reconciliation bootstrap now that we have the
        # FULL history + a refreshed `opening_as_of` on every mapping.
        # `bootstrap_from_plaid` is idempotent — its `_overlaps` guard
        # skips any month that already has a reconciliation, so the ~30
        # days worth of connect-time recons stay put while every
        # historical month (going back 24 months for most institutions)
        # gets a fresh reconciled record.
        try:
            from reconciliation_engine import bootstrap_from_plaid
            await bootstrap_from_plaid(company_id, plaid_item_id=item["id"])
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger("axiom.app").warning(
                "post-HISTORICAL bootstrap failed for cid=%s: %s",
                company_id, e,
            )
    return imported


async def _post_deferred_plaid_opening_balances(
    company_id: str, item: dict,
) -> None:
    """Fire the initial opening-balance JE for each Plaid-linked ledger
    account exactly once, using the identical math as `plaid_connect.
    sync_plaid_history_for_account`. Idempotent — records the resulting
    JE id back on the mapping so subsequent HISTORICAL_UPDATE syncs
    (e.g. reset_resync) don't double-post.
    """
    try:
        item = await db.plaid_items.find_one({"id": item["id"]}) or item
        mappings = item.get("account_mappings") or {}
        accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
        changed = False
        for pa_id, m in mappings.items():
            if m.get("opening_je_id"):
                continue  # Already posted at connect (or a prior HISTORICAL run).
            ledger_id = m.get("ledger_account_id")
            if not ledger_id:
                continue
            ledger_bank = next((a for a in accts if a["id"] == ledger_id), None)
            if not ledger_bank:
                continue
            all_for_acct = await db.transactions.find(
                {"company_id": company_id, "plaid_account_id": pa_id}
            ).to_list(50000)
            if not all_for_acct:
                continue
            net_movement = sum(float(t.get("amount") or 0) for t in all_for_acct)
            plaid_acct = next(
                (a for a in (item.get("accounts") or [])
                 if a.get("account_id") == pa_id), None,
            )
            snap = float((plaid_acct or {}).get("balance_current") or 0.0)
            is_liability = ledger_bank["type"] == "liability"
            opening = round(
                (snap + net_movement) if is_liability else (snap - net_movement),
                2,
            )
            oldest_date = min(t["date"] for t in all_for_acct)
            as_of = plaid_connect._yesterday_iso(oldest_date)
            memo = (
                f"Opening balance — {ledger_bank['name']} "
                "(posted after Plaid historical backfill)"
            )
            je_id = await plaid_connect.post_opening_balance_je(
                company_id, ledger_bank, opening, as_of, memo,
            )
            if je_id:
                mappings[pa_id]["opening_je_id"] = je_id
                mappings[pa_id]["opening_balance"] = opening
                mappings[pa_id]["opening_as_of"] = as_of
                changed = True
        if changed:
            await db.plaid_items.update_one(
                {"id": item["id"]},
                {"$set": {"account_mappings": mappings,
                          "updated_at": now_iso()}},
            )
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("axiom.app").warning(
            "deferred Plaid opening-balance post failed for cid=%s: %s",
            company_id, e,
        )


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
