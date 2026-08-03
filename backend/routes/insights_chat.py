"""Insights Chat — a report-focused, chart-aware AI assistant that lives
in a floating widget (bottom-right of the app, à la Intercom / QBO's
Intuit Intelligence).

Deliberately SEPARATE from `AiPanel` (the big right-edge cockpit at
`/ai/chat/stream` + `/ai/parse-intent`). This one is scoped to a small
family of "tell me about this chart / show me this number" flows.

Design:
  • The LLM is given a *chart registry* (short natural-language index
    of every chart the app can render).
  • It picks the most relevant chart_id, chooses parameters, and returns
    a JSON envelope `{answer, chart_id?, chart_params?, quick_actions?}`.
  • The endpoint then runs the actual data-fetch itself (never trusting
    the LLM with raw numbers) and returns the answer + real chart data.
  • Cost-tracked via `feature="insights-chat"` on the LlmChat call.
"""
from __future__ import annotations
import json
import re
import uuid
from datetime import date, timedelta
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db, now_iso
from llm_client import LlmChat, UserMessage, TextDelta, StreamDone
from ai_service import MODEL_PROVIDER, MODEL_NAME

router = APIRouter(prefix="/api")


# ── Chart registry ───────────────────────────────────────────────────
# Every entry describes one first-class report/tile the widget can show.
# The `params_hint` block is what we pass into the LLM system prompt so
# it knows what arguments to ask for; `fetcher` is the actual server-
# side data-loader (never the LLM). Deliberately small — 6 to start,
# grows as we build.

async def _fetch_income_statement(cid: str, params: dict) -> dict:
    from reports import compute_income_statement
    start = params.get("start") or _default_period_start()
    end = params.get("end") or _today()
    basis = params.get("basis") or "accrual"
    return await compute_income_statement(cid, start=start, end=end, basis=basis)


async def _fetch_balance_sheet(cid: str, params: dict) -> dict:
    from reports import compute_balance_sheet
    as_of = params.get("as_of") or _today()
    basis = params.get("basis") or "accrual"
    return await compute_balance_sheet(cid, as_of=as_of, basis=basis)


async def _fetch_ar_aging(cid: str, params: dict) -> dict:
    from reports import compute_ar_aging
    as_of = params.get("as_of") or _today()
    return await compute_ar_aging(cid, as_of=as_of)


async def _fetch_ap_aging(cid: str, params: dict) -> dict:
    from reports import compute_ap_aging
    as_of = params.get("as_of") or _today()
    return await compute_ap_aging(cid, as_of=as_of)


async def _fetch_inventory_valuation(cid: str, params: dict) -> dict:
    import inventory_service
    return await inventory_service.compute_valuation(cid)


async def _fetch_reorder_alerts(cid: str, params: dict) -> dict:
    import inventory_service
    return await inventory_service.compute_reorder_alerts(cid)


async def _fetch_income_trend(cid: str, params: dict) -> dict:
    """Monthly revenue / expense / net income series for a trailing
    window. Great for 'how's my year looking', 'am I trending up',
    'when did I stop being profitable'. Defaults to the trailing 12
    months from today; caller can override via `months` (int, 3-24) or
    an explicit start/end range.
    """
    from reports import compute_income_statement
    from calendar import monthrange
    from datetime import date as _d

    basis = params.get("basis") or "accrual"
    months_n = int(params.get("months") or 12)
    months_n = max(3, min(24, months_n))

    today = _d.today()
    # If caller supplied an explicit end, honour it; otherwise use today.
    end_iso = params.get("end") or today.isoformat()
    try:
        end_d = _d.fromisoformat(end_iso)
    except ValueError:
        end_d = today

    # Build a list of (year, month) pairs anchored on end_d walking
    # backwards `months_n` full months.
    pairs: list[tuple[int, int]] = []
    y, m = end_d.year, end_d.month
    for _ in range(months_n):
        pairs.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    pairs.reverse()

    series: list[dict] = []
    total_rev = 0.0
    total_exp = 0.0
    for (yy, mm) in pairs:
        m_start = _d(yy, mm, 1).isoformat()
        m_end = _d(yy, mm, monthrange(yy, mm)[1]).isoformat()
        try:
            row = await compute_income_statement(cid, start=m_start, end=m_end, basis=basis)
        except Exception:  # noqa: BLE001
            row = {"total_revenue": 0.0, "total_expense": 0.0, "net_income": 0.0}
        rev = float(row.get("total_revenue") or 0)
        exp = float(row.get("total_expense") or 0)
        net = float(row.get("net_income") or (rev - exp))
        total_rev += rev
        total_exp += exp
        series.append({
            "month": f"{yy}-{mm:02d}",
            "label": _d(yy, mm, 1).strftime("%b %y"),
            "revenue": round(rev, 2),
            "expense": round(exp, 2),
            "net": round(net, 2),
        })

    return {
        "basis": basis,
        "months": series,
        "period_start": series[0]["month"] if series else None,
        "period_end": series[-1]["month"] if series else None,
        "total_revenue": round(total_rev, 2),
        "total_expense": round(total_exp, 2),
        "total_net": round(total_rev - total_exp, 2),
    }


