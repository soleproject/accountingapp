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
from datetime import datetime, timedelta, timezone
from typing import Optional
from calendar import monthrange

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
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
    {"key": "ai_auto_cleanup",         "label": "AI auto-cleanup review",       "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/ai-cleanup-review", "always_visible": True},
    {"key": "paying_bills",            "label": "Paying bills",                 "cadence": "perpetual", "tracked": True,  "area_link": "/bills"},
    {"key": "following_up_invoices",   "label": "Following up with invoices",   "cadence": "perpetual", "tracked": True,  "area_link": "/invoices"},
    {"key": "monitoring_inventory",    "label": "Monitoring Inventory",         "cadence": "perpetual", "tracked": True,  "area_link": "/dashboard#reorder-alerts"},
    {"key": "issuing_payroll",         "label": "Issuing Payroll",              "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/payroll"},
    {"key": "reconciling_accounts",    "label": "Reconciling accounts",         "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/reconciliation"},
    {"key": "paying_sales_tax",        "label": "Paying Sales tax",             "cadence": "monthly",   "tracked": True,  "area_link": "/reports/sales-tax-report"},
    {"key": "paying_payroll_liabilities", "label": "Paying Payroll liabilities", "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/payroll"},
    {"key": "estimated_tax_payments", "label": "Making Estimated Tax payments", "cadence": "quarterly", "tracked": False, "area_link": "/reports/tax"},
    {"key": "eom_closing",             "label": "End of Month Closing",         "cadence": "monthly",   "tracked": True,  "area_link": "/accounting/month-close"},
    # ─────────────────────────────────────────────────────────────────
    # Quick Check-in cards. Each surfaces a bucket of open items from
    # the client's active `client_review_batches` doc so the CPA (and
    # the client on the To Do page) can see exactly what's waiting on
    # a response, without cracking the full Check-in flow.
    #
    # `area_link` isn't used for these — the row expands in place with
    # a `CheckinItemsTile` and every row deep-links into the current
    # open batch. `/todo` is just a safe fallback for the fallback path.
    # ─────────────────────────────────────────────────────────────────
    {"key": "liability_payments",  "label": "Liability Payments",   "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/todo"},
    {"key": "checks_no_payee",     "label": "Checks (missing payee)", "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/todo"},
    {"key": "receipt_followup",    "label": "Receipt Follow-up",    "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/todo"},
    {"key": "irs_compliance",      "label": "IRS Compliance",       "cadence": "perpetual", "tracked": True,  "area_link": "/accounting/todo"},
]

# Keys of the 4 new check-in item cards. Kept as a set so the status
# handler can (a) route them through the shared bucket helper and (b)
# default their assignment to "both" pre-onboarding, without having to
# maintain the list in two places.
CHECKIN_ITEM_KEYS = {
    "liability_payments",
    "checks_no_payee",
    "receipt_followup",
    "irs_compliance",
}

CATALOG_BY_KEY = {c["key"]: c for c in CATALOG}

VALID_ASSIGN = {"accountant", "client", "both", "n/a"}
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


async def _chat_review_counts(cid: str, user: dict) -> dict:
    """Return the same 3-tab count shape the Chat Review queue exposes
    (No Category / Transactions / Checks), so the responsibilities
    panel can render them as the tile pills when the CPA is in
    chat mode. Cheap, single query — no LLM calls.
    """
    from routes.reviewv2 import (
        chat_review_queue as _chat_review_queue,  # noqa: WPS433
    )
    try:
        payload = await _chat_review_queue(cid, user=user)
    except Exception:  # noqa: BLE001
        return {"no_category": 0, "transactions": 0, "checks": 0}
    return {
        "no_category": len(payload.get("no_category") or []),
        "transactions": len(payload.get("transactions") or []),
        "checks":       len(payload.get("checks") or []),
    }


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


