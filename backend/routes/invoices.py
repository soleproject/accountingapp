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

def _sum_lines(lines: list, tax: float = 0.0, shipping: float = 0.0,
               discount: float = 0.0, discount_type: str = "amount"):
    """Return (subtotal, discount_amount, shipping, tax, total).

    Applied order: subtotal → subtract discount → add shipping → add tax.
    `tax` here is invoice-level. Per-line tax is stored on each line as
    `tax_rate` (0-100) and rolled up into `tax_amount` automatically; the
    doc-level `tax` output includes both.
    """
    subtotal = 0.0
    line_tax_total = 0.0
    for li in lines:
        amt = float(li.get("amount", 0) or 0)
        subtotal += amt
        rate = float(li.get("tax_rate", 0) or 0)
        if rate:
            line_tax = round(amt * rate / 100.0, 2)
            li["tax_amount"] = line_tax
            line_tax_total += line_tax
        else:
            # Keep the field in sync even when it should be zero, so old
            # rows don't linger with stale per-line tax after edits.
            if "tax_amount" in li:
                li["tax_amount"] = 0.0
    disc = float(discount or 0)
    if (discount_type or "amount").lower() == "percent":
        disc_amt = round(subtotal * disc / 100.0, 2)
    else:
        disc_amt = round(disc, 2)
    ship = round(float(shipping or 0), 2)
    tax_v = round(float(tax or 0) + line_tax_total, 2)
    total = round(subtotal - disc_amt + ship + tax_v, 2)
    return round(subtotal, 2), disc_amt, ship, tax_v, total


# ----------------------- Tax library (per company) -----------------------

