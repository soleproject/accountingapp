"""Axiom Ledger — Inventory / Assets / Loans / Tags routes.

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


# ----------------------- Inventory / Assets / Loans / Tags -----------------------

def _make_crud(collection_name: str, path_prefix: str):
    @router.get(f"/companies/{{cid}}/{path_prefix}")
    async def _list(cid: str, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        docs = await db[collection_name].find({"company_id": cid}).to_list(1000)
        return {"items": [coerce(d) for d in docs]}

    @router.post(f"/companies/{{cid}}/{path_prefix}")
    async def _create(cid: str, payload: dict, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        xid = str(uuid.uuid4()); now = now_iso()
        await db[collection_name].insert_one({"id": xid, "company_id": cid, **payload,
                                               "created_at": now, "updated_at": now})
        return {"id": xid}

    @router.patch(f"/companies/{{cid}}/{path_prefix}/{{xid}}")
    async def _update(cid: str, xid: str, payload: dict, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        payload["updated_at"] = now_iso()
        await db[collection_name].update_one({"id": xid, "company_id": cid}, {"$set": payload})
        return {"ok": True}

    @router.delete(f"/companies/{{cid}}/{path_prefix}/{{xid}}")
    async def _delete(cid: str, xid: str, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        await db[collection_name].delete_one({"id": xid, "company_id": cid})
        return {"ok": True}


_make_crud("inventory_items", "inventory")
# Note: assets uses a custom lifecycle service (see below) — NOT the
# generic CRUD, because adding a fixed asset also creates CoA
# sub-accounts, posts an acquisition JE, and generates a monthly
# depreciation schedule.
_make_crud("loans", "loans")


@router.post("/companies/{cid}/loans/{lid}/record-payment")
async def loan_record_payment(cid: str, lid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Post a single amortization payment for this loan.

    Splits the fixed monthly payment into interest (rose) + principal
    (emerald) using the current outstanding balance, writes a journal
    entry (DR Loan Payable + DR Interest Expense / CR Cash), and
    increments the loan's `payments_made` counter. Idempotent per row —
    calling this from a scheduler would still be correct.

    Body: {
      payment_date: "YYYY-MM-DD" (required),
      cash_account_id: string   (required — pick which bank to draw from),
      interest_account_id?: string   (optional — auto-resolves to
                                      "Interest Expense" if missing),
      amount?: number   (optional override — else computed from schedule)
    }
    """
    await require_company(user, cid)
    loan = await db.loans.find_one({"id": lid, "company_id": cid})
    if not loan:
        raise HTTPException(404, "Loan not found")
    principal_start = float(loan.get("principal") or 0)
    paid_so_far = int(loan.get("payments_made") or 0)
    rate_pct = float(loan.get("rate") or 0)
    term = int(loan.get("term_months") or 0)
    if principal_start <= 0 or term <= 0:
        raise HTTPException(400, "Loan is missing principal or term — set both before recording payments.")
    if paid_so_far >= term:
        raise HTTPException(400, "This loan is fully paid off.")

    # Rebuild the amortization schedule up to the next unpaid row to
    # find the exact interest/principal split. Deterministic — same
    # inputs always produce the same numbers.
    r = rate_pct / 100 / 12
    monthly_pmt = principal_start / term if r == 0 else principal_start * (r / (1 - (1 + r) ** -term))
    balance = principal_start
    interest = 0.0
    principal_component = 0.0
    for i in range(paid_so_far + 1):
        interest = balance * r
        principal_component = monthly_pmt - interest
        balance -= principal_component

    payment_amount = float(payload.get("amount") or round(monthly_pmt, 2))
    payment_date = payload.get("payment_date")
    if not payment_date:
        raise HTTPException(400, "payment_date is required (YYYY-MM-DD).")
    cash_account_id = payload.get("cash_account_id")
    if not cash_account_id:
        raise HTTPException(400, "cash_account_id is required — pick which bank/cash account is paying.")
    cash_acc = await db.accounts.find_one({"id": cash_account_id, "company_id": cid})
    if not cash_acc:
        raise HTTPException(400, "Cash account not found in this company.")
    loan_account_id = loan.get("account_id")
    if not loan_account_id:
        raise HTTPException(400, "This loan has no linked CoA account. Create the loan via Chart of Accounts (Loan and Line of Credit sub-type).")
    loan_acc = await db.accounts.find_one({"id": loan_account_id, "company_id": cid})
    if not loan_acc:
        raise HTTPException(400, "Linked loan account is missing from CoA.")

    # Resolve or create Interest Expense account (code 6600 default).
    interest_account_id = payload.get("interest_account_id")
    if not interest_account_id:
        ie = await db.accounts.find_one({
            "company_id": cid,
            "$or": [{"name": {"$regex": r"^interest\s+expense$", "$options": "i"}}, {"code": "6600"}],
        })
        if not ie:
            ie_doc = {
                "id": str(uuid.uuid4()), "company_id": cid,
                "code": "6600", "name": "Interest Expense",
                "type": "expense", "subtype": "Other Expense",
                "detail_type": "other_expense",
                "active": True, "balance": 0.0,
                "created_at": now_iso(), "updated_at": now_iso(),
            }
            await db.accounts.insert_one(ie_doc)
            ie = ie_doc
        interest_account_id = ie["id"]

    # Round the split so the components sum to the payment cents.
    principal_amt = round(principal_component, 2)
    interest_amt = round(interest, 2)
    # Fix rounding drift on the last-payment cent.
    total_computed = round(principal_amt + interest_amt, 2)
    if abs(total_computed - payment_amount) < 0.02:
        principal_amt = round(payment_amount - interest_amt, 2)

    payment_num = paid_so_far + 1
    je_doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "date": payment_date,
        "memo": f"Loan payment #{payment_num}/{term} — {loan.get('lender', 'loan')}",
        "source": "loan_payment",
        "source_id": lid,
        "lines": [
            {"account_id": loan_account_id,     "debit": principal_amt, "credit": 0,             "memo": "Principal"},
            {"account_id": interest_account_id, "debit": interest_amt,  "credit": 0,             "memo": "Interest"},
            {"account_id": cash_account_id,     "debit": 0,             "credit": payment_amount, "memo": "Cash out"},
        ],
        "created_at": now_iso(),
    }
    await db.journal_entries.insert_one(je_doc)

    # Advance counter + snapshot remaining balance for quick lookup.
    await db.loans.update_one(
        {"id": lid, "company_id": cid},
        {"$set": {
            "payments_made": payment_num,
            "current_balance": round(max(0.0, balance), 2),
            "last_payment_date": payment_date,
            "updated_at": now_iso(),
        }},
    )
    return {
        "ok": True,
        "je_id": je_doc["id"],
        "payment_number": payment_num,
        "principal": principal_amt,
        "interest": interest_amt,
        "cash_out": payment_amount,
        "remaining_balance": round(max(0.0, balance), 2),
    }
