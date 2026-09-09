"""SmartBooks — Agent Platform (Cockpit Phase 5A).

Puzzle-class scheduled AI agents built on top of the workflows we
already ship. Every agent = an instance of one **template** with a
schedule, a scope (company_id or firm-wide), and a config blob.

Templates seeded in this file (`_TEMPLATES`):
  1. cleanup_sweep        — auto-categorize uncat'd transactions
  2. je_auto_drafter      — run prepaid amort + accrual JE drafters
  3. advisor_report_send  — generate + optionally send advisor pack
  4. tax_1099_watcher     — quarterly vendor threshold check
  5. portal_chase         — nudge stale portal client questions
  6. signoff_reminder     — nudge unresolved close sign-offs after N days

Each template exposes `run(cid, agent, config, user_hint)` returning a
list of `finding` dicts.  Findings surface in Today feed as
`source=agent` cards and can be approved/dismissed from the drawer.

Scheduler: **wake-on-request**. When any firm user hits
`/api/cockpit/today` or `/api/cockpit/agents/*` we call
`tick_due_agents()` which enqueues due agents via a background task.
Simpler than APScheduler, no infra, no leader-election.
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Callable

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from db import db, now_iso, coerce
from auth import get_current_user
from routes.cockpit import require_firm_or_pro

router = APIRouter(prefix="/api/cockpit", tags=["agents"])


# ---------------------------------------------------------------------------
# Template catalog
# ---------------------------------------------------------------------------
# Each template is a plain dict + a `run` async callable.  Keeping the
# implementations inline (rather than dynamic imports) keeps the module
# easy to reason about and grep.

async def _run_cleanup_sweep(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Count uncategorized transactions and surface a finding if any."""
    threshold = int(cfg.get("min_uncategorized", 1) or 1)
    n = await db.transactions.count_documents({
        "company_id": cid,
        "$or": [
            {"account_id": None},
            {"account_id": ""},
            {"needs_review": True},
        ],
    })
    if n < threshold:
        return []
    return [{
        "kind": "cleanup_sweep",
        "severity": "amber" if n < 25 else "red",
        "title": f"{n} transactions need categorization",
        "detail": (
            f"Auto-sweep found {n} uncategorized or flagged transactions. "
            "Open Cleanup Copilot to review and post."
        ),
        "action_label": "Open Cleanup",
        "action_route": f"/accounting/check-register?company={cid}",
        "count": n,
    }]


