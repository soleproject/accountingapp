"""
Per-client Monthly Responsibilities checklist.

Data model
==========

`companies.responsibilities` — flat object seeded during onboarding
step 7. Shape:

    {
        "monitoring_cashflow": "accountant" | "client" | "both",
        "reviewing_transactions": ...,
        "paying_bills": ...,
        "following_up_invoices": ...,
        "monitoring_inventory": ...,
        "issuing_payroll": ...,
        "budget_vs_actual": ...,
        "reconciling_accounts": ...,
        "paying_sales_tax": ...,
        "estimated_tax_payments": ...,
        "eom_closing": ...,
        "payroll_frequency": "weekly" | "biweekly" | "semimonthly" | "monthly" | None,
        "updated_at": ISO,
        "updated_by": email,
    }

`company_task_completions` — one doc per (company, item, period). Only
used for items that don't have a native "done" state elsewhere in the
app (cash-flow monitor, budget vs. actual, sales tax, etc.). Shape:

    {
        "id": uuid,
        "company_id": cid,
        "item_key": "monitoring_cashflow",
        "period": "2026-08",           # YYYY-MM, month-scoped
        "completed_at": ISO,
        "completed_by": email,
    }

Cadence model
=============

Every item has a `cadence`:
  • `perpetual` — no month-scoped completion, always compute live count
  • `monthly`   — one instance per YYYY-MM
  • `quarterly` — surfaces every 3 months (Apr/Jun/Sep/Jan for est. tax)

The "count rule" (per product decision):
  • Current-month view → live "what's open right now" (all cadences).
  • Prior-month view   → filtered to items whose *date* falls in that
    specific month.

Nothing here is a source of truth on its own — this module is a facade
that reads existing collections (transactions, bills, invoices, close
board checkpoints) and layers the responsibility assignment + optional
manual completion on top.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional
from calendar import monthrange

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from deps import require_company


router = APIRouter(prefix="/api")


# =============================================================================
# Static catalog
# =============================================================================

# Order here is the render order in the UI. Every item lists:
#   • label        — human title shown in the checklist + panels
#   • cadence      — perpetual | monthly | quarterly
#   • tracked      — do we have a live data source, or is it manual only?
#   • area_link    — where "Open →" should route the user (query stays raw)
CATALOG = [
    {"key": "monitoring_cashflow",     "label": "Monitoring Cash flow",         "cadence": "monthly",   "tracked": False, "area_link": "/reports/cashflow"},
    {"key": "reviewing_transactions",  "label": "Reviewing Transactions",       "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/ai-cleanup-review"},
    {"key": "paying_bills",            "label": "Paying bills",                 "cadence": "perpetual", "tracked": True,  "area_link": "/bills"},
    {"key": "following_up_invoices",   "label": "Following up with invoices",   "cadence": "perpetual", "tracked": True,  "area_link": "/invoices"},
    {"key": "monitoring_inventory",    "label": "Monitoring Inventory",         "cadence": "monthly",   "tracked": False, "area_link": "/accounting/items"},
    {"key": "issuing_payroll",         "label": "Issuing Payroll",              "cadence": "monthly",   "tracked": False, "area_link": "/accounting/transactions?filter=payroll"},
    {"key": "budget_vs_actual",        "label": "Budget vs. actual analysis",   "cadence": "monthly",   "tracked": False, "area_link": "/reports/budget-vs-actual"},
    {"key": "reconciling_accounts",    "label": "Reconciling accounts",         "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/reconciliation"},
    {"key": "paying_sales_tax",        "label": "Paying Sales tax",             "cadence": "monthly",   "tracked": False, "area_link": "/reports/sales-tax"},
    {"key": "estimated_tax_payments", "label": "Making Estimated Tax payments", "cadence": "quarterly", "tracked": False, "area_link": "/reports/tax"},
    {"key": "eom_closing",             "label": "End of Month Closing",         "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/month-close"},
]

CATALOG_BY_KEY = {c["key"]: c for c in CATALOG}

VALID_ASSIGN = {"accountant", "client", "both"}
VALID_FREQ = {"weekly", "biweekly", "semimonthly", "monthly", None, ""}


# =============================================================================
# Payload models
# =============================================================================

class SaveResponsibilitiesIn(BaseModel):
    # Free-form dict — validated per-key inline. Accepts partial saves so
    # the onboarding "Save & continue" persists whatever the user filled
    # in without failing on missing items. Values can be null when the
    # UI has "unassigned" state for an item.
    assignments: dict[str, Optional[str]]
    payroll_frequency: Optional[str] = None


class CompleteItemIn(BaseModel):
    item_key: str
    period: str  # "YYYY-MM"
    completed: bool  # allow toggling back to incomplete


# =============================================================================
# Helpers
# =============================================================================

def _parse_period(p: str) -> tuple[int, int]:
    """Parse "YYYY-MM" → (year, month). Raises 400 on bad input."""
    try:
        y, m = p.split("-", 1)
        return int(y), int(m)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Invalid period {p!r}, expected YYYY-MM") from e


def _current_period() -> str:
    now = datetime.now(timezone.utc)
    return f"{now.year:04d}-{now.month:02d}"


def _month_bounds_iso(y: int, m: int) -> tuple[str, str]:
    """Return (first_day_iso, last_day_iso) YYYY-MM-DD for that month."""
    last = monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}"


async def _count_uncategorized(cid: str, period: str, is_current: bool) -> int:
    """Reviewing Transactions live count.

    Current-month view → total needs_review (carryover included).
    Prior-month view   → filtered to txns dated in that month.
    """
    q: dict = {"company_id": cid, "needs_review": True}
    if not is_current:
        y, m = _parse_period(period)
        start, end = _month_bounds_iso(y, m)
        q["date"] = {"$gte": start, "$lte": end}
    return await db.transactions.count_documents(q)


async def _count_overdue_bills(cid: str, period: str, is_current: bool) -> int:
    """Overdue bills. Current-month view = total open past due today;
    prior-month view = bills whose original bill_date fell in that
    month AND weren't paid before the month closed. We simplify prior-
    month view to "bills dated in that month that were still unpaid at
    month-end"."""
    now_date = datetime.now(timezone.utc).date().isoformat()
    if is_current:
        return await db.bills.count_documents({
            "company_id": cid,
            "status": {"$ne": "paid"},
            "due_date": {"$lt": now_date, "$ne": None},
        })
    y, m = _parse_period(period)
    start, end = _month_bounds_iso(y, m)
    return await db.bills.count_documents({
        "company_id": cid,
        "bill_date": {"$gte": start, "$lte": end},
        "status": {"$ne": "paid"},
    })


