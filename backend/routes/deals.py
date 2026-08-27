"""CRM deals — Leads → Won pipeline with drag-and-drop Kanban
(Feb 2026, Phase C kickoff).

Data model:
    deals:
      id, company_id
      title (required)
      contact_id (nullable — links to contacts collection)
      contact_name (denorm for fast Kanban card render)
      stage: one of _STAGES
      value (float — expected deal size)
      probability (0-100, auto-set by stage but user can override)
      expected_close_date (YYYY-MM-DD | None)
      owner_user_id (nullable)
      owner_name (denorm)
      source (str | None) — "referral" | "web" | ...
      notes (str)
      lost_reason (str | None)
      project_id (str | None) — filled once converted
      order (float) — sort position within the stage column
      activities: [{id, at, kind, body, by_user_id, by_name}]
      created_at, updated_at

Route prefix: /api/companies/{cid}/deals
"""
from __future__ import annotations

import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"]
# Default probability per stage — the frontend Kanban uses this to
# compute weighted pipeline value ("value × probability").
_STAGE_PROB = {"lead": 10, "qualified": 25, "proposal": 50,
                "negotiation": 75, "won": 100, "lost": 0}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ACTIVITY_KINDS = {"note", "call", "email", "meeting", "stage_change",
                    "system"}


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


def _validate_date(s: Optional[str]) -> Optional[str]:
    if s in (None, ""): return None
    if not _DATE_RE.match(s):
        raise HTTPException(400, "expected_close_date must be YYYY-MM-DD")
    return s


async def _load_contact(cid: str, contact_id: Optional[str]) -> Optional[dict]:
    if not contact_id: return None
    c = await db.contacts.find_one({"company_id": cid, "id": contact_id})
    if not c:
        raise HTTPException(400, f"Contact {contact_id} not found in this company")
    return c


async def _next_order_for_stage(cid: str, stage: str) -> float:
    """Append at the end of a Kanban column by default. Order is a
    monotonically-increasing float so DnD can insert between existing
    cards without renumbering the whole column."""
    doc = await db.deals.find_one(
        {"company_id": cid, "stage": stage}, sort=[("order", -1)])
    return (doc.get("order") or 0.0) + 1000.0 if doc else 1000.0


def _sys_activity(kind: str, body: str, user: dict) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "at": now_iso(),
        "kind": kind,
        "body": body,
        "by_user_id": user.get("id"),
        "by_name": user.get("name") or user.get("email") or "System",
    }


