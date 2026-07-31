"""Axiom Ledger — Items catalog (Products / Services).

A per-company items catalog. Each item can be a service or a product,
optionally linked to an income account (so invoices posted from this
item hit the right P&L line). Prices are the default rate — users can
still override at line-item time.
"""
from __future__ import annotations
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import db, now_iso, coerce
from auth import get_current_user
from deps import require_company

router = APIRouter(prefix="/api")


class ItemIn(BaseModel):
    name: str
    description: Optional[str] = ""
    type: str = "service"  # service | product
    income_account_id: Optional[str] = None
    income_account_name: Optional[str] = ""
    price: float = 0.0
    active: bool = True
    sku: Optional[str] = None


class ItemPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    income_account_id: Optional[str] = None
    income_account_name: Optional[str] = None
    price: Optional[float] = None
    active: Optional[bool] = None
    sku: Optional[str] = None


@router.get("/companies/{cid}/items")
async def list_items(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.items.find({"company_id": cid}).sort("name", 1).to_list(2000)
    return {"items": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/items")
async def create_item(cid: str, inp: ItemIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    nm = (inp.name or "").strip()
    if not nm:
        raise HTTPException(status_code=400, detail="Item name is required.")
    # Warn (409) on exact-name duplicate to keep the catalog clean.
    dup = await db.items.find_one({"company_id": cid, "name": nm})
    if dup:
        raise HTTPException(status_code=409, detail=f"An item named '{nm}' already exists.")
    # Backfill income_account_name from CoA if only id supplied.
    inc_name = inp.income_account_name or ""
    if inp.income_account_id and not inc_name:
        acc = await db.accounts.find_one({"company_id": cid, "id": inp.income_account_id})
        if acc:
            inc_name = acc.get("name") or ""
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": nm,
        "description": inp.description or "",
        "type": inp.type or "service",
        "income_account_id": inp.income_account_id,
        "income_account_name": inc_name,
        "price": float(inp.price or 0),
        "active": bool(inp.active),
        "sku": inp.sku,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.items.insert_one(doc)
    return {"item": coerce(doc)}


@router.patch("/companies/{cid}/items/{iid}")
async def update_item(cid: str, iid: str, patch: ItemPatch, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    upd = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not upd:
        return {"ok": True}
    if "name" in upd:
        upd["name"] = (upd["name"] or "").strip()
        if not upd["name"]:
            raise HTTPException(status_code=400, detail="Item name is required.")
        dup = await db.items.find_one({"company_id": cid, "name": upd["name"], "id": {"$ne": iid}})
        if dup:
            raise HTTPException(status_code=409, detail=f"An item named '{upd['name']}' already exists.")
    if "income_account_id" in upd and "income_account_name" not in upd:
        acc = await db.accounts.find_one({"company_id": cid, "id": upd["income_account_id"]})
        if acc:
            upd["income_account_name"] = acc.get("name") or ""
    upd["updated_at"] = now_iso()
    await db.items.update_one({"id": iid, "company_id": cid}, {"$set": upd})
    doc = await db.items.find_one({"id": iid, "company_id": cid})
    return {"item": coerce(doc) if doc else None}


@router.delete("/companies/{cid}/items/{iid}")
async def delete_item(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.items.delete_one({"id": iid, "company_id": cid})
    return {"ok": True}


# ---------------------- Sales Reports (by item / category) ----------------------

def _in_range(iso_date: Optional[str], start: Optional[str], end: Optional[str]) -> bool:
    if not iso_date:
        return False
    if start and iso_date < start:
        return False
    if end and iso_date > end:
        return False
    return True


@router.get("/companies/{cid}/reports/sales-by-item")
async def sales_by_item(
    cid: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Aggregate invoice line items by item_id (or by description text when
    no item is linked — bucketed under 'Uncategorized').

    Excludes `status='draft'` and `status='void'` so only real sales
    hit the report. Returns rows sorted by amount descending.
    """
    await require_company(user, cid)
    q = {"company_id": cid, "status": {"$nin": ["draft", "void"]}}
    invs = await db.invoices.find(q).to_list(10000)
    buckets: dict[str, dict] = {}
    for inv in invs:
        if not _in_range(inv.get("issue_date"), start, end):
            continue
        for li in (inv.get("line_items") or []):
            item_id = li.get("item_id") or ""
            item_name = li.get("item_name") or li.get("description") or "Uncategorized"
            key = item_id or f"desc::{item_name.lower().strip()}"
            b = buckets.setdefault(key, {
                "item_id": item_id or None,
                "item_name": item_name,
                "quantity": 0.0,
                "amount": 0.0,
                "invoice_count": 0,
                "category": li.get("category") or li.get("income_account_name") or "",
            })
            b["quantity"] += float(li.get("quantity") or 0)
            b["amount"] += float(li.get("amount") or 0)
            b["invoice_count"] += 1
    rows = sorted(buckets.values(), key=lambda r: r["amount"], reverse=True)
    total = round(sum(r["amount"] for r in rows), 2)
    for r in rows:
        r["amount"] = round(r["amount"], 2)
        r["quantity"] = round(r["quantity"], 4)
    return {"rows": rows, "total": total, "start": start, "end": end}


@router.get("/companies/{cid}/reports/sales-by-category")
async def sales_by_category(
    cid: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Aggregate invoice line items by income account (the item's linked
    account, or the free-text `category` on the line). Falls back to
    'Uncategorized' when neither is present. Same date + status filters
    as sales-by-item.
    """
    await require_company(user, cid)
    q = {"company_id": cid, "status": {"$nin": ["draft", "void"]}}
    invs = await db.invoices.find(q).to_list(10000)
    buckets: dict[str, dict] = {}
    for inv in invs:
        if not _in_range(inv.get("issue_date"), start, end):
            continue
        for li in (inv.get("line_items") or []):
            acc_id = li.get("income_account_id") or ""
            acc_name = li.get("income_account_name") or li.get("category") or "Uncategorized"
            key = acc_id or f"cat::{acc_name.lower().strip()}"
            b = buckets.setdefault(key, {
                "account_id": acc_id or None,
                "category": acc_name,
                "amount": 0.0,
                "invoice_count": 0,
                "item_count": 0,
            })
            b["amount"] += float(li.get("amount") or 0)
            b["invoice_count"] += 1
            b["item_count"] += 1
    rows = sorted(buckets.values(), key=lambda r: r["amount"], reverse=True)
    total = round(sum(r["amount"] for r in rows), 2)
    for r in rows:
        r["amount"] = round(r["amount"], 2)
    return {"rows": rows, "total": total, "start": start, "end": end}
