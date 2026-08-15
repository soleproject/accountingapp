"""Feedback (bug reports + product recommendations).

Any signed-in user can `POST /api/feedback` to file a bug or recommendation.
Every submission emails every user with `role == "superadmin"` so the
platform team never misses one. Superadmins triage via `/admin/feedback`
using a 4-state workflow (new / in_progress / completed / wont_do).
Submitters get an in-app list at `/feedback/mine` — no status-change
emails (product decision: keep noise low).
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import get_current_user, require_role
from db import db, now_iso, coerce

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["feedback"])


# --------------------------------------------------------------------------
# Payloads
# --------------------------------------------------------------------------
VALID_TYPES = {"bug", "recommendation"}
VALID_STATUSES = {"new", "in_progress", "completed", "wont_do"}


class FeedbackCreate(BaseModel):
    type: str = Field(..., description="'bug' or 'recommendation'")
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field("", max_length=5000)
    route: Optional[str] = Field(None, max_length=500, description="Frontend path the user was on")
    user_agent: Optional[str] = Field(None, max_length=500)
    company_id: Optional[str] = Field(None, description="Currently-active company, if any")


class FeedbackPatch(BaseModel):
    status: Optional[str] = None
    admin_note: Optional[str] = None  # append-only


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _scrub(row: dict) -> dict:
    row = coerce(row)
    row.pop("_id", None)
    return row


async def _notify_superadmins(item: dict, submitter: dict) -> None:
    """Fire a branded email to every superadmin. Never raises — a failed
    email must not block the submission itself."""
    try:
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl

        admins = await db.users.find({"role": "superadmin"}).to_list(length=100)
        if not admins:
            return

        subject, html = _tmpl.feedback_new_submission(
            fb_type=item["type"],
            title=item["title"],
            description=item.get("description") or "",
            submitter_name=submitter.get("name") or submitter.get("email") or "Unknown",
            submitter_email=submitter.get("email") or "",
            submitter_role=submitter.get("role") or "",
            route=item.get("route") or "",
            company_name=item.get("company_name") or "",
            inbox_url=f"{public_base_url()}/admin/feedback",
        )
        for admin in admins:
            if not admin.get("email"):
                continue
            await dispatch(
                kind="feedback_new_submission",
                to=admin["email"],
                subject=subject,
                html=html,
                initiating_user_id=None,  # system-initiated — skips per-user pref check
                related={"feedback_id": item["id"], "type": item["type"]},
            )
    except Exception:
        log.exception("Feedback superadmin notify failed (submission still saved)")


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@router.post("/feedback")
async def create_feedback(inp: FeedbackCreate, user: dict = Depends(get_current_user)):
    if inp.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")

    now = now_iso()

    # Resolve current company name for context (best-effort)
    company_name = None
    if inp.company_id:
        c = await db.companies.find_one({"id": inp.company_id}, {"name": 1})
        if c:
            company_name = c.get("name")

    item = {
        "id": str(uuid.uuid4()),
        "type": inp.type,
        "title": inp.title.strip(),
        "description": (inp.description or "").strip(),
        "status": "new",
        "submitter_user_id": user["id"],
        "submitter_email": user.get("email"),
        "submitter_name": user.get("name") or user.get("full_name"),
        "submitter_role": user.get("role"),
        "company_id": inp.company_id,
        "company_name": company_name,
        "route": (inp.route or "").strip() or None,
        "user_agent": (inp.user_agent or "").strip() or None,
        "admin_notes": [],  # append-only journal, [{author_id, author_name, note, at}]
        "created_at": now,
        "updated_at": now,
    }
    await db.feedback_items.insert_one(item)
    await _notify_superadmins(item, user)
    return {"id": item["id"], "status": "new"}


@router.get("/feedback/mine")
async def list_my_feedback(user: dict = Depends(get_current_user)):
    """Every submitter can see their own tickets + statuses."""
    rows = await db.feedback_items.find(
        {"submitter_user_id": user["id"]}
    ).sort("created_at", -1).to_list(length=500)
    return {"items": [_scrub(r) for r in rows]}


@router.get("/feedback")
async def list_all_feedback(
    status: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Search title/description"),
    user: dict = Depends(require_role("superadmin")),
):
    """Superadmin-only inbox."""
    query: dict = {}
    if status:
        if status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUSES)}")
        query["status"] = status
    if type:
        if type not in VALID_TYPES:
            raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")
        query["type"] = type
    if q:
        import re
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        query["$or"] = [{"title": rx}, {"description": rx}, {"submitter_email": rx}]

    rows = await db.feedback_items.find(query).sort("created_at", -1).to_list(length=1000)
    items = [_scrub(r) for r in rows]

    # Also return per-status counts (over the WHOLE inbox, ignoring filters)
    # so the tab pills always show accurate totals.
    counts = {s: 0 for s in VALID_STATUSES}
    async for r in db.feedback_items.find({}, {"status": 1}):
        s = r.get("status") or "new"
        if s in counts:
            counts[s] += 1
    return {"items": items, "counts": counts}


@router.patch("/feedback/{fid}")
async def patch_feedback(
    fid: str,
    patch: FeedbackPatch,
    user: dict = Depends(require_role("superadmin")),
):
    row = await db.feedback_items.find_one({"id": fid})
    if not row:
        raise HTTPException(status_code=404, detail="Feedback not found")

    updates: dict = {"updated_at": now_iso()}
    if patch.status is not None:
        if patch.status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUSES)}")
        updates["status"] = patch.status

    push = None
    if patch.admin_note and patch.admin_note.strip():
        push = {
            "id": str(uuid.uuid4()),
            "author_id": user["id"],
            "author_name": user.get("name") or user.get("email") or "Superadmin",
            "note": patch.admin_note.strip()[:2000],
            "at": now_iso(),
        }

    ops: dict = {"$set": updates}
    if push:
        ops["$push"] = {"admin_notes": push}
    await db.feedback_items.update_one({"id": fid}, ops)

    fresh = await db.feedback_items.find_one({"id": fid})
    return _scrub(fresh)
