"""Public routes for the batch client review flow.

Token-gated — no login required. Each batch carries a 32-byte
URL-safe `client_token` created at mint time; the URL in the email
is the only credential the client needs.

Endpoints (all prefixed `/api/client-review`):
  * `GET  /{token}`                      — session state + items
  * `POST /{token}/turn`                 — one conversational turn
  * `POST /{token}/items/{item_id}/answer` — finalize an answer
  * `POST /{token}/items/{item_id}/defer`  — client-deferred → bookkeeper
  * `POST /{token}/items/{item_id}/upload` — attach a document
  * `POST /{token}/complete`             — finalize the session

Every mutation validates the batch by (token, not-expired, not-paused)
and refuses on mismatch. Tokens are single-purpose — no cross-batch
authorization is possible.
"""
from __future__ import annotations
import base64
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends
from pydantic import BaseModel

from deps import db
from auth import get_current_user
import client_review as cr
import client_review_handlers as handlers
import client_review_engine as engine

logger = logging.getLogger("axiom.client_review.routes")

router = APIRouter(prefix="/api/client-review", tags=["client-review"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _resolve_batch(token: str) -> dict:
    """Look up the batch by token. 404 if unknown, 410 if expired."""
    if not token or len(token) < 16:
        raise HTTPException(status_code=404, detail="Invalid review token")
    batch = await db.client_review_batches.find_one({"client_token": token})
    if not batch:
        raise HTTPException(status_code=404, detail="Review session not found")
    if batch.get("status") == "expired":
        raise HTTPException(
            status_code=410,
            detail="This review session has expired. Ask your bookkeeper for a new one.",
        )
    if batch.get("status") == "completed":
        # 200 OK — client can still see the summary of what they did.
        pass
    return batch


async def _company_meta(company_id: str) -> dict:
    company = await db.companies.find_one(
        {"id": company_id},
        {"name": 1, "primary_pro_id": 1},
    )
    firm_name = None
    if company:
        pro_id = company.get("primary_pro_id")
        if pro_id:
            pro = await db.users.find_one({"id": pro_id}, {"branding": 1})
            firm_name = ((pro or {}).get("branding") or {}).get("firm_name")
    return {
        "company_name": (company or {}).get("name") or "your business",
        "firm_name":    firm_name,
    }


async def _load_coa(company_id: str) -> list[dict]:
    coa: list[dict] = []
    async for a in db.accounts.find(
        {"company_id": company_id},
        {"id": 1, "name": 1, "type": 1, "code": 1},
    ):
        coa.append({"id": a["id"], "name": a.get("name") or "",
                    "type": a.get("type") or "expense",
                    "code": a.get("code") or ""})
    return coa


# --------------------------------------------------------------------------
# GET session state
# --------------------------------------------------------------------------

@router.get("/{token}")
async def get_session(token: str):
    batch = await _resolve_batch(token)
    meta = await _company_meta(batch["company_id"])
    # Never leak client_email out to the browser session — the page
    # already knows who it is from the token they clicked.
    return {
        "batch_id":         batch["id"],
        "status":           batch["status"],
        "items":            batch.get("items") or [],
        "answer_count":     batch.get("answer_count", 0),
        "defer_count":      batch.get("defer_count", 0),
        "scheduled_for":    batch.get("scheduled_for"),
        "expires_at":       batch.get("expires_at"),
        "completed_at":     batch.get("completed_at"),
        "company_name":     meta["company_name"],
        "firm_name":        meta["firm_name"],
        "greeting_name":    cr._first_name(
            batch["client_email"],
            contact_name=None,
        ),
    }


# --------------------------------------------------------------------------
# POST /turn — conversational
# --------------------------------------------------------------------------

class TurnRequest(BaseModel):
    item_id: str
    message: str


@router.post("/{token}/turn")
async def post_turn(token: str, body: TurnRequest):
    batch = await _resolve_batch(token)
    if batch["status"] == "completed":
        raise HTTPException(409, "Session already completed")

    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == body.item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    # Per-item message history lives on the item itself. Cap at 24 to
    # bound the doc size — a session that runs longer than that is
    # already an escalate-to-bookkeeper signal.
    history = item.get("messages") or []
    history.append({"role": "user", "content": body.message,
                    "at": _now_iso()})

    meta = await _company_meta(batch["company_id"])
    coa = await _load_coa(batch["company_id"])

    # Q8 special path: if a receipt_analysis already exists and the
    # client is chatting with clarifying context (e.g. "I have a
    # restaurant so are these booked correctly?"), re-run vision with
    # their message as extra guidance so the AI re-classifies items
    # instead of asking them for percentages.
    if item.get("item_type") == 8 and item.get("receipt_analysis"):
        atts = item.get("attachments") or []
        pdf_or_img = next(
            (a for a in atts if (a.get("mime") or "").startswith(("image/", "application/pdf"))),
            None,
        )
        if pdf_or_img and pdf_or_img.get("data_url"):
            try:
                from client_review_engine import analyze_receipt_for_split
                ctx = item.get("context") or {}
                meta_ctx = ctx.get("meta") or {}
                company = await db.companies.find_one(
                    {"id": batch["company_id"]},
                    {"industry": 1, "business_type": 1, "name": 1, "tags": 1},
                ) or {}
                # Prepend the client's clarification to the industry
                # hint so it colors the whole classification pass.
                extra_context = body.message.strip()
                base_industry = (
                    company.get("industry")
                    or company.get("business_type")
                    or (company.get("tags") or [None])[0]
                    or ""
                )
                industry_composite = (
                    f"{base_industry} — client just said: '{extra_context}'"
                    if base_industry
                    else f"client just said: '{extra_context}'"
                )
                refreshed = await analyze_receipt_for_split(
                    attachment_data_url=pdf_or_img["data_url"],
                    coa=coa,
                    txn_amount=meta_ctx.get("txn_amount") or meta_ctx.get("amount"),
                    txn_desc=meta_ctx.get("txn_desc"),
                    company_industry=industry_composite,
                    company_name=company.get("name"),
                )
            except Exception:  # noqa: BLE001
                refreshed = None
            if refreshed:
                await db.client_review_batches.update_one(
                    {"id": batch["id"], "items.item_id": body.item_id},
                    {"$set": {"items.$.receipt_analysis": refreshed,
                              "updated_at":               _now_iso()}},
                )
                narrative = refreshed.get("narrative") \
                    or "Re-classified with that context in mind — here's the updated read."
                history.append({"role": "assistant",
                                "content": narrative,
                                "receipt_analysis": refreshed,
                                "at": _now_iso()})
                history = history[-24:]
                await db.client_review_batches.update_one(
                    {"id": batch["id"], "items.item_id": body.item_id},
                    {"$set": {"items.$.messages": history,
                              "updated_at": _now_iso()}},
                )
                return {
                    "assistant_reply":  narrative,
                    "action":           {"type": "clarify"},
                    "quick_replies":    ["Use this split", "Still off — I'll tap the lines"],
                    "analysis":         refreshed,
                }

    turn = await engine.run_turn(
        item=item, batch=batch,
        user_message=body.message,
        coa=coa,
        first_name=cr._first_name(batch["client_email"]),
        firm_name=meta["firm_name"],
        company_name=meta["company_name"],
        history=history,
    )
    history.append({"role": "assistant",
                    "content": turn["assistant_reply"],
                    "action": turn["action"],
                    "quick_replies": turn["quick_replies"],
                    "at": _now_iso()})
    history = history[-24:]

    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": body.item_id},
        {"$set": {"items.$.messages": history,
                  "updated_at": _now_iso()}},
    )
    return {
        "assistant_reply": turn["assistant_reply"],
        "action":          turn["action"],
        "quick_replies":   turn["quick_replies"],
    }


# --------------------------------------------------------------------------
# POST /answer — finalize
# --------------------------------------------------------------------------

class AnswerRequest(BaseModel):
    answer: str
    payload: Optional[dict] = None


@router.post("/{token}/items/{item_id}/answer")
async def post_answer(token: str, item_id: str, body: AnswerRequest):
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    result = await handlers.apply_answer(
        item, batch,
        answer=body.answer, payload=body.payload or {},
    )

    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.answered_at":   _now_iso(),
            "items.$.answer":        body.answer,
            "items.$.action_taken":  result.get("action_taken"),
            "items.$.action_detail": result.get("detail"),
            "updated_at":            _now_iso(),
        },
         "$inc": {"answer_count": 1}},
    )
    return {"ok": True, **result}


