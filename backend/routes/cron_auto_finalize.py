"""Nightly auto-finalize sweep.

Runs `bootstrap_from_plaid(cid, recent_only=True)` for every company that
has a Plaid connection and recent enough snapshot data to be trusted.
Fills the dormant-company gap — companies that never trigger an org-chart
Plaid sync (no user logins, silent webhook stream) still get their prior
month auto-reconciled within 24h of the 5-day settle threshold.

Called by the Emergent cron platform (see .emergent/crons.yml) with a
Bearer token. Idempotent via the per-company advisory lock inside
`bootstrap_from_plaid`.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Query

from auth import require_role
from db import db

log = logging.getLogger("axiom.cron.auto_finalize")

router = APIRouter(prefix="/api/cron", tags=["cron"])

# How stale a Plaid snapshot can be before we skip the company. Fresh
# enough that integrity check #1 (ledger == Plaid balance) is trustworthy.
_SNAPSHOT_STALE_HOURS = 48


def _constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


async def _run_sweep() -> dict:
    """Backgrounded worker — iterate companies with Plaid items, run
    `bootstrap_from_plaid(recent_only=True)`. Returns a tiny stats dict
    we log for operational visibility.
    """
    from reconciliation_engine import bootstrap_from_plaid

    stats = {"companies": 0, "processed": 0, "skipped_stale": 0, "errors": 0,
             "created": 0, "elapsed_ms": 0}
    t0 = datetime.now(timezone.utc)
    now_dt = t0
    stale_cutoff = (now_dt - timedelta(hours=_SNAPSHOT_STALE_HOURS)).isoformat()

    # Distinct companies that have at least one Plaid item.
    company_ids: set[str] = set()
    freshest_sync: dict[str, str] = {}
    async for item in db.plaid_items.find(
        {}, {"_id": 0, "company_id": 1, "updated_at": 1, "last_synced_at": 1},
    ):
        cid = item.get("company_id")
        if not cid:
            continue
        company_ids.add(cid)
        # Track the freshest sync timestamp per company.
        sync_ts = str(item.get("last_synced_at") or item.get("updated_at") or "")
        if sync_ts and sync_ts > freshest_sync.get(cid, ""):
            freshest_sync[cid] = sync_ts

    stats["companies"] = len(company_ids)
    for cid in company_ids:
        last = freshest_sync.get(cid, "")
        if last and last < stale_cutoff:
            # Dormant company — Plaid snapshot too stale to be
            # trustworthy. Skip; a real sync will trigger auto-recon
            # when the user eventually logs in or Plaid webhook fires.
            stats["skipped_stale"] += 1
            continue
        try:
            r = await bootstrap_from_plaid(cid, recent_only=True)
            stats["processed"] += 1
            stats["created"] += len(r.get("created") or [])
        except Exception as e:  # noqa: BLE001
            log.warning("auto_finalize sweep failed for cid=%s err=%s", cid, e)
            stats["errors"] += 1

    stats["elapsed_ms"] = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    log.info("auto_finalize sweep done: %s", stats)
    # Persist two breadcrumbs so an on-call pro can inspect last-run status.
    # 1) `cron_runs` — latest run per cron name (upsert, one doc).
    # 2) `cron_run_history` — append-only log (last ~90 days worth) so the
    #    admin page can show a run-timeline, not just the most recent state.
    try:
        await db.cron_runs.update_one(
            {"name": "auto_finalize_reconciliations"},
            {"$set": {
                "name": "auto_finalize_reconciliations",
                "last_run_at": now_dt.isoformat(),
                "last_stats": stats,
            }},
            upsert=True,
        )
        await db.cron_run_history.insert_one({
            "name": "auto_finalize_reconciliations",
            "run_at": now_dt.isoformat(),
            "stats": stats,
        })
        # Trim history to last 500 docs per cron name — plenty for an audit
        # trail without unbounded growth.
        total = await db.cron_run_history.count_documents(
            {"name": "auto_finalize_reconciliations"},
        )
        if total > 500:
            # Drop the oldest (total - 500) rows.
            to_drop = total - 500
            async for doc in db.cron_run_history.find(
                {"name": "auto_finalize_reconciliations"},
                {"_id": 1},
            ).sort("run_at", 1).limit(to_drop):
                await db.cron_run_history.delete_one({"_id": doc["_id"]})
    except Exception:  # noqa: BLE001
        pass
    return stats


# Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
@router.post("/auto-finalize-reconciliations")
async def auto_finalize_cron(
    request: Request,
    authorization: str | None = Header(None),
    x_webhook_id: str | None = Header(None),
):
    """Nightly: for every company with a Plaid connection, run the
    narrow-window reconciliation finalize. Fills the dormant-company
    gap left by the normal post-sync hook (plaid_connect.py).

    Platform contract: ack 2xx within ~5s; actual work runs as a
    detached asyncio task so the dispatcher is never blocked.
    """
    secret = os.environ.get("WEBHOOK_CRON_SECRET")
    if not secret:
        # Fail closed — never run if the secret isn't configured.
        raise HTTPException(500, "WEBHOOK_CRON_SECRET not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer")
    token = authorization.split(" ", 1)[1].strip()
    if not _constant_time_eq(token, secret):
        raise HTTPException(401, "invalid bearer")

    # Fire and forget — the sweep is idempotent (per-company lock inside
    # bootstrap_from_plaid), so even if the cron double-fires nothing bad
    # happens. We only need to ack the dispatcher.
    asyncio.create_task(_run_sweep())
    return {"accepted": True, "run_id": x_webhook_id or ""}


# --- Admin surface: last-run status + history, and a manual trigger ----
@router.get("/runs", tags=["admin"])
async def list_cron_runs(
    limit: int = Query(50, ge=1, le=500),
    user: dict = Depends(require_role("superadmin")),
):
    """Return latest state per cron + recent run history. Backs the
    admin Cron Runs panel so pros can see 'last sweep ran at 2:15am ·
    23 companies, 7 finalized, 2 errors' at a glance.
    """
    latest = []
    async for d in db.cron_runs.find({}, {"_id": 0}).sort("last_run_at", -1):
        latest.append(d)
    history = []
    async for d in db.cron_run_history.find({}, {"_id": 0}).sort("run_at", -1).limit(limit):
        history.append(d)
    return {"latest": latest, "history": history}


@router.post("/runs/trigger", tags=["admin"])
async def trigger_cron_now(
    user: dict = Depends(require_role("superadmin")),
):
    """Manually fire the auto-finalize sweep right now (admin-only).
    Same backgrounded worker as the nightly cron — handy for ad-hoc
    runs and for confirming the sweep is working without waiting
    until 02:15 UTC.
    """
    asyncio.create_task(_run_sweep())
    return {"accepted": True, "triggered_at": datetime.now(timezone.utc).isoformat()}