async def _open_checkin_items_by_bucket(cid: str) -> dict[str, list[dict]]:
    """Return the current open/scheduled batch's unanswered items,
    grouped into the four Quick Check-in card buckets.

    Empty buckets are returned when no batch is live so the caller can
    still render "All caught up" state without a second query.
    """
    from client_review import (  # local import to avoid cycles at boot
        ITEM_LIABILITY_SPLIT, ITEM_MISSING_RECEIPT,
        ITEM_CHECK_NO_CONTACT, ITEM_IRS_MEALS, ITEM_IRS_TRAVEL,
    )
    buckets: dict[str, list[dict]] = {
        "liability_payments": [],
        "checks_no_payee":    [],
        "receipt_followup":   [],
        "irs_compliance":     [],
    }
    batch = await db.client_review_batches.find_one(
        {"company_id": cid, "status": {"$in": ["open", "scheduled"]}},
        sort=[("created_at", -1)],
    )
    if not batch:
        return buckets
    for it in batch.get("items") or []:
        if it.get("answered_at") or it.get("deferred"):
            continue
        t = it.get("item_type")
        ctx = it.get("context") or {}
        meta = ctx.get("meta") or {}
        amount = ctx.get("amount")
        if amount is None:
            amount = meta.get("txn_amount")
        row = {
            "id":          it.get("item_id") or it.get("source_id"),
            "source_id":   it.get("source_id"),
            "date":        ctx.get("date") or meta.get("txn_date"),
            "description": (ctx.get("description")
                            or ctx.get("title")
                            or it.get("prompt") or ""),
            "amount":      amount,
            "prompt":      it.get("prompt") or "",
            "item_type":   t,
        }
        # For the aggregate checks-without-payee item, ship the full
        # check list so the inline allocator can render one card per
        # check without a second round trip.
        if t == ITEM_CHECK_NO_CONTACT:
            row["checks"] = ctx.get("checks") or []
            row["resolved_txn_ids"] = it.get("resolved_txn_ids") or []
        if t == ITEM_LIABILITY_SPLIT:
            buckets["liability_payments"].append(row)
        elif t == ITEM_CHECK_NO_CONTACT:
            buckets["checks_no_payee"].append(row)
        elif t == ITEM_MISSING_RECEIPT:
            buckets["receipt_followup"].append(row)
        elif t in (ITEM_IRS_MEALS, ITEM_IRS_TRAVEL):
            buckets["irs_compliance"].append(row)
    return buckets


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

    co = await db.companies.find_one({"id": cid}, {"responsibilities": 1, "features": 1, "payroll_state": 1})
    assignments = ((co or {}).get("responsibilities") or {})
    features_doc = ((co or {}).get("features") or {})
    advanced_payroll = bool(features_doc.get("advanced_payroll"))
    completions = await db.company_task_completions.find({
        "company_id": cid, "period": period,
    }).to_list(100)
    completed_keys = {c["item_key"] for c in completions}

    # Lazy-computed once per request: the 4 Quick Check-in card buckets.
    # Fetched on demand the first time a check-in row is hit so we
    # skip the query entirely when none of them are in scope.
    checkin_buckets: Optional[dict[str, list[dict]]] = None

    items: list[dict] = []
    for c in CATALOG:
        key = c["key"]
        # The full ledger-backed "Paying Payroll liabilities" row is only
        # meaningful when the manual ledger is turned on — otherwise
        # there are no stubs, no aging, and the tile would always be
        # empty. Hide it entirely when advanced_payroll is off.
        if key == "paying_payroll_liabilities" and not advanced_payroll:
            continue
        assign = assignments.get(key)
        # For the 4 Quick Check-in cards we default to "both" pre-
        # onboarding so they surface on both To Do and Client Cockpit
        # without a firm having to remember to toggle them on. A firm
        # can still opt out per-client by picking "N/A" in the
        # Responsibilities modal.
        if assign is None and key in CHECKIN_ITEM_KEYS:
            assign = "both"
        # N/A rows are opt-outs — never surface them anywhere, regardless
        # of scope. Callers see the item as if it was never in the catalog.
        if assign == "n/a":
            continue
        # `always_visible` catalog entries (e.g. AI auto-cleanup, a
        # scheduler-driven housekeeping item) bypass the scope filter
        # since they have no per-company assignment — they should
        # surface on both the To Do (client) and Client Cockpit
        # (accountant) whenever there's something pending.
        always_visible = bool(c.get("always_visible"))
        if scope != "both" and not always_visible:
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
        extra: dict = {}       # per-item add-ons; currently only used
                               # by reviewing_transactions to ship the
                               # Chat Review queue counts alongside the
                               # standard checklist breakdown.

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
                    # Chat Review queue counts — the 3-tab shape used by
                    # the inline expansion on the responsibilities card
                    # (No Category · Transactions · Checks). Cheap: this
                    # is a lightweight groupby on unreviewed rows.
                    try:
                        cr = await _chat_review_counts(cid, user)
                    except Exception:  # noqa: BLE001
                        cr = {"no_category": 0, "transactions": 0, "checks": 0}
                    extra["chat_counts"] = cr
            elif key == "ai_auto_cleanup":
                # Pending patterns from the nightly auto-apply. Each row
                # is one (canonical_contact, descriptor_key) pattern the
                # scheduler already applied — the CPA/client can undo,
                # acknowledge, or save-as-rule right from the card.
                patterns = []
                async for r in db.contact_cleanup_applied.find(
                    {"company_id": cid, "status": "applied"},
                    {"_id": 0, "id": 1, "contact_id": 1, "contact_name": 1,
                     "descriptor_key": 1, "sample_description": 1,
                     "before_labels": 1, "count": 1, "txn_ids": 1,
                     "applied_at": 1, "save_as_rule": 1},
                ).sort("applied_at", -1):
                    patterns.append(r)
                # Aggregate the signed dollar total per pattern in ONE
                # query so the frontend can group cards by direction
                # (Money in vs Money out) without hydrating each
                # pattern's samples first. Cheap: filters by txn ids
                # already resolved above.
                all_txn_ids: list[str] = []
                for p in patterns:
                    all_txn_ids.extend(p.get("txn_ids") or [])
                totals_by_txn: dict[str, float] = {}
                if all_txn_ids:
                    async for t in db.transactions.find(
                        {"company_id": cid, "id": {"$in": all_txn_ids}},
                        {"_id": 0, "id": 1, "amount": 1},
                    ):
                        totals_by_txn[t.get("id")] = float(t.get("amount") or 0)
                total_rows = sum(int(p.get("count") or 0) for p in patterns)
                count = total_rows
                status = "done" if not patterns else "in_progress"
                detail = (f"{total_rows} row{'' if total_rows == 1 else 's'} "
                          f"auto-cleaned · {len(patterns)} pattern"
                          f"{'' if len(patterns) == 1 else 's'} to review"
                          if patterns else "0 pending")
                # Panel renders the dropdown from `breakdown`; per user
                # spec, one card with an expandable list of patterns.
                breakdown = []
                for p in patterns:
                    tids = p.get("txn_ids") or []
                    dollars = sum(totals_by_txn.get(x, 0.0) for x in tids)
                    breakdown.append({
                        "kind":               "ai_cleanup_pattern",
                        "applied_id":         p.get("id"),
                        "label":              (
                            f"{p.get('count')} row"
                            f"{'' if p.get('count') == 1 else 's'} · "
                            + ", ".join((p.get("before_labels") or [])[:3])
                            + f" → {p.get('contact_name') or 'AI-picked contact'}"),
                        "count":              int(p.get("count") or 0),
                        "sample_description": p.get("sample_description") or "",
                        "contact_id":         p.get("contact_id"),
                        "contact_name":       p.get("contact_name"),
                        "before_labels":      p.get("before_labels") or [],
                        "descriptor_key":     p.get("descriptor_key") or "",
                        "txn_ids":            tids,
                        "total_dollars":      round(dollars, 2),
                        "direction":          "in" if dollars >= 0 else "out",
                        "save_as_rule":       bool(p.get("save_as_rule")),
                        "href":               "/transactions?ids=" + ",".join(
                            tids[:20])})
                # Nothing pending → suppress the row entirely to keep
                # the checklist tight. It re-appears on the next sweep
                # if new patterns get applied.
                if not patterns:
                    continue
            elif key == "paying_bills":
                count = await _count_overdue_bills(cid, period, is_current)
                status = "done" if count == 0 else "in_progress"
                detail = f"{count} overdue"
            elif key == "following_up_invoices":
                count = await _count_pastdue_invoices(cid, period, is_current)
                status = "done" if count == 0 else "in_progress"
                detail = f"{count} past due"
            elif key == "issuing_payroll":
                # Cadence-driven reminder. Two data sources, in order:
                #   1) Latest finalized `payroll_runs.pay_date` (used when
                #      the advanced_payroll ledger is on and the CPA is
                #      journalizing real stubs).
                #   2) `companies.payroll_state.last_run_at` — a simple
                #      timestamp updated by POST /payroll/mark-run when
                #      the client uses an external service (Gusto/ADP)
                #      and only needs a checkoff on the cockpit.
                # Frequency comes from `responsibilities.payroll_frequency`
                # set during onboarding: weekly|biweekly|semimonthly|monthly.
                from datetime import datetime, timedelta, timezone
                freq = (assignments.get("payroll_frequency") or "").strip().lower()
                interval_days = {
                    "weekly": 7, "biweekly": 14,
                    "semimonthly": 15, "monthly": 31,
                }.get(freq)

                if not interval_days:
                    status = "not_started"
                    detail = "Set payroll frequency in Responsibilities"
                    count = 0
                else:
                    last = None
                    # Only consult payroll_runs when the advanced ledger
                    # is on. Otherwise the CPA has explicitly said "the
                    # client uses Gusto/ADP" and any old runs are legacy
                    # data that shouldn't drive the cadence.
                    if advanced_payroll:
                        last_run = await db.payroll_runs.find_one(
                            {"company_id": cid, "status": "finalized"},
                            sort=[("pay_date", -1)],
                            projection={"pay_date": 1},
                        )
                        if last_run and last_run.get("pay_date"):
                            try:
                                last = datetime.fromisoformat(
                                    last_run["pay_date"].replace("Z", "+00:00")
                                )
                            except Exception:  # noqa: BLE001
                                last = None
                    if last is None:
                        ts = ((co or {}).get("payroll_state") or {}).get("last_run_at")
                        if ts:
                            try:
                                last = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                            except Exception:  # noqa: BLE001
                                last = None
                    if last and last.tzinfo is None:
                        last = last.replace(tzinfo=timezone.utc)

                    if last is None:
                        status = "in_progress"
                        detail = f"Payroll due — no runs recorded yet ({freq})"
                        count = 1
                    else:
                        days_since = (datetime.now(timezone.utc) - last).days
                        if days_since >= interval_days:
                            status = "in_progress"
                            detail = (
                                f"Payroll due — {days_since} days since last run "
                                f"({freq}, ~every {interval_days}d)"
                            )
                            count = 1
                        else:
                            days_until = interval_days - days_since
                            status = "done"
                            detail = (
                                f"Ran {days_since}d ago · next in ~{days_until}d "
                                f"({freq})"
                            )
                            count = 0
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

            elif key == "paying_payroll_liabilities":
                # Live rollup of payroll withholdings + employer taxes
                # owed to the IRS / state agencies / benefit vendors,
                # minus what's already been remitted via Pay Liability.
                # Cadence is "perpetual" (not scoped to the selected
                # month) because federal 941 deposits are semi-weekly
                # or monthly, FUTA is quarterly, and 401(k) is 7 days
                # — the "month view" of Cockpit shouldn't hide a
                # federal deposit due mid-cycle.
                from payroll_service import liability_aging
                agg = await liability_aging(cid)
                tot = agg.get("totals") or {}
                owed_v = float(tot.get("owed")       or 0)
                paid_v = float(tot.get("paid")       or 0)
                out_v  = float(tot.get("outstanding") or 0)
                count = 1 if out_v > 0.005 else 0
                href = "/accounting/payroll"
                if owed_v == 0 and paid_v == 0:
                    status = "not_started"
                    detail = "no payroll runs yet"
                elif out_v > 0.005:
                    status = "in_progress"
                    detail = f"owe ${out_v:,.2f}"
                else:
                    status = "done"
                    detail = "remitted — settled"
                breakdown = [
                    {"label": "Owed", "count": owed_v, "href": href, "is_money": True},
                    {"label": "Paid", "count": paid_v, "href": href, "is_money": True},
                ]

            elif key in CHECKIN_ITEM_KEYS:
                # Quick Check-in cards — count = unanswered items of
                # this bucket in the current open/scheduled batch.
                # Breakdown = the item list itself, consumed by the
                # frontend's CheckinItemsTile.
                if checkin_buckets is None:
                    checkin_buckets = await _open_checkin_items_by_bucket(cid)
                bucket = checkin_buckets[key]
                # For the checks bucket a single aggregate item can
                # represent N unresolved checks — count those instead
                # so the card header + card badge reflect the real
                # amount of work waiting, not the number of aggregates.
                if key == "checks_no_payee":
                    count = 0
                    for row in bucket:
                        checks = row.get("checks") or []
                        resolved = set(row.get("resolved_txn_ids") or [])
                        if checks:
                            count += sum(1 for c in checks
                                         if c.get("id") not in resolved)
                        else:
                            count += 1
                else:
                    count = len(bucket)
                if count == 0:
                    status = "done"
                    detail = "all caught up — nothing waiting on the client"
                else:
                    status = "in_progress"
                    detail = (f"{count} item{'' if count == 1 else 's'} "
                              f"waiting on client response")
                # Note: we intentionally do NOT populate `breakdown` in
                # the shared inline-chip shape here — the frontend
                # reads a dedicated `items` field so the rows never
                # get treated as clickable count-pills.
                extra["items"] = bucket

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
            **extra,
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