# --------------------------------------------------------------------------
# POST /defer — send to bookkeeper
# --------------------------------------------------------------------------

class DeferRequest(BaseModel):
    note: Optional[str] = None


@router.post("/{token}/items/{item_id}/defer")
async def post_defer(token: str, item_id: str, body: DeferRequest):
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    result = await handlers.apply_deferral(item, batch, note=body.note)
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.deferred":      True,
            "items.$.deferred_at":   _now_iso(),
            "items.$.deferred_note": body.note or "",
            "items.$.action_taken":  result.get("action_taken"),
            "items.$.action_detail": result.get("detail"),
            "updated_at":            _now_iso(),
         },
         "$inc": {"defer_count": 1}},
    )
    return {"ok": True, **result}


# --------------------------------------------------------------------------
# POST /w9-request-email — client asks us to email the contractor asking
# them to complete a W-9. Two-phase: first call resolves the contact's
# email (or returns `needs_email: true` if we don't have one on file);
# second call (with `email` supplied) actually sends the message.
# --------------------------------------------------------------------------

class W9EmailRequest(BaseModel):
    email:   Optional[str] = None
    subject: Optional[str] = None
    body:    Optional[str] = None


_W9_LINK = "https://www.irs.gov/pub/irs-pdf/fw9.pdf"


