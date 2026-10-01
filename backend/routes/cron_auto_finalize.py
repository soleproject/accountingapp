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

from fastapi import APIRouter, Header, HTTPException, Request

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
    # Persist a tiny breadcrumb so an on-call pro can inspect last-run status.
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
