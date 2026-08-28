"""Tasks — universal to-do system (Feb 2026, Phase A-1).

A task is a lightweight cross-product entity: any user can create
one, assign to anyone (defaults to self), give it a due date, and
optionally attach it to a source entity so clicking it jumps back
to the right place.

Schema:
    tasks:
        id, company_id, title, description,
        assignee_user_id, created_by_user_id,
        due_date (ISO, nullable), status ("open"|"done"|"cancelled"),
        priority ("low"|"medium"|"high"),
        entity_type (nullable — "invoice", "bill", "project", "phase",
                     "deal", "employee", "transaction", etc.),
        entity_id (nullable),
        entity_label (denormalized display string — "INV-2023",
                       "Project #1", so the drawer renders without
                       joining across collections),
        completed_at (ISO, nullable),
        created_at, updated_at

Routes:
    GET    /api/companies/{cid}/tasks
    POST   /api/companies/{cid}/tasks
    PATCH  /api/companies/{cid}/tasks/{tid}
    DELETE /api/companies/{cid}/tasks/{tid}
    POST   /api/companies/{cid}/tasks/{tid}/complete   (toggle open ↔ done)
"""
from __future__ import annotations

import uuid
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_STATUS   = {"open", "done", "cancelled"}
_PRIORITY = {"low", "medium", "high"}
_KINDS    = {"task", "meeting", "call", "email"}


def _dedupe(seq):
    seen, out = set(), []
    for x in seq:
        if x and x not in seen:
            out.append(x); seen.add(x)
    return out


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


@router.get("/companies/{cid}/tasks")
async def list_tasks(
    cid: str,
    filter: str = Query("open", description="all | open | today | overdue | mine | done"),
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """Return tasks. Default surface is "open" (everything not-done).
    Additional slices support the drawer's filter chips.
    """
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    today = now_iso()[:10]

    if filter == "open":
        q["status"] = "open"
    elif filter == "today":
        q["status"] = "open"
        q["due_date"] = today
    elif filter == "overdue":
        q["status"] = "open"
        q["due_date"] = {"$lt": today, "$ne": None}
    elif filter == "mine":
        q["status"] = "open"
        q["assignee_user_id"] = user["id"]
    elif filter == "done":
        q["status"] = "done"
    # "all" applies no status filter.

    if entity_type:
        q["entity_type"] = entity_type
    if entity_id:
        q["entity_id"] = entity_id

    rows = await db.tasks.find(q).sort([
        ("due_date", 1),
        ("priority", -1),
        ("created_at", -1),
    ]).to_list(500)
    return {"tasks": [_clean(r) for r in rows], "count": len(rows)}


@router.post("/companies/{cid}/tasks")
async def create_task(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    title = (payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "Task title is required")
    status = payload.get("status") or "open"
    if status not in _STATUS:
        raise HTTPException(400, f"status must be one of {sorted(_STATUS)}")
    priority = payload.get("priority") or "medium"
    if priority not in _PRIORITY:
        raise HTTPException(400, f"priority must be one of {sorted(_PRIORITY)}")
    kind = payload.get("kind") or "task"
    if kind not in _KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(_KINDS)}")

    now = now_iso()
    # Optional time-of-day + duration for meetings/calls (Feb 2026).
    due_time = payload.get("due_time")
    if due_time is not None:
        if isinstance(due_time, str) and re.match(r"^\d{2}:\d{2}$", due_time):
            pass
        elif due_time == "":
            due_time = None
        else:
            raise HTTPException(400, "due_time must be HH:MM (24h)")
    duration_minutes = payload.get("duration_minutes")
    if duration_minutes not in (None, ""):
        try:
            duration_minutes = int(duration_minutes)
        except (TypeError, ValueError):
            raise HTTPException(400, "duration_minutes must be an integer")
        if duration_minutes < 0 or duration_minutes > 24 * 60:
            raise HTTPException(400, "duration_minutes must be 0-1440")
    else:
        duration_minutes = None

    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "title": title,
        "description": (payload.get("description") or "").strip(),
        "assignee_user_id": payload.get("assignee_user_id") or user["id"],
        # Multi-assignee (Google-Calendar-style). Always contains at
        # least the primary assignee so single-assignee code paths
        # keep working. `assignee_user_id` above is the "owner"
        # (first person listed); the list is the full guest roster.
        "assignee_user_ids": _dedupe([
            *(payload.get("assignee_user_ids") or []),
            payload.get("assignee_user_id") or user["id"],
        ]),
        # Multi-contact attendees (Feb 2026). A meeting can invite
        # several external contacts; each ID here also gets an
        # activity logged so their CRM feed stays in sync.
        "contact_ids": _dedupe(payload.get("contact_ids") or []),
        "created_by_user_id": user["id"],
        "due_date": payload.get("due_date") or None,
        "due_time": due_time,
        "duration_minutes": duration_minutes,
        "status": status,
        "priority": priority,
        "kind": kind,
        "entity_type": payload.get("entity_type") or None,
        "entity_id": payload.get("entity_id") or None,
        "entity_label": (payload.get("entity_label") or "").strip() or None,
        "completed_at": None,
        "created_at": now,
        "updated_at": now,
    }
    await db.tasks.insert_one(doc)
    # Notify the assignees (except the creator themselves).
    from routes.notifications import notify
    for aid in doc.get("assignee_user_ids") or []:
        if aid and aid != user["id"]:
            await notify(
                company_id=cid, user_id=aid,
                kind="task_assigned",
                title=f'{user.get("name") or user.get("email") or "Someone"} assigned you a task',
                body=title,
                link=f"/tasks?open={doc['id']}",
                source={"kind": "task", "id": doc["id"]},
            )
    # Google Calendar sync (fire-and-forget, meeting-kind only)
    if doc.get("kind") == "meeting":
        try:
            from routes.task_gcal_sync import sync_task_created
            await sync_task_created(doc)
            fresh = await db.tasks.find_one({"company_id": cid, "id": doc["id"]})
            if fresh: doc = fresh
        except Exception:
            pass
    return {"ok": True, "task": _clean(dict(doc))}