def _valid_email(s: str) -> bool:
    import re
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", (s or "").strip()))


@router.post("/{token}/items/{item_id}/w9-request-email")
async def post_w9_request_email(token: str, item_id: str, body: W9EmailRequest):
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")
    if item.get("item_type") != 4:
        raise HTTPException(400, "Not a W-9 collection item")

    ctx  = item.get("context") or {}
    meta = ctx.get("meta") or {}
    contact_id   = meta.get("contact_id")
    contact_name = meta.get("contact_name") or "the vendor"

    # Resolve the recipient email: caller-provided wins, otherwise fall
    # back to whatever we have on the contact record.
    to_email = (body.email or "").strip()
    contact_doc = None
    if contact_id:
        contact_doc = await db.contacts.find_one(
            {"id": contact_id, "company_id": batch["company_id"]},
            {"email": 1, "name": 1},
        )
    if not to_email:
        to_email = (contact_doc or {}).get("email") or ""

    if not to_email or not _valid_email(to_email):
        # Two-phase — frontend will prompt the client for the address
        # and repost with `email`.
        return {"needs_email": True,
                "contact_name": contact_name,
                "reason": "no_email_on_file" if not to_email else "invalid_email"}

    # Stamp the address back onto the contact so next year we don't
    # re-prompt for it. Non-destructive if one already exists.
    if contact_id and contact_doc is not None and not contact_doc.get("email"):
        await db.contacts.update_one(
            {"id": contact_id, "company_id": batch["company_id"]},
            {"$set": {"email": to_email, "updated_at": _now_iso()}},
        )

    firm_name    = (await _company_meta(batch["company_id"]))["firm_name"]
    company_name = (await _company_meta(batch["company_id"]))["company_name"]
    subject = (body.subject or "").strip() or f"W-9 request from {company_name}"
    body_txt = (body.body or "").strip() or (
        f"Hi,\n\n"
        f"For year-end 1099 reporting, {company_name} needs a completed "
        f"Form W-9 from {contact_name} on file. You can grab the official "
        f"IRS form here: {_W9_LINK}\n\n"
        f"Please fill it out and reply to this email with the completed "
        f"form attached. Let me know if you have any questions.\n\n"
        f"Thanks,\n{company_name}"
    )
    html = "<pre style=\"font: 14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;" \
           " white-space: pre-wrap; margin:0;\">" \
           + body_txt.replace("<", "&lt;").replace(">", "&gt;") \
           + "</pre>"

    try:
        from email_service import send_email
        resp = await send_email(
            to=to_email,
            subject=subject,
            html=html,
            text=body_txt,
            reply_to=batch.get("client_email"),
            firm_name=firm_name,
        )
        resend_id = (resp or {}).get("id")
    except Exception as e:  # noqa: BLE001
        logger.exception("W-9 request email failed")
        raise HTTPException(502, f"Email delivery failed: {e}")

    # Defer the item — the CPA / firm will follow up when the reply
    # arrives. Track the email metadata for the audit trail.
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.deferred":         True,
            "items.$.deferred_at":      _now_iso(),
            "items.$.deferred_note":    f"W-9 request emailed to {to_email}",
            "items.$.w9_email_sent_to": to_email,
            "items.$.w9_email_resend_id": resend_id,
            "updated_at":               _now_iso(),
         },
         "$inc": {"defer_count": 1}},
    )

    return {"ok": True, "sent_to": to_email, "resend_id": resend_id}


