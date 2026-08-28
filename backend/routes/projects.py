"""Projects CRUD (Phase 3 — Feb 2026).

Mirrors the Classes shape but adds a required `contact_id` (the
customer the project is for), lifecycle status, and estimated_revenue
for the profitability report.

Routes:
    GET    /api/companies/{cid}/projects
    POST   /api/companies/{cid}/projects
    PATCH  /api/companies/{cid}/projects/{project_id}
    DELETE /api/companies/{cid}/projects/{project_id}
    GET    /api/companies/{cid}/reports/project-profitability
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_VALID_STATUS = {"planning", "in_progress", "on_hold",
                  "completed", "cancelled"}

# The one type every company gets for free — never deletable so the
# dropdown always has a fallback.
_DEFAULT_PROJECT_TYPE = "General"


def _clean(doc: dict) -> dict:
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


async def _load_project_types(cid: str) -> list[str]:
    """Fetch the company's saved project types, always with
    'General' first + any user-added values sorted alphabetically."""
    doc = await db.project_settings.find_one({"company_id": cid})
    extras = sorted({t for t in (doc.get("types") if doc else [])
                      if t and t != _DEFAULT_PROJECT_TYPE})
    return [_DEFAULT_PROJECT_TYPE] + extras


async def _upsert_project_type(cid: str, name: str) -> None:
    """Add `name` to the company's project types list (idempotent).
    Called both from the explicit POST endpoint and from
    create_project so users don't have to configure types up front."""
    name = (name or "").strip()
    if not name or name == _DEFAULT_PROJECT_TYPE: return
    await db.project_settings.update_one(
        {"company_id": cid},
        {"$addToSet": {"types": name},
          "$set":     {"updated_at": now_iso()},
          "$setOnInsert": {"company_id": cid, "created_at": now_iso()}},
        upsert=True,
    )


async def _project_in_use(cid: str, project_id: str) -> bool:
    if await db.transactions.count_documents(
        {"company_id": cid, "project_id": project_id}, limit=1,
    ):
        return True
    if await db.journal_entries.count_documents(
        {"company_id": cid, "lines.project_id": project_id}, limit=1,
    ):
        return True
    for coll in ("invoices", "bills", "payments", "receipts", "estimates"):
        if await db[coll].count_documents(
            {"company_id": cid, "project_id": project_id}, limit=1,
        ):
            return True
    return False


