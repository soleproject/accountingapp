"""
Client Cockpit — per-client status cards.

Powers 4 inline-expandable cards on `/cockpit/client`:
  1. Waiting on Client       — open portal/email/meeting comms threads
  2. Client Answers & Requests — answered threads awaiting CPA review
  3. Cash Flow Monitor       — summary of `/projections/cashflow` + burn
  4. Assigned Agents         — client-scoped + firm-wide agents

Each endpoint is a thin, read-only facade over existing collections
(`client_questions`, `agents`, `agent_runs`, `projections.cashflow`).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import db
from auth import get_current_user
from deps import require_company


router = APIRouter(prefix="/api")


# =============================================================================
# Helpers
# =============================================================================

def _age_days(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
        return max(0, (datetime.now(timezone.utc) - dt).days)
    except Exception:  # noqa: BLE001
        return None


def _channel_of(q: dict) -> str:
    """Infer a channel label from a client_questions doc."""
    # Portal / Email / Meeting — meeting entries are surfaced via
    # `flow_type` on notes/note-takers, but here we default to portal
    # vs email based on presence of a portal_token / to_email.
    if q.get("portal_id") or q.get("portal_token"):
        return "portal"
    if q.get("to_email"):
        return "email"
    return "portal"


async def _thread_row(q: dict) -> dict:
    """Shape a client_questions doc into a unified thread row."""
    return {
        "id": q.get("id"),
        "company_id": q.get("company_id"),
        "channel": _channel_of(q),
        "status": q.get("status") or "pending",
        "subject": (q.get("subject") or q.get("question") or "").strip(),
        "question": (q.get("question") or "").strip(),
        "answer": (q.get("answer") or "").strip(),
        "to_email": q.get("to_email"),
        "from_email": q.get("answered_by_email") or q.get("to_email"),
        "counterparty_label": q.get("counterparty_label"),
        "sent_at": q.get("sent_at") or q.get("created_at"),
        "answered_at": q.get("answered_at"),
        "cpa_reviewed_at": q.get("cpa_reviewed_at"),
        "age_days": _age_days(q.get("sent_at") or q.get("created_at")),
        "resent_count": int(q.get("resent_count") or 0),
        "chat_msg_count": len(q.get("chat_messages") or []),
        "txn_count": len(q.get("txn_ids") or ([q.get("txn_id")] if q.get("txn_id") else [])),
        "ai_proposal": q.get("ai_proposal"),
        "ai_confidence": (q.get("ai_proposal") or {}).get("confidence") if q.get("ai_proposal") else None,
        "flow_type": q.get("flow_type"),
    }


# =============================================================================
# Card 1 — Waiting on client (open threads)
# =============================================================================

@router.get("/companies/{cid}/cockpit-cards/waiting-on-client")
async def waiting_on_client(
    cid: str,
    channel: Optional[str] = Query(None, description="all|email|portal|meeting"),
    q: Optional[str] = Query(None, description="search over subject/question/to_email"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    """All open comms threads still awaiting a client reply."""
    await require_company(user, cid)
    docs = await db.client_questions.find({
        "company_id": cid,
        "status": {"$in": ["pending", "sent"]},
    }).sort("sent_at", -1).to_list(limit)

    rows = [await _thread_row(d) for d in docs]

    # Apply channel filter.
    if channel and channel != "all":
        rows = [r for r in rows if r["channel"] == channel]

    # Apply free-text search across subject / question / to_email.
    if q:
        needle = q.strip().lower()
        rows = [r for r in rows if any(
            needle in (r.get(k) or "").lower()
            for k in ("subject", "question", "to_email", "counterparty_label")
        )]

    counts = {
        "total": len(rows),
        "email": sum(1 for r in rows if r["channel"] == "email"),
        "portal": sum(1 for r in rows if r["channel"] == "portal"),
        "meeting": sum(1 for r in rows if r["channel"] == "meeting"),
        "stale_7d": sum(1 for r in rows if (r.get("age_days") or 0) >= 7),
    }
    return {"threads": rows, "counts": counts}


# =============================================================================
# Card 2 — Client answers & requests (answered threads)
# =============================================================================

@router.get("/companies/{cid}/cockpit-cards/client-answers")
async def client_answers(
    cid: str,
    channel: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    review_state: Optional[str] = Query("all", description="all|needs_review|reviewed"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    """All answered threads — surfaces client responses to review."""
    await require_company(user, cid)
    docs = await db.client_questions.find({
        "company_id": cid,
        "status": "answered",
    }).sort("answered_at", -1).to_list(limit)

    rows = [await _thread_row(d) for d in docs]

    if review_state == "needs_review":
        rows = [r for r in rows if not r.get("cpa_reviewed_at")]
    elif review_state == "reviewed":
        rows = [r for r in rows if r.get("cpa_reviewed_at")]

    if channel and channel != "all":
        rows = [r for r in rows if r["channel"] == channel]

    if q:
        needle = q.strip().lower()
        rows = [r for r in rows if any(
            needle in (r.get(k) or "").lower()
            for k in ("subject", "question", "answer", "to_email", "counterparty_label")
        )]

    counts = {
        "total": len(rows),
        "needs_review": sum(1 for r in rows if not r.get("cpa_reviewed_at")),
        "reviewed":    sum(1 for r in rows if r.get("cpa_reviewed_at")),
    }
    return {"threads": rows, "counts": counts}


# =============================================================================
# Card 3 — Cash flow snapshot
# =============================================================================

# Runway thresholds shown to the CPA as "issue" vs "healthy".
_RUNWAY_CRITICAL = 60   # days
_RUNWAY_WARNING = 120  # days


@router.get("/companies/{cid}/cockpit-cards/cashflow-snapshot")
async def cashflow_snapshot(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Compact snapshot of the Projections engine for the Client Cockpit.

    Reuses `routes.projections.projections_cashflow` for the same math
    that powers the full Projections page — no duplicate logic.
    """
    await require_company(user, cid)
    try:
        from routes.projections import projections_cashflow
        # Fixed 120-day horizon for the cockpit snapshot.
        data = await projections_cashflow(cid=cid, days=120, start_date=None, end_date=None, user=user)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Failed to load cashflow: {e}") from e

    snapshots = data.get("snapshots") or []
    runway = data.get("runway_days")
    burn_r = data.get("burn_reconciliation") or {}
    forward_monthly_burn = float(data.get("forward_monthly_burn") or 0.0)

    # Categorize the health signal for the row status pill.
    if runway is None or runway > _RUNWAY_WARNING:
        health = "healthy"
    elif runway <= _RUNWAY_CRITICAL:
        health = "critical"
    else:
        health = "warning"

    # Biggest 6 upcoming events for the "on the horizon" list on the drop.
    horizon_events: list[dict] = []
    for e in (data.get("events") or [])[:200]:
        amt = float(e.get("amount") or 0.0)
        if abs(amt) < 0.01:
            continue
        horizon_events.append({
            "date": e.get("date"),
            "label": e.get("label") or e.get("kind"),
            "amount": amt,
            "kind": e.get("kind"),
        })
    horizon_events.sort(key=lambda x: abs(x["amount"]), reverse=True)
    horizon_events = horizon_events[:6]

    # Thin the timeline for the compact card view — 1 point per day is
    # already OK for 120 days but we cap at ~130 points defensively.
    tl = data.get("timeline") or []
    timeline: list[dict] = []
    if tl:
        step = max(1, len(tl) // 130)
        timeline = [{"date": r.get("date"), "cash": float(r.get("cash") or 0.0)} for r in tl[::step]]
        # Always include the last point so the chart terminates cleanly.
        if timeline and tl[-1] is not timeline[-1]:
            last = tl[-1]
            timeline.append({"date": last.get("date"), "cash": float(last.get("cash") or 0.0)})

    # Per-account timelines for the "Per account" chart toggle — same
    # shape/thinning as the total timeline. Also include the cash
    # breakdown so the frontend can label each account.
    per_acct_raw = data.get("timeline_per_account") or {}
    per_account: dict[str, list[dict]] = {}
    if per_acct_raw:
        for aid, rows in per_acct_raw.items():
            if not rows:
                continue
            step = max(1, len(rows) // 130)
            thinned = [{"date": r.get("date"), "cash": float(r.get("cash") or 0.0)} for r in rows[::step]]
            if thinned and rows[-1] is not thinned[-1]:
                last = rows[-1]
                thinned.append({"date": last.get("date"), "cash": float(last.get("cash") or 0.0)})
            per_account[aid] = thinned
    cash_breakdown = [{
        "id": a.get("id"),
        "code": a.get("code"),
        "name": a.get("name"),
        "balance": float(a.get("balance") or 0.0),
        "balance_source": a.get("balance_source"),
    } for a in (data.get("cash_breakdown") or [])]

    return {
        "health": health,
        "as_of": data.get("as_of"),
        "cash_today": float(data.get("cash_today") or 0.0),
        "runway_days": runway,
        "forward_monthly_burn": forward_monthly_burn,
        "snapshots": snapshots,
        "burn_reconciliation": burn_r,
        "biggest_events": horizon_events,
        "timeline": timeline,
        "timeline_per_account": per_account,
        "cash_breakdown": cash_breakdown,
        "horizon_days": int(data.get("horizon_days") or 120),
        "horizon_end": data.get("horizon_end"),
        # Deep-link back into the full Projections page with a return
        # crumb so the CPA can drill in and pop back.
        "open_link": "/accounting/projections",
    }


# =============================================================================
# Card 4 — Assigned agents (client-specific + firm-wide, visually separated)
# =============================================================================

@router.get("/companies/{cid}/cockpit-cards/assigned-agents")
async def assigned_agents(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Return every agent scoped to this client, plus firm-wide agents
    that touch every client. Grouped for side-by-side rendering."""
    await require_company(user, cid)

    # Pull the template catalog so we can enrich rows with the human
    # name/description without duplicating the metadata here.
    try:
        from routes.agents import _TEMPLATES
        templates = _TEMPLATES or {}
    except Exception:  # noqa: BLE001
        templates = {}

    client_docs = await db.agents.find({"company_id": cid}).sort("created_at", -1).to_list(500)
    firm_docs = await db.agents.find({"company_id": None}).sort("created_at", -1).to_list(500)

    def _shape(a: dict) -> dict:
        tk = a.get("template_key") or ""
        tmpl = templates.get(tk) or {}
        return {
            "id": a.get("id"),
            "template_key": tk,
            "template_name": tmpl.get("name") or tk.replace("_", " ").title(),
            "template_description": tmpl.get("description"),
            "template_icon": tmpl.get("icon"),
            "name": a.get("name") or tmpl.get("name") or tk,
            "schedule": a.get("schedule") or tmpl.get("default_schedule"),
            "enabled": bool(a.get("enabled")),
            "last_run_at": a.get("last_run_at"),
            "last_run_status": a.get("last_run_status"),
            "last_findings_count": int(a.get("last_findings_count") or 0),
            "company_id": a.get("company_id"),
        }

    client_agents = [_shape(a) for a in client_docs]
    firm_agents = [_shape(a) for a in firm_docs]

    counts = {
        "client_total": len(client_agents),
        "client_enabled": sum(1 for a in client_agents if a["enabled"]),
        "firm_total": len(firm_agents),
        "firm_enabled": sum(1 for a in firm_agents if a["enabled"]),
    }
    return {
        "client_agents": client_agents,
        "firm_agents": firm_agents,
        "counts": counts,
    }


# =============================================================================
# Follow-up send (POST — nudges + adds a chat_message to the thread)
# =============================================================================

class FollowupIn(BaseModel):
    message: str


@router.post("/companies/{cid}/cockpit-cards/threads/{qid}/followup")
async def send_followup(
    cid: str, qid: str, inp: FollowupIn, user: dict = Depends(get_current_user),
):
    """Append a CPA follow-up message to an open thread and bump its
    resent counter. Client sees the follow-up in the portal + gets an
    email nudge via the existing resend path."""
    await require_company(user, cid)
    q = await db.client_questions.find_one({"id": qid, "company_id": cid})
    if not q:
        raise HTTPException(404, "Thread not found")
    if q.get("status") == "answered":
        raise HTTPException(400, "Thread already answered — send a new ask-client instead.")

    msg = (inp.message or "").strip()
    if not msg:
        raise HTTPException(400, "Message is empty")

    history = list(q.get("chat_messages") or [])
    history.append({
        "role": "cpa",
        "text": msg,
        "author": user.get("email") or user.get("id"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    await db.client_questions.update_one(
        {"id": qid},
        {"$set": {
            "chat_messages": history,
            "resent_at": datetime.now(timezone.utc).isoformat(),
            "resent_count": int(q.get("resent_count") or 0) + 1,
        }},
    )
    return {"ok": True, "chat_msg_count": len(history)}