async def _fetch_cash_flow(cid: str, params: dict) -> dict:
    """Statement of Cash Flows (Operating / Investing / Financing) for a
    period. Uses the existing `compute_cash_flow` engine, so results
    match the Reports > Cash Flow page one-to-one.
    """
    from reports import compute_cash_flow
    start = params.get("start") or _default_period_start()
    end = params.get("end") or _today()
    return await compute_cash_flow(cid, start=start, end=end)


async def _fetch_invoices_by_status(cid: str, params: dict) -> dict:
    """Invoices bucketed by status (draft / sent / partial / paid /
    overdue / void). Returns per-bucket count, total invoiced, and
    total outstanding balance."""
    docs = await db.invoices.find({"company_id": cid}).to_list(20000)
    today_iso = _today()
    buckets: dict[str, dict] = {}
    for d in docs:
        st = (d.get("status") or "draft").lower()
        # Escalate 'sent' to 'overdue' when past due and still open, so
        # the aging story matches what the invoices list shows.
        bal = float(d.get("balance_due") or 0)
        due = d.get("due_date") or ""
        if st == "sent" and bal > 0.005 and due and due < today_iso:
            st = "overdue"
        row = buckets.setdefault(st, {"status": st, "count": 0, "total": 0.0, "balance_open": 0.0})
        row["count"] += 1
        row["total"] += float(d.get("total") or 0)
        row["balance_open"] += bal
    rows = [
        {**v, "total": round(v["total"], 2), "balance_open": round(v["balance_open"], 2)}
        for v in buckets.values()
    ]
    STATUS_ORDER = {"overdue": 0, "sent": 1, "partial": 2, "draft": 3, "paid": 4, "void": 5}
    rows.sort(key=lambda r: STATUS_ORDER.get(r["status"], 99))
    return {
        "rows": rows,
        "total_count": sum(r["count"] for r in rows),
        "total_invoiced": round(sum(r["total"] for r in rows), 2),
        "total_open": round(sum(r["balance_open"] for r in rows), 2),
    }


async def _fetch_bills_by_status(cid: str, params: dict) -> dict:
    """Bills bucketed by status (same shape as invoices_by_status)."""
    docs = await db.bills.find({"company_id": cid}).to_list(20000)
    today_iso = _today()
    buckets: dict[str, dict] = {}
    for d in docs:
        st = (d.get("status") or "draft").lower()
        bal = float(d.get("balance_due") or 0)
        due = d.get("due_date") or ""
        if st in ("received", "sent") and bal > 0.005 and due and due < today_iso:
            st = "overdue"
        row = buckets.setdefault(st, {"status": st, "count": 0, "total": 0.0, "balance_open": 0.0})
        row["count"] += 1
        row["total"] += float(d.get("total") or 0)
        row["balance_open"] += bal
    rows = [
        {**v, "total": round(v["total"], 2), "balance_open": round(v["balance_open"], 2)}
        for v in buckets.values()
    ]
    STATUS_ORDER = {"overdue": 0, "received": 1, "sent": 1, "partial": 2, "draft": 3, "paid": 4, "void": 5}
    rows.sort(key=lambda r: STATUS_ORDER.get(r["status"], 99))
    return {
        "rows": rows,
        "total_count": sum(r["count"] for r in rows),
        "total_billed": round(sum(r["total"] for r in rows), 2),
        "total_open": round(sum(r["balance_open"] for r in rows), 2),
    }


