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
import veryfi_service

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
# Veryfi OCR + auto-match  (Phase 2.5)
# ---------------------------------------------------------------------------

def _veryfi_receipt_fields(veryfi_data: dict) -> dict:
    """Distill the fields that matter for auto-match from a Veryfi
    receipt response. All values coerced to safe types."""
    def _get(k):
        v = veryfi_data.get(k)
        if isinstance(v, dict):
            return v.get("value") or v.get("name")
        return v

    vendor = veryfi_data.get("vendor") or {}
    vendor_name = None
    if isinstance(vendor, dict):
        vendor_name = vendor.get("name") or vendor.get("raw_name")
    elif isinstance(vendor, str):
        vendor_name = vendor

    total = _get("total")
    try:
        total_f = abs(float(total)) if total is not None else None
    except Exception:  # noqa: BLE001
        total_f = None

    date = _get("date") or _get("invoice_date")
    if isinstance(date, str) and len(date) >= 10:
        date = date[:10]

    return {
        "vendor_name": (vendor_name or "").strip() or None,
        "total": total_f,
        "date": date,
    }


def _score_match(txn: dict, fields: dict) -> float:
    """0.0–1.0 confidence that this txn is what the receipt is for."""
    score = 0.0
    v_total = fields.get("total")
    v_date = fields.get("date")
    v_vendor = (fields.get("vendor_name") or "").lower().strip()
    t_amt = abs(float(txn.get("amount") or 0))
    t_date = (txn.get("date") or "")[:10]
    t_desc = (txn.get("description") or "").lower()

    # Amount — the strongest signal.
    if v_total and t_amt:
        diff = abs(t_amt - v_total)
        if diff <= 0.02:
            score += 0.55
        elif diff <= max(1.0, v_total * 0.05):
            score += 0.35
        else:
            # Off by more than 5% → not this txn.
            return 0.0

    # Date proximity.
    if v_date and t_date:
        try:
            from datetime import date as _date
            vd = _date.fromisoformat(v_date)
            td = _date.fromisoformat(t_date)
            days = abs((vd - td).days)
            if days == 0:
                score += 0.25
            elif days <= 3:
                score += 0.15
            elif days <= 7:
                score += 0.05
            else:
                return 0.0  # More than a week off → not it.
        except Exception:  # noqa: BLE001
            pass

    # Vendor name — bonus, not a blocker.
    if v_vendor and t_desc:
        # First token match ("AWS" in "AWS charge") is enough.
        tokens = [t for t in v_vendor.replace(",", " ").split() if len(t) >= 3]
        if any(t in t_desc for t in tokens):
            score += 0.2

    return round(min(score, 1.0), 3)


