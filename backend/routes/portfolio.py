"""Portfolio — one-screen rollup for a user who OWNS 2+ companies (investors included).

Fans out the existing per-company metric functions in parallel; no new accounting logic.
"""
from __future__ import annotations

import asyncio
import calendar
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from db import db
from reports import compute_income_statement
from routes.ai_ops import compute_dashboard_metrics, _compute_attention
from infra import get_cache

router = APIRouter(prefix="/api")
PERIODS = ("ytd", "this_month", "last_month", "ttm")


def period_range(period: str, today: date | None = None) -> tuple[str, str, str]:
    today = today or date.today()
    if period == "this_month":
        start, end, label = today.replace(day=1), today, today.strftime("%B %Y")
    elif period == "last_month":
        first_this = today.replace(day=1)
        end = first_this - timedelta(days=1)
        start, label = end.replace(day=1), end.strftime("%B %Y")
    elif period == "ttm":
        start = (today.replace(day=1) - timedelta(days=365)).replace(day=1)
        end, label = today, "Trailing 12 months"
    else:
        start, end, label = today.replace(month=1, day=1), today, f"YTD {today.year}"
    return start.isoformat(), end.isoformat(), label


async def owned_companies(user: dict) -> list[dict]:
    """Every company under this user's login (any membership role, not archived)."""
    mems = await db.memberships.find({"user_id": user["id"], "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}]}, {"_id": 0, "company_id": 1}).to_list(500)
    ids = [m["company_id"] for m in mems]
    if not ids:
        return []
    return await db.companies.find({"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1, "business_type": 1, "reporting_basis": 1,
                                                          "onboarding_complete": 1, "billing_payer": 1, "billing_product": 1}).sort("name", 1).to_list(500)


async def _company_row(c: dict, start: str, end: str) -> dict:
    basis = (c.get("reporting_basis") or "accrual").lower()

    async def safe(coro, default):
        try:
            return await coro
        except Exception:  # noqa: BLE001
            return default

    metrics, pl, att = await asyncio.gather(
        safe(compute_dashboard_metrics(c["id"]), {}),
        safe(compute_income_statement(c["id"], start, end, basis), {}),
        safe(_compute_attention(c["id"]), {}),
    )
    return {
        "company_id": c["id"], "name": c.get("name"), "business_type": c.get("business_type"), "basis": basis,
        "onboarding_complete": bool(c.get("onboarding_complete", True)), "payer": c.get("billing_payer"),
        "cash": metrics.get("cash_on_hand"), "ar": metrics.get("outstanding_invoices"), "ar_overdue": metrics.get("overdue_invoices"),
        "ap": metrics.get("outstanding_bills"), "ap_overdue": metrics.get("overdue_bills"), "net_cash_30d": metrics.get("net_cash_30d"),
        "revenue": pl.get("total_revenue"), "expenses": pl.get("total_expense"), "net_income": pl.get("net_income"),
        "needs_review": att.get("flagged_count", 0), "overdue_invoices": att.get("overdue_invoices_count", 0),
        "overdue_bills": att.get("overdue_bills_count", 0), "unreconciled": att.get("unreconciled_accounts_count", 0),
    }


@router.get("/portfolio")
async def portfolio(period: str = Query("ytd"), user: dict = Depends(get_current_user)):
    period = period if period in PERIODS else "ytd"
    companies = await owned_companies(user)
    start, end, label = period_range(period)
    cache = get_cache()
    key = cache.key("portfolio", user_id=user["id"], period=period, day=end, n=len(companies))

    async def compute():
        rows = await asyncio.gather(*[_company_row(c, start, end) for c in companies])
        rows = list(rows)

        def tot(k):
            vals = [r[k] for r in rows if isinstance(r.get(k), (int, float))]
            return round(sum(vals), 2) if vals else 0.0

        attention = sum((r["needs_review"] or 0) + (r["overdue_invoices"] or 0) + (r["overdue_bills"] or 0) + (r["unreconciled"] or 0) for r in rows)
        return {
            "eligible": len(companies) >= 2, "count": len(companies), "period": period, "period_label": label, "start": start, "end": end,
            "mixed_basis": len({r["basis"] for r in rows}) > 1,
            "totals": {"cash": tot("cash"), "ar": tot("ar"), "ar_overdue": tot("ar_overdue"), "ap": tot("ap"), "ap_overdue": tot("ap_overdue"),
                       "revenue": tot("revenue"), "expenses": tot("expenses"), "net_income": tot("net_income"),
                       "needs_review": sum(r["needs_review"] or 0 for r in rows), "attention": attention},
            "companies": rows,
        }
    return await cache.get_or_compute(key, 60, compute)
