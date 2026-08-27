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

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Request
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
import report_csv as R_csv
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


# ────────────────────────────────────────────────────────────────
# Shared export audit helper
# ────────────────────────────────────────────────────────────────

def _log_export(user: dict, cid: str, kind: str, filename: str,
                request: Request, extra: Optional[dict] = None) -> None:
    """One-liner audit call for every PDF/CSV export in this file.

    Wrapped in try/except so a missing/misconfigured audit backend can
    never block the download itself — the file bytes must always ship.
    Compliance-shaped: captures who / when / from-what-IP / with-what-
    params, but never the file contents (a 300KB PDF stored per event
    would swamp the audit collection)."""
    try:
        import audit as _audit
        _audit.log_export(
            kind=kind,
            actor={"id": user["id"], "email": user.get("email"),
                    "role": user.get("role")},
            company_id=cid,
            file_format=filename.rsplit(".", 1)[-1].lower(),
            entity_type="report",
            entity_id=kind,
            filename=filename,
            metadata=extra or {},
            request=request,
            summary=f"Downloaded {kind} ({filename.rsplit('.', 1)[-1].upper()})",
        )
    except Exception:  # noqa: BLE001
        pass

router = APIRouter(prefix="/api")


# ----------------------- Reports -----------------------

def _default_range() -> tuple[str, str]:
    end = datetime.now(timezone.utc).date()
    start = end.replace(month=1, day=1)
    return start.isoformat(), end.isoformat()


