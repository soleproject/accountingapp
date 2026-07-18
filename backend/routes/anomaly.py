"""Axiom Ledger — Anomaly Detection routes.

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


# ------------------------- Anomaly Detection --------------------------
# The AI panel calls this on demand ("what's wrong with my books?") AND we
# include a light-weight summary of the top anomalies in every chat request
# so the LLM can flag data-entry issues proactively.

async def _diagnose_books(cid: str) -> dict:
    """Scan the books for common data-entry pathologies and return a list
    of anomalies with a professional-quality one-sentence explanation.

    Detects:
    - Liability accounts with a negative display balance (over-debited —
      usually happens when only the paydown side of a credit card / loan
      is booked, and the offsetting charges / advances are missing).
    - Asset accounts with a negative display balance (except contra-assets).
    - Non-zero Opening Balance Equity (should be cleared to Retained Earnings).
    - Bank accounts with a large gap between last posted date and today
      (indicates sync is stuck).
    """
    from reports import compute_balance_sheet, _signed_balances, CREDIT_NORMAL
    company = await db.companies.find_one({"id": cid})
    if not company:
        return {"anomalies": [], "checked": []}
    today = datetime.now(timezone.utc).date().isoformat()
    basis = company.get("reporting_basis", "accrual")
    bs = await compute_balance_sheet(cid, today, basis)

    anomalies: list[dict] = []

    # Cache accounts by id for descriptive drill-in.
    accts = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}

    # --- Liability sign check ---
    for a in bs["liabilities"]:
        if a["amount"] < -0.01:  # display balance negative → over-debited
            # Investigate: sum of transactions posted to this account by sign.
            aid = None
            for _id, doc in accts.items():
                if doc.get("code") == a["code"]:
                    aid = _id
                    break
            direction_hint = ""
            if aid:
                pipe = [
                    {"$match": {"company_id": cid, "posted": True, "category_account_id": aid}},
                    {"$group": {"_id": None,
                                "n_outflow": {"$sum": {"$cond": [{"$lt": ["$amount", 0]}, 1, 0]}},
                                "n_inflow":  {"$sum": {"$cond": [{"$gt": ["$amount", 0]}, 1, 0]}},
                                "outflow_total": {"$sum": {"$cond": [{"$lt": ["$amount", 0]}, "$amount", 0]}},
                                "inflow_total":  {"$sum": {"$cond": [{"$gt": ["$amount", 0]}, "$amount", 0]}}}},
                ]
                agg = await db.transactions.aggregate(pipe).to_list(1)
                if agg:
                    r = agg[0]
                    if r["n_outflow"] and not r["n_inflow"]:
                        direction_hint = (
                            f" ({r['n_outflow']} paydown-side transactions totaling "
                            f"${abs(r['outflow_total']):,.2f}, but ZERO charge-side entries — "
                            "the offsetting charges (or original loan proceeds) were never booked)."
                        )
            anomalies.append({
                "severity": "high",
                "code": a["code"],
                "account": a["name"],
                "amount": round(a["amount"], 2),
                "kind": "liability_negative",
                "title": f"{a['name']} shows a negative balance",
                "explanation": (
                    f"A liability account with a negative balance is over-debited by "
                    f"${abs(a['amount']):,.2f}."
                    f"{direction_hint} "
                    "Recommended fix: (a) connect the credit-card / loan feed so charges & advances post as CREDITs, "
                    "or (b) book an opening-balance journal entry for the original principal "
                    "(DEBIT the acquired asset or an expense; CREDIT this liability)."
                ),
            })

    # --- Asset sign check (contra-assets excluded) ---
    for a in bs["assets"]:
        # Common contra-assets: Accumulated Depreciation, Allowance for Doubtful Accounts.
        nm = (a.get("name") or "").lower()
        if "accumulated depreciation" in nm or "allowance" in nm:
            continue
        if a["amount"] < -0.01:
            anomalies.append({
                "severity": "high",
                "code": a["code"],
                "account": a["name"],
                "amount": round(a["amount"], 2),
                "kind": "asset_negative",
                "title": f"{a['name']} shows a negative balance",
                "explanation": (
                    f"An asset account should not have a negative balance (currently ${a['amount']:,.2f}). "
                    "Common cause: outflows are being categorized directly to this account without an offsetting inflow. "
                    "Review recent postings on this account and reclassify any that shouldn't be here."
                ),
            })

    # --- OBE not cleared ---
    for a in bs["equity"]:
        if (a.get("name") or "").lower().startswith("opening balance equity") and abs(a["amount"]) > 0.01:
            anomalies.append({
                "severity": "medium",
                "code": a["code"],
                "account": a["name"],
                "amount": round(a["amount"], 2),
                "kind": "obe_nonzero",
                "title": "Opening Balance Equity is not cleared",
                "explanation": (
                    f"Opening Balance Equity has a residual balance of ${a['amount']:,.2f}. "
                    "Best practice: after initial setup, clear OBE to Retained Earnings (or Owner's Equity) "
                    "with a single closing journal entry so it doesn't show on the balance sheet indefinitely."
                ),
            })

    # --- Sanity: BS should balance ---
    diff = bs["total_assets"] - (bs["total_liabilities"] + bs["total_equity"])
    if abs(diff) > 0.5:
        anomalies.append({
            "severity": "critical",
            "kind": "bs_unbalanced",
            "amount": round(diff, 2),
            "title": "Balance sheet does not balance",
            "explanation": (
                f"Assets ${bs['total_assets']:,.2f} ≠ Liabilities + Equity "
                f"${bs['total_liabilities'] + bs['total_equity']:,.2f} (Δ ${diff:,.2f}). "
                "This means at least one journal entry or transaction is not balanced. Investigate recent unposted or manually edited entries."
            ),
        })

    # Sort by severity (critical > high > medium)
    order = {"critical": 0, "high": 1, "medium": 2}
    anomalies.sort(key=lambda x: order.get(x.get("severity"), 9))

    return {
        "as_of": today,
        "basis": basis,
        "total_assets": round(bs["total_assets"], 2),
        "total_liabilities": round(bs["total_liabilities"], 2),
        "total_equity": round(bs["total_equity"], 2),
        "anomalies": anomalies,
        "checked": ["liability_signs", "asset_signs", "obe_nonzero", "bs_balances"],
    }


@router.get("/companies/{cid}/ai/diagnose")
async def ai_diagnose(cid: str, user: dict = Depends(get_current_user)):
    """Diagnostic scan for common data-entry pathologies.

    Called directly by the AI panel when a user asks "what's wrong with my books"
    or "why are my liabilities negative"; also called by chat_stream to enrich
    the LLM context so it can flag issues without being asked.
    """
    await require_company(user, cid)
    return await _diagnose_books(cid)


@router.post("/companies/{cid}/accounts/{aid}/fanout-subaccounts")
async def fanout_liability_subaccounts(cid: str, aid: str,
                                       user: dict = Depends(get_current_user)):
    """Migrate historical transactions currently posted to a generic parent
    liability bucket (Credit Card Payable, Loans Payable, …) into per-payee
    sub-accounts.

    For each unique `contact_name` (or `merchant`) currently posting to the
    parent, we:
      1. Create (or match) a child sub-account named after the payee.
      2. Bulk-update the transactions so they post to that child.

    Returns the number of sub-accounts created + the number of transactions
    moved. Idempotent: running twice does nothing on the second call.
    """
    await require_company(user, cid)
    parent = await db.accounts.find_one({"id": aid, "company_id": cid})
    if not parent:
        raise HTTPException(404, "Account not found")
    from liability_subaccounts import (
        is_parent_liability_bucket, resolve_or_create_liability_subaccount,
    )
    if not is_parent_liability_bucket(parent):
        raise HTTPException(400, "Account is not a generic liability parent bucket")

    # Group current postings by payee.
    pipe = [
        {"$match": {"company_id": cid, "category_account_id": aid, "posted": True}},
        {"$group": {
            "_id": {"$ifNull": ["$contact_name", "$merchant"]},
            "ids": {"$push": "$id"},
            "count": {"$sum": 1},
        }},
        {"$sort": {"count": -1}},
    ]
    groups: list[dict] = []
    async for g in db.transactions.aggregate(pipe):
        groups.append(g)

    accounts_created = 0
    txns_moved = 0
    now = now_iso()
    for g in groups:
        payee = g.get("_id")
        if not payee:
            continue
        # Snapshot child count BEFORE resolve so we can tell if a new one was made.
        before = await db.accounts.count_documents(
            {"company_id": cid, "parent_account_id": aid},
        )
        child = await resolve_or_create_liability_subaccount(cid, parent, payee, source="backfill")
        if not child:
            continue
        after = await db.accounts.count_documents(
            {"company_id": cid, "parent_account_id": aid},
        )
        if after > before:
            accounts_created += 1
        r = await db.transactions.update_many(
            {"id": {"$in": g["ids"]}, "company_id": cid},
            {"$set": {
                "category_account_id":   child["id"],
                "category_account_code": child.get("code"),
                "category_account_name": child.get("name"),
                "updated_at": now,
            }},
        )
        txns_moved += r.modified_count

    return {
        "parent_account": {"id": parent["id"], "code": parent["code"], "name": parent["name"]},
        "accounts_created": accounts_created,
        "transactions_moved": txns_moved,
    }


@router.get("/companies/{cid}/ai/review")
async def ai_review(cid: str, user: dict = Depends(get_current_user)):
    """Return a structured 4-step "walk me through the books" briefing that
    the AI panel narrates step-by-step, waiting for a voice "next" between
    each step. Cheap: one shot, no LLM."""
    await require_company(user, cid)
    today = datetime.now(timezone.utc).date()
    today_s = today.isoformat()

    # STEP 1: Flagged transactions.
    flagged_task = db.transactions.find(
        {"company_id": cid, "needs_review": True},
    ).sort([("date", -1)]).limit(5).to_list(5)
    flagged_count_task = db.transactions.count_documents(
        {"company_id": cid, "needs_review": True},
    )

    # STEP 2: Overdue A/R.
    ar_task = R.compute_ar_aging(cid, today_s)

    # STEP 3: Expense spikes — this week vs last week per category.
    week_end = today
    week_start = week_end - timedelta(days=6)
    prev_end = week_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=6)

    async def _expense_by_cat(start_d, end_d):
        pipeline = [
            {"$match": {
                "company_id": cid,
                "posted": True,
                "date": {"$gte": start_d.isoformat(), "$lte": end_d.isoformat()},
                "amount": {"$lt": 0},
            }},
            {"$group": {"_id": {"$ifNull": ["$category_account_name", "Uncategorized"]},
                        "total": {"$sum": "$amount"}}},
        ]
        out = {}
        async for r in db.transactions.aggregate(pipeline):
            out[r["_id"]] = abs(r.get("total") or 0)
        return out

    # STEP 4: Suggested rules.
    rules_task = db.rule_candidates.find(
        {"company_id": cid, "approvals": {"$gte": 2}},
    ).sort([("applies_to_count", -1)]).limit(5).to_list(5)

    flagged, flagged_count, ar, this_week_exp, last_week_exp, rules = await asyncio.gather(
        flagged_task,
        flagged_count_task,
        ar_task,
        _expense_by_cat(week_start, week_end),
        _expense_by_cat(prev_start, prev_end),
        rules_task,
    )

    # Compute deltas — sorted by absolute change (dollars).
    movers = []
    for cat in set(this_week_exp) | set(last_week_exp):
        n = this_week_exp.get(cat, 0)
        p = last_week_exp.get(cat, 0)
        delta = n - p
        if abs(delta) < 1:
            continue
        pct = None
        if p > 0.01:
            pct = round(((n - p) / p) * 100)
        movers.append({"category": cat, "this_week": round(n, 2),
                       "last_week": round(p, 2), "delta": round(delta, 2), "pct": pct})
    movers.sort(key=lambda x: abs(x["delta"] or 0), reverse=True)

    ar_top = [{
        "invoice_number": x.get("invoice_number"),
        "contact_name": x.get("contact_name"),
        "balance": x.get("balance"),
        "days_overdue": x.get("days_overdue"),
    } for x in (ar.get("overdue_invoices") or [])[:3]]

    steps = [
        {
            "id": "flagged",
            "title": "Flagged transactions",
            "count": flagged_count,
            "top": [{
                "date": t.get("date"), "merchant": t.get("merchant") or t.get("contact_name"),
                "amount": t.get("amount"), "current_category": t.get("category_account_name"),
            } for t in flagged],
            "spoken": (f"You have {flagged_count} flagged transaction{'s' if flagged_count != 1 else ''} needing review."
                       if flagged_count else "No flagged transactions. Nice."),
        },
        {
            "id": "ar",
            "title": "Overdue A/R",
            "total_overdue": round(ar.get("total_overdue") or 0, 2),
            "count": len(ar.get("overdue_invoices") or []),
            "top": ar_top,
            "spoken": _spoken_ar(ar, ar_top),
        },
        {
            "id": "expense_movers",
            "title": "Expense spikes this week",
            "movers": movers[:3],
            "spoken": _spoken_movers(movers),
        },
        {
            "id": "rules",
            "title": "Suggested rules",
            "count": len(rules),
            "top": [{"key": r.get("merchant_pattern") or r.get("normalized_merchant"),
                     "category": r.get("target_account_name"),
                     "applies_to_count": r.get("applies_to_count") or 0} for r in rules],
            "spoken": _spoken_rules(rules),
        },
    ]
    return {"generated_at": now_iso(), "steps": steps}


def _spoken_ar(ar: dict, top: list[dict]) -> str:
    n = len(ar.get("overdue_invoices") or [])
    if not n:
        return "No overdue receivables. Everything current."
    total = ar.get("total_overdue") or 0
    lead = f"{n} overdue invoice{'s' if n != 1 else ''} totaling ${total:,.0f}"
    if top:
        biggest = top[0]
        lead += f", biggest is {biggest.get('contact_name') or 'unknown'} at ${(biggest.get('balance') or 0):,.0f}"
        if biggest.get("days_overdue") is not None:
            lead += f" ({biggest['days_overdue']} days late)"
    return lead + "."


def _spoken_movers(movers: list[dict]) -> str:
    if not movers:
        return "Expenses are flat vs last week."
    top = movers[:2]
    bits = []
    for m in top:
        d = "up" if (m.get("delta") or 0) > 0 else "down"
        pct = f" {abs(m['pct'])}%" if m.get("pct") is not None else ""
        bits.append(f"{m['category']} {d}{pct}")
    return f"Top spend movers: {', '.join(bits)}."


def _spoken_rules(rules: list[dict]) -> str:
    if not rules:
        return "No new rules to approve."
    top = rules[0]
    key = top.get("merchant_pattern") or top.get("normalized_merchant") or "a merchant"
    return f"{len(rules)} suggested rule{'s' if len(rules) != 1 else ''} ready to approve — top one auto-categorizes {key}."


