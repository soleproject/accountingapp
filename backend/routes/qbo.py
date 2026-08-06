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
    code: str = Query(...),
    state: str = Query(...),
    realmId: str = Query(...),
):
    """Intuit redirects here after the user consents. We validate the
    one-shot state token, exchange the code for tokens, encrypt-and-
    store them, then redirect the user back into the app."""
    rec = await db.qbo_oauth_states.find_one_and_delete({"state": state})
    if not rec:
        raise HTTPException(400, "Invalid or expired state token")
    try:
        exp = datetime.fromisoformat(rec["expires_at"])
        if exp < datetime.now(timezone.utc):
            raise HTTPException(400, "State token expired")
    except (KeyError, ValueError) as e:
        raise HTTPException(400, f"Bad state record: {e}") from e
    cid = rec["company_id"]
    try:
        tokens = await Q.exchange_code(code, realmId)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Token exchange failed: {e}") from e
    await Q.save_connection(cid, realmId, tokens)
    # Redirect back to the app's Connections page with a success flag.
    return RedirectResponse(
        f"/connections?qbo=connected&realm={realmId}",
        status_code=302,
    )


@router.get("/companies/{cid}/qbo/status")
async def qbo_status(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    if not conn:
        return {"connected": False}
    return {
        "connected": conn.get("status") == "connected",
        "realm_id": conn.get("realm_id"),
        "environment": conn.get("environment"),
        "connected_at": conn.get("created_at"),
        "last_updated": conn.get("updated_at"),
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
                  "refresh_token_enc": None, "updated_at": now_iso()}},
    )
    await db.qbo_jobs.update_many(
        {"company_id": cid, "status": {"$in": ["queued", "running"]}},
        {"$set": {"status": "cancelled", "finished_at": now_iso()}},
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
