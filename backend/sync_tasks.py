"""In-process sync tasks — executed by `job_queue.enqueue_job()`.

Replaces the previous `worker.py` arq module. Same task functions, just no
`ctx` first argument (no arq redis pool) and no `WorkerSettings` class.

Every task manages its own status transitions via `job_queue.update_job`;
the enqueue wrapper only catches un-caught exceptions as a safety net.
"""
from __future__ import annotations
import asyncio
import logging
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

    # Belt-and-suspenders date-floor filter. `days_requested` at
    # link-token time SHOULD keep Plaid from returning txns older
    # than the user's chosen start date, but some institutions
    # occasionally over-serve. Drop anything under the floor here
    # so a Plaid inconsistency can't sneak old data past the cutoff.
    import_start_date = item.get("import_start_date")
    added = synced["added"]
    if import_start_date:
        added = [t for t in added
                  if (t.get("date") or "") >= import_start_date]

    by_bank: dict[str, list[dict]] = {}
    for t in added:
        mapping = mappings.get(t["account_id"])
        ledger_bank = (
            next((a for a in accts if a["id"] == mapping["ledger_account_id"]),
                 fallback_bank) if mapping else fallback_bank
        )
        by_bank.setdefault(ledger_bank["id"], []).append(t)

    total_target = len(added)
    await _emit("categorizing", 0, total_target)

    imported = 0
    inserted_all: list[dict] = []
    for bank_id, txns in by_bank.items():
        ledger_bank = next(a for a in accts if a["id"] == bank_id)
        inserted, _skipped = await plaid_connect.categorize_and_insert_plaid_txns(
            company_id, txns, ledger_bank, coa, accts,
            categorize_fn=_categorize_fn, is_period_closed_fn=_is_period_closed,
        )
        imported += len(inserted)
        inserted_all.extend(inserted)
        await _emit("categorizing", imported, total_target)

    company_doc = await db.companies.find_one({"id": company_id})
    mode = (company_doc or {}).get("categorization_mode") or "standard"

    # Standard+ Beta override — Global Vendor Rules run over the rows
    # Standard just inserted, overriding category selection where a
    # curated merchant rule matches with confidence >= 0.50. Contact
    # matching + AI confidence/reasoning from Standard are preserved —
    # only the category is potentially overridden.
    if imported > 0 and mode == "standard_plus":
        try:
            import standard_plus_categorizer
            ins_ids = [t["id"] for t in inserted_all if t.get("id")]
            await standard_plus_categorizer.apply_global_rules_override(
                company_id, ins_ids,
            )
        except Exception as e:  # noqa: BLE001 — never fail the sync
            import logging
            logging.getLogger("axiom.app").warning(
                "Standard+ post-hook failed cid=%s: %s", company_id, e,
            )

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
            # Skip if we have no Plaid balance snapshot for this account —
            # without it, the math would anchor opening to `0 - net_movement`
            # and post a bogus JE. Better to leave the mapping in a healable
            # state and let a subsequent sync (which refreshes the snapshot
            # via `_apply_sync_balance_snapshot`) fix it.
            if not plaid_acct or plaid_acct.get("balance_current") is None:
                continue
            snap = float(plaid_acct.get("balance_current") or 0.0)
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
# Plaid backfill polling — durable + semaphore-safe
# ---------------------------------------------------------------------------
#
# Why this is not a `job_queue` task (Feb 2026 lesson):
# The natural design would be to enqueue a delayed sync task that
# calls `asyncio.sleep(delay)` before doing work. But `job_queue.enqueue_job`
# runs its tasks inside `_run_wrapped`, which holds a shared semaphore
# (`MAX_CONCURRENT_SYNCS=20` per pod). Sleeping 30s–30m inside that
# semaphore causes a *priority inversion*: at 1,000+ concurrent
# onboardings, all 20 semaphore slots per pod could be occupied by
# sleeping polls while real webhook + manual syncs queue up behind
# them. So instead of running the delay inside a queued task, we:
#
#   1. Persist `next_backfill_poll_at` + `next_backfill_poll_attempt`
#      directly on the `plaid_items` document. This is what makes it
#      DURABLE — a pod restart doesn't lose scheduled polls.
#
#   2. Spawn a lightweight fire-and-forget `asyncio.create_task` timer
#      that sleeps outside the semaphore, then enqueues the ACTUAL
#      sync work via `plaid_manual_sync` (which does hold the
#      semaphore, but only while doing real work).
#
#   3. On backend startup, `reconcile_pending_backfill_polls` scans
#      `plaid_items` for any item with a future `next_backfill_poll_at`
#      and re-arms an in-process timer for it.
#
# Stops early when: (a) the requested `import_start_date` floor is
# reached, or (b) a real Plaid `HISTORICAL_UPDATE` webhook stamps
# `historical_update_received: True`. Final attempt sends
# `webhook_code="HISTORICAL_UPDATE"` so opening-balance JEs still land
# even when Plaid never fires its own webhook.

