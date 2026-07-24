"""Firm at a Glance dashboard view.

Powers the "Firm at a Glance" toggle on `/dashboard` — a QBO-Accountant-style
overview: Sales & Get Paid funnel, Bank Accounts panel, month-scoped Profit
& Loss with quarter comparison, and Expense breakdown for the donut chart.

Everything the view needs is packaged into a single response so the frontend
only has to fire one request per month change.
"""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query

from db import db
from auth import get_current_user
from deps import require_company, DASH_CACHE_TTL
from infra import get_cache
import reports as R

router = APIRouter(prefix="/api")


# Fixed palette for the expenses donut so the same category keeps the same
# color across renders — matches the emerald / red / amber / violet / cyan
# family used elsewhere in the app.
_DONUT_COLORS = [
    "#ef4444",  # red
    "#f97316",  # orange
    "#eab308",  # amber
    "#10b981",  # emerald
    "#06b6d4",  # cyan
    "#6366f1",  # indigo
    "#8b5cf6",  # violet
    "#ec4899",  # pink
    "#64748b",  # slate (Other)
]


def _month_range(month: Optional[str]) -> tuple[str, str, str]:
    """Return (start_iso, end_iso, month_label) for a `YYYY-MM` input.
    Defaults to the current calendar month when `month` is falsy."""
    today = datetime.now(timezone.utc).date()
    if month:
        y, m = [int(x) for x in month.split("-")]
    else:
        y, m = today.year, today.month
    last = (datetime(y + (m == 12), (m % 12) + 1, 1) - timedelta(days=1)).day
    start = f"{y:04d}-{m:02d}-01"
    end = f"{y:04d}-{m:02d}-{last:02d}"
    label = datetime(y, m, 1).strftime("%B %Y")
    return start, end, label


def _prev_quarter_range(month: Optional[str]) -> tuple[str, str]:
    """Return (start, end) covering the 3 calendar months ENDING just before
    the anchor month — used to compute the "vs last quarter" delta shown on
    the Profit & Loss card. Anchor `2026-03` → returns 2025-12-01 to 2026-02-28."""
    today = datetime.now(timezone.utc).date()
    y, m = (today.year, today.month) if not month else [int(x) for x in month.split("-")]
    # last month = m-1
    end_m = m - 1 if m > 1 else 12
    end_y = y if m > 1 else y - 1
    end_last_day = (datetime(end_y + (end_m == 12), (end_m % 12) + 1, 1) - timedelta(days=1)).day
    end = f"{end_y:04d}-{end_m:02d}-{end_last_day:02d}"
    # start = 3 months earlier
    start_m = end_m - 2
    start_y = end_y
    while start_m < 1:
        start_m += 12
        start_y -= 1
    start = f"{start_y:04d}-{start_m:02d}-01"
    return start, end


def _prev_month_range(month: Optional[str]) -> tuple[str, str]:
    today = datetime.now(timezone.utc).date()
    y, m = (today.year, today.month) if not month else [int(x) for x in month.split("-")]
    pm = m - 1 if m > 1 else 12
    py = y if m > 1 else y - 1
    last = (datetime(py + (pm == 12), (pm % 12) + 1, 1) - timedelta(days=1)).day
    return f"{py:04d}-{pm:02d}-01", f"{py:04d}-{pm:02d}-{last:02d}"


def _pct_delta(cur: float, prev: float) -> Optional[float]:
    """Signed percentage change from `prev` to `cur`. Returns None when the
    prior period is zero (no meaningful baseline)."""
    if not prev:
        return None
    return round(100.0 * (cur - prev) / abs(prev), 1)


