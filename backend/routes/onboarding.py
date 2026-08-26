"""Axiom Ledger — Onboarding routes.

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
from datetime import datetime, timezone, timedelta, date
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
    parse_voice_intent, _new_chat, _extract_json,
)
from llm_client import UserMessage
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


# ------------------------------------------------------------------
# Business-type canonicalization
# ------------------------------------------------------------------
# The frontend now offers exactly seven entity forms in its dropdowns
# (Sole Proprietor, LLC – Partnership, LLC – "S"/"C" Elected, "S"/"C"
# Corporation, Limited Partnership). Whenever a value flows in from a
# user-typed voice utterance, a legacy text field, or a mid-drift LLM
# extraction, we snap it to one of the seven canonicals before writing
# it to `companies.business_type`. This keeps the reports/dashboard
# switches and the tax-treatment logic downstream working against a
# closed, predictable enum.
_CANONICAL_BUSINESS_TYPES: tuple[str, ...] = (
    "Sole Proprietor",
    "LLC – Partnership",
    'LLC – "S" Elected',
    'LLC – "C" Elected',
    '"S" Corporation',
    '"C" Corporation',
    "Limited Partnership",
)


def _canonicalize_business_type(raw: str | None) -> str | None:
    """Map any freeform business-type string to one of the seven
    canonical entity forms. Returns None if nothing sensible can be
    inferred, so callers can decide whether to persist a blank.

    Matching rules (checked in order):
      1. Exact match against the canonical list (case-insensitive).
      2. Keyword heuristics tuned for common voice/typed variants
         ('sole prop', 'sub-s', 's-corp llc', 'inc', 'limited
         partnership', etc.).
      3. Bare 'LLC' with no election detail → 'LLC – Partnership'
         (IRS default treatment for multi-member LLCs).
      4. Fallback: return the input as-is (untouched) so we don't
         silently drop legacy values on a partial update.
    """
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    low = s.lower()
    for c in _CANONICAL_BUSINESS_TYPES:
        if c.lower() == low:
            return c
    has_llc = "llc" in low or "limited liability" in low
    has_s = ("s-corp" in low or "s corp" in low or "sub s" in low
             or "sub-s" in low or "subchapter s" in low or '"s"' in low
             or " s elected" in low or "s-elected" in low
             or "elected s" in low or "s election" in low
             or "filing 2553" in low or "form 2553" in low)
    has_c = ("c-corp" in low or "c corp" in low or '"c"' in low
             or " c elected" in low or "c-elected" in low
             or "elected c" in low or "c election" in low)
    if has_llc and has_s:
        return 'LLC – "S" Elected'
    if has_llc and has_c:
        return 'LLC – "C" Elected'
    if has_llc:
        return "LLC – Partnership"
    if "limited partnership" in low or low == "lp" or low.endswith(" lp"):
        return "Limited Partnership"
    if has_s or "s corporation" in low:
        return '"S" Corporation'
    if has_c or "c corporation" in low or "inc" in low or "corporation" in low:
        return '"C" Corporation'
    if ("sole prop" in low or "sole-prop" in low or "sole proprietor" in low
            or "self-employed" in low or "self employed" in low
            or "schedule c" in low or low == "dba"):
        return "Sole Proprietor"
    # Unrecognised — hand back untouched. The caller can decide.
    return s


# ----------------------- Onboarding -----------------------

@router.get("/companies/{cid}/onboarding")
async def get_onboarding(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await db.onboarding_state.find_one({"company_id": cid})
    if not doc:
        doc = {"id": str(uuid.uuid4()), "company_id": cid, "step": 0, "total_steps": 6,
               "complete": False, "answers": {}, "created_at": now_iso(), "updated_at": now_iso()}
        await db.onboarding_state.insert_one(doc)
    return {"onboarding": coerce(doc)}


@router.patch("/companies/{cid}/onboarding")
async def update_onboarding(cid: str, inp: OnboardingUpdate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    upd = {k: v for k, v in inp.model_dump(exclude_unset=True).items() if v is not None}
    upd["updated_at"] = now_iso()
    await db.onboarding_state.update_one({"company_id": cid}, {"$set": upd}, upsert=True)
    # Propagate the business-profile answers (basis / business type / description)
    # onto the company doc so downstream defaults (Reports basis toggle, Dashboard
    # KPI copy, Company Settings) reflect whatever the user picked here. Kept
    # narrow — we only sync fields the business-profile step owns, so any AI
    # extraction can't blow away unrelated company data.
    answers = (inp.answers or {}) if isinstance(inp.answers, dict) else {}
    company_sync: dict = {}
    basis = answers.get("basis") or answers.get("accounting_method")
    if basis in ("accrual", "cash"):
        company_sync["reporting_basis"] = basis
    if isinstance(answers.get("business_type"), str) and answers["business_type"].strip():
        # Snap to one of the seven canonical entity forms before writing.
        # See `_canonicalize_business_type` for the mapping rules.
        canon = _canonicalize_business_type(answers["business_type"])
        if canon:
            company_sync["business_type"] = canon
    if isinstance(answers.get("business_description"), str) and answers["business_description"].strip():
        company_sync["business_description"] = answers["business_description"].strip()
    if company_sync:
        company_sync["updated_at"] = now_iso()
        await db.companies.update_one({"id": cid}, {"$set": company_sync})
    if inp.complete:
        await db.companies.update_one({"id": cid}, {"$set": {"onboarding_complete": True}})
    return {"ok": True}


# --- AI onboarding coach --------------------------------------------------
# Per-step extraction schemas the coach uses to turn a freeform sentence
# ("It's a consulting company that does IT security audits") into typed form
# fields the frontend can drop straight into the current step's inputs.
_COACH_STEP_SCHEMAS: dict[str, dict] = {
    "business_profile": {
        "system": (
            "You are a CPA guiding a small-business owner through onboarding. "
            "Given a freeform sentence describing their business, extract the "
            "structured business profile fields. Respond with STRICT JSON — "
            "no prose, no code fences. Missing fields → omit the key.\n\n"
            "`business_type` MUST be exactly one of these seven canonical entity "
            "forms (map colloquial phrases to the closest match):\n"
            "  • \"Sole Proprietor\"     — 'sole prop', 'DBA', 'self-employed', "
            "'schedule C', unincorporated single-owner\n"
            "  • \"LLC – Partnership\"    — 'multi-member LLC' with no S/C election, "
            "'LLC taxed as partnership'\n"
            "  • \"LLC – \\\"S\\\" Elected\" — 'LLC S-corp', 'LLC elected S', "
            "'S-elected LLC', 'LLC filing 2553'\n"
            "  • \"LLC – \\\"C\\\" Elected\" — 'LLC taxed as C-corp', 'C-elected LLC'\n"
            "  • \"\\\"S\\\" Corporation\"    — 'S-corp', 'Subchapter S', 'S corporation' "
            "(NOT an LLC)\n"
            "  • \"\\\"C\\\" Corporation\"    — 'C-corp', 'Inc.', 'corporation' "
            "(NOT an LLC, no S election)\n"
            "  • \"Limited Partnership\"   — 'LP', 'limited partnership'\n"
            "If the user just says 'LLC' with no tax-election detail, default to "
            "\"LLC – Partnership\" (the IRS-default treatment for multi-member LLCs). "
            "Omit `business_type` entirely if truly ambiguous."
        ),
        "example_input": "We're an LLC doing IT security consulting for hospitals, cash-basis for now.",
        "example_output": {
            "business_type": "LLC – Partnership",
            "industry": "IT Security Consulting",
            "business_description": "IT security consulting for hospitals",
            "accounting_method": "cash",
        },
        "fields": ["business_type", "industry", "business_description",
                   "fiscal_year_end", "accounting_method", "entity_form"],
    },
    "qbo_link": {
        "system": (
            "You are a CPA guiding onboarding. Given a user's reply about whether "
            "they use QuickBooks Online today, extract whether they want to link "
            "QBO. Respond with STRICT JSON — no prose, no code fences. "
            "Use 'yes' if they currently use QBO / want to link it, 'no' if they "
            "want to start fresh. Omit the key if truly ambiguous."
        ),
        "example_input": "Yeah we're on QuickBooks Online right now.",
        "example_output": {"qbo": "yes"},
        "fields": ["qbo"],
    },
    "coa_overrides": {
        "system": (
            "You are a CPA guiding onboarding. The user is reviewing their "
            "AI-generated chart of accounts and may want to add or drop "
            "specific accounts. Extract their requested overrides. Respond "
            "with STRICT JSON — no prose, no code fences."
        ),
        "example_input": "Add a food truck fuel account and we don't need consulting revenue.",
        "example_output": {
            "add_hints": ["food truck fuel"],
            "remove_hints": ["consulting revenue"],
            "notes": "Food-truck operator, no consulting income",
        },
        "fields": ["add_hints", "remove_hints", "notes"],
    },
    "plaid_intent": {
        "system": (
            "You are a CPA guiding onboarding for a bank-link step. The user "
            "was just asked whether they want to hook up their bank accounts. "
            "Extract whether the user wants to skip the bank link (either "
            "outright or for now) and any institution name they mentioned. "
            "Respond with STRICT JSON — no prose. Set `skip: true` when the "
            "user says any of: 'skip', 'no', 'not now', 'later', 'do later', "
            "'come back to this', 'we'll do it later', 'no thanks', 'pass'. "
            "Set `skip: false` (or omit) only when they clearly want to link now."
        ),
        "example_input": "No, let's skip that for now.",
        "example_output": {"skip": True},
        "fields": ["skip", "institution_hint"],
    },
    "veryfi_intent": {
        "system": (
            "You are a CPA guiding onboarding for a statement-upload step. "
            "Extract whether the user wants to skip uploading old paper "
            "statements for now. Respond with STRICT JSON — no prose. "
            "Use `skip: true` ONLY when they explicitly want to skip / do later."
        ),
        "example_input": "Skip, we don't have any old statements to upload.",
        "example_output": {"skip": True},
        "fields": ["skip"],
    },
    "ready_confirm": {
        "system": (
            "You are a CPA closing onboarding. Extract whether the user is "
            "confirming they're ready to enter their books (e.g. 'let's go', "
            "'ready', 'i'm good'). Respond with STRICT JSON — no prose."
        ),
        "example_input": "Yep, let's go!",
        "example_output": {"confirm": True},
        "fields": ["confirm"],
    },
}


@router.post("/companies/{cid}/onboarding/extract-step")
async def onboarding_coach_extract(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """AI onboarding coach — turns the user's freeform chat reply for the
    current onboarding step into typed form fields the frontend can drop
    into the step's inputs and auto-advance.

    Body: `{"step": "business_profile", "message": "we're an LLC that ..."}`
    Returns: `{"fields": {...}, "step": "..."}` — keys are the schema fields
    the LLM confidently extracted; missing fields are omitted so the caller
    can merge on top of whatever's already in state.
    """
    await require_company(user, cid)
    step = (payload.get("step") or "").strip()
    message = (payload.get("message") or "").strip()
    schema = _COACH_STEP_SCHEMAS.get(step)
    if not schema:
        raise HTTPException(400, f"Unknown onboarding step: {step!r}")
    if not message:
        return {"step": step, "fields": {}}
    prompt = (
        f"{schema['system']}\n\n"
        f"Extract these fields when present: {', '.join(schema['fields'])}.\n"
        f"Example input: {schema['example_input']}\n"
        f"Example output JSON: {json.dumps(schema['example_output'])}\n\n"
        f"User message:\n{message}\n\n"
        "Reply with JSON only."
    )
    chat = _new_chat(schema["system"], session_id=f"coach:{cid}:{step}")
    try:
        resp = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error: {e}")
    data = _extract_json(resp) or {}
    # Whitelist to the schema fields only — never trust the LLM to invent
    # extra keys the frontend doesn't expect.
    fields = {k: v for k, v in data.items() if k in schema["fields"] and v}
    # Per-step value guards — keep persisted state clean even when the LLM
    # inserts sentinel values like 'ambiguous' for enum-like fields.
    if step == "qbo_link" and fields.get("qbo") not in ("yes", "no"):
        fields.pop("qbo", None)
    # Snap `business_type` to one of the seven canonical entity forms
    # BEFORE handing it back to the frontend, so the dropdown always
    # renders a selected value (colloquial LLM output like "LLC" or
    # "S-corp" would otherwise render blank).
    if step == "business_profile" and isinstance(fields.get("business_type"), str):
        canon = _canonicalize_business_type(fields["business_type"])
        if canon:
            fields["business_type"] = canon
    return {"step": step, "fields": fields}


# Step-specific "what does this step do?" grounding — feeds the coach a
# short brief so it answers questions like "what will connecting my bank
# do?" or "what if I don't have statements?" in the user's actual context.
_COACH_STEP_BRIEFS = {
    "business_profile": (
        "This is step 1 of onboarding — Business Profile. We're capturing the "
        "business type, a one-sentence description of what it does, its fiscal "
        "year end (usually Dec 31), reporting basis (Accrual vs Cash), and legal "
        "form (LLC/S-Corp/etc.). Everything downstream (chart of accounts, "
        "tax categorization, industry benchmarks) uses this."
    ),
    "qbo_link": (
        "This is the QuickBooks Online link step. If the client already uses QBO, "
        "we can pull their historical chart of accounts + transactions in the "
        "background so they don't have to start from scratch. If they don't, we "
        "set up a fresh GAAP-baseline CoA together in the next steps."
    ),
    "coa_overrides": (
        "This is the Chart of Accounts step. We start from a 30-account GAAP "
        "baseline and can layer 15-25 industry-specific accounts on top (e.g. "
        "for a coffee roaster: Green Coffee COGS, Roasting Supplies, Barista "
        "Wages). Users can ask us to add or remove specific accounts before we "
        "apply them."
    ),
    "plaid_intent": (
        "This is the bank connection step (Plaid). Connecting a bank lets us "
        "download transactions automatically every night, tag them with vendor "
        "info, run AI categorization, and reconcile balances. Users can link "
        "multiple accounts (checking, credit card, savings) or skip and connect "
        "later from Settings. Sandbox creds for testing: user_good / pass_good."
    ),
    "veryfi_intent": (
        "This is the statement upload step (Veryfi OCR). For anything Plaid "
        "couldn't reach — old paper statements, credit-union PDFs, PayPal "
        "exports, standalone receipts — the user drops files here and Veryfi "
        "OCR extracts the transaction rows so we can categorize them. Users "
        "can skip if they don't have anything to upload."
    ),
    "ready_confirm": (
        "This is the final review step. Everything the AI could categorize "
        "confidently is queued as 'AI Categorized' for one-click approval. "
        "Anything flagged is waiting on the user's judgement. Saying 'let's "
        "go' finishes onboarding and drops them into their transactions view."
    ),
}


@router.post("/companies/{cid}/onboarding/coach-answer")
async def onboarding_coach_answer(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """AI onboarding coach — answers freeform questions the user asks during
    a specific onboarding step. Unlike /extract-step (which returns typed
    form fields), this returns a short natural-language response the coach
    speaks back into the chat.

    Body: `{"step": "plaid_intent", "message": "what will connecting the bank do?"}`
    Returns: `{"answer": "Connecting your bank lets us..."}`
    """
    await require_company(user, cid)
    step = (payload.get("step") or "").strip()
    message = (payload.get("message") or "").strip()
    brief = _COACH_STEP_BRIEFS.get(step, "")
    if not message:
        return {"answer": ""}
    company = await db.companies.find_one({"id": cid}) or {}
    system = (
        "You are a warm, expert CPA guiding a client through onboarding. Answer "
        "the user's question in 2-3 short conversational sentences at most. "
        "Reference the specific on-page action they can take (e.g. 'click "
        "Launch Plaid Link', 'click Upload real statement', 'say skip'). "
        "Never invent features or make up numbers. Do not use bullet points, "
        "code blocks, or headings — just plain conversational prose so it "
        "sounds natural when read aloud. If the user is clearly asking to "
        "move on / skip / do the step, END your reply with exactly the marker "
        "[ADVANCE] on its own line. If they're clearly asking to launch a "
        "connect flow (Plaid, upload, QBO), END with [LAUNCH:plaid] or "
        "[LAUNCH:upload] or [LAUNCH:qbo] on its own line. Otherwise omit the "
        "marker. \n\n"
        f"Client company: {company.get('name', 'this business')}\n"
        f"Current step brief: {brief}"
    )
    chat = _new_chat(system, session_id=f"coach-qa:{cid}:{step}")
    try:
        resp = await chat.send_message(UserMessage(text=message))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error: {e}")
    # Strip markers and return alongside the parsed action.
    action = None
    text = (resp or "").strip()
    m = re.search(r"\[ADVANCE\]", text)
    if m:
        action = "advance"
        text = text.replace(m.group(0), "").strip()
    m = re.search(r"\[LAUNCH:(plaid|upload|qbo)\]", text, flags=re.IGNORECASE)
    if m:
        action = f"launch:{m.group(1).lower()}"
        text = text.replace(m.group(0), "").strip()
    return {"answer": text, "action": action}



@router.post("/companies/{cid}/onboarding/coa/suggest")
async def suggest_coa(cid: str, user: dict = Depends(get_current_user)):
    """Preview an AI-tailored chart of accounts without writing anything.
    Returns a list of `{code, name, type, subtype, rationale, already_exists}`
    so the UI can render a review-and-select screen before insertion.
    """
    company = await require_company(user, cid)
    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    existing_codes = [a["code"] for a in existing]
    suggestions = await suggest_chart_of_accounts(
        company.get("business_type", ""),
        company.get("business_description", ""),
        existing_codes=existing_codes,
    )
    existing_set = set(existing_codes)
    for s in suggestions:
        s["already_exists"] = s["code"] in existing_set
    return {"business_type": company.get("business_type", ""),
            "suggestions": suggestions}


@router.post("/companies/{cid}/onboarding/generate-coa")
async def generate_coa(cid: str, payload: dict | None = None,
                       user: dict = Depends(get_current_user)):
    """Insert AI-suggested industry-specific accounts.

    Body (optional): `{codes: ["4110", "5210", ...]}` — insert ONLY these
    codes from the current AI suggestion. If omitted, inserts every
    non-duplicate suggestion (legacy behavior).
    """
    company = await require_company(user, cid)
    extras = await suggest_chart_of_accounts(
        company.get("business_type", ""),
        company.get("business_description", ""),
        existing_codes=[a["code"] for a in
                        await db.accounts.find({"company_id": cid}).to_list(2000)],
    )
    wanted_codes = None
    if isinstance(payload, dict) and payload.get("codes"):
        wanted_codes = {str(c).strip() for c in payload["codes"] if c}
    # Refresh existing set to make the insert idempotent even if a concurrent
    # call added a code between the AI call and the write.
    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    codes = {a["code"] for a in existing}
    added = 0
    inserted = []
    for x in extras:
        if x["code"] in codes:
            continue
        if wanted_codes is not None and x["code"] not in wanted_codes:
            continue
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "code": x["code"], "name": x["name"],
            "type": x.get("type", "expense"),
            "subtype": x.get("subtype", "operating_expense"),
            "active": True, "balance": 0.0,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        added += 1
        inserted.append(x)
    await log_ai(cid, "coa_generated", added)
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"added": added, "suggestions": extras, "inserted": inserted}



@router.post("/companies/{cid}/onboarding/interview/questions")
async def onboarding_interview(cid: str, user: dict = Depends(get_current_user)):
    """Return 4-5 targeted onboarding questions tailored to the business type."""
    company = await require_company(user, cid)
    questions = await onboarding_interview_questions(
        company.get("business_type", ""),
        company.get("business_description", ""),
    )
    return {"business_type": company.get("business_type", ""), "questions": questions}


@router.post("/companies/{cid}/onboarding/interview/synthesize")
async def onboarding_interview_apply(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
):
    """Take the interview answers and produce refined CoA + starter rules.

    Body: `{answers: [{id, question, answer}, ...], apply: bool}`
    - `apply=false` (default): preview mode — nothing written.
    - `apply=true`: insert every returned account + create every returned rule
      (rules run `apply_to_existing=true` so historic un-reviewed txns are
      back-filled). Returns counts.

    Persists the raw answers on the company so we can retrain later.
    """
    company = await require_company(user, cid)
    answers = payload.get("answers") or []
    apply = bool(payload.get("apply", False))

    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    existing_min = [{"code": a["code"], "name": a["name"],
                     "type": a.get("type", "")} for a in existing]
    existing_codes = [a["code"] for a in existing]

    result = await onboarding_interview_synthesize(
        company.get("business_type", ""),
        company.get("business_description", ""),
        answers=answers,
        existing_codes=existing_codes,
        existing_accounts=existing_min,
    )
    # Persist raw answers even in preview mode — useful for auditing +
    # future re-runs when the AI improves.
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"onboarding_interview_answers": answers,
                  "onboarding_interview_at": now_iso()}},
    )

    if not apply:
        return {"apply": False, **result}

    now = now_iso()
    # 1) Insert every new account
    inserted_accounts = 0
    inserted_codes: dict[str, dict] = {}
    for a in result.get("accounts", []):
        exists = await db.accounts.find_one({"company_id": cid, "code": a["code"]})
        if exists:
            inserted_codes[a["code"]] = exists
            continue
        aid = str(uuid.uuid4())
        doc = {
            "id": aid, "company_id": cid, "code": a["code"], "name": a["name"],
            "type": a.get("type", "expense"),
            "subtype": a.get("subtype", "operating_expense"),
            "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        }
        await db.accounts.insert_one(doc)
        inserted_codes[a["code"]] = doc
        inserted_accounts += 1

    # 2) Create every rule + back-fill matching un-reviewed txns
    inserted_rules = 0
    rules_applied = 0
    for r in result.get("rules", []):
        acct = await db.accounts.find_one(
            {"company_id": cid, "code": r["account_code"]}
        )
        if not acct:
            continue
        # Skip if a matching rule already exists
        dup = await db.rules.find_one({
            "company_id": cid, "match_type": "merchant_contains",
            "match_value": r["merchant"], "account_code": r["account_code"],
        })
        if dup:
            continue
        rid = str(uuid.uuid4())
        await db.rules.insert_one({
            "id": rid, "company_id": cid,
            "match_type": "merchant_contains",
            "match_value": r["merchant"],
            "account_code": r["account_code"],
            "account_name": acct["name"],
            "created_by": "ai_interview",
            "hits": 0, "created_at": now, "updated_at": now,
        })
        inserted_rules += 1

        # Back-fill any historic un-reviewed txns that match
        q = {
            "company_id": cid, "human_reviewed": False,
            "merchant": {"$regex": re.escape(r["merchant"]), "$options": "i"},
        }
        docs = await db.transactions.find(q).to_list(5000)
        applied_here = 0
        for t in docs:
            if await is_period_closed(cid, t.get("date")):
                continue
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {
                    "category_account_id": acct["id"],
                    "category_account_code": acct["code"],
                    "category_account_name": acct["name"],
                    "ai_confidence": 0.99,
                    "ai_reasoning": f"Onboarding rule: {r['merchant']} → {acct['name']}",
                    "needs_review": False, "posted": True,
                    "updated_at": now_iso(),
                }},
            )
            applied_here += 1
        if applied_here:
            await db.rules.update_one({"id": rid}, {"$set": {"hits": applied_here}})
        rules_applied += applied_here

    await log_ai(cid, "onboarding_interview", inserted_accounts + inserted_rules)

    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    return {
        "apply": True,
        "accounts": result.get("accounts", []),
        "rules": result.get("rules", []),
        "inserted_accounts": inserted_accounts,
        "inserted_rules": inserted_rules,
        "rules_applied_to_transactions": rules_applied,
    }


@router.post("/companies/{cid}/onboarding/plaid/link-token")
async def plaid_link_token(cid: str, payload: dict | None = None,
                            user: dict = Depends(get_current_user)):
    """Create a Plaid Link token for the user to link a bank account.

    Optional body: ``{"import_start_date": "YYYY-MM-DD"}`` — clamps the
    Plaid ``transactions.days_requested`` window so we only pull
    transactions on or after that date. Client picks this in the "How
    far back?" modal before Link opens. Omitted → 730 days (max).
    """
    await require_company(user, cid)
    public_base = os.environ.get("PUBLIC_BACKEND_URL", "").rstrip("/")
    webhook_url = f"{public_base}/api/plaid/webhook" if public_base else None
    days_requested = _days_from_start_date((payload or {}).get("import_start_date"))
    try:
        # Nonce on `client_user_id` — Plaid keeps a first-party session
        # cookie on plaid.com that remembers which institutions a given
        # `client_user_id` linked in the past. If we reuse the same
        # `{user}::{cid}` value across opens, Plaid short-circuits the
        # "Search / login" screen with a "Continue as previously
        # linked" prompt, which is the exact bug that let an accountant
        # accidentally re-open Client A's session while trying to link
        # Client B. Adding a per-open uuid gives Plaid a brand-new
        # identity every time, forcing a fresh flow. Zero side-effects:
        # once linked, the returned access_token/item_id is what we
        # use for the connection — client_user_id is never referenced
        # again for that item.
        token = plaid_service.create_link_token(
            user_id=f"{user['id']}::{cid}::{uuid.uuid4()}",
            client_name="Axiom Ledger",
            webhook_url=webhook_url,
            days_requested=days_requested,
        )
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    return {"link_token": token, "days_requested": days_requested}


def _days_from_start_date(iso_date: str | None) -> int:
    """Convert an ISO ``YYYY-MM-DD`` client-supplied start date to a
    Plaid ``days_requested`` count. Bounds:
      * Returned value is clamped to [1, 730] — Plaid's own range.
      * `None`, empty, or malformed → 730 (default = maximum history).
    """
    if not iso_date:
        return 730
    try:
        d = date.fromisoformat(iso_date)
    except (TypeError, ValueError):
        return 730
    delta = (date.today() - d).days
    if delta < 1:
        return 1  # picked today — pull today only
    return min(730, delta)


@router.post("/companies/{cid}/plaid/backfill-history-token")
async def plaid_backfill_history_token(cid: str, user: dict = Depends(get_current_user)):
    """Mint a Plaid Link **update-mode** token for the company's existing Plaid
    item, requesting 730 days of history. When the user completes Link, Plaid
    will backfill older transactions and fire a HISTORICAL_UPDATE webhook.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No Plaid item linked for this company")
    public_base = os.environ.get("PUBLIC_BACKEND_URL", "").rstrip("/")
    webhook_url = f"{public_base}/api/plaid/webhook" if public_base else None
    try:
        # Same per-open nonce as the create-link path so update-mode
        # reconnects don't accidentally inherit cross-tenant Plaid
        # session state. Plaid identifies which item to update via the
        # `access_token` param, so client_user_id can rotate freely
        # without breaking the update flow.
        token = plaid_service.create_link_token(
            user_id=f"{user['id']}::{cid}::{uuid.uuid4()}",
            client_name="Axiom Ledger",
            webhook_url=webhook_url,
            access_token_for_update=plaid_service.token_from_item(item),
        )
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    return {"link_token": token, "item_id": item.get("item_id")}


@router.post("/companies/{cid}/onboarding/plaid/exchange")
async def plaid_exchange(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Exchange the public_token from Plaid Link for an access_token, persist Item, return accounts.

    Supports multiple Plaid items per company — every successful Plaid Link
    flow inserts a NEW item (keyed by `item_id`) rather than overwriting an
    existing one, so users can link Chase + Wells Fargo + Amex + ... during
    onboarding without losing prior connections. Re-linking the same item_id
    (e.g. after re-auth) is idempotent via upsert on `item_id`.
    """
    await require_company(user, cid)
    public_token = payload.get("public_token")
    if not public_token:
        raise HTTPException(400, "public_token required")
    # Optional cutoff from the "How far back?" modal. Persisted on the
    # Plaid item so every subsequent sync uses it as a floor. `None` /
    # unset = pull everything Plaid returns (existing behavior).
    import_start_date = payload.get("import_start_date")
    if import_start_date:
        try:
            date.fromisoformat(import_start_date)  # validate shape
        except (TypeError, ValueError):
            import_start_date = None
    try:
        ex = plaid_service.exchange_public_token(public_token)
        accounts = plaid_service.get_accounts(ex["access_token"])
        institution_name = plaid_service.get_institution_name(ex["access_token"])
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    now = now_iso()
    from crypto_service import encrypt as _enc
    await db.plaid_items.update_one(
        {"company_id": cid, "item_id": ex["item_id"]},
        {"$set": {
            "id": str(uuid.uuid4()), "company_id": cid, "user_id": user["id"],
            "item_id": ex["item_id"], "access_token": _enc(ex["access_token"]),
            "cursor": None, "accounts": accounts,
            "institution_name": institution_name,
            "import_start_date": import_start_date,
            "created_at": now, "updated_at": now,
        }},
        upsert=True,
    )
    return {"accounts": accounts, "item_id": ex["item_id"],
            "institution_name": institution_name,
            "import_start_date": import_start_date}


@router.get("/companies/{cid}/onboarding/plaid/items")
async def onboarding_plaid_items(cid: str, user: dict = Depends(get_current_user)):
    """List every Plaid item + its accounts already connected for this
    company. Used by the onboarding UI to re-hydrate the "connected
    accounts" list on refresh — otherwise a user who links Chase, refreshes
    the page, comes back to the Plaid step and sees an empty state.

    Also flags which accounts have already been imported into the ledger
    (via `account_mappings`) so the UI can render them as "already
    downloaded" instead of asking the user to click Import again.
    """
    await require_company(user, cid)
    items = await db.plaid_items.find({"company_id": cid}).to_list(50)
    out: list[dict] = []
    for it in items:
        mappings = it.get("account_mappings") or {}
        for a in (it.get("accounts") or []):
            if not a.get("account_id"):
                continue
            mapping = mappings.get(a["account_id"])
            out.append({
                "account_id": a["account_id"],
                "name": a.get("name") or a.get("official_name") or "Account",
                "official_name": a.get("official_name"),
                "mask": a.get("mask"),
                "subtype": a.get("subtype"),
                "type": a.get("type"),
                "balance_current": a.get("balance_current") or a.get("current_balance"),
                "institution_name": it.get("institution_name") or "Bank",
                "imported": bool(mapping),
                "ledger_account_id": (mapping or {}).get("ledger_account_id"),
                "ledger_account_code": (mapping or {}).get("ledger_account_code"),
                "ledger_account_name": (mapping or {}).get("ledger_account_name"),
            })
    return {"accounts": out}


# ─── (Feb 2026) Per-item "Download from" editable field ───────────────
#
# Purpose: let clients change the transaction-history cutoff on an
# already-linked Plaid item WITHOUT disconnecting + reconnecting.
#
# Two behaviors depending on direction of change (enforced by the
# frontend via a confirm-dialog, plus a defense-in-depth flag on the
# response for tooling / audit purposes):
#
#   * Making the date LATER (want less clutter): just update the
#     field. Already-imported transactions are NOT deleted (they may
#     be reconciled / categorized / matched already). The response
#     `already_imported_older_count` tells the UI how many old rows
#     the change WILL orphan so it can show a helpful "we'll keep
#     the {N} you already have but won't pull anything older" note.
#
#   * Making the date EARLIER (want more history): update the field.
#     The next Plaid sync will only pull NEW transactions after
#     Plaid's cursor, though — Plaid doesn't rewind for a
#     `days_requested` bump. A future "backfill" endpoint will
#     handle re-pulling the gap. For now the UI just tells the user
#     that.


class PlaidItemUpdateIn(BaseModel):
    import_start_date: str | None = None  # ISO YYYY-MM-DD, or null to clear


def _safe_import_date(iso: str | None) -> str | None:
    """Validate + clamp a client-supplied ISO date. Same-origin: we
    only accept dates within Plaid's 24-month window and never a
    future date. Anything else → None (treated as "no cutoff")."""
    if not iso:
        return None
    try:
        d = date.fromisoformat(iso)
    except (TypeError, ValueError):
        return None
    today = date.today()
    if d > today:
        return None  # can't set a future cutoff
    max_lookback = today - timedelta(days=730)
    if d < max_lookback:
        # Silently clamp instead of rejecting — the frontend already
        # capped the picker; this is defense-in-depth.
        return max_lookback.isoformat()
    return d.isoformat()


@router.get("/companies/{cid}/plaid/items")
async def list_plaid_items(cid: str, user: dict = Depends(get_current_user)):
    """List Plaid Items (institutions) with their editable settings.
    Shape is intentionally different from the accounts-focused
    onboarding endpoint above: one row per institution/item, showing
    the cutoff + account count so the settings page can render a
    compact per-connection list."""
    await require_company(user, cid)
    items = await db.plaid_items.find({"company_id": cid}).to_list(50)
    out: list[dict] = []
    for it in items:
        out.append({
            "item_id": it.get("item_id"),
            "institution_name": it.get("institution_name") or "Bank",
            "import_start_date": it.get("import_start_date"),
            "account_count": len(it.get("accounts") or []),
            "created_at": it.get("created_at"),
            "updated_at": it.get("updated_at"),
        })
    # Newest first — most recently linked institution at the top so
    # the client can find what they just added.
    out.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return {"items": out}


@router.patch("/companies/{cid}/plaid/items/{item_id}")
async def update_plaid_item(cid: str, item_id: str,
                             body: PlaidItemUpdateIn,
                             user: dict = Depends(get_current_user)):
    """Update the "Download from" cutoff on a Plaid item.

    Returns:
      * `import_start_date` — the value now persisted
      * `direction` — "earlier" | "later" | "unchanged", compared to
        the previous value (or "set" if there was no prior value)
      * `already_imported_older_count` — for "later" moves, how many
        already-in-Mongo transactions predate the new cutoff. Lets
        the UI surface an accurate "we'll keep the 47 you already
        have but won't pull anything older" note.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one(
        {"company_id": cid, "item_id": item_id},
    )
    if not item:
        raise HTTPException(404, "Plaid item not found")
    prev = item.get("import_start_date")
    new = _safe_import_date(body.import_start_date)

    if prev == new:
        direction = "unchanged"
    elif not prev and new:
        direction = "set"
    elif prev and not new:
        direction = "cleared"  # "Everything Plaid offers" now
    else:
        direction = "later" if new > prev else "earlier"

    older_count = 0
    # Compute the "we'll keep the {N} you already have" count whenever
    # the change installs a cutoff that could orphan old transactions —
    # that includes "set" (was None, now has a date), and "later" (bumped
    # forward). Not needed for "earlier" (nothing gets orphaned) or
    # "cleared" (removing the cutoff includes MORE, not less).
    if new and direction in ("set", "later"):
        account_ids = [a.get("account_id") for a in (item.get("accounts") or [])
                        if a.get("account_id")]
        if account_ids:
            older_count = await db.transactions.count_documents({
                "company_id": cid,
                "plaid_account_id": {"$in": account_ids},
                "date": {"$lt": new},
            })

    await db.plaid_items.update_one(
        {"company_id": cid, "item_id": item_id},
        {"$set": {
            "import_start_date": new,
            "updated_at": now_iso(),
        }},
    )

    # (Feb 2026) When the user extends the range EARLIER (or clears
    # the cutoff entirely to "everything Plaid offers"), auto-enqueue
    # the same reset-and-resync job the PlaidBackfillButton fires.
    # Plaid's cursor-based `transactions_sync` only returns new
    # events past the cursor — it doesn't retroactively rewind for a
    # bumped `days_requested`. A full reset+resync forces Plaid to
    # re-page the entire history from scratch, which then respects
    # the newly-lowered `import_start_date` in the sync writer's
    # date-floor filter. Idempotent — the writer dedupes on
    # (company_id, plaid_transaction_id) so nothing double-posts.
    backfill_job_id: str | None = None
    if direction in ("earlier", "cleared"):
        try:
            from job_queue import enqueue_job
            backfill_job_id = await enqueue_job(
                "plaid_reset_resync", cid, user_id=user["id"],
            )
        except Exception:  # noqa: BLE001
            # Non-fatal — the PATCH succeeded, backfill will just
            # need a manual "Backfill history" click from the UI.
            # Silent so we don't error the settings save.
            backfill_job_id = None

    return {
        "item_id": item_id,
        "import_start_date": new,
        "previous_import_start_date": prev,
        "direction": direction,
        "already_imported_older_count": older_count,
        "backfill_job_id": backfill_job_id,
    }



@router.post("/companies/{cid}/onboarding/plaid/import")
async def plaid_import(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Import transactions for the selected Plaid account IDs.

    Routes each selected `plaid_account_id` through the same
    `connect_plaid_account` flow the Connections page uses, so the CoA gets
    a proper sub-account per Plaid account (1010-A Checking ···6084,
    1010-B Savings ···4321, etc.), an opening-balance JE is posted, and
    transactions are pulled + AI-categorized. This keeps onboarding and
    post-onboarding Plaid linking in perfect parity — nothing surprising
    when the user later revisits the Connections page.
    """
    await require_company(user, cid)
    selected: list[str] = payload.get("account_ids") or []
    # Support multi-item companies — a user may link Chase + Wells Fargo
    # + Amex during onboarding. Iterate every item, importing only the
    # `plaid_account_id`s the user selected (or all of them if empty).
    items = await db.plaid_items.find({"company_id": cid}).to_list(50)
    if not items:
        raise HTTPException(400, "No linked Plaid item — link first")

    # If no explicit selection, use every account attached to every item.
    if not selected:
        selected = []
        for it in items:
            selected.extend(
                a.get("account_id") for a in (it.get("accounts") or []) if a.get("account_id")
            )
    selected_set = set(selected)

    imported_total = 0
    connected: list[dict] = []
    errors: list[str] = []
    for item in items:
        # Snapshot the items' plaid_account_ids so we know which ones belong
        # to this item.
        item_account_ids = {a.get("account_id") for a in (item.get("accounts") or []) if a.get("account_id")}
        for plaid_account_id in item_account_ids & selected_set:
            try:
                result = await plaid_connect.connect_plaid_account(
                    cid, item, plaid_account_id,
                    categorize_fn=categorize_transaction,
                    is_period_closed_fn=is_period_closed,
                )
            except (ValueError, RuntimeError) as e:
                errors.append(f"{plaid_account_id[:8]}…: {e}")
                continue
            # Refresh the item after every connect so the NEXT loop iteration
            # sees the mapping we just persisted and can dedup vs. shared syncs.
            item = await db.plaid_items.find_one({"id": item["id"]}) or item
            imported_total += int(result.get("imported") or 0)
            connected.append({
                "plaid_account_id": plaid_account_id,
                "ledger_account_id": result.get("ledger_account_id"),
                "ledger_account_code": result.get("ledger_account_code"),
                "ledger_account_name": result.get("ledger_account_name"),
                "imported": result.get("imported") or 0,
            })
    if imported_total:
        await log_ai(cid, "categorize", imported_total)

    # Chase Plaid's async historical backfill. Plaid's `/transactions/sync`
    # on a fresh Item returns only what's been backfilled at the moment of
    # the call (~30 days for most institutions). In classic-webhook mode
    # Plaid fires a follow-up `HISTORICAL_UPDATE` a minute later; in the
    # newer sync-mode (some Sandbox institutions, all newer Prod items)
    # that webhook may never fire. Schedule a poll-chain at +30s, +2m,
    # +5m, +15m, +30m that stops early once we've reached the requested
    # `import_start_date` floor or the real HISTORICAL_UPDATE beats us
    # to it.
    try:
        from job_queue import enqueue_job
        for item in items:
            if not item.get("historical_update_received"):
                await enqueue_job(
                    "plaid_delayed_backfill_sync", cid, user_id=None,
                    item_id=item["id"], attempt=0,
                )
    except Exception:  # noqa: BLE001 — never fail import on scheduling
        import logging
        logging.getLogger("axiom.app").warning(
            "Failed to schedule Plaid backfill poll for cid=%s", cid,
        )

    return {
        "imported": imported_total,
        "connected": connected,
        "errors": errors or None,
    }


@router.post("/companies/{cid}/plaid/connect-account")
async def plaid_connect_account(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Connect a single Plaid account to a ledger bank account. Auto-maps
    the Plaid subtype to (or creates) the correct chart-of-accounts entry,
    pulls full Plaid history for that account (skipping any date range already
    covered by a higher-priority source per QBO > Plaid > Veryfi), and posts an
    opening-balance JE derived from the current Plaid balance and the oldest
    imported transaction.
    """
    await require_company(user, cid)
    plaid_account_id = payload.get("plaid_account_id")
    if not plaid_account_id:
        raise HTTPException(400, "plaid_account_id required")
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No linked Plaid item — launch Plaid Link first")
    try:
        result = await plaid_connect.connect_plaid_account(
            cid, item, plaid_account_id,
            categorize_fn=categorize_transaction,
            is_period_closed_fn=is_period_closed,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    await log_ai(cid, "categorize", result["imported"])
    return result


@router.post("/companies/{cid}/plaid/repair-collided-mappings")
async def plaid_repair_collided_mappings(cid: str, user: dict = Depends(get_current_user)):
    """One-shot repair for the pre-fix bug where two Plaid accounts from the
    same bank (e.g. Bank of America Checking ···6084 + ···9917) collapsed
    onto ONE CoA row. Detects any case where multiple `plaid_account_id`s
    share the same `ledger_account_id`, re-resolves each collided mask
    using the fixed resolver (which now creates a dedicated CoA row per
    unique last-4), moves that Plaid account's transactions to the new CoA
    row, and posts a fresh opening-balance JE for it.

    Idempotent — safe to run multiple times. Returns a per-account summary.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No linked Plaid item — nothing to repair")

    mappings = dict(item.get("account_mappings") or {})
    if not mappings:
        return {"ok": True, "repaired": [], "note": "No Plaid account mappings on this item."}

    # Group plaid_account_ids by their current ledger row.
    from collections import defaultdict
    by_ledger: dict[str, list[str]] = defaultdict(list)
    for pa_id, m in mappings.items():
        lid = m.get("ledger_account_id")
        if lid:
            by_ledger[lid].append(pa_id)

    # Fetch Plaid accounts once so we can re-resolve.
    try:
        plaid_accts = plaid_service.get_accounts(plaid_service.token_from_item(item))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't fetch Plaid accounts: {e}")
    inst_name = item.get("institution_name")

    repaired: list[dict] = []
    for ledger_id, pa_ids in by_ledger.items():
        if len(pa_ids) < 2:
            continue
        # Keep the FIRST plaid_account_id on the original ledger row —
        # everyone else gets a dedicated new CoA row.
        for pa_id in pa_ids[1:]:
            plaid_acct = next((a for a in plaid_accts if a.get("account_id") == pa_id), None)
            if not plaid_acct:
                repaired.append({"plaid_account_id": pa_id, "status": "skipped_no_plaid_data"})
                continue
            new_ledger = await plaid_connect.get_ledger_for_plaid_account(
                cid, plaid_acct, institution_name=inst_name,
            )
            if not new_ledger or new_ledger.get("id") == ledger_id:
                repaired.append({
                    "plaid_account_id": pa_id,
                    "status": "no_change",
                    "reason": "Resolver still returned same ledger row — the collision may already be fixed.",
                })
                continue
            # Move this Plaid account's transactions to the new ledger row.
            moved = await db.transactions.update_many(
                {"company_id": cid, "plaid_account_id": pa_id, "bank_account_id": ledger_id},
                {"$set": {
                    "bank_account_id": new_ledger["id"],
                    "updated_at": now_iso(),
                }},
            )
            # Update the mapping to point to the new ledger row.
            mappings[pa_id] = {
                **mappings[pa_id],
                "ledger_account_id": new_ledger["id"],
                "ledger_account_code": new_ledger["code"],
                "ledger_account_name": new_ledger["name"],
                "repaired_at": now_iso(),
                "previous_ledger_account_id": ledger_id,
            }
            # Recompute + post opening-balance JE for the new row if we don't
            # already have one.
            existing_obe = await db.journal_entries.find_one({
                "company_id": cid, "source": "opening_balance",
                "lines.account_id": new_ledger["id"],
            })
            je_id = None
            if not existing_obe:
                # Use Plaid's current balance as the opening (matches the
                # connect flow's fallback semantics). `plaid_service.get_accounts`
                # returns FLAT keys (`balance_current`/`balance_available`),
                # not a nested `balances` dict.
                current = (
                    plaid_acct.get("balance_current")
                    or plaid_acct.get("balance_available")
                    or 0.0
                )
                is_liability = new_ledger.get("type") == "liability"
                opening = -float(current) if is_liability else float(current)
                as_of = datetime.now(timezone.utc).date().isoformat()
                oldest = await db.transactions.find({
                    "company_id": cid, "plaid_account_id": pa_id,
                }).sort("date", 1).limit(1).to_list(1)
                if oldest and oldest[0].get("date"):
                    from datetime import date as _d
                    try:
                        as_of = (_d.fromisoformat(oldest[0]["date"]) - timedelta(days=1)).isoformat()
                    except Exception:
                        pass
                je_id = await plaid_connect.post_opening_balance_je(
                    cid, new_ledger, opening, as_of,
                    f"Opening balance — {plaid_acct.get('name') or new_ledger['name']} (repaired)",
                )
            repaired.append({
                "plaid_account_id": pa_id,
                "status": "repaired",
                "old_ledger": {"id": ledger_id},
                "new_ledger": {
                    "id": new_ledger["id"],
                    "code": new_ledger["code"],
                    "name": new_ledger["name"],
                },
                "transactions_moved": moved.modified_count,
                "opening_je_id": je_id,
            })

    if repaired:
        await db.plaid_items.update_one(
            {"id": item["id"]},
            {"$set": {"account_mappings": mappings, "updated_at": now_iso()}},
        )
        await log_ai(cid, "plaid_repair", len(repaired))

    # Second pass — ensure every current mapping has an opening-balance JE.
    # Covers the case where a collision was fixed in a previous run but the
    # OBE JE was skipped (e.g. balance parsing bug) — re-running repair now
    # backfills it.
    obe_posted: list[dict] = []
    for pa_id, m in mappings.items():
        ledger_id = m.get("ledger_account_id")
        if not ledger_id:
            continue
        existing_obe = await db.journal_entries.find_one({
            "company_id": cid, "source": "opening_balance",
            "lines.account_id": ledger_id,
        })
        if existing_obe:
            continue
        plaid_acct = next((a for a in plaid_accts if a.get("account_id") == pa_id), None)
        if not plaid_acct:
            continue
        ledger = await db.accounts.find_one({"id": ledger_id, "company_id": cid})
        if not ledger:
            continue
        current = (
            plaid_acct.get("balance_current")
            or plaid_acct.get("balance_available")
            or 0.0
        )
        is_liability = ledger.get("type") == "liability"
        opening = -float(current) if is_liability else float(current)
        if abs(opening) < 0.005:
            continue
        as_of = datetime.now(timezone.utc).date().isoformat()
        oldest = await db.transactions.find({
            "company_id": cid, "plaid_account_id": pa_id,
        }).sort("date", 1).limit(1).to_list(1)
        if oldest and oldest[0].get("date"):
            from datetime import date as _d
            try:
                as_of = (_d.fromisoformat(oldest[0]["date"]) - timedelta(days=1)).isoformat()
            except Exception:
                pass
        je_id = await plaid_connect.post_opening_balance_je(
            cid, ledger, opening, as_of,
            f"Opening balance — {plaid_acct.get('name') or ledger['name']} (repair backfill)",
        )
        if je_id:
            obe_posted.append({
                "plaid_account_id": pa_id,
                "ledger_code": ledger["code"],
                "ledger_name": ledger["name"],
                "opening": opening,
                "je_id": je_id,
            })

    return {"ok": True, "repaired": repaired, "obe_backfilled": obe_posted}