async def _fetch_top_customers_revenue(cid: str, params: dict) -> dict:
    """Top N customers by invoiced revenue in a date range (default
    trailing 90 days). Excludes voided invoices."""
    start = params.get("start") or _default_period_start()
    end = params.get("end") or _today()
    n = max(3, min(int(params.get("limit") or 10), 25))
    docs = await db.invoices.find({
        "company_id": cid,
        "issue_date": {"$gte": start, "$lte": end},
        "status": {"$ne": "void"},
    }).to_list(20000)
    agg: dict[str, dict] = {}
    for d in docs:
        key = d.get("contact_id") or f"__nc__:{d.get('contact_name') or 'Unknown'}"
        name = d.get("contact_name") or "Unknown"
        row = agg.setdefault(key, {"contact_id": d.get("contact_id"),
                                    "name": name, "revenue": 0.0,
                                    "invoice_count": 0, "balance_open": 0.0})
        row["revenue"] += float(d.get("total") or 0)
        row["balance_open"] += float(d.get("balance_due") or 0)
        row["invoice_count"] += 1
    rows = sorted(agg.values(), key=lambda r: r["revenue"], reverse=True)[:n]
    for r in rows:
        r["revenue"] = round(r["revenue"], 2)
        r["balance_open"] = round(r["balance_open"], 2)
    return {
        "rows": rows,
        "period_start": start,
        "period_end": end,
        "total_revenue": round(sum(r["revenue"] for r in rows), 2),
    }


async def _fetch_top_vendors_spend(cid: str, params: dict) -> dict:
    """Top N vendors by billed spend in a date range."""
    start = params.get("start") or _default_period_start()
    end = params.get("end") or _today()
    n = max(3, min(int(params.get("limit") or 10), 25))
    docs = await db.bills.find({
        "company_id": cid,
        "issue_date": {"$gte": start, "$lte": end},
        "status": {"$ne": "void"},
    }).to_list(20000)
    agg: dict[str, dict] = {}
    for d in docs:
        key = d.get("contact_id") or f"__nc__:{d.get('contact_name') or 'Unknown'}"
        name = d.get("contact_name") or "Unknown"
        row = agg.setdefault(key, {"contact_id": d.get("contact_id"),
                                    "name": name, "spend": 0.0,
                                    "bill_count": 0, "balance_open": 0.0})
        row["spend"] += float(d.get("total") or 0)
        row["balance_open"] += float(d.get("balance_due") or 0)
        row["bill_count"] += 1
    rows = sorted(agg.values(), key=lambda r: r["spend"], reverse=True)[:n]
    for r in rows:
        r["spend"] = round(r["spend"], 2)
        r["balance_open"] = round(r["balance_open"], 2)
    return {
        "rows": rows,
        "period_start": start,
        "period_end": end,
        "total_spend": round(sum(r["spend"] for r in rows), 2),
    }


async def _fetch_expense_by_category(cid: str, params: dict) -> dict:
    """Expense breakdown by GL account (top 15) over a period. Great
    for 'where did my money go', 'what's my biggest expense'."""
    from reports import _signed_balances, _display_amount
    start = params.get("start") or _default_period_start()
    end = params.get("end") or _today()
    accts = await db.accounts.find({"company_id": cid, "type": "expense"}).to_list(2000)
    by = await _signed_balances(cid, start, end)
    rows = []
    for a in accts:
        amt = _display_amount(a, by.get(a["id"], 0.0))
        if abs(amt) < 0.01:
            continue
        rows.append({
            "id": a["id"], "name": a["name"], "code": a.get("code", ""),
            "detail_type": (a.get("detail_type") or "").strip(),
            "amount": round(amt, 2),
        })
    rows.sort(key=lambda r: r["amount"], reverse=True)
    return {
        "rows": rows[:15],
        "period_start": start,
        "period_end": end,
        "total": round(sum(r["amount"] for r in rows), 2),
    }


async def _fetch_fixed_assets_summary(cid: str, params: dict) -> dict:
    """Fixed-asset register with cost, accumulated depreciation, and
    current book value. Computes accumulated depreciation from months
    elapsed × monthly_depreciation (capped at depreciable base)."""
    from datetime import date as _d
    docs = await db.assets.find({"company_id": cid}).to_list(2000)
    today = _d.today()
    rows = []
    total_cost = 0.0
    total_accum = 0.0
    for a in docs:
        cost = float(a.get("cost") or 0)
        salvage = float(a.get("salvage_value") or 0)
        monthly = float(a.get("monthly_depreciation") or 0)
        pd_ = a.get("purchase_date")
        months_elapsed = 0
        if pd_:
            try:
                pd_d = _d.fromisoformat(str(pd_)[:10])
                months_elapsed = max(0, (today.year - pd_d.year) * 12 + (today.month - pd_d.month))
            except Exception:
                pass
        depreciable_base = max(cost - salvage, 0)
        accum = min(monthly * months_elapsed, depreciable_base)
        book = round(cost - accum, 2)
        rows.append({
            "id": a["id"], "name": a.get("name") or "(unnamed)",
            "asset_type": a.get("asset_type") or "",
            "cost": round(cost, 2),
            "salvage_value": round(salvage, 2),
            "purchase_date": pd_,
            "monthly_depreciation": round(monthly, 2),
            "accumulated_depreciation": round(accum, 2),
            "book_value": book,
        })
        total_cost += cost
        total_accum += accum
    rows.sort(key=lambda r: r["book_value"], reverse=True)
    return {
        "rows": rows,
        "asset_count": len(rows),
        "total_cost": round(total_cost, 2),
        "total_accumulated_depreciation": round(total_accum, 2),
        "total_book_value": round(total_cost - total_accum, 2),
    }