async def _count_pastdue_invoices(cid: str, period: str, is_current: bool) -> int:
    now_date = datetime.now(timezone.utc).date().isoformat()
    if is_current:
        return await db.invoices.count_documents({
            "company_id": cid,
            "status": {"$nin": ["paid", "void", "voided"]},
            "due_date": {"$lt": now_date, "$ne": None},
        })
    y, m = _parse_period(period)
    start, end = _month_bounds_iso(y, m)
    return await db.invoices.count_documents({
        "company_id": cid,
        "issue_date": {"$gte": start, "$lte": end},
        "status": {"$nin": ["paid", "void", "voided"]},
    })


async def _recon_status(cid: str, period: str) -> tuple[int, int]:
    """Return (signed_accounts, total_accounts) for the given period."""
    y, m = _parse_period(period)
    ckps = await db.close_checkpoints.find({
        "company_id": cid, "year": y, "month": m, "kind": "reconciliation",
    }).to_list(200)
    total = len(ckps)
    signed = sum(1 for c in ckps if c.get("status") == "signed" or c.get("signed_at"))
    return signed, total


async def _close_status(cid: str, period: str) -> str:
    """One-word status for End of Month closing."""
    y, m = _parse_period(period)
    doc = await db.month_status.find_one({"company_id": cid, "year": y, "month": m})
    if not doc:
        return "not_started"
    return doc.get("overall_status") or "in_progress"


# =============================================================================
# Endpoints
# =============================================================================

