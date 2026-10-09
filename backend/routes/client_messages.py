"""Client → accounting professional messages ("Ask my accountant").

Sources: header button, Transactions row ("Ask my accountant about this"),
Quick Check-in "Not sure — send to my bookkeeper". Surfaces in the Cockpit
In Progress → Client Messages tab, where the pro replies / resolves.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from db import db
from auth import get_current_user
from deps import require_company
from routes.cockpit import require_firm_or_pro

router = APIRouter(prefix="/api", tags=["client-messages"])
log = logging.getLogger(__name__)
KINDS = ("ask_accountant", "txn_question", "checkin_deferred")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def pro_for_company(cid: str) -> Optional[dict]:
    comp = await db.companies.find_one({"id": cid}, {"_id": 0, "primary_pro_id": 1, "pro_user_id": 1})
    pid = (comp or {}).get("primary_pro_id") or (comp or {}).get("pro_user_id")
    if not pid:
        m = await db.memberships.find_one({"company_id": cid, "role": "pro"}, {"_id": 0, "user_id": 1})
        pid = (m or {}).get("user_id")
    return await db.users.find_one({"id": pid}, {"_id": 0, "id": 1, "name": 1, "email": 1}) if pid else None


async def create_message(*, company_id: str, kind: str, body: str, from_user: dict | None = None,
                         from_name: str | None = None, from_email: str | None = None,
                         txn_id: str | None = None, item: dict | None = None, notify: bool = True,
                         subject: str | None = None) -> dict:
    comp = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1})
    txn = None
    if txn_id:
        t = await db.transactions.find_one({"id": txn_id, "company_id": company_id}, {"_id": 0, "id": 1, "date": 1, "merchant": 1, "description": 1, "amount": 1, "category_name": 1})
        if t:
            txn = {"id": t["id"], "date": t.get("date"), "merchant": t.get("merchant") or t.get("description"), "amount": t.get("amount"), "category": t.get("category_name")}
    doc = {
        "id": str(uuid.uuid4()), "company_id": company_id, "company_name": (comp or {}).get("name"),
        "kind": kind, "body": body.strip(), "subject": (subject or "").strip()[:120] or None,
        "from_user_id": (from_user or {}).get("id"), "from_name": from_name or (from_user or {}).get("name"),
        "from_email": from_email or (from_user or {}).get("email"),
        "txn": txn, "item": item, "status": "open", "replies": [], "created_at": _now(), "updated_at": _now(),
        "read_by": ({(from_user or {}).get("id"): _now()} if (from_user or {}).get("id") else {}),
    }
    await db.client_messages.insert_one(doc)
    doc.pop("_id", None)
    if notify:
        try:
            pro = await pro_for_company(company_id)
            if pro and pro.get("email"):
                from email_dispatcher import dispatch, public_base_url
                from email_templates import escape
                label = {"txn_question": "asked about a transaction", "checkin_deferred": "sent a check-in item to you", "ask_accountant": "sent you a message"}[kind]
                ctx = f"<p style='color:#64748b;font-size:13px'>{escape(txn['merchant'] or '')} · {txn.get('amount')} · {txn.get('date') or ''}</p>" if txn else ""
                if item:
                    ctx = f"<p style='color:#64748b;font-size:13px'>Check-in item: {escape(item.get('prompt') or '')}</p>"
                html = (f"<p><b>{escape(doc['from_name'] or 'Your client')}</b> ({escape(doc['company_name'] or '')}) {label}:</p>"
                        f"<blockquote style='border-left:3px solid #e2e8f0;margin:0;padding:8px 12px'>{escape(doc['body'])}</blockquote>{ctx}"
                        f"<p><a href='{public_base_url()}/cockpit?open=messages'>Reply in the Cockpit →</a></p>")
                await dispatch(kind="client_message", to=pro["email"], subject=f"{doc['from_name'] or 'Client'} · {doc['company_name'] or ''}: {doc['subject'] or doc['body'][:60]}",
                               html=html, initiating_user_id=pro["id"], related={"client_message_id": doc["id"]})
        except Exception:
            log.exception("client_message notify failed")
    return doc


class MessageIn(BaseModel):
    body: str = Field(..., min_length=2, max_length=4000)
    subject: Optional[str] = Field(None, max_length=120)
    kind: str = "ask_accountant"
    txn_id: Optional[str] = None


@router.post("/companies/{cid}/client-messages")
async def post_message(cid: str, inp: MessageIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    kind = "txn_question" if inp.txn_id else (inp.kind if inp.kind in KINDS else "ask_accountant")
    doc = await create_message(company_id=cid, kind=kind, body=inp.body, from_user=user, txn_id=inp.txn_id, subject=inp.subject)
    return {"ok": True, "message": doc}


@router.get("/companies/{cid}/client-messages")
async def list_company_messages(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rows = await db.client_messages.find({"company_id": cid}, {"_id": 0}).sort("created_at", -1).limit(100).to_list(100)
    pro = await pro_for_company(cid)
    return {"messages": rows, "pro": pro}


@router.get("/pro/client-messages")
async def list_pro_messages(status: str = "open", user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    q: dict = {"company_id": {"$in": accessible}}
    if status != "all":
        q["status"] = {"$in": ["open", "replied"]} if status == "open" else status
    rows = await db.client_messages.find(q, {"_id": 0}).sort("updated_at", -1).limit(200).to_list(200)
    return {"messages": rows}


class ReplyIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    resolve: bool = False


@router.post("/client-messages/{mid}/reply")
async def reply_message(mid: str, inp: ReplyIn, user: dict = Depends(get_current_user)):
    msg = await db.client_messages.find_one({"id": mid}, {"_id": 0})
    if not msg:
        raise HTTPException(404, "Message not found")
    await require_company(user, msg["company_id"])
    is_pro = user.get("role") in ("pro", "superadmin", "admin", "partner", "firm_staff")
    reply = {"id": str(uuid.uuid4()), "by": user["id"], "by_name": user.get("name") or user.get("email"), "by_pro": is_pro, "text": inp.text.strip(), "at": _now()}
    status = "resolved" if (inp.resolve and not is_pro) else ("replied" if is_pro else "open")
    await db.client_messages.update_one({"id": mid}, {"$push": {"replies": reply}, "$set": {"status": status, "updated_at": _now(), f"read_by.{user['id']}": _now()}})
    if is_pro and msg.get("from_email"):
        try:
            from email_dispatcher import dispatch, public_base_url
            from email_templates import escape
            html = (f"<p><b>{escape(reply['by_name'] or 'Your accountant')}</b> replied to your message:</p>"
                    f"<blockquote style='border-left:3px solid #e2e8f0;margin:0;padding:8px 12px'>{escape(reply['text'])}</blockquote>"
                    f"<p style='color:#64748b;font-size:13px'>You asked: {escape(msg['body'][:200])}</p>"
                    f"<p><a href='{public_base_url()}/dashboard?messages=1'>View in the app →</a></p>")
            await dispatch(kind="client_message_reply", to=msg["from_email"], subject=f"Reply from {reply['by_name']}: {msg['body'][:50]}",
                           html=html, initiating_user_id=user["id"], related={"client_message_id": mid})
        except Exception:
            log.exception("client_message reply notify failed")
    return {"ok": True, "reply": reply, "status": status}


@router.post("/client-messages/{mid}/read")
async def mark_read(mid: str, user: dict = Depends(get_current_user)):
    msg = await db.client_messages.find_one({"id": mid}, {"_id": 0, "company_id": 1})
    if not msg:
        raise HTTPException(404, "Message not found")
    await require_company(user, msg["company_id"])
    await db.client_messages.update_one({"id": mid}, {"$set": {f"read_by.{user['id']}": _now()}})
    return {"ok": True}


class StatusIn(BaseModel):
    status: str


@router.patch("/client-messages/{mid}")
async def set_status(mid: str, inp: StatusIn, user: dict = Depends(get_current_user)):
    if inp.status not in ("open", "replied", "resolved"):
        raise HTTPException(400, "Bad status")
    msg = await db.client_messages.find_one({"id": mid}, {"_id": 0, "company_id": 1})
    if not msg:
        raise HTTPException(404, "Message not found")
    await require_company(user, msg["company_id"])
    if inp.status == "resolved" and user.get("role") in ("pro", "superadmin", "admin", "partner", "firm_staff"):
        raise HTTPException(403, "Only the client marks a thread resolved")
    await db.client_messages.update_one({"id": mid}, {"$set": {"status": inp.status, "updated_at": _now()}})
    return {"ok": True}


# ---------------------------------------------------------------- edit / delete (author only)
async def _owned_msg(mid: str, user: dict) -> dict:
    msg = await db.client_messages.find_one({"id": mid}, {"_id": 0})
    if not msg:
        raise HTTPException(404, "Message not found")
    await require_company(user, msg["company_id"])
    return msg


def _recompute_status(msg: dict) -> str:
    if msg.get("status") == "resolved":
        return "resolved"
    replies = msg.get("replies") or []
    return "replied" if replies and replies[-1].get("by_pro") else "open"


class EditIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


@router.patch("/client-messages/{mid}/body")
async def edit_body(mid: str, inp: EditIn, user: dict = Depends(get_current_user)):
    msg = await _owned_msg(mid, user)
    if msg.get("from_user_id") != user["id"]:
        raise HTTPException(403, "You can only edit your own message")
    await db.client_messages.update_one({"id": mid}, {"$set": {"body": inp.text.strip(), "edited_at": _now(), "updated_at": _now()}})
    return {"ok": True}


@router.delete("/client-messages/{mid}")
async def delete_thread(mid: str, user: dict = Depends(get_current_user)):
    msg = await _owned_msg(mid, user)
    if msg.get("from_user_id") != user["id"]:
        raise HTTPException(403, "Only the person who started the thread can delete it")
    await db.client_messages.delete_one({"id": mid})
    return {"ok": True}


@router.patch("/client-messages/{mid}/replies/{rid}")
async def edit_reply(mid: str, rid: str, inp: EditIn, user: dict = Depends(get_current_user)):
    msg = await _owned_msg(mid, user)
    r = next((x for x in msg.get("replies") or [] if x["id"] == rid), None)
    if not r:
        raise HTTPException(404, "Reply not found")
    if r.get("by") != user["id"]:
        raise HTTPException(403, "You can only edit your own reply")
    await db.client_messages.update_one({"id": mid, "replies.id": rid},
                                        {"$set": {"replies.$.text": inp.text.strip(), "replies.$.edited_at": _now(), "updated_at": _now()}})
    return {"ok": True}


@router.delete("/client-messages/{mid}/replies/{rid}")
async def delete_reply(mid: str, rid: str, user: dict = Depends(get_current_user)):
    msg = await _owned_msg(mid, user)
    r = next((x for x in msg.get("replies") or [] if x["id"] == rid), None)
    if not r:
        raise HTTPException(404, "Reply not found")
    if r.get("by") != user["id"]:
        raise HTTPException(403, "You can only delete your own reply")
    msg["replies"] = [x for x in msg["replies"] if x["id"] != rid]
    await db.client_messages.update_one({"id": mid}, {"$set": {"replies": msg["replies"], "status": _recompute_status(msg), "updated_at": _now()}})
    return {"ok": True, "status": _recompute_status(msg)}