async def _bank_accounts_panel(cid: str, today_iso: str) -> dict:
    """Bank-side rollup: total balance, per-account balance, per-account
    to-review count. `to_review` = posted rows still flagged `needs_review`
    on that bank account."""
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset",
        "$or": [
            {"code": {"$gte": "1000", "$lte": "1099"}},
            {"subtype": "Bank"},
        ],
    }).to_list(200)

    async def _for(a):
        aid = a["id"]
        # sum of posted txn amounts against this bank account (matches
        # dashboard/metrics cash_on_hand logic — asset-normal-debit so a
        # positive txn amount increases balance).
        txns = await db.transactions.find(
            {"company_id": cid, "posted": True, "bank_account_id": aid}
        ).to_list(20000)
        bal = sum(float(t.get("amount", 0)) for t in txns)
        # Add JE lines hitting this account.
        jes = await db.journal_entries.find({"company_id": cid}).to_list(20000)
        for j in jes:
            for l in j.get("lines", []):
                if l.get("account_id") == aid:
                    bal += float(l.get("debit", 0) or 0) - float(l.get("credit", 0) or 0)
        to_review = await db.transactions.count_documents(
            {"company_id": cid, "bank_account_id": aid, "needs_review": True}
        )
        return {
            "id": aid,
            "name": a.get("name") or "Bank account",
            "code": a.get("code") or "",
            "balance": round(bal, 2),
            "to_review": to_review,
        }

    rows = await asyncio.gather(*[_for(a) for a in accts]) if accts else []
    # Hide dead $0 accounts with no review debt so the panel stays clean.
    rows = [r for r in rows if r["balance"] or r["to_review"]]
    rows.sort(key=lambda r: -r["balance"])
    return {
        "total_balance": round(sum(r["balance"] for r in rows), 2),
        "as_of_date": today_iso,
        "accounts": rows[:6],  # cap at 6 to keep the card tidy
    }


async def _sales_funnel(cid: str, start: str, end: str, today_iso: str) -> dict:
    """QBO-style Sales & Get Paid funnel scoped to a calendar month.
      - not_paid:   invoices with balance_due > 0 as of today (open bucket)
      - paid:       invoices whose status flipped to `paid` within [start,end]
                    OR that were created & fully paid inside the window
      - deposited:  paid invoices whose linked payment actually cleared the
                    bank (posted transaction against a cash account)
    Also returns the individual `overdue_invoices` list so the Firm at a
    Glance card can pop up an inline "Send reminder" affordance without a
    second round-trip.
    """
    invs = await db.invoices.find({"company_id": cid}).to_list(20000)

    not_paid_amt = 0.0
    not_paid_ct = 0
    overdue_ct = 0
    overdue_rows: list[dict] = []
    # Preload contacts so we can attach email addresses to overdue rows.
    contact_ids = {i.get("contact_id") for i in invs if i.get("contact_id")}
    contact_map = {}
    if contact_ids:
        async for c in db.contacts.find({"company_id": cid, "id": {"$in": list(contact_ids)}}):
            contact_map[c["id"]] = c

    for i in invs:
        if i.get("status") == "paid":
            continue
        bal = float(i.get("balance_due") or 0)
        if bal <= 0:
            continue
        not_paid_amt += bal
        not_paid_ct += 1
        if i.get("due_date") and i["due_date"] < today_iso:
            overdue_ct += 1
            try:
                d_due = datetime.fromisoformat(i["due_date"]).date()
                days_late = (datetime.now(timezone.utc).date() - d_due).days
            except (TypeError, ValueError):
                days_late = 0
            c = contact_map.get(i.get("contact_id") or "") or {}
            overdue_rows.append({
                "id": i["id"],
                "number": i.get("number") or "",
                "contact_name": i.get("contact_name") or c.get("display_name") or c.get("name") or "Customer",
                "contact_email": c.get("email"),
                "amount": round(bal, 2),
                "days_overdue": days_late,
                "due_date": i.get("due_date"),
                "last_reminder_sent_at": i.get("last_reminder_sent_at"),
            })
    overdue_rows.sort(key=lambda r: -r["days_overdue"])

    # Paid this month: invoices with status=paid whose most-recent update
    # (updated_at) or issue_date falls inside the month. Doubles as
    # "closed within window" without needing a separate `paid_at` field.
    def _in_month(d: str | None) -> bool:
        return bool(d) and start <= d <= end

    paid_amt = 0.0
    paid_ct = 0
    on_hold_ct = 0
    for i in invs:
        if i.get("status") != "paid":
            # Track "on hold" pseudo-status for the Paid bucket footnote
            if i.get("status") in ("void", "on_hold") and _in_month(i.get("issue_date")):
                on_hold_ct += 1
            continue
        ref = i.get("updated_at") or i.get("issue_date") or ""
        ref_day = ref[:10] if len(ref) >= 10 else ""
        if _in_month(ref_day):
            paid_amt += float(i.get("total") or 0)
            paid_ct += 1

    # Deposited: cash-account transactions in the month that came from a
    # payment linked to an invoice. This is a proxy — the app doesn't yet
    # persist explicit "deposit batch" records.
    cash_accts = await db.accounts.find({
        "company_id": cid, "type": "asset",
        "$or": [{"code": {"$gte": "1000", "$lte": "1099"}}, {"subtype": "Bank"}],
    }).to_list(200)
    cash_ids = [a["id"] for a in cash_accts]
    deposited_amt = 0.0
    deposited_ct = 0
    if cash_ids:
        recent = await db.transactions.find({
            "company_id": cid, "posted": True,
            "bank_account_id": {"$in": cash_ids},
            "date": {"$gte": start, "$lte": end},
            "amount": {"$gt": 0},
        }).to_list(20000)
        for t in recent:
            # Heuristic: positive-amount postings against a cash account
            # inside the window that reference an invoice are "deposited".
            if (t.get("invoice_id") or t.get("linked_invoice_id")
                    or (t.get("tags") and "invoice_payment" in (t.get("tags") or []))):
                deposited_amt += float(t.get("amount") or 0)
                deposited_ct += 1

    return {
        "not_paid": {
            "amount": round(not_paid_amt, 2),
            "count": not_paid_ct,
            "overdue_count": overdue_ct,
            "overdue_invoices": overdue_rows[:25],  # cap to keep payload lean
        },
        "paid": {
            "amount": round(paid_amt, 2),
            "count": paid_ct,
            "on_hold_count": on_hold_ct,
        },
        "deposited": {
            "amount": round(deposited_amt, 2),
            "count": deposited_ct,
        },
    }


