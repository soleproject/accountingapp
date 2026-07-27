"""SmartBooks — Superadmin routes.

Auto-extracted from server.py during the Feb 2026 modularization refactor.
Behaviour is intentionally identical to the pre-split codebase.
"""
from __future__ import annotations
import os
import re
import uuid
import json
import random
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from auth import (
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
from ai_service import (
    categorize_transaction, chat_stream, suggest_chart_of_accounts,
    onboarding_interview_questions, onboarding_interview_synthesize,
    parse_voice_intent,
)
import reports as R
import plaid_service
import plaid_connect
import veryfi_service
import merchant_cache
import contact_resolver
from infra import get_cache

from models import (
    LoginIn, SignupIn, CompanyCreate, TransactionUpdate, TransactionCreate,
    SplitIn, RuleCreate, InvoiceCreate, BillCreate, ContactCreate,
    AccountCreate, JECreate, ChatIn, OnboardingUpdate, PaymentCreate,
    ReceiptCreate, GenericCreate, NewClientIn,
)
from deps import (
    DASH_CACHE_TTL,
    company_ids_for_user, require_company, log_ai,
    is_period_closed, assert_open,
    categorize_and_insert, sync_and_import,
)

router = APIRouter(prefix="/api")


# ----------------------- Superadmin -----------------------

@router.get("/admin/overview")
async def admin_overview(user: dict = Depends(require_role("superadmin"))):
    users = await db.users.find({}, {"password": 0, "_id": 0}).to_list(1000)
    companies = await db.companies.find({}, {"_id": 0}).to_list(1000)
    memberships = await db.memberships.find({}, {"_id": 0}).to_list(2000)
    pros = [u for u in users if u["role"] == "pro"]
    clients = [u for u in users if u["role"] == "client"]
    return {
        "users": users, "companies": companies, "memberships": memberships,
        "stats": {
            "total_users": len(users), "total_pros": len(pros),
            "total_clients": len(clients), "total_companies": len(companies),
        },
    }


class TestEmailIn(BaseModel):
    to: EmailStr
    subject: Optional[str] = "SmartBooks — test email"
    html: Optional[str] = None


@router.post("/admin/test-email")
async def admin_test_email(
    inp: TestEmailIn,
    user: dict = Depends(require_role("superadmin", "pro")),
):
    """Fire a one-off transactional email via Resend. Reserved for superadmin
    + pros — anyone who legitimately configures branded email in the platform
    (Slack/email digest, invite flows, etc.) needs to be able to verify
    deliverability from a UI button without waiting for a real event."""
    from email_service import send_email, EmailError
    default_html = f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#f8fafc;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <tr><td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"
               style="background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e2e8f0;">
          <tr><td style="font-size:22px;font-weight:600;color:#0f172a;padding-bottom:8px;">
            Test email from SmartBooks
          </td></tr>
          <tr><td style="font-size:14px;color:#475569;line-height:1.55;padding-bottom:24px;">
            Delivery pipeline is live. This message was sent by
            <b>{user.get('email')}</b> from the platform's Resend integration.
          </td></tr>
          <tr><td style="font-size:12px;color:#64748b;line-height:1.55;">
            Sent via Resend · <span style="font-family:monospace;">accountingapp.ai</span>
          </td></tr>
        </table>
      </td></tr>
    </table>
    """
    try:
        resp = await send_email(
            to=str(inp.to),
            subject=inp.subject or "SmartBooks — test email",
            html=inp.html or default_html,
        )
    except EmailError as e:
        raise HTTPException(502, str(e))
    return {"sent": True, "id": resp.get("id"), "to": str(inp.to)}


@router.get("/admin/email/env-check")
async def admin_email_env_check(
    user: dict = Depends(require_role("superadmin")),
):
    """Diagnostic — inspect the Resend env config on the currently-running
    backend. Reports whether RESEND_API_KEY / RESEND_FROM / RESEND_FROM_FIRM
    are set and what the resolved firm-sender From address would look like
    for a sample firm name. Superadmin-only because it echoes value shapes.
    """
    import os as _os
    from email_service import _firm_sender

    def _mask(v):
        if v is None:
            return {"set": False}
        if v == "":
            return {"set": True, "empty": True, "length": 0}
        return {
            "set": True, "empty": False, "length": len(v),
            "prefix": v[:8], "suffix": v[-8:] if len(v) > 8 else "***",
        }

    watched = ["RESEND_API_KEY", "RESEND_FROM", "RESEND_FROM_FIRM"]
    result = {k: _mask(_os.environ.get(k)) for k in watched}
    samples = {}
    for name in ["Synergy AI", "Acme, Inc.", "O'Brien & Sons"]:
        samples[name] = _firm_sender(name) or "(would fall back to RESEND_FROM)"
    return {
        "env": result,
        "resolved_from_samples": samples,
        "platform_from_preview": _os.environ.get("RESEND_FROM"),
    }


# ----------------------- Superadmin — AI Usage & Costs -----------------------

@router.get("/admin/usage")
async def admin_usage(
    range: str = Query("month", pattern=r"^(7d|30d|90d|month|all)$"),
    category: Optional[str] = Query(None, pattern=r"^(all|llm|bank|email|ocr)$"),
    user: dict = Depends(require_role("superadmin")),
):
    """AI + external-API spend rollup.

    ``range`` — 7d / 30d / 90d / month / all
    ``category`` — filter chip: llm / bank / email / ocr (omit for All)

    Response payload matches what the SuperadminUsage frontend expects:
        totals, by_feature, by_service, by_category.

    Also includes ``plaid_items_active`` — a live count of connected
    Plaid items so the dashboard can show the monthly recurring cost row
    (Plaid bills per-item-per-month, and we don't emit an event per
    billing period — the count IS the cost driver).
    """
    from ai_usage import get_summary, SERVICE_UNIT_PRICE_USD
    summary = await get_summary(range_key=range, category=category)

    # Live Plaid item count → synthetic "plaid-linked-item-monthly" row.
    plaid_active = await db.plaid_items.count_documents({"revoked_at": None}) \
        if await db.plaid_items.count_documents({}) else 0
    if plaid_active == 0:
        # Fallback for older docs that never had ``revoked_at`` set.
        plaid_active = await db.plaid_items.count_documents({})
    plaid_rate = SERVICE_UNIT_PRICE_USD.get("plaid_linked_item", 0.30)
    plaid_row = {
        "service": "plaid_linked_item",
        "quantity": plaid_active,
        "unit": "item",
        "unit_price_usd": plaid_rate,
        "cost_cents": plaid_active * plaid_rate * 100,
        "events": plaid_active,
    }

    # Merge into by_service — replace any logged plaid_linked_item row so
    # the live count wins over historical estimates.
    by_service = [r for r in summary["by_service"] if r["service"] != "plaid_linked_item"]
    if plaid_active > 0:
        by_service.append(plaid_row)
        # And roll into totals + category "bank"
        summary["totals"]["cost_cents"] += plaid_row["cost_cents"]
        for cat_row in summary["by_category"]:
            if cat_row["category"] == "bank":
                cat_row["cost_cents"] += plaid_row["cost_cents"]
                break
        else:
            summary["by_category"].append({"category": "bank", "cost_cents": plaid_row["cost_cents"]})
    by_service.sort(key=lambda r: r["cost_cents"], reverse=True)
    summary["by_service"] = by_service

    # Return also the list of "expected" services so the UI can render
    # placeholder rows for integrations not yet used (matches the mock).
    summary["expected_services"] = [
        {"service": "openai_llm", "label": "OpenAI — LLM tokens", "unit": "token"},
        {"service": "veryfi_ocr", "label": "Veryfi OCR", "unit": "document",
         "unit_price_usd": SERVICE_UNIT_PRICE_USD.get("veryfi_ocr")},
        {"service": "resend_email", "label": "Resend email", "unit": "email",
         "unit_price_usd": SERVICE_UNIT_PRICE_USD.get("resend_email")},
        {"service": "plaid_linked_item", "label": "Plaid linked items", "unit": "item",
         "unit_price_usd": SERVICE_UNIT_PRICE_USD.get("plaid_linked_item")},
    ]
    summary["plaid_items_active"] = plaid_active

    # Categorization-source breakdown across the transactions ledger —
    # proves the deterministic pre-LLM layers are pulling their weight.
    # Bucketed into four buckets the UI groups on: pfc / cache / rule / ai.
    def _bucket(ai_source: str | None, cache_hit: bool) -> str:
        s = (ai_source or "").lower()
        if s.startswith("pfc_"):
            return "pfc"
        if s == "memory" or cache_hit:
            return "cache"
        if s in ("rule", "rules"):
            return "rule"
        if s == "ai":
            return "ai"
        # Manually-created / opening_balance / unknown → don't inflate
        # any specific category.
        return "other"

    cat_pipeline = [
        {"$match": {"category_account_id": {"$ne": None}}},
        {"$project": {"ai_source": 1, "cache_hit": 1, "company_id": 1}},
    ]
    buckets_overall: dict[str, int] = {"pfc": 0, "cache": 0, "rule": 0, "ai": 0, "other": 0}
    buckets_by_company: dict[str, dict[str, int]] = {}
    async for t in db.transactions.aggregate(cat_pipeline):
        b = _bucket(t.get("ai_source"), bool(t.get("cache_hit")))
        buckets_overall[b] += 1
        cid = t.get("company_id")
        if cid:
            row = buckets_by_company.setdefault(cid, {"pfc": 0, "cache": 0, "rule": 0, "ai": 0, "other": 0})
            row[b] += 1

    summary["categorization_sources_overall"] = buckets_overall

    # Enrich per-company + per-user rollups with display names so the UI
    # doesn't have to make N follow-up requests. Also attach live Plaid
    # item counts + monthly cost per company so the enterprise view
    # reflects the real bill, not just AI usage.
    company_ids = [r["company_id"] for r in summary.get("by_company", [])]
    user_ids = [r["user_id"] for r in summary.get("by_user", [])]

    companies_by_id = {}
    if company_ids:
        docs = await db.companies.find({"id": {"$in": company_ids}}).to_list(2000)
        companies_by_id = {d["id"]: d for d in docs}

    users_by_id = {}
    if user_ids:
        udocs = await db.users.find({"id": {"$in": user_ids}}).to_list(2000)
        users_by_id = {d["id"]: d for d in udocs}

    # Plaid item counts per company — needed so the enterprise table
    # includes the same bank fee we already surface in by_service.
    plaid_by_company: dict[str, int] = {}
    plaid_docs = await db.plaid_items.find({}).to_list(2000)
    for pi in plaid_docs:
        cid = pi.get("company_id")
        if cid:
            plaid_by_company[cid] = plaid_by_company.get(cid, 0) + 1

    # Any company with a Plaid item but no AI events yet still shows up.
    for cid, count in plaid_by_company.items():
        if not any(r["company_id"] == cid for r in summary.get("by_company", [])):
            summary["by_company"].append({
                "company_id": cid, "events": 0, "cost_cents": 0.0, "unique_users": 0,
            })

    for row in summary.get("by_company", []):
        cdoc = companies_by_id.get(row["company_id"]) or {}
        row["name"] = cdoc.get("name") or "(unknown)"
        row["business_type"] = cdoc.get("business_type") or ""
        row["owner_user_id"] = cdoc.get("owner_user_id")
        pcount = plaid_by_company.get(row["company_id"], 0)
        row["plaid_items"] = pcount
        row["plaid_cost_cents"] = pcount * plaid_rate * 100
        # Total including plaid recurring — the "true bill" per enterprise.
        row["total_cost_cents"] = row["cost_cents"] + row["plaid_cost_cents"]
        row["categorization_sources"] = buckets_by_company.get(
            row["company_id"],
            {"pfc": 0, "cache": 0, "rule": 0, "ai": 0, "other": 0},
        )
    # Drop rows that are pure Plaid orphans (no matching company doc AND
    # no AI events). Those are stale test/dev items and only clutter the
    # dashboard — the numbers are still counted in the by_service Plaid
    # row so we don't lose the cost.
    summary["by_company"] = [
        r for r in summary["by_company"]
        if r.get("name") != "(unknown)" or r.get("events", 0) > 0
    ]
    summary["by_company"].sort(key=lambda r: r["total_cost_cents"], reverse=True)

    for row in summary.get("by_user", []):
        udoc = users_by_id.get(row["user_id"]) or {}
        row["name"] = udoc.get("name")
        row["email"] = udoc.get("email")
        row["role"] = udoc.get("role")

    return summary






# ----------------------- Enterprises -----------------------
# The Enterprise object represents the accounting-firm / billing-parent of
# one-or-more Pro users. The platform-default `SmartBooks` enterprise
# catches every Pro that hasn't been assigned to a private-label parent.

import enterprises as _ent


class EnterprisePatch(BaseModel):
    """Superadmin-editable fields. Everything is optional (sparse patch)."""
    name: Optional[str] = None
    free_user_allotment: Optional[int] = Field(default=None, ge=0, le=10_000)
    default_product: Optional[str] = None
    default_discount: Optional[bool] = None


class EnterpriseCreate(BaseModel):
    """Payload for POST /admin/enterprises — superadmin manually spawns
    a new Enterprise record. Everything except `name` is optional; the
    slug auto-generates from `name` if left blank, and we default the
    product/discount/allotment to the same values used for
    Pro-auto-spawn (`ensure_personal_enterprise_for_pro`).

    Two owner-provisioning modes are supported:
      * `owner_user_id` — attach an existing Pro user directly.
      * `owner_email` + `owner_name` — create/attach a Pro by email:
        if the email already belongs to a Pro we simply set
        `enterprise_id`; if it doesn't exist we insert a fresh Pro
        user with a placeholder password and email them a magic-link
        set-password URL so they can log in and take over the account.
    """
    name: str = Field(..., min_length=1, max_length=120)
    slug: Optional[str] = Field(default=None, max_length=80)
    owner_user_id: Optional[str] = None
    owner_email: Optional[EmailStr] = None
    owner_name: Optional[str] = Field(default=None, max_length=200)
    free_user_allotment: int = Field(default=0, ge=0, le=10_000)
    default_product: str = "simple_start"
    default_discount: bool = False


@router.post("/admin/enterprises")
async def create_enterprise(
    payload: EnterpriseCreate,
    user: dict = Depends(require_role("superadmin")),
):
    """Superadmin — mint a new Enterprise. Slug is auto-generated from
    the name (kebab-case) with de-dupe suffixing when necessary.

    When `owner_email` is supplied we ALSO provision a Pro user for
    that email — creating one with `must_set_password=True` if it
    doesn't already exist, and dispatching a Resend magic-link
    welcome email so the new owner can log in and set their password.
    """
    now = datetime.now(timezone.utc).isoformat()
    slug_base = _ent._slugify(payload.slug or payload.name)
    slug = await _ent._resolve_unique_slug(slug_base)

    # Resolve the owner up-front so the enterprise is stamped with the
    # correct `owner_user_id` on first insert (avoids two write hops).
    owner_user_id: Optional[str] = None
    owner_provisioned = False  # True when we minted a NEW pro user
    magic_token: Optional[str] = None
    if payload.owner_user_id:
        owner = await db.users.find_one({"id": payload.owner_user_id})
        if not owner:
            raise HTTPException(400, "owner_user_id does not exist")
        if owner.get("role") != "pro":
            raise HTTPException(400, "owner_user_id must be a Pro user")
        owner_user_id = owner["id"]
    elif payload.owner_email:
        owner_email = str(payload.owner_email).lower().strip()
        existing = await db.users.find_one({"email": owner_email})
        if existing:
            if existing.get("role") != "pro":
                raise HTTPException(
                    400,
                    "That email belongs to a non-pro account and cannot own an enterprise.",
                )
            owner_user_id = existing["id"]
        else:
            # Fresh Pro user with a random placeholder password. The
            # welcome email carries a magic-link password-set token
            # (7-day TTL, purpose='welcome') so the invitee never sees
            # a plaintext credential and rotation is baked in.
            import secrets as _secrets
            placeholder = hash_password(_secrets.token_urlsafe(48))
            owner_user_id = str(uuid.uuid4())
            await db.users.insert_one({
                "id": owner_user_id,
                "email": owner_email,
                "name": (payload.owner_name or owner_email.split("@")[0]).strip(),
                "password": placeholder,
                "role": "pro",
                "must_set_password": True,
                "created_at": now,
                "updated_at": now,
            })
            owner_provisioned = True

    ent = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "slug": slug,
        "is_default": False,
        "owner_user_id": owner_user_id,
        "free_user_allotment": payload.free_user_allotment,
        "default_product": payload.default_product,
        "default_discount": payload.default_discount,
        "created_at": now,
        "updated_at": now,
    }
    await db.enterprises.insert_one(ent)
    if owner_user_id:
        await db.users.update_one(
            {"id": owner_user_id},
            {"$set": {"enterprise_id": ent["id"]}},
        )

    # Dispatch the welcome / invite email best-effort. Failure to email
    # never blocks the enterprise-create flow — the admin can hit
    # "Resend welcome link" from the enterprise detail page later.
    email_status = None
    email_error = None
    if owner_provisioned:
        try:
            from routes.auth import mint_password_set_token
            from email_dispatcher import dispatch, public_base_url
            import email_templates as _tmpl
            magic_token = await mint_password_set_token(owner_user_id, purpose="welcome")
            magic_url = f"{public_base_url()}/set-password/{magic_token}"
            subject, html = _tmpl.team_invite(
                invitee_name=(payload.owner_name or "there"),
                inviter_name=user.get("name") or user.get("email") or "SmartBooks",
                role_label="Enterprise owner",
                role_description=f"you'll own the {ent['name']} enterprise on SmartBooks and can invite Pros, add clients, and manage billing.",
                company_names=[],
                magic_url=magic_url,
            )
            result = await dispatch(
                kind="team_invite",
                to=str(payload.owner_email),
                subject=subject, html=html,
                initiating_user_id=user["id"],
                company_id=None,
                related={"enterprise_id": ent["id"], "kind": "enterprise_owner_welcome"},
            )
            email_status = result.get("status", "failed")
            email_error = result.get("error")
        except Exception as _exc:  # noqa: BLE001
            import logging as _lg
            _lg.getLogger(__name__).exception("Enterprise owner welcome email failed (user still created)")
            email_status = "failed"
            email_error = str(_exc)

    stats = await _ent.rollup_stats(ent["id"])
    return {
        "enterprise": _ent.serialize(ent, stats=stats),
        "owner_provisioned": owner_provisioned,
        "email_status": email_status,
        "email_error": email_error,
    }


@router.get("/admin/enterprises")
async def list_enterprises(user: dict = Depends(require_role("superadmin"))):
    """Every enterprise on the platform + roll-up KPIs. Sorted with the
    default SmartBooks record first, then by number of companies desc."""
    rows = await db.enterprises.find({}, {"_id": 0}).to_list(500)
    enriched = []
    for r in rows:
        stats = await _ent.rollup_stats(r["id"])
        enriched.append(_ent.serialize(r, stats=stats))
    enriched.sort(key=lambda e: (not e["is_default"], -e["companies_count"], e["name"].lower()))
    return {"enterprises": enriched}


@router.get("/admin/enterprises/{eid}")
async def get_enterprise(eid: str, user: dict = Depends(require_role("superadmin"))):
    """Detail: enterprise + KPI roll-ups + companies list report."""
    ent = await db.enterprises.find_one({"id": eid}, {"_id": 0})
    if not ent:
        raise HTTPException(404, "Enterprise not found")
    stats = await _ent.rollup_stats(eid)

    # Pros belonging to this enterprise (name + email so the detail page
    # can attribute each company to a specific accountant).
    pros = await db.users.find(
        {"id": {"$in": stats["pro_ids"]}},
        {"_id": 0, "id": 1, "name": 1, "email": 1, "branding": 1, "created_at": 1},
    ).to_list(500) if stats["pro_ids"] else []
    pros_by_id = {p["id"]: p for p in pros}

    # Companies list — build the "list report" the UI renders. Each row is
    # its own owner + managing-pro pair.
    if stats["company_ids"]:
        companies = await db.companies.find(
            {"id": {"$in": stats["company_ids"]}},
            {"_id": 0},
        ).to_list(2000)
    else:
        companies = []

    # Fetch owner (client) users in one shot for denormalized display.
    owners = await db.users.find(
        {"id": {"$in": stats["owner_ids"]}},
        {"_id": 0, "id": 1, "name": 1, "email": 1},
    ).to_list(2000) if stats["owner_ids"] else []
    owners_by_id = {o["id"]: o for o in owners}

    # Managing-pro per company: pull the "pro" membership row.
    pro_memberships = await db.memberships.find(
        {"company_id": {"$in": stats["company_ids"]}, "role": "pro"},
        {"_id": 0, "user_id": 1, "company_id": 1},
    ).to_list(4000) if stats["company_ids"] else []
    pro_by_company = {m["company_id"]: m["user_id"] for m in pro_memberships}

    company_rows = []
    for c in companies:
        owner_uid = c.get("owner_user_id")
        owner = owners_by_id.get(owner_uid, {})
        pro_uid = pro_by_company.get(c["id"])
        pro = pros_by_id.get(pro_uid, {})
        company_rows.append({
            "id": c["id"],
            "name": c.get("name") or "",
            "business_type": c.get("business_type") or "",
            "reporting_basis": c.get("reporting_basis") or "accrual",
            "onboarding_complete": bool(c.get("onboarding_complete")),
            "created_at": c.get("created_at"),
            "owner_id": owner_uid,
            "owner_name": owner.get("name") or "",
            "owner_email": owner.get("email") or "",
            "pro_id": pro_uid,
            "pro_name": pro.get("name") or "",
            "pro_email": pro.get("email") or "",
            # Phase B/C billing fields — may be None until Add-Client modal
            # captures them. Frontend renders "—" for blanks.
            "billing_payer": c.get("billing_payer"),
            "billing_product": c.get("billing_product"),
            "billing_discount": c.get("billing_discount"),
            "billing_state": c.get("billing_state") or "pending",
        })
    # Newest companies first — most useful for a Superadmin sanity check.
    company_rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)

    return {
        "enterprise": _ent.serialize(ent, stats=stats),
        "pros": [
            {
                "id": p["id"],
                "name": p.get("name") or "",
                "email": p.get("email") or "",
                "firm_name": (p.get("branding") or {}).get("firm_name") or None,
                "joined_at": p.get("created_at"),
            } for p in pros
        ],
        "companies": company_rows,
    }


@router.patch("/admin/enterprises/{eid}")
async def patch_enterprise(eid: str, inp: EnterprisePatch,
                           user: dict = Depends(require_role("superadmin"))):
    ent = await db.enterprises.find_one({"id": eid})
    if not ent:
        raise HTTPException(404, "Enterprise not found")

    updates: dict = {}
    if inp.name is not None:
        name = inp.name.strip()
        if not name:
            raise HTTPException(400, "Enterprise name cannot be empty.")
        if len(name) > 80:
            raise HTTPException(400, "Enterprise name must be 80 characters or less.")
        updates["name"] = name
    if inp.free_user_allotment is not None:
        updates["free_user_allotment"] = int(inp.free_user_allotment)
    if inp.default_product is not None:
        if inp.default_product not in _ent.BILLING_PRODUCTS:
            raise HTTPException(
                400,
                f"default_product must be one of {list(_ent.BILLING_PRODUCTS)}",
            )
        updates["default_product"] = inp.default_product
    if inp.default_discount is not None:
        updates["default_discount"] = bool(inp.default_discount)

    if not updates:
        # No-op — return the current snapshot so the frontend can still
        # display a fresh timestamp.
        stats = await _ent.rollup_stats(eid)
        return {"enterprise": _ent.serialize(ent, stats=stats)}

    updates["updated_at"] = now_iso()
    await db.enterprises.update_one({"id": eid}, {"$set": updates})
    ent = await db.enterprises.find_one({"id": eid}, {"_id": 0})
    stats = await _ent.rollup_stats(eid)
    return {"enterprise": _ent.serialize(ent, stats=stats)}



@router.get("/admin/enterprises-report")
async def enterprises_report(user: dict = Depends(require_role("superadmin"))):
    """One-shot payload for the Superadmin dashboard's collapsible
    Enterprises → Clients report. Each row is an Enterprise with a
    nested `clients` list (owner users) — each client carries their
    per-company details so the row can expand two-levels deep on the
    frontend without another fetch.
    """
    ents = await db.enterprises.find({}, {"_id": 0}).to_list(500)
    out = []
    for ent in ents:
        stats = await _ent.rollup_stats(ent["id"])
        pro_ids = stats["pro_ids"]
        company_ids = stats["company_ids"]
        owner_ids = stats["owner_ids"]

        # Owner-to-company map for this enterprise's scope.
        owner_companies: dict[str, list[dict]] = {}
        if company_ids:
            companies = await db.companies.find(
                {"id": {"$in": company_ids}}, {"_id": 0},
            ).to_list(2000)
            for c in companies:
                owner_uid = c.get("owner_user_id")
                if not owner_uid:
                    continue
                owner_companies.setdefault(owner_uid, []).append({
                    "id": c["id"],
                    "name": c.get("name") or "",
                    "business_type": c.get("business_type") or "",
                    "onboarding_complete": bool(c.get("onboarding_complete")),
                    "billing_payer": c.get("billing_payer"),
                    "billing_product": c.get("billing_product"),
                    "billing_discount": bool(c.get("billing_discount")),
                    "billing_state": c.get("billing_state") or "pending",
                    "created_at": c.get("created_at"),
                })

        # Fetch owner user docs so we can render name + email.
        owners = await db.users.find(
            {"id": {"$in": owner_ids}},
            {"_id": 0, "id": 1, "name": 1, "email": 1, "created_at": 1},
        ).to_list(2000) if owner_ids else []
        clients_rows = []
        for o in owners:
            cos = owner_companies.get(o["id"], [])
            cos.sort(key=lambda x: x.get("created_at") or "", reverse=True)
            clients_rows.append({
                "id": o["id"],
                "name": o.get("name") or "",
                "email": o.get("email") or "",
                "joined_at": o.get("created_at"),
                "company_count": len(cos),
                "companies": cos,
            })
        clients_rows.sort(key=lambda r: (-r["company_count"], (r["name"] or r["email"]).lower()))

        out.append({
            "enterprise": _ent.serialize(ent, stats=stats),
            "clients": clients_rows,
        })
    # Default first, then most companies desc.
    out.sort(key=lambda x: (not x["enterprise"]["is_default"], -x["enterprise"]["companies_count"], x["enterprise"]["name"].lower()))
    return {"rows": out}



# ----------------------- Enterprise consolidated billing (Phase D) -----

@router.get("/admin/enterprises/{eid}/invoices")
async def list_enterprise_invoices(
    eid: str,
    user: dict = Depends(require_role("superadmin")),
):
    """Historical monthly invoices for one enterprise, newest first."""
    rows = await db.enterprise_invoices.find(
        {"enterprise_id": eid}, {"_id": 0},
    ).sort("month_key", -1).to_list(120)
    return {"invoices": rows}


class BillNowIn(BaseModel):
    """Optional overrides for the manual bill-now endpoint."""
    month_key: Optional[str] = None      # "YYYY-MM"; defaults to prior month
    dry_run: bool = False


@router.post("/admin/enterprises/{eid}/bill-now")
async def bill_enterprise_now(
    eid: str,
    inp: BillNowIn,
    user: dict = Depends(require_role("superadmin")),
):
    """Manually kick off billing for one enterprise (superadmin only).

    Useful for (a) smoke-testing the flow, (b) catching up an enterprise
    that missed the scheduled run, or (c) previewing the plan via
    `dry_run=true` before actually creating a Stripe invoice.
    """
    import enterprise_billing_scheduler as _ebs
    month_key = inp.month_key or _ebs._prior_month_key(
        datetime.now(_ebs.BILLING_TZ)
    )
    res = await _ebs.bill_enterprise(eid, month_key=month_key, dry_run=inp.dry_run)
    res["month_key"] = month_key
    return res



class BulkDeleteByOwnerIn(BaseModel):
    """Bulk-delete request. Provide a non-empty list of owner emails +
    the literal string ``I UNDERSTAND`` as the confirmation token so
    accidents are impossible.

    Set ``dry_run=True`` first to preview the blast radius (returns
    counts + company names without deleting anything). Set
    ``delete_users=True`` to also remove the owner user rows themselves
    after their last-company deletion — handy for test-data cleanup.
    """
    owner_emails: list[str]
    confirm: str
    dry_run: bool = False
    delete_users: bool = False


@router.post("/admin/companies/bulk-delete-by-owner")
async def admin_bulk_delete_by_owner(
    inp: BulkDeleteByOwnerIn,
    user: dict = Depends(require_role("superadmin")),
):
    """Nuke every company owned by any of the given emails, along with
    all per-company data (transactions, invoices, memberships, etc).
    Superadmin-only, requires the literal confirmation string, and
    supports dry-run so you can preview before firing.
    """
    if inp.confirm.strip() != "I UNDERSTAND":
        raise HTTPException(400, "Pass confirm='I UNDERSTAND' to proceed.")
    emails = [e.strip().lower() for e in inp.owner_emails if e and e.strip()]
    if not emails:
        raise HTTPException(400, "owner_emails must be a non-empty list.")

    # Match users case-insensitively (users often type mixed-case emails
    # into signup but the DB has lower-case; also match either shape to
    # cover legacy accounts).
    owner_users = await db.users.find({
        "email": {"$in": emails + [e.upper() for e in emails]}
    }, {"_id": 0}).to_list(1000)
    owner_ids = [u["id"] for u in owner_users]
    if not owner_ids:
        return {"dry_run": inp.dry_run, "matched_users": [], "companies": [], "note": "No users matched."}

    # Find every company where these users are the OWNER (not just a
    # member; deleting a company where a Pro happens to be a member
    # would be catastrophic).
    owner_memberships = await db.memberships.find({
        "user_id": {"$in": owner_ids}, "role": "owner",
    }).to_list(2000)
    company_ids = list({m["company_id"] for m in owner_memberships})
    companies = await db.companies.find(
        {"id": {"$in": company_ids}}, {"_id": 0, "id": 1, "name": 1, "billing_state": 1}
    ).to_list(2000)

    plan = {
        "dry_run": inp.dry_run,
        "matched_users": [{"id": u["id"], "email": u.get("email"), "name": u.get("name")} for u in owner_users],
        "companies": [{"id": c["id"], "name": c.get("name"), "billing_state": c.get("billing_state")} for c in companies],
        "delete_users": inp.delete_users,
    }
    if inp.dry_run:
        plan["would_delete_records_from"] = [
            "companies", "accounts", "transactions", "journal_entries",
            "invoices", "bills", "customers", "vendors", "payments",
            "onboarding_state", "plaid_items", "veryfi_uploads",
            "ai_activity_log", "rules", "audit_logs", "period_locks",
            "memberships", "pro_alerts (company-scoped)",
        ]
        if inp.delete_users:
            plan["would_delete_records_from"].append(f"users ({len(owner_users)})")
        return plan

    # Real delete — mirror the per-company collections list from
    # companies.py delete_company + add pro_alerts.
    per_company_collections = [
        "accounts", "transactions", "journal_entries", "invoices", "bills",
        "customers", "vendors", "payments", "onboarding_state",
        "plaid_items", "veryfi_uploads", "ai_activity_log", "rules",
        "audit_logs", "period_locks", "memberships", "pro_alerts",
    ]
    per_collection_totals: dict[str, int] = {}
    for cid in company_ids:
        for coll in per_company_collections:
            try:
                r = await db[coll].delete_many({"company_id": cid})
                if r.deleted_count:
                    per_collection_totals[coll] = per_collection_totals.get(coll, 0) + r.deleted_count
            except Exception:
                pass
    r = await db.companies.delete_many({"id": {"$in": company_ids}})
    per_collection_totals["companies"] = r.deleted_count

    if inp.delete_users:
        # Only delete users who no longer own any other company (should
        # be zero after the mass-delete above, but check defensively).
        remaining = await db.memberships.count_documents({
            "user_id": {"$in": owner_ids}, "role": "owner",
        })
        if remaining == 0:
            ur = await db.users.delete_many({"id": {"$in": owner_ids}})
            per_collection_totals["users"] = ur.deleted_count
            # Also drop any dangling non-owner memberships on those user ids
            mr = await db.memberships.delete_many({"user_id": {"$in": owner_ids}})
            if mr.deleted_count:
                per_collection_totals["memberships"] = per_collection_totals.get("memberships", 0) + mr.deleted_count

    plan["records_removed"] = per_collection_totals
    return plan