async def _fetch_loans_summary(cid: str, params: dict) -> dict:
    """Loan register with original principal, current balance (from
    linked liability account), rate, and term. Current balance uses
    signed ledger balance and takes the absolute value since liability
    normal balance is credit."""
    from reports import _signed_balances
    docs = await db.loans.find({"company_id": cid}).to_list(2000)
    if not docs:
        return {"rows": [], "loan_count": 0,
                "total_principal": 0.0, "total_current_balance": 0.0}
    by = await _signed_balances(cid, start=None, end=_today(), include_pre_period=True)
    rows = []
    total_principal = 0.0
    total_balance = 0.0
    for l in docs:
        aid = l.get("account_id")
        raw = float(by.get(aid, 0) or 0)
        current = abs(raw)
        principal = float(l.get("principal") or 0)
        rows.append({
            "id": l.get("id"),
            "lender": l.get("lender") or "(unnamed)",
            "principal": round(principal, 2),
            "current_balance": round(current, 2),
            "rate": l.get("rate"),
            "term_months": l.get("term_months"),
            "start_date": l.get("start_date"),
        })
        total_principal += principal
        total_balance += current
    rows.sort(key=lambda r: r["current_balance"], reverse=True)
    return {
        "rows": rows,
        "loan_count": len(rows),
        "total_principal": round(total_principal, 2),
        "total_current_balance": round(total_balance, 2),
    }


CHART_REGISTRY: dict[str, dict] = {
    "income_statement": {
        "title": "Income Statement",
        "description": "Revenue, expenses, and net income over a date range. Great for 'how much did I make', 'why is profit down', 'what are my biggest expenses'.",
        "params_hint": "start (YYYY-MM-DD), end (YYYY-MM-DD), basis ('accrual'|'cash')",
        "fetcher": _fetch_income_statement,
    },
    "balance_sheet": {
        "title": "Balance Sheet",
        "description": "Assets, liabilities, and equity as of a date. Great for 'what's my net worth', 'do I have inventory on the books', 'how much do I owe'.",
        "params_hint": "as_of (YYYY-MM-DD), basis ('accrual'|'cash')",
        "fetcher": _fetch_balance_sheet,
    },
    "ar_aging": {
        "title": "A/R Aging (who owes me)",
        "description": "Outstanding customer invoices bucketed by days overdue. Great for 'who owes me the most', 'what's past due'.",
        "params_hint": "as_of (YYYY-MM-DD)",
        "fetcher": _fetch_ar_aging,
    },
    "ap_aging": {
        "title": "A/P Aging (who I owe)",
        "description": "Outstanding vendor bills bucketed by days overdue. Great for 'what bills are due', 'who am I behind on'.",
        "params_hint": "as_of (YYYY-MM-DD)",
        "fetcher": _fetch_ap_aging,
    },
    "inventory_valuation": {
        "title": "Inventory Valuation",
        "description": "Every tracked item with quantity on hand, weighted-average cost, and total value. Great for 'how much inventory do I have', 'what's my most valuable stock'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_inventory_valuation,
    },
    "reorder_alerts": {
        "title": "Reorder Alerts (low stock)",
        "description": "Inventory items at or below their low-stock threshold. Great for 'what do I need to buy', 'am I running low on anything'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_reorder_alerts,
    },
    "income_trend": {
        "title": "Monthly Income Trend",
        "description": "Revenue, expense, and net-income line/bar trend over the trailing N months. Great for 'how's my year looking', 'am I trending up', 'when did I stop being profitable', 'this year vs last year'. Prefer this over the flat Income Statement whenever the user asks about a TREND, YEAR, or MULTI-MONTH view.",
        "params_hint": "months (int 3-24, default 12), basis ('accrual'|'cash'), end (YYYY-MM-DD, optional)",
        "fetcher": _fetch_income_trend,
    },
    "cash_flow": {
        "title": "Statement of Cash Flows",
        "description": "Operating / Investing / Financing cash movement plus net change in cash for a period. Great for 'am I generating cash', 'where is my cash going', 'why is my bank balance falling while I'm profitable'.",
        "params_hint": "start (YYYY-MM-DD), end (YYYY-MM-DD)",
        "fetcher": _fetch_cash_flow,
    },
    "invoices_by_status": {
        "title": "Invoices by Status",
        "description": "Count and dollar totals of every invoice bucketed by status (overdue, sent, partial, draft, paid, void). Great for 'how many overdue invoices', 'what's in draft', 'invoice pipeline'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_invoices_by_status,
    },
    "bills_by_status": {
        "title": "Bills by Status",
        "description": "Count and dollar totals of every bill bucketed by status (overdue, received, partial, draft, paid). Great for 'how many bills to pay', 'bill pipeline', 'what's overdue to vendors'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_bills_by_status,
    },
    "top_customers_revenue": {
        "title": "Top Customers by Revenue",
        "description": "Ranking of customers by invoiced revenue in a period. Great for 'who are my best customers', 'top 10 customers this year', 'who's my biggest client'.",
        "params_hint": "start (YYYY-MM-DD), end (YYYY-MM-DD), limit (3-25, default 10)",
        "fetcher": _fetch_top_customers_revenue,
    },
    "top_vendors_spend": {
        "title": "Top Vendors by Spend",
        "description": "Ranking of vendors by billed spend in a period. Great for 'where am I spending the most', 'top vendors', 'who do I pay the most'.",
        "params_hint": "start (YYYY-MM-DD), end (YYYY-MM-DD), limit (3-25, default 10)",
        "fetcher": _fetch_top_vendors_spend,
    },
    "expense_by_category": {
        "title": "Expenses by Category",
        "description": "Expense breakdown by GL account (top 15) over a period. Great for 'where did my money go', 'what's my biggest expense category', 'break down my costs'.",
        "params_hint": "start (YYYY-MM-DD), end (YYYY-MM-DD)",
        "fetcher": _fetch_expense_by_category,
    },
    "fixed_assets_summary": {
        "title": "Fixed Assets Register",
        "description": "Every fixed asset with cost, accumulated depreciation, and current book value. Great for 'what assets do I own', 'how depreciated are my assets', 'total book value of my equipment'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_fixed_assets_summary,
    },
    "loans_summary": {
        "title": "Loans Summary",
        "description": "Every loan with original principal, current outstanding balance, interest rate, and term. Great for 'how much do I owe on loans', 'what's my debt', 'loan payoff'.",
        "params_hint": "(no params)",
        "fetcher": _fetch_loans_summary,
    },
}


