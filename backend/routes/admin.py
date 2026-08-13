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


# ──────────────────────────────────────────────────────────────────────
# AI Spend — per-company reporting + one-shot backfill
# ──────────────────────────────────────────────────────────────────────
# The counter on `companies.ai_spend.{YYYY-MM}` is written by every LLM
# call now (Feb 2026 unification). These endpoints let ops see the
# picture without shelling into the database.

@router.get("/admin/ai-spend/by-company")
async def admin_ai_spend_by_company(
    period: Optional[str] = Query(None, description="YYYY-MM; defaults to current UTC month"),
    revenue_per_seat_usd: float = Query(75.0, ge=0, description="Used to compute AI-cost-as-share-of-revenue"),
    user: dict = Depends(require_role("superadmin")),
):
    """Every company's LLM spend for a period, ranked worst-first.

    For each company returns:
      - spent_usd (this period, all features)
      - cap_usd (0 = unlimited)
      - % of revenue eaten (spent / revenue_per_seat_usd)
      - top 3 features driving the spend (from ai_spend_daily)
      - status: over_cap | warn (>=80%) | ok
    """
    from datetime import datetime as _dt, timezone as _tz
    p = period or _dt.now(_tz.utc).strftime("%Y-%m")

    # 1) Grab the current-period counter for every company.
    companies = await db.companies.find(
        {}, {"id": 1, "name": 1, "ai_spend": 1, "insights_spend": 1,
             "ai_spend_cap_cents": 1},
    ).to_list(20000)

    # 2) Aggregate top features per company from ai_spend_daily (or fall
    #    back to ai_usage_events if the daily rollup is empty for a co).
    day_prefix = p  # YYYY-MM matches YYYY-MM-DD prefix on `day`
    top_features_pipeline = [
        {"$match": {"day": {"$regex": f"^{day_prefix}"}}},
        {"$group": {
            "_id": {"company_id": "$company_id", "feature": "$feature"},
            "cost_cents": {"$sum": "$cost_cents"},
            "events": {"$sum": "$events"},
        }},
        {"$sort": {"cost_cents": -1}},
    ]
    features_by_company: dict[str, list] = {}
    async for r in db.ai_spend_daily.aggregate(top_features_pipeline):
        cid = r["_id"]["company_id"]
        features_by_company.setdefault(cid, []).append({
            "feature": r["_id"]["feature"],
            "cost_usd": round(r["cost_cents"] / 100.0, 4),
            "events": r["events"],
        })

    rows = []
    for c in companies:
        ai_cents = float((c.get("ai_spend") or {}).get(p) or 0)
        legacy = float((c.get("insights_spend") or {}).get(p) or 0)
        spent_cents = ai_cents + legacy
        if spent_cents <= 0 and not features_by_company.get(c["id"]):
            continue  # skip companies with zero AI activity
        cap_cents = float(c.get("ai_spend_cap_cents") or 0)
        share = (spent_cents / 100.0) / revenue_per_seat_usd \
            if revenue_per_seat_usd > 0 else 0.0
        status = "ok"
        if cap_cents > 0:
            if spent_cents >= cap_cents:
                status = "over_cap"
            elif spent_cents >= 0.8 * cap_cents:
                status = "warn"
        rows.append({
            "company_id": c["id"],
            "name": c.get("name") or "(unnamed)",
            "spent_usd": round(spent_cents / 100.0, 4),
            "cap_usd": round(cap_cents / 100.0, 2),
            "share_of_revenue": round(share, 4),
            "share_of_revenue_pct": round(share * 100, 2),
            "top_features": features_by_company.get(c["id"], [])[:3],
            "status": status,
        })

    rows.sort(key=lambda r: r["spent_usd"], reverse=True)
    return {
        "period": p,
        "revenue_per_seat_usd": revenue_per_seat_usd,
        "companies_with_activity": len(rows),
        "total_spent_usd": round(sum(r["spent_usd"] for r in rows), 4),
        "average_spent_usd_per_active": round(
            sum(r["spent_usd"] for r in rows) / max(len(rows), 1), 4,
        ),
        "worst_offender": rows[0] if rows else None,
        "rows": rows,
    }


@router.post("/admin/ai-spend/backfill")
async def admin_ai_spend_backfill(
    user: dict = Depends(require_role("superadmin")),
):
    """One-shot backfill — rebuilds `companies.ai_spend` + `ai_spend_daily`
    from every event in `ai_usage_events`. Idempotent — clears both
    derived stores first, then rebuilds. Safe to call anytime the
    counters drift or after schema changes."""
    from ai_usage import backfill_ai_spend_counters
    return await backfill_ai_spend_counters()


class AiCapOverrideIn(BaseModel):
    """One-click override — used from the admin UI to raise/lower a
    specific company's cap without a deploy. Cap is stored in CENTS on
    the company doc so it can be shown to the user in dollars without
    float rounding drift."""
    cap_usd: float = Field(ge=0, le=10000, description="Monthly cap in dollars. 0 = unlimited.")
    hard_block: bool = Field(default=False, description="If true, calls over the cap 402. Default: soft (warn but allow).")