# ─────────────────────────────────────────────────────────────────────────────
# Firm-authenticated Quick Check-in submit — the accountant (or client)
# can answer an open item from the inline `CheckinItemsTile` without
# leaving the To Do / Client Cockpit page. Wraps the existing
# token-gated logic in `routes/client_review.py` so both surfaces (the
# firm-side inline form AND the client's magic-link Check-in) drive
# identical side-effects (attachment mirror, IRS substantiation on the
# transaction, `answered_at` on the batch item, etc.).
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/companies/{cid}/checkin/items/{item_id}/submit")
async def submit_checkin_item(
    cid: str,
    item_id: str,
    answer: str = Form(""),
    payload_json: str = Form("{}"),
    file: Optional[UploadFile] = File(None),
    user: dict = Depends(get_current_user),
):
    """Accountant-side inline submit for one Quick Check-in item.

    Multipart body:
      • `answer`        — free-text notes / rationale (optional)
      • `payload_json`  — JSON dict of structured fields (attendees,
                          business_purpose, destination, trip_start,
                          trip_end, payee_name, split_amounts, …)
      • `file`          — optional receipt / statement upload (8 MB max)

    Effects mirror the client-facing flow: upload is attached to both
    the source doc and the batch item; receipts (types 3, 8, 10, 14)
    are mirrored into `db.receipts`; the item's typed handler runs
    (writing `irs_substantiation` onto the transaction for types 10/14);
    the batch item is stamped `answered_at` + `answered_by_pro`.
    """
    import base64, json, uuid as _uuid
    from client_review_handlers import apply_answer
    from routes.client_review import _mirror_upload_to_receipts_page

    await require_company(user, cid)

    batch = await db.client_review_batches.find_one(
        {"company_id": cid, "status": {"$in": ["open", "scheduled"]}},
        sort=[("created_at", -1)],
    )
    if not batch:
        raise HTTPException(404, "No open check-in batch for this company")
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in current batch")
    if item.get("answered_at") or item.get("deferred"):
        raise HTTPException(409, "Item already finalized")

    # Parse structured payload from the multipart string field. Bad
    # JSON degrades to `{}` — the answer text alone still records.
    try:
        payload = json.loads(payload_json or "{}")
        if not isinstance(payload, dict):
            payload = {}
    except Exception:  # noqa: BLE001
        payload = {}
    # Stamp actor context — the IRS handler reads this to fill the
    # substantiation sub-doc on the transaction.
    payload["answered_by_pro"] = True
    payload["pro_email"] = user.get("email") or user.get("id")

    # ---- Optional file upload ----------------------------------------
    attachment: dict | None = None
    if file is not None:
        data = await file.read()
        if data:
            if len(data) > 8 * 1024 * 1024:
                raise HTTPException(413, "File too large (8 MB max)")
            b64 = base64.b64encode(data).decode("ascii")
            mime = file.content_type or "application/octet-stream"
            data_url = f"data:{mime};base64,{b64}"
            attachment = {
                "id":         str(_uuid.uuid4()),
                "filename":   file.filename or "upload",
                "size":       len(data),
                "mime":       mime,
                "data_url":   data_url,
                "kind":       "receipt",
                "uploaded_at": now_iso(),
                "uploaded_by": f"pro:{user.get('email') or user.get('id')}",
            }
            # Mirror onto both the source doc (so the txn/finding page
            # shows it in context) and the batch item.
            coll = item.get("source_collection")
            if coll in ("agent_findings", "transactions", "contacts"):
                await db[coll].update_one(
                    {"id": item["source_id"], "company_id": cid},
                    {"$push": {"attachments": attachment},
                     "$set":  {"updated_at": now_iso()}},
                )
            attachments = (item.get("attachments") or []) + [attachment]
            await db.client_review_batches.update_one(
                {"id": batch["id"], "items.item_id": item_id},
                {"$set": {"items.$.attachments": attachments,
                          "updated_at":          now_iso()}},
            )
            # For receipt-bearing types, push a copy to `db.receipts`.
            # Enrich the item context with IRS substantiation fields
            # so the mirror can bake them into the receipt notes.
            if item.get("item_type") in (3, 8, 10, 14):
                enriched = dict(item)
                ctx = dict(item.get("context") or {})
                meta = dict(ctx.get("meta") or {})
                for k in ("business_purpose", "attendees", "destination",
                          "trip_start", "trip_end"):
                    if payload.get(k):
                        meta[k] = payload[k]
                ctx["meta"] = meta
                enriched["context"] = ctx
                await _mirror_upload_to_receipts_page(batch, enriched, attachment)

    # ---- Run the typed answer handler --------------------------------
    result = await apply_answer(item, batch, answer=answer, payload=payload)

    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": item_id},
        {"$set": {
            "items.$.answered_at":         now_iso(),
            "items.$.answer":              answer,
            "items.$.action_taken":        result.get("action_taken"),
            "items.$.action_detail":       result.get("detail"),
            "items.$.answered_by_pro":     True,
            "items.$.answered_by_email":   payload.get("pro_email"),
            "items.$.answered_payload":    {k: v for k, v in payload.items()
                                            if k not in ("answered_by_pro",
                                                         "pro_email")},
            "updated_at":                  now_iso(),
        },
         "$inc": {"answer_count": 1}},
    )
    return {"ok": True,
            "attachment_id": (attachment or {}).get("id"),
            **result}


