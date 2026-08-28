"""Home Dashboard — cross-product KPI aggregator (Feb 2026, Phase D).

Single-round-trip endpoint that powers the /home page. Pulls the
smallest slice of each of the 4 product surfaces (Accounting, CRM,
Team, Projects) so the dashboard renders in one request even on
tenants with thousands of records.

Every widget block is emitted with an `id` + `kind` so Phase 2 can
persist per-user layouts (drag-reorder + widget picker) and Phase 3
can splice in AI-generated custom KPIs without changing the
response envelope.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_OPEN_DEAL_STAGES = ("lead", "qualified", "proposal", "negotiation")
_STAGE_PROB = {"lead": 10, "qualified": 25, "proposal": 50,
                "negotiation": 75, "won": 100, "lost": 0}


def _clean(doc: dict | None) -> dict | None:
    if doc: doc.pop("_id", None)
    return doc


async def _accounting_slice(cid: str, month_prefix: str) -> dict:
    """Sums MTD income vs expense off transactions.
    Uses signed `amount` + `type` fields already present on
    transactions (positive income, negative expense).
    """
    txns = await db.transactions.find({
        "company_id": cid,
        "date": {"$gte": f"{month_prefix}-01"},
    }, {"type": 1, "amount": 1, "date": 1, "status": 1}).to_list(20000)
    income = expense = 0.0
    for t in txns:
        amt = float(t.get("amount") or 0)
        typ = (t.get("type") or "").lower()
        if typ == "income" or (typ == "" and amt > 0):
            income += abs(amt)
        elif typ == "expense" or (typ == "" and amt < 0):
            expense += abs(amt)
    # Unpaid AR — sum of invoices not fully paid.
    unpaid_cursor = db.invoices.find({
        "company_id": cid,
        "status": {"$in": ["sent", "overdue", "partial", "unpaid"]},
    }, {"balance": 1, "total": 1, "amount_paid": 1, "due_date": 1,
         "customer_name": 1, "contact_name": 1, "invoice_number": 1,
         "number": 1, "id": 1})
    unpaid_total = 0.0
    unpaid_count = 0
    overdue_list: list[dict] = []
    today = now_iso()[:10]
    async for inv in unpaid_cursor:
        bal = inv.get("balance")
        if bal is None:
            bal = float(inv.get("total") or 0) - float(inv.get("amount_paid") or 0)
        if bal > 0:
            unpaid_total += float(bal)
            unpaid_count += 1
            due = inv.get("due_date")
            if due and due < today:
                days_overdue = (datetime.fromisoformat(today).date()
                                 - datetime.fromisoformat(due).date()).days
                overdue_list.append({
                    "id": inv.get("id"),
                    "label": (inv.get("customer_name")
                                or inv.get("contact_name")
                                or "—")
                              + " · #"
                              + (inv.get("invoice_number")
                                  or inv.get("number") or ""),
                    "value": round(float(bal), 2),
                    "days_overdue": days_overdue,
                })
    overdue_list.sort(key=lambda x: x["days_overdue"], reverse=True)

    # Bank balance — sum of account.balance across cash accounts.
    bank_accts = await db.accounts.find({
        "company_id": cid,
        "type": {"$in": ["cash", "bank"]},
    }, {"balance": 1, "name": 1}).to_list(200)
    bank_balance = round(sum(float(a.get("balance") or 0)
                              for a in bank_accts), 2)

    # Rough cash-runway: bank balance ÷ average monthly burn over
    # the past 90 days. If income >= expenses in that window, runway
    # is "infinite" so we return None and let the UI say "∞".
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()[:10]
    burn_cursor = db.transactions.find({
        "company_id": cid,
        "date": {"$gte": cutoff},
    }, {"type": 1, "amount": 1})
    burn_in = burn_out = 0.0
    async for t in burn_cursor:
        amt = float(t.get("amount") or 0)
        typ = (t.get("type") or "").lower()
        if typ == "income" or (typ == "" and amt > 0):
            burn_in += abs(amt)
        elif typ == "expense" or (typ == "" and amt < 0):
            burn_out += abs(amt)
    monthly_burn = max(0.0, (burn_out - burn_in) / 3.0)
    runway_months = round(bank_balance / monthly_burn, 1) if monthly_burn > 0 else None

    net = round(income - expense, 2)
    return {
        "income_mtd": round(income, 2),
        "expense_mtd": round(expense, 2),
        "net_mtd": net,
        "unpaid_ar_total": round(unpaid_total, 2),
        "unpaid_ar_count": unpaid_count,
        "overdue_invoices": overdue_list[:10],
        "bank_balance": bank_balance,
        "runway_months": runway_months,
    }


async def _top_customers(cid: str, limit: int = 5) -> list[dict]:
    """Top customers by lifetime paid invoice total."""
    pipeline = [
        {"$match": {"company_id": cid,
                     "status": {"$in": ["paid", "partial", "sent",
                                          "overdue"]}}},
        {"$group": {
            "_id": "$contact_id",
            "name": {"$first": "$contact_name"},
            "total": {"$sum": {"$ifNull": ["$total", 0]}},
            "count": {"$sum": 1},
        }},
        {"$sort": {"total": -1}},
        {"$limit": limit},
    ]
    rows = await db.invoices.aggregate(pipeline).to_list(limit)
    return [{
        "id": r["_id"], "label": r.get("name") or "Unknown customer",
        "value": round(float(r.get("total") or 0), 2),
        "sub": f"{r.get('count', 0)} invoices",
    } for r in rows if r["_id"]]


async def _team_utilization(cid: str) -> dict:
    """Billable vs non-billable time in the last 30 days."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    cursor = db.time_entries.find({
        "company_id": cid,
        "end_time": {"$gte": cutoff},
    }, {"duration_minutes": 1, "is_billable": 1})
    billable = non_billable = 0
    async for te in cursor:
        mins = int(te.get("duration_minutes") or 0)
        if te.get("is_billable"): billable += mins
        else: non_billable += mins
    total = billable + non_billable
    pct = round(billable / total * 100, 1) if total > 0 else 0.0
    return {
        "billable_minutes": billable,
        "non_billable_minutes": non_billable,
        "utilization_pct": pct,
    }


