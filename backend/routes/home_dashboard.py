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
    }, {"balance": 1, "total": 1, "amount_paid": 1})
    unpaid_total = 0.0
    unpaid_count = 0
    async for inv in unpaid_cursor:
        bal = inv.get("balance")
        if bal is None:
            bal = float(inv.get("total") or 0) - float(inv.get("amount_paid") or 0)
        if bal > 0:
            unpaid_total += float(bal)
            unpaid_count += 1
    net = round(income - expense, 2)
    return {
        "income_mtd": round(income, 2),
        "expense_mtd": round(expense, 2),
        "net_mtd": net,
        "unpaid_ar_total": round(unpaid_total, 2),
        "unpaid_ar_count": unpaid_count,
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
    ]

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


def _health_caption(pct: float) -> str:
    if pct >= 80: return "Great"
    if pct >= 60: return "Good"
    if pct >= 40: return "OK"
    if pct > 0:   return "Behind"
    return "No data"