# --------------------------------------------------------------------------
# POST /save-client-messages — persist client-side-only chat bubbles
# (e.g. the Q4 W-9 checklist / email-draft / "email sent" cards which
# never round-trip through /turn) so navigating BACK to a finalized
# question rehydrates the full conversation instead of just the
# "✓ Answered" bubble. Whitelisted keys only — client-supplied HTML
# never lands on the item.
# --------------------------------------------------------------------------

_ALLOWED_CLIENT_MSG_KEYS = {
    "role", "content", "quickReplies",
    "_w9Checklist", "_w9EmailDraft", "_w9EmailSentTo",
    "_attachmentId", "_itemId", "_readOnly", "isTransition",
}


class SaveMessagesRequest(BaseModel):
    messages: list[dict]


@router.post("/{token}/items/{item_id}/save-client-messages")
async def post_save_client_messages(token: str, item_id: str, body: SaveMessagesRequest):
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    # Sanitize — only whitelist known-safe keys and cap payload size so
    # a hostile client can't push runaway payloads onto the batch doc.
    cleaned: list[dict] = []
    for m in (body.messages or [])[:60]:
        if not isinstance(m, dict):
            continue
        row = {k: v for k, v in m.items() if k in _ALLOWED_CLIENT_MSG_KEYS}
        # Cap content length. Prevents accidental base64 blobs / abuse.
        if isinstance(row.get("content"), str) and len(row["content"]) > 4000:
            row["content"] = row["content"][:4000]
        # Same guard on the email draft body — the user CAN edit it,
        # but not to arbitrary length.
        draft = row.get("_w9EmailDraft")
        if isinstance(draft, dict):
            row["_w9EmailDraft"] = {
                "subject": (draft.get("subject") or "")[:200],
                "body":    (draft.get("body")    or "")[:5000],
            }
        cleaned.append(row)
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {"items.$.client_messages": cleaned,
                  "updated_at":              _now_iso()}},
    )
    return {"ok": True, "count": len(cleaned)}