@router.get("/companies/{cid}/taxes")
async def list_taxes(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.taxes.find({"company_id": cid}).sort("name", 1).to_list(500)
    return {"taxes": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/taxes")
async def create_tax(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    try:
        rate = float(payload.get("rate", 0) or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Tax rate must be a number")
    if not name:
        raise HTTPException(status_code=400, detail="Tax name is required")
    if rate < 0 or rate > 100:
        raise HTTPException(status_code=400, detail="Tax rate must be between 0 and 100")
    dup = await db.taxes.find_one({"company_id": cid, "name": name})
    if dup:
        raise HTTPException(status_code=409, detail=f"A tax named '{name}' already exists")
    tid = str(uuid.uuid4()); now = now_iso()
    doc = {"id": tid, "company_id": cid, "name": name, "rate": rate,
           "created_at": now, "updated_at": now}
    await db.taxes.insert_one(doc)
    return {"tax": coerce(doc)}


@router.get("/companies/{cid}/invoices")
async def list_invoices(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.invoices.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    return {"invoices": [coerce(d) for d in docs]}


@router.get("/companies/{cid}/invoices/{iid}")
async def get_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    inv = await db.invoices.find_one({"id": iid, "company_id": cid})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return {"invoice": coerce(inv)}


@router.post("/companies/{cid}/invoices")
async def create_invoice(cid: str, inp: InvoiceCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    iid = str(uuid.uuid4()); now = now_iso()
    subtotal, disc_amt, ship, tax_v, total = _sum_lines(
        inp.line_items, inp.tax, inp.shipping, inp.discount, inp.discount_type or "amount",
    )
    doc = {
        "id": iid, "company_id": cid,
        "number": inp.number or f"INV-{random.randint(1000, 9999)}",
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
    await db.invoices.insert_one(doc)
    return {"id": iid, "invoice": coerce(doc)}


@router.patch("/companies/{cid}/invoices/{iid}")
async def update_invoice(cid: str, iid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Any change to totals-affecting fields triggers a full recompute so
    # subtotal / total / balance_due stay consistent with the persisted
    # line items and the (possibly changed) discount / shipping / tax.
    existing = None
    totals_fields = {"line_items", "tax", "shipping", "discount", "discount_type"}
    if totals_fields & set(payload.keys()):
        existing = await db.invoices.find_one({"id": iid, "company_id": cid})
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
    # Soft duplicate-number warning — the CPA may knowingly reuse a
    # number when re-issuing a corrected invoice, so we WARN rather
    # than 409-block. Frontend surfaces the warning via toast.
    number_conflict = False
    if payload.get("number"):
        dup = await db.invoices.find_one(
            {"company_id": cid, "number": payload["number"], "id": {"$ne": iid}},
            {"_id": 0, "id": 1},
        )
        if dup:
            number_conflict = True
    payload["updated_at"] = now_iso()
    await db.invoices.update_one({"id": iid, "company_id": cid}, {"$set": payload})
    return {"ok": True, "number_conflict": number_conflict}


@router.delete("/companies/{cid}/invoices/{iid}")
async def delete_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    from link_cascade import cascade_on_doc_delete
    cascade = await cascade_on_doc_delete(cid, "invoice", iid)
    await db.invoices.delete_one({"id": iid, "company_id": cid})
    return {"ok": True, **cascade}




@router.get("/companies/{cid}/invoices/{iid}/pdf")
async def invoice_pdf(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    inv = await db.invoices.find_one({"id": iid, "company_id": cid})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    company = await db.companies.find_one({"id": cid})
    payments = await db.payments.find({"company_id": cid, "linked_invoice_id": iid}).to_list(200)
    from document_pdfs import build_document_pdf
    pdf = build_document_pdf(kind="invoice", doc=inv, company=company, payments=payments)
    filename = f"invoice-{inv.get('number','')}.pdf".replace(" ", "_")
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )



def _invoice_email_html(company: dict, inv: dict) -> str:
    firm = (company or {}).get("name") or "Your Company"
    number = inv.get("number") or ""
    total = float(inv.get("total") or 0)
    balance = float(inv.get("balance_due") or 0)
    due = inv.get("due_date") or ""
    notes = inv.get("notes") or ""
    to_name = inv.get("contact_name") or "there"
    return f"""<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0F172A;line-height:1.55;max-width:640px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 4px 0;">Invoice {number}</h2>
  <p style="color:#64748B;margin:0 0 16px 0;font-size:13px;">from {firm}</p>
  <p>Hi {to_name},</p>
  <p>Your invoice <b>{number}</b> is attached (PDF).</p>
  <table style="border-collapse:collapse;margin:16px 0;font-size:14px;">
    <tr><td style="padding:4px 12px 4px 0;color:#64748B;">Amount due</td><td style="font-variant-numeric:tabular-nums;font-weight:600;">${balance:,.2f}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#64748B;">Total</td><td style="font-variant-numeric:tabular-nums;">${total:,.2f}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#64748B;">Due</td><td style="font-variant-numeric:tabular-nums;">{due}</td></tr>
  </table>
  {"<p style='color:#334155;'>" + notes + "</p>" if notes else ""}
  <p style="color:#64748B;font-size:12px;margin-top:32px;">Thank you for your business.</p>
</body></html>"""


@router.post("/companies/{cid}/invoices/{iid}/send-email")
async def send_invoice_email(
    cid: str, iid: str,
    to: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Email the invoice PDF to the customer.

    `to` overrides the contact's email on file when supplied.
    """
    await require_company(user, cid)
    inv = await db.invoices.find_one({"id": iid, "company_id": cid})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    contact = None
    if inv.get("contact_id"):
        contact = await db.contacts.find_one({"id": inv["contact_id"], "company_id": cid})
    recipient = (to or (contact or {}).get("email") or "").strip()
    if not recipient or "@" not in recipient:
        raise HTTPException(status_code=400, detail="Customer has no email on file. Pass `to=email@…` to override.")
    company = await db.companies.find_one({"id": cid})
    payments = await db.payments.find({"company_id": cid, "linked_invoice_id": iid}).to_list(200)
    from document_pdfs import build_document_pdf
    pdf_bytes = build_document_pdf(kind="invoice", doc=inv, company=company, payments=payments)
    import base64 as _b64
    firm = (company or {}).get("name") or "Your accountant"
    number = inv.get("number") or ""
    html = _invoice_email_html(company, inv)
    subject = f"Invoice {number} from {firm}"
    from email_dispatcher import dispatch
    result = await dispatch(
        kind="customer_statement",  # reuse existing preference; invoice_email opt-out lives here too
        to=recipient,
        subject=subject,
        html=html,
        initiating_user_id=user["id"],
        company_id=cid,
        contact_id=inv.get("contact_id"),
        related={"invoice_id": iid, "invoice_number": number},
        attachments=[{
            "filename": f"invoice-{number}.pdf".replace(" ", "_"),
            "content": _b64.b64encode(pdf_bytes).decode("ascii"),
        }],
    )
    # Auto-flip a draft invoice to "sent" once we actually email it — CPA
    # workflow assumption. Don't clobber already-sent/partial/paid.
    if result.get("status") == "sent" and (inv.get("status") == "draft"):
        await db.invoices.update_one({"id": iid, "company_id": cid},
                                     {"$set": {"status": "sent", "updated_at": now_iso()}})
    return {
        "status": result.get("status"),
        "to": recipient,
        "email_log_id": result.get("id"),
    }
