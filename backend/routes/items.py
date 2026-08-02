"""Axiom Ledger — Items catalog (Products / Services).

A per-company items catalog. Each item can be a service or a product,
optionally linked to an income account (so invoices posted from this
item hit the right P&L line). Prices are the default rate — users can
still override at line-item time.
"""
from __future__ import annotations
import io
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from db import db, now_iso, coerce
from auth import get_current_user
from deps import require_company

router = APIRouter(prefix="/api")


class ItemIn(BaseModel):
    name: str
    description: Optional[str] = ""
    type: str = "service"  # service | product
    # Where this item is used: "sales" (invoices only), "purchases" (bills
    # only), or "both". Filters the ItemPicker on invoice vs bill lines.
    usage: str = "sales"
    income_account_id: Optional[str] = None
    income_account_name: Optional[str] = ""
    # Optional expense-side mapping so the same item auto-fills the
    # right expense category on bill lines (purchases).
    expense_account_id: Optional[str] = None
    expense_account_name: Optional[str] = ""
    price: float = 0.0
    active: bool = True
    sku: Optional[str] = None
    # ── Inventory (weighted-average) tracking ─────────────────────────
    # When True, bills using this item DR the Inventory asset instead of
    # the item's expense account, invoices auto-post a COGS JE at the
    # current weighted-avg cost, and QOH updates atomically on save.
    track_inventory: bool = False
    quantity_on_hand: float = 0.0
    cost_basis: float = 0.0                   # weighted-average unit cost
    inventory_account_id: Optional[str] = None
    inventory_account_name: Optional[str] = ""
    cogs_account_id: Optional[str] = None
    cogs_account_name: Optional[str] = ""
    low_stock_threshold: Optional[float] = None


class ItemPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    usage: Optional[str] = None
    income_account_id: Optional[str] = None
    income_account_name: Optional[str] = None
    expense_account_id: Optional[str] = None
    expense_account_name: Optional[str] = None
    price: Optional[float] = None
    active: Optional[bool] = None
    sku: Optional[str] = None
    track_inventory: Optional[bool] = None
    quantity_on_hand: Optional[float] = None
    cost_basis: Optional[float] = None
    inventory_account_id: Optional[str] = None
    inventory_account_name: Optional[str] = None
    cogs_account_id: Optional[str] = None
    cogs_account_name: Optional[str] = None
    low_stock_threshold: Optional[float] = None


_USAGE_VALUES = ("sales", "purchases", "both")


def _infer_usage(income_id: Optional[str], expense_id: Optional[str]) -> str:
    """Infer usage when the user didn't explicitly pick one — based on
    which account slots are populated. Falls back to 'sales' to match
    the historical default (items were sales-only)."""
    has_inc = bool(income_id)
    has_exp = bool(expense_id)
    if has_inc and has_exp:
        return "both"
    if has_exp and not has_inc:
        return "purchases"
    return "sales"