async def _pl_card(cid: str, start: str, end: str, month: Optional[str], basis: str) -> dict:
    """Month P&L totals + `X to review` counts on income/expense rows +
    signed % delta vs the prior calendar quarter (average per month)."""
    inc = await R.compute_income_statement(cid, start, end, basis)
    prev_s, prev_e = _prev_quarter_range(month)
    prev = await R.compute_income_statement(cid, prev_s, prev_e, basis)
    # Compare current month vs AVERAGE month of prior quarter for a fair delta
    prev_monthly_avg = float(prev.get("net_income") or 0) / 3.0
    delta = _pct_delta(float(inc.get("net_income") or 0), prev_monthly_avg)

    income_acct_ids = [
        a["id"] for a in await db.accounts.find(
            {"company_id": cid, "type": "revenue"}
        ).to_list(500)
    ]
    expense_acct_ids = [
        a["id"] for a in await db.accounts.find(
            {"company_id": cid, "type": "expense"}
        ).to_list(500)
    ]
    inc_review, exp_review = await asyncio.gather(
        db.transactions.count_documents({
            "company_id": cid, "needs_review": True,
            "date": {"$gte": start, "$lte": end},
            "category_account_id": {"$in": income_acct_ids} if income_acct_ids else None,
        }) if income_acct_ids else asyncio.sleep(0, result=0),
        db.transactions.count_documents({
            "company_id": cid, "needs_review": True,
            "date": {"$gte": start, "$lte": end},
            "category_account_id": {"$in": expense_acct_ids} if expense_acct_ids else None,
        }) if expense_acct_ids else asyncio.sleep(0, result=0),
    )

    return {
        "net_profit": float(inc.get("net_income") or 0),
        "income": float(inc.get("total_revenue") or 0),
        "expense": float(inc.get("total_expense") or 0),
        "income_to_review": int(inc_review or 0),
        "expense_to_review": int(exp_review or 0),
        "delta_pct_vs_last_quarter": delta,
    }


async def _expenses_breakdown(cid: str, start: str, end: str, month: Optional[str], basis: str) -> dict:
    """Top-5 expense categories for the donut + an "Other" roll-up + signed
    % delta vs the prior month total expense."""
    inc = await R.compute_income_statement(cid, start, end, basis)
    prev_s, prev_e = _prev_month_range(month)
    prev = await R.compute_income_statement(cid, prev_s, prev_e, basis)

    rows = [
        {"name": r.get("name") or "Other", "amount": float(r.get("amount") or 0)}
        for r in inc.get("expenses", [])
        if float(r.get("amount") or 0) > 0
    ]
    rows.sort(key=lambda r: -r["amount"])
    top = rows[:5]
    other = round(sum(r["amount"] for r in rows[5:]), 2)
    if other:
        top.append({"name": "Other", "amount": other})
    # attach colors
    for i, r in enumerate(top):
        r["color"] = _DONUT_COLORS[i % len(_DONUT_COLORS)]

    return {
        "total": float(inc.get("total_expense") or 0),
        "delta_pct_vs_last_month": _pct_delta(
            float(inc.get("total_expense") or 0),
            float(prev.get("total_expense") or 0),
        ),
        "categories": top,
    }


