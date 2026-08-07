"""QBO OAuth + migration routes.

Endpoints (all mounted under /api):
  POST   /companies/{cid}/qbo/oauth/start      → returns Intuit consent URL
  GET    /qbo/oauth/callback                    → OAuth redirect target
  GET    /companies/{cid}/qbo/status            → connection info
  POST   /companies/{cid}/qbo/disconnect        → revoke tokens + mark disconnected
  GET    /companies/{cid}/qbo/preview           → count(*) per entity
  POST   /companies/{cid}/qbo/migrations        → kick off background import
  GET    /companies/{cid}/qbo/migrations/{jid}  → poll job status
"""
from __future__ import annotations
import asyncio
import uuid
import secrets
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from deps import require_company
import qbo_service as Q

# The OAuth callback runs on api.smartbookssoftware.ai but the user lives
# on app.smartbookssoftware.ai — so every RedirectResponse must include
# the absolute app URL, not a relative /connections/qbo path. Otherwise
# the browser resolves the relative path against api.* and the SPA
# catch-all on the FRONTEND service never sees the query params.
_APP_URL = Q.QBO_APP_URL.rstrip("/")

router = APIRouter(prefix="/api")


class OAuthStartOut(BaseModel):
    url: str


@router.post("/companies/{cid}/qbo/oauth/start", response_model=OAuthStartOut)
async def qbo_oauth_start(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    state = secrets.token_urlsafe(32)
    await db.qbo_oauth_states.insert_one({
        "state": state, "company_id": cid, "user_id": user["id"],
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "created_at": now_iso(),
    })
    return {"url": Q.authorization_url(state)}


@router.get("/qbo/oauth/callback")
async def qbo_oauth_callback(
    code: str = Query(None),
    state: str = Query(None),
    realmId: str = Query(None),
    error: str = Query(None),
):
    """Intuit redirects here after the user consents. Any failure path
    redirects to `/connections/qbo?qbo_error=<reason>` so the frontend
    can surface a useful toast instead of dumping a raw 4xx page."""
    def _err(reason: str, cid: str | None = None) -> RedirectResponse:
        target = f"{_APP_URL}/connections/qbo?qbo_error={reason}"
        return RedirectResponse(target, status_code=302)

    # Intuit itself returned an error (user hit "No thanks", scope
    # rejected, invalid client, etc.). Bail early.
    if error or not code or not state or not realmId:
        return _err(error or "missing_params")

    rec = await db.qbo_oauth_states.find_one_and_delete({"state": state})
    if not rec:
        return _err("state_expired")
    try:
        exp = datetime.fromisoformat(rec["expires_at"])
        if exp < datetime.now(timezone.utc):
            return _err("state_expired")
    except (KeyError, ValueError):
        return _err("state_bad")
    cid = rec["company_id"]
    try:
        tokens = await Q.exchange_code(code, realmId)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception(
            "QBO token exchange failed for cid=%s realm=%s", cid, realmId
        )
        return _err(f"exchange_failed:{str(e)[:120]}")
    try:
        await Q.save_connection(cid, realmId, tokens)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception(
            "QBO save_connection failed for cid=%s", cid
        )
        return _err(f"save_failed:{str(e)[:120]}")
    # Success — land the user on the QBO Connect page (not the generic
    # /connections page — that route doesn't refresh QBO status). Absolute
    # URL so the browser lands on the FRONTEND service, not the API.
    return RedirectResponse(
        f"{_APP_URL}/connections/qbo?qbo=connected&realm={realmId}",
        status_code=302,
    )


@router.get("/companies/{cid}/qbo/status")
async def qbo_status(cid: str, user: dict = Depends(get_current_user)):
    """Returns connection state PLUS the cached preview counts and the
    most-recent migration job for this company — lets the frontend
    rehydrate the 3-step page on reload without extra roundtrips."""
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    last_job = await db.qbo_jobs.find_one(
        {"company_id": cid, "stale": {"$ne": True}},
        sort=[("created_at", -1)],
    )
    if last_job:
        last_job.pop("_id", None)
    if not conn:
        return {"connected": False, "last_job": last_job}
    preview = None
    if conn.get("preview_counts"):
        preview = {
            "counts": conn["preview_counts"],
            "total": sum(c for c in conn["preview_counts"].values() if c > 0),
            "preview_at": conn.get("preview_at"),
        }
    return {
        "connected": conn.get("status") == "connected",
        "realm_id": conn.get("realm_id"),
        "environment": conn.get("environment"),
        "connected_at": conn.get("created_at"),
        "last_updated": conn.get("updated_at"),
        "preview": preview,
        "last_job": last_job,
    }


@router.post("/companies/{cid}/qbo/disconnect")
async def qbo_disconnect(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    if conn and conn.get("refresh_token_enc"):
        try:
            from crypto_service import decrypt
            await Q.revoke(decrypt(conn["refresh_token_enc"]))
        except Exception:  # noqa: BLE001
            pass
    await db.qbo_connections.update_one(
        {"company_id": cid},
        {"$set": {"status": "disconnected", "access_token_enc": None,
                  "refresh_token_enc": None, "updated_at": now_iso()},
         # Wipe the cached preview + persistent old-job pointer so the
         # UI shows a clean 3-step flow on the next Connect, not stale
         # numbers from the last realm.
         "$unset": {"preview_counts": "", "preview_at": ""}},
    )
    await db.qbo_jobs.update_many(
        {"company_id": cid, "status": {"$in": ["queued", "running"]}},
        {"$set": {"status": "cancelled", "finished_at": now_iso()}},
    )
    # Also mark any prior "done" jobs stale so refreshStatus doesn't
    # hydrate a Complete state for a connection that no longer exists.
    await db.qbo_jobs.update_many(
        {"company_id": cid, "status": "done"},
        {"$set": {"stale": True}},
    )
    return {"ok": True}


@router.get("/companies/{cid}/qbo/preview")
async def qbo_preview(cid: str, user: dict = Depends(get_current_user)):
    """Cheap count(*) per entity so the user can preview scope
    before committing to the full import."""
    await require_company(user, cid)
    try:
        counts = await Q.preview_counts(cid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"QBO preview failed: {e}") from e
    return {"counts": counts, "total": sum(c for c in counts.values() if c > 0)}


@router.post("/companies/{cid}/qbo/migrations")
async def qbo_start_migration(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    if not conn or conn.get("status") != "connected":
        raise HTTPException(400, "QBO not connected")
    # Only one active migration per company at a time.
    existing = await db.qbo_jobs.find_one(
        {"company_id": cid, "status": {"$in": ["queued", "running"]}},
    )
    if existing:
        return {"job_id": existing["job_id"], "already_running": True}
    job_id = str(uuid.uuid4())
    await db.qbo_jobs.insert_one({
        "job_id": job_id, "company_id": cid,
        "status": "queued", "phase": "queued", "percent": 0,
        "processed": 0, "created_at": now_iso(),
    })
    # Fire-and-forget task. The service updates the job doc as it runs.
    asyncio.create_task(Q.run_migration(job_id, cid))
    return {"job_id": job_id, "already_running": False}


@router.get("/companies/{cid}/qbo/migrations/{job_id}")
async def qbo_migration_status(cid: str, job_id: str,
                               user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await db.qbo_jobs.find_one({"job_id": job_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, "Job not found")
    doc.pop("_id", None)
    return doc


@router.get("/companies/{cid}/qbo/diagnostics")
async def qbo_diagnostics(cid: str, user: dict = Depends(get_current_user)):
    """Full audit of a company's QBO migration state. Returns:
      - connection status (realm, environment, last update)
      - every migration job the company has run
      - count of source='qbo' docs in each target collection, WITH the
        Preview count that QBO itself reported so we can spot deltas
      - a sample of the FIRST qbo doc from each collection (name/id/type)
        so the user can eyeball whether the mapping is landing correctly
    Used exclusively for support triage. Cheap — a few counts + one
    `find_one` per collection."""
    await require_company(user, cid)
    conn = await db.qbo_connections.find_one({"company_id": cid}) or {}
    jobs_cur = db.qbo_jobs.find({"company_id": cid}).sort("created_at", -1)
    jobs = []
    async for j in jobs_cur:
        j.pop("_id", None)
        jobs.append(j)

    # For each of the four Foundation collections, count how many QBO-
    # sourced docs exist AND grab one sample so we can eyeball mapping.
    # We also count the transactional collections (invoices/bills/etc.)
    # because a common failure mode is "Foundation imported fine but
    # Invoice/Bill/Payment mappers crashed" — the counts here immediately
    # reveal a partial import.
    out_collections = {}
    for coll_name, entity_label in [
        ("accounts", "Account"),
        ("contacts", "Customer+Vendor"),
        ("items", "Item"),
        ("invoices", "Invoice"),
        ("bills", "Bill"),
        ("payments", "Payment+BillPayment"),
        ("journal_entries", "JournalEntry"),
        ("transactions", "Deposit+Transfer+Purchase+SalesReceipt+RefundReceipt+CreditMemo"),
    ]:
        total = await db[coll_name].count_documents(
            {"company_id": cid, "source": "qbo"},
        )
        sample = await db[coll_name].find_one(
            {"company_id": cid, "source": "qbo"},
            projection={"_id": 0, "raw": 0},   # trim heavy `raw` blob
        )
        out_collections[coll_name] = {
            "entity": entity_label,
            "count_in_db": total,
            "sample": sample,
        }

    # Try a live QBO preview so we can compare live counts to imported.
    preview = None
    try:
        if conn.get("status") == "connected":
            preview = await Q.preview_counts(cid)
    except Exception as e:  # noqa: BLE001
        preview = {"error": str(e)[:200]}

    return {
        "connection": {
            "connected": conn.get("status") == "connected",
            "realm_id": conn.get("realm_id"),
            "environment": conn.get("environment"),
            "created_at": conn.get("created_at"),
            "updated_at": conn.get("updated_at"),
        },
        "mapper_version": Q.MAPPER_VERSION,
        "jobs": jobs,
        "collections": out_collections,
        "live_qbo_preview": preview,
    }
