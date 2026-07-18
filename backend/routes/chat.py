"""Axiom Ledger — AI Chat (SSE) routes.

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


# ----------------------- AI Chat (SSE) -----------------------

@router.post("/ai/chat/stream")
async def ai_chat_stream(inp: ChatIn, user: dict = Depends(get_current_user)):
    await require_company(user, inp.company_id)
    session_id = inp.session_id or f"chat-{inp.company_id}-{user['id']}"
    now = now_iso()
    # persist user message
    await db.chat_messages.insert_one({
        "id": str(uuid.uuid4()), "session_id": session_id, "company_id": inp.company_id,
        "role": "user", "content": inp.message, "created_at": now,
    })
    context = None
    if inp.focused_transaction_id:
        t = await db.transactions.find_one({"id": inp.focused_transaction_id, "company_id": inp.company_id})
        if t:
            context = {
                "date": t.get("date"), "merchant": t.get("merchant"),
                "amount": t.get("amount"), "current_category": t.get("category_account_name"),
                "confidence": t.get("ai_confidence"), "needs_review": t.get("needs_review"),
            }

    # Always inject a snapshot of the books so the AI can answer real questions
    company = await db.companies.find_one({"id": inp.company_id})
    today = datetime.now(timezone.utc).date()
    ytd_start = today.replace(month=1, day=1).isoformat()
    ytd_end = today.isoformat()
    inc = await R.compute_income_statement(inp.company_id, ytd_start, ytd_end,
                                            company.get("reporting_basis", "accrual"))
    bs = await R.compute_balance_sheet(inp.company_id, ytd_end,
                                        company.get("reporting_basis", "accrual"))
    txn_count = await db.transactions.count_documents({"company_id": inp.company_id})
    flagged = await db.transactions.count_documents({"company_id": inp.company_id, "needs_review": True})

    # ---- Transaction-level detail so the AI can drill in ----
    # Top expense categories YTD, by absolute amount.
    top_exp = sorted(
        (inc.get("expenses") or []),
        key=lambda x: abs(x.get("amount") or 0),
        reverse=True,
    )[:8]
    top_expense_categories = [
        {"name": e.get("account_name") or e.get("name"), "amount": round(e.get("amount") or 0, 2)}
        for e in top_exp
    ]
    top_rev = sorted(
        (inc.get("revenue") or []),
        key=lambda x: abs(x.get("amount") or 0),
        reverse=True,
    )[:5]
    top_revenue_categories = [
        {"name": r.get("account_name") or r.get("name"), "amount": round(r.get("amount") or 0, 2)}
        for r in top_rev
    ]

    # Top vendors (by outbound spend YTD) — group transactions by merchant.
    vendor_pipeline = [
        {"$match": {"company_id": inp.company_id, "date": {"$gte": ytd_start, "$lte": ytd_end}, "amount": {"$lt": 0}}},
        {"$group": {"_id": {"$ifNull": ["$contact_name", "$merchant"]}, "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        {"$sort": {"total": 1}},  # most negative (biggest spend) first
        {"$limit": 8},
    ]
    top_vendors = []
    async for r in db.transactions.aggregate(vendor_pipeline):
        name = r.get("_id")
        if not name:
            continue
        top_vendors.append({
            "vendor": name,
            "spend": round(abs(r.get("total") or 0), 2),
            "transactions": r.get("count") or 0,
        })

    # Recent transactions (last 10, most recent first).
    recent_docs = await db.transactions.find(
        {"company_id": inp.company_id}
    ).sort([("date", -1), ("_id", -1)]).limit(10).to_list(10)
    recent_transactions = [{
        "date": t.get("date"),
        "merchant": t.get("merchant") or t.get("contact_name"),
        "amount": round(t.get("amount") or 0, 2),
        "category": t.get("category_account_name"),
        "needs_review": bool(t.get("needs_review")),
    } for t in recent_docs]

    # Up to 10 flagged transactions the user could act on now.
    flagged_docs = await db.transactions.find(
        {"company_id": inp.company_id, "needs_review": True}
    ).sort([("date", -1)]).limit(10).to_list(10)
    flagged_sample = [{
        "date": t.get("date"),
        "merchant": t.get("merchant") or t.get("contact_name"),
        "amount": round(t.get("amount") or 0, 2),
        "current_category": t.get("category_account_name"),
        "confidence": t.get("ai_confidence"),
    } for t in flagged_docs]

    # A/R + A/P aging summaries (very compact — totals only).
    try:
        ar = await R.compute_ar_aging(inp.company_id, ytd_end)
        ap = await R.compute_ap_aging(inp.company_id, ytd_end)
    except Exception:
        ar = {"total_open": 0, "total_overdue": 0}
        ap = {"total_open": 0, "total_overdue": 0}

    # Diagnostic anomalies — so the AI can proactively flag data-entry
    # pathologies (negative liabilities, uncleared OBE, unbalanced BS…).
    try:
        diag = await _diagnose_books(inp.company_id)
        anomalies = diag.get("anomalies", [])[:5]  # cap for token budget
    except Exception:
        anomalies = []

    book_context = {
        "company": company.get("name") if company else "",
        "business_type": company.get("business_type") if company else "",
        "reporting_basis": company.get("reporting_basis", "accrual") if company else "accrual",
        "period": f"{ytd_start} to {ytd_end}",
        "total_revenue_ytd": inc["total_revenue"],
        "total_expenses_ytd": inc["total_expense"],
        "net_income_ytd": inc["net_income"],
        "total_assets": bs["total_assets"],
        "total_liabilities": bs["total_liabilities"],
        "total_equity": bs["total_equity"],
        "transactions": txn_count,
        "needs_review": flagged,
        "top_expense_categories": top_expense_categories,
        "top_revenue_categories": top_revenue_categories,
        "top_vendors": top_vendors,
        "recent_transactions": recent_transactions,
        "flagged_sample": flagged_sample,
        "ar_open": round(ar.get("total_open") or 0, 2),
        "ar_overdue": round(ar.get("total_overdue") or 0, 2),
        "ap_open": round(ap.get("total_open") or 0, 2),
        "ap_overdue": round(ap.get("total_overdue") or 0, 2),
        "anomalies": anomalies,
    }
    combined_context = {"books": book_context}
    if context:
        combined_context["focused_transaction"] = context

    full_reply = {"text": ""}

    async def event_gen():
        async for chunk in chat_stream(session_id, inp.message, combined_context,
                                        terseness=inp.terseness or "balanced"):
            full_reply["text"] += chunk
            yield f"data: {json.dumps({'delta': chunk})}\n\n"
        # save assistant msg
        await db.chat_messages.insert_one({
            "id": str(uuid.uuid4()), "session_id": session_id, "company_id": inp.company_id,
            "role": "assistant", "content": full_reply["text"], "created_at": now_iso(),
        })
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/ai/chat/history")
async def chat_history(company_id: str, session_id: Optional[str] = None,
                       user: dict = Depends(get_current_user)):
    await require_company(user, company_id)
    sid = session_id or f"chat-{company_id}-{user['id']}"
    docs = await db.chat_messages.find({"session_id": sid}).sort("created_at", 1).to_list(200)
    return {"messages": [coerce(d) for d in docs], "session_id": sid}


@router.delete("/ai/chat/history")
async def clear_chat_history(company_id: str, session_id: Optional[str] = None,
                             user: dict = Depends(get_current_user)):
    """Wipe the current user's chat transcript for a company. Used by the
    'Clear chat' button in the AI panel. Session-scoped so other users are
    unaffected."""
    await require_company(user, company_id)
    sid = session_id or f"chat-{company_id}-{user['id']}"
    r = await db.chat_messages.delete_many({"session_id": sid})
    return {"deleted": r.deleted_count, "session_id": sid}


class IntentIn(BaseModel):
    text: str


@router.post("/companies/{cid}/ai/parse-intent")
async def ai_parse_intent(cid: str, inp: IntentIn, user: dict = Depends(get_current_user)):
    """Parse a natural-language utterance into a structured create/open intent.

    Used by the voice-command router for 'create an invoice for X', 'open bill 1024', etc.
    Returns intent + confidence + prefill. For create intents we also try to
    resolve any mentioned contact name to an existing contact id so the modal
    can select the right dropdown value.
    """
    await require_company(user, cid)
    parsed = await parse_voice_intent(inp.text)

    prefill = parsed.get("prefill") or {}
    intent = parsed.get("intent") or "none"

    # For create_invoice / create_bill / open_contact: resolve contact_name against
    # existing contacts so the frontend can preselect it.
    lookup_name = None
    if intent in ("create_invoice", "create_bill"):
        lookup_name = prefill.get("contact_name")
    elif intent == "open_contact":
        lookup_name = prefill.get("name_or_number")

    if lookup_name:
        needle = str(lookup_name).lower().strip()
        contacts = await db.contacts.find({"company_id": cid}).to_list(2000)
        best = None
        best_score = 0
        for c in contacts:
            nm = str(c.get("name") or "").lower().strip()
            if not nm:
                continue
            if nm == needle:
                score = 1000
            elif needle in nm or nm in needle:
                score = 500 + max(len(needle), 1)
            else:
                # per-word overlap
                w_needle = set(w for w in needle.split() if len(w) >= 2)
                w_nm = set(nm.split())
                overlap = len(w_needle & w_nm)
                score = overlap * 10 if overlap else 0
            if score > best_score:
                best_score = score
                best = c
        if best and best_score >= 10:
            prefill["contact_id"] = best.get("id")
            prefill["contact_name"] = best.get("name")
            prefill["matched_existing"] = True

    parsed["prefill"] = prefill
    return parsed


