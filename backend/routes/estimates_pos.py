"""Axiom Ledger — Estimates + Purchase Orders (Phase 3).

Both are pre-transactional documents: an Estimate is what you
send a customer BEFORE they agree to buy; a Purchase Order is
what you send a vendor BEFORE you receive their bill. Because
neither posts to the GL, they're a much smaller surface than
Invoices/Bills — no inventory hooks, no COGS JE, no balance
tracking. Convert-to-Invoice / Convert-to-Bill is where the
real magic happens.

Mirror integration is wired here (autopush on save/delete) so
new Estimates/POs land in QBO immediately.
"""
from __future__ import annotations
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from deps import require_company
from models import EstimateCreate, PurchaseOrderCreate
from qbo_mirror.autopush import (
    try_auto_push, try_auto_update, try_auto_delete, try_auto_convert,
)


router = APIRouter(prefix="/api")


def _coerce(d: dict | None) -> dict | None:
    if not d:
        return d
    d.pop("_id", None)
    return d


def _sum_lines(line_items: list, tax: float = 0,
                shipping: float = 0, discount: float = 0,
                discount_type: str = "amount") -> dict:
    """Compute subtotal / total from lines. Same rules as invoices."""
    subtotal = 0.0
    for li in line_items or []:
        amt = li.get("amount")
        if amt is None:
            qty = float(li.get("quantity") or 1) or 1
            rate = float(li.get("rate") or 0)
            amt = qty * rate
        subtotal += float(amt or 0)
    subtotal = round(subtotal, 2)
    disc_amt = float(discount or 0)
    if discount_type == "percent":
        disc_amt = round(subtotal * (float(discount or 0) / 100.0), 2)
    total = round(subtotal - disc_amt + float(tax or 0)
                  + float(shipping or 0), 2)
    return {"subtotal": subtotal, "total": total,
             "discount_amount": disc_amt}


# ─── ESTIMATES ─────────────────────────────────────────────────────

