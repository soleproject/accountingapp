"""Axiom Ledger — Bills routes.

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

from routes.invoices import _sum_lines
router = APIRouter(prefix="/api")


# ----------------------- Bills -----------------------

@router.get("/companies/{cid}/bills")
async def list_bills(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.bills.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    return {"bills": [coerce(d) for d in docs]}


@router.get("/companies/{cid}/bills/{bid}")
async def get_bill(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    b = await db.bills.find_one({"id": bid, "company_id": cid})
    if not b:
        raise HTTPException(status_code=404, detail="Bill not found")
    return {"bill": coerce(b)}


@router.post("/companies/{cid}/bills")
async def create_bill(cid: str, inp: BillCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    bid = str(uuid.uuid4()); now = now_iso()
    subtotal, disc_amt, ship, tax_v, total = _sum_lines(
        inp.line_items, inp.tax, inp.shipping, inp.discount, inp.discount_type or "amount",
    )
    doc = {
        "id": bid, "company_id": cid,
        "number": inp.number or f"BILL-{random.randint(100, 999)}",
        "contact_id": inp.contact_id, "contact_name": inp.contact_name,
        "issue_date": inp.issue_date, "due_date": inp.due_date,
        "status": inp.status, "line_items": inp.line_items,
        "subtotal": subtotal, "tax": tax_v, "shipping": ship,
        "discount": float(inp.discount or 0), "discount_type": inp.discount_type or "amount",
        "discount_amount": disc_amt,
        "total": total, "balance_due": total,
        "notes": inp.notes,
        "po_number": inp.po_number or "",
        "terms": inp.terms or "",
        "internal_notes": inp.internal_notes or "",
        "attachments": inp.attachments or [],
        "title": inp.title or "",
        "summary": inp.summary or "",
        "created_at": now, "updated_at": now,
    }
    await db.bills.insert_one(doc)
    return {"id": bid, "bill": coerce(doc)}


@router.patch("/companies/{cid}/bills/{bid}")
async def update_bill(cid: str, bid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    totals_fields = {"line_items", "tax", "shipping", "discount", "discount_type"}
    if totals_fields & set(payload.keys()):
        existing = await db.bills.find_one({"id": bid, "company_id": cid})
        if existing:
            lines = payload.get("line_items", existing.get("line_items") or [])
            tax = payload.get("tax", existing.get("tax", 0))
            ship = payload.get("shipping", existing.get("shipping", 0))
            disc = payload.get("discount", existing.get("discount", 0))
            dtype = payload.get("discount_type", existing.get("discount_type") or "amount")
            subtotal, disc_amt, ship_v, tax_v, total = _sum_lines(lines, tax, ship, disc, dtype)
            paid = float(existing.get("total") or 0) - float(existing.get("balance_due") or 0)
            payload["subtotal"] = subtotal
            payload["tax"] = tax_v
            payload["shipping"] = ship_v
            payload["discount"] = float(disc or 0)
            payload["discount_type"] = dtype
            payload["discount_amount"] = disc_amt
            payload["total"] = total
            payload["balance_due"] = round(max(total - paid, 0.0), 2)
    number_conflict = False
    if payload.get("number"):
        dup = await db.bills.find_one(
            {"company_id": cid, "number": payload["number"], "id": {"$ne": bid}},
            {"_id": 0, "id": 1},
        )
        if dup:
            number_conflict = True
    payload["updated_at"] = now_iso()
    await db.bills.update_one({"id": bid, "company_id": cid}, {"$set": payload})
    return {"ok": True, "number_conflict": number_conflict}


@router.delete("/companies/{cid}/bills/{bid}")
async def delete_bill(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    from link_cascade import cascade_on_doc_delete
    cascade = await cascade_on_doc_delete(cid, "bill", bid)
    await db.bills.delete_one({"id": bid, "company_id": cid})
    return {"ok": True, **cascade}




@router.get("/companies/{cid}/bills/{bid}/pdf")
async def bill_pdf(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    bill = await db.bills.find_one({"id": bid, "company_id": cid})
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    company = await db.companies.find_one({"id": cid})
    payments = await db.payments.find({"company_id": cid, "linked_bill_id": bid}).to_list(200)
    from document_pdfs import build_document_pdf
    pdf = build_document_pdf(kind="bill", doc=bill, company=company, payments=payments)
    filename = f"bill-{bill.get('number','')}.pdf".replace(" ", "_")
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