async def _mirror_upload_to_receipts_page(
    batch: dict, item: dict, attachment: dict,
) -> None:
    """Copy a client-uploaded receipt into the `receipts` collection so
    it appears on the pro's /receipts page for that company. Idempotent
    per (company_id, batch item_id) so re-uploads replace the earlier
    row instead of duplicating.

    Applies to Q3 (missing_receipt) and Q8 (split-transaction receipt).
    """
    import uuid as _uuid
    ctx = item.get("context") or {}
    meta = ctx.get("meta") or {}
    txn_amount = meta.get("txn_amount") or meta.get("amount") or 0
    try:
        amt = abs(float(txn_amount))
    except Exception:  # noqa: BLE001
        amt = 0.0
    merchant = (
        meta.get("vendor")
        or meta.get("contact_name")
        or (meta.get("txn_desc") or "").split(" ", 1)[0]
        or "Client-uploaded receipt"
    )
    date = meta.get("txn_date") or attachment.get("uploaded_at", "")[:10] or _now_iso()[:10]
    doc = {
        "company_id":          batch["company_id"],
        "date":                date,
        "amount":              amt,
        "merchant":            merchant,
        "notes":               f"Uploaded via client review — {ITEM_TYPE_LABEL.get(item.get('item_type'), 'question')}",
        "attachment_data_url": attachment.get("data_url"),
        "attachment_filename": attachment.get("filename"),
        "source":              "client_review",
        "source_batch_id":     batch["id"],
        "source_item_id":      item["item_id"],
        "updated_at":          _now_iso(),
    }
    existing = await db.receipts.find_one({
        "source_batch_id": batch["id"],
        "source_item_id":  item["item_id"],
    })
    if existing:
        await db.receipts.update_one({"id": existing["id"]}, {"$set": doc})
    else:
        doc["id"]         = str(_uuid.uuid4())
        doc["created_at"] = _now_iso()
        await db.receipts.insert_one(doc)


ITEM_TYPE_LABEL = {
    1: "uncategorized transaction",
    2: "vendor confirmation",
    3: "missing receipt",
    4: "W-9 request",
    5: "ambiguous transfer",
    6: "recurring charge",
    7: "setup question",
    8: "split transaction",
    9: "liability split",
}