@router.patch("/admin/ai-spend/companies/{cid}/cap")
async def admin_set_company_ai_cap(
    cid: str, inp: AiCapOverrideIn,
    user: dict = Depends(require_role("superadmin")),
):
    """Set (or clear) a single company's monthly AI cap. Takes effect
    immediately — the next LLM call re-reads the doc.

    `hard_block=false` (default) → soft cap: over-cap events are
    logged & counted on `ai_spend_over_cap_events`, but calls still
    succeed. Use this for the default policy the user asked for.

    `hard_block=true` → 402 Payment Required on the next call over
    cap. Reserved for known-abusive tenants and monthly-close
    override cases.
    """
    cap_cents = float(inp.cap_usd) * 100.0
    res = await db.companies.update_one(
        {"id": cid},
        {"$set": {
            "ai_spend_cap_cents": cap_cents,
            "ai_spend_hard_block": bool(inp.hard_block),
            "ai_spend_cap_updated_by": user["id"],
            "ai_spend_cap_updated_at": now_iso(),
            "updated_at": now_iso(),
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Company not found")
    return {
        "company_id": cid,
        "cap_usd": inp.cap_usd,
        "cap_cents": cap_cents,
        "hard_block": bool(inp.hard_block),
    }


class AiCapDefaultIn(BaseModel):
    default_cap_usd: float = Field(ge=0, le=10000)


@router.post("/admin/ai-spend/default-cap/apply-to-all-uncapped")
async def admin_apply_default_ai_cap(
    inp: AiCapDefaultIn,
    user: dict = Depends(require_role("superadmin")),
):
    """Apply a default AI-spend cap (in USD) to every company that
    doesn't already have one set. Idempotent — never lowers an existing
    cap, never touches hard_block. Use this once at rollout to seed the
    platform-wide default; per-company overrides go through
    `admin_set_company_ai_cap`.
    """
    cap_cents = float(inp.default_cap_usd) * 100.0
    res = await db.companies.update_many(
        {"$or": [
            {"ai_spend_cap_cents": {"$exists": False}},
            {"ai_spend_cap_cents": 0},
            {"ai_spend_cap_cents": None},
        ]},
        {"$set": {
            "ai_spend_cap_cents": cap_cents,
            "ai_spend_cap_default_source": user["id"],
            "ai_spend_cap_updated_at": now_iso(),
            "updated_at": now_iso(),
        }},
    )
    return {
        "companies_updated": res.modified_count,
        "default_cap_usd": inp.default_cap_usd,
    }


# ──────────────────────────────────────────────────────────────────────
# Background-job DLQ visibility (Feb 2026)
# ──────────────────────────────────────────────────────────────────────
# Failed background jobs (Plaid sync, contact backfill, receipt OCR)
# now retry with exponential backoff up to MAX_ATTEMPTS, then land in
# `status="dlq"`. These endpoints let ops see what's stuck and retry
# individual rows without a deploy.

@router.get("/admin/jobs/dlq")
async def admin_jobs_dlq(
    kind: Optional[str] = Query(None, description="Filter by job kind (e.g. plaid_manual_sync)"),
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(require_role("superadmin")),
):
    """Every job in the dead-letter queue, newest first. Also includes
    `retry_scheduled` rows so ops can see what's in-flight for retry."""
    q: dict = {"status": {"$in": ["dlq", "retry_scheduled"]}}
    if kind:
        q["kind"] = kind
    rows = await db.sync_jobs.find(q).sort("first_failed_at", -1).limit(limit).to_list(limit)
    # Company-name join for the UI (single find_all in one shot).
    cids = list({r.get("company_id") for r in rows if r.get("company_id")})
    company_names = {}
    if cids:
        async for c in db.companies.find({"id": {"$in": cids}}, {"id": 1, "name": 1}):
            company_names[c["id"]] = c.get("name")
    out = []
    for r in rows:
        r.pop("_id", None)
        r["company_name"] = company_names.get(r.get("company_id"))
        # Truncate error trace so the JSON payload stays reasonable.
        err = r.get("last_error") or r.get("error") or ""
        r["last_error_snippet"] = (err[:500] + " ...[truncated]") if len(err) > 500 else err
        out.append(r)
    counts = {"dlq": 0, "retry_scheduled": 0}
    for r in rows:
        counts[r.get("status", "dlq")] = counts.get(r.get("status", "dlq"), 0) + 1
    return {"counts": counts, "rows": out}


@router.post("/admin/jobs/{job_id}/retry")
async def admin_retry_dlq_job(
    job_id: str,
    user: dict = Depends(require_role("superadmin")),
):
    """One-click retry — resets attempts to 0 and re-enqueues.
    Idempotent. Only works on `dlq` or `failed` rows."""
    from job_queue import retry_dlq_job as _retry
    result = await _retry(job_id)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("reason") or "retry failed")
    return result


@router.get("/admin/ledger-integrity")
async def admin_ledger_integrity(
    user: dict = Depends(require_role("superadmin")),
):
    """Detect ledger corruption from partial multi-doc writes.

    Four checks — all run against live data. If any return non-zero
    counts, ops has real work to do:

      A. JE line sums don't tie (debits != credits) — cardinal double
         entry violation.
      B. JE doc-level `total_debit` / `total_credit` disagree with line
         sums — latent reporting bug, doesn't hit balance-sheet math
         today but any code path reading the header field is wrong.
      C. Invoices / Bills with impossible `balance_due` (negative, or
         > total) — points to partial writes during payment apply.
      D. Payments where the linked invoice/bill status still says
         'sent' / 'received' with a positive balance despite a payment
         landing — the payment insert succeeded but the balance update
         didn't.
    """
    unbalanced = []
    stated_wrong_ct = 0
    async for j in db.journal_entries.find({}):
        lines = j.get("lines") or []
        d_lines = round(sum(float(l.get("debit") or 0) for l in lines), 2)
        c_lines = round(sum(float(l.get("credit") or 0) for l in lines), 2)
        d_stated = float(j.get("total_debit") or 0)
        c_stated = float(j.get("total_credit") or 0)
        if abs(d_lines - c_lines) > 0.005:
            unbalanced.append({
                "id": j.get("id"), "company_id": j.get("company_id"),
                "date": j.get("date"), "debit": d_lines, "credit": c_lines,
                "diff": round(d_lines - c_lines, 4),
                "memo": (j.get("memo") or "")[:80],
            })
        if abs(d_lines - d_stated) > 0.005 or abs(c_lines - c_stated) > 0.005:
            stated_wrong_ct += 1

    bad_inv = await db.invoices.count_documents({
        "$expr": {"$or": [
            {"$lt": ["$balance_due", -0.005]},
            {"$gt": [{"$subtract": ["$balance_due", "$total"]}, 0.005]},
        ]},
    })
    bad_bill = await db.bills.count_documents({
        "$expr": {"$or": [
            {"$lt": ["$balance_due", -0.005]},
            {"$gt": [{"$subtract": ["$balance_due", "$total"]}, 0.005]},
        ]},
    })

    # D — payments landed but the linked doc's status/balance_due still
    # says unpaid. Sample the 200 most recent payments.
    orphan_payments = []
    async for p in db.payments.find({}).sort("created_at", -1).limit(200):
        cid = p.get("company_id"); amt = float(p.get("amount") or 0)
        for coll, fk in (("invoices", "linked_invoice_id"), ("bills", "linked_bill_id")):
            ref = p.get(fk)
            if not ref:
                continue
            doc = await db[coll].find_one({"id": ref, "company_id": cid})
            if not doc:
                orphan_payments.append({
                    "payment_id": p["id"], "company_id": cid,
                    "kind": coll[:-1], "missing_ref": ref,
                })
                continue
            # If balance_due still equals the total AND amount > 0, the
            # balance update never applied.
            if abs(float(doc.get("balance_due") or 0) - float(doc.get("total") or 0)) < 0.005 \
               and amt > 0.005 and (doc.get("status") in ("sent", "received", "draft", None)):
                orphan_payments.append({
                    "payment_id": p["id"], "company_id": cid,
                    "kind": coll[:-1], "ref": ref,
                    "reason": "payment landed but linked doc's balance untouched",
                })

    return {
        "unbalanced_jes": unbalanced,
        "unbalanced_je_count": len(unbalanced),
        "stated_totals_mismatch_count": stated_wrong_ct,
        "invoices_impossible_balance": bad_inv,
        "bills_impossible_balance": bad_bill,
        "orphan_payments": orphan_payments,
        "orphan_payment_count": len(orphan_payments),
        "clean": (len(unbalanced) == 0 and bad_inv == 0 and bad_bill == 0
                  and len(orphan_payments) == 0),
    }



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
    # When a Partner creates an enterprise WITH an owner (email
    # provided or an existing pro is attached), they can burn one of
    # their (max 2) WL comps to give that owner white-label for free.
    # Ignored for non-partner callers and for enterprises without an
    # owner — the flag only takes effect when there's a target user
    # to stamp. Enforced against the partner's remaining quota;
    # rejects with 400 if the partner is at the cap already.
    comp_owner_whitelabel: bool = False


# Feb 2026 policy — a Partner can comp white-label for at most 2
# owners in their tree (total across every enterprise they've
# provisioned). Superadmin bypasses this via the existing
# `POST /admin/pros/{pro_id}/whitelabel-comp` endpoint.
_PARTNER_MAX_WL_COMPS = 2


async def _partner_wl_comps_used(partner_id: str) -> int:
    """Count of pros in the partner's tree currently holding a
    non-revoked WL comp. Used both to gate the create-time toggle and
    to surface the "X of 2 used" hint in the UI. A revoked comp
    (`whitelabel_comp = False`) doesn't count — reinstating a
    previously-revoked partner would just fill an empty slot."""
    return await db.users.count_documents({
        "partner_id": partner_id,
        "branding.whitelabel_comp": True,
    })


# Feb 2026 policy — Partners get a per-enterprise Free-Spots cap. They
# resell paid seats, so unlimited comp'ing would eat their margin. The
# cap is enforced BOTH on create (`POST /admin/enterprises`) and on
# subsequent edits (`PATCH /admin/enterprises/{eid}`) so a Partner can't
# create an enterprise with 2 spots and then raise it to 100 later.
# Superadmin bypass — they can raise the allotment to anything, so
# comping past the cap remains a supported flow via the admin UI.
_PARTNER_MAX_FREE_SPOTS = 2


@router.post("/admin/enterprises")
async def create_enterprise(
    payload: EnterpriseCreate,
    user: dict = Depends(require_role("superadmin", "partner")),
):
    """Superadmin OR Partner — mint a new Enterprise. Slug is auto-
    generated from the name (kebab-case) with de-dupe suffixing when
    necessary. When the caller is a Partner, the enterprise is
    stamped with `partner_id` so it appears in the Partner's scoped
    dashboard rollups.

    When `owner_email` is supplied we ALSO provision a Pro user for
    that email — creating one with `must_set_password=True` if it
    doesn't already exist, and dispatching a Resend magic-link
    welcome email so the new owner can log in and set their password.
    """
    # Partner free-spots cap — reject before we do any DB work so
    # the caller gets an immediate 400. UI clamps the input too but
    # this is the defense-in-depth path against direct API calls.
    if user.get("role") == "partner" and payload.free_user_allotment > _PARTNER_MAX_FREE_SPOTS:
        raise HTTPException(
            400,
            f"Partners can allot at most {_PARTNER_MAX_FREE_SPOTS} free spots "
            f"per enterprise. Ask a superadmin to raise the cap if the client "
            f"needs more comp'd seats.",
        )
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
        # Partner attribution — when the caller is a Partner, tag the
        # enterprise so it lands in the Partner's scoped dashboard
        # rollups. Superadmin-created enterprises leave this unset.
        **({"partner_id": user["id"]} if user.get("role") == "partner" else {}),
        "created_at": now,
        "updated_at": now,
    }
    await db.enterprises.insert_one(ent)
    if owner_user_id:
        # Stamp `enterprise_id` so the pro's dashboard scopes correctly
        # and the branding cascade can walk owner_user -> enterprise_id
        # -> enterprise.partner_id -> partner.branding.
        update: dict = {"enterprise_id": ent["id"]}
        # If the caller was a Partner, also directly stamp
        # `partner_id` on the enterprise-owner Pro so the cascade has
        # a one-hop path (`user.partner_id` -> partner). Redundant
        # with the enterprise.partner_id path, but resilient if the
        # enterprise doc is ever deleted or migrated separately.
        if user.get("role") == "partner":
            update["partner_id"] = user["id"]
        await db.users.update_one({"id": owner_user_id}, {"$set": update})

    # WL-comp burn (Feb 2026) — a Partner can flip on white-label for
    # the enterprise owner in the same request they use to provision
    # the enterprise. Cap at `_PARTNER_MAX_WL_COMPS` (2) across their
    # entire tree. We enforce AFTER inserting the enterprise so that
    # if the cap is exceeded we roll back the enterprise + provisioned
    # owner rather than leaving a partially-configured record.
    comp_applied = False
    if (
        payload.comp_owner_whitelabel
        and user.get("role") == "partner"
        and owner_user_id
    ):
        used = await _partner_wl_comps_used(user["id"])
        # Don't double-count if the owner ALREADY has a WL comp
        # (idempotent for the "attach existing pro" flow).
        already_comped = False
        target = await db.users.find_one(
            {"id": owner_user_id},
            {"branding.whitelabel_comp": 1, "_id": 0},
        )
        if target and (target.get("branding") or {}).get("whitelabel_comp"):
            already_comped = True

        if not already_comped and used >= _PARTNER_MAX_WL_COMPS:
            # Roll back the enterprise + owner we just wrote.
            await db.enterprises.delete_one({"id": ent["id"]})
            if owner_provisioned:
                await db.users.delete_one({"id": owner_user_id})
            raise HTTPException(
                400,
                f"You've already comp'd white-label for {used} of "
                f"{_PARTNER_MAX_WL_COMPS} allowed owners. Revoke one from "
                f"an existing enterprise before granting another.",
            )

        if not already_comped:
            await db.users.update_one(
                {"id": owner_user_id},
                {"$set": {
                    "branding.whitelabel_comp": True,
                    "branding.whitelabel_comp_at": now,
                    "branding.whitelabel_comp_by": user["id"],
                }},
            )
            comp_applied = True

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

            # Resolve the effective brand for the invitee. Priority:
            # 1) The inviting partner's unlocked private label — the
            #    email should feel like it's coming from THEIR firm.
            # 2) Superadmin / non-branded caller → fall back to
            #    SmartBooks (brand_name=None + platform base URL).
            brand_name = None
            brand_slug = None
            brand_signin_sub = None
            if user.get("role") == "partner":
                pb = user.get("branding") or {}
                partner_wl_unlocked = bool(
                    pb.get("whitelabel_comp")
                    or pb.get("whitelabel_paid")
                    or pb.get("whitelabel_unlocked")
                )
                if partner_wl_unlocked:
                    brand_name = pb.get("firm_name") or user.get("name")
                    # Two subdomain fields serve two purposes:
                    #   • `subdomain_slug` — routes the *magic-link
                    #     URL host* when `PRIVATE_LABEL_HOST_TEMPLATE`
                    #     env is set (e.g. axiompartners.accountingapp.ai)
                    #   • `signin_subdomain` — resolves the *branding
                    #     visuals* on the set-password page via the
                    #     public `/branding/by-subdomain/{sub}` lookup.
                    # Not every partner has both; falling back through
                    # them lets any single one drive the branding.
                    brand_slug = (
                        pb.get("subdomain_slug")
                        or pb.get("signin_subdomain")
                        or pb.get("subdomain")
                        or pb.get("slug")
                        or None
                    )
                    brand_signin_sub = (
                        pb.get("signin_subdomain")
                        or pb.get("subdomain_slug")
                        or pb.get("subdomain")
                        or None
                    )
            magic_token = await mint_password_set_token(owner_user_id, purpose="welcome")
            magic_base = f"{public_base_url(firm_slug=brand_slug)}/set-password/{magic_token}"
            # Append `?firm=<slug>` so the set-password frontend can
            # look up the partner's branding via
            # `/branding/by-subdomain/{slug}` and render THEIR logo/
            # firm name instead of "SmartBooks" — this fires even
            # when the host is still on `app.smartbookssoftware.ai`
            # (e.g. `PRIVATE_LABEL_HOST_TEMPLATE` isn't configured
            # yet in prod).
            if brand_signin_sub:
                from urllib.parse import quote
                magic_url = f"{magic_base}?firm={quote(brand_signin_sub)}"
            else:
                magic_url = magic_base
            # Body copy — swap "SmartBooks" in the role blurb for the
            # active brand so it reads consistently with subject/H1/
            # footer.
            active_brand = (brand_name or "SmartBooks").strip()
            role_desc = (
                f"you'll own the {ent['name']} enterprise on {active_brand} "
                f"and can invite Pros, add clients, and manage billing."
            )
            subject, html = _tmpl.team_invite(
                invitee_name=(payload.owner_name or "there"),
                inviter_name=user.get("name") or user.get("email") or active_brand,
                role_label="Enterprise owner",
                role_description=role_desc,
                company_names=[],
                magic_url=magic_url,
                brand_name=brand_name,
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
        "comp_applied": comp_applied,
    }


@router.post("/admin/impersonate/{target_user_id}")
async def impersonate_user(
    target_user_id: str,
    user: dict = Depends(require_role("superadmin")),
):
    """Superadmin — obtain a fresh JWT for another user so the admin
    can drive the platform AS them (customer support / QA). The
    frontend stashes the ORIGINAL superadmin token in localStorage
    before swapping in the impersonation token so "Stop impersonating"
    can restore the session in one click. Audited to `admin_audit_log`
    with kind=`impersonate_start` (superadmin_id, target_user_id,
    timestamp) — non-blocking if the collection isn't seeded.
    """
    target = await db.users.find_one({"id": target_user_id})
    if not target:
        raise HTTPException(404, "User not found")
    # Refuse to impersonate another superadmin — that just muddies the
    # audit trail and offers no support benefit.
    if target.get("role") == "superadmin":
        raise HTTPException(400, "Cannot impersonate another superadmin.")
    token = create_token(target["id"], target["role"])
    try:
        await db.admin_audit_log.insert_one({
            "id": str(uuid.uuid4()),
            "kind": "impersonate_start",
            "superadmin_id": user["id"],
            "superadmin_email": user.get("email"),
            "target_user_id": target["id"],
            "target_email": target.get("email"),
            "target_role": target.get("role"),
            "at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:  # noqa: BLE001 — audit failure never blocks impersonation
        pass
    # Structured audit — every impersonation lands in the unified
    # audit_events collection so the /audit-log page can surface it
    # alongside every action the superadmin subsequently takes AS the
    # target. `actor` is the SUPERADMIN (not the target) so the audit
    # log clearly shows who triggered the impersonation.
    try:
        import audit as _audit
        _audit.log_event(
            event_type=_audit.EVENT_IMPERSONATE_START,
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            entity_type="user", entity_id=target["id"],
            summary=f"{user.get('email')} started impersonating {target.get('email')}",
            metadata={
                "target_user_id":   target["id"],
                "target_email":     target.get("email"),
                "target_role":      target.get("role"),
            },
        )
    except Exception:  # noqa: BLE001
        pass
    return {
        "token": token,
        "user": {
            "id": target["id"],
            "email": target["email"],
            "name": target.get("name") or target["email"],
            "role": target["role"],
        },
    }


class SuperadminGrantIn(BaseModel):
    email: EmailStr
    # Optional display name — only used when creating a brand-new user
    # from this endpoint. If the email already exists we keep the
    # user's current name and just flip their role.
    name: Optional[str] = None


# ---------- Owner-superadmin gate --------------------------------------
# Only ONE superadmin (by convention) is allowed to grant/revoke other
# superadmins. Everyone else at role=superadmin can still access the
# panel and other admin actions, but the promote/demote surface is
# fenced to this single email so no one accidentally locks the owner
# out. Configurable via env for redeploys; defaults to the initial
# platform owner.
OWNER_SUPERADMIN_EMAIL = os.environ.get(
    "OWNER_SUPERADMIN_EMAIL", "michael@bigsaas.ai",
).lower()


def require_owner_superadmin(user: dict = Depends(require_role("superadmin"))) -> dict:
    """Second gate on top of `require_role("superadmin")`. Even other
    superadmins can't hit these endpoints — only the platform owner."""
    if (user.get("email") or "").lower() != OWNER_SUPERADMIN_EMAIL:
        raise HTTPException(
            403,
            "Only the platform owner can grant or revoke superadmin access.",
        )
    return user


@router.get("/admin/superadmins")
async def list_superadmins(
    user: dict = Depends(require_owner_superadmin),
):
    """Return every user with role=superadmin. The owner (per
    `OWNER_SUPERADMIN_EMAIL`) is flagged so the UI can hide the revoke
    button on that row."""
    rows: list[dict] = []
    async for u in db.users.find({"role": "superadmin"}).sort("created_at", 1):
        email = (u.get("email") or "").lower()
        rows.append({
            "id": u.get("id"),
            "email": u.get("email"),
            "name": u.get("name"),
            "created_at": u.get("created_at"),
            "is_owner": email == OWNER_SUPERADMIN_EMAIL,
        })
    return {"items": rows, "owner_email": OWNER_SUPERADMIN_EMAIL}


@router.post("/admin/superadmins/{user_id}/revoke")
async def revoke_superadmin(
    user_id: str,
    user: dict = Depends(require_owner_superadmin),
):
    """Demote a superadmin back to `pro`. The owner cannot revoke
    themselves — that would lock the platform out of granting future
    superadmins."""
    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(404, "User not found.")
    if (target.get("email") or "").lower() == OWNER_SUPERADMIN_EMAIL:
        raise HTTPException(400, "Cannot revoke the platform owner.")
    if target.get("role") != "superadmin":
        raise HTTPException(400, f"User is not a superadmin (role={target.get('role')!r}).")
    now = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"role": "pro", "updated_at": now}},
    )
    try:
        await db.admin_audit_log.insert_one({
            "id": str(uuid.uuid4()),
            "kind": "superadmin_revoked",
            "granting_admin_id": user["id"],
            "granting_admin_email": user.get("email"),
            "target_user_id": user_id,
            "target_email": target.get("email"),
            "previous_role": "superadmin",
            "new_role": "pro",
            "at": now,
        })
    except Exception:  # noqa: BLE001
        pass
    return {
        "ok": True,
        "user": {
            "id": user_id,
            "email": target.get("email"),
            "name": target.get("name"),
            "role": "pro",
        },
    }