@router.get("/companies/{cid}/responsibilities")
async def get_responsibilities(cid: str, user: dict = Depends(get_current_user)):
    """Return the saved assignments + the catalog metadata so a client
    can render the checklist without re-hardcoding the list of items."""
    await require_company(user, cid)
    co = await db.companies.find_one({"id": cid}, {"responsibilities": 1})
    r = (co or {}).get("responsibilities") or {}
    return {
        "assignments": {k: r.get(k) for k in CATALOG_BY_KEY},
        "payroll_frequency": r.get("payroll_frequency"),
        "updated_at": r.get("updated_at"),
        "updated_by": r.get("updated_by"),
        "catalog": [
            {k: c[k] for k in ("key", "label", "cadence", "tracked", "area_link")}
            for c in CATALOG
        ],
    }


@router.post("/companies/{cid}/responsibilities")
async def save_responsibilities(
    cid: str, inp: SaveResponsibilitiesIn, user: dict = Depends(get_current_user),
):
    """Save (or update) the checklist. Called from onboarding step 7
    and from the "Responsibilities" modal on both To Do + Client Cockpit."""
    await require_company(user, cid)
    now = now_iso()
    updates: dict = {"updated_at": now, "updated_by": user.get("email") or user.get("id")}
    for key, val in (inp.assignments or {}).items():
        if key not in CATALOG_BY_KEY:
            continue  # ignore unknown keys (forward-compat)
        if val not in VALID_ASSIGN and val is not None:
            raise HTTPException(400, f"Bad assignment for {key}: {val}")
        updates[key] = val
    freq = (inp.payroll_frequency or "").strip().lower() or None
    if freq not in VALID_FREQ:
        raise HTTPException(400, f"Bad payroll_frequency: {freq}")
    updates["payroll_frequency"] = freq

    await db.companies.update_one(
        {"id": cid},
        {"$set": {f"responsibilities.{k}": v for k, v in updates.items()}},
    )
    return {"ok": True, "updated_at": now}


