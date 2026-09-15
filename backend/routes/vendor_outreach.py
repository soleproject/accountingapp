"""Vendor outreach routes — Milestone G.

Endpoints
---------
POST /api/vendor-outreach/inbound
        Resend Inbound webhook. No JWT — routing is by the
        `w9-reply+<outreach_id>@...` address in `to`. Payload shape
        follows Resend's inbound-email JSON.
GET  /api/vendor-outreach                       — list, pro-side
GET  /api/vendor-outreach/{outreach_id}         — detail, pro-side
POST /api/vendor-outreach/{outreach_id}/stop    — pro-side manual stop
POST /api/vendor-outreach/start                 — manual kickoff for a
                                                  specific contact (pro
                                                  clicks "Ask vendor" on
                                                  an agent finding)
"""
from __future__ import annotations
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from deps import db, company_ids_for_user
from auth import get_current_user
import vendor_outreach as vo

logger = logging.getLogger("axiom.vendor_outreach.routes")

router = APIRouter(prefix="/api/vendor-outreach", tags=["vendor-outreach"])


# --------------------------------------------------------------------------
# Public — inbound webhook (Resend)
# --------------------------------------------------------------------------

@router.post("/inbound")
async def inbound_webhook(request: Request):
    """Receive a Resend Inbound email JSON payload. Route to the right
    outreach doc using the `+<outreach_id>` piece of the `to` address.

    Resend inbound payloads (as of 2026) look roughly like:
      {"from": "vendor@example.com",
       "to":   "w9-reply+<oid>@reply.accountingapp.ai",
       "subject": "...",
       "text": "...",
       "html": "...",
       "attachments": [{"filename": ..., "content": <b64>,
                        "content_type": ...}, ...]}

    We accept a couple of shape variations for robustness.
    """
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Invalid JSON payload")
    if not isinstance(payload, dict):
        raise HTTPException(400, "Expected JSON object")

    to_addr = (payload.get("to")
               or (payload.get("envelope") or {}).get("to")
               or "")
    if isinstance(to_addr, list):
        to_addr = to_addr[0] if to_addr else ""
    outreach_id = vo.parse_reply_to(to_addr)
    if not outreach_id:
        logger.info("inbound webhook: no outreach id in to=%r", to_addr)
        return {"status": "ignored", "reason": "no_outreach_token"}

    from_email = (payload.get("from")
                  or (payload.get("envelope") or {}).get("from")
                  or "")
    if isinstance(from_email, dict):
        from_email = from_email.get("email") or from_email.get("address") or ""

    subject = payload.get("subject") or ""
    text = payload.get("text") or payload.get("plain") or ""
    html = payload.get("html")

    # Normalize attachments to the shape process_inbound_reply expects.
    raw_atts = payload.get("attachments") or []
    attachments: list[dict] = []
    for a in raw_atts:
        if not isinstance(a, dict):
            continue
        filename = a.get("filename") or a.get("name") or "attachment"
        mime = a.get("content_type") or a.get("mime") or "application/octet-stream"
        content_b64 = a.get("content") or a.get("data") or ""
        data_url = None
        if content_b64:
            data_url = f"data:{mime};base64,{content_b64}"
        attachments.append({
            "filename": filename,
            "mime":     mime,
            "size":     a.get("size") or len(content_b64 or ""),
            "data_url": data_url,
        })

    result = await vo.process_inbound_reply(
        outreach_id=outreach_id,
        from_email=str(from_email),
        subject=str(subject),
        text=str(text), html=html,
        attachments=attachments,
    )
    return {"ok": True, **result}


# --------------------------------------------------------------------------
# Authenticated pro-side endpoints
# --------------------------------------------------------------------------

async def _require_access(user: dict, outreach: dict) -> None:
    if not outreach:
        raise HTTPException(404, "Outreach not found")
    ids = await company_ids_for_user(user)
    if outreach["company_id"] not in ids:
        raise HTTPException(403, "Not accessible")


@router.get("")
async def list_outreaches(
    company_id: Optional[str] = None,
    status: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    ids = await company_ids_for_user(user)
    if not ids:
        return {"outreaches": []}
    q: dict = {"company_id": {"$in": ids}}
    if company_id:
        if company_id not in ids:
            raise HTTPException(403, "Not accessible")
        q["company_id"] = company_id
    if status:
        q["status"] = status
    docs = await db.vendor_outreaches.find(q).sort("created_at", -1).limit(200).to_list(200)
    for d in docs:
        d.pop("_id", None)
    return {"outreaches": docs}


@router.get("/{outreach_id}")
async def get_outreach(outreach_id: str, user: dict = Depends(get_current_user)):
    o = await db.vendor_outreaches.find_one({"id": outreach_id})
    await _require_access(user, o)
    o.pop("_id", None)
    return o


class StopRequest(BaseModel):
    reason: Optional[str] = None


@router.post("/{outreach_id}/stop")
async def stop_outreach(outreach_id: str, body: StopRequest,
                        user: dict = Depends(get_current_user)):
    o = await db.vendor_outreaches.find_one({"id": outreach_id})
    await _require_access(user, o)
    return await vo.stop_outreach(
        outreach_id, stopped_by=f"user:{user.get('id')}",
        reason=body.reason or "pro_stopped",
    )


class StartRequest(BaseModel):
    company_id: str
    contact_id: str
    agent_finding_id: Optional[str] = None


@router.post("/start")
async def start_outreach(body: StartRequest, user: dict = Depends(get_current_user)):
    ids = await company_ids_for_user(user)
    if body.company_id not in ids:
        raise HTTPException(403, "Not accessible")
    doc = await vo.start_outreach_for_contact(
        company_id=body.company_id, contact_id=body.contact_id,
        agent_finding_id=body.agent_finding_id,
        initiating_user_id=user.get("id"),
    )
    doc.pop("_id", None)
    return doc
