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
import re
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends, Body
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
            batch.get("client_email") or "",
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
# Phase-1 state model — /draft + /book + compliance-tab
# --------------------------------------------------------------------------
# Every Quick Check-in item now has an internal state machine:
#   gathering → drafted → confirmed → booked
# * /draft     — merge structured fields into `item.draft`; recomputes
#                `bookable`; flips state to "drafted" when bookable.
# * /book      — fires the type-specific handler (same handlers /answer
#                uses) and marks state="booked". Refuses unless
#                `bookable == True` — the "not done until bookable" gate.
# The legacy /answer endpoint stays for LLM-driven closures on item
# types that haven't been rewired yet.


class DraftRequest(BaseModel):
    draft: Dict[str, Any] = {}
    replace: bool = False  # if true, wholesale replace instead of merge


@router.post("/{token}/items/{item_id}/draft")
async def post_draft(token: str, item_id: str, body: DraftRequest):
    """Merge (or replace) structured fields into `item.draft` and
    recompute `bookable`. Never mutates `db.transactions`."""
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    current = {} if body.replace else (item.get("draft") or {})
    merged  = {**current, **body.draft}
    item["draft"] = merged
    bookable, reason = handlers.check_bookable(item)
    new_state = "drafted" if bookable else "gathering"

    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.draft":    merged,
            "items.$.bookable": bookable,
            "items.$.state":    new_state,
            "updated_at":       _now_iso(),
        }},
    )
    return {"ok": True, "state": new_state, "bookable": bookable,
            "reason": reason if not bookable else "",
            "draft": merged}


class BookRequest(BaseModel):
    # Optional passthrough: if the client wants to override or add a
    # final field at book time without another /draft round-trip.
    draft: Optional[Dict[str, Any]] = None


@router.post("/{token}/items/{item_id}/book")
async def post_book(token: str, item_id: str, body: BookRequest):
    """Fire the type-specific handler using the item's saved draft as
    the answer payload. Refuses unless the draft is bookable."""
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i["item_id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    if body.draft:
        item["draft"] = {**(item.get("draft") or {}), **body.draft}

    bookable, reason = handlers.check_bookable(item)
    if not bookable:
        raise HTTPException(422, f"Not bookable yet: {reason}")

    result = await handlers.apply_answer(
        item, batch,
        answer=(item.get("draft") or {}).get("answer_text") or "booked",
        payload=item.get("draft") or {},
    )
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.state":         "booked",
            "items.$.booked_at":     _now_iso(),
            "items.$.draft":         item.get("draft") or {},
            "items.$.answered_at":   _now_iso(),
            "items.$.action_taken":  result.get("action_taken"),
            "items.$.action_detail": result.get("detail"),
            "updated_at":            _now_iso(),
        },
         "$inc": {"answer_count": 1}},
    )
    return {"ok": True, "state": "booked", **result}


@router.get("/{token}/compliance-tab")
async def get_compliance_tab(token: str):
    """Persistent-header rollup: counts of open Meals / Travel /
    Lodging substantiation + W-9 status."""
    batch = await _resolve_batch(token)
    items = batch.get("items") or []
    def _open_count(item_type: int) -> int:
        return sum(
            1 for i in items
            if i.get("item_type") == item_type
            and not i.get("answered_at")
            and not i.get("deferred")
        )
    from client_review import (
        ITEM_IRS_MEALS, ITEM_IRS_TRAVEL,
    )
    w9_outstanding = await db.contacts.count_documents({
        "company_id": batch["company_id"],
        "$or": [{"w9_on_file": {"$ne": True}}, {"w9_on_file": {"$exists": False}}],
        "requires_1099": True,
    })
    return {
        "meals_open":     _open_count(ITEM_IRS_MEALS),
        "travel_open":    _open_count(ITEM_IRS_TRAVEL),
        "lodging_open":   0,
        "w9_outstanding": int(w9_outstanding or 0),
    }


@router.get("/{token}/unfinished-count")
async def get_unfinished_count(token: str):
    """For the top-of-list "You have N unfinished check-ins" banner.
    Counts items in gathering/drafted with SOME draft progress."""
    batch = await _resolve_batch(token)
    items = batch.get("items") or []
    unfinished = sum(
        1 for i in items
        if not i.get("answered_at")
        and not i.get("deferred")
        and (i.get("state") in ("gathering", "drafted"))
        and (i.get("draft") or {})
    )
    return {"unfinished": unfinished}

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
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", (s or "").strip()))


@router.post("/{token}/ai-cleanup-row-reassign")
async def ai_cleanup_row_reassign(token: str, payload: dict = Body(...)):
    """Reassign ONE transaction inside a bundled/solo AI-cleanup card
    to a different contact than the AI's suggestion. Called by the
    Quick Check-in per-row Edit flow when the client says "these 12
    are fine but *that one* is actually Amazon, not PayPal".

    Body:
      {
        "applied_id":   "<audit record id>",
        "txn_id":       "<transaction id>",
        "contact_id":   "<existing contact id>" (or)
        "contact_name": "<new/existing name>"
      }

    Effects:
      • Reassign the single txn's contact_id / contact_name.
      • Pop the txn_id from the applied record's `txn_ids` array and
        drop its `previous_labels` entry so subsequent Undo/Acknowledge
        on the remaining bundle no longer touches this row.
      • Decrement the row `count` on the applied record.
      • If the applied record's txn_ids is now empty, mark it as
        `status: reassigned` (falls off the check-in queue).
      • Teach the new contact's `descriptor_aliases` this row's key so
        future imports route directly.
    """
    from contact_resolver import get_or_create_contact, normalize_descriptor
    batch = await _resolve_batch(token)
    cid = batch["company_id"]
    applied_id = (payload.get("applied_id") or "").strip()
    txn_id     = (payload.get("txn_id") or "").strip()
    if not applied_id or not txn_id:
        raise HTTPException(400, "applied_id and txn_id required")
    rec = await db.contact_cleanup_applied.find_one(
        {"id": applied_id, "company_id": cid})
    if not rec:
        raise HTTPException(404, "Cleanup record not found")
    if txn_id not in (rec.get("txn_ids") or []):
        raise HTTPException(400, "Transaction is not part of this pattern")

    # Resolve target contact.
    new_id = (payload.get("contact_id") or "").strip()
    new_name = (payload.get("contact_name") or "").strip()
    if new_id:
        target = await db.contacts.find_one(
            {"id": new_id, "company_id": cid},
            {"_id": 0, "id": 1, "name": 1, "display_name": 1})
        if not target:
            raise HTTPException(400, f"Unknown contact_id {new_id}")
    elif new_name:
        target = await get_or_create_contact(cid, new_name,
                                             source="ai_client_row_reassign")
        if not target:
            raise HTTPException(500, "Couldn't resolve or create contact")
    else:
        raise HTTPException(400, "contact_id or contact_name required")

    now = datetime.now(timezone.utc).isoformat()
    tname = target.get("display_name") or target.get("name") or new_name

    # Update the transaction itself.
    t = await db.transactions.find_one(
        {"id": txn_id, "company_id": cid},
        {"_id": 0, "description": 1, "original_description": 1})
    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid},
        {"$set": {"contact_id": target["id"], "contact_name": tname,
                  "updated_at": now}},
    )
    # Teach descriptor alias on the correct contact.
    if t:
        key = normalize_descriptor(
            t.get("original_description") or t.get("description"))
        if key:
            await db.contacts.update_one(
                {"id": target["id"], "company_id": cid},
                {"$addToSet": {"descriptor_aliases": key},
                 "$set":      {"updated_at": now}},
            )

    # Pop this row off the audit record so future Yes/No on the bundle
    # only affects the remaining rows.
    prev_snap_key = f"previous_labels.{txn_id}"
    remaining_ids = [x for x in (rec.get("txn_ids") or []) if x != txn_id]
    new_count = max(0, int(rec.get("count") or 0) - 1)
    status_update = {}
    if not remaining_ids:
        status_update = {
            "status": "reassigned",
            "reassigned_at": now,
            "reassigned_via": "client_checkin_row_edit",
        }
    await db.contact_cleanup_applied.update_one(
        {"id": applied_id, "company_id": cid},
        {"$pull":  {"txn_ids": txn_id},
         "$unset": {prev_snap_key: ""},
         "$set":   {"count": new_count, "updated_at": now,
                    **status_update},
         "$push":  {"row_reassignments": {
             "txn_id":       txn_id,
             "to_id":        target["id"],
             "to_name":      tname,
             "at":           now,
             "via":          "client_checkin",
         }}},
    )
    return {"ok": True,
            "contact_id":   target["id"],
            "contact_name": tname,
            "remaining":    len(remaining_ids)}


# --------------------------------------------------------------------------
# Bulk row actions inside a single AI-cleanup bundle. Powers the toolbar
# that appears above the transaction list in the Quick Check-in when the
# client selects ≥1 row via checkboxes ("2 selected / Approve / Bulk
# update / Make these rules"). All three actions pop the selected txns
# out of the bundle so the card auto-collapses to zero when the client
# is done — mirroring the single-row Edit behaviour.
# --------------------------------------------------------------------------

async def _pop_txns_from_applied(cid: str, applied_id: str,
                                 txn_ids: list[str],
                                 via: str,
                                 extra_row_meta: dict | None = None) -> int:
    """Thin wrapper preserved for the existing single-row Edit path;
    routes to the shared `contact_cleanup_ops.pop_txns_from_applied`.
    """
    from contact_cleanup_ops import pop_txns_from_applied
    return await pop_txns_from_applied(
        cid, applied_id, txn_ids,
        via=via, extra_row_meta=extra_row_meta,
    )


@router.post("/{token}/ai-cleanup-bulk-approve")
async def ai_cleanup_bulk_approve(token: str, payload: dict = Body(...)):
    """Confirm N specific rows to the AI's suggested contact (i.e. the
    contact the sweep landed on). Rows are ALREADY assigned to that
    contact — this endpoint just pops them out of the bundle so the
    card shrinks and records an audit trail. No writes to the txn
    docs themselves are needed.
    """
    batch = await _resolve_batch(token)
    cid = batch["company_id"]
    applied_id = (payload.get("applied_id") or "").strip()
    txn_ids    = [x for x in (payload.get("txn_ids") or []) if x]
    if not applied_id or not txn_ids:
        raise HTTPException(400, "applied_id and txn_ids required")
    remaining = await _pop_txns_from_applied(
        cid, applied_id, txn_ids,
        via="client_checkin_bulk_approve",
    )
    return {"ok": True, "approved": len(txn_ids), "remaining": remaining}