async def _run_je_auto_drafter(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Kick the JE drafters scan and report how many pending drafts exist."""
    from routes.je_drafters import (
        _draft_prepaid_amortizations, _draft_recurring_accruals,
    )
    period = cfg.get("period") or _last_closed_or_current_ym()
    try:
        y, m = int(period[:4]), int(period[5:7])
    except Exception:
        return []
    # Clear stale pending drafts (same behavior as the scan endpoint).
    await db.je_drafts.delete_many({
        "company_id": cid, "period": period, "status": "pending",
    })
    drafts = []
    kinds = set(cfg.get("kinds") or ["prepaid_amort", "accrual"])
    if "prepaid_amort" in kinds:
        drafts += await _draft_prepaid_amortizations(cid, y, m)
    if "accrual" in kinds:
        drafts += await _draft_recurring_accruals(cid, y, m)
    if drafts:
        await db.je_drafts.insert_many(drafts)
    if not drafts:
        return []
    return [{
        "kind": "je_auto_drafter",
        "severity": "blue",
        "title": f"{len(drafts)} JE drafts ready for review",
        "detail": (
            f"Auto-drafted prepaid amortization + accruals for {period}. "
            "Approve or edit each before posting."
        ),
        "action_label": "Review drafts",
        "action_route": f"/accounting/journal-entries?tab=drafts",
        "count": len(drafts),
        "meta": {"period": period},
    }]


async def _run_advisor_report_send(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Check if the target period's advisor report exists; produce a finding
    if the CPA still needs to generate/send it."""
    period = cfg.get("period") or _last_closed_or_current_ym()
    existing = await db.advisor_reports.find_one({"company_id": cid, "period": period})
    if existing and existing.get("sent_to_client_at"):
        return []
    if existing:
        return [{
            "kind": "advisor_report_send",
            "severity": "amber",
            "title": f"Advisor report ready — not yet sent",
            "detail": f"The {period} advisor pack is generated but hasn't been shared with the client.",
            "action_label": "Send to portal",
            "action_route": "/cockpit/reports",
            "count": 1,
            "meta": {"period": period, "report_id": existing.get("id")},
        }]
    return [{
        "kind": "advisor_report_send",
        "severity": "amber",
        "title": f"Advisor report not generated for {period}",
        "detail": "Auto-run scheduled — generate and send the branded monthly pack.",
        "action_label": "Generate report",
        "action_route": "/cockpit/reports",
        "count": 1,
        "meta": {"period": period},
    }]


async def _run_tax_1099_watcher(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Flag vendors approaching or past the 1099 threshold."""
    threshold = float(cfg.get("threshold", 600.0) or 600.0)
    warn_at = float(cfg.get("warn_at", 500.0) or 500.0)
    year = int(cfg.get("year") or datetime.now(timezone.utc).year)
    start = f"{year:04d}-01-01"; end = f"{year:04d}-12-31"

    pipeline = [
        {"$match": {
            "company_id": cid,
            "date": {"$gte": start, "$lte": end},
            "kind": {"$in": ["bill", "expense", "check", "payment"]},
        }},
        {"$group": {"_id": "$vendor_id", "total": {"$sum": "$amount"}}},
        {"$match": {"total": {"$gte": warn_at}}},
    ]
    try:
        rows = await db.transactions.aggregate(pipeline).to_list(500)
    except Exception:
        rows = []
    if not rows:
        return []
    over = [r for r in rows if (r.get("total") or 0) >= threshold]
    warn = [r for r in rows if warn_at <= (r.get("total") or 0) < threshold]
    findings = []
    if over:
        findings.append({
            "kind": "tax_1099_watcher",
            "severity": "amber",
            "title": f"{len(over)} vendor{'s' if len(over) != 1 else ''} crossed 1099 threshold",
            "detail": f"Confirm W-9s are on file and prepare 1099-NEC forms for {year}.",
            "action_label": "Open 1099 Cockpit",
            "action_route": "/cockpit/1099",
            "count": len(over),
            "meta": {"year": year, "threshold": threshold},
        })
    if warn:
        findings.append({
            "kind": "tax_1099_watcher",
            "severity": "blue",
            "title": f"{len(warn)} vendor{'s' if len(warn) != 1 else ''} near 1099 threshold",
            "detail": f"Vendors paid ${warn_at:,.0f}–${threshold:,.0f} year-to-date — watch through year-end.",
            "action_label": "Open 1099 Cockpit",
            "action_route": "/cockpit/1099",
            "count": len(warn),
            "meta": {"year": year, "warn_at": warn_at},
        })
    return findings


async def _run_portal_chase(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Surface stale portal client questions past `stale_days`."""
    stale_days = int(cfg.get("stale_days", 3) or 3)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    stale = await db.client_questions.count_documents({
        "company_id": cid,
        "status": "pending",
        "sent_at": {"$lt": cutoff},
    })
    if stale <= 0:
        return []
    return [{
        "kind": "portal_chase",
        "severity": "amber",
        "title": f"{stale} client question{'s' if stale != 1 else ''} unanswered {stale_days}+ days",
        "detail": "Send a friendly nudge from the Client Requests rail.",
        "action_label": "Open Requests",
        "action_route": f"/cockpit/requests?company={cid}",
        "count": stale,
    }]


async def _run_signoff_reminder(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Flag close periods sitting in `waiting` sign-off past `stale_days`."""
    stale_days = int(cfg.get("stale_days", 3) or 3)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    stale = await db.client_signoffs.count_documents({
        "company_id": cid,
        "status": "waiting",
        "sent_at": {"$lt": cutoff},
    })
    if stale <= 0:
        return []
    return [{
        "kind": "signoff_reminder",
        "severity": "amber",
        "title": f"{stale} close sign-off{'s' if stale != 1 else ''} pending {stale_days}+ days",
        "detail": "Resend the sign-off link or ping the client on the portal.",
        "action_label": "Open Requests",
        "action_route": f"/cockpit/requests?company={cid}",
        "count": stale,
    }]


_TEMPLATES: dict[str, dict] = {
    "cleanup_sweep": {
        "key": "cleanup_sweep",
        "name": "Cleanup Sweep",
        "description": "Detects uncategorized and needs-review transactions and posts them to Today.",
        "icon": "Sparkles",
        "default_schedule": "daily",
        "default_config": {"min_uncategorized": 1},
        "config_fields": [
            {"key": "min_uncategorized", "label": "Minimum txns to trigger", "type": "number", "default": 1},
        ],
        "scope": "per_company",
        "run": _run_cleanup_sweep,
    },
    "je_auto_drafter": {
        "key": "je_auto_drafter",
        "name": "JE Auto-Drafter",
        "description": "Scans prepaid amortization and recurring accruals; queues JE drafts for review.",
        "icon": "FileEdit",
        "default_schedule": "monthly",
        "default_config": {"kinds": ["prepaid_amort", "accrual"]},
        "config_fields": [
            {"key": "kinds", "label": "Drafter kinds", "type": "multiselect",
             "options": [
                {"value": "prepaid_amort", "label": "Prepaid amortization"},
                {"value": "accrual", "label": "Recurring accruals"},
             ], "default": ["prepaid_amort", "accrual"]},
        ],
        "scope": "per_company",
        "run": _run_je_auto_drafter,
    },
    "advisor_report_send": {
        "key": "advisor_report_send",
        "name": "Advisor Report Auto-Send",
        "description": "Ensures every closed period has an advisor pack generated and delivered to the client.",
        "icon": "FileBarChart2",
        "default_schedule": "monthly",
        "default_config": {},
        "config_fields": [],
        "scope": "per_company",
        "run": _run_advisor_report_send,
    },
    "tax_1099_watcher": {
        "key": "tax_1099_watcher",
        "name": "1099 Threshold Watcher",
        "description": "Watches vendor spend and warns as vendors approach the $600 IRS threshold.",
        "icon": "Receipt",
        "default_schedule": "quarterly",
        "default_config": {"threshold": 600.0, "warn_at": 500.0},
        "config_fields": [
            {"key": "threshold", "label": "1099 threshold ($)", "type": "number", "default": 600.0},
            {"key": "warn_at", "label": "Early warning at ($)", "type": "number", "default": 500.0},
        ],
        "scope": "per_company",
        "run": _run_tax_1099_watcher,
    },
    "portal_chase": {
        "key": "portal_chase",
        "name": "Portal Chase",
        "description": "Nudges stale client-portal questions after a configurable number of days.",
        "icon": "MessageSquare",
        "default_schedule": "daily",
        "default_config": {"stale_days": 3},
        "config_fields": [
            {"key": "stale_days", "label": "Days before stale", "type": "number", "default": 3},
        ],
        "scope": "per_company",
        "run": _run_portal_chase,
    },
    "signoff_reminder": {
        "key": "signoff_reminder",
        "name": "Sign-off Reminder",
        "description": "Reminds clients who haven't approved their monthly close after a configurable number of days.",
        "icon": "BellRing",
        "default_schedule": "daily",
        "default_config": {"stale_days": 3},
        "config_fields": [
            {"key": "stale_days", "label": "Days before reminder", "type": "number", "default": 3},
        ],
        "scope": "per_company",
        "run": _run_signoff_reminder,
    },
}

_SCHEDULE_INTERVALS: dict[str, timedelta] = {
    "hourly":    timedelta(hours=1),
    "daily":     timedelta(days=1),
    "weekly":    timedelta(days=7),
    "monthly":   timedelta(days=30),
    "quarterly": timedelta(days=90),
}


def _last_closed_or_current_ym() -> str:
    """Prior month YYYY-MM — books-lag heuristic used across Cockpit."""
    now = datetime.now(timezone.utc)
    if now.month == 1:
        return f"{now.year - 1:04d}-12"
    return f"{now.year:04d}-{now.month - 1:02d}"


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def _run_agent(agent: dict, triggered_by: str = "schedule") -> dict:
    """Execute one agent and persist a run + findings. Idempotent per
    (agent_id, triggered_by) — we always create a new run doc."""
    template = _TEMPLATES.get(agent.get("template_key"))
    if not template:
        return {"ok": False, "error": "unknown-template"}

    run_id = str(uuid.uuid4())
    started_at = now_iso()
    await db.agent_runs.insert_one({
        "id": run_id, "agent_id": agent["id"], "company_id": agent.get("company_id"),
        "template_key": agent["template_key"],
        "status": "running", "triggered_by": triggered_by,
        "started_at": started_at, "finished_at": None,
        "findings_count": 0, "error": None,
    })

    cfg = {**(template.get("default_config") or {}), **(agent.get("config") or {})}
    cid = agent.get("company_id")

    findings: list[dict] = []
    error_msg: Optional[str] = None
    try:
        raw = await template["run"](cid, agent, cfg)
        for f in (raw or []):
            findings.append({
                "id": str(uuid.uuid4()),
                "agent_id": agent["id"],
                "run_id": run_id,
                "company_id": cid,
                "template_key": agent["template_key"],
                "kind": f.get("kind") or agent["template_key"],
                "severity": f.get("severity") or "blue",
                "title": f.get("title") or "Agent finding",
                "detail": f.get("detail") or "",
                "action_label": f.get("action_label"),
                "action_route": f.get("action_route"),
                "count": f.get("count") or 1,
                "meta": f.get("meta") or {},
                "status": "open",
                "created_at": now_iso(),
            })
    except Exception as exc:  # noqa: BLE001
        error_msg = f"{type(exc).__name__}: {exc}"

    if findings:
        await db.agent_findings.insert_many(findings)

    await db.agent_runs.update_one(
        {"id": run_id},
        {"$set": {
            "status": "failed" if error_msg else "success",
            "finished_at": now_iso(),
            "findings_count": len(findings),
            "error": error_msg,
        }},
    )
    await db.agents.update_one(
        {"id": agent["id"]},
        {"$set": {
            "last_run_at": now_iso(),
            "last_run_status": "failed" if error_msg else "success",
            "last_findings_count": len(findings),
        }},
    )
    return {
        "ok": not bool(error_msg), "run_id": run_id,
        "findings_count": len(findings), "error": error_msg,
    }


async def _due(agent: dict) -> bool:
    if not agent.get("enabled"):
        return False
    schedule = agent.get("schedule") or "daily"
    interval = _SCHEDULE_INTERVALS.get(schedule, timedelta(days=1))
    last = agent.get("last_run_at")
    if not last:
        return True
    try:
        d = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except Exception:
        return True
    return (datetime.now(timezone.utc) - d) >= interval


async def tick_due_agents(company_ids: list[str], *, background: BackgroundTasks | None = None) -> int:
    """Run every enabled agent whose next-run time has elapsed. Returns
    the number of runs enqueued.  Call from any Cockpit endpoint that a
    firm user hits.  Idempotent: an already-running agent will still get
    a new run, but the templates are safe to re-run (no double-writes).
    """
    if not company_ids:
        return 0
    cursor = db.agents.find({
        "enabled": True,
        "$or": [
            {"company_id": {"$in": company_ids}},
            {"company_id": None},  # firm-wide agents
        ],
    })
    agents = await cursor.to_list(500)
    launched = 0
    for a in agents:
        if not await _due(a):
            continue
        if background is not None:
            background.add_task(_run_agent, a, "schedule")
        else:
            # sync path used only in tests
            await _run_agent(a, "schedule")
        launched += 1
    return launched


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AgentCreateIn(BaseModel):
    template_key: str
    company_id: Optional[str] = None
    name: Optional[str] = None
    schedule: Optional[str] = None
    config: Optional[dict] = Field(default_factory=dict)
    enabled: bool = True


class AgentPatchIn(BaseModel):
    name: Optional[str] = None
    schedule: Optional[str] = None
    config: Optional[dict] = None
    enabled: Optional[bool] = None


class FindingPatchIn(BaseModel):
    status: str  # "open" | "resolved" | "dismissed"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/agents/templates")
async def list_templates(user: dict = Depends(get_current_user)):
    await require_firm_or_pro(user)
    out = []
    for t in _TEMPLATES.values():
        out.append({k: v for k, v in t.items() if k != "run"})
    return {"templates": out}


@router.get("/agents")
async def list_agents(
    background: BackgroundTasks,
    company_id: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"agents": [], "counts": {}}
    q: dict = {"$or": [
        {"company_id": {"$in": accessible}},
        {"company_id": None},
    ]}
    if company_id:
        q = {"company_id": company_id}
    docs = await db.agents.find(q).sort("created_at", -1).limit(500).to_list(500)
    # Wake-on-request scheduler tick.
    await tick_due_agents(accessible, background=background)
    agents = [coerce(d) for d in docs]
    counts = {
        "total": len(agents),
        "enabled": sum(1 for a in agents if a.get("enabled")),
        "disabled": sum(1 for a in agents if not a.get("enabled")),
    }
    return {"agents": agents, "counts": counts}


@router.post("/agents")
async def create_agent(inp: AgentCreateIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    template = _TEMPLATES.get(inp.template_key)
    if not template:
        raise HTTPException(400, f"Unknown template: {inp.template_key}")
    if inp.company_id and inp.company_id not in accessible:
        raise HTTPException(403, "You don't have access to that company.")
    agent = {
        "id": str(uuid.uuid4()),
        "template_key": inp.template_key,
        "name": inp.name or template["name"],
        "company_id": inp.company_id,
        "schedule": inp.schedule or template["default_schedule"],
        "config": {**(template.get("default_config") or {}), **(inp.config or {})},
        "enabled": inp.enabled,
        "created_by": user.get("email") or user.get("id"),
        "created_at": now_iso(),
        "last_run_at": None,
        "last_run_status": None,
        "last_findings_count": 0,
    }
    await db.agents.insert_one(agent)
    return {"agent": coerce(agent)}


@router.patch("/agents/{agent_id}")
async def patch_agent(agent_id: str, inp: AgentPatchIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        raise HTTPException(404, "Agent not found.")
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    update: dict = {}
    if inp.name is not None:      update["name"] = inp.name
    if inp.schedule is not None:  update["schedule"] = inp.schedule
    if inp.config is not None:    update["config"] = inp.config
    if inp.enabled is not None:   update["enabled"] = inp.enabled
    if update:
        await db.agents.update_one({"id": agent_id}, {"$set": update})
    return {"agent": coerce(await db.agents.find_one({"id": agent_id}))}


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        return {"ok": True}
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    await db.agents.delete_one({"id": agent_id})
    await db.agent_findings.delete_many({"agent_id": agent_id})
    await db.agent_runs.delete_many({"agent_id": agent_id})
    return {"ok": True}


@router.post("/agents/{agent_id}/run-now")
async def run_now(agent_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        raise HTTPException(404, "Agent not found.")
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    result = await _run_agent(agent, triggered_by=f"manual:{user.get('email') or user.get('id')}")
    return result


@router.get("/agents/{agent_id}/runs")
async def list_runs(agent_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        raise HTTPException(404, "Agent not found.")
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    docs = await db.agent_runs.find({"agent_id": agent_id}).sort("started_at", -1).limit(50).to_list(50)
    return {"runs": [coerce(d) for d in docs]}


@router.get("/agent-runs/{run_id}")
async def run_detail(run_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    run = await db.agent_runs.find_one({"id": run_id})
    if not run:
        raise HTTPException(404, "Run not found.")
    if run.get("company_id") and run["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    findings = await db.agent_findings.find({"run_id": run_id}).to_list(500)
    return {"run": coerce(run), "findings": [coerce(f) for f in findings]}


@router.get("/agent-findings")
async def list_findings(
    company_id: Optional[str] = Query(None),
    status: str = Query("open"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"findings": []}
    q: dict = {"status": status} if status and status != "all" else {}
    q["$or"] = [
        {"company_id": {"$in": accessible}},
        {"company_id": None},
    ]
    if company_id:
        q = {"company_id": company_id}
        if status and status != "all":
            q["status"] = status
    docs = await db.agent_findings.find(q).sort("created_at", -1).limit(limit).to_list(limit)
    return {"findings": [coerce(d) for d in docs]}


@router.patch("/agent-findings/{finding_id}")
async def patch_finding(finding_id: str, inp: FindingPatchIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    f = await db.agent_findings.find_one({"id": finding_id})
    if not f:
        raise HTTPException(404, "Finding not found.")
    if f.get("company_id") and f["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    if inp.status not in {"open", "resolved", "dismissed"}:
        raise HTTPException(400, "Invalid status.")
    await db.agent_findings.update_one(
        {"id": finding_id},
        {"$set": {"status": inp.status, "resolved_at": now_iso() if inp.status != "open" else None,
                  "resolved_by": user.get("email") or user.get("id") if inp.status != "open" else None}},
    )
    return {"ok": True}
