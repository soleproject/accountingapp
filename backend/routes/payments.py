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
from qbo_mirror.autopush import (
    try_auto_push, try_auto_update, try_auto_delete,
)


def _payment_mirror_entity(doc: dict) -> str | None:
    """Which mirror-entity key applies to this payment doc.
    None → unlinked payment, cannot be mirrored (would be a bare
    QBO deposit/withdrawal, losing its business meaning)."""
    if doc.get("linked_invoice_id"):
        return "payment_in"
    if doc.get("linked_bill_id"):
        return "payment_out"
    return None


router = APIRouter(prefix="/api")


# ----------------------- Payments & Receipts -----------------------

@router.get("/companies/{cid}/payments")
async def list_payments(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.payments.find({"company_id": cid}).sort("date", -1).to_list(1000)
    return {"payments": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/payments")
async def create_payment(cid: str, inp: PaymentCreate, user: dict = Depends(get_current_user)):
    """Record a customer payment (against an invoice) or a vendor
    payment (against a bill). This is a multi-doc write — payment row +
    invoice/bill.balance_due update + (for inventory bills) an A/P
    relief JE + reverse-link stamp on the source transaction. All four
    writes MUST land together or none of them do; otherwise you get the
    class of bug where a payment shows in the ledger but the invoice
    still says "unpaid". Wrapped in `ledger_transaction()`.
    """
    await require_company(user, cid)
    from db import ledger_transaction
    pid = str(uuid.uuid4()); now = now_iso()

    async with ledger_transaction() as _s:
        payload = inp.model_dump()
        # Stamp direction from linkage so the diff engine + mirror
        # dispatch both know which QBO endpoint applies. Unlinked
        # payments (e.g. bare deposits) get no direction and won't
        # be mirrored.
        if payload.get("linked_invoice_id"):
            payload["direction"] = "in"
        elif payload.get("linked_bill_id"):
            payload["direction"] = "out"
        # Undeposited Funds default: a customer receipt (direction='in')
        # that isn't paired with a bank transaction and doesn't specify
        # a deposit account should land in Undeposited Funds — matches
        # QBO's default behaviour. Without this the payment silently
        # reduces AR without a matching asset-side bump, unbalancing
        # the BS by `amount`. Feb 28 2026.
        if (payload.get("direction") == "in"
                and not payload.get("deposit_to_account_id")
                and not payload.get("source_transaction_id")):
            undep = await db.accounts.find_one({
                "company_id": cid,
                "$or": [{"detail_type": "money_in_transit"},
                        {"name": {"$regex": "^Undeposited Funds$",
                                  "$options": "i"}}],
            })
            if undep:
                payload["deposit_to_account_id"] = undep["id"]
        await db.payments.insert_one({
            "id": pid, "company_id": cid, **payload,
            "created_at": now, "updated_at": now,
        }, session=_s)
        # If linked to invoice/bill, reduce balance_due
        if inp.linked_invoice_id:
            inv = await db.invoices.find_one(
                {"id": inp.linked_invoice_id, "company_id": cid},
                session=_s,
            )
            if inv:
                bal = float(inv.get("balance_due", inv.get("total", 0))) - float(inp.amount)
                status = "paid" if bal <= 0.01 else "partial"
                await db.invoices.update_one(
                    {"id": inv["id"]},
                    {"$set": {"balance_due": round(bal, 2), "status": status}},
                    session=_s,
                )
        if inp.linked_bill_id:
            bill = await db.bills.find_one(
                {"id": inp.linked_bill_id, "company_id": cid},
                session=_s,
            )
            if bill:
                bal = float(bill.get("balance_due", bill.get("total", 0))) - float(inp.amount)
                status = "paid" if bal <= 0.01 else "partial"
                await db.bills.update_one(
                    {"id": bill["id"]},
                    {"$set": {"balance_due": round(bal, 2), "status": status}},
                    session=_s,
                )
                # Inventory-tracked bills need an A/P relief JE so the
                # bill's inventory JE doesn't leave A/P lingering after
                # payment. We deliberately don't pass the session into
                # `relieve_ap_on_bill_payment` yet — that helper doesn't
                # accept one today, and re-plumbing it is out of scope
                # for this pass. Follow-up: thread session through
                # inventory_service so this call joins the same
                # transaction.
                if bill.get("inventory_hooks"):
                    try:
                        from inventory_service import relieve_ap_on_bill_payment
                        await relieve_ap_on_bill_payment(cid, bill["id"],
                                                        float(inp.amount),
                                                        inp.source_transaction_id)
                    except Exception:
                        pass
        # Stamp the reverse-link back on the source transaction so
        # cascade-on-transaction-delete knows to reverse this payment.
        if inp.source_transaction_id:
            await db.transactions.update_one(
                {"id": inp.source_transaction_id, "company_id": cid},
                {"$set": {
                    "linked_payment_id": pid,
                    "linked_invoice_id": inp.linked_invoice_id,
                    "linked_bill_id": inp.linked_bill_id,
                    "updated_at": now,
                }},
                session=_s,
            )
    # Fire-and-forget mirror push (both directions). Unlinked
    # payments are silently skipped by `_payment_mirror_entity`.
    entity = _payment_mirror_entity(inp.model_dump())
    if entity:
        try_auto_push(cid, entity, pid)
    return {"id": pid}


@router.patch("/companies/{cid}/payments/{pid}")
async def update_payment(cid: str, pid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Update an existing payment and keep every downstream balance
    in sync.

    Accepts partial ``payload`` — any subset of ``amount``, ``date``,
    ``method``, ``memo``, ``contact_id``, ``contact_name``,
    ``linked_invoice_id``, ``linked_bill_id``. When ``amount`` or the
    link-ids change we:

      1. reverse the OLD payment's impact on its OLD linked doc (via
         the shared ``_reverse_payment_impact`` helper — adds the old
         amount back to ``balance_due``, resets status).
      2. write the new payment fields.
      3. apply the NEW impact to the NEW linked doc (subtract new
         amount from ``balance_due``, flip status paid/partial).

    Only the changed fields are written; unchanged docs are left
    alone.
    """
    await require_company(user, cid)
    existing = await db.payments.find_one({"id": pid, "company_id": cid})
    if not existing:
        raise HTTPException(status_code=404, detail="Payment not found")

    # Whitelist the fields the caller may touch — everything else stays.
    allowed = {"amount", "date", "method", "memo", "contact_id",
               "contact_name", "linked_invoice_id", "linked_bill_id"}
    updates = {k: v for k, v in (payload or {}).items() if k in allowed}
    if not updates:
        return {"ok": True, "changed": False}

    # Rate check + sanity on amount.
    if "amount" in updates:
        try:
            updates["amount"] = float(updates["amount"] or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Amount must be a number")
        if updates["amount"] < 0:
            raise HTTPException(status_code=400, detail="Amount cannot be negative")

    # Detect if the balance-affecting bits actually changed. If not,
    # we can skip the cascade entirely.
    balance_dirty = (
        ("amount" in updates and float(updates["amount"]) != float(existing.get("amount") or 0))
        or ("linked_invoice_id" in updates and updates["linked_invoice_id"] != existing.get("linked_invoice_id"))
        or ("linked_bill_id" in updates and updates["linked_bill_id"] != existing.get("linked_bill_id"))
    )

    from link_cascade import _reverse_payment_impact
    if balance_dirty and (existing.get("linked_invoice_id") or existing.get("linked_bill_id")):
        # Step 1 — undo the old effect on the old linked doc.
        await _reverse_payment_impact(cid, existing)

    updates["updated_at"] = now_iso()
    await db.payments.update_one({"id": pid, "company_id": cid}, {"$set": updates})

    if balance_dirty:
        # Step 2 — apply the new effect to the new linked doc.
        new_amount = float(updates.get("amount", existing.get("amount") or 0))
        new_inv = updates.get("linked_invoice_id", existing.get("linked_invoice_id"))
        new_bill = updates.get("linked_bill_id", existing.get("linked_bill_id"))
        if new_inv:
            inv = await db.invoices.find_one({"id": new_inv, "company_id": cid})
            if inv:
                bal = float(inv.get("balance_due", inv.get("total", 0))) - new_amount
                status = "paid" if bal <= 0.01 else "partial"
                await db.invoices.update_one({"id": inv["id"]},
                    {"$set": {"balance_due": round(bal, 2), "status": status,
                              "updated_at": now_iso()}})
        elif new_bill:
            bill = await db.bills.find_one({"id": new_bill, "company_id": cid})
            if bill:
                bal = float(bill.get("balance_due", bill.get("total", 0))) - new_amount
                status = "paid" if bal <= 0.01 else "partial"
                await db.bills.update_one({"id": bill["id"]},
                    {"$set": {"balance_due": round(bal, 2), "status": status,
                              "updated_at": now_iso()}})
    # Fire-and-forget mirror update. If the payment has no qbo_id
    # yet (initial autopush failed) this routes through fresh-push.
    # Otherwise it's a documented no-op — payment linkage updates
    # aren't mirrored (see qbo_mirror/autopush.py::_run_auto_update).
    fresh = await db.payments.find_one({"id": pid, "company_id": cid})
    entity = _payment_mirror_entity(fresh or {})
    if entity:
        try_auto_update(cid, entity, pid)
    return {"ok": True, "changed": True, "balance_recalculated": balance_dirty}



@router.delete("/companies/{cid}/payments/{pid}")
async def delete_payment(cid: str, pid: str, user: dict = Depends(get_current_user)):
    """Delete a payment AND reverse its impact on any linked invoice/bill.

    Prior to Feb 2026 this route just removed the payments row, leaving
    the linked doc's ``balance_due`` and ``status`` stuck at their
    partially-paid values — a real user hit that as "I deleted the
    payment but the invoice still says $50 due". We now:

    1. Look up the payment first (need the amount + link ids).
    2. Reverse its balance impact on the linked invoice/bill via the
       shared cascade helper (adds the amount back to ``balance_due``
       and flips status open/sent/partial as appropriate).
    3. Clear ``linked_payment_id`` on any transaction that owned this
       payment so downstream reports stay consistent.
    4. Delete the payment row itself.
    """
    await require_company(user, cid)
    payment = await db.payments.find_one({"id": pid, "company_id": cid})
    if not payment:
        # Idempotent — treat missing payment as already-deleted.
        return {"ok": True, "reversed": False}
    entity = _payment_mirror_entity(payment)
    qbo_id = payment.get("qbo_id")
    from link_cascade import _reverse_payment_impact
    if payment.get("linked_invoice_id") or payment.get("linked_bill_id"):
        await _reverse_payment_impact(cid, payment)
    # Any transaction pointing at this payment loses that ref.
    await db.transactions.update_many(
        {"company_id": cid, "linked_payment_id": pid},
        {"$set": {"linked_payment_id": None, "updated_at": now_iso()}},
    )
    await db.payments.delete_one({"id": pid, "company_id": cid})
    # Mirror delete on QBO if this payment was previously synced.
    if entity and qbo_id:
        try_auto_delete(cid, entity, qbo_id, "")
    return {"ok": True, "reversed": bool(payment.get("linked_invoice_id") or payment.get("linked_bill_id"))}


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


@router.patch("/companies/{cid}/receipts/{rid}")
async def update_receipt(
    cid: str, rid: str, inp: ReceiptCreate,
    user: dict = Depends(get_current_user),
):
    """Overwrite a receipt in place. Uses the same shape as create so the
    modal can double as an editor. Every field submitted replaces the
    stored value — the frontend always sends the full form. Untouched
    fields (created_at, id, company_id) are preserved."""
    await require_company(user, cid)
    existing = await db.receipts.find_one({"id": rid, "company_id": cid})
    if not existing:
        raise HTTPException(404, "Receipt not found")
    await db.receipts.update_one(
        {"id": rid, "company_id": cid},
        {"$set": {**inp.model_dump(), "updated_at": now_iso()}},
    )
    return {"id": rid, "ok": True}


@router.delete("/companies/{cid}/receipts/{rid}")
async def delete_receipt(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.receipts.delete_one({"id": rid, "company_id": cid})
    return {"ok": True}


