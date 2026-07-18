"""Axiom Ledger — Invoices routes.

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


# ----------------------- Invoices -----------------------

def _sum_lines(lines: list, tax: float = 0.0) -> tuple[float, float, float]:
    subtotal = sum(float(li.get("amount", 0)) for li in lines)
    total = subtotal + float(tax or 0)
    return round(subtotal, 2), round(float(tax or 0), 2), round(total, 2)


@router.get("/companies/{cid}/invoices")
async def list_invoices(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.invoices.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    return {"invoices": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/invoices")
async def create_invoice(cid: str, inp: InvoiceCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    iid = str(uuid.uuid4()); now = now_iso()
    subtotal, tax, total = _sum_lines(inp.line_items, inp.tax)
    doc = {
        "id": iid, "company_id": cid,
        "number": inp.number or f"INV-{random.randint(1000, 9999)}",
        "contact_id": inp.contact_id, "contact_name": inp.contact_name,
        "issue_date": inp.issue_date, "due_date": inp.due_date,
        "status": inp.status, "line_items": inp.line_items,
        "subtotal": subtotal, "tax": tax, "total": total, "balance_due": total,
        "notes": inp.notes, "created_at": now, "updated_at": now,
    }
    await db.invoices.insert_one(doc)
    return {"id": iid, "invoice": coerce(doc)}


@router.patch("/companies/{cid}/invoices/{iid}")
async def update_invoice(cid: str, iid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    if "line_items" in payload:
        subtotal, tax, total = _sum_lines(payload["line_items"], payload.get("tax", 0))
        payload["subtotal"] = subtotal
        payload["tax"] = tax
        payload["total"] = total
        payload["balance_due"] = total
    payload["updated_at"] = now_iso()
    await db.invoices.update_one({"id": iid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@router.delete("/companies/{cid}/invoices/{iid}")
async def delete_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.invoices.delete_one({"id": iid, "company_id": cid})
    return {"ok": True}


