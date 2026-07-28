"""Axiom Ledger — Accounts (Chart of Accounts) routes.

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


# ----------------------- Auto-opening-balance debounce --------------------
# `list_accounts` fires on every dashboard / balance sheet / transactions
# load, so we opportunistically kick the auto-managed opening balance
# recompute in the BACKGROUND on the same request — but only once every
# 60 seconds per company to keep Mongo write pressure sane. Fully
# fire-and-forget: never blocks the accounts response, never surfaces
# errors to the user. Idempotent by design (see opening_balance_service).
_OBE_LAST_RUN: dict[str, float] = {}
_OBE_DEBOUNCE_SECONDS = 60.0


async def _auto_recompute_opening_balances(cid: str) -> None:
    import time as _t
    import opening_balance_service as obs
    try:
        # Only touch accounts that have at least one statement_imports row —
        # skips the vast majority of accounts on every call.
        imported_account_ids = await db.statement_imports.distinct(
            "account_id", {"company_id": cid, "status": "completed"},
        )
        if not imported_account_ids:
            return
        for aid in imported_account_ids:
            if not aid:
                continue
            await obs.ensure_opening_balance_for_account(cid, aid)
    except Exception:  # noqa: BLE001 — background, never bubble up.
        import logging as _l
        _l.getLogger(__name__).warning(
            "auto opening-balance recompute failed for company %s", cid,
        )
    finally:
        _OBE_LAST_RUN[cid] = _t.time()


def _obe_recompute_needed(cid: str) -> bool:
    """Reserve the debounce slot atomically. Returns True at most once per
    `_OBE_DEBOUNCE_SECONDS` per company; concurrent calls after the first
    within the window all get False.
    """
    import time as _t
    last = _OBE_LAST_RUN.get(cid, 0.0)
    if _t.time() - last < _OBE_DEBOUNCE_SECONDS:
        return False
    _OBE_LAST_RUN[cid] = _t.time()
    return True


# ----------------------- Accounts (Chart of Accounts) -----------------------

@router.get("/companies/{cid}/accounts")
async def list_accounts(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Auto-managed OBE JEs are refreshed in-line on the first accounts
    # fetch per 60-second window per company — idempotent, cheap when
    # everything's already correct, and guarantees the very next Balance
    # Sheet render reflects the right numbers. Wrapped so a helper
    # failure never breaks accounts loading.
    if _obe_recompute_needed(cid):
        try:
            await _auto_recompute_opening_balances(cid)
        except Exception:  # noqa: BLE001
            pass
    docs = await db.accounts.find({"company_id": cid}).sort("code", 1).to_list(2000)
    return {"accounts": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/accounts")
async def create_account(cid: str, inp: AccountCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    aid = str(uuid.uuid4()); now = now_iso()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "code": inp.code, "name": inp.name,
        "type": inp.type, "subtype": inp.subtype, "active": True, "balance": 0.0,
        "created_at": now, "updated_at": now,
    })
    return {"id": aid}


# Idempotent "get-or-create" used by AI-driven flows (voice: "create a Transfer
# category", "make a new equity account named Owner's Contribution"). If an
# account with the same normalized name OR the same code exists we return it
# rather than creating a duplicate. Auto-assigns a code in the next-available
# 100 block for the requested type when the caller didn't specify one.
CODE_RANGES = {
    "asset":      (1200, 1999),  # skip 1010 Business Checking baseline
    "liability":  (2100, 2999),
    "equity":     (3200, 3999),  # skip 3000 Owner block
    "revenue":    (4100, 4999),
    "expense":    (6000, 8999),
    "cogs":       (5000, 5999),
}


class EnsureAccountIn(BaseModel):
    name: str
    type: str
    code: Optional[str] = None
    subtype: Optional[str] = ""
    parent_account_id: Optional[str] = None


@router.post("/companies/{cid}/accounts/ensure")
async def ensure_account(cid: str, inp: EnsureAccountIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    t = (inp.type or "").lower().strip()
    if t not in CODE_RANGES:
        raise HTTPException(400, f"Unsupported account type: {inp.type}")

    # Match by normalized name (case-insensitive) OR exact code.
    name_norm = re.sub(r"\s+", " ", inp.name.strip()).lower()
    existing = None
    if inp.code:
        existing = await db.accounts.find_one({"company_id": cid, "code": inp.code})
    if not existing:
        # Case-insensitive name match on same type; avoids "Transfer" vs "transfer".
        all_of_type = await db.accounts.find({"company_id": cid, "type": t}).to_list(1000)
        for a in all_of_type:
            if re.sub(r"\s+", " ", a.get("name", "").strip()).lower() == name_norm:
                existing = a
                break
    if existing:
        return {"created": False, **coerce(existing)}

    # Assign a code: caller-provided if free, else next-available in the type range.
    lo, hi = CODE_RANGES[t]
    used = {a["code"] for a in await db.accounts.find(
        {"company_id": cid, "code": {"$exists": True}}
    ).to_list(2000)}
    if inp.code and inp.code not in used:
        code = inp.code
    else:
        code = None
        for n in range(lo, hi + 1, 10):
            candidate = str(n)
            if candidate not in used:
                code = candidate
                break
        if not code:
            code = str(lo + len([u for u in used if u.startswith(str(lo)[0])]))

    aid = str(uuid.uuid4()); now = now_iso()
    doc = {
        "id": aid, "company_id": cid, "code": code, "name": inp.name.strip(),
        "type": t, "subtype": inp.subtype or "", "active": True, "balance": 0.0,
        "parent_account_id": inp.parent_account_id,
        "created_at": now, "updated_at": now, "source": "ai_ensure",
    }
    await db.accounts.insert_one(doc)
    return {"created": True, **coerce(doc)}


@router.patch("/companies/{cid}/accounts/{aid}")
async def update_account(cid: str, aid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    payload["updated_at"] = now_iso()
    await db.accounts.update_one({"id": aid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@router.delete("/companies/{cid}/accounts/{aid}")
async def delete_account(cid: str, aid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.accounts.delete_one({"id": aid, "company_id": cid})
    return {"ok": True}


@router.post("/companies/{cid}/accounts/recompute-opening-balances")
async def recompute_opening_balances(cid: str, user: dict = Depends(get_current_user)):
    """Run the auto-managed opening balance helper across every bank
    ledger account in the company. Idempotent — safe to call any time.

    Backfills companies whose statements were uploaded BEFORE the
    auto-OBE service shipped in Feb 2026, and gives users a manual retry
    knob when a closed period previously blocked the auto-post.
    """
    await require_company(user, cid)
    import opening_balance_service as obs
    bank_types = ("asset", "liability")
    accts = await db.accounts.find({
        "company_id": cid, "active": True, "type": {"$in": list(bank_types)},
    }).to_list(1000)
    # Only run against accounts that at least ONE statement_imports row
    # references — no point iterating equity/income accounts.
    imported_account_ids = set(
        (await db.statement_imports.distinct("account_id", {"company_id": cid})) or []
    )
    results = []
    for a in accts:
        if a["id"] not in imported_account_ids:
            continue
        r = await obs.ensure_opening_balance_for_account(cid, a["id"])
        results.append({
            "account_id": a["id"],
            "account_name": a["name"],
            "account_code": a["code"],
            **r,
        })
    return {
        "processed": len(results),
        "posted": sum(1 for r in results if r.get("action") == "upserted"),
        "deleted": sum(1 for r in results if r.get("action") == "deleted"),
        "skipped": sum(1 for r in results if not r.get("ok")),
        "results": results,
    }



