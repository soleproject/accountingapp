"""Axiom Ledger — Reports routes.

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


# ----------------------- Reports -----------------------

def _default_range() -> tuple[str, str]:
    end = datetime.now(timezone.utc).date()
    start = end.replace(month=1, day=1)
    return start.isoformat(), end.isoformat()


@router.get("/companies/{cid}/reports/income-statement")
async def rep_income(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     basis: str = "accrual", user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    start_eff, end_eff = start or s, end or e
    cache = get_cache()
    key = cache.key("income_stmt", company_id=cid, s=start_eff, e=end_eff, b=basis)
    return await cache.get_or_compute(
        key, DASH_CACHE_TTL,
        lambda: R.compute_income_statement(cid, start_eff, end_eff, basis),
    )


@router.get("/companies/{cid}/reports/income-statement/pdf")
async def rep_income_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                         basis: str = "accrual", user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_income_statement(cid, start or s, end or e, basis)
    pdf = R.build_income_statement_pdf(data)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=income_statement.pdf"})


@router.get("/companies/{cid}/reports/balance-sheet")
async def rep_bs(cid: str, as_of: Optional[str] = None, basis: str = "accrual",
                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    return await R.compute_balance_sheet(cid, as_of or e, basis)


@router.get("/companies/{cid}/reports/balance-sheet/pdf")
async def rep_bs_pdf(cid: str, as_of: Optional[str] = None, basis: str = "accrual",
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_balance_sheet(cid, as_of or e, basis)
    return Response(content=R.build_balance_sheet_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=balance_sheet.pdf"})



@router.get("/companies/{cid}/reports/account-detail")
async def rep_account_detail(cid: str, account_id: str,
                             start: Optional[str] = None, end: Optional[str] = None,
                             q: Optional[str] = None,
                             contact_id: Optional[str] = None,
                             min_amount: Optional[float] = None,
                             max_amount: Optional[float] = None,
                             user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    return await R.compute_account_detail(cid, account_id, start, end,
                                          q=q, contact_id=contact_id,
                                          min_amount=min_amount, max_amount=max_amount)


@router.get("/companies/{cid}/reports/account-detail/pdf")
async def rep_account_detail_pdf(cid: str, account_id: str,
                                 start: Optional[str] = None, end: Optional[str] = None,
                                 q: Optional[str] = None,
                                 contact_id: Optional[str] = None,
                                 min_amount: Optional[float] = None,
                                 max_amount: Optional[float] = None,
                                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    data = await R.compute_account_detail(cid, account_id, start, end,
                                          q=q, contact_id=contact_id,
                                          min_amount=min_amount, max_amount=max_amount)
    fname = f"account_detail_{(data.get('account') or {}).get('code','x')}.pdf"
    return Response(content=R.build_account_detail_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename={fname}"})



@router.get("/companies/{cid}/reports/trial-balance")
async def rep_tb(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    return await R.compute_trial_balance(cid, as_of or e)


@router.get("/companies/{cid}/reports/trial-balance/pdf")
async def rep_tb_pdf(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_trial_balance(cid, as_of or e)
    return Response(content=R.build_trial_balance_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=trial_balance.pdf"})


@router.get("/companies/{cid}/reports/general-ledger")
async def rep_gl(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    return await R.compute_general_ledger(cid, start or s, end or e)


@router.get("/companies/{cid}/reports/general-ledger/pdf")
async def rep_gl_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_general_ledger(cid, start or s, end or e)
    return Response(content=R.build_general_ledger_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=general_ledger.pdf"})


@router.get("/companies/{cid}/reports/cash-flow")
async def rep_cf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    return await R.compute_cash_flow(cid, start or s, end or e)


@router.get("/companies/{cid}/reports/cash-flow/pdf")
async def rep_cf_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_cash_flow(cid, start or s, end or e)
    return Response(content=R.build_cash_flow_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=cash_flow.pdf"})


@router.get("/companies/{cid}/reports/sales-tax")
async def rep_sales_tax(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                        user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    return await R.compute_sales_tax(cid, start or s, end or e)


@router.get("/companies/{cid}/reports/sales-tax/pdf")
async def rep_sales_tax_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_sales_tax(cid, start or s, end or e)
    return Response(content=R.build_sales_tax_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=sales_tax_liability.pdf"})


@router.get("/companies/{cid}/reports/1099-summary")
async def rep_1099(cid: str, year: Optional[int] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    return await R.compute_1099_summary(cid, y)


@router.get("/companies/{cid}/reports/1099-summary/pdf")
async def rep_1099_pdf(cid: str, year: Optional[int] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    data = await R.compute_1099_summary(cid, y)
    return Response(content=R.build_1099_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=1099_summary.pdf"})


@router.get("/companies/{cid}/reports/ar-aging")
async def rep_ar_aging(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    return await R.compute_ar_aging(cid, as_of or e)


@router.get("/companies/{cid}/reports/ap-aging")
async def rep_ap_aging(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    return await R.compute_ap_aging(cid, as_of or e)


