"""Tax Line Report + account→tax-line mapping (separate from the P&L)."""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import get_current_user
from db import db, now_iso
from deps import require_company
import reports as R
import tax_lines as TL

router = APIRouter(prefix="/api", tags=["tax-lines"])
log = logging.getLogger(__name__)


async def _company_form(cid: str) -> tuple[dict, str | None]:
    company = await db.companies.find_one({"id": cid}, {"_id": 0}) or {}
    form = company.get("tax_form_override") or TL.form_for_business_type(company.get("business_type"))
    return company, form


@router.get("/companies/{cid}/tax-lines/catalog")
async def tax_line_catalog(cid: str, form: Optional[str] = None, tax_year: int = Query(2026), user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    company, f = await _company_form(cid)
    f = form or f
    return {"form": f, "form_label": TL.FORMS.get(f or ""), "supported": f in TL.SUPPORTED_FORMS,
            "business_type": company.get("business_type"), "tax_year": tax_year, "catalog_year": TL.catalog_year(tax_year),
            "params": TL.PARAMS.get(TL.catalog_year(tax_year)), "lines": TL.lines_for(f, tax_year) if f in TL.SUPPORTED_FORMS else [],
            "keys": [{"key": k, **v} for k, v in TL.KEYS.items()], "forms": TL.FORMS}


class FormIn(BaseModel):
    form: str


@router.put("/companies/{cid}/tax-lines/form")
async def set_tax_form(cid: str, inp: FormIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    if inp.form not in TL.FORMS:
        raise HTTPException(400, "Unknown form")
    await db.companies.update_one({"id": cid}, {"$set": {"tax_form_override": inp.form, "updated_at": now_iso()}})
    return {"ok": True, "form": inp.form}


async def _ai_suggest(unmapped: list[dict], industry: str) -> dict[str, str]:
    """Semantic AI mapping for accounts the rules couldn't place. Returns {account_id: key}.
    Low-confidence answers are dropped so they stay Unmapped for a human."""
    if not unmapped:
        return {}
    from ai_category_resolver import _chat_json
    keys = "\n".join(f"- {k}: {v['label']}" for k, v in TL.KEYS.items())
    accts = "\n".join(f"- id={a['id']} | {a.get('code')} {a.get('name')} | type={a.get('type')} | subtype={a.get('detail_type') or a.get('subtype') or ''}" for a in unmapped)
    system = ("You map a small business's chart-of-accounts rows to FEDERAL income-tax-return semantic keys. "
              "Answer ONLY with JSON: {\"mappings\": [{\"id\": str, \"key\": str, \"confidence\": 0-1}]}. "
              "Use key 'not_on_return' for non-deductible items (entertainment, penalties, owner draws/distributions), "
              "'balance_sheet' for assets/liabilities/equity, 'other_expenses' only when nothing else fits. "
              "If genuinely unsure give confidence < 0.6.")
    prompt = f"Industry: {industry or 'unknown'}\n\nKEYS:\n{keys}\n\nACCOUNTS:\n{accts}"
    out = await _chat_json(system, prompt, sid="tax-line-map")
    res = {}
    for m in (out.get("mappings") or []):
        if m.get("key") in TL.KEYS and float(m.get("confidence") or 0) >= 0.6:
            res[str(m.get("id"))] = m["key"]
    return res


@router.post("/companies/{cid}/tax-lines/suggest")
async def suggest_tax_lines(cid: str, overwrite: bool = False, user: dict = Depends(get_current_user)):
    """Rules first (deterministic), then semantic AI for the rest. Never
    overwrites a human-set mapping unless overwrite=true. Unconfident → Unmapped."""
    await require_company(user, cid)
    company, _ = await _company_form(cid)
    accts = await db.accounts.find({"company_id": cid, "active": {"$ne": False}}, {"_id": 0}).to_list(3000)
    todo = [a for a in accts if overwrite or not a.get("tax_line_key") or a.get("tax_line_source") != "human"]
    applied = {"rule": 0, "ai": 0, "unmapped": 0}
    leftovers = []
    for a in todo:
        key = TL.rule_suggest(a)
        if key:
            await db.accounts.update_one({"id": a["id"]}, {"$set": {"tax_line_key": key, "tax_line_source": "rule"}})
            applied["rule"] += 1
        else:
            leftovers.append(a)
    try:
        ai = await _ai_suggest(leftovers, company.get("industry") or company.get("business_description") or "")
    except Exception as e:  # noqa: BLE001
        log.warning("tax-line AI suggest failed: %s", e)
        ai = {}
    for a in leftovers:
        key = ai.get(a["id"])
        if key:
            await db.accounts.update_one({"id": a["id"]}, {"$set": {"tax_line_key": key, "tax_line_source": "ai"}})
            applied["ai"] += 1
        else:
            applied["unmapped"] += 1
    return {"ok": True, **applied}


class MapIn(BaseModel):
    tax_line_key: Optional[str] = None


@router.put("/companies/{cid}/tax-lines/accounts/{aid}")
async def set_account_tax_line(cid: str, aid: str, inp: MapIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    if inp.tax_line_key and inp.tax_line_key not in TL.KEYS:
        raise HTTPException(400, "Unknown tax line key")
    upd = {"tax_line_key": inp.tax_line_key, "tax_line_source": "human" if inp.tax_line_key else None, "updated_at": now_iso()}
    r = await db.accounts.update_one({"id": aid, "company_id": cid}, {"$set": upd})
    if not r.matched_count:
        raise HTTPException(404, "Account not found")
    return {"ok": True}


@router.get("/companies/{cid}/reports/tax-lines")
async def tax_line_report(cid: str, start: str, end: str, basis: str = "accrual", tax_year: Optional[int] = None,
                          user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    company, form = await _company_form(cid)
    ty = tax_year or int(start[:4])
    pl = await R.compute_income_statement(cid, start, end, basis)
    accts = {a["id"]: a for a in await db.accounts.find({"company_id": cid}, {"_id": 0}).to_list(3000)}
    supported = form in TL.SUPPORTED_FORMS
    table = (TL.CATALOG[TL.catalog_year(ty)].get(form) or {}) if supported else {}
    params = TL.PARAMS.get(TL.catalog_year(ty), {})

    groups: dict[str, dict] = {}
    unmapped, not_on_return = [], []
    for section, rows in (("income", pl.get("revenue") or []), ("cogs", pl.get("cogs") or []), ("deduction", pl.get("expenses") or [])):
        for row in rows:
            if row.get("is_subtotal") or not row.get("id"):
                continue
            a = accts.get(row["id"]) or {}
            amt = round(float(row.get("amount") or 0), 2)
            if amt == 0:
                continue
            entry = {"account_id": row["id"], "code": a.get("code"), "name": a.get("name") or row.get("name"), "amount": amt,
                     "source": a.get("tax_line_source")}
            key = a.get("tax_line_key")
            if not key:
                unmapped.append(entry); continue
            line = table.get(key) if supported else None
            if key in ("not_on_return", "balance_sheet") or (supported and line is None):
                not_on_return.append({**entry, "key": key}); continue
            meta = TL.KEYS[key]
            g = groups.setdefault(key, {"key": key, "line": line, "label": meta["label"], "section": meta["section"],
                                        "limit_pct": meta.get("limit_pct"), "accounts": [], "book_amount": 0.0})
            g["accounts"].append(entry); g["book_amount"] = round(g["book_amount"] + amt, 2)
    for g in groups.values():
        pct = params.get("meals_pct", 50) if g["key"] == "meals" else (g["limit_pct"] or 100)
        g["return_amount"] = round(g["book_amount"] * pct / 100, 2)
        g["limit_pct"] = pct if pct < 100 else None

    def _sort(ls):
        return sorted(ls, key=lambda g: (str(g["line"] or "zzz").zfill(4), g["label"]))
    income = _sort([g for g in groups.values() if g["section"] == "income"])
    cogs = _sort([g for g in groups.values() if g["section"] == "cogs"])
    deductions = _sort([g for g in groups.values() if g["section"] == "deduction"])
    tot_inc = round(sum(g["return_amount"] for g in income), 2)
    tot_cogs = round(sum(g["return_amount"] for g in cogs), 2)
    tot_ded = round(sum(g["return_amount"] for g in deductions), 2)
    return {
        "company_name": company.get("name"), "business_type": company.get("business_type"), "form": form,
        "form_label": TL.FORMS.get(form or ""), "supported": supported, "tax_year": ty, "catalog_year": TL.catalog_year(ty),
        "params": params, "period_start": start, "period_end": end, "basis": pl.get("basis") or basis,
        "income": income, "cogs": cogs, "deductions": deductions,
        "unmapped": unmapped, "not_on_return": not_on_return,
        "unmapped_total": round(sum(e["amount"] for e in unmapped), 2),
        "not_on_return_total": round(sum(e["amount"] for e in not_on_return), 2),
        "total_income": tot_inc, "total_cogs": tot_cogs, "total_deductions": tot_ded,
        "return_net": round(tot_inc - tot_cogs - tot_ded, 2),
        "book_net_income": pl.get("net_income", 0.0),
    }
