"""Audit trail read API.

All write paths hook into `audit.log_event()` directly; this file
exposes the read side used by the /audit-log page and any per-record
timeline widget.

Permission model (implemented in `audit.list_events`):
  * regular users: only their own actions
  * cpas / pros / accountants / superadmins: all events within
    companies they can access (superadmins see everything)
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

import audit
from auth import require_role, get_current_user
from db import db

router = APIRouter(prefix="/api")


# ---------- Company-scoped audit timeline -------------------------------

@router.get("/companies/{cid}/audit")
async def list_company_audit(
    cid: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    event_type: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    only_mine: bool = False,
    limit: int = Query(100, le=500),
    skip: int = 0,
    user: dict = Depends(get_current_user),
):
    """Company-scoped audit list. The audit service enforces
    per-company access checks — a regular user querying a company they
    don't belong to will just get an empty page rather than a 403,
    which matches the rest of the platform's read-through model."""
    events = await audit.list_events(
        user=user, company_id=cid,
        entity_type=entity_type, entity_id=entity_id, event_type=event_type,
        actor_user_id=actor_user_id, since=since, until=until,
        only_mine=only_mine, limit=limit, skip=skip,
    )
    total = await audit.count_events(
        user=user, company_id=cid,
        entity_type=entity_type, entity_id=entity_id, event_type=event_type,
        actor_user_id=actor_user_id, since=since, until=until,
        only_mine=only_mine,
    )
    return {"events": events, "total": total, "limit": limit, "skip": skip}


# ---------- Per-entity timeline (e.g. Invoice #INV-042 history) ---------

@router.get("/audit/entity/{entity_type}/{entity_id}")
async def entity_timeline(
    entity_type: str,
    entity_id: str,
    limit: int = Query(200, le=500),
    user: dict = Depends(get_current_user),
):
    """History of one specific record — plugged into the record editor
    pages (Invoice/Bill/Transaction/etc.) via the `<AuditTimeline/>`
    component."""
    events = await audit.list_events(
        user=user, entity_type=entity_type, entity_id=entity_id, limit=limit,
    )
    return {"events": events, "entity_type": entity_type, "entity_id": entity_id}


# ---------- "My actions" across every accessible company ---------------

@router.get("/audit/me")
async def my_audit(
    limit: int = Query(200, le=500),
    skip: int = 0,
    since: Optional[str] = None,
    until: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    events = await audit.list_events(
        user=user, only_mine=True, limit=limit, skip=skip,
        since=since, until=until,
    )
    total = await audit.count_events(user=user, only_mine=True, since=since, until=until)
    return {"events": events, "total": total, "limit": limit, "skip": skip}


# ---------- Global (superadmin only) ------------------------------------

@router.get("/admin/audit")
async def global_audit(
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    event_type: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    company_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(200, le=500),
    skip: int = 0,
    user: dict = Depends(require_role("superadmin")),
):
    events = await audit.list_events(
        user=user, company_id=company_id,
        entity_type=entity_type, entity_id=entity_id, event_type=event_type,
        actor_user_id=actor_user_id, since=since, until=until,
        limit=limit, skip=skip,
    )
    total = await audit.count_events(
        user=user, company_id=company_id,
        entity_type=entity_type, entity_id=entity_id, event_type=event_type,
        actor_user_id=actor_user_id, since=since, until=until,
    )
    return {"events": events, "total": total, "limit": limit, "skip": skip}