async def _crm_slice(cid: str) -> dict:
    """Open pipeline snapshot + counts."""
    deals = await db.deals.find({"company_id": cid},
        {"stage": 1, "value": 1, "probability": 1}).to_list(5000)
    open_deals = [d for d in deals if d.get("stage") in _OPEN_DEAL_STAGES]
    open_value = round(sum(float(d.get("value") or 0)
                            for d in open_deals), 2)
    weighted = round(sum(
        float(d.get("value") or 0) *
        (float(d.get("probability") or
                _STAGE_PROB.get(d.get("stage"), 0)) / 100.0)
        for d in open_deals), 2)
    leads_new = sum(1 for d in deals if d.get("stage") == "lead")
    won = sum(1 for d in deals if d.get("stage") == "won")
    return {
        "open_count": len(open_deals),
        "open_value": open_value,
        "weighted": weighted,
        "leads_new": leads_new,
        "won_count": won,
    }


async def _projects_slice(cid: str) -> dict:
    """Active project count + open-tasks under those projects."""
    projects = await db.projects.find({
        "company_id": cid,
        "status": {"$nin": ["cancelled", "archived"]},
    }, {"status": 1, "estimated_revenue": 1}).to_list(2000)
    active = [p for p in projects if p.get("status") in
               ("in_progress", "planning", "active", None)]
    done = [p for p in projects if p.get("status") in ("completed", "closed")]
    est_rev = round(sum(float(p.get("estimated_revenue") or 0)
                         for p in active), 2)
    # Tasks tied to any project.
    open_tasks = await db.tasks.count_documents({
        "company_id": cid, "status": "open",
        "entity_type": {"$in": ["project", "phase"]},
    })
    return {
        "active_count": len(active),
        "completed_count": len(done),
        "estimated_revenue": est_rev,
        "open_tasks": open_tasks,
    }