# ------------------------- Project types (settings) -------------------------
@router.get("/companies/{cid}/project-types")
async def list_project_types(
    cid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    return {"types": await _load_project_types(cid)}


@router.post("/companies/{cid}/project-types")
async def add_project_type(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    if len(name) > 40:
        raise HTTPException(400, "name must be <= 40 chars")
    await _upsert_project_type(cid, name)
    return {"ok": True, "types": await _load_project_types(cid)}


@router.delete("/companies/{cid}/project-types/{name}")
async def delete_project_type(
    cid: str, name: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Remove a saved type. Projects already using it keep their
    value — we just stop offering it in the dropdown."""
    await require_company(user, cid)
    if name == _DEFAULT_PROJECT_TYPE:
        raise HTTPException(400, "General cannot be removed")
    await db.project_settings.update_one(
        {"company_id": cid}, {"$pull": {"types": name}})
    return {"ok": True, "types": await _load_project_types(cid)}


# ------------------------- CRUD -------------------------
@router.get("/companies/{cid}/projects")
async def list_projects(
    cid: str,
    status: Optional[str] = None,
    contact_id: Optional[str] = None,
    include_inactive: int = Query(0),
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    q: dict[str, Any] = {"company_id": cid}
    if status:
        q["status"] = status
    if contact_id:
        q["contact_id"] = contact_id
    if not include_inactive:
        q["status"] = q.get("status") or {"$nin": ["cancelled"]}
    rows = await db.projects.find(q).sort("name", 1).to_list(2000)
    return {"projects": [_clean(r) for r in rows]}


@router.post("/companies/{cid}/projects")
async def create_project(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Project name is required")
    contact_id = payload.get("contact_id")
    if not contact_id:
        raise HTTPException(400, "A customer (contact_id) is required")
    contact = await db.contacts.find_one(
        {"company_id": cid, "id": contact_id})
    if not contact:
        raise HTTPException(404, "Customer not found in this company")
    # Uniqueness: same name + same customer conflicts (matches QBO —
    # a customer can have "Kitchen Remodel 2024" and "Kitchen Remodel
    # 2025", but not two identical names).
    dup = await db.projects.find_one({
        "company_id": cid,
        "contact_id": contact_id,
        "name": {"$regex": f"^{name}$", "$options": "i"},
    })
    if dup:
        raise HTTPException(
            409, f'"{name}" already exists for this customer')
    status = payload.get("status") or "in_progress"
    if status not in _VALID_STATUS:
        raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUS)}")

    # Project type — free-form label with a "General" default. If the
    # user picks a brand-new value we upsert it into the company's
    # saved types list so it appears in the dropdown next time.
    project_type = (payload.get("project_type") or "General").strip() or "General"
    if len(project_type) > 40:
        raise HTTPException(400, "project_type must be <= 40 chars")
    await _upsert_project_type(cid, project_type)

    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": name,
        "contact_id": contact_id,
        "contact_name": contact.get("name"),
        "status": status,
        "project_type": project_type,
        "start_date": payload.get("start_date"),
        "end_date": payload.get("end_date"),
        "estimated_revenue": (float(payload["estimated_revenue"])
                                if payload.get("estimated_revenue") is not None
                                else None),
        "hourly_cost_rate": (float(payload["hourly_cost_rate"])
                              if payload.get("hourly_cost_rate") is not None
                              else None),
        "notes": (payload.get("notes") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    await db.projects.insert_one(doc)
    return {"ok": True, "project": _clean(dict(doc))}


@router.patch("/companies/{cid}/projects/{project_id}")
async def update_project(
    cid: str, project_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not doc:
        raise HTTPException(404, "Project not found")

    update: dict = {}
    if "name" in payload:
        new_name = (payload["name"] or "").strip()
        if not new_name:
            raise HTTPException(400, "Name cannot be empty")
        # Uniqueness scoped to same customer.
        dup = await db.projects.find_one({
            "company_id": cid,
            "contact_id": doc["contact_id"],
            "id": {"$ne": project_id},
            "name": {"$regex": f"^{new_name}$", "$options": "i"},
        })
        if dup:
            raise HTTPException(409, "Another project on this customer already has that name")
        update["name"] = new_name
    if "status" in payload:
        st = payload["status"]
        if st not in _VALID_STATUS:
            raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUS)}")
        update["status"] = st
    if "project_type" in payload:
        pt = (payload["project_type"] or "General").strip() or "General"
        if len(pt) > 40:
            raise HTTPException(400, "project_type must be <= 40 chars")
        await _upsert_project_type(cid, pt)
        update["project_type"] = pt
    for f in ("start_date", "end_date", "notes"):
        if f in payload:
            update[f] = payload[f]
    for f in ("estimated_revenue", "hourly_cost_rate"):
        if f in payload:
            update[f] = (float(payload[f])
                          if payload[f] is not None else None)
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.projects.update_one(
        {"company_id": cid, "id": project_id}, {"$set": update})
    fresh = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    return {"ok": True, "project": _clean(fresh)}


@router.delete("/companies/{cid}/projects/{project_id}")
async def delete_project(
    cid: str, project_id: str,
    hard: int = Query(0),
    user: dict = Depends(get_current_user),
) -> dict:
    """Soft-delete by default (status → cancelled). `hard=1` removes
    the row entirely — only when nothing references it."""
    await require_company(user, cid)
    doc = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not doc:
        raise HTTPException(404, "Project not found")
    if hard:
        if await _project_in_use(cid, project_id):
            raise HTTPException(
                400,
                "Project is referenced by transactions or journal entries — mark cancelled instead")
        await db.projects.delete_one(
            {"company_id": cid, "id": project_id})
        # Delete owned phases too (they belong to the project).
        await db.project_phases.delete_many(
            {"company_id": cid, "project_id": project_id})
        return {"ok": True, "deleted": True, "hard": True}
    await db.projects.update_one(
        {"company_id": cid, "id": project_id},
        {"$set": {"status": "cancelled", "updated_at": now_iso()}},
    )
    return {"ok": True, "deleted": True, "hard": False}


# ------------------------- Phases -------------------------
async def _phase_in_use(cid: str, phase_id: str) -> bool:
    if await db.transactions.count_documents(
        {"company_id": cid, "phase_id": phase_id}, limit=1,
    ):
        return True
    if await db.journal_entries.count_documents(
        {"company_id": cid, "lines.phase_id": phase_id}, limit=1,
    ):
        return True
    for coll in ("invoices", "bills", "payments", "receipts", "estimates"):
        if await db[coll].count_documents(
            {"company_id": cid, "phase_id": phase_id}, limit=1,
        ):
            return True
    return False


@router.get("/companies/{cid}/projects/{project_id}/phases")
async def list_phases(
    cid: str, project_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    rows = await db.project_phases.find(
        {"company_id": cid, "project_id": project_id},
    ).sort("sort_order", 1).to_list(200)
    return {"phases": [_clean(r) for r in rows]}


@router.post("/companies/{cid}/projects/{project_id}/phases")
async def create_phase(
    cid: str, project_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    project = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Phase name is required")
    # Uniqueness scoped to the project.
    dup = await db.project_phases.find_one({
        "company_id": cid, "project_id": project_id,
        "name": {"$regex": f"^{name}$", "$options": "i"},
    })
    if dup:
        raise HTTPException(409, f'Phase "{name}" already exists on this project')
    # Default sort_order = current phase count so new phases append.
    count = await db.project_phases.count_documents(
        {"company_id": cid, "project_id": project_id})
    sort_order = payload.get("sort_order")
    if sort_order is None:
        sort_order = count
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "project_id": project_id,
        "name": name,
        "sort_order": int(sort_order),
        "status": payload.get("status") or "in_progress",
        "start_date": payload.get("start_date"),
        "end_date": payload.get("end_date"),
        "notes": (payload.get("notes") or "").strip(),
        # Optional per-phase estimates so a PM can budget each phase
        # independently. `estimated_revenue` rolls up on the ProjectDetail
        # Estimates-vs-Actuals report; `estimated_cost` is the target for
        # phase-scoped cost tracking.
        "estimated_revenue": (float(payload["estimated_revenue"])
                                if payload.get("estimated_revenue") is not None
                                and payload.get("estimated_revenue") != ""
                                else None),
        "estimated_cost": (float(payload["estimated_cost"])
                              if payload.get("estimated_cost") is not None
                              and payload.get("estimated_cost") != ""
                              else None),
        # Team members assigned to this phase. Drives the "Team
        # assignments per phase" card on the Project detail page +
        # the /projects/dashboard team-allocation rollup.
        "assignee_user_ids": [
            uid for uid in (payload.get("assignee_user_ids") or [])
            if isinstance(uid, str) and uid
        ],
        "created_at": now,
        "updated_at": now,
    }
    await db.project_phases.insert_one(doc)
    return {"ok": True, "phase": _clean(dict(doc))}


@router.patch("/companies/{cid}/projects/{project_id}/phases/{phase_id}")
async def update_phase(
    cid: str, project_id: str, phase_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.project_phases.find_one(
        {"company_id": cid, "id": phase_id, "project_id": project_id})
    if not doc:
        raise HTTPException(404, "Phase not found")
    update: dict = {}
    if "name" in payload:
        new_name = (payload["name"] or "").strip()
        if not new_name:
            raise HTTPException(400, "Name cannot be empty")
        dup = await db.project_phases.find_one({
            "company_id": cid, "project_id": project_id,
            "id": {"$ne": phase_id},
            "name": {"$regex": f"^{new_name}$", "$options": "i"},
        })
        if dup:
            raise HTTPException(409, "Another phase on this project already has that name")
        update["name"] = new_name
    for f in ("sort_order", "status", "start_date", "end_date", "notes"):
        if f in payload:
            update[f] = payload[f]
    for f in ("estimated_revenue", "estimated_cost"):
        if f in payload:
            v = payload[f]
            update[f] = (float(v) if v not in (None, "") else None)
    if "assignee_user_ids" in payload:
        ids = payload["assignee_user_ids"] or []
        if not isinstance(ids, list):
            raise HTTPException(400, "assignee_user_ids must be a list")
        update["assignee_user_ids"] = [
            uid for uid in ids if isinstance(uid, str) and uid]
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.project_phases.update_one(
        {"company_id": cid, "id": phase_id}, {"$set": update})
    fresh = await db.project_phases.find_one(
        {"company_id": cid, "id": phase_id})
    return {"ok": True, "phase": _clean(fresh)}


@router.delete("/companies/{cid}/projects/{project_id}/phases/{phase_id}")
async def delete_phase(
    cid: str, project_id: str, phase_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Hard-delete a phase — only when unreferenced. Any doc still
    tagged with the phase blocks the delete."""
    await require_company(user, cid)
    doc = await db.project_phases.find_one(
        {"company_id": cid, "id": phase_id, "project_id": project_id})
    if not doc:
        raise HTTPException(404, "Phase not found")
    if await _phase_in_use(cid, phase_id):
        raise HTTPException(
            400,
            "Phase is referenced by transactions or journal entries — reassign them first")
    await db.project_phases.delete_one(
        {"company_id": cid, "id": phase_id})
    return {"ok": True, "deleted": True}


# ------------------------- Reports -------------------------
@router.get("/companies/{cid}/projects/dashboard")
async def projects_dashboard(
    cid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Everything the /accounting/projects landing page needs in one
    round-trip. Windows are 30/60/90/180 days for the pipeline
    buckets, and 6 months for the cash-flow forecast."""
    from datetime import datetime, timedelta, timezone
    await require_company(user, cid)
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()

    # ---------- 1) Fetch data slices ----------
    projects = await db.projects.find({"company_id": cid}).to_list(5000)
    open_projects = [p for p in projects
                      if p.get("status") in ("planning", "in_progress", "on_hold")]
    phases = await db.project_phases.find({
        "company_id": cid,
        "project_id": {"$in": [p["id"] for p in open_projects]},
    }).to_list(20000) if open_projects else []
    # Actual cost so far — approximate from time_entries * rate.
    time_agg = {}
    async for t in db.time_entries.find({
        "company_id": cid, "status": {"$in": ["approved", "submitted"]},
    }, {"project_id": 1, "duration_minutes": 1,
         "hourly_rate_snapshot": 1, "employee_id": 1}):
        pid = t.get("project_id")
        if not pid: continue
        mins = int(t.get("duration_minutes") or 0)
        rate = float(t.get("hourly_rate_snapshot") or 0)
        time_agg[pid] = time_agg.get(pid, 0.0) + (mins / 60.0) * rate
    employees = await db.employees.find({"company_id": cid}).to_list(500)
    emp_by_uid = {e.get("user_id"): e for e in employees if e.get("user_id")}

    # ---------- 2) Bucketize pipeline (30/60/90/180 by end_date) ----------
    def _in_window(dt_str: str | None, days: int) -> bool:
        if not dt_str: return False
        try:
            d = datetime.fromisoformat(dt_str[:10]).date()
        except ValueError:
            return False
        return today <= dt_str[:10] <= (now + timedelta(days=days)).date().isoformat()

    buckets: dict[int, list[dict]] = {30: [], 60: [], 90: [], 180: []}
    for w in (30, 60, 90, 180):
        for p in open_projects:
            if _in_window(p.get("end_date"), w):
                buckets[w].append({
                    "kind": "project", "id": p["id"],
                    "name": p.get("name"),
                    "contact_name": p.get("contact_name"),
                    "project_type": p.get("project_type") or "General",
                    "end_date": p.get("end_date"),
                    "estimated_revenue": float(p.get("estimated_revenue") or 0),
                })
        for ph in phases:
            if _in_window(ph.get("end_date"), w):
                parent = next((p for p in open_projects
                                if p["id"] == ph.get("project_id")), None)
                buckets[w].append({
                    "kind": "phase", "id": ph["id"],
                    "name": ph.get("name"),
                    "contact_name": parent.get("contact_name") if parent else None,
                    "project_name": parent.get("name") if parent else None,
                    "project_id": ph.get("project_id"),
                    "project_type": (parent or {}).get("project_type") or "General",
                    "end_date": ph.get("end_date"),
                    "estimated_revenue": float(ph.get("estimated_revenue")
                                                or 0),
                })
        buckets[w].sort(key=lambda x: x.get("end_date") or "")

    bucket_summary = {}
    for w in (30, 60, 90, 180):
        rev = sum(x["estimated_revenue"] for x in buckets[w]
                   if x["kind"] == "project")  # avoid double count phase→project
        bucket_summary[str(w)] = {
            "count": len([x for x in buckets[w] if x["kind"] == "project"]),
            "phase_count": len([x for x in buckets[w] if x["kind"] == "phase"]),
            "expected_revenue": round(rev, 2),
        }

    # ---------- 3) Cash-flow forecast — next 6 months ----------
    cash_flow: list[dict] = []
    for i in range(6):
        m_start = (now.replace(day=1) + timedelta(days=32 * i)).replace(day=1)
        # Next month's day 1.
        m_next  = (m_start + timedelta(days=32)).replace(day=1)
        key = m_start.strftime("%Y-%m")
        expected = sum(float(p.get("estimated_revenue") or 0)
                        for p in open_projects
                        if p.get("end_date")
                          and m_start.date().isoformat() <= p["end_date"][:10]
                                                          < m_next.date().isoformat())
        cash_flow.append({
            "month": key,
            "label": m_start.strftime("%b %Y"),
            "expected_revenue": round(expected, 2),
        })

    # ---------- 4) Project-type mix ----------
    type_agg: dict[str, dict] = {}
    for p in open_projects:
        t = p.get("project_type") or "General"
        agg = type_agg.setdefault(t, {"count": 0, "value": 0.0})
        agg["count"] += 1
        agg["value"] += float(p.get("estimated_revenue") or 0)
    type_mix = [{"type": k, "count": v["count"],
                  "value": round(v["value"], 2)}
                 for k, v in type_agg.items()]
    type_mix.sort(key=lambda x: x["count"], reverse=True)

    # ---------- 5) At-risk projects ----------
    at_risk = []
    for p in open_projects:
        end = p.get("end_date")
        est = float(p.get("estimated_revenue") or 0)
        actual = round(time_agg.get(p["id"], 0.0), 2)
        reasons = []
        if end and end[:10] < today:
            reasons.append(f"past due (end {end[:10]})")
        if est > 0 and actual > est:
            reasons.append(f"over budget ({round(actual/est*100)}%)")
        if reasons:
            at_risk.append({
                "id": p["id"], "name": p.get("name"),
                "contact_name": p.get("contact_name"),
                "end_date": end,
                "estimated_revenue": est,
                "actual_cost": actual,
                "reason": " · ".join(reasons),
            })
    at_risk.sort(key=lambda x: x.get("end_date") or "9999")

    # ---------- 6) Variance leaderboard ----------
    variance = []
    for p in open_projects:
        est = float(p.get("estimated_revenue") or 0)
        actual = round(time_agg.get(p["id"], 0.0), 2)
        if est <= 0: continue
        variance.append({
            "id": p["id"], "name": p.get("name"),
            "estimated_revenue": est,
            "actual_cost": actual,
            "variance": round(est - actual, 2),
            "variance_pct": round((actual - est) / est * 100, 1),
        })
    variance.sort(key=lambda x: abs(x["variance_pct"]), reverse=True)
    variance = variance[:5]

    # ---------- 7) Phase deadlines this week ----------
    week_end = (now + timedelta(days=7)).date().isoformat()
    phase_deadlines = []
    for ph in phases:
        end = ph.get("end_date")
        if end and today <= end[:10] <= week_end:
            parent = next((p for p in open_projects
                            if p["id"] == ph.get("project_id")), None)
            phase_deadlines.append({
                "id": ph["id"],
                "name": ph.get("name"),
                "project_id": ph.get("project_id"),
                "project_name": parent.get("name") if parent else None,
                "end_date": end,
                "assignee_user_ids": ph.get("assignee_user_ids") or [],
            })
    phase_deadlines.sort(key=lambda x: x["end_date"])

    # ---------- 8) Team allocation — next 30 days ----------
    horizon = (now + timedelta(days=30)).date().isoformat()
    alloc: dict[str, dict] = {}
    for ph in phases:
        if not ph.get("end_date"): continue
        if ph["end_date"][:10] > horizon: continue
        parent = next((p for p in open_projects
                        if p["id"] == ph.get("project_id")), None)
        if not parent: continue
        for uid in (ph.get("assignee_user_ids") or []):
            slot = alloc.setdefault(uid, {
                "user_id": uid,
                "name": (emp_by_uid.get(uid) or {}).get("name") or "Teammate",
                "projects": {},
            })
            proj = slot["projects"].setdefault(parent["id"], {
                "project_id": parent["id"],
                "project_name": parent["name"],
                "phase_count": 0,
            })
            proj["phase_count"] += 1
    team_allocation = [{
        **s, "projects": list(s["projects"].values())
    } for s in alloc.values()]
    team_allocation.sort(
        key=lambda x: sum(p["phase_count"] for p in x["projects"]),
        reverse=True)

    # ---------- 9) KPI band ----------
    kpis = {
        "active_count": len(open_projects),
        "backlog_value": round(sum(float(p.get("estimated_revenue") or 0)
                                    for p in open_projects), 2),
        "at_risk_count": len(at_risk),
        "expected_90d": bucket_summary["90"]["expected_revenue"],
    }

    return {
        "kpis": kpis,
        "buckets": {str(k): v for k, v in buckets.items()},
        "bucket_summary": bucket_summary,
        "cash_flow": cash_flow,
        "type_mix": type_mix,
        "at_risk": at_risk,
        "variance": variance,
        "phase_deadlines": phase_deadlines,
        "team_allocation": team_allocation,
        "generated_at": now.isoformat(),
    }


@router.get("/companies/{cid}/reports/project-profitability")
async def project_profitability(
    cid: str,
    project_id: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    basis: str = "accrual",
    group_by_phase: int = Query(0, description="If 1, also return per-phase rollup"),
    user: dict = Depends(get_current_user),
) -> dict:
    """Income + expense rollup scoped to a single project.

    Uses the same `_signed_balances(class_id=None, project_id=X)`
    engine that class-slicing does, then splits the returned map
    into revenue / expense / COGS buckets and computes net.

    Also joins the project's `estimated_revenue` so the frontend
    can render "% of estimate consumed" without a second call.
    """
    await require_company(user, cid)
    project = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")

    from reports import _signed_balances
    accts = await db.accounts.find(
        {"company_id": cid}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    # Wide date range if start/end omitted so a project's full
    # history rolls up by default.
    s = start or "2000-01-01"
    e = end or "2099-12-31"
    by = await _signed_balances(
        cid, s, e, basis=basis.capitalize(), project_id=project_id)

    revenue_rows: list[dict] = []
    expense_rows: list[dict] = []
    cogs_rows: list[dict] = []
    total_revenue = 0.0
    total_expense = 0.0
    total_cogs = 0.0

    for aid, bal in by.items():
        a = accts_by_id.get(aid)
        if not a:
            continue
        t = (a.get("type") or "").lower()
        row = {"id": aid, "code": a.get("code"), "name": a.get("name"),
               "amount": round(bal, 2)}
        # Revenue is credit-normal → `by[]` returns debit-positive
        # (negative). Flip for display.
        if t in ("revenue", "income"):
            row["amount"] = round(-bal, 2)
            revenue_rows.append(row)
            total_revenue += row["amount"]
        elif t == "cogs":
            cogs_rows.append(row)
            total_cogs += row["amount"]
        elif t == "expense":
            expense_rows.append(row)
            total_expense += row["amount"]

    net = round(total_revenue - total_cogs - total_expense, 2)
    est = project.get("estimated_revenue")
    result = {
        "project": _clean(dict(project)),
        "start": s, "end": e, "basis": basis,
        "revenue":  {"rows": revenue_rows, "total": round(total_revenue, 2)},
        "cogs":     {"rows": cogs_rows,    "total": round(total_cogs, 2)},
        "expenses": {"rows": expense_rows, "total": round(total_expense, 2)},
        "gross_profit": round(total_revenue - total_cogs, 2),
        "net_income": net,
        "estimated_revenue": est,
        "pct_of_estimate": (round((total_revenue / est) * 100, 1)
                              if est and est > 0 else None),
    }

    # -----------------------------------------------------------------
    # Optional per-phase P&L breakdown (Feb 2026 Phase 3). Walks the
    # project's phases + attributes each posting to a phase based on
    # `phase_id` on the txn / JE line. Postings under this project
    # but without a `phase_id` roll under a synthetic "Unphased"
    # bucket so nothing disappears. Cheap — one txn scan + one JE
    # scan, both already scoped by project_id.
    # -----------------------------------------------------------------
    if group_by_phase:
        phases = await db.project_phases.find(
            {"company_id": cid, "project_id": project_id},
        ).sort("sort_order", 1).to_list(200)
        phase_by_id = {p["id"]: {"id": p["id"], "name": p["name"],
                                   "sort_order": p.get("sort_order", 0),
                                   "revenue": 0.0, "cogs": 0.0,
                                   "expenses": 0.0} for p in phases}
        UNPHASED = "_unphased_"
        phase_by_id[UNPHASED] = {"id": None, "name": "Unphased",
                                   "sort_order": 10_000,
                                   "revenue": 0.0, "cogs": 0.0,
                                   "expenses": 0.0}

        def _bucket(aid: str, amt: float, phase_id: str | None):
            """Add signed amount `amt` (debit-positive) to the phase
            bucket for the account type. Revenue is flipped (credit-
            normal) so it reads positive on the report."""
            acct = accts_by_id.get(aid)
            if not acct:
                return
            key = phase_id if (phase_id and phase_id in phase_by_id) else UNPHASED
            bucket = phase_by_id[key]
            t = (acct.get("type") or "").lower()
            if t in ("revenue", "income"):
                bucket["revenue"] += -amt
            elif t == "cogs":
                bucket["cogs"] += amt
            elif t == "expense":
                bucket["expenses"] += amt

        # Native transactions layer.
        async for t in db.transactions.find(
            {"company_id": cid, "project_id": project_id, "posted": True,
             "date": {"$gte": s, "$lte": e}},
            {"category_account_id": 1, "bank_account_id": 1,
             "amount": 1, "phase_id": 1},
        ):
            amt = float(t.get("amount") or 0)
            # Category side = -amount (debit for negative-amount
            # spend, matching the txn walker in `_signed_balances`).
            if t.get("category_account_id"):
                _bucket(t["category_account_id"], -amt, t.get("phase_id"))
            if t.get("bank_account_id"):
                _bucket(t["bank_account_id"], amt, t.get("phase_id"))

        # Journal-entry lines.
        async for j in db.journal_entries.find(
            {"company_id": cid, "date": {"$gte": s, "$lte": e},
             "lines.project_id": project_id},
            {"lines": 1},
        ):
            for ln in (j.get("lines") or []):
                if ln.get("project_id") != project_id:
                    continue
                aid = ln.get("account_id")
                d = float(ln.get("debit", 0) or 0)
                c = float(ln.get("credit", 0) or 0)
                if aid:
                    _bucket(aid, d - c, ln.get("phase_id"))

        # Emit per-phase rows sorted by `sort_order` — Unphased last.
        phase_rows = sorted(phase_by_id.values(),
                             key=lambda x: x["sort_order"])
        # Drop Unphased row when everything is 0 (keeps drawer tidy).
        phase_rows = [r for r in phase_rows
                       if r["id"] is not None
                       or (r["revenue"] or r["cogs"] or r["expenses"])]
        for r in phase_rows:
            r["revenue"]  = round(r["revenue"], 2)
            r["cogs"]     = round(r["cogs"], 2)
            r["expenses"] = round(r["expenses"], 2)
            r["net_income"] = round(r["revenue"] - r["cogs"] - r["expenses"], 2)
        result["by_phase"] = phase_rows

    return result


@router.get("/companies/{cid}/projects/{project_id}/documents")
async def project_documents(
    cid: str, project_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """List every doc (estimate / invoice / bill / receipt) linked to
    this project. Powers the "Documents" tab on the ProjectDetail
    page — a one-stop view of everything the PM has billed, quoted,
    or committed against this job.

    Returns per-doc: id, kind, number, date, contact_name, total,
    balance_due, status. Client can filter/sort as needed.
    """
    await require_company(user, cid)
    project = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")

    docs: list[dict] = []
    for kind, coll, date_field in (
        ("estimate", "estimates", "issue_date"),
        ("invoice",  "invoices",  "issue_date"),
        ("bill",     "bills",     "issue_date"),
        ("receipt",  "receipts",  "issue_date"),
    ):
        cursor = db[coll].find(
            {"company_id": cid, "project_id": project_id},
            {"_id": 0, "id": 1, "number": 1, "contact_name": 1,
             "total": 1, "balance_due": 1, "status": 1,
             date_field: 1, "phase_id": 1},
        ).sort(date_field, -1)
        async for d in cursor:
            docs.append({
                "id": d.get("id"),
                "kind": kind,
                "number": d.get("number"),
                "date": d.get(date_field),
                "contact_name": d.get("contact_name"),
                "total": float(d.get("total") or 0),
                "balance_due": float(d.get("balance_due") or 0),
                "status": d.get("status"),
                "phase_id": d.get("phase_id"),
            })
    docs.sort(key=lambda x: (x["date"] or "", x["kind"]), reverse=True)
    return {"documents": docs, "count": len(docs)}


@router.get("/companies/{cid}/reports/estimates-vs-actuals")
async def estimates_vs_actuals(
    cid: str,
    include_completed: int = Query(1),
    user: dict = Depends(get_current_user),
) -> dict:
    """Per-project rollup of commitment vs paid vs remaining, sourced
    from the project-linked invoices and bills.

    For each project:

        Revenue side (customer-facing):
            estimated       : projects.estimated_revenue (nullable)
            invoiced        : Σ invoices.total  WHERE project_id = p.id
            received        : invoiced - AR_outstanding
                              (uses invoices.balance_due for open AR)
            remaining_est   : max(estimated - invoiced, 0)
            ar_outstanding  : Σ invoices.balance_due
            invoice_count   : COUNT(invoices)

        Cost side (vendor-facing):
            committed       : Σ bills.total  WHERE project_id = p.id
            paid_to_vendors : committed - AP_outstanding
            ap_outstanding  : Σ bills.balance_due
            bill_count      : COUNT(bills)

    Also returns a totals row and each project's contact name so the
    PM view doesn't need a second call.

    NOTE: All numbers come from stored `total` / `balance_due` fields
    on the invoice/bill docs, which are kept in sync by the posting
    engine — so the rollup matches whatever the individual invoice
    and bill pages show. No signed-balance query needed.
    """
    await require_company(user, cid)

    q: dict[str, Any] = {"company_id": cid}
    if not include_completed:
        # Hide finished / cancelled by default when caller passes 0.
        q["status"] = {"$nin": ["completed", "cancelled"]}
    else:
        q["status"] = {"$ne": "cancelled"}
    projects = await db.projects.find(q).sort("name", 1).to_list(2000)

    # Bulk-fetch invoices / bills for these projects in one query
    # each — cheaper than N round-trips.
    proj_ids = [p["id"] for p in projects]
    inv_rows = await db.invoices.find(
        {"company_id": cid, "project_id": {"$in": proj_ids}},
        {"project_id": 1, "total": 1, "balance_due": 1},
    ).to_list(50000)
    bill_rows = await db.bills.find(
        {"company_id": cid, "project_id": {"$in": proj_ids}},
        {"project_id": 1, "total": 1, "balance_due": 1},
    ).to_list(50000)

    inv_by = defaultdict(lambda: {"count": 0, "total": 0.0, "balance": 0.0})
    for r in inv_rows:
        b = inv_by[r["project_id"]]
        b["count"] += 1
        b["total"]   += float(r.get("total") or 0)
        b["balance"] += float(r.get("balance_due") or 0)
    bill_by = defaultdict(lambda: {"count": 0, "total": 0.0, "balance": 0.0})
    for r in bill_rows:
        b = bill_by[r["project_id"]]
        b["count"] += 1
        b["total"]   += float(r.get("total") or 0)
        b["balance"] += float(r.get("balance_due") or 0)

    rows: list[dict] = []
    totals = {
        "estimated": 0.0, "invoiced": 0.0, "received": 0.0,
        "remaining_est": 0.0, "ar_outstanding": 0.0,
        "committed": 0.0, "paid_to_vendors": 0.0, "ap_outstanding": 0.0,
    }
    for p in projects:
        pid = p["id"]
        inv = inv_by.get(pid, {"count": 0, "total": 0.0, "balance": 0.0})
        bl  = bill_by.get(pid, {"count": 0, "total": 0.0, "balance": 0.0})
        est = float(p.get("estimated_revenue") or 0)
        invoiced = round(inv["total"], 2)
        ar_out   = round(inv["balance"], 2)
        received = round(invoiced - ar_out, 2)
        remaining_est = round(max(est - invoiced, 0.0), 2)
        committed = round(bl["total"], 2)
        ap_out    = round(bl["balance"], 2)
        paid_v    = round(committed - ap_out, 2)
        row = {
            "id": pid,
            "name": p.get("name"),
            "status": p.get("status"),
            "contact_id": p.get("contact_id"),
            "contact_name": p.get("contact_name"),
            "estimated": est,
            "invoiced": invoiced,
            "received": received,
            "remaining_est": remaining_est,
            "ar_outstanding": ar_out,
            "invoice_count": inv["count"],
            "committed": committed,
            "paid_to_vendors": paid_v,
            "ap_outstanding": ap_out,
            "bill_count": bl["count"],
            # Convenience metrics.
            "pct_billed": (round((invoiced / est) * 100, 1)
                            if est > 0 else None),
            "pct_collected": (round((received / invoiced) * 100, 1)
                                if invoiced > 0 else None),
            # Net position = money in - money out (received - paid).
            "net_cash": round(received - paid_v, 2),
        }
        rows.append(row)
        for k in totals:
            totals[k] += row[k]

    for k in totals:
        totals[k] = round(totals[k], 2)
    return {"projects": rows, "totals": totals, "project_count": len(rows)}