async def _veryfi_auto_match(cid: str, veryfi_data: dict) -> Optional[dict]:
    """Return the best-scoring candidate txn, or None. Confidence
    threshold 0.6 — anything less lands the receipt in pending_review."""
    fields = _veryfi_receipt_fields(veryfi_data)
    if not fields.get("total") or not fields.get("date"):
        return None

    # Search window: ±7 days.
    from datetime import date as _date, timedelta
    try:
        vd = _date.fromisoformat(fields["date"])
    except Exception:  # noqa: BLE001
        return None
    lo = (vd - timedelta(days=7)).isoformat()
    hi = (vd + timedelta(days=7)).isoformat()

    total = fields["total"]
    amt_lo = total * 0.95 - 1.0
    amt_hi = total * 1.05 + 1.0

    candidates = await db.transactions.find({
        "company_id": cid,
        "posted": True,
        "date": {"$gte": lo, "$lte": hi},
        "$expr": {
            "$and": [
                {"$gte": [{"$abs": "$amount"}, amt_lo]},
                {"$lte": [{"$abs": "$amount"}, amt_hi]},
            ],
        },
        "$or": [
            {"has_receipt": {"$ne": True}},
            {"has_receipt": {"$exists": False}},
        ],
    }).limit(20).to_list(20)

    best = None
    best_score = 0.0
    for t in candidates:
        s = _score_match(t, fields)
        if s > best_score:
            best_score = s
            best = t

    if not best or best_score < 0.6:
        return None
    return {
        "txn_id": best["id"],
        "confidence": best_score,
        "matched_vendor": fields.get("vendor_name"),
        "matched_amount": fields.get("total"),
        "matched_date": fields.get("date"),
        "txn_description": best.get("description"),
        "txn_amount": abs(float(best.get("amount") or 0)),
        "txn_date": best.get("date"),
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

    # Pending advisor-report sign-offs for this client — surface as
    # first-class cards on the portal so the client's monthly approval
    # is a one-tap action instead of an email chase.
    pending_signoffs = []
    try:
        reports = await db.advisor_reports.find({
            "company_id": portal["company_id"],
            "sent_to_client_at": {"$ne": None},
        }).sort("period", -1).limit(12).to_list(12)
        for r in reports:
            sig = await db.client_signoffs.find_one({
                "company_id": portal["company_id"],
                "advisor_report_id": r["id"],
            })
            if sig and sig.get("status") == "approved":
                continue
            pending_signoffs.append({
                "report_id": r["id"],
                "period": r["period"],
                "kpis": r.get("kpis") or {},
                "narrative": r.get("narrative") or {},
                "status": (sig or {}).get("status") or "awaiting_approval",
            })
    except Exception:  # noqa: BLE001
        pending_signoffs = []

    return {
        "brand": portal.get("brand_snapshot", {}),
        "client_name": portal.get("client_name"),
        "open_count": len(open_qs),
        "open_questions": open_qs,
        "recent_questions": recent,
        "pending_signoffs": pending_signoffs,
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

    # Veryfi OCR + auto-match. Best-effort — a Veryfi outage or a
    # non-receipt image should never break the upload path.
    veryfi_fields: Optional[dict] = None
    auto_match: Optional[dict] = None
    if not linked_txn_ids:  # Only auto-match when the client didn't specify a target.
        try:
            veryfi_data = await veryfi_service.process_generic_document(
                raw, file.filename or "upload", file.content_type or "application/octet-stream",
            )
            veryfi_fields = _veryfi_receipt_fields(veryfi_data)
            auto_match = await _veryfi_auto_match(portal["company_id"], veryfi_data)
            if auto_match:
                linked_txn_ids = [auto_match["txn_id"]]
        except Exception:  # noqa: BLE001 — OCR is a bonus, never a blocker
            veryfi_fields = None
            auto_match = None

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
        "status": "auto_matched" if auto_match else "pending_review",
        "veryfi_fields": veryfi_fields,
        "auto_match": auto_match,
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
            match_note = (
                f" (auto-matched at {int(auto_match['confidence']*100)}% confidence)"
                if auto_match and tid == auto_match.get("txn_id") else ""
            )
            crumb = f"\n[Client uploaded {file.filename}{match_note} via portal on {now[:10]}]"
            await db.transactions.update_one(
                {"id": tid, "company_id": portal["company_id"]},
                {"$set": {
                    "ai_comment": (t.get("ai_comment") or "") + crumb,
                    "has_portal_upload": True,
                    "has_receipt": True,
                    "receipt_upload_id": upload_id,
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

    return {
        "status": "uploaded",
        "upload_id": upload_id,
        "linked_txn_count": len(linked_txn_ids),
        "auto_matched": bool(auto_match),
        "match": auto_match,
        "ocr": veryfi_fields,
    }


# ---------------------------------------------------------------------------
# Monthly sign-off — client approves the advisor report for a period.
# Turns "CPA emails, client acknowledges by silence" into a one-tap
# audit event that gates period-lock on the Close Board.
# ---------------------------------------------------------------------------

class SignoffApproveIn(BaseModel):
    note: Optional[str] = None


@public_router.post("/{token}/signoff/{report_id}")
async def portal_signoff_approve(token: str, report_id: str, inp: SignoffApproveIn):
    portal = await _load_portal(token)
    report = await db.advisor_reports.find_one({
        "id": report_id, "company_id": portal["company_id"],
    })
    if not report:
        raise HTTPException(404, "Report not found.")
    if not report.get("sent_to_client_at"):
        raise HTTPException(400, "Report hasn't been sent to you yet.")

    now = now_iso()
    signoff = {
        "id": str(uuid.uuid4()),
        "company_id": portal["company_id"],
        "period": report["period"],
        "advisor_report_id": report_id,
        "client_email": portal["client_email"],
        "client_name": portal.get("client_name"),
        "status": "approved",
        "note": (inp.note or "").strip() or None,
        "approved_at": now,
        "portal_id": token,
    }
    # One signoff per (company, period) — replace prior.
    await db.client_signoffs.delete_many({
        "company_id": portal["company_id"],
        "period": report["period"],
    })
    await db.client_signoffs.insert_one(signoff)
    await db.advisor_reports.update_one(
        {"id": report_id},
        {"$set": {"client_approved_at": now, "client_approved_by": portal["client_email"]}},
    )
    return {"status": "approved", "period": report["period"]}


class SignoffQuestionIn(BaseModel):
    question: str


@public_router.post("/{token}/signoff/{report_id}/questions")
async def portal_signoff_question(token: str, report_id: str, inp: SignoffQuestionIn):
    """Client sends back the report with a question. Creates a
    client_questions doc for the CPA + marks signoff status=questioned."""
    portal = await _load_portal(token)
    report = await db.advisor_reports.find_one({
        "id": report_id, "company_id": portal["company_id"],
    })
    if not report:
        raise HTTPException(404, "Report not found.")
    text = (inp.question or "").strip()
    if not text:
        raise HTTPException(400, "Question cannot be empty.")

    now = now_iso()
    q_id = str(uuid.uuid4())
    await db.client_questions.insert_one({
        "id": q_id,
        "company_id": portal["company_id"],
        "flow_type": "signoff_question",
        "question": text,
        "status": "answered",  # client-originated, not accountant-originated
        "answer": text,
        "sent_at": now,
        "answered_at": now,
        "to_email": portal["client_email"],
        "advisor_report_id": report_id,
    })
    await db.client_signoffs.update_one(
        {"company_id": portal["company_id"], "period": report["period"]},
        {
            "$set": {
                "status": "questioned",
                "questioned_at": now,
                "last_question_id": q_id,
                # Persist the report + client identity on insert so a
                # subsequent portal_home lookup surfaces status='questioned'
                # (portal_home filters by advisor_report_id).
                "advisor_report_id": report_id,
                "client_email": portal["client_email"],
                "portal_id": token,
            },
            "$setOnInsert": {
                "id": str(uuid.uuid4()),
            },
        },
        upsert=True,
    )
    return {"status": "questioned", "question_id": q_id}