# ─────────────────────────────────────────────────────────────────────────────
# Voice-fill for the inline Answer form. One mic per instance:
# user records a short utterance ("Lunch with John from Acme about Q4
# pricing"), we transcribe with Whisper and run a tiny LLM extraction
# to split the transcript into the form's structured fields. Frontend
# sparkle-fills the fields; user reviews + submits.
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/companies/{cid}/checkin/voice-extract")
async def voice_extract_checkin(
    cid: str,
    audio: UploadFile = File(...),
    item_type: int = Form(...),
    txn_context_json: str = Form("{}"),
    user: dict = Depends(get_current_user),
):
    """Transcribe an audio blob + extract structured substantiation
    fields relevant to this item type.

    Body (multipart):
      • `audio`             — webm / mp3 / wav / m4a blob (25 MB max)
      • `item_type`         — 10 (meals) | 14 (travel) | 3 (receipt) | ...
      • `txn_context_json`  — {merchant, amount, date} — gives Whisper +
                              the extractor grounded context so the AI
                              knows what transaction is being described.

    Returns:
      {
        "transcript": str,
        "extracted": {
          "attendees":         str | null,
          "business_purpose":  str | null,
          "destination":       str | null,
          "trip_start":        "YYYY-MM-DD" | null,
          "trip_end":          "YYYY-MM-DD" | null,
          "notes":             str | null,   # anything that didn't fit
          "payee_name":        str | null,
        }
      }

    Actor is authenticated but we don't require the batch — this is a
    pure text-transformation endpoint, and it's stateless so the form
    can call it before the user commits to submitting.
    """
    import io, json, os
    await require_company(user, cid)

    if audio.content_type and not any(t in audio.content_type for t in (
        "audio", "webm", "mp3", "mp4", "mpeg", "mpga", "m4a", "wav",
    )):
        raise HTTPException(400, f"Unsupported audio type: {audio.content_type}")

    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty audio blob")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "Audio too large (25 MB max)")

    # Parse the transaction context — used both as a Whisper `prompt`
    # (nudges vendor spelling) and as grounding for the extractor.
    try:
        ctx = json.loads(txn_context_json or "{}")
        if not isinstance(ctx, dict): ctx = {}
    except Exception:  # noqa: BLE001
        ctx = {}
    merchant = str(ctx.get("merchant") or "").strip()
    amount   = ctx.get("amount")
    date     = str(ctx.get("date") or "").strip()

    # ---- Whisper transcription ----
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(500, "Server LLM key not configured")

    from emergentintegrations.llm.openai import OpenAISpeechToText
    # Whisper needs a file-like with a `.name` for format detection.
    ext_map = {"audio/webm": "webm", "audio/mp3": "mp3", "audio/mpeg": "mp3",
               "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-m4a": "m4a"}
    ext = ext_map.get(audio.content_type or "", "webm")
    filename = audio.filename or f"utterance.{ext}"
    buf = io.BytesIO(data)
    buf.name = filename

    stt = OpenAISpeechToText(api_key=api_key)
    hint = (f"Business meal at {merchant}." if item_type == 10 and merchant
            else (f"Business trip. " if item_type == 14 else ""))
    try:
        stt_resp = await stt.transcribe(
            file=buf,
            model="whisper-1",
            response_format="json",
            language="en",
            prompt=hint or None,
            temperature=0.0,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Transcription failed: {e}")

    transcript = (getattr(stt_resp, "text", None) or "").strip()
    if not transcript:
        return {"transcript": "", "extracted": {}}

    # ---- Structured extraction via chat LLM ----
    # We use a small deterministic prompt that always returns JSON.
    # Anything the model isn't confident about → null (never guess).
    txn_ctx_lines = []
    if merchant: txn_ctx_lines.append(f"merchant: {merchant}")
    if amount is not None: txn_ctx_lines.append(f"amount: {amount}")
    if date:     txn_ctx_lines.append(f"date: {date}")
    txn_ctx = "\n".join(txn_ctx_lines) or "(no transaction context)"

    type_hints = {
        10: ("IRS §274 meals-and-entertainment substantiation. Focus on "
             "WHO attended (names + affiliations) and the BUSINESS PURPOSE "
             "of the meal."),
        14: ("IRS §274 travel substantiation. Focus on DESTINATION, "
             "BUSINESS PURPOSE, and TRIP DATES if mentioned."),
        3:  ("Missing-receipt follow-up. Capture the business purpose or "
             "memo. Do NOT invent attendees or destinations."),
        13: ("Check-with-missing-payee. Extract the PAYEE NAME. Do NOT "
             "invent other fields."),
    }
    task = type_hints.get(item_type, "Extract any relevant substantiation fields.")

    system_prompt = (
        "You extract structured bookkeeping-compliance fields from a "
        "one-sentence dictation. Return STRICT JSON only — no prose, "
        "no markdown. Every field is optional; set unknown fields to "
        "null. NEVER invent details that are not clearly stated in the "
        "dictation.\n\n"
        f"Task context: {task}\n\n"
        "Schema: {\"attendees\": string|null, \"business_purpose\": "
        "string|null, \"destination\": string|null, \"trip_start\": "
        "\"YYYY-MM-DD\"|null, \"trip_end\": \"YYYY-MM-DD\"|null, "
        "\"notes\": string|null, \"payee_name\": string|null}"
    )
    user_prompt = (
        f"Transcript: \"{transcript}\"\n\n"
        f"Transaction context:\n{txn_ctx}\n\n"
        "Return JSON only."
    )

    from emergentintegrations.llm.chat import LlmChat, UserMessage
    chat = (LlmChat(
        api_key=api_key,
        session_id=f"voice-extract-{cid}-{uuid.uuid4().hex[:8]}",
        system_message=system_prompt,
    )
        .with_model("openai", "gpt-4o-mini"))
    try:
        reply = await chat.send_message(UserMessage(text=user_prompt))
    except Exception as e:  # noqa: BLE001
        # Extraction failed — degrade gracefully to just returning the
        # transcript in the notes field. User can hand-fill.
        return {"transcript": transcript,
                "extracted": {"notes": transcript}}

    # Try to parse JSON — model sometimes wraps in ``` fences even
    # when instructed not to; strip them defensively.
    raw = (reply or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:].lstrip()
    try:
        extracted = json.loads(raw)
        if not isinstance(extracted, dict):
            extracted = {"notes": transcript}
    except Exception:  # noqa: BLE001
        extracted = {"notes": transcript}

    # Prune empty / null / whitespace values.
    extracted = {k: v for k, v in extracted.items()
                 if v not in (None, "", "null") and not
                 (isinstance(v, str) and not v.strip())}

    # Whitelist per item_type — the LLM sometimes over-fills fields
    # that aren't relevant to this substantiation category (e.g.
    # stamping the merchant as "destination" on a meals row). Keep
    # only the fields the form actually renders for this type.
    FIELDS_BY_TYPE = {
        10: {"attendees", "business_purpose", "notes"},
        14: {"attendees", "business_purpose", "destination",
             "trip_start", "trip_end", "notes"},
        3:  {"notes"},
        9:  {"notes"},
        13: {"payee_name", "notes"},
    }
    allowed = FIELDS_BY_TYPE.get(item_type, set())
    if allowed:
        extracted = {k: v for k, v in extracted.items() if k in allowed}

    return {"transcript": transcript, "extracted": extracted}


# ─────────────────────────────────────────────────────────────────────────────
# Firm-authenticated wrappers for the Checks-without-payee allocator.
# Reuses the token-side helpers so both surfaces behave identically.
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/companies/{cid}/checkin/pickable")
async def get_checkin_pickable(
    cid: str, user: dict = Depends(get_current_user),
):
    """Accounts + open bills for the inline check allocator dropdowns.
    Same shape as the token-side `/client-review/{token}/pickable`."""
    await require_company(user, cid)
    from routes.client_review import load_pickable_options
    return await load_pickable_options(cid)


@router.post("/companies/{cid}/checkin/items/{item_id}/check-assign")
async def post_checkin_check_assign(
    cid: str, item_id: str, body: dict = None,
    user: dict = Depends(get_current_user),
):
    """Firm-authenticated wrapper around the token-side check-assign
    endpoint. Finds the current open batch for this company + item
    and delegates to the shared implementation, so the inline
    allocator on the Client Cockpit / To Do saves each check row
    exactly the way the client-facing magic-link Check-in would."""
    await require_company(user, cid)
    from routes.client_review import apply_check_assign, CheckAssignBody
    batch = await db.client_review_batches.find_one(
        {"company_id": cid, "status": {"$in": ["open", "scheduled"]}},
        sort=[("created_at", -1)],
    )
    if not batch:
        raise HTTPException(404, "No open check-in batch for this company")
    item = next((i for i in (batch.get("items") or [])
                 if i.get("item_id") == item_id), None)
    if not item:
        raise HTTPException(404, "Item not in current batch")
    try:
        parsed = CheckAssignBody(**(body or {}))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"Invalid body: {e}")
    return await apply_check_assign(batch, item, parsed)


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