@router.get("/companies/{cid}/items")
async def list_items(cid: str, usage: Optional[str] = None, user: dict = Depends(get_current_user)):
    """List items. Optional `usage=sales|purchases|both` filter — when
    provided, returns items usable in that context (an item flagged
    'both' shows up in either filter). Legacy items without a `usage`
    field are inferred from their account slots so old data works
    without a migration.
    """
    await require_company(user, cid)
    docs = await db.items.find({"company_id": cid}).sort("name", 1).to_list(2000)
    out = []
    for d in docs:
        # Backfill inferred usage on the fly so the frontend never sees
        # a null. We don't persist the inference — the user can flip it
        # explicitly whenever they edit the item.
        if not d.get("usage"):
            d["usage"] = _infer_usage(d.get("income_account_id"), d.get("expense_account_id"))
        out.append(coerce(d))
    if usage in _USAGE_VALUES:
        out = [i for i in out if i.get("usage") == usage or i.get("usage") == "both"]
    return {"items": out}


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
    exp_name = inp.expense_account_name or ""
    if inp.expense_account_id and not exp_name:
        acc = await db.accounts.find_one({"company_id": cid, "id": inp.expense_account_id})
        if acc:
            exp_name = acc.get("name") or ""
    inv_name = inp.inventory_account_name or ""
    if inp.inventory_account_id and not inv_name:
        acc = await db.accounts.find_one({"company_id": cid, "id": inp.inventory_account_id})
        if acc:
            inv_name = acc.get("name") or ""
    cogs_name = inp.cogs_account_name or ""
    if inp.cogs_account_id and not cogs_name:
        acc = await db.accounts.find_one({"company_id": cid, "id": inp.cogs_account_id})
        if acc:
            cogs_name = acc.get("name") or ""
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": nm,
        "description": inp.description or "",
        "type": inp.type or "service",
        "usage": inp.usage if inp.usage in _USAGE_VALUES else _infer_usage(inp.income_account_id, inp.expense_account_id),
        "income_account_id": inp.income_account_id,
        "income_account_name": inc_name,
        "expense_account_id": inp.expense_account_id,
        "expense_account_name": exp_name,
        "price": float(inp.price or 0),
        "active": bool(inp.active),
        "sku": inp.sku,
        # Inventory fields — only meaningful when track_inventory=True,
        # but stored on every doc for consistent projection.
        "track_inventory": bool(inp.track_inventory),
        "quantity_on_hand": float(inp.quantity_on_hand or 0),
        "cost_basis": float(inp.cost_basis or 0),
        "inventory_account_id": inp.inventory_account_id,
        "inventory_account_name": inv_name,
        "cogs_account_id": inp.cogs_account_id,
        "cogs_account_name": cogs_name,
        "low_stock_threshold": inp.low_stock_threshold,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.items.insert_one(doc)
    # Post an opening-balance JE so the BS picks up the current stock.
    try:
        from inventory_service import sync_opening_balance
        await sync_opening_balance(cid, doc)
        # Re-read to pick up opening_je_id.
        doc = await db.items.find_one({"id": doc["id"], "company_id": cid}) or doc
    except Exception:
        pass
    return {"item": coerce(doc)}