# ── Helpers ──────────────────────────────────────────────────────────

def _today() -> str:
    return date.today().isoformat()


def _default_period_start() -> str:
    return (date.today() - timedelta(days=90)).isoformat()


def _chart_menu_prompt() -> str:
    lines = []
    for cid_, meta in CHART_REGISTRY.items():
        lines.append(f'  • "{cid_}" → {meta["title"]}. {meta["description"]} Params: {meta["params_hint"]}.')
    return "\n".join(lines)


_SYSTEM = (
    "You are the SmartBooks Insights Assistant — a friendly, precise "
    "financial-reporting companion embedded in a small floating widget "
    "at the bottom of a bookkeeping app. Your job is to answer the user's "
    "question about their business finances by (a) picking the most "
    "relevant chart from the registry below, (b) choosing sensible "
    "params, and (c) writing a SHORT, warm, plain-English explanation "
    "of what that chart will show them. The app itself fetches the real "
    "numbers — you never invent them.\n\n"
    "CHART REGISTRY:\n" + "{registry}" + "\n\n"
    "OUTPUT FORMAT — respond with STRICT JSON (no code fences, no extra prose) matching exactly:\n"
    "{\n"
    '  "answer": "<2-4 sentence conversational explanation of what you\'re showing them and why. Never quote specific $ figures — just describe.>",\n'
    '  "chart_id": "<one of the registry keys, or null if the question is generic conversation>",\n'
    '  "chart_params": {},\n'
    '  "quick_actions": [\n'
    '    {"label": "<short verb phrase>", "kind": "navigate", "to": "/some-route"}\n'
    "  ]\n"
    "}\n\n"
    "RULES:\n"
    "• If the user's question does not map to any chart (small talk, "
    "  'thanks', 'who are you'), set chart_id=null and just answer.\n"
    "• Dates: when the user says 'this month' resolve to the current "
    "  month, 'last quarter' → previous 3 whole months, 'YTD' → Jan 1 to today.\n"
    "• Never fabricate numbers. Always let the chart show them.\n"
    "• `quick_actions` are optional — 0-3 items, links like '/reports/income-statement', '/transactions', '/inventory-management'.\n"
    "• Today is " + _today() + "."
)


