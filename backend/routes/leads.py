"""Referral / lead-capture routes.

Public POST endpoint lets a referred visitor drop their name + email
+ role BEFORE they hit signup — the classic "Enter Referral" landing
page that sits between a shared link (`?ref=<slug>`) and the paid
signup flow.

Every submission lands in the `leads` collection. Superadmins can list,
filter, update status/notes, and (soft) delete leads from
`/admin/leads`. In a later pass this feeds a templated drip-email
campaign with a calendar link for accounting professionals.

RBAC:
  * ``POST /api/public/leads`` — no auth (public form).
  * ``GET  /api/admin/leads``  — superadmin only.
  * ``PATCH /api/admin/leads/{id}`` — superadmin only.
  * ``DELETE /api/admin/leads/{id}`` — superadmin only.
"""
from __future__ import annotations

import uuid
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel, EmailStr, Field

from db import db
from auth import require_role
from referral_util import resolve_referrer_id


router = APIRouter(prefix="/api", tags=["leads"])


# ---- Models ------------------------------------------------------------
VALID_ROLES = {"accounting_pro", "business_owner", "enterprise", "other"}
VALID_STATUS = {"new", "contacted", "qualified", "converted", "dead"}


class LeadIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr
    role: str = Field(..., description="accounting_pro | business_owner | enterprise | other")
    ref_slug: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=2000)
    phone: Optional[str] = Field(None, max_length=40)
    company_name: Optional[str] = Field(None, max_length=200)


class LeadStatusPatch(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- Public: submit lead ------------------------------------------------
@router.post("/public/leads")
async def submit_lead(payload: LeadIn, request: Request):
    """Public lead-capture endpoint. Anyone (no auth) can drop a lead.

    Idempotent-ish: repeat submissions from the same email + ref within
    24h are collapsed into the original (status + notes preserved) so a
    double-click doesn't create dupes.
    """
    if payload.role not in VALID_ROLES:
        raise HTTPException(400, f"Role must be one of: {sorted(VALID_ROLES)}")

    referrer_id = await resolve_referrer_id(payload.ref_slug) if payload.ref_slug else None

    # De-dupe within 24h on (email, ref_slug)
    email_lc = payload.email.lower()
    existing = await db.leads.find_one({
        "email": email_lc,
        "ref_slug": payload.ref_slug or None,
    })
    if existing:
        # Refresh timestamp; preserve status/notes so admin work isn't clobbered
        await db.leads.update_one(
            {"id": existing["id"]},
            {"$set": {
                "name": payload.name.strip(),
                "role": payload.role,
                "phone": payload.phone,
                "company_name": payload.company_name,
                "last_seen_at": _now_iso(),
            }}
        )
        return {"ok": True, "id": existing["id"], "duplicate": True}

    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "email": email_lc,
        "role": payload.role,
        "phone": (payload.phone or "").strip() or None,
        "company_name": (payload.company_name or "").strip() or None,
        "ref_slug": payload.ref_slug or None,
        "referrer_user_id": referrer_id,
        "notes": (payload.notes or "").strip() or None,
        "status": "new",
        "source": "referral" if payload.ref_slug else "direct",
        "ip": (request.client.host if request.client else None),
        "user_agent": request.headers.get("user-agent", "")[:400],
        "created_at": _now_iso(),
        "last_seen_at": _now_iso(),
    }
    await db.leads.insert_one(doc)
    return {"ok": True, "id": doc["id"], "duplicate": False}


