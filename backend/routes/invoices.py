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
from qbo_mirror.autopush import (
    try_auto_push, try_auto_update, try_auto_delete,
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


_INV_NUM_RE = re.compile(r"^(?P<prefix>[A-Za-z_-]*?)(?P<num>\d+)$")


async def _next_invoice_number(cid: str, prefix: str = "INV-") -> str:
    """Return the next sequential invoice number for a company.

    Scans every existing invoice number in the company, extracts the
    trailing integer, and returns `{prefix}{max+1}`. If no invoices
    exist yet (or none match the numeric shape), starts at 1001 — a
    friendly opening number that also avoids the "INV-1" awkwardness
    when the user shows their first invoice to a client.

    User-typed numbers (`inp.number` non-empty) always bypass this and
    are stored as-is, so bespoke schemes like "2026-Q1-001" still work.
    """
    highest = 0
    async for inv in db.invoices.find(
        {"company_id": cid}, projection={"number": 1}
    ):
        m = _INV_NUM_RE.match(str(inv.get("number") or "").strip())
        if not m:
            continue
        try:
            n = int(m.group("num"))
        except ValueError:
            continue
        if n > highest:
            highest = n
    return f"{prefix}{max(highest + 1, 1001)}"


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


@router.patch("/companies/{cid}/taxes/{tid}")
async def update_tax(cid: str, tid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    updates: dict = {}
    if "name" in payload:
        n = (payload.get("name") or "").strip()
        if not n:
            raise HTTPException(status_code=400, detail="Tax name cannot be empty")
        dup = await db.taxes.find_one({"company_id": cid, "name": n, "id": {"$ne": tid}})
        if dup:
            raise HTTPException(status_code=409, detail=f"A tax named '{n}' already exists")
        updates["name"] = n
    if "rate" in payload:
        try:
            r = float(payload.get("rate", 0) or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Tax rate must be a number")
        if r < 0 or r > 100:
            raise HTTPException(status_code=400, detail="Tax rate must be between 0 and 100")
        updates["rate"] = r
    if not updates:
        return {"ok": True}
    updates["updated_at"] = now_iso()
    await db.taxes.update_one({"id": tid, "company_id": cid}, {"$set": updates})
    # Cascade the display fields into any invoice/bill lines that
    # reference this tax so historical documents keep the fresh name/rate.
    # (Only the DISPLAY name updates; existing tax_amount on saved lines
    # stays untouched — those are locked historicals.)
    if "name" in updates or "rate" in updates:
        set_fields = {}
        if "name" in updates:
            set_fields["line_items.$[el].tax_name"] = updates["name"]
        if "rate" in updates:
            set_fields["line_items.$[el].tax_rate"] = updates["rate"]
        for coll in ("invoices", "bills"):
            await db[coll].update_many(
                {"company_id": cid, "line_items.tax_id": tid},
                {"$set": set_fields},
                array_filters=[{"el.tax_id": tid}],
            )
    return {"ok": True}


@router.delete("/companies/{cid}/taxes/{tid}")
async def delete_tax(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Refuse to delete a tax that's still referenced. This forces the pro
    # to consciously replace it on any active document rather than
    # silently orphaning line items.
    for coll in ("invoices", "bills"):
        stuck = await db[coll].find_one({"company_id": cid, "line_items.tax_id": tid})
        if stuck:
            raise HTTPException(
                status_code=409,
                detail=f"This tax is still applied to at least one {coll[:-1]}. Remove it there first.",
            )
    await db.taxes.delete_one({"id": tid, "company_id": cid})
    return {"ok": True}


@router.get("/companies/{cid}/invoices")
async def list_invoices(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.invoices.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    # Batched self-heal: compute Σ(linked payments) per invoice in one
    # aggregate call and fix any row whose persisted balance/status
    # drifts. Guards against legacy payment-delete calls that skipped
    # the reversal (see routes/payments.py::delete_payment).
    paid_by_inv: dict[str, float] = {}
    async for row in db.payments.aggregate([
        {"$match": {"company_id": cid, "linked_invoice_id": {"$ne": None}}},
        {"$group": {"_id": "$linked_invoice_id", "paid": {"$sum": "$amount"}}},
    ]):
        paid_by_inv[row["_id"]] = float(row["paid"] or 0)
    heal_updates = []
    for d in docs:
        total = float(d.get("total") or 0)
        paid = paid_by_inv.get(d["id"], 0.0)
        expected_bal = round(max(total - paid, 0.0), 2)
        persisted_bal = float(d.get("balance_due") or 0)
        if abs(expected_bal - persisted_bal) > 0.01:
            st = ("paid" if expected_bal <= 0.01
                  else "partial" if paid > 0
                  else (d.get("status") or "sent"))
            d["balance_due"] = expected_bal
            d["status"] = st
            heal_updates.append((d["id"], expected_bal, st))
    if heal_updates:
        # Fire off the corrective writes without blocking the response.
        now = now_iso()
        for iid, bal, st in heal_updates:
            await db.invoices.update_one(
                {"id": iid, "company_id": cid},
                {"$set": {"balance_due": bal, "status": st, "updated_at": now}},
            )
    return {"invoices": [coerce(d) for d in docs]}


@router.get("/companies/{cid}/invoices/{iid}")
async def get_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    inv = await db.invoices.find_one({"id": iid, "company_id": cid})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    # Self-heal: if the persisted balance_due drifts from the actual
    # Σ(linked_payments) — e.g. because a legacy DELETE /payments call
    # didn't reverse — quietly recompute + write back so the UI shows
    # the true balance. Cheap read-time consistency check.
    total = float(inv.get("total") or 0)
    paid = 0.0
    async for p in db.payments.find({"company_id": cid, "linked_invoice_id": iid}):
        paid += float(p.get("amount") or 0)
    expected_bal = round(max(total - paid, 0.0), 2)
    persisted_bal = float(inv.get("balance_due") or 0)
    if abs(expected_bal - persisted_bal) > 0.01:
        st = ("paid" if expected_bal <= 0.01
              else "partial" if paid > 0
              else (inv.get("status") or "sent"))
        await db.invoices.update_one(
            {"id": iid, "company_id": cid},
            {"$set": {"balance_due": expected_bal, "status": st, "updated_at": now_iso()}},
        )
        inv["balance_due"] = expected_bal
        inv["status"] = st
    return {"invoice": coerce(inv)}


@router.get("/companies/{cid}/invoices/{iid}/followup-history")
async def get_followup_history(cid: str, iid: str, user: dict = Depends(get_current_user)):
    """Timeline of every AI Follow-up email successfully sent for this
    invoice. Newest first so the pro can eyeball the most recent chase
    without scrolling."""
    await require_company(user, cid)
    inv = await db.invoices.find_one(
        {"id": iid, "company_id": cid},
        {"followup_history": 1, "last_followup_at": 1, "number": 1},
    )
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    history = list(inv.get("followup_history") or [])
    history.sort(key=lambda e: str(e.get("sent_at") or ""), reverse=True)
    return {
        "invoice_id": iid,
        "invoice_number": inv.get("number"),
        "last_followup_at": inv.get("last_followup_at"),
        "count": len(history),
        "history": history,
    }



@router.post("/companies/{cid}/invoices")
async def create_invoice(cid: str, inp: InvoiceCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    iid = str(uuid.uuid4()); now = now_iso()
    subtotal, disc_amt, ship, tax_v, total = _sum_lines(
        inp.line_items, inp.tax, inp.shipping, inp.discount, inp.discount_type or "amount",
    )
    doc = {
        "id": iid, "company_id": cid,
        "number": inp.number or await _next_invoice_number(cid),
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
    # Inventory hooks — decrement QOH & post COGS JE for tracked lines.
    warnings: list[str] = []
    try:
        from inventory_service import apply_invoice_inventory
        hooks, warnings = await apply_invoice_inventory(cid, doc)
        if hooks:
            # Persist any back-stamped item_ids alongside the hooks.
            await db.invoices.update_one({"id": iid, "company_id": cid},
                                         {"$set": {"inventory_hooks": hooks,
                                                   "line_items": doc.get("line_items") or [],
                                                   "updated_at": now_iso()}})
            doc["inventory_hooks"] = hooks
    except Exception as e:
        await db.invoices.update_one({"id": iid, "company_id": cid},
                                     {"$set": {"inventory_error": str(e)}})

    # Post the accrual JE (DR A/R / CR Income) so the ledger balances.
    # See `posting_service.post_invoice_je` for full rationale — this
    # closes the day-one bug where non-QBO companies got invoices
    # that never landed on the balance sheet. Idempotent + safe on
    # drafts (helper no-ops on empty/zero-total docs). Feb 28 2026.
    try:
        from posting_service import post_invoice_je
        await post_invoice_je(cid, doc)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning(
            "invoice JE post failed for %s: %s", iid, e)

    # Fire-and-forget mirror push. Silent no-op if QBO Mirror is
    # disabled or the invoice is a draft; the autopush guard filters
    # on doc.status internally.
    try_auto_push(cid, "invoice", iid)
    # Audit — invoice creation.
    try:
        import audit as _audit
        _audit.log_create(
            "invoice", iid, coerce(doc),
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            summary=f"Invoice {doc.get('number') or ''} · {doc.get('contact_name') or ''} · ${total:,.2f}".strip(),
        )
    except Exception:  # noqa: BLE001
        pass
    return {"id": iid, "invoice": coerce(doc), "inventory_warnings": warnings}


@router.patch("/companies/{cid}/invoices/{iid}")
async def update_invoice(cid: str, iid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Snapshot the BEFORE doc for the audit trail. Fetched up front so
    # the totals-recompute branch below reuses it as `existing`.
    before_doc = await db.invoices.find_one({"id": iid, "company_id": cid})
    # Any change to totals-affecting fields triggers a full recompute so
    # subtotal / total / balance_due stay consistent with the persisted
    # line items and the (possibly changed) discount / shipping / tax.
    existing = before_doc
    totals_fields = {"line_items", "tax", "shipping", "discount", "discount_type"}
    if totals_fields & set(payload.keys()):
        if existing:
            lines = payload.get("line_items", existing.get("line_items") or [])
            # `existing.tax` on disk is the ROLLED-UP figure (doc-level
            # input + Σ line tax). If the caller didn't override `tax`,
            # we must peel the previously-rolled-up per-line tax back
            # off before feeding _sum_lines — otherwise line-tax gets
            # counted twice.
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
    # A user PATCH is an authoritative local edit — clear any stale
    # `_sync_origin: mirror_pull` from the last pull so autopush
    # correctly propagates this change back to QBO on our next hop.
    payload["_sync_origin"] = "user_edit"
    await db.invoices.update_one({"id": iid, "company_id": cid}, {"$set": payload})
    # Re-run inventory hooks so QOH & COGS JE mirror the latest lines.
    warnings: list[str] = []
    try:
        from inventory_service import apply_invoice_inventory
        fresh = await db.invoices.find_one({"id": iid, "company_id": cid})
        if fresh:
            hooks, warnings = await apply_invoice_inventory(cid, fresh)
            await db.invoices.update_one({"id": iid, "company_id": cid},
                                         {"$set": {"inventory_hooks": hooks,
                                                   "line_items": fresh.get("line_items") or [],
                                                   "updated_at": now_iso()}})
    except Exception as e:
        await db.invoices.update_one({"id": iid, "company_id": cid},
                                     {"$set": {"inventory_error": str(e)}})
    # Fire-and-forget mirror update (doc-level fields only; line drift
    # is skipped in Phase 2c — see autopush._run_auto_update).
    try_auto_update(cid, "invoice", iid)
    # If totals-affecting fields changed, reverse the auto-posted JE
    # and re-post it so the ledger reflects the new numbers. No-op if
    # the invoice never posted (e.g. it was a QBO-mirrored doc that
    # relies on GL rather than the local JE path). Feb 28 2026.
    if totals_fields & set(payload.keys()):
        try:
            from posting_service import (
                reverse_document_je, post_invoice_je,
            )
            await reverse_document_je(cid, "invoice", iid)
            fresh_inv = await db.invoices.find_one({"id": iid, "company_id": cid})
            if fresh_inv:
                await post_invoice_je(cid, fresh_inv)
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger(__name__).warning(
                "invoice JE repost failed for %s: %s", iid, e)
    # Audit — capture before/after diff.
    try:
        import audit as _audit
        after_doc = await db.invoices.find_one({"id": iid, "company_id": cid})
        _audit.log_update(
            "invoice", iid, coerce(before_doc) if before_doc else {}, coerce(after_doc) if after_doc else {},
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            summary=f"Invoice {(after_doc or {}).get('number') or ''} updated ({', '.join(sorted(payload.keys()))[:120]})",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "number_conflict": number_conflict, "inventory_warnings": warnings}


@router.delete("/companies/{cid}/invoices/{iid}")
async def delete_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    from link_cascade import cascade_on_doc_delete
    # Restore QOH & remove COGS JEs before wiping the invoice.
    existing = await db.invoices.find_one({"id": iid, "company_id": cid})
    qbo_id = (existing or {}).get("qbo_id")
    inv_number = (existing or {}).get("number") or ""
    try:
        from inventory_service import _reverse_invoice_hooks
        if existing:
            await _reverse_invoice_hooks(cid, existing)
    except Exception:
        pass
    cascade = await cascade_on_doc_delete(cid, "invoice", iid)
    await db.invoices.delete_one({"id": iid, "company_id": cid})
    # Reverse the accrual JE that create_invoice posted (idempotent).
    try:
        from posting_service import reverse_document_je
        await reverse_document_je(cid, "invoice", iid)
    except Exception:  # noqa: BLE001
        pass
    # Mirror delete on QBO if this invoice was previously synced.
    try_auto_delete(cid, "invoice", qbo_id, inv_number)
    # Audit — delete gets a FULL snapshot per policy.
    try:
        import audit as _audit
        _audit.log_delete(
            "invoice", iid, coerce(existing) if existing else {"id": iid, "number": inv_number},
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            summary=f"Deleted invoice {inv_number}",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, **cascade}




@router.get("/companies/{cid}/invoices/{iid}/pdf")
async def invoice_pdf(cid: str, iid: str, request: Request, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    inv = await db.invoices.find_one({"id": iid, "company_id": cid})
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    company = await db.companies.find_one({"id": cid})
    payments = await db.payments.find({"company_id": cid, "linked_invoice_id": iid}).to_list(200)
    from document_pdfs import build_document_pdf
    pdf = build_document_pdf(kind="invoice", doc=inv, company=company, payments=payments)
    filename = f"invoice-{inv.get('number','')}.pdf".replace(" ", "_")
    # Audit — every invoice PDF download is a compliance-shaped event.
    try:
        import audit as _audit
        _audit.log_export(
            kind="invoice",
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid, file_format="pdf",
            entity_type="invoice", entity_id=iid, filename=filename,
            metadata={"number": inv.get("number"), "total": inv.get("total")},
            request=request,
            summary=f"Downloaded invoice {inv.get('number','')} PDF",
        )
    except Exception:  # noqa: BLE001
        pass
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



# ─────────────────────────────────────────────────────────────────────────────
# Duplicate + Bulk-Tax-Import (Feb 2026)
# ─────────────────────────────────────────────────────────────────────────────

async def _duplicate_doc(src: dict, *, kind: str) -> dict:
    """Return a fresh persist-ready doc that mirrors ``src`` line-for-line
    but with a new id, new number, today's issue date, +30 due date, and
    a reset status/balance. Used by both the invoice and bill duplicate
    endpoints so the two stay behaviourally identical.
    """
    now = now_iso()
    today = datetime.now(timezone.utc).date().isoformat()
    due = (datetime.now(timezone.utc).date() + timedelta(days=30)).isoformat()
    prefix = "INV" if kind == "invoice" else "BILL"
    # Invoices use sequential numbering — bill numbers stay random for
    # now (user only asked for invoices to be sequential).
    if kind == "invoice":
        fresh_number = await _next_invoice_number(src.get("company_id") or "", prefix=f"{prefix}-")
    else:
        fresh_number = f"{prefix}-{random.randint(1000, 9999)}"
    default_status = "draft" if kind == "invoice" else "open"
    doc = {**src}
    doc["id"] = str(uuid.uuid4())
    doc["number"] = fresh_number
    doc["issue_date"] = today
    doc["due_date"] = due
    doc["status"] = default_status
    doc["balance_due"] = float(doc.get("total") or 0)
    doc["created_at"] = now
    doc["updated_at"] = now
    # Nuke Mongo internal _id (comes back with the projection) and any
    # linked-payment scars from the original doc — a duplicate is a
    # brand-new document, no payment history.
    doc.pop("_id", None)
    return doc


@router.post("/companies/{cid}/invoices/{iid}/duplicate")
async def duplicate_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    src = await db.invoices.find_one({"id": iid, "company_id": cid})
    if not src:
        raise HTTPException(status_code=404, detail="Invoice not found")
    dup = await _duplicate_doc(src, kind="invoice")
    # A duplicate is a brand-new document — strip the source qbo_id so
    # the autopush hook treats it as fresh (else it'd short-circuit on
    # "already synced").
    dup.pop("qbo_id", None)
    dup.pop("_sync_origin", None)
    dup.pop("_sync_status", None)
    await db.invoices.insert_one(dup)
    try_auto_push(cid, "invoice", dup["id"])
    return {"id": dup["id"], "invoice": coerce(dup)}


@router.post("/companies/{cid}/bills/{bid}/duplicate")
async def duplicate_bill(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    src = await db.bills.find_one({"id": bid, "company_id": cid})
    if not src:
        raise HTTPException(status_code=404, detail="Bill not found")
    dup = await _duplicate_doc(src, kind="bill")
    # Duplicate is a brand-new document — strip source qbo_id so the
    # autopush hook treats it as fresh.
    dup.pop("qbo_id", None)
    dup.pop("_sync_origin", None)
    dup.pop("_sync_status", None)
    await db.bills.insert_one(dup)
    try_auto_push(cid, "bill", dup["id"])
    return {"id": dup["id"], "bill": coerce(dup)}


@router.post("/companies/{cid}/bills/{bid}/send-email")
async def send_bill_email(
    cid: str, bid: str,
    to: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Email the bill PDF to the vendor.

    Pros use this to forward a copy of the recorded bill back to the
    vendor (e.g. "here's what I have on file — please confirm").
    """
    await require_company(user, cid)
    b = await db.bills.find_one({"id": bid, "company_id": cid})
    if not b:
        raise HTTPException(status_code=404, detail="Bill not found")
    contact = None
    if b.get("contact_id"):
        contact = await db.contacts.find_one({"id": b["contact_id"], "company_id": cid})
    recipient = (to or (contact or {}).get("email") or "").strip()
    if not recipient or "@" not in recipient:
        raise HTTPException(
            status_code=400,
            detail="Vendor has no email on file. Pass `to=email@…` to override.",
        )
    company = await db.companies.find_one({"id": cid})
    payments = await db.payments.find({"company_id": cid, "linked_bill_id": bid}).to_list(200)
    from document_pdfs import build_document_pdf
    pdf_bytes = build_document_pdf(kind="bill", doc=b, company=company, payments=payments)
    import base64 as _b64
    firm = (company or {}).get("name") or "Your accountant"
    number = b.get("number") or ""
    total = float(b.get("total") or 0)
    balance = float(b.get("balance_due") or 0)
    due = b.get("due_date") or ""
    to_name = b.get("contact_name") or "there"
    notes = b.get("notes") or ""
    html = f"""<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0F172A;line-height:1.55;max-width:640px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 4px 0;">Bill {number}</h2>
  <p style="color:#64748B;margin:0 0 16px 0;font-size:13px;">Recorded by {firm}</p>
  <p>Hi {to_name},</p>
  <p>We've recorded the attached bill <b>{number}</b> against your account. If anything looks off, please reply so we can update our records.</p>
  <table style="border-collapse:collapse;margin:16px 0;font-size:14px;">
    <tr><td style="padding:4px 12px 4px 0;color:#64748B;">Amount due</td><td style="font-variant-numeric:tabular-nums;font-weight:600;">${balance:,.2f}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#64748B;">Total</td><td style="font-variant-numeric:tabular-nums;">${total:,.2f}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#64748B;">Due</td><td style="font-variant-numeric:tabular-nums;">{due}</td></tr>
  </table>
  {"<p style='color:#334155;'>" + notes + "</p>" if notes else ""}
</body></html>"""
    subject = f"Bill {number} on file with {firm}"
    from email_dispatcher import dispatch
    result = await dispatch(
        kind="customer_statement",  # reuses the "transactional" preference bucket
        to=recipient,
        subject=subject,
        html=html,
        initiating_user_id=user["id"],
        company_id=cid,
        contact_id=b.get("contact_id"),
        related={"bill_id": bid, "bill_number": number},
        attachments=[{
            "filename": f"bill-{number}.pdf".replace(" ", "_"),
            "content": _b64.b64encode(pdf_bytes).decode("ascii"),
        }],
    )
    return {
        "status": result.get("status"),
        "to": recipient,
        "email_log_id": result.get("id"),
    }


@router.post("/companies/{cid}/taxes/bulk-import")
async def bulk_import_taxes(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Paste-a-CSV bulk import for Tax Library.

    Accepts ``payload = {"rows": [{"name": "...", "rate": 0.0}, ...]}``
    (typed schema — CSV parsing happens on the frontend so we don't
    have to guess encodings / delimiters here).

    Behaviour per row:
      • create new row when the name is unique
      • update the rate when the name already exists (idempotent
        re-import)
      • skip rows with a blank name or an out-of-range rate; report
        them in the response so the pro can fix and re-paste.
    """
    rows = payload.get("rows") or []
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail="`rows` must be a list")
    created = 0
    updated = 0
    skipped: list[dict] = []
    now = now_iso()
    for idx, r in enumerate(rows):
        name = str((r or {}).get("name") or "").strip()
        raw_rate = (r or {}).get("rate")
        try:
            rate = float(raw_rate)
        except (TypeError, ValueError):
            skipped.append({"row": idx + 1, "name": name, "reason": "rate is not a number"})
            continue
        if not name:
            skipped.append({"row": idx + 1, "name": name, "reason": "name is empty"})
            continue
        if rate < 0 or rate > 100:
            skipped.append({"row": idx + 1, "name": name, "reason": "rate must be between 0 and 100"})
            continue
        existing = await db.taxes.find_one({"company_id": cid, "name": name})
        if existing:
            if float(existing.get("rate", 0)) != rate:
                await db.taxes.update_one(
                    {"id": existing["id"], "company_id": cid},
                    {"$set": {"rate": rate, "updated_at": now}},
                )
                updated += 1
            # else: identical row, nothing to do (silently idempotent).
        else:
            await db.taxes.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "name": name, "rate": rate,
                "created_at": now, "updated_at": now,
            })
            created += 1
    return {"created": created, "updated": updated, "skipped": skipped, "total_rows": len(rows)}


# ─────────────────────────────────────────────────────────────────────────────
# AI Follow-up — draft chase emails per overdue customer, then Send-All
# ─────────────────────────────────────────────────────────────────────────────

async def _drafts_for_overdue(cid: str) -> list[dict]:
    """Group every overdue invoice by customer and generate one chase
    draft per customer. Returns a list of `{customer_id, customer_name,
    to_email, invoice_ids, invoice_numbers, total_due, oldest_days,
    subject, body}`.
    """
    from llm_client import LlmChat, UserMessage, TextDelta, StreamDone
    today = datetime.now(timezone.utc).date()
    company = await db.companies.find_one({"id": cid}) or {}
    firm = company.get("name") or "your accountant"
    docs = await db.invoices.find({"company_id": cid}).to_list(2000)
    # Overdue = balance_due > 0 AND due_date < today
    overdue = []
    for d in docs:
        bal = float(d.get("balance_due") or 0)
        if bal <= 0.005:
            continue
        due = d.get("due_date") or ""
        try:
            due_d = datetime.strptime(due, "%Y-%m-%d").date()
        except Exception:
            continue
        if due_d >= today:
            continue
        days = (today - due_d).days
        overdue.append({**d, "_days_overdue": days})
    if not overdue:
        return []
    # Group by contact_id (falls back to contact_name).
    groups: dict[str, dict] = {}
    for inv in overdue:
        key = inv.get("contact_id") or f"name::{inv.get('contact_name') or 'Unknown'}"
        g = groups.setdefault(key, {
            "customer_id": inv.get("contact_id"),
            "customer_name": inv.get("contact_name") or "Customer",
            "invoice_ids": [], "invoice_numbers": [],
            "total_due": 0.0, "oldest_days": 0, "lines": [],
            "last_followup_at": None,
        })
        g["invoice_ids"].append(inv["id"])
        g["invoice_numbers"].append(inv.get("number") or "")
        g["total_due"] += float(inv.get("balance_due") or 0)
        g["oldest_days"] = max(g["oldest_days"], inv["_days_overdue"])
        g["lines"].append(f"- Invoice {inv.get('number','?')}: ${float(inv.get('balance_due') or 0):.2f} · due {inv.get('due_date')} ({inv['_days_overdue']} days late)")
        # Track most-recent follow-up across every invoice in the group.
        lf = inv.get("last_followup_at")
        if lf and (not g["last_followup_at"] or str(lf) > str(g["last_followup_at"])):
            g["last_followup_at"] = lf

    # Compute recency flag: was any invoice in this group chased in the last 7 days?
    seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)
    for g in groups.values():
        lf = g.get("last_followup_at")
        days = None
        recent = False
        if lf:
            try:
                # Stored as ISO string; parse tolerantly.
                lf_dt = datetime.fromisoformat(str(lf).replace("Z", "+00:00"))
                if lf_dt.tzinfo is None:
                    lf_dt = lf_dt.replace(tzinfo=timezone.utc)
                delta = datetime.now(timezone.utc) - lf_dt
                days = max(0, int(delta.total_seconds() // 86400))
                recent = lf_dt >= seven_days_ago
            except Exception:
                pass
        g["followup_days_ago"] = days
        g["recently_followed_up"] = recent

    # Fill emails.
    for g in groups.values():
        email = ""
        if g.get("customer_id"):
            c = await db.contacts.find_one({"id": g["customer_id"], "company_id": cid})
            email = (c or {}).get("email") or ""
        g["to_email"] = email

    drafts: list[dict] = []
    for g in groups.values():
        summary = "\n".join(g["lines"])
        prompt = (
            f"Write a short, polite follow-up email to a customer who has overdue invoices.\n"
            f"Customer: {g['customer_name']}\n"
            f"Total past due: ${g['total_due']:.2f}\n"
            f"Oldest invoice is {g['oldest_days']} days late.\n"
            f"Invoices:\n{summary}\n\n"
            f"Sender: {firm}\n\n"
            f"Tone: friendly-but-firm, respectful, direct. 3-5 short paragraphs. "
            f"Include a clear ask to pay or reply with a payment ETA. "
            f"Return ONLY the email body — NO subject line, NO greeting like 'Subject:'. "
            f"Sign off with the sender name."
        )
        body_text = ""
        try:
            chat = LlmChat(session_id=f"followup-{cid}-{g.get('customer_id') or 'anon'}",
                           system_message="You draft short, professional accounts-receivable follow-up emails.",
                           feature="ai-followup",
                           company_id=cid)
            async for ev in chat.stream_message(UserMessage(text=prompt)):
                if isinstance(ev, TextDelta):
                    body_text += ev.content
                elif isinstance(ev, StreamDone):
                    break
        except Exception as e:
            # Fallback to a deterministic template so the modal always
            # has *something* to preview even if the LLM is offline.
            body_text = (
                f"Hi {g['customer_name']},\n\n"
                f"Just checking in on {len(g['invoice_ids'])} invoice(s) totaling "
                f"${g['total_due']:.2f} that are now past due. "
                f"Could you let us know when we can expect payment or reply if there's an issue?\n\n"
                f"{summary}\n\n"
                f"Thanks,\n{firm}"
            )
        drafts.append({
            **g,
            "subject": f"Friendly reminder — invoice{'s' if len(g['invoice_ids']) > 1 else ''} past due",
            "body": body_text.strip(),
        })
    return drafts


@router.post("/companies/{cid}/invoices/ai-followup/drafts")
async def ai_followup_drafts(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    drafts = await _drafts_for_overdue(cid)
    return {"drafts": drafts}


@router.post("/companies/{cid}/invoices/ai-followup/send-all")
async def ai_followup_send_all(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Dispatch a batch of edited drafts. Body: `{drafts: [{to_email,
    subject, body, customer_id, invoice_ids}]}`. Skips rows without a
    to_email and reports them in the response.
    """
    await require_company(user, cid)
    drafts = (payload or {}).get("drafts") or []
    if not isinstance(drafts, list):
        raise HTTPException(status_code=400, detail="drafts must be a list")
    from email_dispatcher import dispatch
    sent = 0
    failed = 0
    skipped: list[dict] = []
    for d in drafts:
        to = (d.get("to_email") or "").strip()
        if not to or "@" not in to:
            skipped.append({"customer_name": d.get("customer_name"), "reason": "no email on file"})
            continue
        subj = d.get("subject") or "Invoice follow-up"
        body_text = d.get("body") or ""
        # Simple <br/> wrap for HTML rendering.
        html = "<div style='font-family:system-ui,sans-serif;color:#0F172A;white-space:pre-wrap;'>" + body_text.replace("<", "&lt;").replace(">", "&gt;") + "</div>"
        try:
            resp = await dispatch(
                kind="customer_statement",
                to=to,
                subject=subj,
                html=html,
                text=body_text,
                initiating_user_id=user["id"],
                company_id=cid,
                contact_id=d.get("customer_id"),
                related={"invoice_ids": d.get("invoice_ids") or []},
            )
            if resp.get("status") == "sent":
                sent += 1
                # Stamp every invoice we chased with the send time so the
                # modal can warn on repeat clicks within 7 days, and
                # append a history entry so pros can prove the chase.
                inv_ids = d.get("invoice_ids") or []
                if inv_ids:
                    stamp = datetime.now(timezone.utc).isoformat()
                    entry = {
                        "id": uuid.uuid4().hex,
                        "sent_at": stamp,
                        "to_email": to,
                        "subject": subj,
                        "body": body_text,
                        "sent_by_user_id": user.get("id"),
                        "sent_by_user_name": user.get("name") or user.get("email") or "",
                        "channel": "email",
                    }
                    await db.invoices.update_many(
                        {"company_id": cid, "id": {"$in": inv_ids}},
                        {
                            "$set": {"last_followup_at": stamp},
                            "$push": {"followup_history": entry},
                        },
                    )
            else:
                failed += 1
        except Exception:
            failed += 1
    return {"sent": sent, "failed": failed, "skipped": skipped, "total": len(drafts)}