@router.post("/admin/superadmins")
async def grant_superadmin(
    payload: SuperadminGrantIn,
    user: dict = Depends(require_owner_superadmin),
):
    """Superadmin — promote an existing user (any role) to superadmin,
    OR create a brand-new superadmin from scratch. New users get a
    placeholder password + a 7-day magic-link welcome email so they
    can set their own credentials on first sign-in.

    Every grant is logged to `admin_audit_log` with kind=
    `superadmin_granted` (granting_admin_id, target_user_id, previous_
    role, timestamp) — non-blocking if the collection isn't seeded.
    """
    email_norm = str(payload.email).strip().lower()
    now = datetime.now(timezone.utc).isoformat()

    existing = await db.users.find_one({"email": email_norm})
    created = False
    previous_role = None
    email_status = None
    email_error = None
    magic_url_debug = None

    if existing:
        previous_role = existing.get("role")
        if previous_role == "superadmin":
            # Idempotent: no-op if they're already a superadmin.
            return {
                "created": False,
                "already_superadmin": True,
                "user": {
                    "id": existing["id"], "email": existing["email"],
                    "name": existing.get("name"), "role": "superadmin",
                },
            }
        await db.users.update_one(
            {"id": existing["id"]},
            {"$set": {"role": "superadmin", "updated_at": now}},
        )
        target_id = existing["id"]
        target_name = existing.get("name") or email_norm.split("@")[0]
    else:
        # Fresh user. Random placeholder password + magic-link welcome.
        import secrets as _secrets
        placeholder = hash_password(_secrets.token_urlsafe(48))
        target_id = str(uuid.uuid4())
        target_name = (payload.name or email_norm.split("@")[0]).strip()
        await db.users.insert_one({
            "id": target_id,
            "email": email_norm,
            "name": target_name,
            "password": placeholder,
            "role": "superadmin",
            "must_set_password": True,
            "created_at": now,
            "updated_at": now,
        })
        created = True
        # Dispatch a welcome magic-link so the new superadmin can set
        # their own password on first sign-in. Non-blocking — the user
        # still exists even if email delivery flops.
        try:
            from routes.auth import mint_password_set_token
            from email_dispatcher import dispatch, public_base_url
            import email_templates as _tmpl
            magic_token = await mint_password_set_token(target_id, purpose="welcome")
            magic_url = f"{public_base_url()}/set-password/{magic_token}"
            magic_url_debug = magic_url
            subject, html = _tmpl.team_invite(
                invitee_name=target_name,
                inviter_name=user.get("name") or user.get("email") or "SmartBooks",
                role_label="Platform Superadmin",
                role_description="you have full access to the SmartBooks platform — every firm, every company, every billing record. Use this power carefully.",
                company_names=[],
                magic_url=magic_url,
            )
            result = await dispatch(
                kind="team_invite",
                to=email_norm,
                subject=subject, html=html,
                initiating_user_id=user["id"],
                company_id=None,
                related={"target_user_id": target_id, "kind": "superadmin_welcome"},
            )
            email_status = result.get("status", "failed")
            email_error = result.get("error")
        except Exception as _exc:  # noqa: BLE001
            import logging as _lg
            _lg.getLogger(__name__).exception("Superadmin welcome email failed (user still created)")
            email_status = "failed"
            email_error = str(_exc)

    # Audit trail — never blocks the grant.
    try:
        await db.admin_audit_log.insert_one({
            "id": str(uuid.uuid4()),
            "kind": "superadmin_granted",
            "granting_admin_id": user["id"],
            "granting_admin_email": user.get("email"),
            "target_user_id": target_id,
            "target_email": email_norm,
            "previous_role": previous_role,
            "created_new_user": created,
            "at": now,
        })
    except Exception:  # noqa: BLE001
        pass

    return {
        "created": created,
        "already_superadmin": False,
        "previous_role": previous_role,
        "email_status": email_status,
        "email_error": email_error,
        # Included only so ops can copy/paste the link if the email queue
        # is down. Returned only on fresh-user creation.
        "magic_url": magic_url_debug if created else None,
        "user": {
            "id": target_id, "email": email_norm,
            "name": target_name, "role": "superadmin",
        },
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


# ------------------------------------------------------------------
# Affiliate payout console — close the loop between accrual and
# actually-paid. All endpoints return `paid_out_at` / `paid_out_by`
# fields on affected rows so the ledger stays audit-ready even after
# an admin marks something paid.
# ------------------------------------------------------------------
async def _resolve_users_map(user_ids: list[str]) -> dict[str, dict]:
    """Load a ``{user_id: user_doc}`` map for the ids in one round-trip."""
    if not user_ids:
        return {}
    docs = await db.users.find(
        {"id": {"$in": list(set(user_ids))}},
        {"id": 1, "email": 1, "name": 1, "referral_slug": 1,
         "branding": 1, "_id": 0},
    ).to_list(2000)
    return {u["id"]: u for u in docs}


@router.get("/admin/affiliate/payouts")
async def affiliate_payouts_overview(
    user: dict = Depends(require_role("superadmin")),
):
    """Per-affiliate accrued-vs-paid roll-up, sorted by outstanding
    balance so the largest amounts owed float to the top. Every earnings
    doc contributes to exactly one row (the referrer). Zero-balance
    referrers with paid_out history still appear (marked
    ``needs_payout=False``) so admins can eyeball who's active.
    """
    all_e = await db.referral_earnings.find({}).to_list(20000)
    by_ref: dict[str, dict] = {}
    for e in all_e:
        rid = e.get("referrer_user_id")
        if not rid:
            continue
        row = by_ref.setdefault(rid, {
            "referrer_user_id": rid,
            "accrued_cents": 0, "paid_out_cents": 0,
            "accrued_count": 0, "paid_count": 0,
            "unique_payers": set(),
            "last_activity": None,
        })
        cents = int(e.get("share_cents") or 0)
        status = e.get("status") or "accrued"
        if status == "paid_out":
            row["paid_out_cents"] += cents
            row["paid_count"] += 1
        else:
            row["accrued_cents"] += cents
            row["accrued_count"] += 1
        if e.get("referred_user_id"):
            row["unique_payers"].add(e["referred_user_id"])
        ts = e.get("paid_out_at") or e.get("created_at")
        if ts and (not row["last_activity"] or ts > row["last_activity"]):
            row["last_activity"] = ts
    users = await _resolve_users_map([rid for rid in by_ref])
    rows = []
    for rid, r in by_ref.items():
        u = users.get(rid) or {}
        b = u.get("branding") or {}
        rows.append({
            "referrer_user_id": rid,
            "email": u.get("email"),
            "name": u.get("name"),
            "referral_slug": u.get("referral_slug"),
            "firm_name": b.get("firm_name") or None,
            "accrued_cents": r["accrued_cents"],
            "paid_out_cents": r["paid_out_cents"],
            "accrued_count": r["accrued_count"],
            "paid_count": r["paid_count"],
            "unique_payers": len(r["unique_payers"]),
            "last_activity": r["last_activity"],
            "needs_payout": r["accrued_cents"] > 0,
        })
    rows.sort(key=lambda r: (-r["accrued_cents"], -r["paid_out_cents"]))
    totals_accrued = sum(r["accrued_cents"] for r in rows)
    totals_paid = sum(r["paid_out_cents"] for r in rows)
    return {
        "affiliates": rows,
        "totals": {
            "affiliates": len(rows),
            "affiliates_needing_payout": sum(1 for r in rows if r["needs_payout"]),
            "accrued_cents": totals_accrued,
            "paid_out_cents": totals_paid,
            "lifetime_cents": totals_accrued + totals_paid,
        },
    }


@router.get("/admin/affiliate/payouts/{referrer_user_id}")
async def affiliate_payouts_for_referrer(
    referrer_user_id: str,
    status: Optional[str] = None,  # accrued | paid_out | None (all)
    user: dict = Depends(require_role("superadmin")),
):
    """Line-item earnings for a single affiliate. The mark-paid modal
    lists these rows so the admin can either "select all accrued" or
    cherry-pick specific invoices to include in a payout."""
    q: dict = {"referrer_user_id": referrer_user_id}
    if status in {"accrued", "paid_out"}:
        q["status"] = status
    earnings = await db.referral_earnings.find(q).to_list(5000)
    payer_ids = list({e["referred_user_id"] for e in earnings if e.get("referred_user_id")})
    payers = await _resolve_users_map(payer_ids)
    ref_user = (await _resolve_users_map([referrer_user_id])).get(referrer_user_id) or {}
    lines = [{
        "id": e["id"],
        "date": e.get("created_at"),
        "referred_user_id": e.get("referred_user_id"),
        "referred_email": (payers.get(e.get("referred_user_id")) or {}).get("email"),
        "referred_name": (payers.get(e.get("referred_user_id")) or {}).get("name"),
        "gross_cents": int(e.get("gross_cents") or 0),
        "share_cents": int(e.get("share_cents") or 0),
        "share_bps": int(e.get("share_bps") or 0),
        "status": e.get("status") or "accrued",
        "paid_out_at": e.get("paid_out_at"),
        "paid_out_by": e.get("paid_out_by_user_id"),
        "external_ref": e.get("external_ref"),
        "note": e.get("payout_note"),
    } for e in earnings]
    lines.sort(key=lambda r: r["date"] or "", reverse=True)
    return {
        "referrer": {
            "user_id": referrer_user_id,
            "email": ref_user.get("email"), "name": ref_user.get("name"),
            "referral_slug": ref_user.get("referral_slug"),
        },
        "lines": lines,
        "totals": {
            "accrued_cents": sum(l["share_cents"] for l in lines if l["status"] == "accrued"),
            "paid_out_cents": sum(l["share_cents"] for l in lines if l["status"] == "paid_out"),
        },
    }


class MarkPaidBody(BaseModel):
    referrer_user_id: str
    earning_ids: Optional[list[str]] = None  # None → all accrued rows
    external_ref: Optional[str] = None
    note: Optional[str] = None


@router.post("/admin/affiliate/payouts/mark-paid")
async def mark_payouts_paid(
    inp: MarkPaidBody, user: dict = Depends(require_role("superadmin")),
):
    """Flip accrued earnings to ``paid_out`` for a single referrer.

    * ``earning_ids=None`` marks every currently-accrued row for that
      referrer — the "just paid Priya her full balance" happy path.
    * ``earning_ids=[…]`` marks only those specific invoice rows so
      admins can cut a partial check (e.g. minimum payout thresholds).
    Idempotent — already-paid rows are ignored, not double-marked.
    """
    q: dict = {
        "referrer_user_id": inp.referrer_user_id,
        "status": "accrued",
    }
    if inp.earning_ids:
        q["id"] = {"$in": list(inp.earning_ids)}
    matching = await db.referral_earnings.find(q).to_list(5000)
    if not matching:
        return {"marked": 0, "amount_cents": 0}
    ids = [m["id"] for m in matching]
    total = sum(int(m.get("share_cents") or 0) for m in matching)
    now = now_iso()
    set_ops = {
        "status": "paid_out",
        "paid_out_at": now,
        "paid_out_by_user_id": user["id"],
    }
    if inp.external_ref is not None:
        set_ops["external_ref"] = inp.external_ref.strip()[:120] or None
    if inp.note is not None:
        set_ops["payout_note"] = inp.note.strip()[:500] or None
    await db.referral_earnings.update_many(
        {"id": {"$in": ids}}, {"$set": set_ops},
    )
    # Batch record — one row per admin action so the History tab can
    # show "Alice paid Priya $37 on Feb 12 (Wise TX abc)".
    await db.referral_payout_batches.insert_one({
        "id": str(uuid.uuid4()),
        "referrer_user_id": inp.referrer_user_id,
        "paid_by_user_id": user["id"],
        "paid_at": now,
        "amount_cents": total,
        "earning_ids": ids,
        "external_ref": (inp.external_ref or "").strip()[:120] or None,
        "note": (inp.note or "").strip()[:500] or None,
    })
    return {"marked": len(ids), "amount_cents": total}


class ReversePayoutBody(BaseModel):
    reason: Optional[str] = None


@router.post("/admin/affiliate/payouts/{earning_id}/reverse")
async def reverse_payout(
    earning_id: str, inp: ReversePayoutBody,
    user: dict = Depends(require_role("superadmin")),
):
    """Flip a single ``paid_out`` earning back to ``accrued`` for
    corrections — bounced checks, incorrect wire, wrong batch."""
    row = await db.referral_earnings.find_one({"id": earning_id})
    if not row:
        raise HTTPException(404, "Earning not found.")
    if row.get("status") != "paid_out":
        raise HTTPException(400, "Earning is not in paid_out status.")
    await db.referral_earnings.update_one(
        {"id": earning_id},
        {
            "$set": {"status": "accrued"},
            "$unset": {"paid_out_at": "", "paid_out_by_user_id": ""},
            "$push": {"reversal_log": {
                "reversed_at": now_iso(),
                "reversed_by_user_id": user["id"],
                "reason": (inp.reason or "").strip()[:500] or None,
            }},
        },
    )
    return {"reversed": earning_id}


@router.get("/admin/affiliate/history")
async def affiliate_payout_history(
    limit: int = 50,
    user: dict = Depends(require_role("superadmin")),
):
    """Recent payout batches across all affiliates, newest first —
    powers the History pane on the payout console."""
    batches = await db.referral_payout_batches.find({}).sort(
        "paid_at", -1,
    ).to_list(max(1, min(500, limit)))
    ref_ids = list({b["referrer_user_id"] for b in batches})
    admin_ids = list({b["paid_by_user_id"] for b in batches})
    users = await _resolve_users_map(ref_ids + admin_ids)
    return {
        "batches": [{
            "id": b["id"],
            "paid_at": b.get("paid_at"),
            "amount_cents": int(b.get("amount_cents") or 0),
            "invoice_count": len(b.get("earning_ids") or []),
            "referrer": {
                "user_id": b["referrer_user_id"],
                "email": (users.get(b["referrer_user_id"]) or {}).get("email"),
                "name": (users.get(b["referrer_user_id"]) or {}).get("name"),
            },
            "paid_by": {
                "user_id": b["paid_by_user_id"],
                "email": (users.get(b["paid_by_user_id"]) or {}).get("email"),
                "name": (users.get(b["paid_by_user_id"]) or {}).get("name"),
            },
            "external_ref": b.get("external_ref"),
            "note": b.get("note"),
        } for b in batches]
    }


@router.get("/admin/orphan-memberships")
async def orphan_memberships(user: dict = Depends(require_role("superadmin"))):
    """Data-drift lens: surface memberships / user records that look
    inconsistent so a superadmin can clean them up before customers
    notice. Read-only.

    Categories returned (in order of severity):

    * ``multi_firm_staff`` — a single user is a pro on client companies
      belonging to two or more different firms (partitioned by shared
      pro-management). Legit for contractors, but usually signals a
      lingering invite that was never revoked.
    * ``role_mismatch_client_but_pro`` — user.role = ``client`` yet they
      hold at least one ``role=pro`` membership. Should have been fixed
      by the Feb-2026 backfill; anything new points to a regression in
      invite-accept role elevation.
    * ``role_mismatch_pro_but_no_pro_ms`` — user.role = ``pro`` but no
      active pro memberships. Their sidebar shows the Clients link with
      an empty list — either abandoned firm-staff or a manual role edit.
    * ``dangling_archived`` — memberships with ``archived_at`` set that
      still exist in the DB. Nothing broken; presented for review /
      hard-delete decisions.
    * ``duplicate_memberships`` — the same ``(user_id, company_id, role)``
      triple appears more than once. Cannot happen through the API but
      historical seed scripts sometimes created dupes.
    """
    # Pull everything once — small tables (<10k) in this app.
    all_ms = await db.memberships.find({}).to_list(20000)
    all_users = await db.users.find({}, {
        "id": 1, "email": 1, "name": 1, "role": 1, "_id": 0,
    }).to_list(20000)
    all_companies = await db.companies.find({}, {
        "id": 1, "name": 1, "_id": 0,
    }).to_list(20000)
    U = {u["id"]: u for u in all_users}
    C = {c["id"]: c for c in all_companies}

    # -------- 1) multi-firm staff --------
    # A "firm" is a maximally connected set of companies linked by shared
    # pros. To detect a candidate that spans two firms, we MUST rebuild
    # the union-find WITHOUT the candidate's own memberships — otherwise
    # the candidate themselves supplies the bridging edge that collapses
    # the very firms we're trying to detect.
    #
    # For each candidate: union all edges from OTHER pros, then count
    # distinct roots among the candidate's companies. `>1` → multi-firm.
    active_pro_ms = [
        m for m in all_ms
        if m.get("role") == "pro" and not m.get("archived_at")
    ]
    cands_cids: dict[str, list[str]] = {}
    for m in active_pro_ms:
        cands_cids.setdefault(m["user_id"], []).append(m["company_id"])
    multi_firm_staff = []
    for uid, cids in cands_cids.items():
        if len(cids) < 2:
            continue
        if (U.get(uid) or {}).get("role") == "superadmin":
            continue  # superadmins legitimately touch every firm
        parent: dict[str, str] = {c: c for c in cids}
        def _find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        def _union(a: str, b: str) -> None:
            ra, rb = _find(a), _find(b)
            if ra != rb: parent[ra] = rb
        # Group other pros' companies (restricted to the candidate's set)
        # then union each group.
        other_groups: dict[str, list[str]] = {}
        for m in active_pro_ms:
            if m["user_id"] == uid: continue
            if m["company_id"] in parent:
                other_groups.setdefault(m["user_id"], []).append(m["company_id"])
        for group in other_groups.values():
            for c in group[1:]:
                _union(group[0], c)
        roots = {_find(c) for c in cids}
        if len(roots) > 1:
            u = U.get(uid) or {}
            multi_firm_staff.append({
                "user_id": uid,
                "email": u.get("email"), "name": u.get("name"), "role": u.get("role"),
                "firm_count": len(roots),
                "companies": [
                    {"id": c, "name": (C.get(c) or {}).get("name")}
                    for c in cids
                ],
            })

    # -------- 2) role mismatch: client user but has pro memberships ------
    role_mismatch_client_but_pro = []
    for u in all_users:
        if u.get("role") != "client": continue
        has_pro = any(
            m["user_id"] == u["id"] and m.get("role") == "pro" and not m.get("archived_at")
            for m in all_ms
        )
        if has_pro:
            role_mismatch_client_but_pro.append({
                "user_id": u["id"], "email": u.get("email"), "name": u.get("name"),
            })

    # -------- 3) role mismatch: pro user but no active pro memberships ---
    role_mismatch_pro_but_no_pro_ms = []
    for u in all_users:
        if u.get("role") != "pro": continue
        has_pro = any(
            m["user_id"] == u["id"] and m.get("role") == "pro" and not m.get("archived_at")
            for m in all_ms
        )
        if not has_pro:
            role_mismatch_pro_but_no_pro_ms.append({
                "user_id": u["id"], "email": u.get("email"), "name": u.get("name"),
            })

    # -------- 4) dangling archived memberships ---------------------------
    dangling_archived = []
    for m in all_ms:
        if not m.get("archived_at"): continue
        u = U.get(m["user_id"], {})
        dangling_archived.append({
            "user_id": m["user_id"], "email": u.get("email"), "name": u.get("name"),
            "company_id": m["company_id"],
            "company_name": (C.get(m["company_id"]) or {}).get("name"),
            "role": m.get("role"),
            "archived_at": m.get("archived_at"),
        })

    # -------- 5) duplicate memberships -----------------------------------
    seen: dict[tuple, int] = {}
    for m in all_ms:
        k = (m["user_id"], m["company_id"], m.get("role"))
        seen[k] = seen.get(k, 0) + 1
    duplicate_memberships = []
    for (uid, cid, role), count in seen.items():
        if count > 1:
            u = U.get(uid, {})
            duplicate_memberships.append({
                "user_id": uid, "email": u.get("email"), "name": u.get("name"),
                "company_id": cid,
                "company_name": (C.get(cid) or {}).get("name"),
                "role": role, "count": count,
            })

    return {
        "generated_at": now_iso(),
        "totals": {
            "multi_firm_staff": len(multi_firm_staff),
            "role_mismatch_client_but_pro": len(role_mismatch_client_but_pro),
            "role_mismatch_pro_but_no_pro_ms": len(role_mismatch_pro_but_no_pro_ms),
            "dangling_archived": len(dangling_archived),
            "duplicate_memberships": len(duplicate_memberships),
        },
        "multi_firm_staff": multi_firm_staff,
        "role_mismatch_client_but_pro": role_mismatch_client_but_pro,
        "role_mismatch_pro_but_no_pro_ms": role_mismatch_pro_but_no_pro_ms,
        "dangling_archived": dangling_archived,
        "duplicate_memberships": duplicate_memberships,
    }


@router.post("/admin/orphan-memberships/purge-duplicates")
async def orphan_purge_duplicates(user: dict = Depends(require_role("superadmin"))):
    """Collapse duplicate ``(user_id, company_id, role)`` memberships to
    a single canonical row. Keeps the OLDEST record (preserves audit
    trail) and deletes the rest. Idempotent."""
    all_ms = await db.memberships.find({}).to_list(20000)
    keep_ids: set[str] = set()
    delete_ids: list[str] = []
    seen: dict[tuple, dict] = {}
    for m in all_ms:
        k = (m["user_id"], m["company_id"], m.get("role"))
        if k not in seen:
            seen[k] = m
            keep_ids.add(m["id"])
        else:
            # keep the earliest created_at
            existing = seen[k]
            if (m.get("created_at") or "") < (existing.get("created_at") or ""):
                delete_ids.append(existing["id"])
                seen[k] = m
                keep_ids.discard(existing["id"])
                keep_ids.add(m["id"])
            else:
                delete_ids.append(m["id"])
    if delete_ids:
        await db.memberships.delete_many({"id": {"$in": delete_ids}})
    return {"kept": len(keep_ids), "deleted": len(delete_ids)}


@router.post("/admin/orphan-memberships/fix-role-drift")
async def orphan_fix_role_drift(user: dict = Depends(require_role("superadmin"))):
    """Re-run the Feb-2026 role-elevation heuristic across all users.

    * Any user with an active ``role=pro`` membership but global role
      ``client`` is upgraded to ``pro``.
    * Any user whose global role is ``pro`` but who has ZERO active pro
      memberships stays put (we don't downgrade automatically — that's a
      manual decision). Reported in the read endpoint for the operator
      to review.
    Returns the number of users elevated.
    """
    pro_ms = await db.memberships.find(
        {"role": "pro", "$or": [
            {"archived_at": {"$exists": False}}, {"archived_at": None},
        ]},
        {"user_id": 1, "_id": 0},
    ).to_list(20000)
    pro_uids = list({m["user_id"] for m in pro_ms})
    result = await db.users.update_many(
        {"role": "client", "id": {"$in": pro_uids}},
        {"$set": {"role": "pro"}},
    )
    return {"elevated": result.modified_count}


async def _require_enterprise_access(eid: str, user: dict) -> dict:
    """Fetch the enterprise doc and verify the caller can act on it.

    Superadmins → any enterprise.
    Partners    → only enterprises they provisioned (`ent.partner_id
                  == user.id`). Non-matching → 404 (not 403) to avoid
                  leaking existence of other partners' rows.
    Other roles → shouldn't reach here (role gate blocks first), but
                  defense-in-depth 403 if they do.

    Returns the enterprise doc so the caller doesn't need a second
    round-trip. Raises HTTPException on any denial.
    """
    ent = await db.enterprises.find_one({"id": eid})
    if not ent:
        raise HTTPException(404, "Enterprise not found")
    role = user.get("role")
    if role == "superadmin":
        return ent
    if role == "partner":
        if ent.get("partner_id") != user["id"]:
            # Treat someone else's enterprise as "not found" — a
            # partner shouldn't be able to enumerate the platform.
            raise HTTPException(404, "Enterprise not found")
        return ent
    raise HTTPException(403, "Forbidden")


@router.get("/admin/enterprises/{eid}")
async def get_enterprise(eid: str,
                         user: dict = Depends(require_role("superadmin", "partner"))):
    """Detail: enterprise + KPI roll-ups + companies list report.

    Available to Superadmins (any enterprise) and Partners (only
    enterprises they provisioned — `ent.partner_id == user.id`). The
    payload shape is identical for both roles so the frontend can
    reuse the same detail view."""
    ent = await _require_enterprise_access(eid, user)
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
                # White-label unlock state so the Superadmin can flip the
                # comp toggle inline without navigating away.
                "whitelabel_comp": bool((p.get("branding") or {}).get("whitelabel_comp")),
                "whitelabel_paid": bool((p.get("branding") or {}).get("whitelabel_paid")),
                "whitelabel_unlocked": bool(
                    (p.get("branding") or {}).get("whitelabel_comp")
                    or (p.get("branding") or {}).get("whitelabel_paid")
                ),
                "whitelabel_source": (
                    "comp" if (p.get("branding") or {}).get("whitelabel_comp")
                    else ("paid" if (p.get("branding") or {}).get("whitelabel_paid") else None)
                ),
            } for p in pros
        ],
        "companies": company_rows,
    }