@router.get("/companies/{cid}/dashboard/firm-glance")
async def firm_glance(
    cid: str,
    month: Optional[str] = Query(None, description="YYYY-MM, defaults to current month"),
    basis: str = Query("accrual"),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    start, end, label = _month_range(month)
    today_iso = datetime.now(timezone.utc).date().isoformat()

    cache = get_cache()
    key = cache.key("firm_glance", company_id=cid, s=start, e=end, b=basis, d=today_iso)

    async def compute():
        funnel, banks, pl, exp = await asyncio.gather(
            _sales_funnel(cid, start, end, today_iso),
            _bank_accounts_panel(cid, today_iso),
            _pl_card(cid, start, end, month, basis),
            _expenses_breakdown(cid, start, end, month, basis),
        )
        return {
            "month": start[:7],
            "month_label": label,
            "sales_funnel": funnel,
            "bank_accounts": banks,
            "profit_loss": pl,
            "expenses": exp,
        }

    return await cache.get_or_compute(key, DASH_CACHE_TTL, compute)



# --------------------------------------------------------------------------
# Business Overview dashboard view
# --------------------------------------------------------------------------
# QBO-Client-style 6-card grid: Invoices funnel (365d / 30d windows),
# Expenses (donut w/ categories, last month), Bank Accounts (bank vs books
# balance per account), Profit & Loss (last month), Sales (line chart:
# monthly totals for current + prior quarter). One packaged response so
# the frontend renders the entire view in a single round-trip.


async def _bo_invoices(cid: str, today_iso: str) -> dict:
    """Invoices card:
      unpaid_365 = amount of unpaid invoices issued in the last 365 days
      overdue    = unpaid amount past due date
      paid_30    = amount of invoices paid within the last 30 days
      deposited  = of paid_30, amount actually posted to a cash account
      not_deposited = paid_30 − deposited
    """
    today = datetime.fromisoformat(today_iso).date()
    d365 = (today - timedelta(days=365)).isoformat()
    d30 = (today - timedelta(days=30)).isoformat()

    invs = await db.invoices.find({"company_id": cid}).to_list(20000)

    unpaid_365 = 0.0
    overdue_amt = 0.0
    paid_30 = 0.0
    for i in invs:
        if i.get("status") == "paid":
            ref = (i.get("updated_at") or i.get("issue_date") or "")[:10]
            if ref and ref >= d30:
                paid_30 += float(i.get("total") or 0)
        else:
            issue = i.get("issue_date") or ""
            if issue and issue >= d365:
                unpaid_365 += float(i.get("balance_due") or 0)
            if i.get("due_date") and i["due_date"] < today_iso:
                overdue_amt += float(i.get("balance_due") or 0)

    # Deposited = paid invoices in last 30d that we can match to a cash
    # posting via invoice_id/tag. Everything else is "not deposited".
    cash_accts = await db.accounts.find({
        "company_id": cid, "type": "asset",
        "$or": [{"code": {"$gte": "1000", "$lte": "1099"}}, {"subtype": "Bank"}],
    }).to_list(200)
    cash_ids = [a["id"] for a in cash_accts]
    deposited = 0.0
    if cash_ids:
        recent = await db.transactions.find({
            "company_id": cid, "posted": True,
            "bank_account_id": {"$in": cash_ids},
            "date": {"$gte": d30, "$lte": today_iso},
            "amount": {"$gt": 0},
        }).to_list(20000)
        for t in recent:
            if (t.get("invoice_id") or t.get("linked_invoice_id")
                    or (t.get("tags") and "invoice_payment" in (t.get("tags") or []))):
                deposited += float(t.get("amount") or 0)
    not_deposited = max(paid_30 - deposited, 0.0)

    return {
        "unpaid_365": round(unpaid_365, 2),
        "overdue": round(overdue_amt, 2),
        "paid_30": round(paid_30, 2),
        "deposited": round(deposited, 2),
        "not_deposited": round(not_deposited, 2),
    }


async def _bo_bank_accounts(cid: str, today_iso: str) -> dict:
    """Business Overview bank-side breakdown: for each cash account, return
    both the ledger balance (what QuickBooks/our books show) AND the raw
    Plaid bank balance if it's been synced (falls back to ledger when the
    Plaid balance isn't known yet)."""
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset",
        "$or": [
            {"code": {"$gte": "1000", "$lte": "1099"}},
            {"subtype": "Bank"},
        ],
    }).to_list(200)

    async def _row(a):
        aid = a["id"]
        txns = await db.transactions.find(
            {"company_id": cid, "posted": True, "bank_account_id": aid}
        ).to_list(20000)
        in_books = sum(float(t.get("amount", 0)) for t in txns)
        jes = await db.journal_entries.find({"company_id": cid}).to_list(20000)
        for j in jes:
            for l in j.get("lines", []):
                if l.get("account_id") == aid:
                    in_books += float(l.get("debit", 0) or 0) - float(l.get("credit", 0) or 0)
        # Plaid balance snapshot (if present on the account doc from the
        # last plaid_service refresh). Falls back to in_books.
        bank_balance = float(a.get("plaid_current_balance") or a.get("balance") or in_books or 0)
        subtype = (a.get("subtype") or "").lower()
        category = (
            "savings" if "saving" in subtype or "saving" in (a.get("name") or "").lower()
            else "checking"
        )
        return {
            "id": aid,
            "name": a.get("name") or "Bank account",
            "code": a.get("code") or "",
            "category": category,
            "bank_balance": round(bank_balance, 2),
            "in_books": round(in_books, 2),
        }

    rows = await asyncio.gather(*[_row(a) for a in accts]) if accts else []
    rows = [r for r in rows if r["bank_balance"] or r["in_books"]]
    # Order: checking first, then savings, largest balance first inside each.
    rows.sort(key=lambda r: (r["category"] != "checking", -r["bank_balance"]))
    return {"accounts": rows[:6]}