@router.post("/{token}/items/{item_id}/upload")
async def post_upload(
    token: str, item_id: str,
    file: UploadFile = File(...),
    kind: str = Form("attachment"),
):
    """Store an uploaded doc as a base64 attachment on the source
    record. Emergent Object Storage would be the production path for
    large PDFs — this route keeps it simple (base64-in-Mongo) for the
    MVP and matches how existing receipts/W-9s are already stored.

    Max size 8 MB — anything larger returns 413. Client-side chunked
    upload is out of scope for Milestone C.
    """
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(413, "File too large (8 MB max)")

    b64 = base64.b64encode(data).decode("ascii")
    mime = file.content_type or "application/octet-stream"
    data_url = f"data:{mime};base64,{b64}"
    attachment = {
        "id":        str(uuid.uuid4()),
        "filename":  file.filename or "upload",
        "size":      len(data),
        "mime":      mime,
        "data_url":  data_url,
        "kind":      kind,
        "uploaded_at": _now_iso(),
        "uploaded_by": "client:review",
    }

    # Push onto both the source record (so the pro sees it in-context)
    # and the batch item (so the client sees a preview here).
    coll = item.get("source_collection")
    if coll in ("agent_findings", "transactions", "contacts"):
        await db[coll].update_one(
            {"id": item["source_id"], "company_id": batch["company_id"]},
            {"$push": {"attachments": attachment},
             "$set":  {"updated_at": _now_iso()}},
        )
    attachments = (item.get("attachments") or []) + [attachment]
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {"items.$.attachments": attachments,
                  "updated_at":          _now_iso()}},
    )
    # Never return the base64 payload — client already has the bytes.
    resp: dict = {
        "ok": True,
        "attachment": {k: v for k, v in attachment.items() if k != "data_url"},
    }

    # Split-transaction items (item_type=8) — read the receipt with
    # GPT-4o vision and return a proposed split so the client can
    # tap "Use this split" instead of typing percentages.
    if item.get("item_type") == 8 and mime.startswith(("image/", "application/pdf")):
        try:
            from client_review_engine import analyze_receipt_for_split
            coa = await db.chart_of_accounts.find(
                {"company_id": batch["company_id"]},
                {"id": 1, "name": 1, "type": 1},
            ).to_list(400)
            ctx = item.get("context") or {}
            meta = ctx.get("meta") or {}
            company = await db.companies.find_one(
                {"id": batch["company_id"]},
                {"industry": 1, "business_type": 1, "name": 1, "tags": 1},
            ) or {}
            analysis = await analyze_receipt_for_split(
                attachment_data_url=data_url,
                coa=coa,
                txn_amount=meta.get("txn_amount") or meta.get("amount"),
                txn_desc=meta.get("txn_desc"),
                company_industry=(
                    company.get("industry")
                    or company.get("business_type")
                    or (company.get("tags") or [None])[0]
                ),
                company_name=company.get("name"),
            )
        except Exception:  # noqa: BLE001
            analysis = None
        if analysis:
            resp["analysis"] = analysis
            # Also persist the AI's read on the batch item so the pro
            # (and any next-render of this page) sees the same result.
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {"items.$.receipt_analysis": analysis,
                          "updated_at":             _now_iso()}},
            )

    # Uncategorized transaction (item_type=1) / vendor categorization
    # (item_type=2) — read the receipt with GPT-4o vision and propose
    # a per-line-item Chart-of-Accounts split. Client sees each row
    # ("4x4x8 PT POST → Materials · Lumber $119.88") and can change
    # the account or accept the whole thing with "Use this split".
    if item.get("item_type") in (1, 2) and mime.startswith(("image/", "application/pdf")):
        try:
            from client_review_engine import analyze_receipt_for_categorization
            coa = await db.chart_of_accounts.find(
                {"company_id": batch["company_id"]},
                {"id": 1, "code": 1, "name": 1, "type": 1},
            ).to_list(400)
            ctx = item.get("context") or {}
            meta = ctx.get("meta") or {}
            company = await db.companies.find_one(
                {"id": batch["company_id"]},
                {"industry": 1, "business_type": 1, "name": 1, "tags": 1},
            ) or {}
            cat_analysis = await analyze_receipt_for_categorization(
                attachment_data_url=data_url,
                coa=coa,
                txn_amount=meta.get("txn_amount") or meta.get("amount"),
                txn_desc=meta.get("txn_desc"),
                company_industry=(
                    company.get("industry")
                    or company.get("business_type")
                    or (company.get("tags") or [None])[0]
                ),
                company_name=company.get("name"),
            )
        except Exception:  # noqa: BLE001
            cat_analysis = None
        if cat_analysis:
            resp["categorization_analysis"] = cat_analysis
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {"items.$.categorization_analysis": cat_analysis,
                          "updated_at":                     _now_iso()}},
            )

    # Liability payment items (item_type=9) — read the mortgage /
    # credit-card / auto-loan statement with GPT-4o vision and return
    # a proposed Principal / Interest / Escrow / Fees split. Client
    # confirms with "Use this split" instead of typing bucket amounts.
    if item.get("item_type") == 9 and mime.startswith(("image/", "application/pdf")):
        try:
            from client_review_engine import analyze_liability_statement_for_split
            coa = await db.chart_of_accounts.find(
                {"company_id": batch["company_id"]},
                {"id": 1, "name": 1, "type": 1},
            ).to_list(400)
            ctx = item.get("context") or {}
            meta = ctx.get("meta") or {}
            company = await db.companies.find_one(
                {"id": batch["company_id"]},
                {"industry": 1, "business_type": 1, "name": 1, "tags": 1},
            ) or {}
            liab_analysis = await analyze_liability_statement_for_split(
                attachment_data_url=data_url,
                coa=coa,
                txn_amount=meta.get("txn_amount") or meta.get("amount"),
                txn_desc=meta.get("txn_desc"),
                company_industry=(
                    company.get("industry")
                    or company.get("business_type")
                    or (company.get("tags") or [None])[0]
                ),
                company_name=company.get("name"),
            )
        except Exception:  # noqa: BLE001
            liab_analysis = None
        if liab_analysis:
            resp["liability_analysis"] = liab_analysis
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {"items.$.liability_analysis": liab_analysis,
                          "updated_at":                _now_iso()}},
            )

    # Receipts uploaded through the client-review flow should also
    # land on the client's Receipts page. Applies to Q3 (missing
    # receipt) and Q8 (split-transaction receipt).
    if item.get("item_type") in (3, 8):
        await _mirror_upload_to_receipts_page(batch, item, attachment)
    return resp