@router.patch("/admin/enterprises/{eid}")
async def patch_enterprise(eid: str, inp: EnterprisePatch,
                           user: dict = Depends(require_role("superadmin", "partner"))):
    ent = await _require_enterprise_access(eid, user)

    updates: dict = {}
    if inp.name is not None:
        name = inp.name.strip()
        if not name:
            raise HTTPException(400, "Enterprise name cannot be empty.")
        if len(name) > 80:
            raise HTTPException(400, "Enterprise name must be 80 characters or less.")
        updates["name"] = name
    if inp.free_user_allotment is not None:
        new_allot = int(inp.free_user_allotment)
        # Same partner cap as `POST /admin/enterprises` — a partner
        # can't lift the allotment past the enforced ceiling even on
        # an enterprise they own, so the create-side cap actually
        # sticks. Superadmin bypass is implicit (role check above).
        if user.get("role") == "partner" and new_allot > _PARTNER_MAX_FREE_SPOTS:
            raise HTTPException(
                400,
                f"Partners can allot at most {_PARTNER_MAX_FREE_SPOTS} free "
                f"spots per enterprise. Ask a superadmin to raise the cap.",
            )
        updates["free_user_allotment"] = new_allot
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


# --------------------------------------------------------------------------
# Enterprise archive / unarchive / hard-delete (Feb 2026)
# --------------------------------------------------------------------------
# Same shape as the partner-lifecycle endpoints, scoped to a single
# enterprise. Partners can operate on enterprises they own
# (via _require_enterprise_access); superadmins can operate on any.
# --------------------------------------------------------------------------

