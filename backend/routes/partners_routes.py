"""Partner routes — the "reseller" tier.

Two surfaces:
  * `/api/superadmin/partners` — Superadmin creates + lists partners
    (mirrors `/api/admin/enterprises`).
  * `/api/partner/*` — a Partner logged in with role=partner sees a
    dashboard scoped to their tree (clients + enterprises they created,
    their Partner Books, their branding).

Data scoping invariant: no Partner can see another Partner's data.
Every read on this router either filters `partner_id == self.id`
directly or resolves the target via a helper that enforces the same.

Cross-role access matrix:
  * Superadmin can hit both surfaces.
  * Partner (role=='partner') can hit `/api/partner/*` and gets
    403 on `/api/superadmin/*`.
  * Pro / Client / Enterprise-owner get 403 on both.
"""
from __future__ import annotations

import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from auth import require_role, hash_password
from db import db
import partners as _p

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# Superadmin — Partner CRUD
# --------------------------------------------------------------------------

class PartnerCreate(BaseModel):
    """Payload for POST /superadmin/partners. Slug + branding fall back
    from the name if left blank."""
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    display_name: Optional[str] = Field(default=None, max_length=120)
    subdomain: Optional[str] = Field(default=None, max_length=60)
    primary_color: Optional[str] = Field(default=None, max_length=32)


class PartnerPatch(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=120)
    subdomain: Optional[str] = Field(default=None, max_length=60)
    primary_color: Optional[str] = Field(default=None, max_length=32)
    logo_url: Optional[str] = Field(default=None, max_length=1000)


@router.post("/superadmin/partners")
async def create_partner(
    payload: PartnerCreate,
    user: dict = Depends(require_role("superadmin")),
):
    """Superadmin — mint a new Partner. Auto-provisions Partner Books
    and fires a magic-link welcome email so the invitee can set their
    password and log in.

    Returns 409 if the email already belongs to a NON-partner user —
    upgrading an existing pro to partner is an explicit action (a
    future `PATCH /superadmin/users/{id}/role` endpoint) rather than
    something we do silently, to avoid demoting a client-with-data by
    accident.
    """
    email = str(payload.email).lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing and existing.get("role") != "partner":
        raise HTTPException(
            409,
            f"Email belongs to a {existing.get('role') or 'unknown'} account. "
            "Change role via user management before re-using it for a partner.",
        )
    if existing:
        raise HTTPException(409, "A partner with this email already exists.")

    now = now_iso()
    partner_user_id = str(uuid.uuid4())
    # Placeholder password — the welcome email carries a magic-link
    # password-set token so the invitee never sees a plaintext
    # credential. `must_set_password=True` blocks normal password
    # login until they complete the set-password flow.
    placeholder = hash_password(secrets.token_urlsafe(48))

    slug_base = _p.slugify(payload.subdomain or payload.display_name or payload.name)
    slug = await _p.resolve_unique_slug(slug_base)

    partner_doc = {
        "id": partner_user_id,
        "email": email,
        "name": payload.name.strip(),
        "password": placeholder,
        "role": "partner",
        "must_set_password": True,
        "branding": {
            "firm_name": (payload.display_name or payload.name).strip(),
            "subdomain": slug,
            "primary_color": payload.primary_color or None,
        },
        "created_at": now,
        "updated_at": now,
    }
    await db.users.insert_one(partner_doc)
    # Sidecar `partners` collection — lightweight index doc used by
    # the slug lookup + rollup. Keeps `users` from carrying every
    # partner-specific field.
    await db.partners.insert_one({
        "id": partner_user_id,  # same PK as the user doc for easy join
        "user_id": partner_user_id,
        "slug": slug,
        "created_at": now,
    })

    # Auto-provision Partner Books.
    books = await _p.ensure_partner_books_company_for_partner(partner_user_id)

    # Welcome / magic-link email. Failure is logged but never blocks
    # the create — the superadmin can hit "Resend welcome" later.
    email_status = None
    email_error = None
    try:
        from routes.auth import mint_password_set_token
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        magic_token = await mint_password_set_token(partner_user_id, purpose="welcome")
        magic_url = f"{public_base_url()}/set-password/{magic_token}"
        subject, html = _tmpl.team_invite(
            invitee_name=payload.name,
            inviter_name=user.get("name") or user.get("email") or "SmartBooks",
            role_label="Partner",
            role_description=(
                f"you'll own the {payload.display_name or payload.name} partner space "
                "on SmartBooks — add clients, provision enterprises under your brand, "
                "and see usage + revenue scoped to your tree."
            ),
            company_names=[],
            magic_url=magic_url,
        )
        result = await dispatch(
            kind="team_invite",
            to=email,
            subject=subject, html=html,
            initiating_user_id=user["id"],
            related={"partner_id": partner_user_id, "kind": "partner_owner_welcome"},
        )
        email_status = result.get("status", "failed")
        email_error = result.get("error")
    except Exception as _exc:  # noqa: BLE001
        logger.exception("Partner welcome email failed (partner still created)")
        email_status = "failed"
        email_error = str(_exc)

    stats = await _p.rollup_stats(partner_user_id)
    return {
        "partner": _p.serialize(partner_doc, stats=stats),
        "partner_books_company_id": (books or {}).get("id"),
        "email_status": email_status,
        "email_error": email_error,
    }