@router.patch("/companies/{cid}/items/{iid}")
async def update_item(cid: str, iid: str, patch: ItemPatch, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    upd = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not upd:
        return {"ok": True}
    if "usage" in upd and upd["usage"] not in _USAGE_VALUES:
        raise HTTPException(status_code=400, detail=f"usage must be one of {_USAGE_VALUES}")
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
    if "expense_account_id" in upd and "expense_account_name" not in upd:
        acc = await db.accounts.find_one({"company_id": cid, "id": upd["expense_account_id"]})
        if acc:
            upd["expense_account_name"] = acc.get("name") or ""
    upd["updated_at"] = now_iso()
    await db.items.update_one({"id": iid, "company_id": cid}, {"$set": upd})
    doc = await db.items.find_one({"id": iid, "company_id": cid})
    # Re-sync opening-balance JE if any inventory-affecting field changed.
    try:
        from inventory_service import sync_opening_balance
        if doc and any(k in upd for k in
                       ("track_inventory", "quantity_on_hand", "cost_basis",
                        "inventory_account_id", "name")):
            await sync_opening_balance(cid, doc)
            doc = await db.items.find_one({"id": iid, "company_id": cid})
    except Exception:
        pass
    return {"item": coerce(doc) if doc else None}


@router.delete("/companies/{cid}/items/{iid}")
async def delete_item(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Reverse the opening-balance JE (if any) so the BS drops back to
    # zero — otherwise the credit sits orphaned in Opening Balance
    # Equity forever.
    try:
        from inventory_service import clear_opening_balance
        existing = await db.items.find_one({"id": iid, "company_id": cid})
        if existing:
            await clear_opening_balance(cid, existing)
    except Exception:
        pass
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


# ---------------------- Purchases (bills) mirror reports ----------------------

@router.get("/companies/{cid}/reports/purchases-by-item")
async def purchases_by_item(
    cid: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Aggregate bill line items by item_id (or by description text when
    no item is linked — bucketed under 'Uncategorized').

    Excludes `status='void'` and `status='draft'`. Returns rows sorted
    by amount descending.
    """
    await require_company(user, cid)
    q = {"company_id": cid, "status": {"$nin": ["void", "draft"]}}
    bills = await db.bills.find(q).to_list(10000)
    buckets: dict[str, dict] = {}
    for bill in bills:
        if not _in_range(bill.get("issue_date"), start, end):
            continue
        for li in (bill.get("line_items") or []):
            item_id = li.get("item_id") or ""
            item_name = li.get("item_name") or li.get("description") or "Uncategorized"
            key = item_id or f"desc::{item_name.lower().strip()}"
            b = buckets.setdefault(key, {
                "item_id": item_id or None,
                "item_name": item_name,
                "quantity": 0.0,
                "amount": 0.0,
                "bill_count": 0,
                "category": li.get("category") or li.get("expense_account_name") or "",
            })
            b["quantity"] += float(li.get("quantity") or 0)
            b["amount"] += float(li.get("amount") or 0)
            b["bill_count"] += 1
    rows = sorted(buckets.values(), key=lambda r: r["amount"], reverse=True)
    total = round(sum(r["amount"] for r in rows), 2)
    for r in rows:
        r["amount"] = round(r["amount"], 2)
        r["quantity"] = round(r["quantity"], 4)
    return {"rows": rows, "total": total, "start": start, "end": end}


@router.get("/companies/{cid}/reports/purchases-by-category")
async def purchases_by_category(
    cid: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Aggregate bill line items by expense account (the item's linked
    expense account, or the free-text `category` on the line). Falls
    back to 'Uncategorized' when neither is present. Same date + status
    filters as purchases-by-item.
    """
    await require_company(user, cid)
    q = {"company_id": cid, "status": {"$nin": ["void", "draft"]}}
    bills = await db.bills.find(q).to_list(10000)
    buckets: dict[str, dict] = {}
    for bill in bills:
        if not _in_range(bill.get("issue_date"), start, end):
            continue
        for li in (bill.get("line_items") or []):
            acc_id = li.get("expense_account_id") or ""
            acc_name = li.get("expense_account_name") or li.get("category") or "Uncategorized"
            key = acc_id or f"cat::{acc_name.lower().strip()}"
            b = buckets.setdefault(key, {
                "account_id": acc_id or None,
                "category": acc_name,
                "amount": 0.0,
                "bill_count": 0,
                "item_count": 0,
            })
            b["amount"] += float(li.get("amount") or 0)
            b["bill_count"] += 1
            b["item_count"] += 1
    rows = sorted(buckets.values(), key=lambda r: r["amount"], reverse=True)
    total = round(sum(r["amount"] for r in rows), 2)
    for r in rows:
        r["amount"] = round(r["amount"], 2)
    return {"rows": rows, "total": total, "start": start, "end": end}


@router.get("/companies/{cid}/reports/spend-by-vendor")
async def spend_by_vendor(
    cid: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Roll up bill totals by vendor (contact_name) over a date range.

    Uses the bill's TOTAL (not per-line amounts) since dependency risk
    lives at the bill level — a $10k bill with 12 line items still
    represents $10k of exposure to one vendor. Excludes draft/void.
    Returns rows sorted by amount desc + total + `bill_count` + a
    `paid_amount` view derived from status='paid'.
    """
    await require_company(user, cid)
    q = {"company_id": cid, "status": {"$nin": ["void", "draft"]}}
    bills = await db.bills.find(q).to_list(10000)
    buckets: dict[str, dict] = {}
    for bill in bills:
        if not _in_range(bill.get("issue_date"), start, end):
            continue
        vid = bill.get("contact_id") or bill.get("vendor_id") or ""
        vname = bill.get("contact_name") or bill.get("vendor_name") or "Uncategorized vendor"
        key = vid or f"nm::{vname.lower().strip()}"
        total_amt = float(bill.get("total") or 0)
        bal = float(bill.get("balance_due") or 0)
        b = buckets.setdefault(key, {
            "vendor_id": vid or None,
            "vendor_name": vname,
            "amount": 0.0,
            "paid_amount": 0.0,
            "outstanding": 0.0,
            "bill_count": 0,
        })
        b["amount"] += total_amt
        b["paid_amount"] += max(total_amt - bal, 0.0)
        b["outstanding"] += bal
        b["bill_count"] += 1
    rows = sorted(buckets.values(), key=lambda r: r["amount"], reverse=True)
    total = round(sum(r["amount"] for r in rows), 2)
    for r in rows:
        r["amount"] = round(r["amount"], 2)
        r["paid_amount"] = round(r["paid_amount"], 2)
        r["outstanding"] = round(r["outstanding"], 2)
    return {"rows": rows, "total": total, "start": start, "end": end}


@router.get("/companies/{cid}/reports/revenue-by-customer")
async def revenue_by_customer(
    cid: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Mirror of spend-by-vendor for the sales side — rolls up invoice
    totals by customer over a date range. Excludes draft/void.
    """
    await require_company(user, cid)
    q = {"company_id": cid, "status": {"$nin": ["void", "draft"]}}
    invs = await db.invoices.find(q).to_list(10000)
    buckets: dict[str, dict] = {}
    for inv in invs:
        if not _in_range(inv.get("issue_date"), start, end):
            continue
        cid_ref = inv.get("contact_id") or inv.get("customer_id") or ""
        cname = inv.get("contact_name") or inv.get("customer_name") or "Uncategorized customer"
        key = cid_ref or f"nm::{cname.lower().strip()}"
        total_amt = float(inv.get("total") or 0)
        bal = float(inv.get("balance_due") or 0)
        b = buckets.setdefault(key, {
            "customer_id": cid_ref or None,
            "customer_name": cname,
            "amount": 0.0,
            "paid_amount": 0.0,
            "outstanding": 0.0,
            "invoice_count": 0,
        })
        b["amount"] += total_amt
        b["paid_amount"] += max(total_amt - bal, 0.0)
        b["outstanding"] += bal
        b["invoice_count"] += 1
    rows = sorted(buckets.values(), key=lambda r: r["amount"], reverse=True)
    total = round(sum(r["amount"] for r in rows), 2)
    for r in rows:
        r["amount"] = round(r["amount"], 2)
        r["paid_amount"] = round(r["paid_amount"], 2)
        r["outstanding"] = round(r["outstanding"], 2)
    return {"rows": rows, "total": total, "start": start, "end": end}


@router.get("/companies/{cid}/reports/vendor-detail")
async def vendor_detail(
    cid: str,
    vendor_id: Optional[str] = None,
    vendor_name: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Every bill + every linked payment/transaction for one vendor in a
    period. Callers pass `vendor_id` when known, else `vendor_name` for
    the 'Uncategorized' rollup bucket.
    """
    await require_company(user, cid)
    q: dict = {"company_id": cid, "status": {"$nin": ["void", "draft"]}}
    if vendor_id:
        q["contact_id"] = vendor_id
    elif vendor_name:
        q["contact_name"] = vendor_name
    else:
        raise HTTPException(status_code=400, detail="vendor_id or vendor_name is required")
    all_bills = await db.bills.find(q).to_list(10000)
    bills = [coerce(b) for b in all_bills if _in_range(b.get("issue_date"), start, end)]
    # Any transactions linked to these bills — filter by the ids we just
    # collected, no need to scan the whole txn table.
    bill_ids = [b["id"] for b in bills]
    txns: list[dict] = []
    if bill_ids:
        raw = await db.transactions.find({"company_id": cid, "linked_bill_id": {"$in": bill_ids}}).to_list(5000)
        txns = [coerce(t) for t in raw]
    label = bills[0].get("contact_name") if bills else (vendor_name or "Vendor")
    total = round(sum(float(b.get("total") or 0) for b in bills), 2)
    paid = round(sum(float(b.get("total") or 0) - float(b.get("balance_due") or 0) for b in bills), 2)
    outstanding = round(sum(float(b.get("balance_due") or 0) for b in bills), 2)
    return {
        "vendor_id": vendor_id,
        "vendor_name": label,
        "bills": bills,
        "linked_transactions": txns,
        "totals": {"amount": total, "paid": paid, "outstanding": outstanding, "bill_count": len(bills)},
        "start": start,
        "end": end,
    }


@router.get("/companies/{cid}/reports/customer-detail")
async def customer_detail(
    cid: str,
    customer_id: Optional[str] = None,
    customer_name: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Every invoice + every linked receipt/transaction for one customer
    in a period. Mirrors vendor-detail."""
    await require_company(user, cid)
    q: dict = {"company_id": cid, "status": {"$nin": ["void", "draft"]}}
    if customer_id:
        q["contact_id"] = customer_id
    elif customer_name:
        q["contact_name"] = customer_name
    else:
        raise HTTPException(status_code=400, detail="customer_id or customer_name is required")
    all_invs = await db.invoices.find(q).to_list(10000)
    invs = [coerce(i) for i in all_invs if _in_range(i.get("issue_date"), start, end)]
    inv_ids = [i["id"] for i in invs]
    txns: list[dict] = []
    if inv_ids:
        raw = await db.transactions.find({"company_id": cid, "linked_invoice_id": {"$in": inv_ids}}).to_list(5000)
        txns = [coerce(t) for t in raw]
    label = invs[0].get("contact_name") if invs else (customer_name or "Customer")
    total = round(sum(float(i.get("total") or 0) for i in invs), 2)
    paid = round(sum(float(i.get("total") or 0) - float(i.get("balance_due") or 0) for i in invs), 2)
    outstanding = round(sum(float(i.get("balance_due") or 0) for i in invs), 2)
    return {
        "customer_id": customer_id,
        "customer_name": label,
        "invoices": invs,
        "linked_transactions": txns,
        "totals": {"amount": total, "paid": paid, "outstanding": outstanding, "invoice_count": len(invs)},
        "start": start,
        "end": end,
    }


def _statement_html(company_name: str, customer_name: str, start: str, end: str,
                    outstanding: list[dict], totals: dict) -> str:
    """Build a simple, print-friendly HTML statement email."""
    def money(v):
        try: return f"${float(v):,.2f}"
        except (TypeError, ValueError): return "$0.00"

    rows = "".join(
        f"""<tr>
             <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;">{i.get('number','')}</td>
             <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;">{i.get('issue_date','')}</td>
             <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;">{i.get('due_date','')}</td>
             <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;text-align:right;">{money(i.get('total'))}</td>
             <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;text-align:right;color:#B91C1C;font-weight:600;">{money(i.get('balance_due'))}</td>
           </tr>"""
        for i in outstanding
    ) or '<tr><td colspan="5" style="padding:12px;text-align:center;color:#64748B;">No outstanding invoices in this period.</td></tr>'

    return f"""<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0F172A;max-width:640px;margin:24px auto;padding:0 16px;">
  <h1 style="font-size:22px;margin:0 0 4px;">{company_name}</h1>
  <div style="color:#64748B;font-size:13px;margin-bottom:16px;">Account statement · {start} → {end}</div>
  <p>Hi {customer_name},</p>
  <p>Here's a summary of your outstanding invoices with us. Please let us know if you have any questions or if a payment is on the way.</p>
  <table style="border-collapse:collapse;width:100%;font-size:13px;margin:16px 0;">
    <thead>
      <tr style="background:#F8FAFC;text-align:left;">
        <th style="padding:8px;">Invoice</th>
        <th style="padding:8px;">Issued</th>
        <th style="padding:8px;">Due</th>
        <th style="padding:8px;text-align:right;">Total</th>
        <th style="padding:8px;text-align:right;">Balance</th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
    <tfoot>
      <tr style="background:#F8FAFC;">
        <td colspan="3" style="padding:10px 8px;font-weight:600;">Total outstanding</td>
        <td style="padding:10px 8px;text-align:right;">{money(totals.get('amount',0))}</td>
        <td style="padding:10px 8px;text-align:right;font-weight:700;color:#B91C1C;">{money(totals.get('outstanding',0))}</td>
      </tr>
    </tfoot>
  </table>
  <p style="color:#64748B;font-size:12px;margin-top:24px;">Thank you for your business.</p>
</body></html>"""


@router.get("/companies/{cid}/customer-statements/preview")
async def preview_customer_statement(
    cid: str,
    customer_id: str,
    kind: str = "outstanding",  # outstanding | activity
    user: dict = Depends(get_current_user),
):
    """Structured statement data for the Customer Statements page.

    `kind`:
      - outstanding: current open A/R with overdue vs not-yet-due split,
        one row per unpaid invoice.
      - activity:   full activity log (invoices + payments) with a
                    running balance — matches Wave's Account activity.
    """
    await require_company(user, cid)
    contact = await db.contacts.find_one({"id": customer_id, "company_id": cid})
    if not contact:
        raise HTTPException(status_code=404, detail="Customer not found")
    company = await db.companies.find_one({"id": cid}) or {}

    today = datetime.now(timezone.utc).date().isoformat()
    inv_query = {"company_id": cid, "contact_id": customer_id, "status": {"$nin": ["void", "draft"]}}
    all_invs = await db.invoices.find(inv_query).to_list(10000)

    def paid_amount(inv):
        return round(float(inv.get("total") or 0) - float(inv.get("balance_due") or 0), 2)

    if kind == "outstanding":
        rows = []
        overdue = 0.0
        not_yet_due = 0.0
        for i in all_invs:
            bal = float(i.get("balance_due") or 0)
            if bal <= 0.01: continue
            due = i.get("due_date") or ""
            is_overdue = bool(due and str(due) < today)
            if is_overdue: overdue += bal
            else: not_yet_due += bal
            rows.append({
                "id": i.get("id"),
                "number": i.get("number") or "",
                "invoice_date": i.get("issue_date") or "",
                "due_date": due,
                "total": round(float(i.get("total") or 0), 2),
                "paid": paid_amount(i),
                "due": round(bal, 2),
                "is_overdue": is_overdue,
            })
        rows.sort(key=lambda r: r.get("invoice_date") or "")
        return {
            "kind": "outstanding",
            "as_of": today,
            "customer": {
                "id": contact.get("id"),
                "name": contact.get("name") or "",
                "email": contact.get("email") or "",
                "address": contact.get("address") or "",
            },
            "company": {
                "name": company.get("name") or "",
                "address": company.get("address") or "",
                "country": company.get("country") or "",
                "logo_data_url": company.get("logo_data_url") or "",
            },
            "summary": {
                "overdue": round(overdue, 2),
                "not_yet_due": round(not_yet_due, 2),
                "outstanding": round(overdue + not_yet_due, 2),
            },
            "rows": rows,
        }

    # kind == "activity" — full ledger with running balance.
    payments = await db.payments.find({"company_id": cid, "contact_id": customer_id}).to_list(10000)
    events = []
    for i in all_invs:
        events.append({
            "date": i.get("issue_date") or "",
            "kind": "invoice",
            "description": f"Invoice {i.get('number') or ''}".strip(),
            "invoice_id": i.get("id"),
            "invoice_number": i.get("number") or "",
            "debit": round(float(i.get("total") or 0), 2),
            "credit": 0.0,
        })
    for p in payments:
        inv_num = ""
        if p.get("linked_invoice_id"):
            m = next((x for x in all_invs if x.get("id") == p["linked_invoice_id"]), None)
            if m: inv_num = m.get("number") or ""
        events.append({
            "date": p.get("date") or "",
            "kind": "payment",
            "description": f"Payment received — {p.get('method') or 'payment'}" + (f" · Invoice {inv_num}" if inv_num else ""),
            "invoice_id": p.get("linked_invoice_id"),
            "invoice_number": inv_num,
            "debit": 0.0,
            "credit": round(float(p.get("amount") or 0), 2),
        })
    events.sort(key=lambda e: (e.get("date") or "", 0 if e["kind"] == "invoice" else 1))
    running = 0.0
    for e in events:
        running += e["debit"] - e["credit"]
        e["balance"] = round(running, 2)

    total_invoiced = round(sum(e["debit"] for e in events), 2)
    total_paid = round(sum(e["credit"] for e in events), 2)
    return {
        "kind": "activity",
        "as_of": today,
        "customer": {
            "id": contact.get("id"),
            "name": contact.get("name") or "",
            "email": contact.get("email") or "",
            "address": contact.get("address") or "",
        },
        "company": {
            "name": company.get("name") or "",
            "address": company.get("address") or "",
            "country": company.get("country") or "",
            "logo_data_url": company.get("logo_data_url") or "",
        },
        "summary": {
            "total_invoiced": total_invoiced,
            "total_paid": total_paid,
            "balance": round(total_invoiced - total_paid, 2),
        },
        "rows": events,
    }


@router.post("/companies/{cid}/customers/{customer_id}/send-statement")
async def send_customer_statement(
    cid: str,
    customer_id: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    to: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Email the customer their outstanding-invoice statement over a period.

    `to` overrides the contact's email if provided (useful for CPAs
    testing with their own inbox). Uses the shared `dispatch` helper so
    firm branding, opt-outs, and audit logging come for free.
    """
    await require_company(user, cid)
    contact = await db.contacts.find_one({"id": customer_id, "company_id": cid})
    if not contact:
        raise HTTPException(status_code=404, detail="Customer not found")
    recipient = (to or contact.get("email") or "").strip()
    if not recipient or "@" not in recipient:
        raise HTTPException(status_code=400, detail="Customer has no email on file. Pass `to=email@…` to override.")

    # Pull only OUTSTANDING invoices (balance > 0) — draft/void already
    # filtered — in the period.
    q = {"company_id": cid, "contact_id": customer_id, "status": {"$nin": ["void", "draft"]}}
    all_invs = await db.invoices.find(q).to_list(10000)
    invs = [i for i in all_invs
            if _in_range(i.get("issue_date"), start, end)
            and float(i.get("balance_due") or 0) > 0.01]
    invs.sort(key=lambda i: i.get("issue_date") or "")
    total_amt = round(sum(float(i.get("total") or 0) for i in invs), 2)
    outstanding = round(sum(float(i.get("balance_due") or 0) for i in invs), 2)
    totals = {"amount": total_amt, "outstanding": outstanding, "invoice_count": len(invs)}

    company = await db.companies.find_one({"id": cid})
    company_name = (company or {}).get("name") or "Your accountant"
    customer_name = contact.get("name") or "there"

    html = _statement_html(company_name, customer_name, start or "", end or "", invs, totals)
    subject = f"Statement of account · {company_name}"

    from email_dispatcher import dispatch
    result = await dispatch(
        kind="customer_statement",
        to=recipient,
        subject=subject,
        html=html,
        initiating_user_id=user["id"],
        company_id=cid,
        contact_id=customer_id,
        related={"invoice_ids": [i["id"] for i in invs], "outstanding": outstanding},
    )
    return {
        "status": result.get("status"),
        "to": recipient,
        "outstanding": outstanding,
        "invoice_count": len(invs),
        "email_log_id": result.get("id"),
    }







# ---------------------- Bulk Import (CSV / Excel) ----------------------

# Common column-name variations we accept, mapped to canonical keys.
# Match is case-insensitive after stripping whitespace/underscores.
_HEADER_ALIASES = {
    "name":        {"name", "item", "product", "service", "itemname", "productname", "servicename"},
    "description": {"description", "desc", "details", "notes", "productdescription"},
    "type":        {"type", "itemtype", "kind"},
    "usage":       {"usage", "usedon", "usedfor", "for", "salesorpurchase"},
    "account":     {"account", "incomeaccount", "revenueaccount", "category", "salescategory"},
    "expense_account": {"expenseaccount", "cogsaccount", "purchaseaccount"},
    "price":       {"price", "rate", "amount", "unitprice", "salesprice", "cost"},
    "sku":         {"sku", "code", "itemcode", "productcode"},
    "active":      {"active", "enabled", "status"},
}


def _norm_header(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def _resolve_columns(cols: list[str]) -> dict[str, Optional[str]]:
    """Return {canonical: matched_original_column_name or None}."""
    norm_to_orig = {_norm_header(c): c for c in cols}
    resolved: dict[str, Optional[str]] = {k: None for k in _HEADER_ALIASES}
    for canonical, aliases in _HEADER_ALIASES.items():
        for a in aliases:
            if a in norm_to_orig:
                resolved[canonical] = norm_to_orig[a]
                break
    return resolved


def _coerce_type(val: str) -> str:
    v = (val or "").strip().lower()
    if v in ("product", "inventory", "non-inventory", "goods"):
        return "product"
    return "service"


def _coerce_bool(val, default=True) -> bool:
    if val is None:
        return default
    s = str(val).strip().lower()
    if s in ("no", "n", "0", "false", "inactive", "disabled", "off"):
        return False
    if s in ("yes", "y", "1", "true", "active", "enabled", "on"):
        return True
    return default


def _coerce_price(val) -> float:
    if val is None or val == "":
        return 0.0
    try:
        s = str(val).replace("$", "").replace(",", "").strip()
        return float(s) if s else 0.0
    except (ValueError, TypeError):
        return 0.0


async def _resolve_account_for_type(
    cid: str, target_type: str, account_name: str, cache: dict, create_missing: bool
) -> tuple[Optional[str], str]:
    """Return (account_id, account_name). Empty account_name → returns (None, '')."""
    nm = (account_name or "").strip()
    if not nm:
        return None, ""
    cache_key = f"{target_type}::{nm.lower()}"
    if cache_key in cache:
        return cache[cache_key]
    # Case-insensitive lookup against existing accounts of the right type.
    acc = await db.accounts.find_one({
        "company_id": cid,
        "type": target_type,
        "name": {"$regex": f"^{_regex_escape(nm)}$", "$options": "i"},
    })
    if not acc and target_type == "revenue":
        # Legacy seeds use "income" — try that fallback.
        acc = await db.accounts.find_one({
            "company_id": cid,
            "type": "income",
            "name": {"$regex": f"^{_regex_escape(nm)}$", "$options": "i"},
        })
    if acc:
        result = (acc["id"], acc.get("name") or nm)
        cache[cache_key] = result
        return result
    if not create_missing:
        cache[cache_key] = (None, nm)
        return None, nm
    # Auto-create the account. Pick a benign starting number in the type's
    # canonical range — accounts.py enforces uniqueness, so on collision we
    # just skip the code and let Mongo assign a random one.
    new_acc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "type": target_type,
        "subtype": "operating_revenue" if target_type == "revenue" else "operating_expense",
        "name": nm,
        "code": None,
        "active": True,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.accounts.insert_one(new_acc)
    result = (new_acc["id"], nm)
    cache[cache_key] = result
    return result


def _regex_escape(s: str) -> str:
    return "".join("\\" + ch if ch in r".*+?^$()[]{}|\\" else ch for ch in s)


@router.post("/companies/{cid}/items/import")
async def import_items(
    cid: str,
    file: UploadFile = File(...),
    create_missing_accounts: bool = Form(True),
    update_existing: bool = Form(True),
    user: dict = Depends(get_current_user),
):
    """Upload a CSV or Excel file to bulk-create items.

    Column headers are matched case-insensitively against common aliases
    (name / description / type / account / expense_account / price / sku /
    active). Unknown accounts are auto-created when
    `create_missing_accounts=True` (default). Duplicates by name are
    either updated (default) or skipped based on `update_existing`.
    Returns a summary counters + row-level errors.
    """
    await require_company(user, cid)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="File is empty.")

    # Parse via pandas — supports CSV and any Excel dialect openpyxl
    # / xlrd can handle. Fallback to a simple CSV split if pandas
    # blows up on a mangled file.
    import pandas as pd
    ext = (file.filename or "").lower().split(".")[-1]
    try:
        if ext in ("xls", "xlsx", "xlsm"):
            df = pd.read_excel(io.BytesIO(raw), dtype=str, keep_default_na=False)
        else:
            df = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {e}")

    df.columns = [str(c) for c in df.columns]
    cols = _resolve_columns(list(df.columns))
    if not cols["name"]:
        raise HTTPException(
            status_code=400,
            detail=f"No 'name' column found. Detected headers: {list(df.columns)}",
        )

    acc_cache: dict = {}
    created, updated, skipped = 0, 0, 0
    errors: list[dict] = []
    for idx, row in df.iterrows():
        try:
            nm = str(row[cols["name"]] or "").strip()
            if not nm:
                skipped += 1
                continue
            desc = str(row[cols["description"]]).strip() if cols["description"] else ""
            itype = _coerce_type(str(row[cols["type"]])) if cols["type"] else "service"
            price = _coerce_price(row[cols["price"]]) if cols["price"] else 0.0
            sku = str(row[cols["sku"]]).strip() if cols["sku"] else None
            active = _coerce_bool(row[cols["active"]]) if cols["active"] else True
            inc_name = str(row[cols["account"]]).strip() if cols["account"] else ""
            inc_id, inc_final = await _resolve_account_for_type(
                cid, "revenue", inc_name, acc_cache, create_missing_accounts
            )
            exp_name = str(row[cols["expense_account"]]).strip() if cols["expense_account"] else ""
            exp_id, exp_final = await _resolve_account_for_type(
                cid, "expense", exp_name, acc_cache, create_missing_accounts
            )
            # Explicit usage from the file wins; otherwise infer from
            # which account slots got filled by this row.
            usage_raw = str(row[cols["usage"]]).strip().lower() if cols["usage"] else ""
            usage = usage_raw if usage_raw in _USAGE_VALUES else _infer_usage(inc_id, exp_id)

            existing = await db.items.find_one({"company_id": cid, "name": nm})
            if existing:
                if not update_existing:
                    skipped += 1
                    continue
                upd = {
                    "description": desc or existing.get("description") or "",
                    "type": itype,
                    "usage": usage,
                    "price": price,
                    "sku": sku or existing.get("sku"),
                    "active": active,
                    "updated_at": now_iso(),
                }
                if inc_id:
                    upd["income_account_id"] = inc_id
                    upd["income_account_name"] = inc_final
                if exp_id:
                    upd["expense_account_id"] = exp_id
                    upd["expense_account_name"] = exp_final
                await db.items.update_one({"id": existing["id"]}, {"$set": upd})
                updated += 1
            else:
                doc = {
                    "id": str(uuid.uuid4()),
                    "company_id": cid,
                    "name": nm,
                    "description": desc,
                    "type": itype,
                    "usage": usage,
                    "income_account_id": inc_id,
                    "income_account_name": inc_final,
                    "expense_account_id": exp_id,
                    "expense_account_name": exp_final,
                    "price": price,
                    "active": active,
                    "sku": sku,
                    "created_at": now_iso(),
                    "updated_at": now_iso(),
                }
                await db.items.insert_one(doc)
                created += 1
        except Exception as e:
            errors.append({"row": int(idx) + 2, "name": str(row.get(cols["name"] or "", "")), "error": str(e)})

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "resolved_columns": {k: v for k, v in cols.items() if v},
        "total_rows": int(len(df)),
    }
