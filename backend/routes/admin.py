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