async def _bo_sales_series(cid: str, month: Optional[str], basis: str) -> dict:
    """Sales card: cumulative sales for the current calendar quarter + a
    6-month monthly-totals series for the sparkline (last 6 months, oldest
    → newest)."""
    today = datetime.now(timezone.utc).date()
    y, m = (today.year, today.month) if not month else [int(x) for x in month.split("-")]
    # Current quarter: figure out which quarter the anchor month falls in.
    q = (m - 1) // 3
    q_start_m = q * 3 + 1
    q_start = f"{y:04d}-{q_start_m:02d}-01"
    q_end_last = (datetime(y + (q_start_m + 2 == 12), ((q_start_m + 2) % 12) + 1, 1) - timedelta(days=1)).day
    q_end = f"{y:04d}-{q_start_m + 2:02d}-{q_end_last:02d}"
    qtr = await R.compute_income_statement(cid, q_start, q_end, basis)

    months: list[dict] = []
    cursor_y, cursor_m = y, m
    for _ in range(6):
        last = (datetime(cursor_y + (cursor_m == 12), (cursor_m % 12) + 1, 1) - timedelta(days=1)).day
        s = f"{cursor_y:04d}-{cursor_m:02d}-01"
        e = f"{cursor_y:04d}-{cursor_m:02d}-{last:02d}"
        r = await R.compute_income_statement(cid, s, e, basis)
        months.append({
            "month": s[:7],
            "label": datetime(cursor_y, cursor_m, 1).strftime("%b"),
            "amount": float(r.get("total_revenue") or 0),
        })
        cursor_m -= 1
        if cursor_m == 0:
            cursor_m = 12
            cursor_y -= 1
    months.reverse()

    return {
        "quarter_total": float(qtr.get("total_revenue") or 0),
        "months": months,
    }


@router.get("/companies/{cid}/dashboard/business-overview")
async def business_overview(
    cid: str,
    month: Optional[str] = Query(None, description="YYYY-MM anchor, defaults to current month"),
    basis: str = Query("accrual"),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    start, end, label = _month_range(month)
    today_iso = datetime.now(timezone.utc).date().isoformat()
    cache = get_cache()
    key = cache.key("business_overview", company_id=cid, s=start, e=end, b=basis, d=today_iso)

    async def compute():
        inv_bucket, banks, expenses, pl, sales = await asyncio.gather(
            _bo_invoices(cid, today_iso),
            _bo_bank_accounts(cid, today_iso),
            _expenses_breakdown(cid, start, end, month, basis),
            _pl_card(cid, start, end, month, basis),
            _bo_sales_series(cid, month, basis),
        )
        return {
            "month": start[:7],
            "month_label": label,
            "invoices": inv_bucket,
            "bank_accounts": banks,
            "expenses": expenses,
            "profit_loss": pl,
            "sales": sales,
        }

    return await cache.get_or_compute(key, DASH_CACHE_TTL, compute)