@router.get("/companies/{cid}/responsibilities/status")
async def responsibilities_status(
    cid: str,
    period: str = Query(default_factory=_current_period, description="YYYY-MM"),
    scope: str = Query("both", description="accountant | client | both"),
    user: dict = Depends(get_current_user),
):
    """Return the per-item state for one period. Shape:

    {
        "period": "2026-08",
        "is_current": bool,
        "items": [
            {
                "key", "label", "cadence", "tracked", "area_link",
                "assignment": "accountant" | "client" | "both" | None,
                "count": int | None,      # live count when tracked
                "status": "done" | "in_progress" | "not_started" | "n/a",
                "manual_complete": bool,  # completion doc exists for this period
                "detail": str,            # human blurb ("2 of 4 accounts signed")
            },
            ...
        ]
    }

    The `scope` filter is applied server-side so the To Do page (client
    scope) and Client Cockpit (accountant scope) can both hit this one
    endpoint. Items where assignment=`both` appear in both scopes.
    """
    await require_company(user, cid)
    is_current = period == _current_period()

    co = await db.companies.find_one({"id": cid}, {"responsibilities": 1})
    assignments = ((co or {}).get("responsibilities") or {})
    completions = await db.company_task_completions.find({
        "company_id": cid, "period": period,
    }).to_list(100)
    completed_keys = {c["item_key"] for c in completions}

    items: list[dict] = []
    for c in CATALOG:
        key = c["key"]
        assign = assignments.get(key)
        if scope != "both":
            # For a client-scope view we include "client" + "both"; for
            # accountant-scope we include "accountant" + "both".
            if scope == "client" and assign not in ("client", "both"):
                continue
            if scope == "accountant" and assign not in ("accountant", "both"):
                continue

        count: Optional[int] = None
        status = "n/a"
        detail = ""
        breakdown: list[dict] = []

        if c["tracked"]:
            if key == "reviewing_transactions":
                # For prior-month views, the Setup Checklist breakdown
                # doesn't make sense (it's a live "right now" query with
                # no period arg). Fall back to the raw uncategorized
                # date-filtered count instead. Breakdown only surfaces
                # on the current-month view.
                base_count = await _count_uncategorized(cid, period, is_current)
                if not is_current:
                    count = base_count
                    status = "done" if count == 0 else "in_progress"
                    detail = f"{count} needs review"
                else:
                    # Reuse the Setup Checklist's 5-bucket breakdown so
                    # the CPA sees the SAME numbers here that they see on
                    # the Overview page. Each bucket becomes a clickable
                    # inline link on the panel row. Zero-count buckets
                    # are suppressed.
                    try:
                        from routes.firm_glance import _monthly_todos
                        todos = await _monthly_todos(cid)
                        s1 = int((todos.get("step1") or {}).get("count") or 0)
                        s2 = int((todos.get("step2") or {}).get("count") or 0)
                        step3 = todos.get("step3") or {}
                        tf = int(step3.get("transfer_pairs_count") or 0)
                        nc = int(step3.get("no_contact_count") or 0)
                        ck = int(step3.get("check_count") or 0)
                    except Exception:  # noqa: BLE001
                        s1 = s2 = tf = nc = ck = 0
                    total = s1 + s2 + tf + nc + ck or base_count
                    count = total
                    status = "done" if total == 0 else "in_progress"
                    detail = f"{total} needs review"
                    buckets = [
                        ("AI Categorized", s1, "/accounting/ai-cleanup-review"),
                        ("No Category",   s2, "/accounting/lets-review"),
                        ("Transfers",     tf, "/accounting/transfer-review"),
                        ("No Contact",    nc, "/accounting/no-contact-review"),
                        ("Checks",        ck, "/accounting/check-register-review"),
                    ]
                    breakdown = [
                        {"label": lbl, "count": cnt, "href": href}
                        for (lbl, cnt, href) in buckets if cnt > 0
                    ]
            elif key == "paying_bills":
                count = await _count_overdue_bills(cid, period, is_current)
                status = "done" if count == 0 else "in_progress"
                detail = f"{count} overdue"
            elif key == "following_up_invoices":
                count = await _count_pastdue_invoices(cid, period, is_current)
                status = "done" if count == 0 else "in_progress"
                detail = f"{count} past due"
            elif key == "reconciling_accounts":
                signed, total = await _recon_status(cid, period)
                count = total - signed
                if total == 0:
                    status = "not_started"
                    detail = "no bank accounts linked yet"
                elif signed == total:
                    status = "done"
                    detail = f"{total} of {total} accounts signed"
                else:
                    status = "in_progress"
                    detail = f"{signed} of {total} accounts signed"
            elif key == "eom_closing":
                s = await _close_status(cid, period)
                status = "done" if s in ("signed", "closed", "signed_off") else \
                         "not_started" if s == "not_started" else "in_progress"
                detail = s.replace("_", " ")

        if not c["tracked"]:
            # Manual — user checks it off explicitly.
            if key in completed_keys:
                status = "done"
                detail = "marked done"
            else:
                status = "not_started"
                detail = "manual — mark done when finished"

        items.append({
            "key": key,
            "label": c["label"],
            "cadence": c["cadence"],
            "tracked": c["tracked"],
            "area_link": c["area_link"],
            "assignment": assign,
            "count": count,
            "status": status,
            "manual_complete": key in completed_keys,
            "detail": detail,
            "breakdown": breakdown,
        })

    return {
        "period": period,
        "is_current": is_current,
        "scope": scope,
        "payroll_frequency": (assignments.get("payroll_frequency")),
        "items": items,
    }


@router.post("/companies/{cid}/responsibilities/complete")
async def complete_item(
    cid: str, inp: CompleteItemIn, user: dict = Depends(get_current_user),
):
    """Mark (or un-mark) a manual item complete for a specific period.
    Only applies to items with `tracked=False`. Tracked items infer
    their status from the underlying data source."""
    await require_company(user, cid)
    if inp.item_key not in CATALOG_BY_KEY:
        raise HTTPException(400, f"Unknown item {inp.item_key}")
    _parse_period(inp.period)  # validate shape
    if inp.completed:
        await db.company_task_completions.update_one(
            {"company_id": cid, "item_key": inp.item_key, "period": inp.period},
            {"$set": {
                "id": str(uuid.uuid4()),
                "company_id": cid,
                "item_key": inp.item_key,
                "period": inp.period,
                "completed_at": now_iso(),
                "completed_by": user.get("email") or user.get("id"),
            }},
            upsert=True,
        )
    else:
        await db.company_task_completions.delete_one({
            "company_id": cid, "item_key": inp.item_key, "period": inp.period,
        })
    return {"ok": True, "completed": inp.completed}
