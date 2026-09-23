"""
Public (no-auth) endpoints backing the magic-link info-request flow.

Every route validates the signed token first. Nothing here trusts
path params, request body, or cookies — the token IS the credential
and is scoped to a single {company_id, info_request_id}.

Endpoints:
  GET    /api/public/info-request/{token}
    → { note, response_type, business_name, requested_at, already_responded }

  POST   /api/public/info-request/{token}/upload   (multipart file)
    → { id, name, size }

  DELETE /api/public/info-request/{token}/files/{file_id}
    → { ok: true }

  POST   /api/public/info-request/{token}/respond  (JSON body)
    → { ok, status }
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Body
from pydantic import BaseModel

from db import db
import storage as objstore
import link_tokens
from email_service import send_email

log = logging.getLogger("axiom.public_info_request")
router = APIRouter(prefix="/api/public")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _resolve_token(token: str) -> tuple[dict, dict, int, dict]:
    """Verify the token and return `(payload, app_doc, request_index, request_entry)`.
    Raises HTTPException on any failure with a merchant-safe message."""
    try:
        payload = link_tokens.decode(token)
    except link_tokens.InvalidToken as e:
        # Map the internal reason to a merchant-friendly message.
        # 410 GONE for expired, 401 for anything else — makes it easy
        # for the frontend to render the right "expired link" screen.
        if str(e) == "expired":
            raise HTTPException(410, "This link has expired.") from e
        raise HTTPException(401, "This link isn't valid.") from e

    cid, rid = payload["cid"], payload["rid"]
    doc = await db.payments_applications.find_one({"company_id": cid})
    if not doc:
        raise HTTPException(404, "Application not found.")
    history = list(doc.get("info_requests") or [])
    idx = next((i for i, r in enumerate(history) if r.get("id") == rid), None)
    if idx is None:
        raise HTTPException(404, "Request not found.")
    req = history[idx]
    if req.get("nonce_used") and req.get("nonce_used") != payload["nonce"]:
        # A different nonce already burned this request. Old link.
        raise HTTPException(410, "This link has already been superseded.")
    return payload, doc, idx, req


@router.get("/info-request/{token}")
async def get_info_request(token: str):
    """Merchant-facing view of the request. Returns the note + type
    + business name so the response page can render without an
    authenticated session."""
    _payload, doc, _idx, req = await _resolve_token(token)
    company = await db.companies.find_one({"id": doc["company_id"]}, {"_id": 0, "name": 1}) or {}
    already = bool(req.get("responded_at"))
    return {
        "cid":            doc["company_id"],
        "rid":            req.get("id"),
        "business_name":  company.get("name") or "your business",
        "note":           req.get("note") or "",
        "response_type":  req.get("response_type") or "either",
        "requested_at":   req.get("requested_at"),
        "already_responded": already,
        "responded_at":   req.get("responded_at"),
    }


@router.post("/info-request/{token}/upload")
async def upload_via_token(token: str, file: UploadFile = File(...)):
    """Accept a single file uploaded from the merchant's magic-link
    session. Files are tagged with `via_link_rid` so the closing
    logic can find them without relying on timestamps."""
    _payload, doc, _idx, req = await _resolve_token(token)
    if req.get("responded_at"):
        raise HTTPException(409, "You've already sent your response.")

    cid = doc["company_id"]
    ext = "bin"
    if file.filename and "." in file.filename:
        ext = file.filename.rsplit(".", 1)[-1].lower()[:12]
    file_id = str(uuid.uuid4())
    path = f"{objstore.APP_NAME}/{cid}/payments_app/{file_id}.{ext}"
    data = await file.read()
    try:
        result = objstore.put_object(
            path, data, file.content_type or "application/octet-stream"
        )
    except objstore.StorageUnavailable as e:
        raise HTTPException(503, f"Storage unavailable — try again shortly ({e})") from e
    now = _now()
    await db.payments_app_files.insert_one({
        "id": file_id,
        "company_id": cid,
        "storage_path": result["path"],
        "original_filename": file.filename or f"{file_id}.{ext}",
        "content_type": file.content_type or "application/octet-stream",
        "size": result.get("size") or len(data),
        "uploaded_by": None,        # anonymous — token session
        "uploaded_at": now,
        "is_deleted": False,
        "via_link_rid": req.get("id"),
    })
    return {
        "id":   file_id,
        "name": file.filename or f"{file_id}.{ext}",
        "size": result.get("size") or len(data),
    }


@router.get("/info-request/{token}/files")
async def list_files_via_token(token: str):
    """Merchant can see files they've already uploaded in this
    session — so a browser refresh doesn't lose track."""
    _payload, doc, _idx, req = await _resolve_token(token)
    files = await db.payments_app_files.find(
        {
            "company_id": doc["company_id"],
            "via_link_rid": req.get("id"),
            "is_deleted": {"$ne": True},
        },
        {"_id": 0, "id": 1, "original_filename": 1, "size": 1, "uploaded_at": 1},
    ).sort("uploaded_at", 1).to_list(200)
    return {"files": files}


