"""Axiom Ledger — Payments & Receipts routes.

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


# ----------------------- Payments & Receipts -----------------------

@router.get("/companies/{cid}/payments")
async def list_payments(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.payments.find({"company_id": cid}).sort("date", -1).to_list(1000)
    return {"payments": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/payments")
async def create_payment(cid: str, inp: PaymentCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    pid = str(uuid.uuid4()); now = now_iso()
    await db.payments.insert_one({
        "id": pid, "company_id": cid, **inp.model_dump(),
        "created_at": now, "updated_at": now,
    })
    # If linked to invoice/bill, reduce balance_due
    if inp.linked_invoice_id:
        inv = await db.invoices.find_one({"id": inp.linked_invoice_id, "company_id": cid})
        if inv:
            bal = float(inv.get("balance_due", inv.get("total", 0))) - float(inp.amount)
            status = "paid" if bal <= 0.01 else "partial"
            await db.invoices.update_one({"id": inv["id"]},
                {"$set": {"balance_due": round(bal, 2), "status": status}})
    if inp.linked_bill_id:
        bill = await db.bills.find_one({"id": inp.linked_bill_id, "company_id": cid})
        if bill:
            bal = float(bill.get("balance_due", bill.get("total", 0))) - float(inp.amount)
            status = "paid" if bal <= 0.01 else "partial"
            await db.bills.update_one({"id": bill["id"]},
                {"$set": {"balance_due": round(bal, 2), "status": status}})
    return {"id": pid}


@router.delete("/companies/{cid}/payments/{pid}")
async def delete_payment(cid: str, pid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.payments.delete_one({"id": pid, "company_id": cid})
    return {"ok": True}


@router.get("/companies/{cid}/receipts")
async def list_receipts(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.receipts.find({"company_id": cid}).sort("date", -1).to_list(1000)
    return {"receipts": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/receipts")
async def create_receipt(cid: str, inp: ReceiptCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.receipts.insert_one({
        "id": rid, "company_id": cid, **inp.model_dump(),
        "created_at": now, "updated_at": now,
    })
    return {"id": rid}


@router.delete("/companies/{cid}/receipts/{rid}")
async def delete_receipt(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.receipts.delete_one({"id": rid, "company_id": cid})
    return {"ok": True}


