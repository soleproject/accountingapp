"""Underwriter / Merchant Review portal.

The underwriter (Paul, our NMI merchant-services contact) is a
dedicated role that ONLY has access to review submitted payments
applications and approve or decline them. They don't see books,
transactions, or any other client data — just the KYC application
payload plus the uploaded documents.

Endpoints:
    GET  /underwriter/apps                  → list every submitted app
    GET  /underwriter/apps/{company_id}     → decrypted app detail
    GET  /underwriter/apps/{cid}/files/{fid} → download an uploaded file
    POST /underwriter/apps/{cid}/approve    → set status=approved, save NMI keys, email client
    POST /underwriter/apps/{cid}/decline    → set status=declined, save reason, email client

Approved credentials land in `db.merchant_payments_credentials`
(encrypted at rest via `crypto_service`) — that same collection is
what `nmi_service.py` reads from when running sales.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, Field

from fastapi import APIRouter, Depends, HTTPException, Response

from db import db
from auth import get_current_user, require_role
import crypto_service as cs
import storage as objstore
from email_service import send_email

# Import decrypt helper from payments_app to avoid duplicating the
# per-field cipher logic — same required-list too, so completion %
# stays consistent across surfaces.
from routes.payments_app import (
    _decrypt_payload, _completion, _BUSINESS_SECRETS, _OWNER_SECRETS,
)

log = logging.getLogger("axiom.underwriter")
router = APIRouter(prefix="/api/underwriter")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_underwriter(user: dict = Depends(get_current_user)) -> dict:
    """Only `underwriter` and `superadmin` roles can hit this router."""
    if user["role"] not in ("underwriter", "superadmin"):
        raise HTTPException(403, "This portal is restricted to underwriters.")
    return user


# ---- List ---------------------------------------------------------

@router.get("/apps")
async def list_submitted_apps(user: dict = Depends(_require_underwriter)):
    """Every app that's been submitted (or already approved / declined).
    Drafts are hidden — underwriter only sees what the merchant has
    formally attested to."""
    docs = await db.payments_applications.find(
        {"status": {"$in": ["submitted", "approved", "declined"]}},
        {"_id": 0},
    ).to_list(1000)
    cids = [d.get("company_id") for d in docs if d.get("company_id")]
    companies = await db.companies.find(
        {"id": {"$in": cids}}, {"_id": 0, "id": 1, "name": 1},
    ).to_list(1000)
    names = {c["id"]: c.get("name") or "Untitled" for c in companies}
    items = []
    for d in docs:
        # We DON'T decrypt here — the list only needs summary info.
        biz = d.get("business") or {}
        items.append({
            "company_id":   d.get("company_id"),
            "company_name": names.get(d.get("company_id"), "Untitled"),
            "dba":          biz.get("dba") or "",
            "status":       d.get("status") or "submitted",
            "submitted_at": d.get("submitted_at"),
            "reviewed_at":  d.get("reviewed_at"),
            "updated_at":   d.get("updated_at"),
        })
    # Waiting-first (submitted before approved/declined), most recent first.
    order = {"submitted": 0, "approved": 1, "declined": 2}
    items.sort(key=lambda x: (x.get("submitted_at") or ""), reverse=True)
    items.sort(key=lambda x: order.get(x["status"], 3))
    return {"items": items}


# ---- Detail -------------------------------------------------------

@router.get("/apps/{company_id}")
async def get_app(company_id: str, user: dict = Depends(_require_underwriter)):
    """Full decrypted payload — this is the only surface where the
    underwriter sees SSNs and EINs in plain text. Callers are
    superadmin or the dedicated underwriter role."""
    doc = await db.payments_applications.find_one(
        {"company_id": company_id, "status": {"$in": ["submitted", "approved", "declined"]}},
        {"_id": 0},
    )
    if not doc:
        raise HTTPException(404, "No submitted application for that company.")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    plain = _decrypt_payload(doc)
    plain["company_name"] = company.get("name") or "Untitled"
    plain["completion"] = _completion(plain)
    # File manifest for the underwriter's preview panel. `storage_path`
    # is the S3-style key; the client asks us to sign a temp URL via
    # /files/{fid} rather than trusting the browser with it.
    files = await db.payments_app_files.find(
        {"company_id": company_id, "is_deleted": {"$ne": True}},
        {"_id": 0, "id": 1, "original_filename": 1, "content_type": 1,
         "size": 1, "uploaded_at": 1, "storage_path": 1},
    ).to_list(200)
    plain["files"] = files
    # Redact the still-encrypted credentials from any prior approval —
    # underwriter re-enters keys on re-approve if needed.
    cred = await db.merchant_payments_credentials.find_one(
        {"company_id": company_id}, {"_id": 0, "environment": 1, "nmi_tokenization_key": 1,
                                     "surcharge_pct": 1, "approved_at": 1, "approved_by": 1},
    )
    plain["credentials"] = cred  # None if never approved
    return plain


# ---- File preview -------------------------------------------------

@router.get("/apps/{company_id}/files/{file_id}")
async def download_file(
    company_id: str, file_id: str,
    user: dict = Depends(_require_underwriter),
):
    """Stream an uploaded document. Underwriter-only. We proxy through
    the backend rather than issuing a signed URL so the object-storage
    origin never accepts anonymous traffic."""
    f = await db.payments_app_files.find_one({
        "id": file_id, "company_id": company_id, "is_deleted": {"$ne": True},
    })
    if not f:
        raise HTTPException(404, "File not found")
    try:
        data, ct = objstore.get_object(f["storage_path"])
    except Exception as e:
        raise HTTPException(503, f"Storage unavailable: {e}")
    return Response(
        content=data,
        media_type=ct or f.get("content_type") or "application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{f.get("original_filename","file")}"',
        },
    )


# ---- Approve ------------------------------------------------------

class ApproveIn(BaseModel):
    nmi_security_key: str = Field(..., min_length=8)
    nmi_tokenization_key: str = Field(..., min_length=8)
    nmi_processor_id: Optional[str] = ""
    webhook_secret: Optional[str] = ""
    environment: str = Field("sandbox", pattern="^(sandbox|production)$")
    surcharge_pct: float = Field(0, ge=0, le=10)
    note: Optional[str] = ""


@router.post("/apps/{company_id}/approve")
async def approve_app(
    company_id: str, body: ApproveIn,
    user: dict = Depends(_require_underwriter),
):
    """Persist NMI credentials (encrypted), flip the app status, and
    email the client that they're live."""
    doc = await db.payments_applications.find_one({"company_id": company_id})
    if not doc:
        raise HTTPException(404, "No application on file.")
    if doc.get("status") not in ("submitted", "declined"):
        # Re-approving an already-approved app is idempotent but noisy —
        # allow it so keys can be rotated in place.
        pass
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    now = _now()
    cred = {
        "company_id":            company_id,
        "environment":           body.environment,
        "nmi_security_key":      cs.encrypt(body.nmi_security_key.strip()),
        "nmi_tokenization_key":  body.nmi_tokenization_key.strip(),
        "nmi_processor_id":      (body.nmi_processor_id or "").strip(),
        "webhook_secret":        cs.encrypt(body.webhook_secret.strip()) if body.webhook_secret else "",
        "surcharge_pct":         float(body.surcharge_pct or 0),
        "approved_at":           now,
        "approved_by":           user.get("id"),
        "updated_at":            now,
    }
    await db.merchant_payments_credentials.update_one(
        {"company_id": company_id},
        {"$set": cred, "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now}},
        upsert=True,
    )
    await db.payments_applications.update_one(
        {"company_id": company_id},
        {"$set": {
            "status":         "approved",
            "reviewed_at":    now,
            "reviewed_by":    user.get("id"),
            "review_note":    body.note or "",
            "updated_at":     now,
        }},
    )
    # Flip the company-level flag so the Pay Now button lights up on invoices.
    await db.companies.update_one(
        {"id": company_id},
        {"$set": {"payments_enabled": True, "payments_enabled_at": now}},
    )

    # Notify the client. `contact_email` is the merchant's primary
    # contact from the application; fall back to owner user if missing.
    biz = _decrypt_payload(doc).get("business") or {}
    to_email = (biz.get("contact_email") or "").strip()
    if not to_email:
        owner = await db.users.find_one({"id": doc.get("submitted_by")}, {"_id": 0, "email": 1}) if doc.get("submitted_by") else None
        to_email = (owner or {}).get("email") or ""
    if to_email:
        try:
            await send_email(
                to=to_email,
                subject=f"You're live: {company.get('name') or 'your business'} can now accept payments",
                html=_approval_email_html(company.get("name") or "your business"),
            )
        except Exception as e:  # noqa: BLE001
            log.warning("approval email send failed: %s", e)
    return {"ok": True, "status": "approved"}


class DeclineIn(BaseModel):
    reason: str = Field(..., min_length=4)
    note:   Optional[str] = ""


@router.post("/apps/{company_id}/decline")
async def decline_app(
    company_id: str, body: DeclineIn,
    user: dict = Depends(_require_underwriter),
):
    doc = await db.payments_applications.find_one({"company_id": company_id})
    if not doc:
        raise HTTPException(404, "No application on file.")
    now = _now()
    await db.payments_applications.update_one(
        {"company_id": company_id},
        {"$set": {
            "status":         "declined",
            "reviewed_at":    now,
            "reviewed_by":    user.get("id"),
            "decline_reason": body.reason,
            "review_note":    body.note or "",
            "updated_at":     now,
        }},
    )
    await db.companies.update_one(
        {"id": company_id}, {"$set": {"payments_enabled": False}},
    )
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    biz = _decrypt_payload(doc).get("business") or {}
    to_email = (biz.get("contact_email") or "").strip()
    if to_email:
        try:
            await send_email(
                to=to_email,
                subject=f"Your payments application update — {company.get('name') or 'your business'}",
                html=_decline_email_html(company.get("name") or "your business", body.reason),
            )
        except Exception as e:  # noqa: BLE001
            log.warning("decline email send failed: %s", e)
    return {"ok": True, "status": "declined"}


# ---- Email templates ---------------------------------------------

def _approval_email_html(business_name: str) -> str:
    return f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;color:#059669;margin:0 0 12px;">You're approved — payments are live!</h1>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Great news for <b>{business_name}</b>: your Get Paid Faster application has been approved.
    You can now send invoices with a one-click Pay Now link, accept ACH pulls, and share a hosted
    payment page with your customers.
  </p>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Money settles in 2–3 business days. We'll auto-post each payment into your books and clear the
    matching invoice — no double entry required.
  </p>
  <p style="font-size:13px;color:#64748b;margin-top:24px;">
    Head to <b>Invoices</b> to send your first Pay Now invoice, or ping us with any questions.
  </p>
</div>
""".strip()


def _decline_email_html(business_name: str, reason: str) -> str:
    return f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;color:#0f172a;margin:0 0 12px;">Your payments application needs another look</h1>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Thanks for submitting the payments application for <b>{business_name}</b>. Unfortunately we
    weren't able to approve it as-is. Our underwriter noted:
  </p>
  <blockquote style="border-left:3px solid #cbd5e1;padding:8px 12px;color:#475569;font-size:14px;background:#f8fafc;">
    {reason}
  </blockquote>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    You can update your application in <b>Get Paid Faster</b> and resubmit anytime — we're here to
    help you get across the finish line.
  </p>
</div>
""".strip()
