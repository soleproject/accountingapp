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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Query
from pydantic import BaseModel, EmailStr, Field

from db import db
from auth import require_role
from referral_util import resolve_referrer_id


router = APIRouter(prefix="/api", tags=["leads"])


# ---- Models ------------------------------------------------------------
VALID_ROLES = {"accounting_pro", "business_owner", "enterprise", "affiliate", "other"}
VALID_STATUS = {"new", "contacted", "qualified", "converted", "dead"}


class LeadIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr
    role: str = Field(..., description="accounting_pro | business_owner | enterprise | affiliate | other")
    ref_slug: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=2000)
    phone: Optional[str] = Field(None, max_length=40)
    company_name: Optional[str] = Field(None, max_length=200)
    variant: Optional[str] = Field(None, max_length=20, description="owner | pro | enterprise landing variant")
    source_tag: Optional[str] = Field(None, max_length=40, description="free-form channel tag (&src=)")
    extra: Optional[dict] = Field(None, description="role-specific answers (books_today, clients, software, entities, best_time)")


ROLE_LABEL = {"business_owner": "Business owner", "accounting_pro": "Accounting pro", "enterprise": "Enterprise",
              "affiliate": "Affiliate", "other": "Other"}


async def _routing(doc: dict, firm: dict | None) -> dict:
    """Where the prospect goes next + URLs the emails need."""
    from email_dispatcher import public_base_url
    import affiliate_content as ac
    base = public_base_url((firm or {}).get("slug"))
    qs = []
    if doc.get("ref_slug"):
        qs.append(f"ref={doc['ref_slug']}")
    if (firm or {}).get("slug"):
        qs.append(f"firm={firm['slug']}")
    qs.append(f"email={doc['email']}")
    q = "?" + "&".join(qs)
    signup_url = f"{base}/signup/affiliate{q}" if doc["role"] == "affiliate" else f"{base}/signup{q}"
    settings = await ac.get_settings()
    booking_url = None
    if doc["role"] == "accounting_pro" and settings.get("walkthrough_booking_slug"):
        booking_url = f"{base}/book/{settings['walkthrough_booking_slug']}?name={doc.get('name','')}&email={doc['email']}"
    action = {"business_owner": "signup", "affiliate": "signup", "other": "signup",
              "accounting_pro": "book" if booking_url else "call", "enterprise": "call"}[doc["role"]]
    if firm and doc["role"] == "business_owner":
        action = "firm_contact"
    return {"action": action, "signup_url": signup_url, "booking_url": booking_url, "base": base,
            "admin_emails": [e.strip() for e in (settings.get("admin_notify_emails") or "").split(",") if e.strip()]}


async def _after_lead_submit(doc: dict, firm: dict | None, referrer: dict | None, routing: dict) -> None:
    """Transactional trio: prospect confirmation, affiliate notice, admin notice (pro/enterprise)."""
    import logging
    import affiliate_emails as ae
    import affiliate_content as ac
    from email_dispatcher import dispatch
    log = logging.getLogger(__name__)
    first = (doc.get("name") or "").split()[0] if doc.get("name") else "there"
    ref_name = (referrer or {}).get("name") or ((referrer or {}).get("email") or "").split("@")[0] or None
    brand = (firm or {}).get("name") if firm else None
    try:
        subject, html = ae.prospect_confirmation(role=doc["role"], first_name=first, email=doc["email"], referrer=ref_name,
                                                 signup_url=routing["signup_url"], booking_url=routing["booking_url"],
                                                 brand=brand, firm_name=brand)
        await dispatch(kind="lead_confirmation", to=doc["email"], subject=subject, html=html,
                       reply_to=(referrer or {}).get("email"), related={"lead_id": doc["id"]})
    except Exception:
        log.exception("lead confirmation failed lead=%s", doc["id"])
    if referrer and referrer.get("email"):
        try:
            prior = await db.leads.count_documents({"referrer_user_id": referrer["id"], "id": {"$ne": doc["id"]}})
            tk = await ac.get_toolkit()
            tpl = next((t for t in tk["templates"] if t["id"] == "sms_signed_up_no_bank"), None)
            text = ac.render((tpl or {}).get("body", ""), {"first_name": first})
            subject, html = ae.affiliate_lead_notice(
                affiliate_first=(referrer.get("name") or "").split()[0] if referrer.get("name") else "there",
                lead_name=doc.get("name") or doc["email"], company=doc.get("company_name"),
                role_label=ROLE_LABEL.get(doc["role"], "Business owner"), variant=doc.get("variant") or "owner",
                pipeline_url=f"{routing['base']}/share?tab=pipeline&lead={doc['id']}", suggested_text=text, is_first=prior == 0)
            await dispatch(kind="affiliate_lead_notice", to=referrer["email"], subject=subject, html=html,
                           initiating_user_id=referrer["id"], related={"lead_id": doc["id"]})
        except Exception:
            log.exception("affiliate lead notice failed lead=%s", doc["id"])
    firm_owner = (firm or {}).get("owner_email")
    if doc["role"] in ("accounting_pro", "enterprise") or (firm_owner and doc["role"] == "business_owner"):
        try:
            to = [] if (firm_owner and doc["role"] == "business_owner") else (
                routing["admin_emails"] or [u["email"] async for u in db.users.find({"role": "superadmin"}, {"_id": 0, "email": 1})])
            if firm_owner:
                to.append(firm_owner)
            subject, html = ae.admin_lead_notice(lead=doc, affiliate_name=ref_name, admin_url=f"{routing['base']}/admin/leads",
                                                 booking_url=routing["booking_url"])
            for addr in dict.fromkeys(to):
                await dispatch(kind="admin_lead_notice", to=addr, subject=subject, html=html, related={"lead_id": doc["id"]})
        except Exception:
            log.exception("admin lead notice failed lead=%s", doc["id"])


