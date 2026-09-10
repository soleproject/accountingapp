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
    {"key": "reviewing_transactions",  "label": "Reviewing Transactions",       "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/ai-cleanup-review"},
    {"key": "paying_bills",            "label": "Paying bills",                 "cadence": "perpetual", "tracked": True,  "area_link": "/bills"},
    {"key": "following_up_invoices",   "label": "Following up with invoices",   "cadence": "perpetual", "tracked": True,  "area_link": "/invoices"},
    {"key": "monitoring_inventory",    "label": "Monitoring Inventory",         "cadence": "perpetual", "tracked": True,  "area_link": "/dashboard#reorder-alerts"},
    {"key": "issuing_payroll",         "label": "Issuing Payroll",              "cadence": "monthly",   "tracked": False, "area_link": "/accounting/transactions?filter=payroll"},
    {"key": "budget_vs_actual",        "label": "Budget vs. actual analysis",   "cadence": "monthly",   "tracked": False, "area_link": "/reports/budget-vs-actual"},
    {"key": "reconciling_accounts",    "label": "Reconciling accounts",         "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/reconciliation"},
    {"key": "paying_sales_tax",        "label": "Paying Sales tax",             "cadence": "monthly",   "tracked": True,  "area_link": "/reports/sales-tax-report"},
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


# ---- Reconciliation detail (per-account) ----------------------------------

# detail_types we consider "reconcilable" — these are the accounts that
# meaningfully carry a real-world statement (bank, savings, CC, loan).
_RECONCILABLE_DETAIL_TYPES = {
    "cash_and_bank",
    "credit_card",
    "loan_and_line_of_credit",
}

# Name-keyword fallback for accounts missing detail_type (legacy CoA rows
# imported before the detail_type refactor).
_RECONCILABLE_NAME_KEYWORDS = (
    "bank", "checking", "savings", "money market", "cd",
    "credit card", "line of credit", "loan", "mortgage",
)


def _is_reconcilable_account(a: dict) -> bool:
    if a.get("type") not in ("asset", "liability"):
        return False
    if a.get("active") is False:
        return False
    dt = (a.get("detail_type") or "").strip().lower()
    if dt in _RECONCILABLE_DETAIL_TYPES:
        return True
    if dt:
        return False  # explicit non-reconcilable detail_type — skip
    name = (a.get("name") or "").lower()
    return any(k in name for k in _RECONCILABLE_NAME_KEYWORDS)


