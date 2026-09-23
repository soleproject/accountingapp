"""HTTP surfaces for the cleanup workflow.

Two endpoints:

* ``POST /companies/{cid}/cleanup/kickoff`` — enqueue a scan job when
  the user opts into any of the three compliance flags on `/welcome`.
  Called from `Welcome.jsx::proceed()` right after the `compliance_flags`
  PATCH succeeds. Idempotent — repeated calls just refresh the job's
  ``scheduled_at`` timestamp so late clicks don't spawn duplicates.

* ``GET  /companies/{cid}/cleanup/status`` — lightweight status probe
  the Cockpit + Client Cockpit poll so they know whether to show a
  "Preparing your clean-up list…" placeholder card while a scan is
  still running. Returns ``{status, scheduled_at, batch_id?}``.
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from db import db
from routes.companies import require_company

log = logging.getLogger("axiom.cleanup")
router = APIRouter(prefix="/api")


def _now() -> datetime:
    return datetime.now(timezone.utc)


@router.post("/companies/{cid}/cleanup/kickoff")
async def kickoff_cleanup(cid: str, user: dict = Depends(get_current_user)):
    """Read the company's ``compliance_flags`` and enqueue a scan.

    We deliberately schedule ~24h out (± random jitter) rather than
    running immediately: Plaid's initial historical sync is
    asynchronous and can take up to 24h for slower banks. Running
    before that lands would miss transactions. The scheduler also
    double-checks Plaid readiness at run time and re-defers if needed.
    """
    await require_company(user, cid)
    company = await db.companies.find_one(
        {"id": cid},
        {"_id": 0, "compliance_flags": 1},
    )
    if not company:
        raise HTTPException(404, "Company not found")
    cf = company.get("compliance_flags") or {}
    flags = {
        "irs":         bool(cf.get("flag_irs_docs")),
        "receipts":    bool(cf.get("flag_receipts")),
        "liabilities": bool(cf.get("flag_split_liabilities")),
    }
    if not any(flags.values()):
        return {"ok": True, "queued": False, "reason": "no flags enabled"}

    months = {
        "irs":         cf.get("flag_irs_docs_months") or 12,
        "receipts":    cf.get("flag_receipts_months") or 12,
        "liabilities": cf.get("flag_split_liabilities_months") or 12,
    }

    # 24h base delay + up to 24h jitter — spreads new opt-ins across
    # a full day so a mass-signup event doesn't slam the scheduler at
    # the same minute the next morning.
    delay_hours = 24 + random.uniform(0, 24)
    scheduled_at = (_now() + timedelta(hours=delay_hours)).isoformat()

    # Idempotent: if a pending job already exists for this company,
    # just refresh its schedule + flags. Otherwise insert a new one.
    existing = await db.cleanup_jobs.find_one({
        "company_id": cid, "status": {"$in": ["pending", "deferred"]},
    })
    if existing:
        await db.cleanup_jobs.update_one(
            {"id": existing["id"]},
            {"$set": {
                "flags": flags,
                "months": months,
                "scheduled_at": scheduled_at,
                "status": "pending",
                "updated_at": _now().isoformat(),
            }},
        )
        return {"ok": True, "queued": True, "job_id": existing["id"], "reused": True}

    job_id = str(uuid.uuid4())
    await db.cleanup_jobs.insert_one({
        "id": job_id,
        "company_id": cid,
        "flags": flags,
        "months": months,
        "status": "pending",
        "scheduled_at": scheduled_at,
        "created_at": _now().isoformat(),
        "started_at": None,
        "completed_at": None,
        "items_created": 0,
        "items_total": 0,
        "error": None,
        "retries": 0,
        "defer_count": 0,
        "created_by": user.get("id"),
    })
    return {"ok": True, "queued": True, "job_id": job_id, "scheduled_at": scheduled_at}


@router.get("/companies/{cid}/cleanup/status")
async def cleanup_status(cid: str, user: dict = Depends(get_current_user)):
    """Return a compact status summary so the Cockpit can render a
    "Preparing your clean-up list…" placeholder or the real card."""
    await require_company(user, cid)
    job = await db.cleanup_jobs.find_one(
        {"company_id": cid},
        {"_id": 0, "id": 1, "status": 1, "scheduled_at": 1,
         "completed_at": 1, "items_total": 1, "batch_id": 1, "error": 1},
        sort=[("created_at", -1)],
    )
    batch = await db.client_review_batches.find_one(
        {"company_id": cid, "kind": "cleanup"},
        {"_id": 0, "id": 1, "status": 1, "last_scan_at": 1,
         "items": 1},
    )
    total_items = len(batch.get("items") or []) if batch else 0
    open_items  = sum(1 for i in (batch or {}).get("items") or []
                       if not i.get("answered_at"))
    return {
        "job": job,
        "batch_id": (batch or {}).get("id"),
        "batch_status": (batch or {}).get("status"),
        "total_items": total_items,
        "open_items": open_items,
        "last_scan_at": (batch or {}).get("last_scan_at"),
    }