@router.post("/{token}/ai-cleanup-bulk-reassign")
async def ai_cleanup_bulk_reassign(token: str, payload: dict = Body(...)):
    """Reassign N rows out of the bundle to a SINGLE other contact.
    Mirrors the single-row Edit path but batched — writes all txns,
    teaches descriptor aliases on the target contact, and pops the
    rows from the applied record in one go.
    """
    from contact_resolver import get_or_create_contact, normalize_descriptor
    batch = await _resolve_batch(token)
    cid = batch["company_id"]
    applied_id = (payload.get("applied_id") or "").strip()
    txn_ids    = [x for x in (payload.get("txn_ids") or []) if x]
    if not applied_id or not txn_ids:
        raise HTTPException(400, "applied_id and txn_ids required")

    new_id   = (payload.get("contact_id") or "").strip()
    new_name = (payload.get("contact_name") or "").strip()
    if new_id:
        target = await db.contacts.find_one(
            {"id": new_id, "company_id": cid},
            {"_id": 0, "id": 1, "name": 1, "display_name": 1})
        if not target:
            raise HTTPException(400, f"Unknown contact_id {new_id}")
    elif new_name:
        target = await get_or_create_contact(
            cid, new_name, source="ai_client_bulk_reassign")
        if not target:
            raise HTTPException(500, "Couldn't resolve or create contact")
    else:
        raise HTTPException(400, "contact_id or contact_name required")

    tname = target.get("display_name") or target.get("name") or new_name
    now = datetime.now(timezone.utc).isoformat()

    # Update every affected txn's contact + collect their descriptor
    # keys so we can teach them all in a single $addToSet.
    await db.transactions.update_many(
        {"id": {"$in": txn_ids}, "company_id": cid},
        {"$set": {"contact_id": target["id"], "contact_name": tname,
                  "updated_at": now}},
    )
    keys: set[str] = set()
    async for t in db.transactions.find(
        {"id": {"$in": txn_ids}, "company_id": cid},
        {"_id": 0, "description": 1, "original_description": 1},
    ):
        k = normalize_descriptor(
            t.get("original_description") or t.get("description"))
        if k:
            keys.add(k)
    if keys:
        await db.contacts.update_one(
            {"id": target["id"], "company_id": cid},
            {"$addToSet": {"descriptor_aliases": {"$each": sorted(keys)}},
             "$set":      {"updated_at": now}},
        )

    remaining = await _pop_txns_from_applied(
        cid, applied_id, txn_ids,
        via="client_checkin_bulk_reassign",
        extra_row_meta={"to_id": target["id"], "to_name": tname},
    )
    return {"ok": True,
            "reassigned":  len(txn_ids),
            "contact_id":   target["id"],
            "contact_name": tname,
            "remaining":    remaining}


@router.post("/{token}/ai-cleanup-bulk-rule")
async def ai_cleanup_bulk_rule(token: str, payload: dict = Body(...)):
    """"Make these rules" for N rows: teach each row's normalized
    descriptor as an alias on the AI-suggested contact so future
    imports auto-route directly (no re-review needed). Rows stay
    assigned to the AI contact; they just get popped from the bundle.
    """
    from contact_resolver import normalize_descriptor
    batch = await _resolve_batch(token)
    cid = batch["company_id"]
    applied_id = (payload.get("applied_id") or "").strip()
    txn_ids    = [x for x in (payload.get("txn_ids") or []) if x]
    if not applied_id or not txn_ids:
        raise HTTPException(400, "applied_id and txn_ids required")
    rec = await db.contact_cleanup_applied.find_one(
        {"id": applied_id, "company_id": cid},
        {"_id": 0, "contact_id": 1, "contact_name": 1})
    if not rec:
        raise HTTPException(404, "Cleanup record not found")
    target_id = rec.get("contact_id")
    if not target_id:
        raise HTTPException(500, "Applied record missing contact_id")

    keys: set[str] = set()
    async for t in db.transactions.find(
        {"id": {"$in": txn_ids}, "company_id": cid},
        {"_id": 0, "description": 1, "original_description": 1},
    ):
        k = normalize_descriptor(
            t.get("original_description") or t.get("description"))
        if k:
            keys.add(k)
    now = datetime.now(timezone.utc).isoformat()
    if keys:
        await db.contacts.update_one(
            {"id": target_id, "company_id": cid},
            {"$addToSet": {"descriptor_aliases": {"$each": sorted(keys)}},
             "$set":      {"updated_at": now}},
        )
    remaining = await _pop_txns_from_applied(
        cid, applied_id, txn_ids,
        via="client_checkin_bulk_rule",
        extra_row_meta={"rule_alias_count": len(keys),
                        "to_id": target_id,
                        "to_name": rec.get("contact_name")},
    )
    return {"ok": True,
            "rules_learned": len(keys),
            "rows":          len(txn_ids),
            "remaining":     remaining}


@router.get("/{token}/ai-cleanup-samples/{applied_id}")
async def ai_cleanup_samples(token: str, applied_id: str):
    """Hydrate an AI-cleanup pattern's sample transactions on demand.

    Used by the Quick Check-in card when the enclosing batch was minted
    BEFORE `_collect_ai_cleanup` learned to bake samples into the
    item's context — this keeps existing checkin links renderable
    without forcing the CPA to regenerate the batch."""
    batch = await _resolve_batch(token)
    rec = await db.contact_cleanup_applied.find_one(
        {"id": applied_id, "company_id": batch["company_id"]},
        {"_id": 0, "id": 1, "txn_ids": 1, "contact_name": 1, "count": 1,
         "before_labels": 1},
    )
    if not rec:
        raise HTTPException(404, "Cleanup record not found")
    txn_ids = rec.get("txn_ids") or []
    samples: list[dict] = []
    total = 0.0
    async for t in db.transactions.find(
        {"company_id": batch["company_id"], "id": {"$in": txn_ids[:12]}},
        {"_id": 0, "id": 1, "date": 1, "amount": 1,
         "description": 1, "original_description": 1},
    ).sort("date", -1):
        samples.append({
            "id":          t.get("id"),
            "date":        t.get("date"),
            "amount":      t.get("amount"),
            "description": t.get("description") or t.get("original_description") or "",
        })
    agg = db.transactions.aggregate([
        {"$match": {"company_id": batch["company_id"], "id": {"$in": txn_ids}}},
        {"$group": {"_id": None, "s": {"$sum": "$amount"}}},
    ])
    async for row in agg:
        total = float(row.get("s") or 0)
    return {
        "samples":       samples,
        "total_dollars": round(total, 2),
        "txn_ids":       txn_ids,
        "count":         rec.get("count"),
        "contact_name":  rec.get("contact_name"),
        "before_labels": rec.get("before_labels") or [],
    }


@router.get("/{token}/contacts")
async def list_contacts_for_review(token: str, q: str | None = None):
    """Contact directory for the batch's company — used by the Q2
    vendor-confirmation dropdown so the client picks from a real
    curated list (with typeahead search) instead of free-texting.
    Token-scoped only; never leaks contacts across companies."""
    batch = await _resolve_batch(token)
    query: dict = {"company_id": batch["company_id"]}
    if q and (q := q.strip()):
        import re as _re
        rx = _re.compile(_re.escape(q), _re.IGNORECASE)
        query["$or"] = [{"name": rx}, {"normalized_name": rx}]
    cursor = db.contacts.find(query, {"id": 1, "name": 1, "email": 1}) \
                        .sort("name", 1).limit(200)
    rows = await cursor.to_list(200)
    return {"contacts": [
        {"id": r["id"], "name": r.get("name") or "",
         "email": r.get("email") or ""} for r in rows
    ]}


class _CreateLiabilityIn(BaseModel):
    name: str
    # Optional — auto-assigned from the 2200-2999 block when blank.
    code: Optional[str] = None
    # Canonical Wave-style detail_type (e.g. "loan_and_line_of_credit",
    # "credit_card", "other_short_term_liability"). Required so the
    # balance sheet groups the account correctly.
    detail_type: Optional[str] = None
    # Legacy field — kept for callers that still pass a subtype-only
    # value. Ignored when `detail_type` is present.
    subtype: Optional[str] = None
    # Explicit parent — when null/blank, we auto-resolve the canonical
    # parent (Loans Payable / Credit Cards Payable) if the name/subtype
    # qualifies.
    parent_account_id: Optional[str] = None


@router.post("/{token}/accounts/liability")
async def create_liability_account_for_review(token: str, inp: _CreateLiabilityIn):
    """Token-scoped inline creation of a Liability CoA account. Used by
    the Deposit → Loan received flow so the client can mint a new
    account (e.g. "Vehicle Loan — Toyota") without leaving the
    check-in wizard or requiring firm auth. Mirrors the firm-side "New
    Account" modal shape (code / name / sub-type / sub-account of).
    Auto-parents under the canonical "Loans Payable" / "Credit Cards
    Payable" bucket when no explicit parent is passed and the
    name/subtype qualifies. Auto-assigns a free code in the liability
    block (2200-2999) when `code` is blank."""
    from account_normalize import normalize_account_fields

    batch = await _resolve_batch(token)
    company_id = batch["company_id"]
    name = (inp.name or "").strip()
    if not name:
        raise HTTPException(400, "Account name is required.")
    if len(name) > 100:
        raise HTTPException(400, "Account name is too long (100 char max).")

    # Snap sub-type/detail_type to canonical Wave keys — same
    # normalizer the firm-side create endpoint uses so the balance
    # sheet renders the account in the right group.
    caller_dt = (inp.detail_type or "").strip() or None
    caller_st = (inp.subtype or "").strip() or None
    subtype, detail_type = normalize_account_fields(
        acct_type="liability", name=name,
        subtype=caller_st, detail_type=caller_dt,
    )
    if not detail_type:
        # Fallback so `list_accounts_for_review` doesn't render a
        # groupless orphan. "Other Long-Term Liability" is the safest
        # default for the Loan-received flow.
        detail_type = "other_long_term_liability"
        subtype = "long_term_liability"

    # Reject exact-name duplicates so the picker doesn't grow a forest of
    # "Vehicle Loan" / "Vehicle Loan " variants when the client hits
    # Save twice on a flaky network.
    import re as _re
    name_norm = _re.sub(r"\s+", " ", name).lower()
    async for existing in db.accounts.find(
        {"company_id": company_id, "type": "liability"},
        {"id": 1, "name": 1, "code": 1, "type": 1, "subtype": 1,
         "detail_type": 1, "parent_account_id": 1},
    ):
        if _re.sub(r"\s+", " ", (existing.get("name") or "").strip()).lower() == name_norm:
            return {
                "id": existing["id"], "name": existing.get("name") or "",
                "code": existing.get("code") or "",
                "type": "liability",
                "subtype": existing.get("subtype") or "",
                "detail_type": existing.get("detail_type") or "",
                "parent_account_id": existing.get("parent_account_id"),
                "reused": True,
            }

    # Resolve parent: explicit override wins; else auto-parent when the
    # name/subtype qualifies (loan/HELOC/credit card).
    parent_id = (inp.parent_account_id or "").strip() or None
    if parent_id:
        par = await db.accounts.find_one(
            {"id": parent_id, "company_id": company_id, "type": "liability"},
            {"id": 1, "parent_account_id": 1})
        if not par:
            raise HTTPException(400, "Parent account not found or wrong type.")
        if par.get("parent_account_id"):
            raise HTTPException(400, "Parent must be a top-level account.")
    else:
        from routes.accounts import _resolve_liability_parent
        parent_id = await _resolve_liability_parent(company_id, name, subtype or "")

    # Code: user-supplied wins (uniqueness enforced); else auto-assign.
    supplied_code = (inp.code or "").strip() or None
    used: set[str] = set()
    async for a in db.accounts.find(
        {"company_id": company_id, "code": {"$exists": True}},
        {"code": 1},
    ):
        used.add(str(a.get("code") or ""))
    if supplied_code:
        if supplied_code in used:
            raise HTTPException(400, f"Code {supplied_code} is already used.")
        code = supplied_code
    else:
        code = None
        for n in range(2200, 3000, 10):
            if str(n) in ("2100", "2500"):
                continue
            if str(n) not in used:
                code = str(n); break
        if not code:
            for n in range(2200, 3000):
                if str(n) not in used:
                    code = str(n); break

    aid = str(uuid.uuid4()); now = _now_iso()
    doc = {
        "id": aid, "company_id": company_id, "code": code, "name": name,
        "type": "liability", "subtype": subtype or "",
        "detail_type": detail_type,
        "active": True, "balance": 0.0,
        "parent_account_id": parent_id,
        "created_at": now, "updated_at": now,
        "source": "client_review_loan_picker",
    }
    await db.accounts.insert_one(doc)
    return {
        "id": aid, "name": name, "code": code,
        "type": "liability",
        "subtype": subtype or "",
        "detail_type": detail_type,
        "parent_account_id": parent_id,
        "reused": False,
    }


