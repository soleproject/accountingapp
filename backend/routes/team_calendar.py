"""Team calendar — aggregated task/phase/time overlay
(Feb 2026, Phase B-3 follow-up).

Returns everything that a manager needs to see on a calendar in
ONE payload, for the requested date window:

  * tasks       — company tasks with a due_date inside the window
  * phases      — project phases whose [start_date, end_date] range
                  overlaps the window (either bound counts)
  * time_entries — time entries logged in the window
  * employees   — the roster used to populate the filter dropdown

An optional `employee_id` filter narrows tasks (via
assignee_user_id → employee.user_id lookup) and time entries (via
employee_id). Phases stay unfiltered because they're project-scoped,
not person-scoped.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db
from deps import require_company

router = APIRouter(prefix="/api")

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


def _validate_date(s: str, field: str) -> str:
    if not s or not _DATE_RE.match(s):
        raise HTTPException(400, f"{field} must be YYYY-MM-DD")
    return s


@router.get("/companies/{cid}/team-calendar")
async def team_calendar(
    cid: str,
    date_from: str = Query(...),
    date_to: str = Query(...),
    employee_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    df = _validate_date(date_from, "date_from")
    dt = _validate_date(date_to, "date_to")
    if df > dt:
        raise HTTPException(400, "date_from must be ≤ date_to")

    # Roster (used by the filter dropdown; always returned in full).
    employees = await db.employees.find(
        {"company_id": cid, "active": {"$ne": False}}
    ).sort("name", 1).to_list(500)

    # If an employee filter is passed, resolve their user_id so we
    # can narrow tasks by assignee_user_id.
    filter_user_id: Optional[str] = None
    if employee_id:
        emp = next((e for e in employees if e.get("id") == employee_id), None)
        if not emp:
            # Fall through: unknown employee → empty result set later.
            filter_user_id = "__none__"
        else:
            filter_user_id = emp.get("user_id") or "__none__"

    # -- Tasks: due_date in window --
    task_q: dict = {
        "company_id": cid,
        "due_date": {"$gte": df, "$lte": dt, "$ne": None},
    }
    if filter_user_id:
        task_q["assignee_user_id"] = filter_user_id
    tasks = await db.tasks.find(task_q).sort("due_date", 1).to_list(500)

    # -- Phases: [start, end] overlaps [df, dt] --
    # A phase overlaps if start_date ≤ dt AND end_date ≥ df.
    # Phases with only one bound still count if that bound falls inside.
    phase_q: dict = {
        "company_id": cid,
        "$or": [
            {"start_date": {"$lte": dt, "$ne": None},
             "end_date":   {"$gte": df, "$ne": None}},
            {"start_date": {"$gte": df, "$lte": dt}},
            {"end_date":   {"$gte": df, "$lte": dt}},
        ],
    }
    phases_raw = await db.phases.find(phase_q).sort("start_date", 1).to_list(500)
    # Denormalize project_name for fast rendering.
    project_ids = {p.get("project_id") for p in phases_raw if p.get("project_id")}
    projects_by_id: dict = {}
    if project_ids:
        rows = await db.projects.find(
            {"company_id": cid, "id": {"$in": list(project_ids)}}
        ).to_list(500)
        projects_by_id = {r["id"]: r for r in rows}
    phases = []
    for p in phases_raw:
        proj = projects_by_id.get(p.get("project_id"))
        phases.append({
            **_clean(p),
            "project_name": proj.get("name") if proj else None,
        })

    # -- Time entries: date in window --
    te_q: dict = {"company_id": cid, "date": {"$gte": df, "$lte": dt}}
    if employee_id:
        te_q["employee_id"] = employee_id
    time_entries = await db.time_entries.find(te_q).sort("date", 1).to_list(1000)

    return {
        "date_from": df,
        "date_to": dt,
        "employees": [_clean(e) for e in employees],
        "tasks": [_clean(t) for t in tasks],
        "phases": phases,
        "time_entries": [_clean(t) for t in time_entries],
        "counts": {
            "tasks": len(tasks),
            "phases": len(phases),
            "time_entries": len(time_entries),
        },
    }
