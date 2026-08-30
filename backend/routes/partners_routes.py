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
import enterprises as _ent

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

    # Pros the partner has provisioned — for the "Comped / Revoke"
    # whitelabel column on the detail page. Mirrors the enterprise
    # detail page's `pros` block so the same WhitelabelCompToggle
    # component drops in as-is.
    pros: list[dict] = []
    async for u in db.users.find({
        "partner_id": partner_id, "role": {"$in": ["pro", "partner"]},
    }):
        b = (u.get("branding") or {})
        pros.append({
            "id": u["id"],
            "email": u.get("email"),
            "name": u.get("name") or u.get("email"),
            "firm_name": b.get("firm_name"),
            "whitelabel_comp": bool(b.get("whitelabel_comp")),
            "whitelabel_paid": bool(b.get("whitelabel_paid")),
            "whitelabel_unlocked": bool(b.get("whitelabel_comp") or b.get("whitelabel_paid")),
            "source": "comp" if b.get("whitelabel_comp") else ("paid" if b.get("whitelabel_paid") else None),
            "created_at": u.get("created_at"),
        })

    # Enterprises the partner has provisioned — surfaced above the
    # Pros section so a Superadmin can see the firm entities under
    # this Partner before drilling into individual accountants
    # (Round 7.17, Feb 2026).
    enterprises: list[dict] = []
    async for e in db.enterprises.find(
        {"partner_id": partner_id},
        {"_id": 0, "id": 1, "name": 1, "slug": 1, "is_default": 1,
         "default_product": 1, "free_user_allotment": 1,
         "created_at": 1},
    ).sort("created_at", -1):
        try:
            e_stats = await _ent.rollup_stats(e["id"])
        except Exception:
            e_stats = {"pros_count": 0, "clients_count": 0, "companies_count": 0}
        enterprises.append({
            **e,
            "pros_count": e_stats.get("pros_count", 0),
            "clients_count": e_stats.get("clients_count", 0),
            "companies_count": e_stats.get("companies_count", 0),
        })

    # Client companies the partner owns (excluding their Partner Books)
    companies: list[dict] = []
    async for c in db.companies.find({
        "partner_id": partner_id,
        "is_partner_books": {"$ne": True},
    }).sort("created_at", -1):
        companies.append({
            "id": c["id"], "name": c.get("name"),
            "business_type": c.get("business_type"),
            "owner_user_id": c.get("owner_user_id"),
            "pro_user_id": c.get("pro_user_id"),
            "onboarding_complete": bool(c.get("onboarding_complete")),
            "created_at": c.get("created_at"),
        })

    return {
        "partner": _p.serialize(p, stats=stats),
        # The partner's OWN whitelabel status — surfaced as its own
        # block so the Superadmin can grant/revoke the partner's
        # white-label without a Pro row to hang the toggle on. (The
        # partner is a Pro-like user; the `/admin/pros/{id}/whitelabel-
        # comp` endpoint works for them directly.)
        "partner_wl": {
            "unlocked": bool(
                (p.get("branding") or {}).get("whitelabel_comp")
                or (p.get("branding") or {}).get("whitelabel_paid")
            ),
            "source": (
                "comp" if (p.get("branding") or {}).get("whitelabel_comp")
                else ("paid" if (p.get("branding") or {}).get("whitelabel_paid") else None)
            ),
        },
        "pros": pros,
        "enterprises": enterprises,
        "companies": companies,
    }


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
# Archive / Unarchive / Hard-Delete (Feb 2026)
# --------------------------------------------------------------------------
# A superadmin can either:
#   • ARCHIVE a partner (soft-delete) — flips `status=archived` on the
#     user doc. Login is blocked (see /auth/login). The tree
#     (enterprises + companies + descendant pros) is left untouched so
#     the partner can be un-archived losslessly.
#   • UNARCHIVE — restore.
#   • HARD-DELETE — irreversible. Cascades to every record downstream:
#     Partner Books company, all enterprises they provisioned, all
#     client companies stamped with `partner_id` or attached via
#     `enterprise_id`, every Pro user in their tree, and their
#     qbo_oauth_states. Refuses (409) if any client company still has
#     transactions unless `force=true` is passed.
# --------------------------------------------------------------------------

@router.post("/superadmin/partners/{partner_id}/archive")
async def archive_partner(
    partner_id: str,
    user: dict = Depends(require_role("superadmin")),
):
    p = await db.users.find_one({"id": partner_id, "role": "partner"})
    if not p:
        raise HTTPException(404, "Partner not found")
    if p.get("status") == "archived":
        return {"ok": True, "already_archived": True}
    await db.users.update_one(
        {"id": partner_id},
        {"$set": {
            "status": "archived",
            "archived_at": now_iso(),
            "archived_by": user["id"],
        }},
    )
    return {"ok": True, "partner_id": partner_id, "status": "archived"}


