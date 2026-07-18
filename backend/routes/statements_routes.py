"""Axiom Ledger — Bank-statement Imports (Veryfi tab) routes.

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


# ----------------------- Bank-statement Imports (Veryfi tab) -----------------------
# Backed by /app/backend/statements.py — auto-promote flow that OCRs a
# bank-statement PDF, resolves (or creates) the matching CoA asset row,
# then routes every extracted line through the same PFC + AI pipeline as
# Plaid so the resulting rows land on the Transactions page with full
# categorization + contact resolution.

@router.post("/companies/{cid}/statements/upload")
async def statements_upload(
    cid: str,
    file: UploadFile = File(...),
    account_id: str | None = Form(None),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    import statements
    return await statements.upload_statement(
        cid, file, account_id or None,
        categorize_fn=categorize_transaction,
        is_period_closed_fn=is_period_closed,
    )


@router.get("/companies/{cid}/statements/imports")
async def statements_list(
    cid: str, limit: int = 50, offset: int = 0,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    import statements
    return await statements.list_imports(cid, limit=limit, offset=offset)


@router.get("/companies/{cid}/statements/imports/{import_id}")
async def statements_detail(
    cid: str, import_id: str,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    import statements
    return await statements.get_import_detail(cid, import_id)


@router.delete("/companies/{cid}/statements/imports/{import_id}")
async def statements_delete(
    cid: str, import_id: str, cascade: bool = True,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    import statements
    return await statements.delete_import(cid, import_id, cascade=cascade)