@router.get("/companies/{cid}/responsibilities/overdue-invoices")
async def overdue_invoices_detail(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Return the list of open invoices past due today for the given
    company. Powers the inline dropdown on the "Following up with
    invoices" row on the Responsibilities panel.
    """
    await require_company(user, cid)
    now_date = datetime.now(timezone.utc).date().isoformat()
    docs = await db.invoices.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided"]},
        "due_date": {"$lt": now_date, "$ne": None},
        "$or": [
            {"cockpit_snooze_until": {"$exists": False}},
            {"cockpit_snooze_until": None},
            {"cockpit_snooze_until": {"$lte": now_date}},
        ],
    }).sort("due_date", 1).to_list(500)

    # Also fetch active invoice snoozes for the header chip + inline view.
    snoozed_docs = await db.invoices.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided"]},
        "cockpit_snooze_until": {"$gt": now_date},
    }).sort("cockpit_snooze_until", 1).to_list(500)

    # Resolve contact names in one round-trip.
    contact_ids = list({d.get("contact_id") for d in (docs + snoozed_docs) if d.get("contact_id")})
    contacts_by_id: dict = {}
    if contact_ids:
        contact_docs = await db.contacts.find({"id": {"$in": contact_ids}}).to_list(1000)
        contacts_by_id = {c["id"]: c for c in contact_docs}

    total_open = await db.invoices.count_documents({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided"]},
    })

    out: list[dict] = []
    for d in docs:
        c = contacts_by_id.get(d.get("contact_id")) if d.get("contact_id") else None
        total = float(d.get("total") or 0.0)
        balance = float(d.get("balance_due") if d.get("balance_due") is not None else total)
        out.append({
            "id": d.get("id"),
            "number": d.get("number") or d.get("invoice_number") or "—",
            "contact_id": d.get("contact_id"),
            "customer_name": (c or {}).get("name") or d.get("contact_name") or "—",
            "customer_email": (c or {}).get("email"),
            "issue_date": d.get("issue_date"),
            "due_date": d.get("due_date"),
            "total": total,
            "balance": balance,
            "status": d.get("status") or "sent",
            "followup_count": len(d.get("followup_history") or []),
            "last_followup_at": d.get("last_followup_at"),
            "followup_schedule": d.get("followup_schedule"),
        })
    snoozed_out: list[dict] = []
    for d in snoozed_docs:
        c = contacts_by_id.get(d.get("contact_id")) if d.get("contact_id") else None
        total = float(d.get("total") or 0.0)
        balance = float(d.get("balance_due") if d.get("balance_due") is not None else total)
        snoozed_out.append({
            "id": d.get("id"),
            "number": d.get("number") or d.get("invoice_number") or "—",
            "contact_id": d.get("contact_id"),
            "customer_name": (c or {}).get("name") or d.get("contact_name") or "—",
            "due_date": d.get("due_date"),
            "total": total,
            "balance": balance,
            "status": d.get("status") or "sent",
            "snoozed_until": d.get("cockpit_snooze_until"),
            "snoozed_reason": d.get("cockpit_snooze_reason"),
            "snoozed_by": d.get("cockpit_snoozed_by"),
            "snoozed_at": d.get("cockpit_snoozed_at"),
        })
    return {
        "as_of": now_date,
        "overdue_count": len(out),
        "snoozed_count": len(snoozed_out),
        "total_open_count": int(total_open),
        "invoices": out,
        "snoozed_invoices": snoozed_out,
    }



@router.get("/companies/{cid}/responsibilities/overdue-bills")
async def overdue_bills_detail(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Return the list of open bills past due today for the given
    company. Powers the inline dropdown on the "Paying bills" row
    on the Responsibilities panel.
    """
    await require_company(user, cid)
    now_date = datetime.now(timezone.utc).date().isoformat()
    docs = await db.bills.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided", "cancelled"]},
        "due_date": {"$lt": now_date, "$ne": None},
        "$or": [
            {"cockpit_snooze_until": {"$exists": False}},
            {"cockpit_snooze_until": None},
            {"cockpit_snooze_until": {"$lte": now_date}},
        ],
    }).sort("due_date", 1).to_list(500)

    # Also fetch the active snoozes so the tile can surface a small
    # "N snoozed" chip that opens a drawer for un-snoozing.
    snoozed_docs = await db.bills.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided", "cancelled"]},
        "cockpit_snooze_until": {"$gt": now_date},
    }).sort("cockpit_snooze_until", 1).to_list(500)

    # Resolve vendor names in one round-trip. Bills store either
    # `contact_id` or the legacy `vendor_id`.
    vendor_ids = list({(d.get("contact_id") or d.get("vendor_id")) for d in (docs + snoozed_docs) if (d.get("contact_id") or d.get("vendor_id"))})
    vendors_by_id: dict = {}
    if vendor_ids:
        v_docs = await db.contacts.find({"id": {"$in": vendor_ids}}).to_list(1000)
        vendors_by_id = {v["id"]: v for v in v_docs}

    total_open = await db.bills.count_documents({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided", "cancelled"]},
    })

    out: list[dict] = []
    for d in docs:
        vid = d.get("contact_id") or d.get("vendor_id")
        v = vendors_by_id.get(vid) if vid else None
        total = float(d.get("total") or 0.0)
        balance = float(d.get("balance_due") if d.get("balance_due") is not None else total)
        out.append({
            "id": d.get("id"),
            "number": d.get("number") or d.get("bill_number") or "—",
            "vendor_id": vid,
            "vendor_name": (v or {}).get("name") or d.get("vendor_name") or d.get("contact_name") or "—",
            "vendor_email": (v or {}).get("email"),
            "issue_date": d.get("issue_date") or d.get("date"),
            "due_date": d.get("due_date"),
            "total": total,
            "balance": balance,
            "status": d.get("status") or "open",
        })
    snoozed_out: list[dict] = []
    for d in snoozed_docs:
        vid = d.get("contact_id") or d.get("vendor_id")
        v = vendors_by_id.get(vid) if vid else None
        total = float(d.get("total") or 0.0)
        balance = float(d.get("balance_due") if d.get("balance_due") is not None else total)
        snoozed_out.append({
            "id": d.get("id"),
            "number": d.get("number") or d.get("bill_number") or "—",
            "vendor_id": vid,
            "vendor_name": (v or {}).get("name") or d.get("vendor_name") or d.get("contact_name") or "—",
            "due_date": d.get("due_date"),
            "total": total,
            "balance": balance,
            "status": d.get("status") or "open",
            "snoozed_until": d.get("cockpit_snooze_until"),
            "snoozed_reason": d.get("cockpit_snooze_reason"),
            "snoozed_by": d.get("cockpit_snoozed_by"),
            "snoozed_at": d.get("cockpit_snoozed_at"),
        })
    return {
        "as_of": now_date,
        "overdue_count": len(out),
        "snoozed_count": len(snoozed_out),
        "total_open_count": int(total_open),
        "bills": out,
        "snoozed_bills": snoozed_out,
    }