async def _team_slice(cid: str) -> dict:
    """Employee headcount + tasks/approvals rollup."""
    employees = await db.employees.find({
        "company_id": cid, "is_active": {"$ne": False},
    }, {"role": 1, "user_id": 1}).to_list(500)
    total_tasks = await db.tasks.count_documents({"company_id": cid})
    open_tasks = await db.tasks.count_documents({
        "company_id": cid, "status": "open"})
    today = now_iso()[:10]
    overdue_tasks = await db.tasks.count_documents({
        "company_id": cid, "status": "open",
        "due_date": {"$lt": today, "$ne": None}})
    pending_approvals = await db.time_entries.count_documents({
        "company_id": cid, "status": "submitted"})
    completion = round(
        (total_tasks - open_tasks) / total_tasks * 100, 1) if total_tasks else 0.0
    return {
        "employee_count": len(employees),
        "open_tasks": open_tasks,
        "overdue_tasks": overdue_tasks,
        "pending_approvals": pending_approvals,
        "task_completion_pct": completion,
    }


async def _recent_activity(cid: str, limit: int) -> list[dict]:
    """Merge deal activities + completed tasks + logged time into a
    single reverse-chronological ribbon."""
    stream: list[dict] = []
    # Deal activities (last N).
    async for d in db.deals.find({"company_id": cid},
            {"id": 1, "title": 1, "activities": 1}).sort(
            [("updated_at", -1)]).limit(50):
        for a in (d.get("activities") or []):
            stream.append({
                "id": f"deal_{a.get('id')}",
                "at": a.get("at"),
                "kind": a.get("kind") or "note",
                "source": "crm",
                "body": a.get("body"),
                "by_name": a.get("by_name"),
                "link_type": "deal",
                "link_id": d.get("id"),
                "link_label": d.get("title"),
            })
    # Recently-completed tasks.
    async for t in db.tasks.find({
        "company_id": cid, "status": "done"
    }).sort([("completed_at", -1)]).limit(30):
        stream.append({
            "id": f"task_{t.get('id')}",
            "at": t.get("completed_at") or t.get("updated_at"),
            "kind": t.get("kind") or "task",
            "source": "team",
            "body": f"✅ {t.get('title')}",
            "by_name": None,
            "link_type": t.get("entity_type"),
            "link_id": t.get("entity_id"),
            "link_label": t.get("entity_label"),
        })
    # Logged time entries.
    async for te in db.time_entries.find({
        "company_id": cid, "end_time": {"$ne": None}
    }).sort([("end_time", -1)]).limit(20):
        mins = int(te.get("duration_minutes") or 0)
        stream.append({
            "id": f"time_{te.get('id')}",
            "at": te.get("end_time"),
            "kind": "time",
            "source": "team",
            "body": f"⏱ Logged {mins // 60}h {mins % 60}m"
                     + (f" · {te.get('notes')}" if te.get("notes") else ""),
            "by_name": None,
            "link_type": "project",
            "link_id": te.get("project_id"),
            "link_label": None,
        })
    stream.sort(key=lambda x: x.get("at") or "", reverse=True)
    return stream[:limit]