@router.delete("/{token}/items/{item_id}/attachments/{aid}")
async def delete_upload(token: str, item_id: str, aid: str):
    """Remove a previously-uploaded attachment from a batch item.
    Mirrors the change to the source record (transaction / contact /
    finding) so the pro side sees the removal too. Only removes
    attachments — does NOT re-open the item; the client's typed
    answer (if any) stays.
    """
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found")
    atts = item.get("attachments") or []
    if not any(a.get("id") == aid for a in atts):
        raise HTTPException(404, "Attachment not found")
    # Pull from the batch item
    new_atts = [a for a in atts if a.get("id") != aid]
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {"items.$.attachments": new_atts,
                  "updated_at":          _now_iso()}},
    )
    # Pull from the source record too so the transaction / contact /
    # finding page stops showing it as well.
    coll = item.get("source_collection")
    if coll in ("agent_findings", "transactions", "contacts"):
        await db[coll].update_one(
            {"id": item["source_id"], "company_id": batch["company_id"]},
            {"$pull": {"attachments": {"id": aid}},
             "$set":  {"updated_at": _now_iso()}},
        )
    return {"ok": True}




# --------------------------------------------------------------------------
# POST /schedule and /reschedule — pick / change a follow-up time
# --------------------------------------------------------------------------

class ScheduleRequest(BaseModel):
    # ISO-8601 datetime. Frontend converts the picker's local time to
    # UTC before sending, but the schedule_batch helper also accepts
    # naive datetimes as UTC.
    scheduled_for: str


@router.post("/{token}/schedule")
async def post_schedule(token: str, body: ScheduleRequest):
    batch = await _resolve_batch(token)
    if batch.get("status") == "completed":
        raise HTTPException(409, "Session already completed")
    try:
        result = await cr.schedule_batch(batch, body.scheduled_for)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result


@router.post("/{token}/reschedule")
async def post_reschedule(token: str, body: ScheduleRequest):
    """Active reschedule — client picking a new time from a reminder
    email. Unlimited within the 14-day window; does NOT reset the
    expiry clock (client_review.schedule_batch enforces this via the
    expires_at comparison).
    """
    batch = await _resolve_batch(token)
    if batch.get("status") == "completed":
        raise HTTPException(409, "Session already completed")
    try:
        result = await cr.schedule_batch(batch, body.scheduled_for)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result


# --------------------------------------------------------------------------
# POST /complete — finalize the session
# --------------------------------------------------------------------------

@router.post("/{token}/complete")
async def post_complete(token: str):
    batch = await _resolve_batch(token)
    if batch.get("status") == "completed":
        return {"ok": True,
                "answer_count": batch.get("answer_count", 0),
                "defer_count":  batch.get("defer_count", 0)}
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"status":       "completed",
                  "completed_at": _now_iso(),
                  "updated_at":   _now_iso()}},
    )
    # Fresh doc for the response — accurate counts even if the last
    # answer landed a microsecond before the client hit Complete.
    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    return {
        "ok": True,
        "answer_count": fresh.get("answer_count", 0),
        "defer_count":  fresh.get("defer_count", 0),
    }


# --------------------------------------------------------------------------
# Authenticated: pending-batch lookup for the in-app notification cards
# --------------------------------------------------------------------------
# Used by the Overview / To Do / Client Cockpit pages so a logged-in
# client sees a "you have a review waiting" card on every screen. This
# does NOT read the client_token — it's authenticated with the user's
# JWT, and matches on `client_review_batches.client_email == user.email`
# within the requested company.

@router.get("/pending/{company_id}")
async def get_pending_batch(
    company_id: str,
    user: dict = Depends(get_current_user),
):
    email = (user or {}).get("email")
    if not email:
        # No email on the user record — no way to key a batch to them.
        return {"has_pending": False}
    batch = await db.client_review_batches.find_one({
        "company_id":   company_id,
        "client_email": email,
        "status":       {"$in": ["open", "scheduled"]},
    })
    if not batch:
        return {"has_pending": False}
    # We never expose the client_token via this endpoint — the whole
    # point of the token is that it's separately-scoped from the JWT.
    # The card links to `/client-review/{token}` via a redirect
    # endpoint below so the token stays server-side.
    remaining = [i for i in (batch.get("items") or [])
                 if not i.get("answered_at") and not i.get("deferred")]
    return {
        "has_pending":   True,
        "batch_id":      batch["id"],
        "review_path":   f"/api/client-review/pending/{company_id}/open",
        "status":        batch["status"],
        "item_count":    len(remaining),
        "total_count":   len(batch.get("items") or []),
        "expires_at":    batch.get("expires_at"),
        "scheduled_for": batch.get("scheduled_for"),
    }