def _system_prompt() -> str:
    return _SYSTEM.replace("{registry}", _chart_menu_prompt())


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    # Strip common markdown fences the LLM sometimes wraps JSON in.
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    # Try to parse the whole payload first (fast path), then fall back
    # to grabbing the widest {...} substring.
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"\{[\s\S]*\}", t)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None


# ── API ──────────────────────────────────────────────────────────────

class InsightsAskIn(BaseModel):
    question: str
    session_id: Optional[str] = None      # keeps conversation memory
    page: Optional[str] = None            # current app route for context
    chart_hint: Optional[str] = None      # optional chart the user is looking at
    page_charts: Optional[list[str]] = None  # chart_ids the current page has
                                             # registered via useRegisterChart
    monthly_cap_usd: Optional[float] = None  # soft cap for cost tracking


# ── Cost caps (per-company monthly ceiling) ─────────────────────────
#
# Each insights_ask call bumps a monthly counter on the company doc; the
# LLM is metered at $0.008 / request (rough Claude Sonnet 5 avg for a
# short JSON reply — override via COST_PER_INSIGHTS_CALL env var).
# `cap_status()` returns one of: "ok" | "warn" (>=80%) | "block".
import os as _os
_COST_PER_CALL = float(_os.environ.get("COST_PER_INSIGHTS_CALL") or 0.008)


def _current_period() -> str:
    from datetime import date as _d
    return _d.today().strftime("%Y-%m")


async def _cap_status(cid: str, monthly_cap: Optional[float]) -> tuple[str, dict]:
    """Return (status, meta) where status ∈ ok|warn|block. Meta carries
    the spend + cap for surfacing to the client."""
    period = _current_period()
    doc = await db.companies.find_one({"id": cid}, {"insights_spend": 1}) or {}
    spend_map = doc.get("insights_spend") or {}
    spent = float(spend_map.get(period) or 0)
    cap = float(monthly_cap or 0)  # 0 → unlimited
    status = "ok"
    if cap > 0:
        if spent >= cap:
            status = "block"
        elif spent >= 0.8 * cap:
            status = "warn"
    return status, {"period": period, "spent": round(spent, 4),
                    "cap": cap, "per_call": _COST_PER_CALL}


async def _bump_spend(cid: str) -> None:
    await db.companies.update_one(
        {"id": cid},
        {"$inc": {f"insights_spend.{_current_period()}": _COST_PER_CALL},
         "$set": {"updated_at": now_iso()}},
    )


class QuickAction(BaseModel):
    label: str
    kind: str = "navigate"
    to: Optional[str] = None


class InsightsAskOut(BaseModel):
    session_id: str
    answer: str
    chart_id: Optional[str] = None
    chart_title: Optional[str] = None
    chart_data: Optional[dict] = None
    quick_actions: list[QuickAction] = []