# ---------- List / Board ----------
@router.get("/companies/{cid}/deals")
async def list_deals(
    cid: str,
    stage: Optional[str] = None,
    contact_id: Optional[str] = None,
    owner_user_id: Optional[str] = None,
    limit: int = Query(500, le=2000),
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    if stage:
        if stage not in _STAGES:
            raise HTTPException(400, f"stage must be one of {_STAGES}")
        q["stage"] = stage
    if contact_id: q["contact_id"] = contact_id
    if owner_user_id: q["owner_user_id"] = owner_user_id
    rows = await db.deals.find(q).sort(
        [("order", 1), ("created_at", -1)]).to_list(limit)
    return {"deals": [_clean(d) for d in rows], "count": len(rows)}


@router.get("/companies/{cid}/deals/board")
async def board(
    cid: str,
    owner_user_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """Kanban board — deals grouped by stage with per-column totals
    (count, sum(value), sum(value × probability))."""
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    if owner_user_id: q["owner_user_id"] = owner_user_id
    rows = await db.deals.find(q).sort([("order", 1)]).to_list(2000)
    columns = []
    for st in _STAGES:
        deals = [_clean(d) for d in rows if d.get("stage") == st]
        v_sum = round(sum(float(d.get("value") or 0) for d in deals), 2)
        w_sum = round(sum(
            float(d.get("value") or 0) *
            (float(d.get("probability") or _STAGE_PROB.get(st, 0)) / 100.0)
            for d in deals), 2)
        columns.append({
            "stage": st,
            "deals": deals,
            "count": len(deals),
            "value_sum": v_sum,
            "weighted_sum": w_sum,
        })
    open_deals = [d for d in rows if d.get("stage") not in ("won", "lost")]
    return {
        "columns": columns,
        "totals": {
            "open_count": len(open_deals),
            "open_value": round(sum(
                float(d.get("value") or 0) for d in open_deals), 2),
            "weighted": round(sum(
                float(d.get("value") or 0) *
                (float(d.get("probability")
                        or _STAGE_PROB.get(d.get("stage"), 0)) / 100.0)
                for d in open_deals), 2),
        },
    }


# ---------- Create / update / delete ----------
@router.post("/companies/{cid}/deals")
async def create_deal(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    title = (payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "title is required")
    stage = payload.get("stage") or "lead"
    if stage not in _STAGES:
        raise HTTPException(400, f"stage must be one of {_STAGES}")
    contact = await _load_contact(cid, payload.get("contact_id"))
    value = float(payload.get("value") or 0)
    if value < 0:
        raise HTTPException(400, "value must be >= 0")
    probability = payload.get("probability")
    if probability is None:
        probability = _STAGE_PROB.get(stage, 0)
    else:
        probability = int(probability)
        if probability < 0 or probability > 100:
            raise HTTPException(400, "probability must be 0-100")
    exp_close = _validate_date(payload.get("expected_close_date"))
    order = await _next_order_for_stage(cid, stage)
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "title": title,
        "contact_id": contact["id"] if contact else None,
        "contact_name": contact.get("name") if contact else None,
        "stage": stage,
        "value": value,
        "probability": probability,
        "expected_close_date": exp_close,
        "owner_user_id": payload.get("owner_user_id") or user["id"],
        "owner_name": payload.get("owner_name") or user.get("name")
                        or user.get("email") or "",
        "source": (payload.get("source") or "").strip() or None,
        "notes": (payload.get("notes") or "").strip(),
        "lost_reason": None,
        "project_id": None,
        "order": order,
        "activities": [_sys_activity("system",
            f"Deal created in stage '{stage}'", user)],
        "created_at": now,
        "updated_at": now,
    }
    await db.deals.insert_one(doc)
    return {"ok": True, "deal": _clean(dict(doc))}


@router.patch("/companies/{cid}/deals/{did}")
async def update_deal(
    cid: str, did: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.deals.find_one({"company_id": cid, "id": did})
    if not doc:
        raise HTTPException(404, "Deal not found")
    update: dict = {}
    if "title" in payload:
        t = (payload["title"] or "").strip()
        if not t: raise HTTPException(400, "title cannot be blank")
        update["title"] = t
    if "value" in payload:
        v = float(payload["value"] or 0)
        if v < 0: raise HTTPException(400, "value must be >= 0")
        update["value"] = v
    if "probability" in payload and payload["probability"] is not None:
        p = int(payload["probability"])
        if p < 0 or p > 100:
            raise HTTPException(400, "probability must be 0-100")
        update["probability"] = p
    if "expected_close_date" in payload:
        update["expected_close_date"] = _validate_date(
            payload["expected_close_date"])
    if "contact_id" in payload:
        c = await _load_contact(cid, payload["contact_id"])
        update["contact_id"] = c["id"] if c else None
        update["contact_name"] = c.get("name") if c else None
    if "owner_user_id" in payload:
        update["owner_user_id"] = payload["owner_user_id"] or None
        update["owner_name"] = payload.get("owner_name") or ""
    for k in ("source", "notes", "lost_reason"):
        if k in payload:
            update[k] = (payload[k] or "").strip() or None
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.deals.update_one(
        {"company_id": cid, "id": did}, {"$set": update})
    fresh = await db.deals.find_one({"company_id": cid, "id": did})
    return {"ok": True, "deal": _clean(fresh)}


@router.post("/companies/{cid}/deals/{did}/move")
async def move_deal(
    cid: str, did: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Drag-and-drop endpoint. Payload:
        { stage: <new stage>, before_id?: <deal id to insert before>,
          after_id?: <deal id to insert after> }
    If neither before_id nor after_id is provided, the deal is
    appended at the end of the target column.
    Moving into 'won' or 'lost' also stamps a stage_change activity."""
    await require_company(user, cid)
    doc = await db.deals.find_one({"company_id": cid, "id": did})
    if not doc:
        raise HTTPException(404, "Deal not found")
    new_stage = payload.get("stage") or doc.get("stage")
    if new_stage not in _STAGES:
        raise HTTPException(400, f"stage must be one of {_STAGES}")

    before_id = payload.get("before_id")
    after_id = payload.get("after_id")
    if before_id and after_id:
        raise HTTPException(400, "pass only one of before_id / after_id")

    # Compute the new `order` — average of surrounding cards' orders
    # so we never renumber the whole column.
    new_order: float
    if before_id:
        target = await db.deals.find_one({"company_id": cid, "id": before_id})
        if not target: raise HTTPException(400, "before_id not found")
        # Find the card just above target in the SAME (new) stage.
        above = await db.deals.find_one(
            {"company_id": cid, "stage": new_stage,
             "order": {"$lt": target["order"]},
             "id": {"$ne": did}},
            sort=[("order", -1)])
        upper = target["order"]
        lower = above["order"] if above else (target["order"] - 2000)
        new_order = (upper + lower) / 2
    elif after_id:
        target = await db.deals.find_one({"company_id": cid, "id": after_id})
        if not target: raise HTTPException(400, "after_id not found")
        below = await db.deals.find_one(
            {"company_id": cid, "stage": new_stage,
             "order": {"$gt": target["order"]},
             "id": {"$ne": did}},
            sort=[("order", 1)])
        lower = target["order"]
        upper = below["order"] if below else (target["order"] + 2000)
        new_order = (lower + upper) / 2
    else:
        new_order = await _next_order_for_stage(cid, new_stage)

    update: dict = {"stage": new_stage, "order": new_order,
                     "updated_at": now_iso()}
    activities = list(doc.get("activities") or [])
    if new_stage != doc.get("stage"):
        activities.append(_sys_activity("stage_change",
            f"Moved {doc.get('stage')} → {new_stage}", user))
        # Auto-bump probability if user hasn't overridden it, but only
        # when moving between purely-open stages. Won/Lost force 100/0.
        if new_stage in ("won", "lost"):
            update["probability"] = _STAGE_PROB[new_stage]
        update["activities"] = activities
    await db.deals.update_one(
        {"company_id": cid, "id": did}, {"$set": update})
    fresh = await db.deals.find_one({"company_id": cid, "id": did})
    return {"ok": True, "deal": _clean(fresh)}


@router.delete("/companies/{cid}/deals/{did}")
async def delete_deal(
    cid: str, did: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    r = await db.deals.delete_one({"company_id": cid, "id": did})
    if r.deleted_count == 0:
        raise HTTPException(404, "Deal not found")
    return {"ok": True, "deleted": True}


# ---------- Activities feed ----------
@router.post("/companies/{cid}/deals/{did}/activities")
async def add_activity(
    cid: str, did: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    kind = (payload.get("kind") or "note").lower()
    if kind not in _ACTIVITY_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(_ACTIVITY_KINDS)}")
    body = (payload.get("body") or "").strip()
    if not body:
        raise HTTPException(400, "body is required")
    doc = await db.deals.find_one({"company_id": cid, "id": did})
    if not doc:
        raise HTTPException(404, "Deal not found")
    activity = {
        "id": str(uuid.uuid4()),
        "at": now_iso(),
        "kind": kind,
        "body": body,
        "by_user_id": user["id"],
        "by_name": user.get("name") or user.get("email") or "",
    }
    await db.deals.update_one(
        {"company_id": cid, "id": did},
        {"$push": {"activities": activity},
         "$set": {"updated_at": now_iso()}})
    return {"ok": True, "activity": activity}


# ---------- Deal → Project handoff ----------
@router.post("/companies/{cid}/deals/{did}/convert-to-project")
async def convert_to_project(
    cid: str, did: str, payload: dict | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """Seeds a Project from a won (or explicitly-forced) Deal:
       • name = payload.name OR deal.title
       • contact_id = deal.contact_id (REQUIRED — Projects need one)
       • estimated_revenue = deal.value
       • notes carries over
    Auto-moves the deal to 'won' if not already and stamps an activity.
    A deal can only convert once — repeat calls return the same
    linked project_id."""
    await require_company(user, cid)
    deal = await db.deals.find_one({"company_id": cid, "id": did})
    if not deal:
        raise HTTPException(404, "Deal not found")
    if deal.get("project_id"):
        proj = await db.projects.find_one(
            {"company_id": cid, "id": deal["project_id"]})
        return {"ok": True, "project": _clean(dict(proj)) if proj else None,
                "deal": _clean(dict(deal)),
                "already_converted": True}
    if not deal.get("contact_id"):
        raise HTTPException(400,
            "Deal must have a contact before it can convert to a project")

    payload = payload or {}
    name = (payload.get("name") or deal.get("title") or "").strip()
    if not name:
        raise HTTPException(400, "project name is required")

    # Duplicate-name guard mirrors POST /projects.
    dup = await db.projects.find_one({
        "company_id": cid,
        "contact_id": deal["contact_id"],
        "name": name,
    })
    if dup:
        raise HTTPException(409,
            f'A project "{name}" already exists for this customer')

    now = now_iso()
    proj_id = str(uuid.uuid4())
    project_doc = {
        "id": proj_id,
        "company_id": cid,
        "name": name,
        "contact_id": deal["contact_id"],
        "contact_name": deal.get("contact_name"),
        "status": "in_progress",
        "start_date": payload.get("start_date")
                       or now[:10],
        "end_date": payload.get("end_date")
                     or deal.get("expected_close_date"),
        "estimated_revenue": float(deal.get("value") or 0) or None,
        "hourly_cost_rate": None,
        "notes": (deal.get("notes") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    await db.projects.insert_one(project_doc)

    # Stamp the deal — flip to 'won' if it isn't already, link back,
    # and push a stage_change/system activity so the deal's history
    # tells the whole story.
    deal_update: dict = {
        "project_id": proj_id, "updated_at": now,
    }
    activities = list(deal.get("activities") or [])
    if deal.get("stage") != "won":
        deal_update["stage"] = "won"
        deal_update["probability"] = 100
        activities.append(_sys_activity("stage_change",
            f"Moved {deal.get('stage')} → won (converted)", user))
    activities.append(_sys_activity("system",
        f"Converted to project '{name}'", user))
    deal_update["activities"] = activities
    await db.deals.update_one(
        {"company_id": cid, "id": did}, {"$set": deal_update})
    deal_after = await db.deals.find_one({"company_id": cid, "id": did})
    return {"ok": True, "project": _clean(dict(project_doc)),
            "deal": _clean(deal_after),
            "already_converted": False}