@router.post("/admin/enterprises/{eid}/archive")
async def archive_enterprise(
    eid: str,
    user: dict = Depends(require_role("superadmin", "partner")),
):
    ent = await _require_enterprise_access(eid, user)
    if ent.get("status") == "archived":
        return {"ok": True, "already_archived": True}
    await db.enterprises.update_one(
        {"id": eid},
        {"$set": {
            "status": "archived",
            "archived_at": datetime.now(timezone.utc).isoformat(),
            "archived_by": user["id"],
        }},
    )
    # Also archive the owner user so they can't log in while the
    # enterprise is dormant. Descendant client-company users are
    # left alone — they may still need read access for a wind-down.
    if ent.get("owner_user_id"):
        await db.users.update_one(
            {"id": ent["owner_user_id"]},
            {"$set": {
                "status": "archived",
                "archived_at": datetime.now(timezone.utc).isoformat(),
                "archived_by": user["id"],
            }},
        )
    return {"ok": True, "eid": eid, "status": "archived"}


@router.post("/admin/enterprises/{eid}/unarchive")
async def unarchive_enterprise(
    eid: str,
    user: dict = Depends(require_role("superadmin", "partner")),
):
    ent = await _require_enterprise_access(eid, user)
    await db.enterprises.update_one(
        {"id": eid},
        {"$unset": {"status": "", "archived_at": "", "archived_by": ""}},
    )
    if ent.get("owner_user_id"):
        await db.users.update_one(
            {"id": ent["owner_user_id"]},
            {"$unset": {"status": "", "archived_at": "", "archived_by": ""}},
        )
    return {"ok": True, "eid": eid, "status": "active"}