_BACKFILL_POLL_DELAYS = [30, 120, 300, 900, 1800]  # seconds

# Set holds a reference to every live in-process timer so the GC
# doesn't reap them mid-sleep. Auto-cleaned via done_callback.
_active_backfill_timers: set[asyncio.Task] = set()


async def schedule_plaid_backfill_poll(
    company_id: str, item_id: str, attempt: int = 0,
) -> None:
    """Schedule the next Plaid backfill poll for the given item.

    Persists `next_backfill_poll_at` on the plaid_items row (so a pod
    restart can re-arm) and starts an in-process timer that will fire
    the actual sync after the delay expires.

    Idempotent: if a timer is already armed for a future poll on this
    item, this call replaces it with a newer schedule.
    """
    from datetime import datetime, timezone, timedelta

    if attempt >= len(_BACKFILL_POLL_DELAYS):
        return  # No more attempts.

    delay = _BACKFILL_POLL_DELAYS[attempt]
    next_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
    await db.plaid_items.update_one(
        {"id": item_id},
        {"$set": {
            "next_backfill_poll_at": next_at.isoformat(),
            "next_backfill_poll_attempt": attempt,
            "updated_at": now_iso(),
        }},
    )

    task = asyncio.create_task(
        _backfill_timer(company_id, item_id, attempt, delay),
        name=f"plaid_backfill_timer:{item_id[:8]}:a{attempt}",
    )
    _active_backfill_timers.add(task)
    task.add_done_callback(_active_backfill_timers.discard)


async def _backfill_timer(
    company_id: str, item_id: str, attempt: int, delay: float,
) -> None:
    """The actual timer body — sleeps outside any semaphore, then
    enqueues a real sync job.

    Runs as a fire-and-forget asyncio task. Errors are swallowed (and
    logged) so a single bad item can't crash the pod.
    """
    log = logging.getLogger("axiom.app")
    try:
        await asyncio.sleep(delay)

        # Re-check the item: maybe HISTORICAL_UPDATE already landed while
        # we were sleeping, or the item was deleted. Either way, stop.
        item = await db.plaid_items.find_one({"id": item_id})
        if not item:
            return
        if item.get("historical_update_received"):
            await _clear_poll_schedule(item_id)
            return

        # Enqueue the real sync as a normal queued job. This is what
        # actually acquires the sync semaphore — sleep already done.
        # Last attempt uses `HISTORICAL_UPDATE` trigger so opening
        # balance JEs land even if Plaid never fires its own webhook.
        last = attempt >= len(_BACKFILL_POLL_DELAYS) - 1
        trigger = "HISTORICAL_UPDATE" if last else "BACKFILL_POLL"
        job_id = await job_queue.enqueue_job(
            "plaid_manual_sync", company_id, user_id=None,
            webhook_code=trigger,
        )

        # Wait briefly (up to 5 min) for the sync to finish so we can
        # decide whether to schedule the next attempt based on its
        # result. If it doesn't finish in time, we optimistically
        # schedule the next attempt anyway — the follow-up sync will
        # dedup against any in-flight or completed one.
        result = await _await_job(job_id, timeout=300)
        imported = int((result or {}).get("imported") or 0)

        # Post-sync: did we reach the requested import_start_date floor?
        item = await db.plaid_items.find_one({"id": item_id}) or item
        floor = item.get("import_start_date")
        reached_floor = False
        if floor:
            oldest = await db.transactions.find_one(
                {"company_id": company_id,
                 "plaid_transaction_id": {"$ne": None}},
                sort=[("date", 1)], projection={"date": 1},
            )
            if oldest and (oldest.get("date") or "") <= floor:
                reached_floor = True

        # Decide whether to schedule the next attempt.
        # STOP if: last attempt just ran, or we reached the floor, or
        # this attempt imported 0 rows AND we've already had 2+ zero-
        # imports (Plaid is done shipping data).
        if last:
            await _clear_poll_schedule(item_id)
            return
        if reached_floor:
            await _clear_poll_schedule(item_id)
            return

        # Otherwise arm the next attempt.
        await schedule_plaid_backfill_poll(company_id, item_id, attempt + 1)

    except Exception:  # noqa: BLE001 — never crash a pod on a poll
        log.warning(
            "Plaid backfill timer failed cid=%s item=%s attempt=%s: %s",
            company_id, item_id, attempt, traceback.format_exc(),
        )