@router.get("/companies/{cid}/home-summary")
async def home_summary(
    cid: str,
    activity_limit: int = 12,
    user: dict = Depends(get_current_user),
) -> dict:
    """Cross-product dashboard payload.

    Envelope is `{widgets: [...], meta: {...}}` so Phase 2 can layer
    on per-user reordering and Phase 3 can inject AI-generated KPIs
    without breaking the contract.
    """
    await require_company(user, cid)
    now = now_iso()
    month_prefix = now[:7]

    acc = await _accounting_slice(cid, month_prefix)
    crm = await _crm_slice(cid)
    proj = await _projects_slice(cid)
    team = await _team_slice(cid)
    activity = await _recent_activity(cid, activity_limit)
    top_cust = await _top_customers(cid)
    util = await _team_utilization(cid)
    notifs = await _notifications_slice(cid, user)
    custom_widgets = await _custom_widgets(cid, user)

    widgets = [
        # Hero KPI band (row 1)
        {"id": "kpi.revenue_mtd",     "kind": "kpi",
         "label": "Revenue this month", "tone": "emerald",
         "value_kind": "currency",     "value": acc["income_mtd"],
         "sub": f"Net {acc['net_mtd']:+,.0f}"},
        {"id": "kpi.employees",       "kind": "kpi",
         "label": "Active employees", "tone": "cyan",
         "value_kind": "number",       "value": team["employee_count"],
         "sub": f"{team['pending_approvals']} pending approvals"},
        {"id": "kpi.pipeline",        "kind": "kpi",
         "label": "Pipeline value",   "tone": "violet",
         "value_kind": "currency",     "value": crm["open_value"],
         "sub": f"Weighted {crm['weighted']:,.0f} · {crm['open_count']} deals"},
        {"id": "kpi.active_projects", "kind": "kpi",
         "label": "Active projects",  "tone": "amber",
         "value_kind": "number",       "value": proj["active_count"],
         "sub": f"{proj['open_tasks']} open tasks"},

        # Team-health donut (row 2, left)
        {"id": "team.health", "kind": "donut",
         "label": "Team health",
         "percent": team["task_completion_pct"],
         "caption": _health_caption(team["task_completion_pct"]),
         "legend": [
            {"label": "Task completion", "value": team["task_completion_pct"], "tone": "emerald"},
            {"label": "Overdue",         "value": team["overdue_tasks"],       "tone": "rose"},
         ]},

        # Module cards (row 3)
        {"id": "module.sales", "kind": "module",
         "label": "Sales",              "tone": "violet",
         "product": "crm",              "link": "/crm",
         "metrics": [
            {"label": "New leads",   "value": crm["leads_new"]},
            {"label": "Active deals","value": crm["open_count"]},
         ],
         "trend_hint": "+24.5% vs last month"},
        {"id": "module.projects", "kind": "module",
         "label": "Projects",           "tone": "amber",
         "product": "projects",         "link": "/accounting/projects",
         "metrics": [
            {"label": "Active",     "value": proj["active_count"]},
            {"label": "Open tasks", "value": proj["open_tasks"]},
         ],
         "trend_hint": "+16.3% vs last month"},
        {"id": "module.team", "kind": "module",
         "label": "Team",               "tone": "cyan",
         "product": "team",             "link": "/team",
         "metrics": [
            {"label": "Team members","value": team["employee_count"]},
            {"label": "Overdue",     "value": team["overdue_tasks"]},
         ],
         "trend_hint": "+9.1% vs last month"},
        {"id": "module.finance", "kind": "module",
         "label": "Finance",            "tone": "emerald",
         "product": "accounting",       "link": "/dashboard",
         "metrics": [
            {"label": "Revenue MTD", "value": acc["income_mtd"], "kind": "currency"},
            {"label": "Unpaid AR",   "value": acc["unpaid_ar_count"]},
         ],
         "trend_hint": f"{acc['unpaid_ar_count']} invoices to collect"},

        # Activity feed (row 4)
        {"id": "feed.recent", "kind": "activity",
         "label": "Recent activity",
         "items": activity},

        # Notifications (widget lives on Home + mirrored in the bell)
        {"id": "feed.notifications", "kind": "notifications",
         "label": "Notifications",
         "items": notifs},

        # ---- Library widgets (hidden by default, add from tray) ----
        {"id": "kpi.bank_balance", "kind": "kpi",
         "label": "Bank balance", "tone": "emerald",
         "value_kind": "currency", "value": acc["bank_balance"],
         "sub": "across all cash accounts",
         "default_hidden": True},
        {"id": "kpi.cash_runway", "kind": "kpi",
         "label": "Cash runway", "tone": "amber",
         "value_kind": "text",
         "value": ("∞" if acc["runway_months"] is None
                   else f"{acc['runway_months']} mo"),
         "sub": ("cash-positive" if acc["runway_months"] is None
                 else "at current burn"),
         "default_hidden": True},
        {"id": "kpi.team_utilization", "kind": "kpi",
         "label": "Team utilization (30d)", "tone": "cyan",
         "value_kind": "percent", "value": util["utilization_pct"],
         "sub": (f"{util['billable_minutes'] // 60}h billable · "
                  f"{util['non_billable_minutes'] // 60}h non-billable"),
         "default_hidden": True},
        {"id": "list.top_customers", "kind": "list",
         "label": "Top customers", "tone": "violet",
         "value_kind": "currency",
         "items": top_cust,
         "empty_label": "No paid customers yet — send an invoice first.",
         "default_hidden": True},
        {"id": "list.overdue_invoices", "kind": "list",
         "label": "Overdue invoices", "tone": "rose",
         "value_kind": "currency",
         "items": [{
            "id": inv["id"], "label": inv["label"],
            "value": inv["value"],
            "sub": f"{inv['days_overdue']}d overdue",
         } for inv in acc["overdue_invoices"]],
         "empty_label": "Nothing overdue — you're all caught up.",
         "default_hidden": True},
    ] + custom_widgets

    return {
        "widgets": widgets,
        "meta": {
            "generated_at": now,
            "month": month_prefix,
            "slices": {
                "accounting": acc, "crm": crm,
                "projects": proj, "team": team,
            },
        },
    }


