"""Time entries — labor logging + soft roll-up into project cost
(Feb 2026, Phase B-3).

A time entry captures hours worked by an employee against a project
(and optionally a specific phase or task) on a given date. Labor
cost = hours × cost_rate_snapshot; the snapshot is captured at write
time so future rate changes never retro-affect historical entries.

Roll-ups are **virtual only** for MVP: no GL journal entry is
created. Project P&L dashboards read the roll-up endpoint on demand.

Schema:
    time_entries:
        id, company_id,
        employee_id (required),
        employee_name (denorm — for fast list rendering),
        project_id (required),
        project_name (denorm),
        phase_id (nullable),
        phase_name (denorm, nullable),
        task_id (nullable),
        date ("YYYY-MM-DD"),
        hours (float — decimal, e.g. 1.5),
        notes (str),
        billable (bool, default true),
        cost_rate_snapshot (float — captured from employee.hourly_cost_rate),
        created_by_user_id,
        created_at, updated_at

Route prefix: /api/companies/{cid}/time-entries
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

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_STATUSES = {"approved", "submitted", "rejected"}
_MANAGER_ROLES = {"owner", "manager", "admin", "superadmin", "pro"}


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


def _validate_date(s: Optional[str], field: str = "date") -> str:
    if not s or not _DATE_RE.match(s):
        raise HTTPException(400, f"{field} must be YYYY-MM-DD")
    return s


def _validate_hours(h) -> float:
    try:
        v = float(h)
    except (TypeError, ValueError):
        raise HTTPException(400, "hours must be a number")
    if v <= 0 or v > 24:
        raise HTTPException(400, "hours must be > 0 and ≤ 24")
    return round(v, 2)


async def _load_employee_or_400(cid: str, employee_id: str) -> dict:
    if not employee_id:
        raise HTTPException(400, "employee_id is required")
    emp = await db.employees.find_one({"company_id": cid, "id": employee_id})
    if not emp:
        raise HTTPException(400, f"Employee {employee_id} not found in this company")
    return emp


async def _load_project_or_400(cid: str, project_id: str) -> dict:
    if not project_id:
        raise HTTPException(400, "project_id is required")
    proj = await db.projects.find_one({"company_id": cid, "id": project_id})
    if not proj:
        raise HTTPException(400, f"Project {project_id} not found in this company")
    return proj


async def _load_phase(cid: str, phase_id: Optional[str]) -> Optional[dict]:
    if not phase_id:
        return None
    ph = await db.phases.find_one({"company_id": cid, "id": phase_id})
    if not ph:
        raise HTTPException(400, f"Phase {phase_id} not found in this company")
    return ph


@router.get("/companies/{cid}/time-entries")
async def list_time_entries(
    cid: str,
    employee_id: Optional[str] = None,
    project_id: Optional[str] = None,
    phase_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    billable: Optional[bool] = None,
    status: Optional[str] = None,
    limit: int = Query(500, le=2000),
    user: dict = Depends(get_current_user),
) -> dict:
    """List time entries with common filters. Newest first."""
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    if employee_id:
        q["employee_id"] = employee_id
    if project_id:
        q["project_id"] = project_id
    if phase_id:
        q["phase_id"] = phase_id
    if billable is not None:
        q["billable"] = bool(billable)
    if status:
        if status not in _STATUSES:
            raise HTTPException(400, f"status must be one of {sorted(_STATUSES)}")
        q["status"] = status
    if date_from or date_to:
        d: dict = {}
        if date_from:
            d["$gte"] = _validate_date(date_from, "date_from")
        if date_to:
            d["$lte"] = _validate_date(date_to, "date_to")
        q["date"] = d
    rows = await db.time_entries.find(q).sort([
        ("date", -1), ("created_at", -1)]).to_list(limit)
    rows = [_clean(r) for r in rows]
    total_hours = round(sum(r.get("hours") or 0 for r in rows), 2)
    total_cost = round(sum(
        (r.get("hours") or 0) * (r.get("cost_rate_snapshot") or 0)
        for r in rows), 2)
    return {
        "time_entries": rows,
        "count": len(rows),
        "total_hours": total_hours,
        "total_cost": total_cost,
    }


@router.post("/companies/{cid}/time-entries")
async def create_time_entry(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    emp = await _load_employee_or_400(cid, payload.get("employee_id"))
    proj = await _load_project_or_400(cid, payload.get("project_id"))
    phase = await _load_phase(cid, payload.get("phase_id"))
    date = _validate_date(payload.get("date"))
    hours = _validate_hours(payload.get("hours"))
    billable = bool(payload.get("billable", True))
    # Snapshot the employee's cost rate at write time. If missing, 0.
    rate = emp.get("hourly_cost_rate")
    rate = float(rate) if rate not in (None, "") else 0.0

    now = now_iso()
    # Approval status. Default is "approved" so the no-approval mode
    # from Phase B-3 keeps working unchanged — callers can pass
    # status="submitted" (via a "Save as draft" toggle) to route the
    # entry through the manager approval queue instead.
    status = (payload.get("status") or "approved").lower()
    if status not in _STATUSES:
        raise HTTPException(400, f"status must be one of {sorted(_STATUSES)}")
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "employee_id": emp["id"],
        "employee_name": emp.get("name") or "",
        "project_id": proj["id"],
        "project_name": proj.get("name") or "",
        "phase_id": phase["id"] if phase else None,
        "phase_name": (phase.get("name") if phase else None),
        "task_id": payload.get("task_id") or None,
        "date": date,
        "hours": hours,
        "notes": (payload.get("notes") or "").strip(),
        "billable": billable,
        "cost_rate_snapshot": rate,
        "status": status,
        "approval_history": [{
            "at": now, "by_user_id": user["id"], "action": (
                "created_submitted" if status == "submitted"
                else "created_approved"),
        }],
        "created_by_user_id": user["id"],
        "created_at": now,
        "updated_at": now,
    }
    await db.time_entries.insert_one(doc)
    return {"ok": True, "time_entry": _clean(dict(doc))}


@router.patch("/companies/{cid}/time-entries/{tid}")
async def update_time_entry(
    cid: str, tid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.time_entries.find_one({"company_id": cid, "id": tid})
    if not doc:
        raise HTTPException(404, "Time entry not found")

    update: dict = {}
    if "date" in payload:
        update["date"] = _validate_date(payload["date"])
    if "hours" in payload:
        update["hours"] = _validate_hours(payload["hours"])
    if "notes" in payload:
        update["notes"] = (payload["notes"] or "").strip()
    if "billable" in payload:
        update["billable"] = bool(payload["billable"])
    # project_id change resets phase — process it BEFORE phase_id so a
    # mixed payload doesn't waste a phase lookup that would be nulled.
    project_changed = (
        "project_id" in payload
        and payload["project_id"] != doc.get("project_id"))
    if project_changed:
        proj = await _load_project_or_400(cid, payload["project_id"])
        update["project_id"] = proj["id"]
        update["project_name"] = proj.get("name") or ""
        update["phase_id"] = None
        update["phase_name"] = None
    if "phase_id" in payload and not project_changed:
        ph = await _load_phase(cid, payload["phase_id"])
        update["phase_id"] = ph["id"] if ph else None
        update["phase_name"] = ph.get("name") if ph else None
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.time_entries.update_one(
        {"company_id": cid, "id": tid}, {"$set": update})
    fresh = await db.time_entries.find_one({"company_id": cid, "id": tid})
    return {"ok": True, "time_entry": _clean(fresh)}


@router.delete("/companies/{cid}/time-entries/{tid}")
async def delete_time_entry(
    cid: str, tid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    r = await db.time_entries.delete_one({"company_id": cid, "id": tid})
    if r.deleted_count == 0:
        raise HTTPException(404, "Time entry not found")
    return {"ok": True, "deleted": True}


@router.get("/companies/{cid}/time-entries/rollup")
async def rollup(
    cid: str,
    project_id: str = Query(...),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """Aggregate hours + labor cost by phase for a single project.

    Returns:
        {
            project_id, project_name,
            totals: {hours, cost, entries, billable_hours, billable_cost},
            by_phase: [
                {phase_id, phase_name, hours, cost, entries,
                 billable_hours, billable_cost},
                ...
            ],
            by_employee: [
                {employee_id, employee_name, hours, cost, entries},
                ...
            ]
        }
    """
    await require_company(user, cid)
    proj = await _load_project_or_400(cid, project_id)
    q: dict = {"company_id": cid, "project_id": project_id}
    # Rollups drive Project P&L labor cost — only count APPROVED entries
    # (default status). Submitted/rejected are excluded so a rejected
    # entry never inflates project cost.
    q["status"] = "approved"
    if date_from or date_to:
        d: dict = {}
        if date_from:
            d["$gte"] = _validate_date(date_from, "date_from")
        if date_to:
            d["$lte"] = _validate_date(date_to, "date_to")
        q["date"] = d
    rows = await db.time_entries.find(q).to_list(5000)

    def _key_phase(r):
        return (r.get("phase_id") or "__unassigned__", r.get("phase_name") or "Unassigned")

    def _key_emp(r):
        return (r.get("employee_id"), r.get("employee_name") or "")

    by_phase: dict = {}
    by_emp: dict = {}
    totals = {"hours": 0.0, "cost": 0.0, "entries": 0,
              "billable_hours": 0.0, "billable_cost": 0.0}
    for r in rows:
        h = float(r.get("hours") or 0)
        c = h * float(r.get("cost_rate_snapshot") or 0)
        bill = bool(r.get("billable"))

        pk, pname = _key_phase(r)
        p = by_phase.setdefault(pk, {
            "phase_id": (r.get("phase_id") or None),
            "phase_name": pname,
            "hours": 0.0, "cost": 0.0, "entries": 0,
            "billable_hours": 0.0, "billable_cost": 0.0,
        })
        p["hours"] += h; p["cost"] += c; p["entries"] += 1
        if bill:
            p["billable_hours"] += h; p["billable_cost"] += c

        ek, ename = _key_emp(r)
        if ek:
            e = by_emp.setdefault(ek, {
                "employee_id": ek, "employee_name": ename,
                "hours": 0.0, "cost": 0.0, "entries": 0,
            })
            e["hours"] += h; e["cost"] += c; e["entries"] += 1

        totals["hours"] += h; totals["cost"] += c; totals["entries"] += 1
        if bill:
            totals["billable_hours"] += h; totals["billable_cost"] += c

    def _round_group(g: dict) -> dict:
        for k in ("hours", "cost", "billable_hours", "billable_cost"):
            if k in g:
                g[k] = round(g[k], 2)
        return g

    return {
        "project_id": proj["id"],
        "project_name": proj.get("name") or "",
        "totals": _round_group(dict(totals)),
        "by_phase": sorted(
            (_round_group(v) for v in by_phase.values()),
            key=lambda v: v["phase_name"].lower() if v["phase_name"] else "zzz"),
        "by_employee": sorted(
            (_round_group(v) for v in by_emp.values()),
            key=lambda v: -v["hours"]),
    }


@router.get("/companies/{cid}/time-entries/my-week")
async def my_week(
    cid: str,
    anchor: Optional[str] = Query(None, description="Any date within the week (YYYY-MM-DD). Defaults to today."),
    user: dict = Depends(get_current_user),
) -> dict:
    """Return the current user's time entries in a Monday-anchored
    7-day window. The frontend day-list uses this for the "This week"
    filter chip and the personal /team/time page's summary strip.
    """
    from datetime import date, timedelta
    await require_company(user, cid)
    if anchor:
        _validate_date(anchor, "anchor")
        y, m, d = anchor.split("-")
        anc = date(int(y), int(m), int(d))
    else:
        anc = date.fromisoformat(now_iso()[:10])
    monday = anc - timedelta(days=anc.weekday())
    sunday = monday + timedelta(days=6)
    # Resolve current user's employee row (if any) — /my-week is scoped
    # to the calling user; a Pro or Owner without an employee record
    # simply sees no rows here.
    emp = await db.employees.find_one({
        "company_id": cid, "user_id": user["id"]})
    q: dict = {
        "company_id": cid,
        "date": {"$gte": monday.isoformat(), "$lte": sunday.isoformat()},
    }
    if emp:
        q["employee_id"] = emp["id"]
    else:
        # Fall back to "created by me" so managers can still see the
        # entries they logged for others in this window.
        q["created_by_user_id"] = user["id"]
    rows = await db.time_entries.find(q).sort([("date", 1), ("created_at", 1)]).to_list(500)
    rows = [_clean(r) for r in rows]
    by_day: dict = {}
    for i in range(7):
        d = (monday + timedelta(days=i)).isoformat()
        by_day[d] = {"date": d, "hours": 0.0, "entries": []}
    for r in rows:
        d = r.get("date")
        if d in by_day:
            by_day[d]["hours"] += float(r.get("hours") or 0)
            by_day[d]["entries"].append(r)
    days = [by_day[k] for k in sorted(by_day.keys())]
    for day in days:
        day["hours"] = round(day["hours"], 2)
    total_hours = round(sum(d["hours"] for d in days), 2)
    return {
        "monday": monday.isoformat(),
        "sunday": sunday.isoformat(),
        "employee_id": emp["id"] if emp else None,
        "employee_name": emp.get("name") if emp else None,
        "days": days,
        "total_hours": total_hours,
    }


# ------------------------------------------------------------------
# Timesheet approvals — Draft → Submitted → Approved/Rejected flow
# ------------------------------------------------------------------
async def _require_manager(user: dict, cid: str) -> None:
    """A user is a manager for approval purposes if their app role is
    owner/manager/admin/pro/superadmin, OR they are owner/admin on
    the company's membership, OR their employee record on this
    company has role in {owner, manager}."""
    if user.get("role") in _MANAGER_ROLES:
        return
    mem = await db.memberships.find_one({
        "company_id": cid, "user_id": user["id"]})
    if mem and mem.get("role") in {"owner", "admin", "manager"}:
        return
    emp = await db.employees.find_one({
        "company_id": cid, "user_id": user["id"]})
    if emp and emp.get("role") in {"owner", "manager"}:
        return
    raise HTTPException(403, "Only managers can approve or reject time entries")


async def _set_status(
    cid: str, tid: str, new_status: str, user: dict, note: str = "",
) -> dict:
    doc = await db.time_entries.find_one({"company_id": cid, "id": tid})
    if not doc:
        raise HTTPException(404, "Time entry not found")
    now = now_iso()
    history = list(doc.get("approval_history") or [])
    history.append({
        "at": now, "by_user_id": user["id"],
        "action": new_status, "note": note.strip() if note else "",
    })
    await db.time_entries.update_one(
        {"company_id": cid, "id": tid},
        {"$set": {
            "status": new_status,
            "approval_history": history,
            "updated_at": now,
        }})
    fresh = await db.time_entries.find_one({"company_id": cid, "id": tid})
    return _clean(fresh)


@router.post("/companies/{cid}/time-entries/{tid}/submit")
async def submit_for_approval(
    cid: str, tid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """The logger flips a draft/approved entry into 'submitted' —
    waits for a manager to approve. Anyone with company access can
    submit their own or a teammate's entry."""
    await require_company(user, cid)
    updated = await _set_status(cid, tid, "submitted", user)
    # Notify every company manager that a new report is waiting.
    from routes.notifications import notify
    mgrs = await db.memberships.find({
        "company_id": cid, "role": {"$in": ["owner", "admin", "manager"]},
    }).to_list(50)
    who = user.get("name") or user.get("email") or "Someone"
    mins = int(updated.get("duration_minutes") or 0)
    for m in mgrs:
        if m["user_id"] == user["id"]: continue
        await notify(
            company_id=cid, user_id=m["user_id"],
            kind="timesheet_approval",
            title=f"{who} submitted a timesheet for approval",
            body=f"{mins // 60}h {mins % 60}m · needs your review",
            link="/team/approvals",
            source={"kind": "time_entry", "id": tid},
        )
    return {"ok": True, "time_entry": updated}


@router.post("/companies/{cid}/time-entries/{tid}/approve")
async def approve(
    cid: str, tid: str, payload: dict | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    await _require_manager(user, cid)
    note = (payload or {}).get("note") or ""
    updated = await _set_status(cid, tid, "approved", user, note)
    return {"ok": True, "time_entry": updated}


@router.post("/companies/{cid}/time-entries/{tid}/reject")
async def reject(
    cid: str, tid: str, payload: dict | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    await _require_manager(user, cid)
    note = (payload or {}).get("note") or ""
    updated = await _set_status(cid, tid, "rejected", user, note)
    return {"ok": True, "time_entry": updated}


@router.post("/companies/{cid}/time-entries/bulk-approve")
async def bulk_approve(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Bulk-approve a list of submitted entries in one shot — powers
    the /team/approvals queue's "Approve all" button."""
    await require_company(user, cid)
    await _require_manager(user, cid)
    ids = payload.get("ids") or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "ids must be a non-empty list")
    approved = []
    for tid in ids:
        try:
            updated = await _set_status(cid, tid, "approved", user)
            approved.append(updated["id"])
        except HTTPException:
            continue
    return {"ok": True, "approved": approved, "count": len(approved)}