async def _await_job(job_id: str, timeout: int = 300) -> dict | None:
    """Poll the sync_jobs row until it's terminal or the timeout elapses."""
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        j = await db.sync_jobs.find_one({"id": job_id})
        if j and j.get("status") in ("completed", "failed"):
            return j.get("result") or {}
        await asyncio.sleep(5)
    return None


async def _clear_poll_schedule(item_id: str) -> None:
    await db.plaid_items.update_one(
        {"id": item_id},
        {"$unset": {"next_backfill_poll_at": "",
                    "next_backfill_poll_attempt": ""},
         "$set": {"updated_at": now_iso()}},
    )


async def reconcile_pending_backfill_polls() -> int:
    """Called at backend startup. Scans plaid_items for pending polls
    persisted before the last shutdown/redeploy and re-arms an
    in-process timer for each.

    Returns the number of timers armed.
    """
    from datetime import datetime, timezone
    log = logging.getLogger("axiom.app")
    now = datetime.now(timezone.utc)
    armed = 0
    async for item in db.plaid_items.find({
        "next_backfill_poll_at": {"$ne": None},
        "historical_update_received": {"$ne": True},
    }):
        try:
            due_at = datetime.fromisoformat(item["next_backfill_poll_at"])
        except (TypeError, ValueError):
            continue
        remaining = max(0, (due_at - now).total_seconds())
        attempt = int(item.get("next_backfill_poll_attempt") or 0)
        task = asyncio.create_task(
            _backfill_timer(
                item["company_id"], item["id"], attempt, remaining,
            ),
            name=f"plaid_backfill_timer:{item['id'][:8]}:a{attempt}:resumed",
        )
        _active_backfill_timers.add(task)
        task.add_done_callback(_active_backfill_timers.discard)
        armed += 1
    if armed:
        log.info("Reconciled %d pending Plaid backfill polls", armed)
    return armed


# ---------------------------------------------------------------------------
# Opening-balance self-heal — durable safety net beyond webhook + poll chain
# ---------------------------------------------------------------------------
#
# Why this exists (Feb 2026, discovered in production):
# The OBE JE for a Plaid-linked ledger account is normally posted via one
# of three pathways:
#
#   1. Plaid's `HISTORICAL_UPDATE` webhook   (primary)
#   2. In-process backfill poll chain        (fallback for missed webhooks,
#      max ~1h coverage across 5 attempts)
#   3. Manual reset-and-resync from the UI   (last-resort user action)
#
# All three call `_post_deferred_plaid_opening_balances`, which is
# idempotent. However, real-world edge cases can leak past all three:
#
#   * Item connected BEFORE the poll-chain safety net shipped
#   * Webhook URL misconfigured in Plaid dashboard for a given env
#   * Pod restart mid-poll BEFORE `historical_update_received` was
#     stamped AND before `next_backfill_poll_at` reconciler existed
#   * All 5 poll attempts happened during a transient Plaid outage
#
# When that leak happens, the ledger shows the bank account with a $0
# opening line where it should show the true opening balance. The
# `plaid_current` snapshot on the item and the imported transactions
# together are sufficient to derive the OBE — no user action needed.
#
# So we run a **startup self-heal scan** that finds any plaid_item whose
# `account_mappings` contain an entry missing `opening_je_id` AND has
# imported transactions, and posts the OBE JE using the exact same math
# the webhook pathway uses. Idempotent — sets `opening_je_id` on the
# mapping, so subsequent scans no-op.
#
# Also exposed via a per-company endpoint (`/plaid/heal-opening-
# balances`) so a bookkeeper can trigger it manually without waiting
# for a restart.

