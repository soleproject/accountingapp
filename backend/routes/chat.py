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

from routes.anomaly import _diagnose_books
router = APIRouter(prefix="/api")


# ----------------------- AI Chat (SSE) -----------------------

@router.post("/ai/chat/stream")
async def ai_chat_stream(inp: ChatIn, user: dict = Depends(get_current_user)):
    await require_company(user, inp.company_id)
    session_id = inp.session_id or f"chat-{inp.company_id}-{user['id']}"
    now = now_iso()
    # Fetch prior turns for this session BEFORE inserting the new user
    # message so the LLM sees full multi-turn context (fixes the bug
    # where the AI re-asked for details already given, e.g. Fixed Asset
    # $350k / May 15 / $100k down + rest financed). Cap to the last 20
    # turns to keep the prompt bounded.
    prior_docs = await db.chat_messages.find(
        {"session_id": session_id, "role": {"$in": ["user", "assistant"]}}
    ).sort("created_at", -1).limit(20).to_list(20)
    prior_docs.reverse()
    _PROP_RE_HIST = re.compile(r"\[\[PROPOSAL:[^\]]+\]\]")
    history = []
    for d in prior_docs:
        content = d.get("content") or ""
        if d.get("role") == "assistant":
            content = _PROP_RE_HIST.sub("", content).rstrip()
        if content:
            history.append({"role": d.get("role"), "content": content})
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

    # Vendor-bucket focus (fired by the mega-approve modal's Sparkle
    # button). Give the LLM the shape of the bucket + a sample of the
    # actual rows so it can answer "why is this categorized as Supplies?"
    # or "make it a rule" with real awareness.
    if inp.focused_bucket:
        b = inp.focused_bucket
        contact_name = (b.get("contact_name") or "").strip()
        sample = []
        if contact_name:
            async for t in db.transactions.find({
                "company_id": inp.company_id,
                "$or": [
                    {"contact_name": contact_name},
                    {"merchant": contact_name},
                ],
            }).sort("date", -1).limit(6):
                sample.append({
                    "date": t.get("date"),
                    "description": t.get("description") or t.get("merchant"),
                    "amount": t.get("amount"),
                    "category": t.get("category_account_name") or t.get("account_name"),
                    "status": t.get("status"),
                })
        combined_context["focused_bucket"] = {
            "contact_name": contact_name,
            "count": b.get("count"),
            "amount_total": b.get("amount"),
            "current_category_code": b.get("account_code"),
            "current_category_name": b.get("account_name"),
            "sample_rows": sample,
        }

    # Guided fixed-asset creation focus — set when the user clicked the
    # Sparkles button on the New/Edit Fixed Asset modal. Injects the
    # current draft + a directive that tells the LLM to ask discovery
    # questions and emit `[[PROPOSAL:{"kind":"create-fixed-asset",...}]]`
    # once it has enough to fill in the form. If the user needs a
    # mortgage/loan account created first, emit
    # `[[PROPOSAL:{"kind":"create-liability-account",...}]]` earlier in the
    # conversation.
    if inp.focused_new_asset:
        # Bank + liability + equity accounts the LLM can suggest as offsets.
        offset_candidates = []
        async for a in db.accounts.find({
            "company_id": inp.company_id, "active": True,
            "type": {"$in": ["asset", "liability", "equity"]},
        }, {"id": 1, "code": 1, "name": 1, "type": 1, "subtype": 1}).limit(200):
            offset_candidates.append({
                "id": a["id"], "code": a.get("code"), "name": a.get("name"),
                "type": a.get("type"), "subtype": a.get("subtype"),
            })
        combined_context["new_fixed_asset"] = {
            "draft": inp.focused_new_asset.get("draft") or {},
            "editing": bool(inp.focused_new_asset.get("editing")),
            "asset_types_reference": [
                "residential_real_estate (27.5 yrs)",
                "commercial_real_estate (39 yrs)",
                "vehicle (5 yrs)",
                "computer_equipment (5 yrs)",
                "machinery_equipment (7 yrs)",
                "office_furniture (7 yrs)",
                "land_improvements / building_improvements / leasehold_improvements (15 yrs each)",
                "land (non-depreciable — separate from building)",
                "other (custom life)",
            ],
            "offset_candidates": offset_candidates,
            "pending_funding_assets": [
                {
                    "id": a.get("id"),
                    "name": a.get("name"),
                    "cost": a.get("cost"),
                    "funded_amount": a.get("funded_amount") or 0.0,
                    "remaining": round(
                        (a.get("cost") or 0) - (a.get("funded_amount") or 0), 2
                    ),
                }
                async for a in db.assets.find(
                    {"company_id": inp.company_id, "pending_funding": True},
                    {"id": 1, "name": 1, "cost": 1, "funded_amount": 1},
                ).sort("created_at", -1).limit(10)
            ],
            "directive": (
                "You are helping the user add a Fixed Asset using a TWO-"
                "PHASE FLOW. Do NOT try to gather funding details on the "
                "first pass — get the asset created and on the books first, "
                "then handle funding separately.\n\n"
                "STAY IN FIXED-ASSET MODE until you emit "
                "[[PROPOSAL:create-fixed-asset]] or the user explicitly "
                "cancels — do NOT ask to 'hover a transaction' or 'click "
                "the sparkle', do NOT offer generic categorization help.\n\n"
                "FIRST — CHECK `pending_funding_assets` in this context. "
                "If it is NON-EMPTY, an asset shell already exists and is "
                "waiting to be funded. SKIP PHASE 1 ENTIRELY and go "
                "straight to PHASE 2 for the most recent pending asset "
                "(the first entry in the list). Use its `id` as "
                "`asset_id` in the fund-fixed-asset proposal and its "
                "`remaining` as the maximum total funding amount. Do NOT "
                "re-create the asset — it's already on the books.\n\n"
                "PHASE 1 — CREATE THE ASSET SHELL (only when "
                "`pending_funding_assets` is empty):\n"
                "Ask short, concrete questions ONLY for these fields: "
                "name (or address), purchase_date (YYYY-MM-DD — extract "
                "from what the user said, e.g. 'May 15 this year' → "
                "'2026-05-15'; NEVER default to today), cost, asset_type "
                "(pick from asset_types_reference), and useful_life_years "
                "(optional if the type has a preset). Do NOT ask about "
                "cash-down / loan / mortgage / funding at this stage.\n\n"
                "LIVE FORM-FILL — as each field becomes known from the "
                "user's message, emit a partial DRAFT marker on that "
                "same reply so the New Fixed Asset modal fills in real "
                "time. Shape (any subset of fields is valid):\n"
                "[[DRAFT:{\"name\":\"...\",\"purchase_date\":"
                "\"YYYY-MM-DD\",\"cost\":NNN,\"asset_type\":\"...\","
                "\"useful_life_years\":NN}]]\n"
                "Emit DRAFT often — even if only 1-2 fields are known. "
                "Example flow: user says 'I bought 123 Main for $175k on "
                "January 5' → your reply emits "
                "[[DRAFT:{\"name\":\"123 Main\",\"cost\":175000,"
                "\"purchase_date\":\"2026-01-05\"}]] alongside asking "
                "about asset_type. When user answers 'residential real "
                "estate' → next reply emits [[DRAFT:{\"asset_type\":"
                "\"residential_real_estate\"}]].\n\n"
                "Once you have those fields, emit the marker AT THE END OF "
                "THE SAME MESSAGE where you present the summary. Shape:\n"
                "[[PROPOSAL:{\"kind\":\"create-fixed-asset\",\"payload\":"
                "{\"name\":\"...\",\"purchase_date\":\"YYYY-MM-DD\","
                "\"cost\":NNN,\"asset_type\":\"...\","
                "\"useful_life_years\":NN}}]]\n"
                "NOTE: Do NOT include an `offsets` field in Phase 1 — "
                "leaving it out signals the backend to book the acquisition "
                "against 'Fixed Asset Suspense' (a system-managed clearing "
                "account). The user sees the asset on Fixed Assets + Chart "
                "of Accounts immediately.\n\n"
                "PHASE 2 — WALK THROUGH FUNDING (when `pending_funding_"
                "assets` is non-empty):\n"
                "Look at `pending_funding_assets[0]` — that's the asset "
                "you're funding. Its `id`, `name`, `cost`, and `remaining` "
                "are all provided. Ask how it was funded — cash amount, "
                "loan/mortgage amount, owner contribution, etc. You can "
                "gather multiple sources across multiple turns; each "
                "funding action clears part of the Suspense balance.\n\n"
                "When creating a mortgage/loan/HELOC funding source, emit "
                "a create-liability-account proposal WITH the SUB-ACCOUNT "
                "POLICY parent_account_id (see below) AND any known loan "
                "metadata (lender, principal, rate, term_months). Convert "
                "years → months (30-year mortgage → term_months=360). "
                "Wait for the user to confirm and the account to be "
                "created before emitting the fund-fixed-asset proposal.\n\n"
                "Once you have the account UUID(s) for the funding sources "
                "(from offset_candidates, after any needed liability "
                "creation), emit the FUND proposal:\n"
                "[[PROPOSAL:{\"kind\":\"fund-fixed-asset\",\"payload\":"
                "{\"asset_id\":\"<uuid from pending_funding_assets[0].id>\","
                "\"sources\":[{\"account_id\":\"<uuid>\",\"amount\":NNN},"
                " ...]}}]]\n"
                "All account_id values MUST be UUIDs from "
                "offset_candidates — never codes or names. sources[] "
                "amounts must NOT exceed the asset's `remaining` value.\n\n"
                "SUB-ACCOUNT POLICY (firm-wide, applies to ALL loan/HELOC/"
                "credit-card creations, not just when the user asks): every "
                "loan, mortgage, note payable, line of credit, HELOC, or "
                "credit card MUST be created as a sub-account under a "
                "canonical parent. For loans/mortgages/HELOCs the parent is "
                "'Loans Payable' (or 'Notes Payable' if that exists instead). "
                "For credit cards the parent is 'Credit Cards Payable'. "
                "Always include a parent_account_id in the "
                "create-liability-account proposal — even on the first "
                "creation. The backend will auto-create the parent if it "
                "doesn't exist yet, but you should still emit the child "
                "proposal with the parent's UUID when it IS in "
                "offset_candidates.\n\n"
                "IMPORTANT: for real estate specifically, remind the user "
                "in PHASE 1 that land is not depreciable — offer to split "
                "into land + building assets (the depreciable building is "
                "what needs a useful_life_years). Do NOT block the Phase 1 "
                "proposal on this — proceed with what the user prefers."
            ),
        }

    full_reply = {"text": ""}

    # Regex that matches the hidden proposal marker the AI emits (parsed
    # client-side to power "yes → do it" follow-throughs). We strip it
    # from the persisted transcript so history reloads don't render the
    # raw `[[PROPOSAL:...]]` tag inside a chat bubble.
    _PROPOSAL_RE = re.compile(r"\[\[PROPOSAL:[^\]]+\]\]")

    async def event_gen():
        async for chunk in chat_stream(session_id, inp.message, combined_context,
                                        terseness=inp.terseness or "balanced",
                                        history=history):
            full_reply["text"] += chunk
            yield f"data: {json.dumps({'delta': chunk})}\n\n"
        # save assistant msg — strip the hidden proposal marker first.
        clean_text = _PROPOSAL_RE.sub("", full_reply["text"]).rstrip()
        await db.chat_messages.insert_one({
            "id": str(uuid.uuid4()), "session_id": session_id, "company_id": inp.company_id,
            "role": "assistant", "content": clean_text, "created_at": now_iso(),
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
    # Legacy rows may have been persisted with the raw [[PROPOSAL:...]] tag
    # before the strip-on-save fix landed. Scrub on read so past transcripts
    # display cleanly without needing a migration.
    _PROP_RE = re.compile(r"\[\[PROPOSAL:[^\]]+\]\]")
    out = []
    for d in docs:
        c = coerce(d)
        if c.get("role") == "assistant" and isinstance(c.get("content"), str):
            c["content"] = _PROP_RE.sub("", c["content"]).rstrip()
        out.append(c)
    return {"messages": out, "session_id": sid}


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


def _match_item(needle: str, catalog: list[dict]) -> Optional[dict]:
    """Fuzzy-match a spoken item reference against the company's item
    catalog. Ranking (highest wins):

      exact case-insensitive name         → 1000
      normalized-substring both ways      →  500
      per-word overlap × 10                → variable

    Voice STT often emits ordinal number-words ('widget one' for 'Widget
    1') or plurals ('widget ones'), so we normalize by lowercasing,
    stripping trailing plural 's', and mapping the first ten ordinal
    words to their digit equivalents on BOTH sides of the comparison.
    """
    if not needle or not catalog:
        return None

    _ORDINAL = {
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    }

    def _norm(s: str) -> str:
        s = str(s or "").lower().strip()
        # collapse whitespace / punctuation
        s = re.sub(r"[^\w\s]", " ", s)
        toks = [t for t in s.split() if t]
        out = []
        for t in toks:
            # trailing plural (widget → widget, ones → one)
            base = t[:-1] if len(t) > 3 and t.endswith("s") else t
            out.append(_ORDINAL.get(base, base))
        return " ".join(out)

    n = _norm(needle)
    if not n:
        return None
    n_words = set(w for w in n.split() if len(w) >= 2)

    best = None
    best_score = 0
    for it in catalog:
        cand = _norm(it.get("name") or "")
        if not cand:
            continue
        if cand == n:
            score = 1000
        elif n in cand or cand in n:
            score = 500 + max(len(n), 1)
        else:
            c_words = set(cand.split())
            overlap = len(n_words & c_words)
            score = overlap * 10 if overlap else 0
        if score > best_score:
            best_score = score
            best = it
    # Require some real signal — a single 1-char accidental overlap
    # shouldn't hydrate a random item.
    return best if best_score >= 10 else None


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

    # For create_invoice / create_bill: resolve `lines[]` against the item
    # catalog so a spoken "five widget ones" hydrates into a real line
    # {item_id, description, rate, quantity, income_account_*}. If the AI
    # extracted an amount instead of lines (or the item name doesn't match),
    # we leave prefill alone so the modal falls back to the freeform single-
    # line-with-amount path.
    if intent in ("create_invoice", "create_bill"):
        raw_lines = prefill.get("lines")
        if isinstance(raw_lines, list) and raw_lines:
            usage = "sales" if intent == "create_invoice" else "purchases"
            catalog = await db.items.find({
                "company_id": cid,
                "active": {"$ne": False},
                "$or": [{"usage": usage}, {"usage": "both"}],
            }).to_list(2000)
            resolved: list[dict] = []
            for entry in raw_lines:
                if not isinstance(entry, dict):
                    continue
                nm = str(entry.get("item_name") or "").strip()
                try:
                    qty = float(entry.get("quantity") or 1) or 1
                except (TypeError, ValueError):
                    qty = 1
                if not nm:
                    continue
                match = _match_item(nm, catalog)
                if match:
                    rate = float(match.get("price") or 0)
                    resolved.append({
                        "item_id": match.get("id"),
                        "item_name": match.get("name"),
                        "description": match.get("description") or match.get("name") or nm,
                        "quantity": qty,
                        "rate": rate,
                        "amount": round(qty * rate, 2),
                        "income_account_id": match.get("income_account_id") or match.get("account_id"),
                        "income_account_name": match.get("income_account_name") or match.get("account_name") or "",
                    })
                else:
                    # No catalog hit — keep the reference as a freeform line
                    # with zero rate so the user can fill it in manually.
                    resolved.append({
                        "description": nm,
                        "quantity": qty,
                        "rate": 0,
                        "amount": 0,
                    })
            if resolved:
                prefill["lines"] = resolved

    parsed["prefill"] = prefill
    return parsed