class SnoozeBillIn(BaseModel):
    until: str  # YYYY-MM-DD (inclusive; the bill reappears the day AFTER)
    reason: Optional[str] = None


@router.post("/companies/{cid}/bills/{bid}/cockpit-snooze")
async def snooze_bill_in_cockpit(
    cid: str, bid: str, inp: SnoozeBillIn, user: dict = Depends(get_current_user),
):
    """Hide a bill from the Paying Bills cockpit tile + To Do view
    until the given date. Does NOT change the bill's ledger status —
    it only affects surfaces that filter on `cockpit_snooze_until`."""
    await require_company(user, cid)
    # Validate date shape.
    try:
        datetime.fromisoformat(inp.until)
    except Exception:
        raise HTTPException(400, "Invalid `until` date. Use YYYY-MM-DD.")
    r = await db.bills.update_one(
        {"id": bid, "company_id": cid},
        {"$set": {
            "cockpit_snooze_until": inp.until,
            "cockpit_snooze_reason": (inp.reason or None),
            "cockpit_snoozed_at": datetime.now(timezone.utc).isoformat(),
            "cockpit_snoozed_by": user.get("email") or user.get("id"),
        }},
    )
    if not r.matched_count:
        raise HTTPException(404, "Bill not found")
    return {"ok": True, "cockpit_snooze_until": inp.until}