# Code block per account type, used to auto-assign a free code when
# the caller doesn't supply one. Ranges mirror the seeded DEFAULT_COA
# so hand-built lines cluster with their neighbors.
_CODE_BLOCK_BY_TYPE: dict[str, tuple[int, int]] = {
    "asset":     (1300, 1999),
    "liability": (2200, 2999),
    "equity":    (3300, 3999),
    "income":    (4300, 4999),
    "revenue":   (4300, 4999),
    "expense":   (6100, 8999),
    "cogs":              (5100, 5999),
    "cost_of_goods_sold": (5100, 5999),
}


class _CreateAccountIn(BaseModel):
    # Type must be one of the standard buckets — this endpoint
    # deliberately does NOT allow "bank" / "credit_card" / etc.
    # sub-types (they need a bank account setup flow).
    type: str
    name: str
    code: Optional[str] = None
    detail_type: Optional[str] = None
    subtype: Optional[str] = None
    parent_account_id: Optional[str] = None


@router.post("/{token}/accounts")
async def create_account_for_review(token: str, inp: _CreateAccountIn):
    """Token-scoped inline creation of a CoA account of ANY standard
    type (asset / liability / equity / income / expense / cogs). Used
    by the Liability Payment "Change" affordance on each bucket so
    the client can mint a specific expense/asset account (e.g.
    "Vehicle Insurance", "Prepaid Property Tax") without leaving the
    check-in wizard. Auto-assigns a free code in the type's block
    when blank; auto-parents under a canonical bucket if the name /
    subtype qualifies (currently only wired for liability — other
    types get inserted top-level unless an explicit parent is
    passed)."""
    from account_normalize import normalize_account_fields

    batch = await _resolve_batch(token)
    company_id = batch["company_id"]

    atype = (inp.type or "").strip().lower()
    if atype not in _CODE_BLOCK_BY_TYPE:
        raise HTTPException(400, f"Unsupported account type: {atype!r}. "
                                  "Use one of: asset, liability, equity, "
                                  "income, expense, cogs.")
    # Route liability creates through the specialized endpoint's
    # logic so all the parent-bucket / detail_type policies stay
    # consistent (loan sub-accounts nest under Loans Payable, etc.).
    if atype == "liability":
        return await create_liability_account_for_review(
            token,
            _CreateLiabilityIn(
                name=inp.name, code=inp.code,
                detail_type=inp.detail_type, subtype=inp.subtype,
                parent_account_id=inp.parent_account_id,
            ),
        )

    name = (inp.name or "").strip()
    if not name:
        raise HTTPException(400, "Account name is required.")
    if len(name) > 100:
        raise HTTPException(400, "Account name is too long (100 char max).")

    subtype, detail_type = normalize_account_fields(
        acct_type=atype, name=name,
        subtype=(inp.subtype or "").strip() or None,
        detail_type=(inp.detail_type or "").strip() or None,
    )

    # Dedup by exact name within the same type — repeated "Save" on
    # a flaky connection shouldn't multiply account rows.
    name_norm = re.sub(r"\s+", " ", name).lower()
    async for existing in db.accounts.find(
        {"company_id": company_id, "type": atype},
        {"id": 1, "name": 1, "code": 1, "type": 1, "subtype": 1,
         "detail_type": 1, "parent_account_id": 1},
    ):
        if re.sub(r"\s+", " ", (existing.get("name") or "").strip()).lower() == name_norm:
            return {
                "id": existing["id"], "name": existing.get("name") or "",
                "code": existing.get("code") or "",
                "type": atype,
                "subtype": existing.get("subtype") or "",
                "detail_type": existing.get("detail_type") or "",
                "parent_account_id": existing.get("parent_account_id"),
                "reused": True,
            }

    # Validate parent (if given) is same-type + top-level.
    parent_id = (inp.parent_account_id or "").strip() or None
    if parent_id:
        par = await db.accounts.find_one(
            {"id": parent_id, "company_id": company_id, "type": atype},
            {"id": 1, "parent_account_id": 1})
        if not par:
            raise HTTPException(400, "Parent account not found or wrong type.")
        if par.get("parent_account_id"):
            raise HTTPException(400, "Parent must be a top-level account.")

    # Code: user-supplied wins (uniqueness enforced); else auto-assign
    # from the type's block.
    lo, hi = _CODE_BLOCK_BY_TYPE[atype]
    supplied_code = (inp.code or "").strip() or None
    used: set[str] = set()
    async for a in db.accounts.find(
        {"company_id": company_id, "code": {"$exists": True}},
        {"code": 1},
    ):
        used.add(str(a.get("code") or ""))
    if supplied_code:
        if supplied_code in used:
            raise HTTPException(400, f"Code {supplied_code} is already used.")
        code = supplied_code
    else:
        code = None
        for n in range(lo, hi + 1, 10):   # prefer round decades
            if str(n) not in used:
                code = str(n); break
        if not code:
            for n in range(lo, hi + 1):
                if str(n) not in used:
                    code = str(n); break

    aid = str(uuid.uuid4()); now = _now_iso()
    doc = {
        "id": aid, "company_id": company_id, "code": code, "name": name,
        "type": atype, "subtype": subtype or "",
        "detail_type": detail_type or "",
        "active": True, "balance": 0.0,
        "parent_account_id": parent_id,
        "created_at": now, "updated_at": now,
        "source": "client_review_generic_picker",
    }
    await db.accounts.insert_one(doc)
    return {
        "id": aid, "name": name, "code": code,
        "type": atype,
        "subtype": subtype or "",
        "detail_type": detail_type or "",
        "parent_account_id": parent_id,
        "reused": False,
    }


@router.get("/{token}/accounts")
async def list_accounts_for_review(token: str):
    """Chart-of-accounts for the batch's company — used by the check-
    without-contact table so the client can pick a category. Token-
    scoped only; excludes retired accounts and the Uncategorized
    dumpster slots (9999, 6999, 4999)."""
    batch = await _resolve_batch(token)
    cursor = db.accounts.find({
        "company_id": batch["company_id"],
    }, {"id": 1, "name": 1, "type": 1, "code": 1,
        "retired_at": 1, "parent_account_id": 1})
    rows = await cursor.to_list(1000)
    exclude_codes = {"9999", "6999", "4999"}
    out = []
    for a in rows:
        if a.get("retired_at"):
            continue
        code = str(a.get("code") or "")
        if code in exclude_codes:
            continue
        out.append({
            "id":   a["id"],
            "name": a.get("name") or "",
            "type": a.get("type") or "",
            "code": code,
            "parent_account_id": a.get("parent_account_id"),
        })
    out.sort(key=lambda r: (r["code"] or "999", r["name"]))
    return {"accounts": out}


async def load_pickable_options(cid: str) -> dict:
    """Combined dropdown source for the check-assign flow (accounts +
    open bills). Extracted so the firm-authenticated To Do / Client
    Cockpit inline check allocator can reuse the exact same shape."""
    acct_cur = db.accounts.find({"company_id": cid},
        {"id": 1, "name": 1, "type": 1, "code": 1, "retired_at": 1})
    exclude_codes = {"9999", "6999", "4999"}
    accounts = []
    async for a in acct_cur:
        if a.get("retired_at"):
            continue
        code = str(a.get("code") or "")
        if code in exclude_codes:
            continue
        accounts.append({
            "id":   a["id"], "name": a.get("name") or "",
            "type": a.get("type") or "", "code": code,
        })
    accounts.sort(key=lambda r: (r["code"] or "999", r["name"]))

    bill_cur = db.bills.find({
        "company_id": cid,
        "$or": [
            {"status": {"$in": ["open", "partial", "overdue", "unpaid"]}},
            {"balance_due": {"$gt": 0.005}},
        ],
    }, {"id": 1, "vendor_name": 1, "contact_id": 1, "contact_name": 1,
        "bill_number": 1, "number": 1, "total": 1, "balance_due": 1,
        "due_date": 1, "date": 1, "line_items": 1})
    bills = []
    async for b in bill_cur:
        total    = float(b.get("total") or 0)
        balance  = float(b.get("balance_due", total) or 0)
        if balance <= 0.005:
            continue
        vendor   = (b.get("contact_name") or b.get("vendor_name") or "").strip()
        number   = (b.get("bill_number") or b.get("number") or "").strip()
        due      = b.get("due_date") or b.get("date") or ""
        default_acct = None
        for li in (b.get("line_items") or []):
            if li.get("category_account_id"):
                default_acct = li["category_account_id"]
                break
        bills.append({
            "id":                  b["id"],
            "contact_id":          b.get("contact_id"),
            "contact_name":        vendor,
            "number":              number,
            "total":               round(total, 2),
            "balance_due":         round(balance, 2),
            "due_date":            due,
            "default_account_id":  default_acct,
            "label": (f"Bill{(' #' + number) if number else ''} — "
                      f"{vendor or 'vendor'} — "
                      f"${balance:.2f} due"
                      f"{(' ' + due) if due else ''}"),
        })
    bills.sort(key=lambda b: (b.get("due_date") or "9999-99-99",
                              -b.get("balance_due", 0)))

    inv_cur = db.invoices.find({
        "company_id": cid,
        "$or": [
            {"status": {"$in": ["open", "partial", "overdue", "unpaid",
                                  "sent", "draft"]}},
            {"balance_due": {"$gt": 0.005}},
        ],
    }, {"id": 1, "customer_name": 1, "contact_id": 1, "contact_name": 1,
        "invoice_number": 1, "number": 1, "total": 1, "balance_due": 1,
        "due_date": 1, "date": 1, "line_items": 1})
    invoices = []
    async for inv in inv_cur:
        total   = float(inv.get("total") or 0)
        balance = float(inv.get("balance_due", total) or 0)
        if balance <= 0.005:
            continue
        customer = (inv.get("contact_name")
                    or inv.get("customer_name") or "").strip()
        number   = (inv.get("invoice_number")
                    or inv.get("number") or "").strip()
        due      = inv.get("due_date") or inv.get("date") or ""
        default_acct = None
        for li in (inv.get("line_items") or []):
            if li.get("category_account_id"):
                default_acct = li["category_account_id"]
                break
        invoices.append({
            "id":                 inv["id"],
            "contact_id":         inv.get("contact_id"),
            "contact_name":       customer,
            "number":             number,
            "total":              round(total, 2),
            "balance_due":        round(balance, 2),
            "due_date":           due,
            "default_account_id": default_acct,
            "label": (f"Invoice{(' #' + number) if number else ''} — "
                      f"{customer or 'customer'} — "
                      f"${balance:.2f} outstanding"
                      f"{(' due ' + due) if due else ''}"),
        })
    invoices.sort(key=lambda i: (i.get("due_date") or "9999-99-99",
                                 -i.get("balance_due", 0)))
    return {"accounts": accounts, "bills": bills, "invoices": invoices}


