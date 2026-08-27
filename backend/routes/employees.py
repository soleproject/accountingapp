"""Employees — Team foundation (Feb 2026, Phase B-1).

An employee is a person who works for the company. They may or may
not have a user login — some contractors / subs are records only.
When linked to a user (via `user_id`), the role determines their
default product access.

Schema:
    employees:
        id, company_id, user_id (nullable),
        name, email, phone,
        role ("owner" | "manager" | "bookkeeper" | "field_employee"),
        department (free text — "Field", "Office", "Admin"),
        title (free text — "Foreman", "Sales rep"),
        hourly_cost_rate (float, nullable — for job costing later),
        active (bool, default true),
        notes (free text),
        permission_overrides (dict, nullable — { product_key: bool })
        created_at, updated_at

Route prefix: /api/companies/{cid}/employees
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_ROLES = ("owner", "manager", "bookkeeper", "field_employee")

# Default product access by role. Owners see everything; managers see
# accounting + projects + team + crm but not the firm-level pages;
# bookkeepers see accounting only; field employees see projects + team
# but not accounting. Frontends read these + apply per-employee overrides.
ROLE_DEFAULTS = {
    "owner":          {"accounting": True,  "crm": True,  "team": True,  "projects": True},
    "manager":        {"accounting": True,  "crm": True,  "team": True,  "projects": True},
    "bookkeeper":     {"accounting": True,  "crm": False, "team": False, "projects": False},
    "field_employee": {"accounting": False, "crm": False, "team": True,  "projects": True},
}


def _clean(doc: dict) -> dict:
    if doc:
        doc.pop("_id", None)
    return doc


def _validate_role(r: Optional[str]) -> str:
    r = (r or "field_employee").lower()
    if r not in _ROLES:
        raise HTTPException(400, f"role must be one of {list(_ROLES)}")
    return r


@router.get("/companies/{cid}/employees")
async def list_employees(
    cid: str,
    include_inactive: bool = False,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    if not include_inactive:
        q["active"] = {"$ne": False}
    rows = await db.employees.find(q).sort("name", 1).to_list(500)
    return {"employees": [_clean(r) for r in rows], "count": len(rows)}


@router.post("/companies/{cid}/employees")
async def create_employee(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Employee name is required")
    email = (payload.get("email") or "").strip().lower() or None
    role = _validate_role(payload.get("role"))

    # Uniqueness by email within a company (only when email is set).
    if email:
        dup = await db.employees.find_one(
            {"company_id": cid, "email": email})
        if dup:
            raise HTTPException(409, f"An employee with email {email} already exists")

    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "user_id": payload.get("user_id") or None,
        "name": name,
        "email": email,
        "phone": (payload.get("phone") or "").strip() or None,
        "role": role,
        "department": (payload.get("department") or "").strip() or None,
        "title": (payload.get("title") or "").strip() or None,
        "hourly_cost_rate": (float(payload["hourly_cost_rate"])
                               if payload.get("hourly_cost_rate") not in (None, "")
                               else None),
        "active": bool(payload.get("active", True)),
        "notes": (payload.get("notes") or "").strip(),
        "permission_overrides": payload.get("permission_overrides") or {},
        "created_at": now,
        "updated_at": now,
    }
    await db.employees.insert_one(doc)
    return {"ok": True, "employee": _clean(dict(doc))}


@router.get("/companies/{cid}/employees/{eid}")
async def get_employee(
    cid: str, eid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.employees.find_one({"company_id": cid, "id": eid})
    if not doc:
        raise HTTPException(404, "Employee not found")
    return {"employee": _clean(doc)}


@router.patch("/companies/{cid}/employees/{eid}")
async def update_employee(
    cid: str, eid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.employees.find_one({"company_id": cid, "id": eid})
    if not doc:
        raise HTTPException(404, "Employee not found")

    update: dict = {}
    if "name" in payload:
        v = (payload["name"] or "").strip()
        if not v:
            raise HTTPException(400, "Name cannot be empty")
        update["name"] = v
    if "email" in payload:
        v = (payload["email"] or "").strip().lower() or None
        if v and v != doc.get("email"):
            dup = await db.employees.find_one({
                "company_id": cid, "email": v, "id": {"$ne": eid}})
            if dup:
                raise HTTPException(409, f"Another employee already uses {v}")
        update["email"] = v
    if "role" in payload:
        update["role"] = _validate_role(payload["role"])
    for f in ("phone", "department", "title", "notes"):
        if f in payload:
            v = payload[f]
            update[f] = (v.strip() if isinstance(v, str) else v) or None
    if "hourly_cost_rate" in payload:
        v = payload["hourly_cost_rate"]
        update["hourly_cost_rate"] = float(v) if v not in (None, "") else None
    if "active" in payload:
        update["active"] = bool(payload["active"])
    if "permission_overrides" in payload:
        po = payload["permission_overrides"]
        if not isinstance(po, dict):
            raise HTTPException(400, "permission_overrides must be an object")
        # Whitelist to known product keys so junk keys never propagate
        # into the effective-permissions computation. Values must be bools.
        known = {"accounting", "crm", "team", "projects"}
        update["permission_overrides"] = {
            k: bool(v) for k, v in po.items() if k in known
        }
    if "user_id" in payload:
        update["user_id"] = payload["user_id"] or None
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.employees.update_one(
        {"company_id": cid, "id": eid}, {"$set": update})
    fresh = await db.employees.find_one({"company_id": cid, "id": eid})
    return {"ok": True, "employee": _clean(fresh)}


@router.delete("/companies/{cid}/employees/{eid}")
async def delete_employee(
    cid: str, eid: str, hard: bool = False,
    user: dict = Depends(get_current_user),
) -> dict:
    """Soft-delete by default (marks inactive). Hard-delete drops the
    row only when there are no downstream references (tasks assigned,
    transactions tagged, etc.)."""
    await require_company(user, cid)
    doc = await db.employees.find_one({"company_id": cid, "id": eid})
    if not doc:
        raise HTTPException(404, "Employee not found")
    if not hard:
        await db.employees.update_one(
            {"company_id": cid, "id": eid},
            {"$set": {"active": False, "updated_at": now_iso()}})
        return {"ok": True, "archived": True}
    # Hard-delete blocked if referenced by any task or transaction.
    # Only run the assigned-tasks check when the employee is linked to a
    # user — otherwise assignee_user_id=None would falsely match every
    # unassigned task in the company.
    if doc.get("user_id"):
        task_ref = await db.tasks.find_one({
            "company_id": cid, "assignee_user_id": doc["user_id"]})
        if task_ref:
            raise HTTPException(400, "Cannot hard-delete: employee has assigned tasks")
    await db.employees.delete_one({"company_id": cid, "id": eid})
    return {"ok": True, "deleted": True}


@router.get("/companies/{cid}/employees/{eid}/permissions")
async def get_effective_permissions(
    cid: str, eid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Compute effective product access: role defaults ∪ overrides."""
    await require_company(user, cid)
    doc = await db.employees.find_one({"company_id": cid, "id": eid})
    if not doc:
        raise HTTPException(404, "Employee not found")
    role = doc.get("role", "field_employee")
    defaults = dict(ROLE_DEFAULTS.get(role, {}))
    overrides = doc.get("permission_overrides") or {}
    effective = {**defaults, **overrides}
    return {
        "employee_id": eid, "role": role,
        "role_defaults": defaults,
        "overrides": overrides,
        "effective": effective,
    }
