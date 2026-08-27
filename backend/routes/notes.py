"""Notes — polymorphic free-form notes attached to any entity
(Feb 2026, Phase B-2).

An employee can jot a note on a customer, a project, a phase, an
invoice, a deal — anywhere. Notes are lightweight (title-less, body
+ author + timestamp) and support inline editing.

Schema:
    notes:
        id, company_id,
        entity_type ("employee", "project", "phase", "invoice",
                     "bill", "contact", "deal", "transaction", …),
        entity_id,
        body (markdown-lite text),
        author_user_id, author_name (denorm for fast rendering),
        pinned (bool),
        created_at, updated_at
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


@router.get("/companies/{cid}/notes")
async def list_notes(
    cid: str,
    entity_type: str = Query(...),
    entity_id: str = Query(...),
    user: dict = Depends(get_current_user),
) -> dict:
    """List notes for a specific entity. Pinned notes float to top."""
    await require_company(user, cid)
    rows = await db.notes.find({
        "company_id": cid,
        "entity_type": entity_type,
        "entity_id": entity_id,
    }).sort([("pinned", -1), ("created_at", -1)]).to_list(200)
    return {"notes": [_clean(r) for r in rows], "count": len(rows)}


@router.post("/companies/{cid}/notes")
async def create_note(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    body = (payload.get("body") or "").strip()
    if not body:
        raise HTTPException(400, "Note body is required")
    entity_type = (payload.get("entity_type") or "").strip()
    entity_id = (payload.get("entity_id") or "").strip()
    if not entity_type or not entity_id:
        raise HTTPException(400, "entity_type and entity_id are required")
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "body": body,
        "author_user_id": user["id"],
        "author_name": user.get("name") or user.get("email") or "user",
        "pinned": bool(payload.get("pinned", False)),
        "created_at": now,
        "updated_at": now,
    }
    await db.notes.insert_one(doc)
    return {"ok": True, "note": _clean(dict(doc))}


@router.patch("/companies/{cid}/notes/{nid}")
async def update_note(
    cid: str, nid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.notes.find_one({"company_id": cid, "id": nid})
    if not doc:
        raise HTTPException(404, "Note not found")
    update: dict = {}
    if "body" in payload:
        v = (payload["body"] or "").strip()
        if not v:
            raise HTTPException(400, "Body cannot be empty")
        update["body"] = v
    if "pinned" in payload:
        update["pinned"] = bool(payload["pinned"])
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.notes.update_one({"company_id": cid, "id": nid}, {"$set": update})
    fresh = await db.notes.find_one({"company_id": cid, "id": nid})
    return {"ok": True, "note": _clean(fresh)}


@router.delete("/companies/{cid}/notes/{nid}")
async def delete_note(
    cid: str, nid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    r = await db.notes.delete_one({"company_id": cid, "id": nid})
    if r.deleted_count == 0:
        raise HTTPException(404, "Note not found")
    return {"ok": True, "deleted": True}