@router.delete("/admin/enterprises/{eid}")
async def delete_enterprise(
    eid: str,
    force: bool = False,
    user: dict = Depends(require_role("superadmin", "partner")),
):
    """Hard-delete an enterprise + cascade to its owner Pro + every
    client company attached to it. Refuses (409) if any client
    company has recorded transactions unless `?force=true`.

    Partner scope: same as `_require_enterprise_access` — 404 unless
    the enterprise's `partner_id` matches the caller. Superadmin
    unrestricted.
    """
    ent = await _require_enterprise_access(eid, user)

    # Collect the tree.
    company_ids: list[str] = [
        c["id"] async for c in db.companies.find(
            {"enterprise_id": eid}, {"id": 1, "_id": 0},
        ) if c.get("id")
    ]
    user_ids: list[str] = []
    if ent.get("owner_user_id"):
        user_ids.append(ent["owner_user_id"])
    # Any pro / client user stamped with THIS enterprise_id but not
    # captured above (e.g. sub-users added later).
    async for u in db.users.find(
        {"enterprise_id": eid, "id": {"$nin": user_ids}},
        {"id": 1, "_id": 0},
    ):
        if u.get("id"):
            user_ids.append(u["id"])

    if not force:
        tx_count = 0
        if company_ids:
            tx_count = await db.transactions.count_documents(
                {"company_id": {"$in": company_ids}}
            )
        if tx_count > 0:
            raise HTTPException(
                409,
                detail={
                    "message": (
                        f"This enterprise has {tx_count} transactions across "
                        f"{len(company_ids)} client compan"
                        f"{'y' if len(company_ids) == 1 else 'ies'}. Pass "
                        f"`force=true` to nuke anyway, or archive instead "
                        f"to preserve data."
                    ),
                    "code": "cascade_blocked_active_data",
                    "counts": {
                        "companies": len(company_ids),
                        "users": len(user_ids),
                        "transactions": tx_count,
                    },
                },
            )

    # Cascade deletes — leaf tables first.
    txn_del = 0
    if company_ids:
        res = await db.transactions.delete_many({"company_id": {"$in": company_ids}})
        txn_del = res.deleted_count
        for _coll in (
            "invoices", "bills", "estimates", "receipts", "contacts",
            "products", "categories", "memberships",
            "ai_usage_events", "qbo_oauth_states", "qbo_connections",
            "plaid_items", "veryfi_receipts", "chat_messages",
        ):
            try:
                await getattr(db, _coll).delete_many({"company_id": {"$in": company_ids}})
            except Exception:  # noqa: BLE001
                pass
        await db.companies.delete_many({"id": {"$in": company_ids}})

    if user_ids:
        await db.users.delete_many({"id": {"$in": user_ids}})

    await db.enterprise_invoices.delete_many({"enterprise_id": eid})
    await db.enterprises.delete_one({"id": eid})

    return {
        "ok": True,
        "deleted": {
            "enterprise_id": eid,
            "companies": len(company_ids),
            "users": len(user_ids),
            "transactions": txn_del,
            "forced": bool(force),
        },
    }



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