@router.get("/companies/{cid}/estimates")
async def list_estimates(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rows = []
    async for e in db.estimates.find({"company_id": cid}).sort("issue_date", -1):
        rows.append(_coerce(e))
    return {"estimates": rows}


@router.get("/companies/{cid}/estimates/{eid}")
async def get_estimate(cid: str, eid: str,
                         user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await db.estimates.find_one({"id": eid, "company_id": cid})
    if not doc:
        raise HTTPException(status_code=404, detail="Estimate not found")
    return {"estimate": _coerce(doc)}


@router.post("/companies/{cid}/estimates")
async def create_estimate(cid: str, inp: EstimateCreate,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    eid = str(uuid.uuid4())
    totals = _sum_lines(inp.line_items, inp.tax, inp.shipping,
                          inp.discount, inp.discount_type or "amount")
    doc = {
        "id": eid, "company_id": cid,
        **inp.model_dump(),
        **totals,
        "created_by": user["id"],
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.estimates.insert_one(doc)
    try_auto_push(cid, "estimate", eid)
    return {"id": eid, "estimate": _coerce(doc)}


@router.patch("/companies/{cid}/estimates/{eid}")
async def update_estimate(cid: str, eid: str, payload: dict,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    if "line_items" in payload:
        totals = _sum_lines(
            payload.get("line_items") or [],
            payload.get("tax", 0),
            payload.get("shipping", 0),
            payload.get("discount", 0),
            payload.get("discount_type") or "amount",
        )
        payload.update(totals)
    payload["updated_at"] = now_iso()
    payload["_sync_origin"] = "user_edit"
    await db.estimates.update_one({"id": eid, "company_id": cid},
                                   {"$set": payload})
    try_auto_update(cid, "estimate", eid)
    return {"ok": True}


@router.delete("/companies/{cid}/estimates/{eid}")
async def delete_estimate(cid: str, eid: str,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    existing = await db.estimates.find_one({"id": eid, "company_id": cid})
    qbo_id = (existing or {}).get("qbo_id")
    num = (existing or {}).get("number") or ""
    await db.estimates.delete_one({"id": eid, "company_id": cid})
    try_auto_delete(cid, "estimate", qbo_id, num)
    return {"ok": True}


class ConvertEstimatePayload(BaseModel):
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    number: Optional[str] = None


@router.post("/companies/{cid}/estimates/{eid}/convert")
async def convert_estimate_to_invoice(
    cid: str, eid: str, inp: ConvertEstimatePayload = None,
    user: dict = Depends(get_current_user),
):
    """One-click Estimate → Invoice. Copies line items + contact,
    creates a fresh Invoice, and flips the source Estimate's
    status to 'converted' with a back-reference. The new invoice
    auto-pushes to QBO via the existing invoice hooks."""
    await require_company(user, cid)
    src = await db.estimates.find_one({"id": eid, "company_id": cid})
    if not src:
        raise HTTPException(status_code=404, detail="Estimate not found")
    if src.get("status") == "converted":
        raise HTTPException(status_code=400,
                             detail="Estimate already converted")
    inp = inp or ConvertEstimatePayload()
    issue = inp.issue_date or now_iso()[:10]
    # 30-day default net if user didn't specify.
    from datetime import date, timedelta
    due = inp.due_date or (date.fromisoformat(issue)
                            + timedelta(days=30)).isoformat()
    iid = str(uuid.uuid4())
    # Build the invoice doc directly rather than round-tripping
    # through create_invoice's handler — we want to preserve line
    # amounts exactly and skip inventory hooks that don't apply to
    # a pre-transactional convert.
    line_items = src.get("line_items") or []
    totals = _sum_lines(
        line_items, src.get("tax", 0), src.get("shipping", 0),
        src.get("discount", 0), src.get("discount_type") or "amount",
    )
    invoice = {
        "id": iid, "company_id": cid,
        "number": inp.number or "",
        "contact_id": src.get("contact_id"),
        "contact_name": src.get("contact_name") or "",
        "issue_date": issue, "due_date": due,
        "line_items": line_items,
        "tax": src.get("tax", 0),
        "notes": src.get("notes", ""),
        "status": "sent",  # converted estimates go straight to sent
        "po_number": src.get("po_number") or "",
        "shipping": src.get("shipping", 0),
        "discount": src.get("discount", 0),
        "discount_type": src.get("discount_type") or "amount",
        "internal_notes": src.get("internal_notes") or "",
        "attachments": src.get("attachments") or [],
        "title": src.get("title") or "",
        "summary": src.get("summary") or "",
        **totals,
        "balance_due": totals["total"],
        "source_estimate_id": eid,
        "created_by": user["id"],
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.invoices.insert_one(invoice)
    # Flip the source estimate to converted and back-link.
    await db.estimates.update_one(
        {"id": eid, "company_id": cid},
        {"$set": {"status": "converted",
                  "converted_invoice_id": iid,
                  "updated_at": now_iso()}},
    )
    # Chained QBO push: create the invoice first (so it gets a qbo_id),
    # then update the source estimate with TxnStatus="Closed" + a
    # LinkedTxn back-reference to that invoice. This mirrors what QBO
    # does when the user converts natively — otherwise the estimate
    # stays "Pending" on the QBO side and shows up as drift.
    try_auto_convert(cid, "estimate", eid, "invoice", iid)
    return {"id": iid, "invoice": _coerce(invoice)}


# ─── PURCHASE ORDERS ───────────────────────────────────────────────

@router.get("/companies/{cid}/purchase-orders")
async def list_pos(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rows = []
    async for p in db.purchase_orders.find({"company_id": cid}).sort(
        "issue_date", -1
    ):
        rows.append(_coerce(p))
    return {"purchase_orders": rows}


@router.get("/companies/{cid}/purchase-orders/{pid}")
async def get_po(cid: str, pid: str,
                  user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await db.purchase_orders.find_one({"id": pid, "company_id": cid})
    if not doc:
        raise HTTPException(status_code=404,
                             detail="Purchase order not found")
    return {"purchase_order": _coerce(doc)}


@router.post("/companies/{cid}/purchase-orders")
async def create_po(cid: str, inp: PurchaseOrderCreate,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    pid = str(uuid.uuid4())
    totals = _sum_lines(inp.line_items, inp.tax)
    doc = {
        "id": pid, "company_id": cid,
        **inp.model_dump(),
        **totals,
        "created_by": user["id"],
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.purchase_orders.insert_one(doc)
    try_auto_push(cid, "purchase_order", pid)
    return {"id": pid, "purchase_order": _coerce(doc)}


@router.patch("/companies/{cid}/purchase-orders/{pid}")
async def update_po(cid: str, pid: str, payload: dict,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    if "line_items" in payload:
        totals = _sum_lines(
            payload.get("line_items") or [],
            payload.get("tax", 0),
        )
        payload.update(totals)
    payload["updated_at"] = now_iso()
    payload["_sync_origin"] = "user_edit"
    await db.purchase_orders.update_one(
        {"id": pid, "company_id": cid}, {"$set": payload},
    )
    try_auto_update(cid, "purchase_order", pid)
    return {"ok": True}


@router.delete("/companies/{cid}/purchase-orders/{pid}")
async def delete_po(cid: str, pid: str,
                     user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    existing = await db.purchase_orders.find_one({"id": pid, "company_id": cid})
    qbo_id = (existing or {}).get("qbo_id")
    num = (existing or {}).get("number") or ""
    await db.purchase_orders.delete_one({"id": pid, "company_id": cid})
    try_auto_delete(cid, "purchase_order", qbo_id, num)
    return {"ok": True}


class ConvertPOPayload(BaseModel):
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    number: Optional[str] = None


@router.post("/companies/{cid}/purchase-orders/{pid}/convert")
async def convert_po_to_bill(
    cid: str, pid: str, inp: ConvertPOPayload = None,
    user: dict = Depends(get_current_user),
):
    """One-click PO → Bill. Copies line items + vendor, creates
    a fresh Bill, flips the source PO to 'converted' with a
    back-reference. Bill autopush handles the QBO side."""
    await require_company(user, cid)
    src = await db.purchase_orders.find_one({"id": pid, "company_id": cid})
    if not src:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if src.get("status") == "converted":
        raise HTTPException(status_code=400,
                             detail="PO already converted")
    inp = inp or ConvertPOPayload()
    from datetime import date, timedelta
    issue = inp.issue_date or now_iso()[:10]
    due = inp.due_date or (date.fromisoformat(issue)
                            + timedelta(days=30)).isoformat()
    bid = str(uuid.uuid4())
    line_items = src.get("line_items") or []
    totals = _sum_lines(line_items, src.get("tax", 0))
    bill = {
        "id": bid, "company_id": cid,
        "number": inp.number or "",
        "contact_id": src.get("contact_id"),
        "contact_name": src.get("contact_name") or "",
        "issue_date": issue, "due_date": due,
        "line_items": line_items,
        "tax": src.get("tax", 0),
        "notes": src.get("notes", ""),
        "status": "open",
        "internal_notes": src.get("internal_notes") or "",
        "attachments": src.get("attachments") or [],
        **totals,
        "balance_due": totals["total"],
        "source_po_id": pid,
        "created_by": user["id"],
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.bills.insert_one(bill)
    await db.purchase_orders.update_one(
        {"id": pid, "company_id": cid},
        {"$set": {"status": "converted",
                  "converted_bill_id": bid,
                  "updated_at": now_iso()}},
    )
    # Chained QBO push: create the bill first (so it gets a qbo_id),
    # then update the source PO with POStatus="Closed" + a LinkedTxn
    # back-reference to that bill. Otherwise the PO stays "Open" on
    # QBO and shows up as drift.
    try_auto_convert(cid, "purchase_order", pid, "bill", bid)
    return {"id": bid, "bill": _coerce(bill)}