@router.post("/companies/{cid}/ai/insights/ask", response_model=InsightsAskOut)
async def insights_ask(cid: str, inp: InsightsAskIn,
                       user: dict = Depends(get_current_user)):
    """Chart-aware conversational Q&A for reports & dashboard tiles.

    Flow:
      1. LLM picks a `chart_id` from the registry and params (never a
         raw $ figure).
      2. This endpoint runs the corresponding fetcher against the
         user's real data.
      3. Response bundles the LLM's plain-English answer with the
         actual chart_data so the widget can render it live.
    """
    await require_company(user, cid)
    q = (inp.question or "").strip()
    if not q:
        raise HTTPException(400, "question is required")

    # Cost gate — refuse when the caller has burned through their monthly
    # ceiling. `warn` still lets the request through but the frontend
    # can show a soft banner.
    status, meta = await _cap_status(cid, inp.monthly_cap_usd)
    if status == "block":
        raise HTTPException(
            status_code=402,
            detail={"error": "insights_cap_reached", **meta,
                    "message": "Monthly Insights budget reached. Raise the cap in Settings or wait for next month."},
        )

    session_id = inp.session_id or str(uuid.uuid4())
    # Add a tiny bit of context so the LLM can resolve "this chart" /
    # "this page" style questions without a full context registry.
    ctx_lines = []
    if inp.page:      ctx_lines.append(f"Current page: {inp.page}")
    if inp.chart_hint:
        meta = CHART_REGISTRY.get(inp.chart_hint)
        if meta:
            ctx_lines.append(f"User is currently looking at: {meta['title']} ({inp.chart_hint}).")
    user_msg = q if not ctx_lines else "\n".join(ctx_lines) + "\n\nQuestion: " + q

    chat = LlmChat(
        api_key="",  # llm_client resolves from env
        session_id="insights-" + session_id,
        system_message=_system_prompt(),
        feature="insights-chat",
    ).with_model(MODEL_PROVIDER, MODEL_NAME)
    try:
        raw = await chat.send_message(UserMessage(text=user_msg))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error: {e}")

    # `send_message` may return either a string or an object with `.text`
    # depending on backend model — normalize.
    raw_text = raw if isinstance(raw, str) else (getattr(raw, "text", "") or str(raw))
    parsed = _extract_json(raw_text) or {}
    if not parsed:
        print(f"[insights_chat] LLM unparseable payload → {raw_text!r}"[:1000], flush=True)
    answer = (parsed.get("answer") or "").strip() \
             or "I wasn't sure how to answer that — try rephrasing?"
    chart_id = parsed.get("chart_id")
    chart_params = parsed.get("chart_params") or {}
    quick_actions_raw = parsed.get("quick_actions") or []

    # Fetch the real chart data server-side — LLM never touches raw numbers.
    chart_data = None
    chart_title = None
    if chart_id and chart_id in CHART_REGISTRY:
        meta = CHART_REGISTRY[chart_id]
        chart_title = meta["title"]
        try:
            chart_data = await meta["fetcher"](cid, chart_params if isinstance(chart_params, dict) else {})
        except Exception as e:  # noqa: BLE001
            # Data-fetch failure shouldn't kill the whole response — surface
            # a graceful degraded state.
            answer += f"\n\n(I couldn't load the chart right now: {e})"
            chart_id = None
            chart_title = None

    # Normalize quick_actions defensively.
    quick_actions: list[QuickAction] = []
    for qa in (quick_actions_raw if isinstance(quick_actions_raw, list) else [])[:3]:
        if isinstance(qa, dict) and qa.get("label"):
            quick_actions.append(QuickAction(
                label=str(qa["label"])[:60],
                kind=str(qa.get("kind") or "navigate"),
                to=str(qa["to"]) if qa.get("to") else None,
            ))

    # Persist a lightweight transcript for the widget's history view.
    try:
        await db.insights_chat_log.insert_one({
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "user_id": user["id"],
            "session_id": session_id,
            "question": q,
            "answer": answer,
            "chart_id": chart_id,
            "created_at": now_iso(),
        })
        await _bump_spend(cid)
    except Exception:  # noqa: BLE001
        pass

    return InsightsAskOut(
        session_id=session_id,
        answer=answer,
        chart_id=chart_id,
        chart_title=chart_title,
        chart_data=chart_data,
        quick_actions=quick_actions,
    )


@router.get("/companies/{cid}/ai/insights/history")
async def insights_history(cid: str, session_id: Optional[str] = None,
                           limit: int = 20,
                           user: dict = Depends(get_current_user)):
    """Recent Q&A rows for the widget's collapsible history view."""
    await require_company(user, cid)
    q: dict[str, Any] = {"company_id": cid, "user_id": user["id"]}
    if session_id:
        q["session_id"] = session_id
    rows = await db.insights_chat_log.find(q).sort("created_at", -1).limit(limit).to_list(limit)
    for r in rows:
        r.pop("_id", None)
    return {"rows": rows}


@router.get("/companies/{cid}/ai/insights/registry")
async def insights_registry(cid: str, user: dict = Depends(get_current_user)):
    """Expose the chart registry so the frontend can render "starter
    prompts" (Balance Sheet · Income Statement · A/R Aging · …) without
    hard-coding the list twice."""
    await require_company(user, cid)
    return {
        "charts": [
            {"id": cid_, "title": meta["title"], "description": meta["description"]}
            for cid_, meta in CHART_REGISTRY.items()
        ]
    }


@router.get("/companies/{cid}/ai/insights/budget")
async def insights_budget(cid: str, monthly_cap: Optional[float] = None,
                          user: dict = Depends(get_current_user)):
    """Return current-month insights spend + cap. Used by the widget to
    render the 80%-warn banner."""
    await require_company(user, cid)
    status, meta = await _cap_status(cid, monthly_cap)
    return {"status": status, **meta}