@router.delete("/info-request/{token}/files/{file_id}")
async def delete_file_via_token(token: str, file_id: str):
    """Soft-remove a file the merchant staged in error — scoped so
    they can only touch files tied to THIS request's token."""
    _payload, doc, _idx, req = await _resolve_token(token)
    r = await db.payments_app_files.update_one(
        {
            "id":           file_id,
            "company_id":   doc["company_id"],
            "via_link_rid": req.get("id"),
            "is_deleted":   {"$ne": True},
        },
        {"$set": {"is_deleted": True, "deleted_at": _now()}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "That file isn't attached to this response.")
    return {"ok": True}


class RespondIn(BaseModel):
    response_note: Optional[str] = None


@router.post("/info-request/{token}/respond")
async def respond_via_token(token: str, body: RespondIn):
    """Close out the info request with the merchant's staged files
    and optional text reply. Mirrors the portal path's closing logic
    but runs unauthenticated (via the signed token) and stamps
    `response_channel="link"` so the underwriter sees which channel
    was used."""
    payload, doc, idx, req = await _resolve_token(token)
    if req.get("responded_at"):
        raise HTTPException(409, "You've already sent your response.")

    cid = doc["company_id"]
    note = (body.response_note or "").strip()

    # Files uploaded via THIS specific request's link.
    resp_files = await db.payments_app_files.find(
        {
            "company_id":   cid,
            "via_link_rid": req.get("id"),
            "is_deleted":   {"$ne": True},
        },
        {"_id": 0, "id": 1},
    ).to_list(200)
    file_ids = [f["id"] for f in resp_files]

    # Same response-type gates as the portal path.
    rtype = req.get("response_type") or "either"
    if rtype == "docs" and len(file_ids) == 0:
        raise HTTPException(400, "Your underwriter asked for a document. Upload at least one file before sending.")
    if rtype == "text" and not note:
        raise HTTPException(400, "Your underwriter asked for a written reply. Add a note before sending.")
    if rtype == "either" and len(file_ids) == 0 and not note:
        raise HTTPException(400, "Add a written reply or upload a document — otherwise your underwriter has nothing new to review.")

    now = _now()
    # Close the request AND flip the app status. Single-use burn:
    # store the nonce so a re-play of the same link 410s next time.
    await db.payments_applications.update_one(
        {"company_id": cid},
        {"$set": {
            "status":            "info_received",
            "info_received_at":  now,
            "updated_at":        now,
            f"info_requests.{idx}.responded_at":      now,
            f"info_requests.{idx}.response_file_ids": file_ids,
            f"info_requests.{idx}.response_note":     note,
            f"info_requests.{idx}.response_channel":  "link",
            f"info_requests.{idx}.nonce_used":        payload["nonce"],
        }},
    )

    # Notify the underwriter. Best-effort — email failure doesn't
    # roll back the response.
    try:
        await _notify_underwriter(cid=cid, req=req, note=note, file_count=len(file_ids))
    except Exception as e:  # noqa: BLE001
        log.warning("underwriter notify (link path) failed: %s", e)

    return {"ok": True, "status": "info_received", "response_file_count": len(file_ids)}


async def _notify_underwriter(*, cid: str, req: dict, note: str, file_count: int):
    """Same shape as the portal path's notifier — kept in this file
    so the public router has zero import fanout into the auth-scoped
    module. Silent no-op if we can't find an email."""
    req_by = req.get("requested_by")
    if not req_by:
        return
    uw = await db.users.find_one({"id": req_by}, {"_id": 0, "email": 1, "prefs": 1})
    if not uw or not uw.get("email"):
        return
    if (uw.get("prefs") or {}).get("notify_on_response") is False:
        return
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "name": 1}) or {}
    biz_name = company.get("name") or "A merchant"
    parts = []
    if note:
        parts.append(
            f"<div style='margin-top:10px;'><b>Their reply:</b><br>"
            f"<div style='padding:8px 12px;background:#f8fafc;border-left:3px solid #a78bfa;color:#334155;'>{note}</div></div>"
        )
    if file_count:
        parts.append(
            f"<div style='margin-top:10px;color:#475569;'>📎 <b>{file_count}</b> file{'s' if file_count != 1 else ''} attached.</div>"
        )
    html = f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:20px;color:#0f172a;margin:0 0 12px;">Response ready for review</h1>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    <b>{biz_name}</b> responded to your info request <b>via the email link</b>.
    Their submission is now in the <b>Info Received</b> bucket.
  </p>
  <div style="margin-top:14px;padding:8px 12px;background:#fef3c7;border-left:3px solid #f59e0b;color:#475569;font-size:13px;">
    <b>Your original question:</b><br>{req.get("note") or ""}
  </div>
  {''.join(parts)}
</div>
""".strip()
    await send_email(to=uw["email"], subject=f"{biz_name} responded to your info request", html=html)