_make_crud("tags", "tags")
_make_crud("communications", "communications")
_make_crud("connections", "connections")


# ----------------------- Fixed Assets (custom lifecycle) -----------------------

@router.get("/assets/types")
async def list_asset_types():
    """Public metadata used by the FixedAssetsPage modal — returns the
    canonical asset-type dropdown with default useful-life years so the
    frontend can auto-populate the life field on selection."""
    import asset_service
    return {"asset_types": asset_service.ASSET_TYPES}


@router.get("/companies/{cid}/assets")
async def list_assets(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.assets.find({"company_id": cid}).to_list(1000)
    # Look up the "Fixed Asset Suspense" account for this company. When
    # an asset's funding lines still point at suspense, we surface a
    # `pending_suspense_amount` so the register can badge the row —
    # reminding the pro to allocate the funding after creating via CoA.
    import asset_service
    try:
        suspense = await asset_service._ensure_fixed_asset_suspense(cid)
        suspense_id = suspense.get("id")
    except Exception:
        suspense_id = None
    out = []
    for d in docs:
        row = coerce(d)
        offsets = row.get("offsets") or []
        pending = sum(
            float(o.get("amount") or 0) for o in offsets
            if o.get("account_id") == suspense_id
        ) if suspense_id else 0.0
        row["pending_suspense_amount"] = round(pending, 2)
        out.append(row)
    return {"items": out}


@router.post("/companies/{cid}/assets")
async def create_asset(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        import asset_service
        result = await asset_service.create_fixed_asset(cid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.patch("/companies/{cid}/assets/{aid}")
async def update_asset(cid: str, aid: str, payload: dict,
                       user: dict = Depends(get_current_user)):
    """Edit an existing fixed asset.

    Non-financial edits (name/notes/tag_ids/metadata) are cheap — just
    update the row and rename the linked sub-accounts. Financial edits
    (cost / life / dates / offset / asset type) delete the acquisition
    JE + every depreciation JE and re-generate the whole schedule with
    the new values. The asset's `id` stays stable across the swap.
    """
    await require_company(user, cid)
    try:
        import asset_service
        result = await asset_service.update_fixed_asset(cid, aid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.post("/companies/{cid}/assets/fix-hierarchy")
async def fix_asset_hierarchy(cid: str, user: dict = Depends(get_current_user)):
    """One-shot repair: re-home any fixed_asset / accumulated_depreciation
    sub-accounts that were nested under the wrong parent (a legacy bug
    where the code fetched code=1500 assuming it was "Fixed Assets" —
    but 1500 is often "Prepaid Expenses" in seeded CoAs). Idempotent."""
    await require_company(user, cid)
    import asset_service
    parent = await asset_service._ensure_fixed_assets_parent(cid)
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "fixed_assets_parent": {
        "id": parent["id"], "code": parent.get("code"), "name": parent.get("name"),
    }}


@router.post("/companies/{cid}/assets/{aid}/fund")
async def fund_asset(cid: str, aid: str, payload: dict,
                     user: dict = Depends(get_current_user)):
    """Phase-2 funding for an asset created without funding sources.
    Body: `{"sources": [{"account_id": "...", "amount": ...}, ...]}`.
    Sweeps balance out of the Fixed Asset Suspense clearing account
    into the real funding accounts (cash, mortgage, owner, etc.).
    Can be called multiple times if funding trickles in."""
    await require_company(user, cid)
    sources = payload.get("sources") or payload.get("offsets") or []
    try:
        import asset_service
        result = await asset_service.fund_fixed_asset(cid, aid, sources)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.delete("/companies/{cid}/assets/{aid}")
async def delete_asset(cid: str, aid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    import asset_service
    result = await asset_service.delete_fixed_asset(cid, aid)
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


# ═══════════════════ Inventory Management (Tier 2) ═══════════════════
# Weighted-average product/service inventory. The item catalog lives in
# routes/items.py; this section wraps the ledger side-effects: manual
# adjustments, valuation snapshots, and per-item movement history.

class InventoryAdjustmentIn(BaseModel):
    item_id: str
    reason: str                    # shrinkage|damage|recount|opening|other
    new_qoh: Optional[float] = None    # absolute set
    qty_delta: Optional[float] = None  # relative delta (used only if new_qoh is None)
    new_cost_basis: Optional[float] = None
    memo: Optional[str] = ""


@router.post("/companies/{cid}/inventory-management/adjustments")
async def create_inventory_adjustment(
    cid: str, inp: InventoryAdjustmentIn,
    user: dict = Depends(get_current_user),
):
    """Post a manual inventory adjustment (shrinkage, damage, recount,
    opening, other). Writes a movement row + posts a balancing JE
    against the "Inventory Adjustments" expense account (auto-created
    on first use). Callers pass EITHER `new_qoh` (absolute set) or
    `qty_delta` (relative)."""
    await require_company(user, cid)
    if inp.new_qoh is None and inp.qty_delta is None:
        raise HTTPException(status_code=400, detail="Pass either new_qoh or qty_delta.")
    try:
        import inventory_service
        result = await inventory_service.apply_adjustment(
            cid=cid, item_id=inp.item_id,
            new_qoh=inp.new_qoh, qty_delta=inp.qty_delta,
            new_cost_basis=inp.new_cost_basis,
            reason=inp.reason, memo=inp.memo or "",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **result}


@router.get("/companies/{cid}/inventory-management/valuation")
async def inventory_valuation(cid: str, user: dict = Depends(get_current_user)):
    """Snapshot of every tracked item — QOH, avg cost, total value, low-
    stock flag. The Inventory Valuation report renders this."""
    await require_company(user, cid)
    import inventory_service
    return await inventory_service.compute_valuation(cid)


@router.get("/companies/{cid}/inventory-management/movements")
async def inventory_movements(
    cid: str,
    item_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Chronological audit trail of purchases / sales / adjustments for
    inventory items. Optionally filter by item_id + date range."""
    await require_company(user, cid)
    import inventory_service
    return await inventory_service.list_movements(cid, item_id, start, end)


@router.get("/companies/{cid}/inventory-management/valuation/pdf")
async def inventory_valuation_pdf(cid: str, user: dict = Depends(get_current_user)):
    """Print-friendly Inventory Valuation PDF for month-end audit binders."""
    await require_company(user, cid)
    from datetime import date as _date
    import inventory_service
    pdf = await inventory_service.build_valuation_pdf(cid)
    filename = f"inventory-valuation-{_date.today().isoformat()}.pdf"
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.get("/companies/{cid}/inventory-management/reorder-alerts")
async def inventory_reorder_alerts(cid: str, user: dict = Depends(get_current_user)):
    """Every tracked item at or below its low-stock threshold — powers
    the Dashboard reorder tile and one-click Draft PO action."""
    await require_company(user, cid)
    import inventory_service
    return await inventory_service.compute_reorder_alerts(cid)