@router.get("/{token}/pickable")
async def list_pickable_options(token: str):
    """Combined dropdown source for the check-assign flow: every open
    bill the client could apply this check to, plus the filtered
    chart-of-accounts. Frontend renders these as two <optgroup>s in a
    single <select>. Token-scoped only.
    """
    batch = await _resolve_batch(token)
    return await load_pickable_options(batch["company_id"])


class CheckAssignLine(BaseModel):
    category_account_id: str | None = None
    bill_id: str | None = None
    amount: float
    description: str | None = None


class CheckAssignBody(BaseModel):
    txn_id: str
    contact_id: str | None = None
    create_contact_name: str | None = None
    line_items: list[CheckAssignLine]


@router.post("/{token}/items/{item_id}/check-assign")
async def post_check_assign(token: str, item_id: str, body: CheckAssignBody):
    """Client-facing check-without-payee assignment. Resolves payee
    (existing contact_id OR inline-created by name), validates the
    line-item sum matches the check amount, and stamps the underlying
    transaction with the same fields the CPA-side `/check-review/…/assign`
    endpoint would. Tracks row-level completion on the aggregate batch
    item so the client can save one row at a time; when every check in
    the collection is resolved the item is marked answered and the
    flow advances.
    """
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found on batch")
    return await apply_check_assign(batch, item, body)


async def apply_check_assign(batch: dict, item: dict, body: CheckAssignBody) -> dict:
    """Shared implementation of the check-without-payee assignment
    used by both the token-gated client route and the firm-authenticated
    inline allocator on the To Do / Client Cockpit responsibilities
    panel. Assumes the caller has already resolved the batch + item
    (auth model differs between the two callers)."""
    if item.get("item_type") != cr.ITEM_CHECK_NO_CONTACT:
        raise HTTPException(400, "Item is not a checks-without-contacts item")

    cid = batch["company_id"]
    item_id = item["item_id"]
    txn = await db.transactions.find_one({"id": body.txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Check transaction not found")

    # ---- Payee resolution ----------------------------------------
    #      Bills can override the payee (line has bill_id → vendor).
    bill_lookup: dict[str, dict] = {}
    for li in body.line_items:
        if li.bill_id and li.bill_id not in bill_lookup:
            b = await db.bills.find_one(
                {"id": li.bill_id, "company_id": cid},
            )
            if not b:
                raise HTTPException(400, f"Unknown bill_id {li.bill_id}")
            bill_lookup[li.bill_id] = b
    contact_id   = body.contact_id
    contact_name = ""
    if bill_lookup and not contact_id and not body.create_contact_name:
        vendors = {b.get("contact_id") for b in bill_lookup.values()
                   if b.get("contact_id")}
        if len(vendors) == 1:
            contact_id = next(iter(vendors))
            v = await db.contacts.find_one({"id": contact_id, "company_id": cid})
            contact_name = (v or {}).get("name") or ""
    if not contact_id and body.create_contact_name:
        name = body.create_contact_name.strip()
        if not name:
            raise HTTPException(400, "Payee name is required")
        existing = await db.contacts.find_one(
            {"company_id": cid, "name": name},
        )
        if existing:
            contact_id   = existing["id"]
            contact_name = existing["name"]
        else:
            contact_id   = str(uuid.uuid4())
            contact_name = name
            await db.contacts.insert_one({
                "id":         contact_id,
                "company_id": cid,
                "name":       contact_name,
                "type":       "vendor",
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
                "source":     "client_review_check_assign",
            })
    elif contact_id:
        c = await db.contacts.find_one({"id": contact_id, "company_id": cid})
        if not c:
            raise HTTPException(400, "Unknown contact_id")
        contact_name = c.get("name") or ""
    else:
        raise HTTPException(400, "Provide contact_id, create_contact_name, or a bill_id")

    # ---- Line-item sum must match the check ---------------------
    expected = round(abs(float(txn.get("amount") or 0)), 2)
    got      = round(sum(li.amount for li in body.line_items), 2)
    if abs(got - expected) > 0.005:
        raise HTTPException(
            400,
            f"Line total ${got:.2f} doesn't match check amount ${expected:.2f}",
        )
    for li in body.line_items:
        if not li.bill_id and not li.category_account_id:
            raise HTTPException(400, "Each line needs a bill_id OR a category")

    # ---- Bill balance-due decrement (best-effort application) ----
    for li in body.line_items:
        if not li.bill_id:
            continue
        b = bill_lookup[li.bill_id]
        old_bal = float(b.get("balance_due", b.get("total", 0)) or 0)
        new_bal = round(max(0.0, old_bal - float(li.amount)), 2)
        new_status = "paid" if new_bal < 0.005 else "partial"
        await db.bills.update_one(
            {"id": li.bill_id, "company_id": cid},
            {"$set": {"balance_due": new_bal,
                      "status":      new_status,
                      "updated_at":  _now_iso()},
             "$push": {"applied_check_txn_ids": body.txn_id}},
        )

    # ---- Stamp the transaction ---------------------------------
    splits = [{
        "amount":              round(float(li.amount), 2),
        "category_account_id": (li.category_account_id
                                or (bill_lookup.get(li.bill_id, {})
                                    .get("default_account_id"))
                                or None),
        "bill_id":             li.bill_id,
        "description":         li.description or "",
    } for li in body.line_items]
    single_cat = (splits[0]["category_account_id"]
                  if len(splits) == 1 else None)
    await db.transactions.update_one(
        {"id": body.txn_id, "company_id": cid},
        {"$set": {
            "contact_id":            contact_id,
            "contact_name":          contact_name,
            "splits":                splits,
            "category_account_id":   single_cat,
            "human_reviewed":        True,
            "needs_review":          False,
            "assigned_via":          "client_review_check_assign",
            "updated_at":            _now_iso(),
        }},
    )

    # ---- Track row-level completion on the batch item -----------
    resolved_ids = list(item.get("resolved_txn_ids") or [])
    if body.txn_id not in resolved_ids:
        resolved_ids.append(body.txn_id)
    all_check_ids = [c.get("id") for c in (item.get("context") or {}).get("checks", [])
                     if c.get("id")]
    all_done = all_check_ids and all(cid_ in resolved_ids for cid_ in all_check_ids)

    update: dict = {
        f"items.$.resolved_txn_ids": resolved_ids,
    }
    if all_done:
        update["items.$.answered_at"] = _now_iso()
        update["items.$.answer"]      = f"Resolved {len(resolved_ids)} check(s)"
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": update},
    )

    return {
        "status":              "assigned",
        "txn_id":              body.txn_id,
        "contact_id":          contact_id,
        "contact_name":        contact_name,
        "resolved_count":      len(resolved_ids),
        "total_count":         len(all_check_ids),
        "all_done":            bool(all_done),
    }


# --------------------------------------------------------------------------
# POST /link-doc — attach an Uncategorized transaction to an open bill (for
# money-out) or invoice (for money-in). Used by the two shortcut buttons on
# the Quick Check-in card for item_type 1 (Uncategorized transaction).
# --------------------------------------------------------------------------

class LinkDocBody(BaseModel):
    doc_type: str  # 'bill' or 'invoice'
    doc_id: str
    txn_id: Optional[str] = None  # per-row override for grouped items


@router.post("/{token}/items/{item_id}/link-doc")
async def post_link_doc(token: str, item_id: str, body: LinkDocBody):
    """Book an uncategorized transaction against an open bill (AP) or
    invoice (AR). Decrements the doc's balance_due, stamps the txn
    with the doc's vendor/customer + the AP/AR account, and marks the
    check-in item as answered.
    """
    if body.doc_type not in ("bill", "invoice"):
        raise HTTPException(400, "doc_type must be 'bill' or 'invoice'")

    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found on batch")
    if item.get("item_type") != cr.ITEM_UNCATEGORIZED:
        raise HTTPException(400,
            "Link-doc only supports Uncategorized transaction items")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    cid    = batch["company_id"]
    txn_id = await _resolve_editable_txn_id(item, cid, override=body.txn_id)
    if not txn_id:
        raise HTTPException(400, "This item has no editable transaction")
    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Underlying transaction is gone")

    is_bill = body.doc_type == "bill"
    coll    = db.bills if is_bill else db.invoices
    doc     = await coll.find_one({"id": body.doc_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, f"{body.doc_type.title()} not found")

    total    = float(doc.get("total") or 0)
    balance  = float(doc.get("balance_due", total) or 0)
    if balance <= 0.005:
        raise HTTPException(400,
            f"That {body.doc_type} has no outstanding balance to apply.")

    txn_amount = round(abs(float(txn.get("amount") or 0)), 2)
    applied    = round(min(txn_amount, balance), 2)
    new_bal    = round(max(0.0, balance - applied), 2)
    new_status = "paid" if new_bal < 0.005 else "partial"

    # AR/AP account resolution — reuse the standard 1200/2000 pattern
    # if present, else fall back to any account of the matching type.
    target_type = "liability" if is_bill else "asset"
    target_code = "2000" if is_bill else "1200"
    ap_ar = await db.accounts.find_one(
        {"company_id": cid, "code": target_code, "type": target_type},
        {"id": 1, "name": 1},
    )
    if not ap_ar:
        ap_ar = await db.accounts.find_one(
            {"company_id": cid, "type": target_type,
             "name": {"$regex": ("Payable" if is_bill else "Receivable"),
                       "$options": "i"}},
            {"id": 1, "name": 1},
        )
    if not ap_ar:
        raise HTTPException(500,
            f"Company is missing an "
            f"{'Accounts Payable' if is_bill else 'Accounts Receivable'} "
            f"account — please have your bookkeeper set one up.")

    contact_id   = doc.get("contact_id")
    contact_name = (doc.get("contact_name")
                    or doc.get("vendor_name")
                    or doc.get("customer_name") or "")

    # --- Update the doc's balance ---
    push_key = "applied_check_txn_ids" if is_bill else "applied_payment_txn_ids"
    await coll.update_one(
        {"id": body.doc_id, "company_id": cid},
        {"$set": {"balance_due": new_bal,
                  "status":      new_status,
                  "updated_at":  _now_iso()},
         "$push": {push_key: txn_id}},
    )

    # --- Stamp the transaction ---
    doc_number = (doc.get("bill_number") or doc.get("invoice_number")
                  or doc.get("number") or "")
    note_prefix = "Bill" if is_bill else "Invoice"
    memo = (f"Linked to {note_prefix.lower()}"
            f"{(' #' + doc_number) if doc_number else ''} "
            f"— {contact_name or 'party'}")
    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid},
        {"$set": {
            "contact_id":          contact_id,
            "contact_name":        contact_name,
            "category_account_id": ap_ar["id"],
            "category_account_name": ap_ar.get("name") or "",
            ("linked_bill_id" if is_bill else "linked_invoice_id"): body.doc_id,
            "needs_review":        False,
            "human_reviewed":      True,
            "ai_source":           "client_link_doc",
            "ai_comment":          memo,
            "updated_at":          _now_iso(),
        }},
    )

    # --- Mark the check-in item answered ---
    label = (f"Linked to {note_prefix.lower()}"
             f"{(' #' + doc_number) if doc_number else ''} "
             f"({contact_name or 'party'})")
    # For grouped Uncategorized cards, linking ONE row doesn't finish
    # the item — the other txns in the bundle still need answers. In
    # that case just log the per-row action and leave the item open.
    is_grouped = bool((item.get("context") or {}).get("grouped"))
    if is_grouped:
        await db.client_review_batches.update_one(
            {"id": batch["id"], "items.item_id": item_id},
            {"$set": {"updated_at": _now_iso()},
             "$push": {"items.$.per_row_actions": {
                 "txn_id":     txn_id,
                 "action":     f"link_{body.doc_type}",
                 "doc_id":     body.doc_id,
                 "doc_number": doc_number,
                 "applied":    applied,
                 "at":         _now_iso(),
             }}},
        )
    else:
        await db.client_review_batches.update_one(
            {"id": batch["id"], "items.item_id": item_id},
            {"$set": {
                "items.$.answered_at":   _now_iso(),
                "items.$.answer":        label,
                "items.$.action_taken":  f"link_{body.doc_type}",
                "items.$.action_detail": {
                    "doc_type":    body.doc_type,
                    "doc_id":      body.doc_id,
                    "doc_number":  doc_number,
                    "contact_id":  contact_id,
                    "contact_name": contact_name,
                    "applied":     applied,
                    "new_balance": new_bal,
                },
                "updated_at":            _now_iso(),
            },
             "$inc": {"answer_count": 1}},
        )

    return {
        "ok":            True,
        "doc_type":      body.doc_type,
        "doc_id":        body.doc_id,
        "doc_number":    doc_number,
        "contact_name":  contact_name,
        "applied":       applied,
        "new_balance":   new_bal,
        "message":       label,
    }


