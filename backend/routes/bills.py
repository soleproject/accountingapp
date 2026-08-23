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
from qbo_mirror.autopush import (
    try_auto_push, try_auto_update, try_auto_delete,
)
router = APIRouter(prefix="/api")


# ----------------------- Bills -----------------------

@router.get("/companies/{cid}/bills")
async def list_bills(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.bills.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    # Batched self-heal (mirror of invoices) — reverses any legacy
    # payment-delete that skipped the balance recomputation.
    paid_by_bill: dict[str, float] = {}
    async for row in db.payments.aggregate([
        {"$match": {"company_id": cid, "linked_bill_id": {"$ne": None}}},
        {"$group": {"_id": "$linked_bill_id", "paid": {"$sum": "$amount"}}},
    ]):
        paid_by_bill[row["_id"]] = float(row["paid"] or 0)
    now = now_iso()
    for d in docs:
        total = float(d.get("total") or 0)
        paid = paid_by_bill.get(d["id"], 0.0)
        expected_bal = round(max(total - paid, 0.0), 2)
        persisted_bal = float(d.get("balance_due") or 0)
        if abs(expected_bal - persisted_bal) > 0.01:
            st = ("paid" if expected_bal <= 0.01
                  else "partial" if paid > 0
                  else (d.get("status") or "open"))
            d["balance_due"] = expected_bal
            d["status"] = st
            await db.bills.update_one(
                {"id": d["id"], "company_id": cid},
                {"$set": {"balance_due": expected_bal, "status": st, "updated_at": now}},
            )
    return {"bills": [coerce(d) for d in docs]}


@router.get("/companies/{cid}/bills/{bid}")
async def get_bill(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    b = await db.bills.find_one({"id": bid, "company_id": cid})
    if not b:
        raise HTTPException(status_code=404, detail="Bill not found")
    total = float(b.get("total") or 0)
    paid = 0.0
    async for p in db.payments.find({"company_id": cid, "linked_bill_id": bid}):
        paid += float(p.get("amount") or 0)
    expected_bal = round(max(total - paid, 0.0), 2)
    persisted_bal = float(b.get("balance_due") or 0)
    if abs(expected_bal - persisted_bal) > 0.01:
        st = ("paid" if expected_bal <= 0.01
              else "partial" if paid > 0
              else (b.get("status") or "open"))
        await db.bills.update_one(
            {"id": bid, "company_id": cid},
            {"$set": {"balance_due": expected_bal, "status": st, "updated_at": now_iso()}},
        )
        b["balance_due"] = expected_bal
        b["status"] = st
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
    # Inventory hooks — post JEs & update item QOH/cost for tracked lines.
    try:
        from inventory_service import apply_bill_inventory
        hooks = await apply_bill_inventory(cid, doc)
        if hooks:
            # `apply_bill_inventory` may have back-stamped item_id onto
            # lines that matched by name — persist those too.
            await db.bills.update_one({"id": bid, "company_id": cid},
                                      {"$set": {"inventory_hooks": hooks,
                                                "line_items": doc.get("line_items") or [],
                                                "updated_at": now_iso()}})
            doc["inventory_hooks"] = hooks
    except Exception as e:
        # Never let inventory bookkeeping block the bill save — surface
        # the error into the doc so the UI can prompt the user.
        await db.bills.update_one({"id": bid, "company_id": cid},
                                  {"$set": {"inventory_error": str(e)}})

    # Post the accrual JE (DR Expense / CR A/P). Mirror of the invoice
    # fix above — closes the day-one bug where non-QBO companies got
    # bills that never landed on the balance sheet. Idempotent, safe
    # on drafts. Feb 28 2026.
    try:
        from posting_service import post_bill_je
        await post_bill_je(cid, doc)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning(
            "bill JE post failed for %s: %s", bid, e)

    # Fire-and-forget mirror push. Silent no-op if QBO Mirror is
    # disabled or bill is voided.
    try_auto_push(cid, "bill", bid)
    # Audit — bill creation.
    try:
        import audit as _audit
        _audit.log_create(
            "bill", bid, coerce(doc),
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            summary=f"Bill {doc.get('number') or ''} · {doc.get('contact_name') or ''} · ${total:,.2f}".strip(),
        )
    except Exception:  # noqa: BLE001
        pass
    return {"id": bid, "bill": coerce(doc)}


@router.patch("/companies/{cid}/bills/{bid}")
async def update_bill(cid: str, bid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Snapshot before doc for the audit trail (fetched even on
    # non-totals-changing PATCHes so we always have diff context).
    before_doc = await db.bills.find_one({"id": bid, "company_id": cid})
    totals_fields = {"line_items", "tax", "shipping", "discount", "discount_type"}
    if totals_fields & set(payload.keys()):
        existing = before_doc
        if existing:
            lines = payload.get("line_items", existing.get("line_items") or [])
            # See invoices.py — peel rolled-up per-line tax off `existing.tax`
            # before re-summing so partial PATCH doesn't double-count.
            prev_line_tax = sum(float(li.get("tax_amount") or 0)
                                for li in (existing.get("line_items") or []))
            base_tax = float(existing.get("tax", 0) or 0) - prev_line_tax
            tax = payload.get("tax", base_tax)
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
    # A user PATCH is an authoritative local edit — clear any stale
    # `_sync_origin: mirror_pull` from the last pull so autopush
    # correctly propagates this change back to QBO on our next hop.
    payload["_sync_origin"] = "user_edit"
    await db.bills.update_one({"id": bid, "company_id": cid}, {"$set": payload})
    # Re-run inventory hooks on any save so QOH & JEs stay in sync with
    # the latest lines. Reads the freshest doc, then persists the new
    # hook records back onto it.
    try:
        from inventory_service import apply_bill_inventory
        fresh = await db.bills.find_one({"id": bid, "company_id": cid})
        if fresh:
            hooks = await apply_bill_inventory(cid, fresh)
            await db.bills.update_one({"id": bid, "company_id": cid},
                                      {"$set": {"inventory_hooks": hooks,
                                                "line_items": fresh.get("line_items") or [],
                                                "updated_at": now_iso()}})
    except Exception as e:
        await db.bills.update_one({"id": bid, "company_id": cid},
                                  {"$set": {"inventory_error": str(e)}})
    # Fire-and-forget mirror update.
    try_auto_update(cid, "bill", bid)
    # If totals-affecting fields changed, reverse + repost the accrual
    # JE so the ledger stays in sync with the fresh amount. Feb 28 2026.
    if totals_fields & set(payload.keys()):
        try:
            from posting_service import (
                reverse_document_je, post_bill_je,
            )
            await reverse_document_je(cid, "bill", bid)
            fresh_b = await db.bills.find_one({"id": bid, "company_id": cid})
            if fresh_b:
                await post_bill_je(cid, fresh_b)
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger(__name__).warning(
                "bill JE repost failed for %s: %s", bid, e)
    # Audit — capture before/after diff.
    try:
        import audit as _audit
        after_doc = await db.bills.find_one({"id": bid, "company_id": cid})
        _audit.log_update(
            "bill", bid, coerce(before_doc) if before_doc else {}, coerce(after_doc) if after_doc else {},
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            summary=f"Bill {(after_doc or {}).get('number') or ''} updated ({', '.join(sorted(payload.keys()))[:120]})",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "number_conflict": number_conflict}


@router.delete("/companies/{cid}/bills/{bid}")
async def delete_bill(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    from link_cascade import cascade_on_doc_delete
    # Reverse inventory hooks before wiping the doc — items get restored
    # to their pre-bill QOH and the JEs get removed.
    existing = await db.bills.find_one({"id": bid, "company_id": cid})
    qbo_id = (existing or {}).get("qbo_id")
    bill_number = (existing or {}).get("number") or ""
    try:
        from inventory_service import _reverse_bill_hooks
        if existing:
            await _reverse_bill_hooks(cid, existing)
    except Exception:
        pass
    cascade = await cascade_on_doc_delete(cid, "bill", bid)
    await db.bills.delete_one({"id": bid, "company_id": cid})
    # Reverse the accrual JE that create_bill posted (idempotent).
    try:
        from posting_service import reverse_document_je
        await reverse_document_je(cid, "bill", bid)
    except Exception:  # noqa: BLE001
        pass
    # Mirror delete on QBO if this bill was previously synced.
    try_auto_delete(cid, "bill", qbo_id, bill_number)
    # Audit — full snapshot on delete per policy.
    try:
        import audit as _audit
        _audit.log_delete(
            "bill", bid, coerce(existing) if existing else {"id": bid, "number": bill_number},
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            summary=f"Deleted bill {bill_number}",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, **cascade}




@router.get("/companies/{cid}/bills/{bid}/pdf")
async def bill_pdf(cid: str, bid: str, request: Request, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    bill = await db.bills.find_one({"id": bid, "company_id": cid})
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    company = await db.companies.find_one({"id": cid})
    payments = await db.payments.find({"company_id": cid, "linked_bill_id": bid}).to_list(200)
    from document_pdfs import build_document_pdf
    pdf = build_document_pdf(kind="bill", doc=bill, company=company, payments=payments)
    filename = f"bill-{bill.get('number','')}.pdf".replace(" ", "_")
    # Audit — bill PDF download.
    try:
        import audit as _audit
        _audit.log_export(
            kind="bill",
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid, file_format="pdf",
            entity_type="bill", entity_id=bid, filename=filename,
            metadata={"number": bill.get("number"), "total": bill.get("total")},
            request=request,
            summary=f"Downloaded bill {bill.get('number','')} PDF",
        )
    except Exception:  # noqa: BLE001
        pass
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