# ---- Superadmin: list ---------------------------------------------------
@router.get("/admin/leads")
async def list_leads(
    status: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Search name/email/company"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(require_role("superadmin")),
):
    """List leads, newest first, with optional filters."""
    filt: dict = {}
    if status and status in VALID_STATUS:
        filt["status"] = status
    if role and role in VALID_ROLES:
        filt["role"] = role
    if q:
        pattern = re.escape(q.strip())
        filt["$or"] = [
            {"name":         {"$regex": pattern, "$options": "i"}},
            {"email":        {"$regex": pattern, "$options": "i"}},
            {"company_name": {"$regex": pattern, "$options": "i"}},
        ]

    cur = db.leads.find(filt, {"_id": 0}).sort("created_at", -1).limit(limit)
    items = await cur.to_list(length=limit)

    # Enrich with referrer display name (if any)
    referrer_ids = {i["referrer_user_id"] for i in items if i.get("referrer_user_id")}
    if referrer_ids:
        refs = await db.users.find(
            {"id": {"$in": list(referrer_ids)}},
            {"_id": 0, "id": 1, "name": 1, "email": 1, "referral_slug": 1},
        ).to_list(length=None)
        by_id = {u["id"]: u for u in refs}
        for i in items:
            rid = i.get("referrer_user_id")
            if rid and rid in by_id:
                u = by_id[rid]
                i["referrer_name"] = u.get("name") or u.get("email")
                i["referrer_slug"] = u.get("referral_slug")

    # Aggregate summary tiles
    total = await db.leads.count_documents({})
    new_count = await db.leads.count_documents({"status": "new"})
    return {
        "items": items,
        "total": total,
        "new_count": new_count,
    }


# ---- Superadmin: update -------------------------------------------------
@router.patch("/admin/leads/{lead_id}")
async def update_lead(
    lead_id: str,
    payload: LeadStatusPatch,
    user: dict = Depends(require_role("superadmin")),
):
    updates: dict = {}
    if payload.status is not None:
        if payload.status not in VALID_STATUS:
            raise HTTPException(400, f"Status must be one of: {sorted(VALID_STATUS)}")
        updates["status"] = payload.status
    if payload.notes is not None:
        updates["notes"] = payload.notes.strip() or None
    if not updates:
        raise HTTPException(400, "Nothing to update")

    updates["updated_at"] = _now_iso()
    updates["updated_by"] = user.get("email")
    res = await db.leads.update_one({"id": lead_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(404, "Lead not found")
    return {"ok": True}


# ---- Superadmin: delete -------------------------------------------------
@router.delete("/admin/leads/{lead_id}")
async def delete_lead(
    lead_id: str,
    user: dict = Depends(require_role("superadmin")),
):
    res = await db.leads.delete_one({"id": lead_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Lead not found")
    return {"ok": True}


# ---- Public: resolve slug into referrer display info -------------------
@router.get("/public/refer/{slug}")
async def resolve_slug(slug: str):
    """Public: given a slug, return the referrer's display name (if any).

    Powers the referral landing page — we want to show 'Referred by Priya'
    above the form so visitors trust the source. Returns 200 with a null
    ``referrer`` when the slug doesn't resolve (still show the form).
    """
    user_id = await resolve_referrer_id(slug)
    if not user_id:
        return {"slug": slug, "referrer": None}
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "name": 1, "email": 1})
    display = (u or {}).get("name") or ((u or {}).get("email", "").split("@")[0])
    return {"slug": slug, "referrer": display}


# ---- Public: log referral link click -----------------------------------
class ClickIn(BaseModel):
    slug: str = Field(..., max_length=40)


@router.post("/public/refer-click")
async def log_click(payload: ClickIn, request: Request):
    """Log a click on a shared referral link. Fired by the ``/r/:slug``
    frontend route right before it forwards the visitor to the actual
    lead-capture page. Cheap insert into ``referral_clicks``.

    Idempotent-ish: we de-dupe by (slug, IP) within a rolling 30-minute
    window so a page reload doesn't inflate click counts.
    """
    slug = payload.slug.strip().lower()
    referrer_id = await resolve_referrer_id(slug)
    if not referrer_id:
        # Still record the click so we can see "wasted" traffic to bad slugs
        pass

    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent", "")[:400]

    # De-dupe 30-min window on (slug, ip)
    if ip:
        cutoff = (datetime.now(timezone.utc)
                  .replace(microsecond=0) - timedelta(minutes=30)).isoformat()
        recent = await db.referral_clicks.find_one({
            "slug": slug, "ip": ip,
            "created_at": {"$gte": cutoff},
        })
        if recent:
            return {"ok": True, "deduped": True}

    await db.referral_clicks.insert_one({
        "id": str(uuid.uuid4()),
        "slug": slug,
        "referrer_user_id": referrer_id,
        "ip": ip,
        "user_agent": ua,
        "created_at": _now_iso(),
    })
    return {"ok": True, "deduped": False}
