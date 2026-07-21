"""Axiom Ledger — Reconciliation / Book Review / Close periods routes.

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


# ----------------------- Reconciliation / Book Review / Close periods -----------------------

# The heavy lifting for R1 (Plaid auto-clear), R2 (manual matching), and R3
# (statement fuzzy matcher) lives in `reconciliation_engine`. This module
# stays a thin HTTP shell — validate, delegate, respond.
from reconciliation_engine import (
    auto_clear_settled_plaid_txns,
    preview_recon,
    complete_recon,
    match_statement_lines,
)


@router.get("/companies/{cid}/reconciliations")
async def list_recs(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.reconciliations.find({"company_id": cid}).sort("as_of", -1).to_list(500)
    return {"reconciliations": [coerce(d) for d in docs]}


@router.get("/companies/{cid}/reconciliations/preview")
async def preview_reconciliation(
    cid: str,
    bank_account_id: str = Query(...),
    as_of: str = Query(...),
    statement_balance: float = Query(0.0),
    user: dict = Depends(get_current_user),
):
    """Return uncleared items + running diff for the interactive UI."""
    await require_company(user, cid)
    return await preview_recon(cid, bank_account_id, as_of, statement_balance)


class ReconCompleteIn(BaseModel):
    bank_account_id: str
    period_start: Optional[str] = None
    period_end: str
    statement_balance: float
    cleared_txn_ids: List[str]


@router.post("/companies/{cid}/reconciliations/complete")
async def complete_reconciliation(
    cid: str, inp: ReconCompleteIn, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    try:
        return await complete_recon(
            cid=cid,
            bank_account_id=inp.bank_account_id,
            period_start=inp.period_start,
            period_end=inp.period_end,
            statement_balance=inp.statement_balance,
            cleared_txn_ids=inp.cleared_txn_ids,
            user_email=user.get("email") or user.get("id"),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/companies/{cid}/reconciliations/auto-clear")
async def auto_clear_endpoint(cid: str, user: dict = Depends(get_current_user)):
    """On-demand trigger for the Plaid auto-clear pass. Sync path calls this
    automatically too."""
    await require_company(user, cid)
    return await auto_clear_settled_plaid_txns(cid)


@router.post("/companies/{cid}/reconciliations/match-statement")
async def match_statement(
    cid: str,
    bank_account_id: str = Form(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Veryfi-OCR a statement PDF (or CSV) and return per-line match candidates
    grouped by confidence tier. Nothing is written; UI drives the apply step."""
    await require_company(user, cid)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    try:
        veryfi_data = await veryfi_service.process_bank_statement(
            raw, file.filename or "statement.pdf", file.content_type or "application/pdf",
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Veryfi error: {e}")
    lines = veryfi_service.extract_transactions(veryfi_data)
    matches = await match_statement_lines(cid, bank_account_id, lines)
    return {
        "line_count": len(lines),
        "auto_count": len(matches["auto"]),
        "suggest_count": len(matches["suggest"]),
        "manual_count": len(matches["manual"]),
        **matches,
    }


class ApplyMatchesIn(BaseModel):
    bank_account_id: str
    period_end: str
    apply_txn_ids: List[str]


@router.post("/companies/{cid}/reconciliations/apply-matches")
async def apply_matches(
    cid: str, inp: ApplyMatchesIn, user: dict = Depends(get_current_user),
):
    """Bulk-clear a set of ledger txn ids after the user confirms fuzzy matches
    from the statement matcher."""
    await require_company(user, cid)
    now = now_iso()
    r = await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": inp.apply_txn_ids}},
        {"$set": {
            "cleared_at": inp.period_end,
            "cleared_source": "statement_match",
            "updated_at": now,
        }},
    )
    return {"cleared": r.modified_count}


@router.post("/companies/{cid}/reconciliations")
async def create_rec(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Legacy freeform endpoint — kept so existing clients (the old UI, the
    demo seed script) don't 404. New flows should use `/complete` above."""
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    doc = {"id": rid, "company_id": cid, **payload, "created_at": now, "updated_at": now}
    await db.reconciliations.insert_one(doc)
    return {"id": rid}


@router.get("/companies/{cid}/book-reviews")
async def list_reviews(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.book_reviews.find({"company_id": cid}).sort("period", -1).to_list(500)
    return {"reviews": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/book-reviews")
async def create_review(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.book_reviews.insert_one({"id": rid, "company_id": cid, **payload,
                                       "created_at": now, "updated_at": now})
    return {"id": rid}


@router.get("/companies/{cid}/close-periods")
async def list_close(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.close_periods.find({"company_id": cid}).sort("period_end", -1).to_list(500)
    return {"periods": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/close-periods")
async def create_close(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.close_periods.insert_one({"id": rid, "company_id": cid, **payload,
                                        "kind": payload.get("kind", "month"),
                                        "created_at": now, "updated_at": now})
    return {"id": rid}