# ── SSE streaming variant ────────────────────────────────────────────
#
# The non-streaming `ask` above returns the whole JSON after the LLM
# finishes. This variant emits the same shape but progressively:
#   `event: text_delta`  → partial `answer` text chunks (from the LLM
#                          stream while it types out its `answer` field)
#   `event: chart`       → single event carrying the resolved chart_id,
#                          chart_title, chart_data + quick_actions once
#                          the JSON has been fully parsed
#   `event: done`        → terminal marker
#
# Streaming a JSON payload directly is fragile, so we take a two-phase
# approach: let the model write to completion, extract the JSON,
# then simulate word-by-word streaming of the answer field so the UX
# feels alive while chart_data lands atomically at the end. Cost is
# identical to the non-streaming call.


@router.post("/companies/{cid}/ai/insights/ask/stream")
async def insights_ask_stream(cid: str, inp: InsightsAskIn,
                              user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    q = (inp.question or "").strip()
    if not q:
        raise HTTPException(400, "question is required")

    status, meta = await _cap_status(cid, inp.monthly_cap_usd)
    if status == "block":
        raise HTTPException(status_code=402, detail={"error": "insights_cap_reached", **meta})

    session_id = inp.session_id or str(uuid.uuid4())
    ctx_lines = []
    if inp.page:
        ctx_lines.append(f"Current page: {inp.page}")
    if inp.chart_hint:
        meta_c = CHART_REGISTRY.get(inp.chart_hint)
        if meta_c:
            ctx_lines.append(f"User is currently looking at: {meta_c['title']} ({inp.chart_hint}).")
    if inp.page_charts:
        # Charts the frontend registered on this page via
        # `useRegisterChart`. We only echo the ids so the LLM can
        # PREFER them, but any chart in the registry stays valid.
        valid = [c for c in inp.page_charts if c in CHART_REGISTRY]
        if valid:
            ctx_lines.append("Charts already visible on this page: " + ", ".join(valid))
    user_msg = q if not ctx_lines else "\n".join(ctx_lines) + "\n\nQuestion: " + q

    chat = LlmChat(
        api_key="",
        session_id="insights-" + session_id,
        system_message=_system_prompt(),
        feature="insights-chat",
    ).with_model(MODEL_PROVIDER, MODEL_NAME)

    async def event_gen():
        import asyncio
        try:
            raw = await chat.send_message(UserMessage(text=user_msg))
        except Exception as e:  # noqa: BLE001
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
            return
        raw_text = raw if isinstance(raw, str) else (getattr(raw, "text", "") or str(raw))
        parsed = _extract_json(raw_text) or {}
        answer = (parsed.get("answer") or "").strip() \
                 or "I wasn't sure how to answer that — try rephrasing?"
        chart_id = parsed.get("chart_id") or None
        chart_params = parsed.get("chart_params") or {}
        quick_actions_raw = parsed.get("quick_actions") or []

        # Stream the answer text word-by-word for the "typing" feel.
        words = answer.split(" ")
        for i, w in enumerate(words):
            chunk = w + (" " if i < len(words) - 1 else "")
            yield f"event: text_delta\ndata: {json.dumps({'content': chunk})}\n\n"
            await asyncio.sleep(0.018)   # ~55 words/sec cadence

        # Now fetch chart data + emit the chart event.
        chart_data, chart_title = None, None
        if chart_id and chart_id in CHART_REGISTRY:
            m = CHART_REGISTRY[chart_id]
            chart_title = m["title"]
            try:
                chart_data = await m["fetcher"](
                    cid, chart_params if isinstance(chart_params, dict) else {}
                )
            except Exception as e:  # noqa: BLE001
                yield f"event: text_delta\ndata: {json.dumps({'content': f' (chart failed to load: {e})'})}\n\n"
                chart_id = None
        quick_actions: list[dict] = []
        for qa in (quick_actions_raw if isinstance(quick_actions_raw, list) else [])[:3]:
            if isinstance(qa, dict) and qa.get("label"):
                quick_actions.append({
                    "label": str(qa["label"])[:60],
                    "kind": str(qa.get("kind") or "navigate"),
                    "to": str(qa["to"]) if qa.get("to") else None,
                })
        yield "event: chart\ndata: " + json.dumps({
            "chart_id": chart_id,
            "chart_title": chart_title,
            "chart_data": chart_data,
            "quick_actions": quick_actions,
        }) + "\n\n"

        # Persist + meter spend.
        try:
            await db.insights_chat_log.insert_one({
                "id": str(uuid.uuid4()),
                "company_id": cid,
                "user_id": user["id"],
                "session_id": session_id,
                "question": q,
                "answer": answer,
                "chart_id": chart_id,
                "created_at": now_iso(),
            })
            await _bump_spend(cid)
        except Exception:  # noqa: BLE001
            pass

        yield f"event: done\ndata: {json.dumps({'session_id': session_id, 'cap_status': status})}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