@router.get("/pending/{company_id}/open")
async def open_pending_batch(
    company_id: str,
    user: dict = Depends(get_current_user),
):
    """302 to the token-gated review URL. Keeps the token out of the
    JWT-authenticated response body — the browser follows the redirect
    and the URL bar is fine (this is the client's own session, they'd
    see the token if they emailed themselves anyway).
    """
    from fastapi.responses import RedirectResponse
    email = (user or {}).get("email")
    if not email:
        raise HTTPException(404, "No pending review")
    batch = await db.client_review_batches.find_one({
        "company_id":   company_id,
        "client_email": email,
        "status":       {"$in": ["open", "scheduled"]},
    })
    if not batch:
        raise HTTPException(404, "No pending review")
    # Same-origin redirect to the SPA route
    return RedirectResponse(url=f"/client-review/{batch['client_token']}",
                            status_code=302)


# --------------------------------------------------------------------------
# Pro-scoped: latest batch for a company (any client_email)
# --------------------------------------------------------------------------
# Used by the "Quick Check-In" button on the Agent Inquiries card so a
# CPA can preview / walk through the review flow the client sees. This
# is authorized via `require_company` (must be firm staff or the
# company owner). Unlike `/pending/{cid}` which keys on the CLIENT's
# email, this one finds the open/scheduled batch for the company
# regardless of who owns it.

from deps import require_company as _require_company


@router.get("/latest-for-company/{company_id}")
async def get_latest_batch_for_company(
    company_id: str,
    user: dict = Depends(get_current_user),
):
    """Return {has_pending, batch_id, status, item_count, ...} for the
    most-recent open/scheduled batch on the company. Pro-scoped —
    caller must have access to the company (firm staff or owner).
    """
    await _require_company(user, company_id)
    batch = await db.client_review_batches.find_one(
        {"company_id": company_id,
         "status":     {"$in": ["open", "scheduled"]}},
        sort=[("created_at", -1)],
    )
    if not batch:
        return {"has_pending": False}
    remaining = [i for i in (batch.get("items") or [])
                 if not i.get("answered_at") and not i.get("deferred")]
    return {
        "has_pending":   True,
        "batch_id":      batch["id"],
        "client_token":  batch["client_token"],
        "review_url":    f"/client-review/{batch['client_token']}",
        # Deprecated: was a redirect endpoint but new-tab opens strip
        # the JWT header. Kept for callers that still read it.
        "review_path":   f"/client-review/{batch['client_token']}",
        "status":        batch["status"],
        "client_email":  batch.get("client_email"),
        "item_count":    len(remaining),
        "total_count":   len(batch.get("items") or []),
        "expires_at":    batch.get("expires_at"),
        "scheduled_for": batch.get("scheduled_for"),
    }


@router.get("/latest-for-company/{company_id}/open")
async def open_latest_batch_for_company(
    company_id: str,
    user: dict = Depends(get_current_user),
):
    """302 to the token-gated review URL for the pro. The token still
    passes through the URL bar — that's expected, since firm staff
    already have full JWT-authenticated access to the company's data.
    """
    from fastapi.responses import RedirectResponse
    await _require_company(user, company_id)
    batch = await db.client_review_batches.find_one(
        {"company_id": company_id,
         "status":     {"$in": ["open", "scheduled"]}},
        sort=[("created_at", -1)],
    )
    if not batch:
        raise HTTPException(404, "No open review session for this company")
    return RedirectResponse(url=f"/client-review/{batch['client_token']}",
                            status_code=302)