async def heal_missing_plaid_opening_balances_for_item(
    company_id: str, item_id: str,
) -> dict:
    """Heal missing OBE JEs for a single Plaid item. Returns a summary
    dict with `healed` (list of plaid_account_ids that got a fresh JE),
    `already_ok` (list of plaid_account_ids that already had one), and
    `no_txns` (list that had no imported txns yet — nothing to anchor).
    """
    item = await db.plaid_items.find_one({"id": item_id})
    if not item:
        return {"ok": False, "reason": "item_not_found"}
    mappings = item.get("account_mappings") or {}
    already_ok = [pa for pa, m in mappings.items() if m.get("opening_je_id")]

    # Snapshot the set of plaid_account_ids missing an OBE JE BEFORE
    # calling the deferred helper (which mutates the mapping).
    to_heal = [pa for pa, m in mappings.items() if not m.get("opening_je_id")]

    # Delegate to the exact same routine the webhook pathway uses.
    # Idempotent — safe to call repeatedly.
    await _post_deferred_plaid_opening_balances(company_id, item)

    # Re-read the item to see which JEs actually got posted.
    refreshed = await db.plaid_items.find_one({"id": item_id}) or item
    refreshed_mappings = refreshed.get("account_mappings") or {}
    healed: list[str] = []
    no_txns: list[str] = []
    for pa in to_heal:
        if (refreshed_mappings.get(pa) or {}).get("opening_je_id"):
            healed.append(pa)
        else:
            no_txns.append(pa)
    return {
        "ok": True,
        "item_id": item_id,
        "healed": healed,
        "already_ok": already_ok,
        "no_txns": no_txns,
    }


async def heal_missing_plaid_opening_balances_for_company(
    company_id: str,
) -> dict:
    """Iterate every plaid_item on a company and heal each in turn."""
    items = await db.plaid_items.find({"company_id": company_id}).to_list(200)
    per_item: list[dict] = []
    healed_total = 0
    for it in items:
        res = await heal_missing_plaid_opening_balances_for_item(
            company_id, it["id"],
        )
        per_item.append(res)
        healed_total += len(res.get("healed") or [])
    return {"ok": True, "healed_count": healed_total, "items": per_item}


async def heal_all_missing_plaid_opening_balances() -> int:
    """Startup scan: find every plaid_item across ALL companies with a
    mapping missing `opening_je_id`, and post the OBE JE. Returns the
    total number of JEs healed. Idempotent and safe to run on every
    boot — mappings that already have an `opening_je_id` are skipped.
    """
    log = logging.getLogger("axiom.app")
    healed_total = 0
    # Match ANY plaid_item that has at least one mapping missing an
    # opening_je_id. Uses a wildcard $exists check on the nested field.
    cursor = db.plaid_items.find({
        "account_mappings": {"$exists": True, "$ne": {}},
    })
    scanned = 0
    async for item in cursor:
        scanned += 1
        mappings = item.get("account_mappings") or {}
        # Cheap in-python filter (avoids a scary Mongo aggregation on
        # dynamic keys): are ANY of this item's mappings missing an
        # opening_je_id?
        if not any(not (m or {}).get("opening_je_id") for m in mappings.values()):
            continue
        try:
            res = await heal_missing_plaid_opening_balances_for_item(
                item["company_id"], item["id"],
            )
            healed_total += len(res.get("healed") or [])
        except Exception as e:  # noqa: BLE001
            log.warning(
                "heal_all_missing_plaid_opening_balances: item=%s cid=%s err=%s",
                item.get("id"), item.get("company_id"), e,
            )
    if healed_total:
        log.info(
            "Startup OBE self-heal: scanned=%d, healed=%d journal entries",
            scanned, healed_total,
        )
    return healed_total


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
    "schedule_plaid_backfill_poll",
    "reconcile_pending_backfill_polls",
    "heal_missing_plaid_opening_balances_for_item",
    "heal_missing_plaid_opening_balances_for_company",
    "heal_all_missing_plaid_opening_balances",
    "register_all",
]