async def _ledger_balance_asof(cid: str, account_id: str, as_of: str) -> float:
    """Sum of all posted txns for account_id through (inclusive) as_of."""
    agg = await db.transactions.aggregate([
        {"$match": {
            "company_id": cid,
            "account_id": account_id,
            "date": {"$lte": as_of},
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    return round(float(agg[0]["total"]) if agg else 0.0, 2)


async def _close_status(cid: str, period: str) -> str:
    """One-word status for End of Month closing (of the given period)."""
    y, m = _parse_period(period)
    doc = await db.month_status.find_one({"company_id": cid, "year": y, "month": m})
    if not doc:
        return "not_started"
    return doc.get("overall_status") or "in_progress"


def _prev_period(period: str) -> str:
    y, m = _parse_period(period)
    if m == 1:
        return f"{y - 1:04d}-12"
    return f"{y:04d}-{m - 1:02d}"


async def _sales_tax_status(cid: str, period: str) -> dict:
    """For "Paying Sales tax": returns per-month collected/paid/net.

    Mirrors the `/reports/sales-tax` computation so numbers stay in sync
    with the Sales Tax Report the "Open" link points to.

    Returns:
        {"collected": float, "paid_to_agency": float, "net_owed": float}
        where `net_owed` = collected − paid_to_agency (positive = owe
        the agency, negative = credit / overpayment).
    """
    y, m = _parse_period(period)
    start, end = _month_bounds_iso(y, m)
    invs = await db.invoices.find({
        "company_id": cid, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)
    collected = round(sum(float(i.get("tax") or 0) for i in invs), 2)
    pay_docs = await db.tax_payments.find({
        "company_id": cid, "date": {"$gte": start, "$lte": end},
    }).to_list(2000)
    paid_to_agency = round(sum(float(p.get("amount") or 0) for p in pay_docs), 2)
    return {
        "collected": collected,
        "paid_to_agency": paid_to_agency,
        "net_owed": round(collected - paid_to_agency, 2),
    }



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
            elif key == "monitoring_inventory":
                # Perpetual — always "right now" regardless of the month
                # switcher. Ticks amber when any tracked item is at or
                # below its low-stock threshold.
                try:
                    import inventory_service
                    alerts = await inventory_service.compute_reorder_alerts(cid)
                    count = int(alerts.get("count") or 0)
                except Exception:  # noqa: BLE001
                    count = 0
                status = "done" if count == 0 else "in_progress"
                detail = (
                    f"{count} item{'' if count == 1 else 's'} at or below low-stock"
                    if count else "all items above low-stock threshold"
                )
            elif key == "reconciling_accounts":
                # Reconciliation refers to the PREVIOUS month — like
                # EOM Closing, you can't reconcile a month that isn't
                # over yet. Per-account rollup: for each reconcilable
                # account, is there a reconciliation covering the prev
                # month AND is it balanced (|diff| < $0.02)?
                prev = _prev_period(period)
                py, pm = _parse_period(prev)
                _, month_end = _month_bounds_iso(py, pm)
                prev_label = datetime(py, pm, 1).strftime("%B %Y")
                accts = await db.accounts.find({
                    "company_id": cid, "type": {"$in": ["asset", "liability"]},
                }).to_list(500)
                recon_accts = [a for a in accts if _is_reconcilable_account(a)]
                total = len(recon_accts)
                if total == 0:
                    count = 0
                    status = "not_started"
                    detail = f"{prev_label}: no bank accounts linked yet"
                else:
                    acct_ids = [a["id"] for a in recon_accts]
                    recs = await db.reconciliations.find({
                        "company_id": cid,
                        "bank_account_id": {"$in": acct_ids},
                        "period_start": {"$lte": month_end},
                        "period_end":   {"$gte": f"{py:04d}-{pm:02d}-01"},
                    }).to_list(500)
                    # Best recon per account for this month = latest by period_end.
                    by_acct: dict = {}
                    for r in recs:
                        aid = r.get("bank_account_id")
                        if not aid:
                            continue
                        prev_r = by_acct.get(aid)
                        if not prev_r or (r.get("period_end") or "") > (prev_r.get("period_end") or ""):
                            by_acct[aid] = r
                    reconciled = 0
                    for aid in acct_ids:
                        r = by_acct.get(aid)
                        if not r:
                            continue
                        diff = r.get("difference")
                        if diff is None:
                            diff = float(r.get("statement_balance") or 0.0) - float(r.get("cleared_sum") or 0.0)
                        if abs(float(diff)) < 0.02:
                            reconciled += 1
                    count = total - reconciled
                    if reconciled == total:
                        status = "done"
                        detail = f"{prev_label}: {total} of {total} accounts reconciled"
                    elif reconciled == 0:
                        status = "in_progress"
                        detail = f"{prev_label}: 0 of {total} accounts reconciled"
                    else:
                        status = "in_progress"
                        detail = f"{prev_label}: {reconciled} of {total} accounts reconciled"
            elif key == "eom_closing":
                # EOM Closing intentionally refers to the PREVIOUS month —
                # you can't close the current month until it's over. The
                # dropdown drills into the same 5 checkpoints that live on
                # the Month Close page for that prior period.
                prev = _prev_period(period)
                py, pm = _parse_period(prev)
                try:
                    from routes.month_close import _month_status as _mc_status
                    mc = await _mc_status(cid, py, pm)
                except Exception:  # noqa: BLE001
                    mc = None
                cps = (mc or {}).get("checkpoints") or {}
                total_c = 5
                green_c = sum(1 for k in ("txns_reviewed", "invoices", "bills", "recon", "closed") if (cps.get(k) or {}).get("green"))
                closed_sign = (cps.get("closed") or {}).get("green")
                prev_label = datetime(py, pm, 1).strftime("%B %Y")
                if closed_sign:
                    status = "done"
                    detail = f"{prev_label} closed"
                elif green_c == 0:
                    status = "not_started"
                    detail = f"{prev_label} not started"
                else:
                    status = "in_progress"
                    detail = f"{prev_label}: {green_c} of {total_c} signed"
                count = total_c - green_c
            elif key == "paying_sales_tax":
                # Live per-month rollup — collected on invoices minus what
                # was remitted to the agency. `done` only when the net
                # obligation is zero or a credit (over-remitted).
                st = await _sales_tax_status(cid, period)
                owed, paid_amt, net = st["collected"], st["paid_to_agency"], st["net_owed"]
                count = 1 if net > 0.005 else 0
                if owed == 0 and paid_amt == 0:
                    status = "not_started"
                    detail = "no taxable sales this period"
                elif net > 0.005:
                    status = "in_progress"
                    detail = f"owe ${net:,.2f}"
                elif net < -0.005:
                    status = "done"
                    detail = f"remitted — ${-net:,.2f} credit"
                else:
                    status = "done"
                    detail = "remitted — settled"
                # Two inline breakdown chips on the row, both deep-linking
                # to the Sales Tax Report scoped to this month. Rendered
                # as money on the frontend via the `is_money` flag.
                y_, m_ = _parse_period(period)
                m_start, m_end = _month_bounds_iso(y_, m_)
                href = f"/reports/sales-tax-report?preset=custom&start={m_start}&end={m_end}"
                breakdown = [
                    {"label": "Owed", "count": owed,     "href": href, "is_money": True},
                    {"label": "Paid", "count": paid_amt, "href": href, "is_money": True},
                ]

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



@router.get("/companies/{cid}/responsibilities/reconciliation-detail")
async def reconciliation_detail(
    cid: str,
    period: str = Query(default_factory=_current_period, description="YYYY-MM"),
    user: dict = Depends(get_current_user),
):
    """Per-account reconciliation status for the Reconciling Accounts row.

    Reconciliation refers to the PREVIOUS month relative to the selected
    `period` (you can't reconcile a month that isn't over yet — mirrors
    the EOM Closing behavior).

    For every reconcilable account (bank/savings/CC/loan) return:
      • `ledger_balance` through end of the prev month
      • whether a reconciliation covering the prev month has been *attempted*
      • latest recon `statement_balance`, `diff`, `status` when attempted
    """
    await require_company(user, cid)
    prev = _prev_period(period)
    y, m = _parse_period(prev)
    month_start, month_end = _month_bounds_iso(y, m)
    prev_label = datetime(y, m, 1).strftime("%B %Y")

    accts = await db.accounts.find({
        "company_id": cid, "type": {"$in": ["asset", "liability"]},
    }).to_list(1000)
    accts = [a for a in accts if _is_reconcilable_account(a)]
    accts.sort(key=lambda a: (a.get("code") or "", a.get("name") or ""))

    if not accts:
        return {
            "period": period,
            "recon_period": prev,
            "recon_period_label": prev_label,
            "month_start": month_start,
            "month_end": month_end,
            "accounts": [],
        }

    acct_ids = [a["id"] for a in accts]
    # Any recon overlapping this month, per account. Keep the latest by
    # period_end so a mid-month partial recon doesn't override the full
    # month one.
    recs = await db.reconciliations.find({
        "company_id": cid,
        "bank_account_id": {"$in": acct_ids},
        "period_start": {"$lte": month_end},
        "period_end":   {"$gte": month_start},
    }).sort("period_end", -1).to_list(1000)
    by_acct: dict = {}
    for r in recs:
        aid = r.get("bank_account_id")
        if aid and aid not in by_acct:
            by_acct[aid] = r

    out: list[dict] = []
    for a in accts:
        aid = a["id"]
        ledger = await _ledger_balance_asof(cid, aid, month_end)
        r = by_acct.get(aid)
        attempted = r is not None
        if r:
            stmt_bal = float(r.get("statement_balance") or 0.0)
            if r.get("difference") is not None:
                diff = float(r["difference"])
            else:
                cleared = float(r.get("cleared_sum") or 0.0)
                diff = round(stmt_bal - cleared, 2)
            balanced = abs(diff) < 0.02
            if r.get("status") == "qbo_covered":
                acct_status = "qbo_covered"
            elif r.get("status") == "reconciled" and balanced:
                acct_status = "reconciled"
            elif balanced:
                acct_status = "reconciled"
            else:
                acct_status = "variance"
            recon_id = r.get("id")
            period_start = r.get("period_start")
            period_end = r.get("period_end")
        else:
            stmt_bal = None
            diff = None
            balanced = False
            acct_status = "not_started"
            recon_id = None
            period_start = None
            period_end = None
        out.append({
            "id": aid,
            "code": a.get("code"),
            "name": a.get("name"),
            "type": a.get("type"),
            "detail_type": a.get("detail_type") or "",
            "ledger_balance": ledger,
            "attempted": attempted,
            "statement_balance": stmt_bal,
            "diff": diff,
            "balanced": balanced,
            "status": acct_status,
            "reconciliation_id": recon_id,
            "reconciliation_period_start": period_start,
            "reconciliation_period_end": period_end,
        })
    return {
        "period": period,
        "recon_period": prev,
        "recon_period_label": prev_label,
        "month_start": month_start,
        "month_end": month_end,
        "accounts": out,
    }



@router.get("/companies/{cid}/responsibilities/month-close-detail")
async def month_close_detail(
    cid: str,
    period: str = Query(default_factory=_current_period, description="YYYY-MM (current)"),
    user: dict = Depends(get_current_user),
):
    """Detail for the "End of Month Closing" row.

    EOM Closing always refers to the *previous* month relative to the
    selected `period` (you can't close a month that isn't over yet). Uses
    `routes.month_close._month_status` directly so the checkpoints match
    what the Month Close page renders.

    Returns:
        {
          "close_period": "YYYY-MM",           # the month being closed
          "close_period_label": "August 2026",
          "deep_link": "/accounting/month-close?ym=YYYY-MM",
          "checkpoints": {...same as month_close endpoint...}
        }
    """
    await require_company(user, cid)
    prev = _prev_period(period)
    py, pm = _parse_period(prev)
    from routes.month_close import _month_status as _mc_status
    mc = await _mc_status(cid, py, pm)
    return {
        "close_period": prev,
        "close_period_label": datetime(py, pm, 1).strftime("%B %Y"),
        "deep_link": f"/accounting/month-close?ym={prev}",
        "period_start": mc.get("period_start"),
        "period_end":   mc.get("period_end"),
        "checkpoints":  mc.get("checkpoints") or {},
    }
