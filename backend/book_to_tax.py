"""Book-to-Tax Adjustments report.

Separate from the P&L (which is untouched): starts from book net income
and lists the non-deductible portion of each expense account whose
effective deductibility is < 100% (entertainment 0%, business meals
50%, penalties, …) to arrive at an estimated taxable net income — the
Schedule M-1 style numbers a preparer needs.
"""
from __future__ import annotations

from db import db
from deductibility import effective_deductible_pct
import reports as R


async def compute_book_to_tax(company_id: str, start: str, end: str, basis: str = "accrual") -> dict:
    pl = await R.compute_income_statement(company_id, start, end, basis)
    accts = {a["id"]: a for a in await db.accounts.find({"company_id": company_id}, {"_id": 0}).to_list(3000)}

    adjustments = []
    for row in (pl.get("expenses") or []) + (pl.get("cogs") or []):
        if row.get("is_subtotal") or not row.get("id"):
            continue
        acct = accts.get(row["id"])
        if not acct:
            continue
        pct = effective_deductible_pct(acct)
        amt = float(row.get("amount") or 0)
        if pct >= 100 or amt == 0:
            continue
        addback = round(amt * (100 - pct) / 100, 2)
        adjustments.append({
            "account_id": acct["id"], "code": acct.get("code"), "name": acct.get("name"),
            "book_amount": round(amt, 2), "deductible_pct": pct,
            "deductible_amount": round(amt - addback, 2), "addback": addback,
            "inferred": acct.get("deductible_pct") not in (100, 50, 0),
        })
    adjustments.sort(key=lambda a: (a["deductible_pct"], -a["addback"]))
    total_addback = round(sum(a["addback"] for a in adjustments), 2)
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    return {
        "company_name": company.get("name") or pl.get("company_name") or "",
        "period_start": start, "period_end": end, "basis": pl.get("basis") or basis,
        "book_net_income": pl.get("net_income", 0.0),
        "total_expense": pl.get("total_expense", 0.0),
        "adjustments": adjustments,
        "total_addback": total_addback,
        "taxable_net_income": round(float(pl.get("net_income") or 0) + total_addback, 2),
    }