# --------------------------------------------------------------------------
# White-label comp toggle — Superadmin can grant or revoke free
# white-label branding on any pro's firm. Comp trumps paid status: a
# comped firm stays unlocked even if their Stripe subscription lapses.
# --------------------------------------------------------------------------
class WhitelabelCompIn(BaseModel):
    granted: bool


@router.get("/admin/pros")
async def admin_list_pros(user: dict = Depends(require_role("superadmin"))):
    """List every pro on the platform with the info the Superadmin needs
    for the White-label Comp column: firm name, email, comp/paid status,
    and the resolved unlocked flag."""
    pros = await db.users.find(
        {"role": "pro"},
        {"_id": 0, "id": 1, "name": 1, "email": 1, "branding": 1, "created_at": 1},
    ).to_list(2000)
    rows = []
    for p in pros:
        b = p.get("branding") or {}
        comp = bool(b.get("whitelabel_comp"))
        paid = bool(b.get("whitelabel_paid"))
        rows.append({
            "id": p["id"],
            "name": p.get("name") or "",
            "email": p.get("email") or "",
            "firm_name": b.get("firm_name") or None,
            "created_at": p.get("created_at"),
            "whitelabel_comp": comp,
            "whitelabel_paid": paid,
            "whitelabel_unlocked": comp or paid,
            "whitelabel_source": "comp" if comp else ("paid" if paid else None),
            "whitelabel_comp_at": b.get("whitelabel_comp_at"),
            "whitelabel_paid_at": b.get("whitelabel_paid_at"),
        })
    # Newest pros first — matches the enterprise detail page ordering.
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return {"pros": rows}


