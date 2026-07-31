"""Axiom Ledger — Items catalog (Products / Services).

A per-company items catalog. Each item can be a service or a product,
optionally linked to an income account (so invoices posted from this
item hit the right P&L line). Prices are the default rate — users can
still override at line-item time.
"""
from __future__ import annotations
import io
import uuid
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
    income_account_id: Optional[str] = None
    income_account_name: Optional[str] = ""
    # Optional expense-side mapping so the same item auto-fills the
    # right expense category on bill lines (purchases).
    expense_account_id: Optional[str] = None
    expense_account_name: Optional[str] = ""
    price: float = 0.0
    active: bool = True
    sku: Optional[str] = None


class ItemPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    income_account_id: Optional[str] = None
    income_account_name: Optional[str] = None
    expense_account_id: Optional[str] = None
    expense_account_name: Optional[str] = None
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
    exp_name = inp.expense_account_name or ""
    if inp.expense_account_id and not exp_name:
        acc = await db.accounts.find_one({"company_id": cid, "id": inp.expense_account_id})
        if acc:
            exp_name = acc.get("name") or ""
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": nm,
        "description": inp.description or "",
        "type": inp.type or "service",
        "income_account_id": inp.income_account_id,
        "income_account_name": inc_name,
        "expense_account_id": inp.expense_account_id,
        "expense_account_name": exp_name,
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
    if "expense_account_id" in upd and "expense_account_name" not in upd:
        acc = await db.accounts.find_one({"company_id": cid, "id": upd["expense_account_id"]})
        if acc:
            upd["expense_account_name"] = acc.get("name") or ""
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


# ---------------------- Bulk Import (CSV / Excel) ----------------------

# Common column-name variations we accept, mapped to canonical keys.
# Match is case-insensitive after stripping whitespace/underscores.
_HEADER_ALIASES = {
    "name":        {"name", "item", "product", "service", "itemname", "productname", "servicename"},
    "description": {"description", "desc", "details", "notes", "productdescription"},
    "type":        {"type", "itemtype", "kind"},
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

            existing = await db.items.find_one({"company_id": cid, "name": nm})
            if existing:
                if not update_existing:
                    skipped += 1
                    continue
                upd = {
                    "description": desc or existing.get("description") or "",
                    "type": itype,
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