@router.patch("/companies/{cid}/tasks/{task_id}")
async def update_task(
    cid: str, task_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.tasks.find_one({"company_id": cid, "id": task_id})
    if not doc:
        raise HTTPException(404, "Task not found")
    update: dict = {}
    for f in ("title", "description", "assignee_user_id",
              "due_date", "due_time", "entity_type", "entity_id", "entity_label",
              "priority", "kind", "duration_minutes"):
        if f in payload:
            v = payload[f]
            update[f] = (v.strip() if isinstance(v, str) else v) or None
    if "assignee_user_ids" in payload:
        ids = payload["assignee_user_ids"] or []
        if not isinstance(ids, list):
            raise HTTPException(400, "assignee_user_ids must be a list")
        update["assignee_user_ids"] = _dedupe(ids)
    if "contact_ids" in payload:
        cids = payload["contact_ids"] or []
        if not isinstance(cids, list):
            raise HTTPException(400, "contact_ids must be a list")
        update["contact_ids"] = _dedupe(cids)
    if "title" in update and not update["title"]:
        raise HTTPException(400, "Title cannot be empty")
    if "priority" in update and update["priority"] not in _PRIORITY:
        raise HTTPException(400, f"priority must be one of {sorted(_PRIORITY)}")
    if "kind" in update and update["kind"] not in _KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(_KINDS)}")
    if "status" in payload:
        st = payload["status"]
        if st not in _STATUS:
            raise HTTPException(400, f"status must be one of {sorted(_STATUS)}")
        update["status"] = st
        # Auto-stamp completion time on transitions.
        if st == "done" and doc.get("status") != "done":
            update["completed_at"] = now_iso()
        if st != "done":
            update["completed_at"] = None
    if "priority" in payload:
        pr = payload["priority"]
        if pr not in _PRIORITY:
            raise HTTPException(400, f"priority must be one of {sorted(_PRIORITY)}")
        update["priority"] = pr
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.tasks.update_one(
        {"company_id": cid, "id": task_id}, {"$set": update})
    fresh = await db.tasks.find_one({"company_id": cid, "id": task_id})
    # Google Calendar sync — mirror updates and handle kind flips
    try:
        from routes.task_gcal_sync import sync_task_updated
        await sync_task_updated(fresh)
        fresh = await db.tasks.find_one({"company_id": cid, "id": task_id}) or fresh
    except Exception:
        pass
    return {"ok": True, "task": _clean(fresh)}


@router.delete("/companies/{cid}/tasks/{task_id}")
async def delete_task(
    cid: str, task_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    existing = await db.tasks.find_one({"company_id": cid, "id": task_id})
    if not existing:
        raise HTTPException(404, "Task not found")
    # Google Calendar sync — cascade delete before removing the row
    if existing.get("google_event_id"):
        try:
            from routes.task_gcal_sync import sync_task_deleted
            await sync_task_deleted(existing)
        except Exception:
            pass
    await db.tasks.delete_one({"company_id": cid, "id": task_id})
    return {"ok": True, "deleted": True}


@router.post("/companies/{cid}/tasks/{task_id}/complete")
async def toggle_complete(
    cid: str, task_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Flip open ↔ done in one shot — powers the drawer's checkbox."""
    await require_company(user, cid)
    doc = await db.tasks.find_one({"company_id": cid, "id": task_id})
    if not doc:
        raise HTTPException(404, "Task not found")
    new_status = "open" if doc.get("status") == "done" else "done"
    now = now_iso()
    await db.tasks.update_one(
        {"company_id": cid, "id": task_id},
        {"$set": {
            "status": new_status,
            "completed_at": now if new_status == "done" else None,
            "updated_at": now,
        }})
    fresh = await db.tasks.find_one({"company_id": cid, "id": task_id})
    return {"ok": True, "task": _clean(fresh)}