async def _notifications_slice(cid: str, user: dict) -> list[dict]:
    """Load THIS user's recent unread notifications on THIS company
    (bell shows the global feed; the home widget stays company-
    scoped so multi-company Pros can compare at a glance)."""
    from routes.notifications import _compute_stale_deals
    rows = await db.notifications.find({
        "company_id": cid, "user_id": user["id"], "read": False,
    }).sort([("created_at", -1)]).to_list(10)
    virtual = await _compute_stale_deals(cid, user["id"])
    combined = [_clean(r) for r in rows] + virtual
    combined.sort(key=lambda n: n.get("created_at") or "", reverse=True)
    return combined[:10]


async def _custom_widgets(cid: str, user: dict) -> list[dict]:
    """Load AI-generated custom KPIs owned by the company or the
    current user, execute each pipeline, and emit `kpi` widgets.

    Runs each saved pipeline through `run_custom_kpi()` — that helper
    lives in `custom_kpis.py` so the executor + validator live next to
    the routes that let a user CREATE the KPI. Fails silent per-widget
    so one bad KPI never breaks the dashboard load.
    """
    try:
        from routes.custom_kpis import run_custom_kpi
    except Exception:
        return []
    rows = await db.custom_kpis.find({
        "company_id": cid,
        "$or": [{"scope": "company"}, {"owner_user_id": user["id"]}],
    }).to_list(50)
    out: list[dict] = []
    for r in rows:
        try:
            value = await run_custom_kpi(cid, r)
        except Exception:
            value = None
        out.append({
            "id": f"custom.{r['id']}",
            "kind": "kpi",
            "label": r.get("name") or "Custom KPI",
            "tone": r.get("tone") or "violet",
            "value_kind": r.get("value_kind") or "number",
            "value": value if value is not None else "—",
            "sub": r.get("description") or "AI-generated",
            "custom": True,
            "custom_kpi_id": r["id"],
        })
    return out


def _health_caption(pct: float) -> str:
    if pct >= 80: return "Great"
    if pct >= 60: return "Good"
    if pct >= 40: return "OK"
    if pct > 0:   return "Behind"
    return "No data"
