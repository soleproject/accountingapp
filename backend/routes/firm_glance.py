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
    """
    invs = await db.invoices.find({"company_id": cid}).to_list(20000)

    not_paid_amt = 0.0
    not_paid_ct = 0
    overdue_ct = 0
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