class CategorizeUncatBody(BaseModel):
    category_account_id: str
    contact_id: str | None = None


@router.post("/{token}/items/{item_id}/categorize")
async def post_categorize_uncat(token: str, item_id: str,
                                  body: CategorizeUncatBody):
    """Book an Uncategorized transaction against a picked category
    account (and optionally a contact) in one tap — used by the
    "Complete" shortcut on the Quick Check-in card for item_type 1."""
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found on batch")
    if item.get("item_type") not in (cr.ITEM_UNCATEGORIZED, cr.ITEM_OWNER_DRAW):
        raise HTTPException(400,
            "Categorize only supports Uncategorized transaction and Owner's Draw items")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")
    cid    = batch["company_id"]
    txn_id = await _resolve_editable_txn_id(item, cid)
    if not txn_id:
        raise HTTPException(404, "Underlying transaction is gone")
    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Underlying transaction is gone")
    acct = await db.accounts.find_one(
        {"id": body.category_account_id, "company_id": cid},
        {"id": 1, "name": 1, "code": 1},
    )
    if not acct:
        raise HTTPException(404, "Category account not found")
    contact_name = None
    if body.contact_id:
        c = await db.contacts.find_one(
            {"id": body.contact_id, "company_id": cid}, {"id": 1, "name": 1},
        )
        if c: contact_name = c.get("name")
    updates = {
        "category_account_id":   acct["id"],
        "category_account_name": acct.get("name") or "",
        "needs_review":          False,
        "human_reviewed":        True,
        "ai_source":             "client_complete",
        "ai_comment":            f"Client picked {acct.get('name')} via Quick Check-in Complete",
        "updated_at":            _now_iso(),
    }
    if body.contact_id:
        updates["contact_id"]   = body.contact_id
        updates["contact_name"] = contact_name or ""
    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid}, {"$set": updates},
    )
    label = f"Booked to {acct.get('name')}"
    if contact_name: label = f"{label} · {contact_name}"
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.answered_at":   _now_iso(),
            "items.$.answer":        label,
            "items.$.action_taken":  "categorize",
            "items.$.action_detail": {
                "category_account_id": acct["id"],
                "category_account_name": acct.get("name") or "",
                "contact_id":            body.contact_id,
                "contact_name":          contact_name,
            },
            "updated_at":            _now_iso(),
        },
         "$inc": {"answer_count": 1}},
    )
    return {"ok": True, "message": label,
            "account_name": acct.get("name"),
            "contact_name": contact_name}


class EditTxnBody(BaseModel):
    date:                Optional[str]   = None
    description:         Optional[str]   = None
    amount:              Optional[float] = None
    bank_account_id:     Optional[str]   = None
    contact_id:          Optional[str]   = None
    contact_name:        Optional[str]   = None  # allow free-text new contact
    category_account_id: Optional[str]   = None
    splits:              Optional[list]  = None  # [{amount, category_account_id, description}]
    link_kind:           Optional[str]   = None  # "invoice" | "bill" | ""
    link_doc_id:         Optional[str]   = None  # "" clears the link
    txn_id:              Optional[str]   = None  # per-row override for grouped items


async def _resolve_editable_txn_id(item: dict, cid: str,
                                    override: Optional[str] = None) -> Optional[str]:
    """Return the underlying db.transactions.id an item points at.

    If `override` is supplied (from a per-row action inside a grouped
    Uncategorized card), it wins — but ONLY when the override is one
    of the txn_ids the batch item is authorised to touch, so a client
    can't use a valid review token to edit random transactions.
    Otherwise: `transactions` items use `source_id`; `agent_findings`
    items use `finding.meta.txn_id` (or the older
    `meta.transaction_id`); last resort is `context.meta.txn_id`.
    """
    if override:
        allowed = set((item.get("context") or {}).get("txn_ids") or [])
        # Legacy items (non-grouped, source_collection="transactions")
        # also allow their own source_id as an override so the UI can
        # always send it.
        if item.get("source_collection") == "transactions" and item.get("source_id"):
            allowed.add(item.get("source_id"))
        if override in allowed:
            return override
        raise HTTPException(403, "txn_id not part of this batch item")
    if item.get("source_collection") == "transactions":
        return item.get("source_id")
    if item.get("source_collection") == "agent_findings":
        f = await db.agent_findings.find_one({"id": item.get("source_id")})
        if f:
            fm = f.get("meta") or {}
            tid = fm.get("txn_id") or fm.get("transaction_id")
            if tid:
                return tid
        ctx_meta = ((item.get("context") or {}).get("meta") or {})
        return ctx_meta.get("txn_id") or ctx_meta.get("transaction_id")
    ctx_meta = ((item.get("context") or {}).get("meta") or {})
    return ctx_meta.get("txn_id") or ctx_meta.get("transaction_id")


@router.get("/{token}/items/{item_id}/txn")
async def get_underlying_txn(token: str, item_id: str, txn_id: Optional[str] = None):
    """Return the underlying transaction that a Quick Check-in item points
    at, so the client-side Edit modal can pre-fill splits, invoice/bill
    links, and attachments — none of which live in the batch's cached
    `context` snapshot.

    Accepts `?txn_id=<id>` for per-row actions inside grouped
    Uncategorized cards. The override must be one of the item's
    authorised `context.txn_ids`."""
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found on batch")
    resolved = await _resolve_editable_txn_id(item, batch["company_id"], override=txn_id)
    if not resolved:
        raise HTTPException(400, "This item has no editable transaction")
    txn = await db.transactions.find_one(
        {"id": resolved, "company_id": batch["company_id"]}
    )
    if not txn:
        raise HTTPException(404, "Underlying transaction is gone")
    return {
        "id":                     txn.get("id"),
        "date":                   txn.get("date"),
        "amount":                 txn.get("amount"),
        "description":            txn.get("description"),
        "merchant":               txn.get("merchant"),
        "bank_account_id":        txn.get("bank_account_id"),
        "bank_account_name":      txn.get("bank_account_name"),
        "contact_id":             txn.get("contact_id"),
        "contact_name":           txn.get("contact_name"),
        "category_account_id":    txn.get("category_account_id"),
        "category_account_name":  txn.get("category_account_name"),
        "splits":                 txn.get("splits") or [],
        "linked_invoice_id":      txn.get("linked_invoice_id"),
        "linked_bill_id":         txn.get("linked_bill_id"),
        "attachments":            [
            {"id": a.get("id"), "filename": a.get("filename"),
             "size": a.get("size"), "mime": a.get("mime"),
             "kind": a.get("kind"), "source": a.get("source")}
            for a in (txn.get("attachments") or [])
        ],
    }