@router.post("/admin/pros/{pro_id}/whitelabel-comp")
async def admin_toggle_whitelabel_comp(
    pro_id: str,
    inp: WhitelabelCompIn,
    user: dict = Depends(require_role("superadmin", "partner")),
):
    """Flip ``branding.whitelabel_comp`` on for the target pro (or off
    when ``granted=False``). Stamps ``whitelabel_comp_at`` +
    ``whitelabel_comp_by`` for audit trail. Idempotent — repeated calls
    with the same value just refresh the timestamp/actor.

    Role scoping:
      * Superadmin — can flip any pro/partner/superadmin. No quota.
      * Partner — can only flip pros in their own tree
        (`target.partner_id == user.id`). Granting a new comp burns
        one of the (max 2) partner WL-comp slots — same quota that
        the create-time flag on `POST /admin/enterprises` uses.
        Revoking is unbounded (partners can free slots back up).
    """
    pro = await db.users.find_one({"id": pro_id})
    if not pro:
        raise HTTPException(404, "Pro not found")
    # Accept `partner` too — Partners are Pro-like users who also get
    # their own white-label comp toggle (surfaced on the Partner
    # Detail page's "Partner white-label" section). The DB shape is
    # identical, so the same branding.whitelabel_comp flag works.
    if pro.get("role") not in {"pro", "superadmin", "partner"}:
        raise HTTPException(400, "Target user is not a Pro or Partner.")

    # Partner scope + quota enforcement.
    if user.get("role") == "partner":
        if pro.get("partner_id") != user["id"]:
            # 404 to avoid enumerating other partners' pros.
            raise HTTPException(404, "Pro not found")
        if inp.granted:
            already = bool((pro.get("branding") or {}).get("whitelabel_comp"))
            if not already:
                used = await _partner_wl_comps_used(user["id"])
                if used >= _PARTNER_MAX_WL_COMPS:
                    raise HTTPException(
                        400,
                        f"You've already comp'd white-label for {used} of "
                        f"{_PARTNER_MAX_WL_COMPS} allowed owners. Revoke one "
                        f"before granting another.",
                    )
    if inp.granted:
        await db.users.update_one(
            {"id": pro_id},
            {"$set": {
                "branding.whitelabel_comp": True,
                "branding.whitelabel_comp_at": now_iso(),
                "branding.whitelabel_comp_by": user["id"],
            }},
        )
    else:
        await db.users.update_one(
            {"id": pro_id},
            {"$set": {"branding.whitelabel_comp": False,
                      "branding.whitelabel_comp_revoked_at": now_iso(),
                      "branding.whitelabel_comp_revoked_by": user["id"]}},
        )
    pro = await db.users.find_one({"id": pro_id})
    b = pro.get("branding") or {}
    comp = bool(b.get("whitelabel_comp"))
    paid = bool(b.get("whitelabel_paid"))
    return {
        "id": pro["id"],
        "whitelabel_comp": comp,
        "whitelabel_paid": paid,
        "whitelabel_unlocked": comp or paid,
        "whitelabel_source": "comp" if comp else ("paid" if paid else None),
    }