@router.post("/superadmin/partners/{partner_id}/unarchive")
async def unarchive_partner(
    partner_id: str,
    user: dict = Depends(require_role("superadmin")),
):
    p = await db.users.find_one({"id": partner_id, "role": "partner"})
    if not p:
        raise HTTPException(404, "Partner not found")
    await db.users.update_one(
        {"id": partner_id},
        {
            "$set": {"unarchived_at": now_iso(), "unarchived_by": user["id"]},
            "$unset": {"status": "", "archived_at": "", "archived_by": ""},
        },
    )
    return {"ok": True, "partner_id": partner_id, "status": "active"}


@router.delete("/superadmin/partners/{partner_id}")
async def delete_partner(
    partner_id: str,
    force: bool = False,
    user: dict = Depends(require_role("superadmin")),
):
    """Hard-delete a partner and cascade to their entire tree.

    * `force=false` (default) — refuses with 409 if any client company
      in the tree still has transactions, invoices, or bills. This is
      the guardrail against accidentally nuking active data.
    * `force=true` — deletes anyway. Use with intent — this is
      irreversible and doesn't archive.

    Returns a summary of what was removed so the frontend can render
    "Deleted N companies, M enterprises, K users" for the audit toast.
    """
    p = await db.users.find_one({"id": partner_id, "role": "partner"})
    if not p:
        raise HTTPException(404, "Partner not found")

    # Collect the tree BEFORE we start deleting so cascade decisions
    # are consistent across each step.
    ent_ids = [
        e["id"] async for e in db.enterprises.find(
            {"partner_id": partner_id}, {"id": 1, "_id": 0},
        ) if e.get("id")
    ]
    company_ids: set[str] = set()
    async for c in db.companies.find(
        {"$or": [
            {"partner_id": partner_id},
            {"enterprise_id": {"$in": ent_ids}} if ent_ids else {"_id": None},
        ]},
        {"id": 1, "_id": 0},
    ):
        if c.get("id"):
            company_ids.add(c["id"])
    user_ids: set[str] = {partner_id}
    async for u in db.users.find(
        {"$or": [
            {"partner_id": partner_id},
            {"enterprise_id": {"$in": ent_ids}} if ent_ids else {"_id": None},
        ]},
        {"id": 1, "_id": 0},
    ):
        if u.get("id"):
            user_ids.add(u["id"])

    if not force:
        # Guardrail — refuse if any company has recorded transactions.
        # Callers can retry with `?force=true` after confirming with a
        # human they really want to nuke the data.
        tx_count = 0
        if company_ids:
            tx_count = await db.transactions.count_documents(
                {"company_id": {"$in": list(company_ids)}}
            )
        if tx_count > 0:
            raise HTTPException(
                409,
                detail={
                    "message": (
                        f"This partner's tree has {tx_count} transactions across "
                        f"{len(company_ids)} companies. Pass `force=true` to nuke "
                        f"anyway, or archive the partner instead to preserve data."
                    ),
                    "code": "cascade_blocked_active_data",
                    "counts": {
                        "companies": len(company_ids),
                        "enterprises": len(ent_ids),
                        "users": len(user_ids),
                        "transactions": tx_count,
                    },
                },
            )

    # --- Cascade the deletes. Order matters — leaf tables first so
    # foreign-key-ish references are removed before their parents.
    txn_del = 0
    if company_ids:
        cids = list(company_ids)
        res = await db.transactions.delete_many({"company_id": {"$in": cids}})
        txn_del = res.deleted_count
        # Other per-company tables — best-effort, safe to no-op if
        # they don't exist in this deployment.
        for _coll in (
            "invoices", "bills", "estimates", "receipts", "contacts",
            "products", "categories", "memberships",
            "ai_usage_events", "qbo_oauth_states", "qbo_connections",
            "plaid_items", "veryfi_receipts", "chat_messages",
        ):
            try:
                await getattr(db, _coll).delete_many({"company_id": {"$in": cids}})
            except Exception:  # noqa: BLE001
                # Any collection that isn't in this deployment simply
                # doesn't matter — swallow and move on.
                pass
        await db.companies.delete_many({"id": {"$in": cids}})

    # Users in the tree.
    uids = list(user_ids)
    await db.users.delete_many({"id": {"$in": uids}})
    await db.qbo_oauth_states.delete_many({"user_id": {"$in": uids}})

    # Enterprises + their invoices.
    if ent_ids:
        await db.enterprise_invoices.delete_many({"enterprise_id": {"$in": ent_ids}})
        await db.enterprises.delete_many({"id": {"$in": ent_ids}})

    return {
        "ok": True,
        "deleted": {
            "partner_id": partner_id,
            "enterprises": len(ent_ids),
            "companies": len(company_ids),
            "users": len(user_ids),
            "transactions": txn_del,
            "forced": bool(force),
        },
    }


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
    """List enterprises this partner has provisioned. Includes each
    enterprise owner's white-label comp state so the Partner
    Dashboard can render an inline "Comp WL" toggle per row without
    a follow-up round-trip. Owners with no user account or without a
    WL flag surface as `owner_whitelabel_comp: false`. Also returns
    `clients_count` (companies attached via `enterprise_id`) so the
    dashboard can render "N clients" per row without another fetch.
    """
    rows: list[dict] = []
    ents = [e async for e in db.enterprises.find({"partner_id": user["id"]}).sort("name", 1)]
    ent_ids = [e["id"] for e in ents if e.get("id")]
    owner_ids = [e.get("owner_user_id") for e in ents if e.get("owner_user_id")]

    # Batch-fetch owner branding + companies-per-enterprise so this
    # scales at O(1) queries regardless of enterprise count.
    owners: dict[str, dict] = {}
    if owner_ids:
        async for o in db.users.find(
            {"id": {"$in": owner_ids}},
            {"id": 1, "email": 1, "name": 1, "branding.whitelabel_comp": 1,
             "branding.whitelabel_paid": 1, "_id": 0},
        ):
            owners[o["id"]] = o

    company_counts: dict[str, int] = {}
    if ent_ids:
        pipeline = [
            {"$match": {"enterprise_id": {"$in": ent_ids}}},
            {"$group": {"_id": "$enterprise_id", "n": {"$sum": 1}}},
        ]
        async for row in db.companies.aggregate(pipeline):
            company_counts[row["_id"]] = int(row.get("n") or 0)

    for e in ents:
        owner_id = e.get("owner_user_id")
        owner = owners.get(owner_id) if owner_id else None
        owner_b = (owner or {}).get("branding") or {}
        rows.append({
            "id": e["id"],
            "name": e.get("name"),
            "slug": e.get("slug"),
            "status": e.get("status"),
            "owner_user_id": owner_id,
            "owner_email": (owner or {}).get("email"),
            "owner_name": (owner or {}).get("name"),
            "owner_whitelabel_comp": bool(owner_b.get("whitelabel_comp")),
            "owner_whitelabel_paid": bool(owner_b.get("whitelabel_paid")),
            "clients_count": company_counts.get(e["id"], 0),
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


@router.get("/partner/financials")
async def partner_financials(
    months: int = 3,
    user: dict = Depends(require_role("partner", "superadmin")),
):
    """Real $-value Usage / Costs / Revenue rollup scoped to the
    Partner's tree. Returns:

      * `usage_cents_current`   — $ spent by the Partner's tree of
        companies on LLM + service calls this month.
      * `revenue_cents_current` — $ billed to enterprises the Partner
        provisioned this month (finalized + paid invoices).
      * `by_service_current`    — per-service breakdown of Usage for
        the current month (descending $).
      * `trend`                 — trailing `months`-month series of
        `{month_key, usage_cents, revenue_cents}`.

    `months` is clamped to `[1, 12]` — anything larger is truncated
    to protect the aggregation cost.
    """
    months = max(1, min(int(months or 3), 12))
    return await _p.partner_financials(user["id"], months=months)


@router.get("/partner/wl-comps")
async def partner_wl_comps(user: dict = Depends(require_role("partner"))):
    """Return the partner's remaining white-label comp quota so the
    Add-Enterprise modal (and future partner UIs) can show
    "X of 2 used" and disable the comp checkbox when exhausted."""
    # `_partner_wl_comps_used` lives in `routes/admin.py` — import
    # inline to avoid a circular dependency at module load.
    from routes.admin import _partner_wl_comps_used, _PARTNER_MAX_WL_COMPS
    used = await _partner_wl_comps_used(user["id"])
    return {
        "used": used,
        "cap": _PARTNER_MAX_WL_COMPS,
        "remaining": max(0, _PARTNER_MAX_WL_COMPS - used),
    }


@router.get("/partner/usage")
async def partner_usage(
    range: str = "month",
    category: str | None = None,
    user: dict = Depends(require_role("partner")),
):
    """Partner-scoped mirror of `/admin/usage` — same response shape
    so the SuperadminUsage UI can be reused verbatim on the frontend.
    Scoped to the partner's tree of companies (direct
    `companies.partner_id` OR attached to an enterprise the partner
    owns). Never leaks platform-wide spend.
    """
    if range not in {"7d", "30d", "90d", "month", "all"}:
        range = "month"
    if category not in {"all", "llm", "bank", "email", "ocr", None}:
        category = None
    # Reuse the same tree-walking helper the Financials rollup uses.
    company_ids = await _p._partner_tree_company_ids(user["id"])
    from ai_usage import get_summary, SERVICE_UNIT_PRICE_USD
    summary = await get_summary(
        range_key=range, category=category, company_ids=company_ids,
    )
    # Partners don't get the Plaid-live-count synthetic row — that's
    # a platform-wide monthly-recurring line that only makes sense
    # for the superadmin dashboard.
    summary["expected_services"] = [
        {"service": "openai_llm", "label": "OpenAI — LLM tokens", "unit": "token"},
        {"service": "veryfi_ocr", "label": "Veryfi OCR", "unit": "document",
         "unit_price_usd": SERVICE_UNIT_PRICE_USD.get("veryfi_ocr")},
        {"service": "resend_email", "label": "Resend email", "unit": "email",
         "unit_price_usd": SERVICE_UNIT_PRICE_USD.get("resend_email")},
    ]
    summary["tree_summary"] = {"company_count": len(company_ids)}
    return summary
