"""Axiom Ledger — Rules routes.

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


# ----------------------- Rules -----------------------

@router.get("/companies/{cid}/rules")
async def list_rules(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.rules.find({"company_id": cid}).sort("created_at", -1).to_list(500)
    candidates = await db.rule_candidates.find(
        {"company_id": cid, "approvals": {"$gte": 2}}
    ).sort("approvals", -1).to_list(200)

    # For each candidate compute how many CURRENT un-reviewed transactions
    # would be back-filled if the rule is accepted. The list is short
    # (typically < 30) and the regex is anchored, so parallel count_documents
    # calls are cheap. This is what powers the "would clean up N txns" preview
    # on the Rules page.
    async def _preview(c):
        try:
            n = await db.transactions.count_documents({
                "company_id": cid,
                "human_reviewed": False,
                "merchant": {"$regex": re.escape(c["merchant"]), "$options": "i"},
            })
        except Exception:  # noqa: BLE001
            n = 0
        return c["id"], n

    if candidates:
        pairs = await asyncio.gather(*[_preview(c) for c in candidates])
        preview_by_id = dict(pairs)
    else:
        preview_by_id = {}

    out_candidates = []
    for c in candidates:
        d = coerce(c)
        d["applies_to_count"] = preview_by_id.get(c["id"], 0)
        out_candidates.append(d)

    return {"rules": [coerce(d) for d in docs], "candidates": out_candidates}


@router.post("/companies/{cid}/rules")
async def create_rule(cid: str, inp: RuleCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    acct = await db.accounts.find_one({"company_id": cid, "code": inp.account_code})
    if not acct:
        raise HTTPException(400, "Account code not found")
    rid = str(uuid.uuid4()); now = now_iso()
    await db.rules.insert_one({
        "id": rid, "company_id": cid, "match_type": inp.match_type,
        "match_value": inp.match_value, "account_code": inp.account_code,
        "account_name": acct["name"], "created_by": "human", "hits": 0,
        "created_at": now, "updated_at": now,
    })
    applied = 0
    if inp.apply_to_existing:
        q = {
            "company_id": cid, "human_reviewed": False,
            "merchant": {"$regex": inp.match_value, "$options": "i"},
        }
        docs = await db.transactions.find(q).to_list(5000)
        for t in docs:
            if await is_period_closed(cid, t.get("date")):
                continue  # rules never edit closed-period activity
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {
                    "category_account_id": acct["id"],
                    "category_account_code": acct["code"],
                    "category_account_name": acct["name"],
                    "ai_confidence": 0.99,
                    "ai_reasoning": f"Auto-applied rule: {inp.match_value} → {acct['name']}",
                    "needs_review": False, "posted": True,
                    "updated_at": now_iso(),
                }},
            )
            applied += 1
        await db.rules.update_one({"id": rid}, {"$set": {"hits": applied}})
    # Consume any matching candidate — once promoted to a rule it should not
    # keep surfacing on the "Suggested rules" panel.
    await db.rule_candidates.delete_many({
        "company_id": cid,
        "key": f"{inp.match_value}::{inp.account_code}",
    })
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    await log_ai(cid, "rule_created", 1)
    return {"id": rid, "applied": applied}


@router.delete("/companies/{cid}/rules/{rid}")
async def delete_rule(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.rules.delete_one({"id": rid, "company_id": cid})
    return {"ok": True}


@router.delete("/companies/{cid}/rule-candidates/{candidate_id}")
async def dismiss_rule_candidate(cid: str, candidate_id: str,
                                  user: dict = Depends(get_current_user)):
    """Remove a suggested rule so it stops surfacing on the Rules page.

    Note: the underlying `(merchant, account_code)` pair may be re-created
    by future manual reclassifies — that's the intended feedback loop.
    """
    await require_company(user, cid)
    r = await db.rule_candidates.delete_one({"id": candidate_id, "company_id": cid})
    return {"ok": True, "deleted": r.deleted_count}


