"""Audit trail read API.

All write paths hook into `audit.log_event()` directly; this file
exposes the read side used by the /audit-log page and any per-record
timeline widget.

Permission model (implemented in `audit.list_events`):
  * regular users: only their own actions
  * cpas / pros / accountants / superadmins: all events within
    companies they can access (superadmins see everything)
"""
import csv
import io
import json
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

import audit
from auth import require_role, get_current_user
from db import db

router = APIRouter(prefix="/api")


# ---------- CSV helper ---------------------------------------------------

def _events_to_csv(events: list[dict]) -> bytes:
    """Serialize a list of hydrated audit events into a CSV blob for
    download. Columns match what a compliance officer needs at a
    glance — timestamp, event type, actor identity, entity target,
    IP, summary, and a serialized diff (kept as JSON in one cell so
    the row count stays 1-per-event). before/after snapshots are
    omitted from the CSV to keep it spreadsheet-friendly; anyone who
    needs the full JSON can hit the API directly."""
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    w.writerow([
        "timestamp", "event_type", "actor_email", "actor_role",
        "is_impersonation", "impersonator_email",
        "company_id", "entity_type", "entity_id",
        "ip_address", "user_agent", "summary",
        "diff_field_count", "diff_json",
    ])
    for e in events:
        diff = e.get("diff") or {}
        # Strip noise fields from the diff before serializing so the
        # CSV cell stays readable — _id and updated_at change on every
        # write and just clutter the audit row.
        diff = {k: v for k, v in diff.items() if k not in ("_id", "updated_at")}
        w.writerow([
            e.get("timestamp") or "",
            e.get("event_type") or "",
            e.get("actor_email") or "",
            e.get("actor_role") or "",
            "yes" if e.get("is_impersonation") else "",
            e.get("impersonator_email") or "",
            e.get("company_id") or "",
            e.get("entity_type") or "",
            e.get("entity_id") or "",
            e.get("ip_address") or "",
            e.get("user_agent") or "",
            e.get("summary") or "",
            len(diff),
            json.dumps(diff, default=str, separators=(",", ":")) if diff else "",
        ])
    return buf.getvalue().encode("utf-8")


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


# ---------- CSV export (compliance) -------------------------------------

@router.get("/companies/{cid}/audit.csv")
async def export_company_audit_csv(
    cid: str,
    request: Request,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    event_type: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    only_mine: bool = False,
    # Hard cap higher than the paged list — compliance officers usually
    # want the whole trail for a period, not a first-page sample. 50k
    # rows ≈ 10-20 MB CSV, which spreadsheet apps handle fine.
    limit: int = Query(50000, le=200000),
    user: dict = Depends(get_current_user),
):
    """Download an audit CSV for the current company, honoring the same
    filters as the list view. Meta-audit: this download itself lands
    in `audit_events` as an `export` kind so a downstream reviewer can
    see who pulled the trail and when."""
    events = await audit.list_events(
        user=user, company_id=cid,
        entity_type=entity_type, entity_id=entity_id, event_type=event_type,
        actor_user_id=actor_user_id, since=since, until=until,
        only_mine=only_mine, limit=limit, skip=0,
    )
    csv_bytes = _events_to_csv(events)
    filename = f"audit-{cid}-{date.today().isoformat()}.csv"
    # Meta-audit: the compliance officer pulling the trail is themselves
    # audited. `entity_type=audit_export` keeps this event distinct from
    # ordinary report exports.
    try:
        audit.log_export(
            kind="audit-log",
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid, file_format="csv",
            entity_type="audit_export", entity_id="audit-log",
            filename=filename,
            metadata={
                "row_count": len(events),
                "filters": {
                    "entity_type": entity_type, "entity_id": entity_id,
                    "event_type": event_type, "actor_user_id": actor_user_id,
                    "since": since, "until": until, "only_mine": only_mine,
                },
            },
            request=request,
            summary=f"Exported audit log ({len(events)} rows)",
        )
    except Exception:  # noqa: BLE001
        pass
    return Response(
        content=csv_bytes, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/audit/me.csv")
async def export_my_audit_csv(
    request: Request,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(50000, le=200000),
    user: dict = Depends(get_current_user),
):
    """Personal audit CSV — every user can pull their own activity
    (matches the "everyone sees their own actions" rule)."""
    events = await audit.list_events(
        user=user, only_mine=True, since=since, until=until, limit=limit,
    )
    csv_bytes = _events_to_csv(events)
    filename = f"my-audit-{date.today().isoformat()}.csv"
    try:
        audit.log_export(
            kind="my-audit-log",
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=None, file_format="csv",
            entity_type="audit_export", entity_id="my-audit-log",
            filename=filename,
            metadata={"row_count": len(events), "since": since, "until": until},
            request=request,
            summary=f"Exported my audit log ({len(events)} rows)",
        )
    except Exception:  # noqa: BLE001
        pass
    return Response(
        content=csv_bytes, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