@router.post("/{token}/items/{item_id}/edit-txn")
async def post_edit_txn(token: str, item_id: str, body: EditTxnBody):
    """Edit the underlying transaction attached to a Quick Check-in item
    (date, description, amount, bank account, contact, category) from the
    client-review page. Does NOT auto-mark the item answered — the client
    can keep chatting or hit Complete afterwards."""
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not found on batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")
    cid    = batch["company_id"]
    txn_id = await _resolve_editable_txn_id(item, cid, override=body.txn_id)
    if not txn_id:
        raise HTTPException(400, "This item has no editable transaction")
    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Underlying transaction is gone")

    updates: Dict[str, Any] = {}
    if body.date is not None:
        updates["date"] = body.date
    if body.description is not None:
        updates["description"] = body.description
    if body.amount is not None:
        updates["amount"] = float(body.amount)
    if body.bank_account_id is not None:
        bacct = await db.accounts.find_one(
            {"id": body.bank_account_id, "company_id": cid},
            {"id": 1, "name": 1},
        )
        if not bacct:
            raise HTTPException(404, "Bank account not found")
        updates["bank_account_id"]   = bacct["id"]
        updates["bank_account_name"] = bacct.get("name") or ""
    if body.contact_id is not None:
        if body.contact_id == "":
            updates["contact_id"]   = None
            updates["contact_name"] = body.contact_name or ""
        else:
            c = await db.contacts.find_one(
                {"id": body.contact_id, "company_id": cid},
                {"id": 1, "name": 1},
            )
            if not c:
                raise HTTPException(404, "Contact not found")
            updates["contact_id"]   = c["id"]
            updates["contact_name"] = c.get("name") or ""
    elif body.contact_name is not None:
        # free-text contact (client typed a new name in the typeahead
        # without picking from the list) — keep the name only, no id link.
        updates["contact_id"]   = None
        updates["contact_name"] = body.contact_name

    if body.splits is not None:
        # A splits array is passed → we're switching this txn into
        # split-category mode (or clearing splits when empty).
        if body.splits:
            rows = []
            total = 0.0
            for r in body.splits:
                amt = float(r.get("amount") or 0)
                cat = r.get("category_account_id") or ""
                if not cat:
                    raise HTTPException(400, "Every split line needs a category")
                acct = await db.accounts.find_one(
                    {"id": cat, "company_id": cid}, {"id": 1, "name": 1},
                )
                if not acct:
                    raise HTTPException(404, f"Split category {cat} not found")
                rows.append({
                    "amount":              amt,
                    "category_account_id": acct["id"],
                    "category_account_name": acct.get("name") or "",
                    "description":         r.get("description") or "",
                })
                total += amt
            target = float(updates.get("amount", txn.get("amount") or 0))
            if abs(total - target) > 0.01:
                raise HTTPException(400,
                    f"Splits total {total:.2f} must equal txn amount {target:.2f}")
            updates["splits"]              = rows
            updates["category_account_id"] = None
            updates["category_account_name"] = ""
        else:
            updates["splits"] = []

    if body.category_account_id is not None:
        if body.category_account_id == "":
            updates["category_account_id"]   = None
            updates["category_account_name"] = ""
        else:
            acct = await db.accounts.find_one(
                {"id": body.category_account_id, "company_id": cid},
                {"id": 1, "name": 1},
            )
            if not acct:
                raise HTTPException(404, "Category account not found")
            updates["category_account_id"]   = acct["id"]
            updates["category_account_name"] = acct.get("name") or ""
            # Picking a single category clears any existing splits.
            if "splits" not in updates:
                updates["splits"] = []

    if body.link_kind is not None:
        # "" clears both links; "invoice"/"bill" writes to the matching field
        # and clears the other one so the two are mutually exclusive.
        if body.link_kind == "":
            updates["linked_invoice_id"] = None
            updates["linked_bill_id"]    = None
        elif body.link_kind == "invoice":
            if body.link_doc_id == "":
                updates["linked_invoice_id"] = None
            elif body.link_doc_id:
                inv = await db.invoices.find_one(
                    {"id": body.link_doc_id, "company_id": cid}, {"id": 1},
                )
                if not inv:
                    raise HTTPException(404, "Invoice not found")
                updates["linked_invoice_id"] = inv["id"]
                updates["linked_bill_id"]    = None
        elif body.link_kind == "bill":
            if body.link_doc_id == "":
                updates["linked_bill_id"] = None
            elif body.link_doc_id:
                bill = await db.bills.find_one(
                    {"id": body.link_doc_id, "company_id": cid}, {"id": 1},
                )
                if not bill:
                    raise HTTPException(404, "Bill not found")
                updates["linked_bill_id"]    = bill["id"]
                updates["linked_invoice_id"] = None

    if not updates:
        return {"ok": True, "message": "Nothing changed", "context": item.get("context") or {}}

    updates["updated_at"] = _now_iso()
    updates["ai_source"]  = "client_edit"
    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid}, {"$set": updates},
    )

    fresh = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    new_context = {
        "date":        fresh.get("date"),
        "amount":      fresh.get("amount"),
        "description": fresh.get("description"),
        "merchant":    fresh.get("merchant"),
        "account":     fresh.get("bank_account_name"),
    }
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {"items.$.context": new_context, "updated_at": _now_iso()}},
    )
    return {"ok": True, "message": "Transaction updated", "context": new_context,
            "category_account_id":   fresh.get("category_account_id"),
            "category_account_name": fresh.get("category_account_name"),
            "contact_id":            fresh.get("contact_id"),
            "contact_name":          fresh.get("contact_name"),
            "bank_account_id":       fresh.get("bank_account_id"),
            "bank_account_name":     fresh.get("bank_account_name"),
            "splits":                fresh.get("splits") or [],
            "linked_invoice_id":     fresh.get("linked_invoice_id"),
            "linked_bill_id":        fresh.get("linked_bill_id")}


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

    Applies to Q3 (missing_receipt), Q8 (split-transaction receipt),
    Q10 (Meals §274), and Q14 (Travel §274). For the IRS types the
    substantiation payload (attendees / business purpose / destination /
    trip dates) gets baked into the receipt's `notes` field so the
    Receipts page shows the full compliance context, and a structured
    `irs_substantiation` mirror lives on the receipt for future filters.
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

    # Notes: label + optional IRS-substantiation blurb so a CPA
    # scanning /receipts sees business purpose + attendees inline.
    label = ITEM_TYPE_LABEL.get(item.get("item_type"), "question")
    notes_bits = [f"Uploaded via client review — {label}"]
    irs_sub_doc = None
    if item.get("item_type") in (cr.ITEM_IRS_MEALS, cr.ITEM_IRS_TRAVEL):
        if meta.get("business_purpose"):
            notes_bits.append(f"Business purpose: {meta['business_purpose']}")
        if meta.get("attendees"):
            notes_bits.append(f"Attendees: {meta['attendees']}")
        if meta.get("destination"):
            notes_bits.append(f"Destination: {meta['destination']}")
        if meta.get("trip_start") or meta.get("trip_end"):
            notes_bits.append(
                f"Trip: {meta.get('trip_start') or '?'} → {meta.get('trip_end') or '?'}"
            )
        irs_sub_doc = {k: meta.get(k) for k in
                       ("business_purpose", "attendees",
                        "destination", "trip_start", "trip_end")
                       if meta.get(k)}
        irs_sub_doc["kind"] = ("meals" if item.get("item_type") == cr.ITEM_IRS_MEALS
                                else "travel")

    doc = {
        "company_id":          batch["company_id"],
        "date":                date,
        "amount":              amt,
        "merchant":            merchant,
        "notes":               " · ".join(notes_bits),
        "attachment_data_url": attachment.get("data_url"),
        "attachment_filename": attachment.get("filename"),
        "source":              "client_review",
        "source_batch_id":     batch["id"],
        "source_item_id":      item["item_id"],
        "updated_at":          _now_iso(),
    }
    if irs_sub_doc:
        doc["irs_substantiation"] = irs_sub_doc
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
    10: "meals compliance (§274)",
    13: "check missing payee",
    14: "travel compliance (§274)",
}


async def _semantic_lender_to_liability_account(
    company_id: str, lender_name: str,
) -> Optional[dict]:
    """Ask Claude Haiku whether `lender_name` (extracted from a
    statement — e.g. "Wells Fargo Home Mortgage") refers to the same
    real-world institution as any of the company's existing liability
    sub-accounts. Returns the account dict `{id, name, code}` when the
    LLM is confident (>=0.75), else None.

    Same pattern as `routes.accounts._semantic_contact_match` — catches
    institution rebrands ("Chase Auto" ↔ "JPMorgan Chase Auto Loan"),
    DBA variants ("Wells Fargo Home Mortgage" ↔ "Wells Fargo Mortgage
    — 123 Main"), and casual spellings ("BofA" ↔ "Bank of America
    Auto Loan"). We only consider SUB-accounts (has parent_account_id)
    — the canonical "Loans Payable" / "Credit Cards Payable" parents
    are catch-alls, not specific loan records worth pre-selecting.
    """
    lender_name = (lender_name or "").strip()
    if not lender_name:
        return None

    # Candidate pool: liability sub-accounts on this company's CoA.
    # Skip retired accounts and the canonical parent buckets.
    candidates: list[dict] = []
    async for a in db.accounts.find(
        {"company_id": company_id, "type": "liability"},
        {"id": 1, "name": 1, "code": 1, "parent_account_id": 1,
         "subtype": 1, "detail_type": 1, "retired_at": 1},
    ):
        if a.get("retired_at"):
            continue
        if not a.get("parent_account_id"):
            # Top-level (parent) — skip. We want the specific loan
            # record, not the catch-all "Loans Payable" bucket.
            continue
        candidates.append({
            "id": a["id"],
            "name": a.get("name") or "",
            "code": a.get("code") or "",
            "subtype": a.get("subtype") or "",
            "detail_type": a.get("detail_type") or "",
        })

    if not candidates:
        return None

    # Fast path: exact case-insensitive name match — no need to burn a
    # Haiku call when the lender name IS the account name.
    lender_norm = re.sub(r"\s+", " ", lender_name).lower()
    for c in candidates:
        if re.sub(r"\s+", " ", c["name"]).lower() == lender_norm:
            return c

    # Bounded prompt — keep costs sane on large CoAs.
    cands = candidates[:40]
    lines = "\n".join(
        f"- id={c['id']} · name={c['name']}"
        + (f" · code={c['code']}" if c.get("code") else "")
        + (f" · subtype={c['subtype']}" if c.get("subtype") else "")
        for c in cands
    )
    system = (
        "You are helping a bookkeeping app auto-route a mortgage / "
        "credit-card / auto-loan payment to the correct liability "
        "sub-account on the company's chart of accounts. "
        "Judge SEMANTICALLY, not by string similarity alone. Treat "
        "institution rebrands (\"Chase Auto\" ↔ \"JPMorgan Chase Auto "
        "Loan\"), DBA variants (\"Wells Fargo Home Mortgage\" ↔ "
        "\"Wells Fargo Mortgage — 123 Main\"), abbreviations (\"BofA\" "
        "↔ \"Bank of America\"), and legal-form suffixes (LLC, N.A., "
        "Inc, Corp) as SAME. Distinct institutions (\"Chase\" vs "
        "\"Chase Freedom Credit Card\" — probably a specific card "
        "sub-account) can still match if it's clearly the same lender. "
        "When multiple candidates plausibly match, prefer the one "
        "whose name most specifically matches the lender's product "
        "line (mortgage → mortgage sub-acct, auto → auto sub-acct). "
        "When in doubt, return null — do NOT force a match. "
        "Reply with STRICT JSON only, no prose, no code fences."
    )
    user = (
        f"LENDER (from statement): \"{lender_name}\"\n\n"
        f"EXISTING LIABILITY SUB-ACCOUNTS:\n{lines}\n\n"
        "Respond as:\n"
        "{ \"match_id\": \"<candidate id or null>\", "
        "\"confidence\": <0.0-1.0>, "
        "\"reason\": \"<one short line>\" }"
    )
    try:
        from ai_service import _new_chat, _extract_json, MODEL_HAIKU
        from llm_client import UserMessage
        chat = _new_chat(system, f"lender-match-{company_id}",
                          model_name=MODEL_HAIKU,
                          feature="lender-semantic-match",
                          company_id=company_id)
        text = await chat.send_message(UserMessage(text=user))
    except Exception:  # noqa: BLE001
        return None
    parsed = _extract_json(text or "") or {}
    mid  = parsed.get("match_id")
    conf = parsed.get("confidence")
    try:
        conf = float(conf) if conf is not None else 0.0
    except (TypeError, ValueError):
        conf = 0.0
    if not mid or mid in ("null", "None"):
        return None
    if conf < 0.75:
        return None
    valid = {c["id"]: c for c in cands}
    return valid.get(mid)


