"""SmartBooks — Client Portal.

Unified magic-link portal per (company, client_email). One shareable URL
gives the client a single queue of every open question, receipt request,
and document ask from their accountant. Answers land against the
existing `client_questions` collection so the Cockpit auto-unblocks.

Two routers here:
  firm_router     /api/companies/{cid}/client-portals/*   (auth required)
  public_router   /api/portal/{token}/*                    (public)
"""
from __future__ import annotations
import base64
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, EmailStr

from db import db, now_iso, coerce
from auth import get_current_user, require_role
from deps import require_company
import email_templates as tmpl
from email_dispatcher import dispatch, public_base_url

firm_router = APIRouter(prefix="/api", tags=["client-portal"])
public_router = APIRouter(prefix="/api/portal", tags=["client-portal-public"])


def _norm_email(s: Optional[str]) -> str:
    return (s or "").strip().lower()


async def _snapshot_brand(cid: str) -> dict:
    c = await db.companies.find_one({"id": cid}) or {}
    return {
        "company_name": c.get("name") or "Your books",
        "logo_url": c.get("brand_logo_url") or c.get("logo_url"),
        "primary_color": c.get("brand_primary_color") or "#6366F1",
    }


# ---------------------------------------------------------------------------
# FIRM-SIDE (auth)
# ---------------------------------------------------------------------------

class CreatePortalIn(BaseModel):
    client_email: EmailStr
    client_name: Optional[str] = None
    contact_id: Optional[str] = None