class LeadStatusPatch(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- Public: submit lead ------------------------------------------------
@router.post("/public/leads")
async def submit_lead(payload: LeadIn, request: Request, background: BackgroundTasks):
    """Public lead-capture endpoint. Anyone (no auth) can drop a lead.

    Idempotent-ish: repeat submissions from the same email + ref within
    24h are collapsed into the original (status + notes preserved) so a
    double-click doesn't create dupes.
    """
    if payload.role not in VALID_ROLES:
        raise HTTPException(400, f"Role must be one of: {sorted(VALID_ROLES)}")

    referrer_id = await resolve_referrer_id(payload.ref_slug) if payload.ref_slug else None
    referrer = await db.users.find_one({"id": referrer_id}, {"_id": 0, "id": 1, "name": 1, "email": 1, "branding": 1,
                                                            "signup_firm_slug": 1, "enterprise_id": 1}) if referrer_id else None
    from routes.auth import _resolve_firm_for_user, _firm_public_info
    raw_firm = await _resolve_firm_for_user(referrer) if referrer else None
    firm = _firm_public_info(raw_firm)
    if firm and raw_firm:
        firm["owner_email"] = raw_firm.get("email")

    # De-dupe on (email, ref_slug)
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
                "variant": payload.variant or existing.get("variant"),
                "last_seen_at": _now_iso(),
            }}
        )
        routing = await _routing({**existing, "role": payload.role}, firm)
        return {"ok": True, "id": existing["id"], "duplicate": True, "next": routing["action"],
                "signup_url": routing["signup_url"], "booking_url": routing["booking_url"]}

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
        "variant": (payload.variant or "").strip() or None,
        "source_tag": (payload.source_tag or "").strip() or None,
        "extra": payload.extra or None,
        "activities": [],
        "status": "new",
        "source": "referral" if payload.ref_slug else "direct",
        "ip": (request.client.host if request.client else None),
        "user_agent": request.headers.get("user-agent", "")[:400],
        "created_at": _now_iso(),
        "last_seen_at": _now_iso(),
    }
    await db.leads.insert_one(doc)
    doc.pop("_id", None)
    routing = await _routing(doc, firm)
    background.add_task(_after_lead_submit, doc, firm, referrer, routing)
    return {"ok": True, "id": doc["id"], "duplicate": False, "next": routing["action"],
            "signup_url": routing["signup_url"], "booking_url": routing["booking_url"]}


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
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "name": 1, "email": 1, "branding": 1,
                                                  "signup_firm_slug": 1, "enterprise_id": 1})
    display = (u or {}).get("name") or ((u or {}).get("email", "").split("@")[0])
    from routes.auth import _resolve_firm_for_user, _firm_public_info
    firm = _firm_public_info(await _resolve_firm_for_user(u or {}))
    return {"slug": slug, "referrer": display, "firm_slug": (firm or {}).get("slug"),
            "firm_name": (firm or {}).get("name"), "firm_logo_url": (firm or {}).get("logo_url")}


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