@router.post("/{token}/items/{item_id}/upload")
async def post_upload(
    token: str, item_id: str,
    file: UploadFile = File(...),
    kind: str = Form("attachment"),
    txn_id: Optional[str] = Form(None),
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
        # Per-row override for grouped Uncategorized cards: attach the
        # receipt to the specific txn the client tapped, not the
        # grouped item's synthetic source_id.
        target_id = item["source_id"]
        if txn_id and (item.get("context") or {}).get("grouped"):
            allowed = set((item.get("context") or {}).get("txn_ids") or [])
            if txn_id in allowed:
                target_id = txn_id
                coll = "transactions"
        await db[coll].update_one(
            {"id": target_id, "company_id": batch["company_id"]},
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
            # Real CoA lives on `db.accounts` — the historical
            # `db.chart_of_accounts` collection was never populated
            # so the AI was guessing off the prompt examples.
            coa = await db.accounts.find(
                {"company_id": batch["company_id"]},
                {"id": 1, "code": 1, "name": 1, "type": 1},
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
    # (item_type=2) / missing receipt (item_type=3) — read the receipt
    # with GPT-4o vision and propose a per-line-item Chart-of-Accounts
    # split. Client sees each row ("4x4x8 PT POST → Materials · Lumber
    # $119.88") and can change the account or accept the whole thing
    # with "Use this split".
    if item.get("item_type") in (1, 2, 3) and mime.startswith(("image/", "application/pdf")):
        try:
            from client_review_engine import analyze_receipt_for_categorization
            # Real CoA lives on `db.accounts`; see sibling split path above.
            coa = await db.accounts.find(
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
                # Missing-receipt findings store amount/desc under `meta.*`;
                # per-txn Uncategorized items (Feb 2026 refactor) store them
                # at the top level of `context`. Fall through both.
                txn_amount=(meta.get("txn_amount")
                            or meta.get("amount")
                            or ctx.get("amount")),
                txn_desc=(meta.get("txn_desc")
                          or ctx.get("description")),
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
            # Post-process: resolve every AI line to a real account
            # on this company's CoA (auto-creates canonical accounts
            # like "Taxes & Licenses" when missing). No hallucinated
            # account names ever reach the ledger.
            try:
                from curated_receipt_accounts import resolve_line_account
                for line in (cat_analysis.get("line_items") or []):
                    acct = await resolve_line_account(batch["company_id"], line)
                    if acct:
                        line["account_id"]   = acct.get("id")
                        line["account_code"] = acct.get("code")
                        line["account_name"] = acct.get("name")
            except Exception:  # noqa: BLE001
                pass
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
            # Real CoA lives on `db.accounts`; see receipt-split path above.
            coa = await db.accounts.find(
                {"company_id": batch["company_id"]},
                {"id": 1, "code": 1, "name": 1, "type": 1},
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
            # Auto-match the extracted lender name to an existing
            # liability sub-account on the company's CoA — if we're
            # confident, stamp `principal_account_id` on the Principal
            # bucket so the client doesn't have to click "Change" in
            # the LiabilityBreakdown UI. Semantic match (Haiku) handles
            # "Wells Fargo Home Mortgage" ↔ "Wells Fargo Mortgage —
            # 123 Main", "Chase Auto" ↔ "JPMorgan Chase Auto Loan",
            # etc. Silently no-ops when no confident match exists —
            # the user picks manually via the "Change" affordance.
            lender = (liab_analysis.get("lender_name") or "").strip()
            if lender:
                try:
                    matched = await _semantic_lender_to_liability_account(
                        batch["company_id"], lender,
                    )
                except Exception:  # noqa: BLE001
                    matched = None
                if matched and matched.get("id"):
                    liab_analysis["matched_principal_account"] = {
                        "id":   matched["id"],
                        "name": matched.get("name") or "",
                        "code": matched.get("code") or "",
                    }
                    # Also stamp onto the Principal bucket so the
                    # frontend LiabilityBreakdown picks it up on first
                    # render (matches the shape the "Change" affordance
                    # already produces via editBucket).
                    for b in (liab_analysis.get("buckets") or []):
                        label = (b.get("label") or "").lower()
                        if "principal" in label:
                            b["principal_account_id"] = matched["id"]
                            b["account_name"] = matched.get("name") or b.get("account_name") or ""
                            break
            resp["liability_analysis"] = liab_analysis
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {"items.$.liability_analysis": liab_analysis,
                          "updated_at":                _now_iso()}},
            )

    # Receipts uploaded through the client-review flow should also
    # land on the client's Receipts page. Applies to Q3 (missing
    # receipt), Q8 (split-transaction receipt), Q10 (Meals §274),
    # and Q14 (Travel §274).
    if item.get("item_type") in (3, 8, 10, 14):
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
    # Prefer an OPEN batch over a scheduled one — an open batch is the
    # live magic-link session the pro would walk. Scheduled batches are
    # just future-dated placeholders on the Cockpit calendar. Without
    # this preference, seeding scheduled appointments (e.g.
    # `seed_week_schedule.py`) causes the Agent Inquiries pill to
    # report the scheduled batch's smaller item count instead of the
    # currently-live 17-question Quick Check-in.
    batch = await db.client_review_batches.find_one(
        {"company_id": company_id, "status": "open"},
        sort=[("created_at", -1)],
    )
    if not batch:
        batch = await db.client_review_batches.find_one(
            {"company_id": company_id, "status": "scheduled"},
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


# --------------------------------------------------------------------------
# Missing Receipt · Dismiss ("no receipt needed — drop from Quick Check-in")
# --------------------------------------------------------------------------
@router.post("/{token}/items/{item_id}/dismiss-receipt")
async def dismiss_missing_receipt(token: str, item_id: str):
    """Client-initiated dismissal of a Missing-Receipt item.

    Marks the underlying transaction as intentionally receipt-free
    (``receipt_dismissed: True``) so future receipt-required agent
    scans skip it, closes the source agent_finding, and stamps the
    batch item as answered so the queue advances past it.

    Type-3 items only. No file upload, no GL mutation.
    """
    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("item_type") != 3:
        raise HTTPException(400, "Dismiss only applies to Missing Receipt items")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    now = _now_iso()
    company_id = batch["company_id"]
    meta = (item.get("context") or {}).get("meta") or {}
    txn_id = meta.get("txn_id")

    # Prefer the explicit meta.txn_id (set by the seed + real detectors);
    # fall back to fuzzy amount+date match to mirror
    # `_handle_missing_receipt`'s resolver.
    txn = None
    if txn_id:
        txn = await db.transactions.find_one(
            {"id": txn_id, "company_id": company_id}, {"id": 1},
        )
    if not txn:
        amt = meta.get("txn_amount") or meta.get("amount")
        date = meta.get("txn_date")
        q: dict = {"company_id": company_id}
        if amt is not None:
            try:
                a = round(abs(float(amt)), 2)
                q["$expr"] = {"$eq": [{"$round": [{"$abs": "$amount"}, 2]}, a]}
            except (TypeError, ValueError):
                pass
        if date:
            q["date"] = date
        txn = await db.transactions.find_one(q, {"id": 1})

    if txn:
        await db.transactions.update_one(
            {"id": txn["id"], "company_id": company_id},
            {"$set": {
                "receipt_dismissed":    True,
                "receipt_dismissed_at": now,
                "receipt_dismissed_by": "client",
                "updated_at":           now,
            }},
        )

    # Close the source agent_finding so the pro Cockpit reflects the
    # client's dismissal too.
    src_coll = item.get("source_collection")
    if src_coll == "agent_findings" and item.get("source_id"):
        await db.agent_findings.update_one(
            {"id": item["source_id"], "company_id": company_id},
            {"$set": {"status":       "resolved",
                      "resolved_at":  now,
                      "resolved_by":  "client:receipt_dismissed",
                      "resolve_note": "Client marked no receipt needed",
                      "client_answer":      "Dismiss receipt",
                      "client_answered_at": now,
                      "meta.matched_txn_id": (txn or {}).get("id"),
                      "updated_at":   now}},
        )

    # Stamp the batch item so the queue moves on.
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.answered_at":         now,
            "items.$.answer":              "Dismiss receipt",
            "items.$.action_taken":        "receipt_dismissed",
            "items.$.action_detail":       "Client dismissed — no receipt required.",
            "items.$.answered_by_client":  True,
            "updated_at":                  now,
        },
         "$inc": {"answer_count": 1}},
    )
    return {"ok": True, "txn_id": (txn or {}).get("id"),
            "action_taken": "receipt_dismissed"}


# --------------------------------------------------------------------------
# Deposit · Link-to-invoice (multi-invoice apply) — client-facing mirror
# of `/companies/{cid}/transactions/{tid}/receive-payment`
# --------------------------------------------------------------------------
@router.get("/{token}/invoices/open")
async def list_open_invoices_for_review(token: str):
    """Token-scoped mirror of ``/companies/{cid}/invoices/open`` used by
    the client-facing Deposit → Customer payment → Link to invoice
    modal (Feb 2026). Returns every open invoice on the batch's
    company sorted oldest-first (FIFO)."""
    batch = await _resolve_batch(token)
    cid = batch["company_id"]
    docs = await db.invoices.find({
        "company_id": cid,
        "balance_due": {"$gt": 0.005},
        "status": {"$nin": ["paid", "void", "cancelled"]},
    }).sort("issue_date", 1).to_list(2000)
    return {"invoices": [
        {"id": d["id"], "number": d.get("number") or "",
         "issue_date": d.get("issue_date") or d.get("date") or "",
         "due_date": d.get("due_date") or "",
         "total": float(d.get("total") or 0),
         "balance_due": float(d.get("balance_due") or 0),
         "status": d.get("status") or "",
         "contact_id": d.get("contact_id"),
         "contact_name": d.get("contact_name") or ""}
        for d in docs
    ]}


@router.get("/{token}/bills/open")
async def list_open_bills_for_review(token: str, include_paid: bool = False):
    """Token-scoped mirror of ``/companies/{cid}/bills/open``.

    ``include_paid=1`` also returns bills fully paid within the last
    90 days — used by the Refund → Against a bill flow so a client
    can credit a refund against a bill they already paid off (the
    "vendor overpaid me back" scenario).
    """
    batch = await _resolve_batch(token)
    cid = batch["company_id"]
    open_docs = await db.bills.find({
        "company_id": cid,
        "balance_due": {"$gt": 0.005},
        "status": {"$nin": ["paid", "void", "cancelled"]},
    }).sort("date", 1).to_list(2000)
    paid_docs: list[dict] = []
    if include_paid:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).date().isoformat()
        paid_docs = await db.bills.find({
            "company_id": cid,
            "balance_due": {"$lte": 0.005},
            "status": {"$nin": ["void", "cancelled"]},
            "$or": [{"date": {"$gte": cutoff}},
                    {"paid_date": {"$gte": cutoff}},
                    {"updated_at": {"$gte": cutoff}}],
        }).sort("date", -1).limit(500).to_list(500)

    def _row(d: dict, is_paid: bool) -> dict:
        return {
            "id": d["id"], "number": d.get("number") or "",
            "date": d.get("date") or "",
            "due_date": d.get("due_date") or "",
            "total": float(d.get("total") or 0),
            "balance_due": float(d.get("balance_due") or 0),
            "status": d.get("status") or "",
            "is_paid": bool(is_paid),
            "contact_id": d.get("contact_id") or d.get("vendor_id"),
            "contact_name": d.get("contact_name") or d.get("vendor_name") or "",
            "category_account_id": d.get("category_account_id"),
        }
    return {"bills": [_row(d, False) for d in open_docs] +
                     [_row(d, True)  for d in paid_docs]}


@router.post("/{token}/transactions/{tid}/receive-payment")
async def client_receive_payment(
    token: str, tid: str, payload: dict = Body(...),
    item_id: str | None = None,
):
    """Token-scoped mirror of the multi-doc Receive/Pay endpoint used
    by the client-side Deposit → Customer payment → Link to invoice
    flow. Delegates to ``routes.transactions.receive_payment_multi``
    via a synthetic superadmin user (auth is already covered by the
    token → batch resolver).

    If ``item_id`` is passed, we also close that batch item + agent
    finding so the Quick Check-in queue advances past the deposit.
    """
    from routes import transactions as txn_routes
    batch = await _resolve_batch(token)
    cid = batch["company_id"]

    # Validate the txn belongs to the batch's company before delegating.
    txn = await db.transactions.find_one(
        {"id": tid, "company_id": cid}, {"id": 1, "amount": 1},
    )
    if not txn:
        raise HTTPException(404, "Transaction not in this company")

    # Synthetic superadmin user so `require_company` passes without an
    # actual pro JWT — the token itself is the authenticator here.
    synthetic = {"id": f"client-review:{token[:8]}", "role": "superadmin"}
    result = await txn_routes.receive_payment_multi(
        cid, tid, payload, user=synthetic,
    )

    # Optionally close the associated batch item so `unfinished-count`
    # decrements and the queue advances.
    if item_id:
        now = _now_iso()
        item = next((i for i in (batch.get("items") or [])
                     if i.get("item_id") == item_id), None)
        if item and not item.get("answered_at") and not item.get("deferred"):
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {
                    "items.$.answered_at":        now,
                    "items.$.answer":             "Link to invoice",
                    "items.$.action_taken":       "invoice_payment_applied",
                    "items.$.action_detail":      f"Applied ${float(txn.get('amount') or 0):,.2f} across invoice(s).",
                    "items.$.answered_by_client": True,
                    "items.$.answered_payload":   {"flow": "customer_payment",
                                                    "sub_flow": "link_invoice",
                                                    "applications": payload.get("applications") or []},
                    "updated_at":                 now,
                }, "$inc": {"answer_count": 1}},
            )
            if item.get("source_collection") == "agent_findings" and item.get("source_id"):
                await db.agent_findings.update_one(
                    {"id": item["source_id"], "company_id": cid},
                    {"$set": {"status":       "resolved",
                              "resolved_at":  now,
                              "resolved_by":  "client:deposit_linked_to_invoice",
                              "client_answer":       "Link to invoice",
                              "client_answered_at":  now,
                              "meta.matched_txn_id": tid}},
                )
    return result