@firm_router.post("/companies/{cid}/client-portals")
async def create_or_get_portal(
    cid: str, inp: CreatePortalIn,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Idempotent — one portal per (company, client_email). Returns the
    magic URL so the CPA can copy/share or trigger an invite email."""
    await require_company(user, cid)
    email = _norm_email(inp.client_email)
    existing = await db.client_portals.find_one({
        "company_id": cid, "client_email": email,
        "$or": [{"revoked_at": None}, {"revoked_at": {"$exists": False}}],
    })
    if existing:
        return {"portal": coerce(existing), "url": f"{public_base_url()}/portal/{existing['id']}"}

    token = secrets.token_urlsafe(24)
    brand = await _snapshot_brand(cid)
    doc = {
        "id": token,
        "company_id": cid,
        "client_email": email,
        "client_name": inp.client_name or None,
        "contact_id": inp.contact_id or None,
        "brand_snapshot": brand,
        "created_by": user.get("email") or user.get("id"),
        "created_at": now_iso(),
        "last_used_at": None,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=365)).isoformat(),
        "revoked_at": None,
    }
    await db.client_portals.insert_one(doc)
    return {"portal": coerce(doc), "url": f"{public_base_url()}/portal/{token}"}


@firm_router.get("/companies/{cid}/client-portals")
async def list_portals(
    cid: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    docs = await db.client_portals.find({
        "company_id": cid,
        "$or": [{"revoked_at": None}, {"revoked_at": {"$exists": False}}],
    }).sort("created_at", -1).to_list(200)
    return {"portals": [coerce(d) for d in docs]}


@firm_router.post("/companies/{cid}/client-portals/{pid}/send-invite")
async def send_portal_invite(
    cid: str, pid: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    portal = await db.client_portals.find_one({"id": pid, "company_id": cid})
    if not portal:
        raise HTTPException(404, "Portal not found.")
    if portal.get("revoked_at"):
        raise HTTPException(400, "Portal has been revoked.")

    company = await db.companies.find_one({"id": cid})
    magic_url = f"{public_base_url()}/portal/{pid}"

    # Simple invite email — reuses the same dispatch pipe as ask-client so
    # we keep one audit log for outbound comms.
    subject = f"Your accountant just set up a portal for {company.get('name') or 'your books'}"
    html = f"""
      <p>Hi{f" {portal.get('client_name')}" if portal.get('client_name') else ""},</p>
      <p>Your accountant at <b>{company.get('name') or 'your firm'}</b> just set up a
      dedicated portal for you. Any time we have a question about a transaction, a
      receipt request, or a document ask — it will show up here in one place.</p>
      <p><a href="{magic_url}" style="display:inline-block;padding:12px 20px;
        background:{portal.get('brand_snapshot',{}).get('primary_color','#6366F1')};
        color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
        Open your portal →</a></p>
      <p style="color:#64748b;font-size:12px;">Bookmark this link — it's yours for the year.</p>
    """
    try:
        result = await dispatch(
            kind="portal_invite",
            to=portal["client_email"],
            subject=subject,
            html=html,
            initiating_user_id=user.get("id"),
            company_id=cid,
            related={"portal_id": pid},
        )
        return {"status": result.get("status", "sent"), "magic_url": magic_url}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Failed to send invite: {e}")


@firm_router.post("/companies/{cid}/client-portals/{pid}/revoke")
async def revoke_portal(
    cid: str, pid: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    r = await db.client_portals.update_one(
        {"id": pid, "company_id": cid},
        {"$set": {"revoked_at": now_iso(), "revoked_by": user.get("email") or user.get("id")}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Portal not found.")
    return {"ok": True}


# ---------------------------------------------------------------------------
# PUBLIC (no auth — token IS the auth)
# ---------------------------------------------------------------------------

async def _load_portal(token: str) -> dict:
    p = await db.client_portals.find_one({"id": token})
    if not p:
        raise HTTPException(404, "Portal not found or expired.")
    if p.get("revoked_at"):
        raise HTTPException(410, "This portal link has been revoked.")
    exp = p.get("expires_at")
    if exp and exp < now_iso():
        raise HTTPException(410, "This portal link has expired.")
    return p


@public_router.get("/{token}")
async def portal_home(token: str):
    """Everything the client sees in one payload:
    - brand (company name, logo, primary color)
    - open + recent-answered questions (from client_questions)
    - upload endpoint hint
    """
    portal = await _load_portal(token)
    # Aggregate every question addressed to this client email, or with a
    # matching contact_id, on this company. Match to_email case-insensitively
    # because ask-client write paths may store the original casing while
    # client_portals.client_email is always lowercase-normalized.
    import re
    email_regex = re.compile(f"^{re.escape(portal['client_email'])}$", re.IGNORECASE)
    q_filter = {
        "company_id": portal["company_id"],
        "to_email": {"$regex": email_regex},
    }
    docs = await db.client_questions.find(q_filter).sort("sent_at", -1).limit(200).to_list(200)

    def _shape(q: dict) -> dict:
        return {
            "id": q.get("id"),
            "question": q.get("question"),
            "status": q.get("status") or "pending",
            "sent_at": q.get("sent_at"),
            "answered_at": q.get("answered_at"),
            "counterparty_label": q.get("counterparty_label"),
            "asked_by_name": q.get("asked_by_name"),
            "txn_count": len(q.get("txn_ids") or []),
            "has_answer": bool(q.get("answer")),
            "chat_messages": q.get("chat_messages") or [],
        }

    open_qs = [_shape(q) for q in docs if (q.get("status") or "pending") in ("pending", "sent")]
    recent = [_shape(q) for q in docs if (q.get("status") or "pending") in ("answered", "expired", "cancelled")][:20]

    # Touch last_used_at.
    await db.client_portals.update_one({"id": token}, {"$set": {"last_used_at": now_iso()}})

    return {
        "brand": portal.get("brand_snapshot", {}),
        "client_name": portal.get("client_name"),
        "open_count": len(open_qs),
        "open_questions": open_qs,
        "recent_questions": recent,
        "allow_upload": True,
    }


class PortalAnswerIn(BaseModel):
    answer: str


@public_router.post("/{token}/answer/{qid}")
async def portal_answer(token: str, qid: str, inp: PortalAnswerIn):
    """Answer one of the portal's open questions. Reuses the same
    logic as the per-question link so the auto-unblock loop on the
    Close Board just works."""
    portal = await _load_portal(token)
    q = await db.client_questions.find_one({"id": qid, "company_id": portal["company_id"]})
    if not q:
        raise HTTPException(404, "Question not found.")
    if _norm_email(q.get("to_email")) != portal["client_email"]:
        raise HTTPException(403, "This question isn't part of your portal.")
    if q.get("status") == "answered":
        raise HTTPException(400, "Already answered.")

    ans = (inp.answer or "").strip()
    if not ans:
        raise HTTPException(400, "Answer cannot be empty.")

    now = now_iso()
    await db.client_questions.update_one(
        {"id": qid},
        {"$set": {"status": "answered", "answer": ans, "answered_at": now}},
    )
    # Mirror the ai_comment onto the txn(s) so the pro sees the reply
    # inline — matches the pattern in `public_answer_question`.
    tx_ids = q.get("txn_ids") or ([q.get("txn_id")] if q.get("txn_id") else [])
    for tid in tx_ids:
        try:
            t = await db.transactions.find_one({"id": tid, "company_id": portal["company_id"]})
            if not t:
                continue
            new_comment = (t.get("ai_comment") or "") + f"\n[Client answered {now[:10]}]: {ans}"
            await db.transactions.update_one(
                {"id": tid, "company_id": portal["company_id"]},
                {"$set": {
                    "ai_comment": new_comment,
                    "client_answered_at": now,
                    "updated_at": now,
                }},
            )
        except Exception:  # noqa: BLE001
            continue
    return {"status": "answered"}


@public_router.post("/{token}/upload")
async def portal_upload(
    token: str,
    file: UploadFile = File(...),
    question_id: Optional[str] = Form(None),
    note: Optional[str] = Form(None),
):
    """Client-side upload — receipts, docs, statements. Stores the raw
    bytes as base64 on `portal_uploads` and links to the referenced
    question (if any). Auto-attaches to the transaction ai_comment so
    the accountant sees "[Client uploaded receipt.pdf]" inline.

    Phase 2 MVP intentionally skips Veryfi OCR + auto-match — that's a
    Phase 3 add. The file is stored, notified, and human-triaged.
    """
    portal = await _load_portal(token)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "File too large (15 MB max).")

    upload_id = str(uuid.uuid4())
    b64 = base64.b64encode(raw).decode("ascii")

    linked_txn_ids: list[str] = []
    q = None
    if question_id:
        q = await db.client_questions.find_one({"id": question_id, "company_id": portal["company_id"]})
        if q:
            linked_txn_ids = q.get("txn_ids") or ([q.get("txn_id")] if q.get("txn_id") else [])

    doc = {
        "id": upload_id,
        "company_id": portal["company_id"],
        "portal_id": token,
        "client_email": portal["client_email"],
        "question_id": question_id or None,
        "linked_txn_ids": linked_txn_ids,
        "filename": file.filename or "upload",
        "content_type": file.content_type or "application/octet-stream",
        "size_bytes": len(raw),
        "note": (note or "").strip() or None,
        "data_base64": b64,
        "uploaded_at": now_iso(),
        "status": "pending_review",
    }
    await db.portal_uploads.insert_one(doc)

    # Attach a breadcrumb to each linked transaction and to the question
    # so the CPA's Cockpit shows real movement.
    now = now_iso()
    for tid in linked_txn_ids:
        try:
            t = await db.transactions.find_one({"id": tid, "company_id": portal["company_id"]})
            if not t:
                continue
            crumb = f"\n[Client uploaded {file.filename} via portal on {now[:10]}]"
            await db.transactions.update_one(
                {"id": tid, "company_id": portal["company_id"]},
                {"$set": {
                    "ai_comment": (t.get("ai_comment") or "") + crumb,
                    "has_portal_upload": True,
                    "updated_at": now,
                }},
            )
        except Exception:  # noqa: BLE001
            continue

    if question_id and q and q.get("status") != "answered":
        # Auto-answer the question with "receipt uploaded" so it clears
        # off the client's queue and the Close Board unblocks.
        auto_answer = f"[Uploaded {file.filename}{f' — {note}' if note else ''}]"
        await db.client_questions.update_one(
            {"id": question_id},
            {"$set": {"status": "answered", "answer": auto_answer, "answered_at": now}},
        )

    return {"status": "uploaded", "upload_id": upload_id, "linked_txn_count": len(linked_txn_ids)}