@router.get("/companies/{cid}/reports/income-statement")
async def rep_income(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     basis: str = "accrual", imported_only: bool = False,
                     class_id: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    start_eff, end_eff = start or s, end or e
    # `imported_only` requests the QBO-imported-slice view for the
    # Reconciliation panel — bypass the shared cache so we don't hand
    # back the combined view. Aug 23 2026.
    if imported_only:
        return await R.compute_income_statement(cid, start_eff, end_eff, basis, imported_only=True)
    # Class-scoped view (Feb 2026 Phase 2). Keyed into the cache so
    # switching classes doesn't blow the un-filtered cache away.
    cache = get_cache()
    key = cache.key("income_stmt", company_id=cid, s=start_eff, e=end_eff, b=basis,
                    cls=class_id or "_")
    return await cache.get_or_compute(
        key, DASH_CACHE_TTL,
        lambda: R.compute_income_statement(cid, start_eff, end_eff, basis,
                                            class_id=class_id),
    )


@router.get("/companies/{cid}/reports/income-statement/pdf")
async def rep_income_pdf(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                         basis: str = "accrual", user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_income_statement(cid, start or s, end or e, basis)
    pdf = R.build_income_statement_pdf(data)
    _log_export(user, cid, "income-statement", "income_statement.pdf", request,
                {"start": start or s, "end": end or e, "basis": basis})
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=income_statement.pdf"})


@router.get("/companies/{cid}/reports/balance-sheet")
async def rep_bs(cid: str, as_of: Optional[str] = None, basis: str = "accrual",
                 imported_only: bool = False,
                 class_id: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    return await R.compute_balance_sheet(cid, as_of or e, basis,
                                           imported_only=imported_only,
                                           class_id=class_id)


@router.get("/companies/{cid}/reports/balance-sheet/pdf")
async def rep_bs_pdf(cid: str, request: Request, as_of: Optional[str] = None, basis: str = "accrual",
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_balance_sheet(cid, as_of or e, basis)
    _log_export(user, cid, "balance-sheet", "balance_sheet.pdf", request,
                {"as_of": as_of or e, "basis": basis})
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
async def rep_account_detail_pdf(cid: str, request: Request, account_id: str,
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
    _log_export(user, cid, "account-detail", fname, request,
                {"account_id": account_id, "start": start, "end": end,
                 "q": q, "contact_id": contact_id})
    return Response(content=R.build_account_detail_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename={fname}"})



@router.get("/companies/{cid}/reports/trial-balance")
async def rep_tb(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    return await R.compute_trial_balance(cid, as_of or e)


@router.get("/companies/{cid}/reports/trial-balance/pdf")
async def rep_tb_pdf(cid: str, request: Request, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_trial_balance(cid, as_of or e)
    _log_export(user, cid, "trial-balance", "trial_balance.pdf", request, {"as_of": as_of or e})
    return Response(content=R.build_trial_balance_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=trial_balance.pdf"})


@router.get("/companies/{cid}/reports/general-ledger")
async def rep_gl(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    return await R.compute_general_ledger(cid, start or s, end or e)


@router.get("/companies/{cid}/reports/general-ledger/pdf")
async def rep_gl_pdf(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_general_ledger(cid, start or s, end or e)
    _log_export(user, cid, "general-ledger", "general_ledger.pdf", request,
                {"start": start or s, "end": end or e})
    return Response(content=R.build_general_ledger_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=general_ledger.pdf"})


@router.get("/companies/{cid}/reports/cash-flow")
async def rep_cf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                 class_id: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    return await R.compute_cash_flow(cid, start or s, end or e, class_id=class_id)


@router.get("/companies/{cid}/reports/cash-flow/pdf")
async def rep_cf_pdf(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_cash_flow(cid, start or s, end or e)
    _log_export(user, cid, "cash-flow", "cash_flow.pdf", request,
                {"start": start or s, "end": end or e})
    return Response(content=R.build_cash_flow_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=cash_flow.pdf"})


@router.get("/companies/{cid}/reports/sales-tax")
async def rep_sales_tax(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                        user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    return await R.compute_sales_tax(cid, start or s, end or e)


@router.get("/companies/{cid}/reports/sales-tax/pdf")
async def rep_sales_tax_pdf(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_sales_tax(cid, start or s, end or e)
    _log_export(user, cid, "sales-tax", "sales_tax_liability.pdf", request,
                {"start": start or s, "end": end or e})
    return Response(content=R.build_sales_tax_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=sales_tax_liability.pdf"})


@router.get("/companies/{cid}/reports/1099-summary")
async def rep_1099(cid: str, year: Optional[int] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    return await R.compute_1099_summary(cid, y)


@router.get("/companies/{cid}/reports/1099-summary/pdf")
async def rep_1099_pdf(cid: str, request: Request, year: Optional[int] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    data = await R.compute_1099_summary(cid, y)
    _log_export(user, cid, "1099-summary", "1099_summary.pdf", request, {"year": y})
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




# ========================================================================
# CSV exports — one route per report, mirrors the /pdf route contract.
# The UI's Export dropdown flips between PDF and CSV by swapping the
# extension in the URL; params are identical.
# ========================================================================

def _csv_response(csv_bytes: bytes, filename: str) -> Response:
    return Response(
        content=csv_bytes, media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/companies/{cid}/reports/income-statement/csv")
async def rep_income_csv(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                         basis: str = "accrual", user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_income_statement(cid, start or s, end or e, basis)
    _log_export(user, cid, "income-statement", "income_statement.csv", request,
                {"start": start or s, "end": end or e, "basis": basis})
    return _csv_response(R_csv.build_income_statement_csv(data), "income_statement.csv")


@router.get("/companies/{cid}/reports/balance-sheet/csv")
async def rep_bs_csv(cid: str, request: Request, as_of: Optional[str] = None, basis: str = "accrual",
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_balance_sheet(cid, as_of or e, basis)
    _log_export(user, cid, "balance-sheet", "balance_sheet.csv", request,
                {"as_of": as_of or e, "basis": basis})
    return _csv_response(R_csv.build_balance_sheet_csv(data), "balance_sheet.csv")


@router.get("/companies/{cid}/reports/account-detail/csv")
async def rep_account_detail_csv(cid: str, request: Request, account_id: str,
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
    fname = f"account_detail_{(data.get('account') or {}).get('code', 'x')}.csv"
    _log_export(user, cid, "account-detail", fname, request,
                {"account_id": account_id, "start": start, "end": end,
                 "q": q, "contact_id": contact_id})
    return _csv_response(R_csv.build_account_detail_csv(data), fname)


@router.get("/companies/{cid}/reports/trial-balance/csv")
async def rep_tb_csv(cid: str, request: Request, as_of: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_trial_balance(cid, as_of or e)
    _log_export(user, cid, "trial-balance", "trial_balance.csv", request, {"as_of": as_of or e})
    return _csv_response(R_csv.build_trial_balance_csv(data), "trial_balance.csv")


@router.get("/companies/{cid}/reports/general-ledger/csv")
async def rep_gl_csv(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_general_ledger(cid, start or s, end or e)
    _log_export(user, cid, "general-ledger", "general_ledger.csv", request,
                {"start": start or s, "end": end or e})
    return _csv_response(R_csv.build_general_ledger_csv(data), "general_ledger.csv")


@router.get("/companies/{cid}/reports/cash-flow/csv")
async def rep_cf_csv(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_cash_flow(cid, start or s, end or e)
    _log_export(user, cid, "cash-flow", "cash_flow.csv", request,
                {"start": start or s, "end": end or e})
    return _csv_response(R_csv.build_cash_flow_csv(data), "cash_flow.csv")


@router.get("/companies/{cid}/reports/sales-tax/csv")
async def rep_sales_tax_csv(cid: str, request: Request, start: Optional[str] = None, end: Optional[str] = None,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_sales_tax(cid, start or s, end or e)
    _log_export(user, cid, "sales-tax", "sales_tax_liability.csv", request,
                {"start": start or s, "end": end or e})
    return _csv_response(R_csv.build_sales_tax_csv(data), "sales_tax_liability.csv")


@router.get("/companies/{cid}/reports/1099-summary/csv")
async def rep_1099_csv(cid: str, request: Request, year: Optional[int] = None,
                       user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    data = await R.compute_1099_summary(cid, y)
    _log_export(user, cid, "1099-summary", "1099_summary.csv", request, {"year": y})
    return _csv_response(R_csv.build_1099_csv(data), "1099_summary.csv")
