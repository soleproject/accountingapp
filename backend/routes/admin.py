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