@router.get("/superadmin/partners")
async def list_partners(user: dict = Depends(require_role("superadmin"))):
    """List every partner with rollup counts (clients, enterprises,
    linked users). Sort: most-populated first, then alphabetical."""
    rows: list[dict] = []
    async for u in db.users.find({"role": "partner"}):
        stats = await _p.rollup_stats(u["id"])
        rows.append(_p.serialize(u, stats=stats))
    rows.sort(key=lambda r: (
        -(r["stats"].get("clients", 0) + r["stats"].get("enterprises", 0)),
        (r.get("display_name") or "").lower(),
    ))
    return {"partners": rows, "count": len(rows)}


@router.get("/superadmin/partners/{partner_id}")
async def get_partner(
    partner_id: str,
    user: dict = Depends(require_role("superadmin")),
):
    p = await db.users.find_one({"id": partner_id, "role": "partner"})
    if not p:
        raise HTTPException(404, "Partner not found")
    stats = await _p.rollup_stats(partner_id)
    return {"partner": _p.serialize(p, stats=stats)}


@router.patch("/superadmin/partners/{partner_id}")
async def patch_partner(
    partner_id: str,
    payload: PartnerPatch,
    user: dict = Depends(require_role("superadmin")),
):
    p = await db.users.find_one({"id": partner_id, "role": "partner"})
    if not p:
        raise HTTPException(404, "Partner not found")

    branding = dict(p.get("branding") or {})
    if payload.display_name is not None:
        branding["firm_name"] = payload.display_name.strip()
    if payload.primary_color is not None:
        branding["primary_color"] = payload.primary_color.strip() or None
    if payload.logo_url is not None:
        branding["logo_url"] = payload.logo_url.strip() or None
    if payload.subdomain is not None:
        new_slug = _p.slugify(payload.subdomain)
        # Only take the trip through resolve_unique_slug if the value
        # actually changed — otherwise we'd get an "already taken" false
        # positive on the partner's own current slug.
        if new_slug != (p.get("branding") or {}).get("subdomain"):
            new_slug = await _p.resolve_unique_slug(new_slug)
        branding["subdomain"] = new_slug
        await db.partners.update_one(
            {"id": partner_id},
            {"$set": {"slug": new_slug, "updated_at": now_iso()}},
        )

    await db.users.update_one(
        {"id": partner_id},
        {"$set": {"branding": branding, "updated_at": now_iso()}},
    )
    p["branding"] = branding
    stats = await _p.rollup_stats(partner_id)
    return {"partner": _p.serialize(p, stats=stats)}


# --------------------------------------------------------------------------
# Partner — self-service views (scoped to their own tree)
# --------------------------------------------------------------------------

@router.get("/partner/me")
async def partner_me(user: dict = Depends(require_role("partner", "superadmin"))):
    """Partner's own profile + rollup — Superadmin can also hit this
    while impersonating for support."""
    stats = await _p.rollup_stats(user["id"])
    # Ensure Partner Books exists — self-heals if a Partner slipped
    # through without one (e.g. migrated from an older role).
    if not stats["has_partner_books"] and user.get("role") == "partner":
        books = await _p.ensure_partner_books_company_for_partner(user["id"])
        if books:
            stats["has_partner_books"] = True
            stats["partner_books_company_id"] = books["id"]
    return {"partner": _p.serialize(user, stats=stats)}


@router.get("/partner/clients")
async def partner_clients(user: dict = Depends(require_role("partner", "superadmin"))):
    """List client companies scoped to this partner. Excludes Partner
    Books from the client count (it appears in its own tile)."""
    rows: list[dict] = []
    async for c in db.companies.find({
        "partner_id": user["id"],
        "is_partner_books": {"$ne": True},
    }).sort("name", 1):
        rows.append({
            "id": c["id"],
            "name": c.get("name"),
            "owner_user_id": c.get("owner_user_id"),
            "business_type": c.get("business_type"),
            "created_at": c.get("created_at"),
        })
    return {"clients": rows, "count": len(rows)}


@router.get("/partner/enterprises")
async def partner_enterprises(user: dict = Depends(require_role("partner", "superadmin"))):
    """List enterprises this partner has provisioned."""
    rows: list[dict] = []
    async for e in db.enterprises.find({"partner_id": user["id"]}).sort("name", 1):
        rows.append({
            "id": e["id"],
            "name": e.get("name"),
            "slug": e.get("slug"),
            "owner_user_id": e.get("owner_user_id"),
            "created_at": e.get("created_at"),
        })
    return {"enterprises": rows, "count": len(rows)}


@router.get("/partner/summary")
async def partner_summary(user: dict = Depends(require_role("partner", "superadmin"))):
    """One-shot payload for the /partner landing page: rollup counts,
    Partner Books ref, and last-updated stamp. Front-end renders
    everything from this single call."""
    stats = await _p.rollup_stats(user["id"])
    if not stats["has_partner_books"] and user.get("role") == "partner":
        books = await _p.ensure_partner_books_company_for_partner(user["id"])
        if books:
            stats["has_partner_books"] = True
            stats["partner_books_company_id"] = books["id"]
    return {
        "partner": _p.serialize(user, stats=stats),
        "generated_at": now_iso(),
    }
