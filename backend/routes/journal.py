"""Axiom Ledger — Journal Entries routes.

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


# ----------------------- Journal Entries -----------------------

@router.get("/companies/{cid}/journal-entries")
async def list_jes(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.journal_entries.find({"company_id": cid}).sort("date", -1).to_list(2000)
    return {"entries": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/journal-entries")
async def create_je(cid: str, inp: JECreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await assert_open(cid, inp.date)
    total_d = sum(float(l.get("debit", 0)) for l in inp.lines)
    total_c = sum(float(l.get("credit", 0)) for l in inp.lines)
    if abs(total_d - total_c) > 0.01:
        raise HTTPException(400, f"Debits ({total_d}) must equal credits ({total_c})")
    jid = str(uuid.uuid4()); now = now_iso()
    await db.journal_entries.insert_one({
        "id": jid, "company_id": cid, "date": inp.date, "memo": inp.memo,
        "lines": inp.lines, "total_debit": round(total_d, 2), "total_credit": round(total_c, 2),
        "created_by": user["id"], "created_at": now, "updated_at": now,
    })
    return {"id": jid}


@router.delete("/companies/{cid}/journal-entries/{jid}")
async def delete_je(cid: str, jid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    existing = await db.journal_entries.find_one({"id": jid, "company_id": cid})
    if existing:
        await assert_open(cid, existing.get("date"))
    await db.journal_entries.delete_one({"id": jid, "company_id": cid})
    return {"ok": True}