@router.delete("/companies/{cid}/bills/{bid}/cockpit-snooze")
async def unsnooze_bill_in_cockpit(
    cid: str, bid: str, user: dict = Depends(get_current_user),
):
    """Clear an existing cockpit snooze so the bill reappears immediately."""
    await require_company(user, cid)
    r = await db.bills.update_one(
        {"id": bid, "company_id": cid},
        {"$unset": {
            "cockpit_snooze_until": "",
            "cockpit_snooze_reason": "",
            "cockpit_snoozed_at": "",
            "cockpit_snoozed_by": "",
        }},
    )
    if not r.matched_count:
        raise HTTPException(404, "Bill not found")
    return {"ok": True}



# ─────────────────────────────────────────────────────────────────────────────
# Invoice snooze — mirror of the bill snooze, used by the Following Up With
# Invoices tile so a CPA can quiet a "waiting on customer promise-to-pay"
# invoice for a few days.
# ─────────────────────────────────────────────────────────────────────────────

class SnoozeInvoiceIn(BaseModel):
    until: str
    reason: Optional[str] = None


@router.post("/companies/{cid}/invoices/{iid}/cockpit-snooze")
async def snooze_invoice_in_cockpit(
    cid: str, iid: str, inp: SnoozeInvoiceIn, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    try:
        datetime.fromisoformat(inp.until)
    except Exception:
        raise HTTPException(400, "Invalid `until` date. Use YYYY-MM-DD.")
    r = await db.invoices.update_one(
        {"id": iid, "company_id": cid},
        {"$set": {
            "cockpit_snooze_until": inp.until,
            "cockpit_snooze_reason": (inp.reason or None),
            "cockpit_snoozed_at": datetime.now(timezone.utc).isoformat(),
            "cockpit_snoozed_by": user.get("email") or user.get("id"),
        }},
    )
    if not r.matched_count:
        raise HTTPException(404, "Invoice not found")
    return {"ok": True, "cockpit_snooze_until": inp.until}


@router.delete("/companies/{cid}/invoices/{iid}/cockpit-snooze")
async def unsnooze_invoice_in_cockpit(
    cid: str, iid: str, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    r = await db.invoices.update_one(
        {"id": iid, "company_id": cid},
        {"$unset": {
            "cockpit_snooze_until": "",
            "cockpit_snooze_reason": "",
            "cockpit_snoozed_at": "",
            "cockpit_snoozed_by": "",
        }},
    )
    if not r.matched_count:
        raise HTTPException(404, "Invoice not found")
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Automated Follow-up Schedule — per-invoice recurring chase config. The
# Tuesday-morning cron reads these + fires `POST /invoices/{iid}/send-email`
# when the next run is due.
# ─────────────────────────────────────────────────────────────────────────────

class FollowupStepIn(BaseModel):
    days_from_now: int
    template_key: Optional[str] = None


class FollowupScheduleIn(BaseModel):
    enabled: bool
    # Discrete list of scheduled follow-up sends. Each step fires once
    # at (now + days_from_now) from when the schedule was saved.
    steps: list[FollowupStepIn] = []


@router.get("/companies/{cid}/invoices/{iid}/followup-schedule")
async def get_followup_schedule(
    cid: str, iid: str, user: dict = Depends(get_current_user),
):
    """Return the current schedule + a computed `next_run_at` preview."""
    await require_company(user, cid)
    inv = await db.invoices.find_one(
        {"id": iid, "company_id": cid},
        {"followup_schedule": 1, "followup_history": 1, "last_followup_at": 1, "number": 1},
    )
    if not inv:
        raise HTTPException(404, "Invoice not found")
    schedule = inv.get("followup_schedule") or {}
    history = list(inv.get("followup_history") or [])
    auto_sends = [h for h in history if h.get("origin") in ("auto", "schedule")]
    # Next unsent step whose run_at is in the future.
    now_iso = datetime.now(timezone.utc).isoformat()
    steps = list(schedule.get("steps") or [])
    next_step = None
    if schedule.get("enabled"):
        pending = [s for s in steps if not s.get("sent_at") and (s.get("run_at") or "") >= now_iso]
        pending.sort(key=lambda s: s.get("run_at") or "")
        next_step = pending[0] if pending else None
    return {
        "invoice_id": iid,
        "invoice_number": inv.get("number"),
        "schedule": schedule,
        "auto_sends_used": len(auto_sends),
        "next_run_at": (next_step or {}).get("run_at"),
        "last_followup_at": inv.get("last_followup_at"),
    }


@router.post("/companies/{cid}/invoices/{iid}/followup-schedule")
async def set_followup_schedule(
    cid: str, iid: str, inp: FollowupScheduleIn, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    now = datetime.now(timezone.utc)
    # Preserve existing sent_at markers so re-saving doesn't re-send an
    # already-sent step. Match by ordinal index for simplicity.
    existing = await db.invoices.find_one(
        {"id": iid, "company_id": cid},
        {"followup_schedule": 1, "contact_id": 1},
    )
    if not existing:
        raise HTTPException(404, "Invoice not found")
    # Hard gate: cannot enable an active schedule without a valid customer
    # email on file. The scheduler would just skip forever otherwise, so
    # we surface the fix-it moment at save time.
    if inp.enabled and inp.steps:
        contact_email = ""
        if existing.get("contact_id"):
            contact = await db.contacts.find_one(
                {"id": existing["contact_id"], "company_id": cid},
                {"email": 1},
            )
            contact_email = ((contact or {}).get("email") or "").strip()
        if not contact_email or "@" not in contact_email:
            raise HTTPException(
                400,
                "Customer has no email on file. Add one before scheduling follow-ups.",
            )
    prior_steps = list((existing.get("followup_schedule") or {}).get("steps") or [])

    steps_out: list[dict] = []
    for idx, s in enumerate(inp.steps):
        days = max(0, int(s.days_from_now))
        run_at = (now + timedelta(days=days)).isoformat()
        prior = prior_steps[idx] if idx < len(prior_steps) else {}
        steps_out.append({
            "days_from_now": days,
            "template_key": s.template_key or None,
            "run_at": run_at,
            "sent_at": prior.get("sent_at"),
            "sent_status": prior.get("sent_status"),
        })
    schedule = {
        "enabled": bool(inp.enabled),
        "steps": steps_out,
        "updated_at": now.isoformat(),
        "updated_by": user.get("email") or user.get("id"),
    }
    await db.invoices.update_one(
        {"id": iid, "company_id": cid},
        {"$set": {"followup_schedule": schedule}},
    )
    return {"ok": True, "schedule": schedule}



@router.post("/admin/invoice-followups/run-now")
async def invoice_followup_run_now(user: dict = Depends(get_current_user)):
    """Fire the invoice follow-up scheduler once for the current process
    without waiting for the next 5-minute tick. Used for testing + when
    a CPA wants to trigger an immediate scan after saving a schedule."""
    if not (user.get("is_superadmin") or user.get("is_admin") or user.get("role") in ("superadmin", "admin")):
        raise HTTPException(403, "Superadmin/admin only")
    import invoice_followup_scheduler as _ifs
    return await _ifs.run_once()