# --------------------------------------------------------------------------
# Pro-scoped: full batch document by id — used by the Review v2 Lab
# (`/accounting/lab/review-v2`) to reshape items into the 3-stage flow
# without needing the client's magic-link JWT. Read-only.
@router.get("/by-id/{batch_id}")
async def get_batch_by_id(
    batch_id: str,
    user: dict = Depends(get_current_user),
):
    batch = await db.client_review_batches.find_one({"id": batch_id})
    if not batch:
        raise HTTPException(404, "Batch not found")
    await _require_company(user, batch["company_id"])
    # Strip Mongo _id + client_token before returning.
    batch.pop("_id", None)
    batch.pop("client_token", None)
    return batch


# --------------------------------------------------------------------------
# Info-gathering forms — client-facing (magic-link) mirror of the
# Cockpit's /checkin/items/{id}/submit + /checkin/voice-extract routes.
# Same UX as the IRS Compliance card in Cockpit but token-authenticated
# so a client can fill Meals/Travel substantiation fields, W-9 details,
# check-payee, liability split, etc. from their magic link.
# --------------------------------------------------------------------------

@router.post("/{token}/items/{item_id}/checkin-submit")
async def post_checkin_submit(
    token: str,
    item_id: str,
    answer: str = Form(""),
    payload_json: str = Form("{}"),
    file: UploadFile | None = File(None),
):
    """Structured-form submission for one Quick Check-in item, token
    authenticated. Mirrors ``responsibilities.submit_checkin_item`` but
    without a companyId path param — the token pins the batch/company.

    Multipart body identical to the Cockpit route:
      • ``answer``       — free-text memo / rationale (optional)
      • ``payload_json`` — JSON dict of structured fields (attendees,
                           business_purpose, destination, trip_start,
                           trip_end, payee_name, split, …)
      • ``file``         — optional receipt / statement (8 MB max)

    Effects mirror the pro flow: file attached to source + batch item,
    receipt-bearing types mirror into ``db.receipts``, typed handler
    runs (writing IRS substantiation onto the transaction), batch item
    stamped ``answered_at``.
    """
    import base64, json, uuid as _uuid

    batch = await _resolve_batch(token)
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in this batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    try:
        payload = json.loads(payload_json or "{}")
        if not isinstance(payload, dict):
            payload = {}
    except Exception:  # noqa: BLE001
        payload = {}
    # Stamp actor context — client-side submission (not a pro).
    payload["answered_by_client"] = True

    # ---- Optional file upload -----------------------------------------
    attachment: dict | None = None
    if file is not None:
        data = await file.read()
        if data:
            if len(data) > 8 * 1024 * 1024:
                raise HTTPException(413, "File too large (8 MB max)")
            b64 = base64.b64encode(data).decode("ascii")
            mime = file.content_type or "application/octet-stream"
            data_url = f"data:{mime};base64,{b64}"
            attachment = {
                "id":         str(_uuid.uuid4()),
                "filename":   file.filename or "upload",
                "size":       len(data),
                "mime":       mime,
                "data_url":   data_url,
                "kind":       "receipt",
                "uploaded_at": _now_iso(),
                "uploaded_by": "client",
            }
            coll = item.get("source_collection")
            if coll in ("agent_findings", "transactions", "contacts"):
                await db[coll].update_one(
                    {"id": item["source_id"],
                     "company_id": batch["company_id"]},
                    {"$push": {"attachments": attachment},
                     "$set":  {"updated_at": _now_iso()}},
                )
            attachments = (item.get("attachments") or []) + [attachment]
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {"items.$.attachments": attachments,
                          "updated_at":          _now_iso()}},
            )
            # Receipt-bearing types → mirror into db.receipts. Enrich
            # the item context with substantiation fields so the
            # receipt notes carry the who/why/where.
            if item.get("item_type") in (3, 8, 10, 14):
                enriched = dict(item)
                ctx = dict(item.get("context") or {})
                meta = dict(ctx.get("meta") or {})
                for k in ("business_purpose", "attendees", "destination",
                          "trip_start", "trip_end"):
                    if payload.get(k):
                        meta[k] = payload[k]
                ctx["meta"] = meta
                enriched["context"] = ctx
                await _mirror_upload_to_receipts_page(batch, enriched, attachment)

    # ---- Run the typed answer handler --------------------------------
    result = await handlers.apply_answer(item, batch,
                                          answer=answer, payload=payload)

    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.answered_at":         _now_iso(),
            "items.$.answer":              answer,
            "items.$.action_taken":        result.get("action_taken"),
            "items.$.action_detail":       result.get("detail"),
            "items.$.answered_by_client":  True,
            "items.$.answered_payload":    {k: v for k, v in payload.items()
                                            if k != "answered_by_client"},
            "updated_at":                  _now_iso(),
        },
         "$inc": {"answer_count": 1}},
    )
    return {"ok": True,
            "attachment_id": (attachment or {}).get("id"),
            **result}


@router.post("/{token}/checkin-voice-extract")
async def post_checkin_voice_extract(
    token: str,
    audio: UploadFile = File(...),
    item_type: int = Form(...),
    txn_context_json: str = Form("{}"),
):
    """Whisper transcription + structured field extraction for the
    client-facing voice-fill bar. Mirror of
    ``responsibilities.voice_extract_checkin`` — same Whisper + gpt-4o-mini
    pipeline, same schema, same per-item-type field whitelist.

    Auth: token binds this to a single batch/company but the endpoint
    itself is stateless — no batch mutation.
    """
    import io, json, os, uuid as _uuid

    # Anchor to the batch so we don't accept audio for an expired/
    # non-existent token.
    await _resolve_batch(token)

    if audio.content_type and not any(t in audio.content_type for t in (
        "audio", "webm", "mp3", "mp4", "mpeg", "mpga", "m4a", "wav",
    )):
        raise HTTPException(400, f"Unsupported audio type: {audio.content_type}")

    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty audio blob")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "Audio too large (25 MB max)")

    try:
        ctx = json.loads(txn_context_json or "{}")
        if not isinstance(ctx, dict): ctx = {}
    except Exception:  # noqa: BLE001
        ctx = {}
    merchant = str(ctx.get("merchant") or "").strip()
    amount   = ctx.get("amount")
    date     = str(ctx.get("date") or "").strip()

    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(500, "Server LLM key not configured")

    from emergentintegrations.llm.openai import OpenAISpeechToText
    ext_map = {"audio/webm": "webm", "audio/mp3": "mp3", "audio/mpeg": "mp3",
               "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-m4a": "m4a"}
    ext = ext_map.get(audio.content_type or "", "webm")
    filename = audio.filename or f"utterance.{ext}"
    buf = io.BytesIO(data)
    buf.name = filename

    stt = OpenAISpeechToText(api_key=api_key)
    hint = (f"Business meal at {merchant}." if item_type == 10 and merchant
            else (f"Business trip. " if item_type == 14 else ""))
    try:
        stt_resp = await stt.transcribe(
            file=buf, model="whisper-1", response_format="json",
            language="en", prompt=hint or None, temperature=0.0,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Transcription failed: {e}")

    transcript = (getattr(stt_resp, "text", None) or "").strip()
    if not transcript:
        return {"transcript": "", "extracted": {}}

    txn_ctx_lines = []
    if merchant: txn_ctx_lines.append(f"merchant: {merchant}")
    if amount is not None: txn_ctx_lines.append(f"amount: {amount}")
    if date:     txn_ctx_lines.append(f"date: {date}")
    txn_ctx = "\n".join(txn_ctx_lines) or "(no transaction context)"

    type_hints = {
        10: ("IRS §274 meals-and-entertainment substantiation. Focus on "
             "WHO attended (names + affiliations) and the BUSINESS PURPOSE "
             "of the meal."),
        14: ("IRS §274 travel substantiation. Focus on DESTINATION, "
             "BUSINESS PURPOSE, and TRIP DATES if mentioned."),
        3:  ("Missing-receipt follow-up. Capture the business purpose or "
             "memo. Do NOT invent attendees or destinations."),
        13: ("Check-with-missing-payee. Extract the PAYEE NAME. Do NOT "
             "invent other fields."),
    }
    task = type_hints.get(item_type, "Extract any relevant substantiation fields.")

    system_prompt = (
        "You extract structured bookkeeping-compliance fields from a "
        "one-sentence dictation. Return STRICT JSON only — no prose, "
        "no markdown. Every field is optional; set unknown fields to "
        "null. NEVER invent details that are not clearly stated in the "
        "dictation.\n\n"
        f"Task context: {task}\n\n"
        "Schema: {\"attendees\": string|null, \"business_purpose\": "
        "string|null, \"destination\": string|null, \"trip_start\": "
        "\"YYYY-MM-DD\"|null, \"trip_end\": \"YYYY-MM-DD\"|null, "
        "\"notes\": string|null, \"payee_name\": string|null}"
    )
    user_prompt = (
        f"Transcript: \"{transcript}\"\n\n"
        f"Transaction context:\n{txn_ctx}\n\n"
        "Return JSON only."
    )

    from emergentintegrations.llm.chat import LlmChat, UserMessage
    chat = (LlmChat(
        api_key=api_key,
        session_id=f"voice-extract-tok-{_uuid.uuid4().hex[:8]}",
        system_message=system_prompt,
    )
        .with_model("openai", "gpt-4o-mini"))
    try:
        reply = await chat.send_message(UserMessage(text=user_prompt))
    except Exception:  # noqa: BLE001
        return {"transcript": transcript,
                "extracted": {"notes": transcript}}

    raw = (reply or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:].lstrip()
    try:
        extracted = json.loads(raw)
        if not isinstance(extracted, dict):
            extracted = {"notes": transcript}
    except Exception:  # noqa: BLE001
        extracted = {"notes": transcript}

    extracted = {k: v for k, v in extracted.items()
                 if v not in (None, "", "null") and not
                 (isinstance(v, str) and not v.strip())}

    FIELDS_BY_TYPE = {
        10: {"attendees", "business_purpose", "notes"},
        14: {"attendees", "business_purpose", "destination",
             "trip_start", "trip_end", "notes"},
        3:  {"notes"},
        9:  {"notes"},
        13: {"payee_name", "notes"},
    }
    allowed = FIELDS_BY_TYPE.get(item_type, set())
    if allowed:
        extracted = {k: v for k, v in extracted.items() if k in allowed}

    return {"transcript": transcript, "extracted": extracted}
