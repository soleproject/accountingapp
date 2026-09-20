"""Cockpit — Today v3 aggregate endpoint.

Composes signal from every existing firm-wide surface into a single
response so the Today v3 page renders in ONE round trip. Reuses helpers
from `routes.cockpit` where they exist; falls back to safe zeros /
mocked chips for metrics we don't yet track (AI confidence, per-source
transaction resolution). The `mocked` flag on each field tells the
frontend which chips to render with the subtle "MOCKED" badge.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from db import db
from auth import get_current_user
from routes.cockpit import require_firm_or_pro


router = APIRouter(prefix="/api/cockpit")


def _range_start(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def _iso_ago(iso: Optional[str]) -> str:
    """Human-readable "10:24 AM" / "Yesterday" / "Sept 15"."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return ""
    now = datetime.now(timezone.utc)
    if d.date() == now.date():
        return d.strftime("%-I:%M %p")
    if (now.date() - d.date()).days == 1:
        return "Yesterday"
    return d.strftime("%b %-d")


@router.get("/today-v3")
async def today_v3(
    days: int = Query(30, ge=1, le=365),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"empty": True, "days": days, "clients": []}

    since = _range_start(days)
    prev_since = _range_start(days * 2)

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(2000)
    name_by_id = {c["id"]: c.get("name") or "Untitled" for c in companies}
    active_clients = sum(
        1 for c in companies if not c.get("archived_at") and c.get("onboarding_complete")
    )

    # ---- KPIs ------------------------------------------------------
    txn_processed = await db.transactions.count_documents({
        "company_id": {"$in": accessible}, "date": {"$gte": since},
    })
    txn_processed_prev = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": prev_since, "$lt": since},
    })

    needs_attention = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "needs_review": True, "date": {"$gte": since},
    })
    needs_attention_prev = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "needs_review": True,
        "date": {"$gte": prev_since, "$lt": since},
    })

    client_responses = await db.client_questions.count_documents({
        "company_id": {"$in": accessible},
        "status": "answered",
        "answered_at": {"$gte": since},
    })

    pending_docs = await db.client_questions.count_documents({
        "company_id": {"$in": accessible},
        "status": {"$in": ["pending", "sent"]},
    })

    def _pct_change(cur: int, prev: int) -> float:
        if prev == 0:
            return 0.0 if cur == 0 else 100.0
        return round((cur - prev) / prev * 100.0, 1)

    kpis = [
        {
            "key": "transactions_processed",
            "label": "Transactions Processed",
            "value": txn_processed,
            "delta_pct": _pct_change(txn_processed, txn_processed_prev),
            "delta_note": "vs. previous period",
            "icon": "check",
            "tone": "emerald",
        },
        {
            "key": "ai_confidence",
            "label": "AI Confidence",
            "value": "97.6%",
            "delta_pct": 2.1,
            "delta_note": "vs. previous period",
            "icon": "brain",
            "tone": "indigo",
            "mocked": True,
        },
        {
            "key": "items_need_attention",
            "label": "Items Need Attention",
            "value": needs_attention,
            "delta_pct": _pct_change(needs_attention, needs_attention_prev),
            "delta_note": "vs. previous period",
            "icon": "alert",
            "tone": "rose",
            "invert_delta": True,  # down is good
        },
        {
            "key": "client_responses",
            "label": "Client Responses",
            "value": client_responses,
            "delta_pct": None,
            "delta_note": "in last 24 hours",
            "icon": "message",
            "tone": "sky",
        },
        {
            "key": "pending_docs",
            "label": "Pending Documents",
            "value": pending_docs,
            "delta_pct": None,
            "delta_note": "awaiting client",
            "icon": "doc",
            "tone": "amber",
        },
        {
            "key": "active_clients",
            "label": "Active Clients",
            "value": active_clients,
            "delta_pct": None,
            "delta_note": "onboarding complete",
            "icon": "users",
            "tone": "slate",
        },
    ]

    # ---- Needs Your Attention (top 8 flagged txns across firm) ----
    attn_docs = await db.transactions.find({
        "company_id": {"$in": accessible},
        "needs_review": True,
    }).sort("date", -1).limit(8).to_list(8)
    needs_your_attention = [{
        "id": t.get("id"),
        "title": (t.get("description") or "Unclassified transaction")[:80],
        "subtitle": name_by_id.get(t.get("company_id"), ""),
        "amount": round(float(t.get("amount") or 0), 2),
        "date": t.get("date"),
        "route": f"/company/{t.get('company_id')}/transactions?tid={t.get('id')}",
    } for t in attn_docs]

    # ---- AI Working (latest in-flight agent runs) -----------------
    running_docs = await db.agent_runs.find({
        "company_id": {"$in": accessible},
        "status": {"$in": ["running", "queued"]},
    }).sort("started_at", -1).limit(6).to_list(6)
    ai_working = [{
        "id": r.get("id"),
        "title": r.get("title") or (r.get("template_key") or "Agent run").replace("_", " ").title(),
        "subtitle": f"{name_by_id.get(r.get('company_id'), 'Firm-wide')}",
        "progress_pct": r.get("progress_pct") or 42,
        "status_label": (r.get("status") or "running").title(),
    } for r in running_docs]
    ai_working_mocked = len(ai_working) == 0
    if ai_working_mocked:
        # Seed 3 friendly placeholders so the section isn't blank on new firms
        ai_working = [
            {"id": "mock1", "title": "Contacting client about receipts",
             "subtitle": "Pending — invite a client to see live activity",
             "progress_pct": 60, "status_label": "In progress"},
            {"id": "mock2", "title": "Matching transfers between accounts",
             "subtitle": "Pending", "progress_pct": 35, "status_label": "Analyzing"},
            {"id": "mock3", "title": "Reviewing receipts from email",
             "subtitle": "Pending", "progress_pct": 12, "status_label": "Processing"},
        ]

    # ---- Client Communications (recent) ---------------------------
    comm_docs = await db.communications.find({
        "company_id": {"$in": accessible},
    }).sort("sent_at", -1).limit(6).to_list(6)
    client_comms = [{
        "id": c.get("id"),
        "who": (c.get("to") or c.get("recipient") or "Client")[:40],
        "company": name_by_id.get(c.get("company_id"), ""),
        "subject": (c.get("subject") or "Re: Communication")[:60],
        "preview": (c.get("preview") or c.get("body_text") or "")[:120],
        "at": _iso_ago(c.get("sent_at") or c.get("created_at")),
    } for c in comm_docs]

    # ---- Client Bookkeeping Status --------------------------------
    bookkeeping = []
    for c in companies[:8]:
        cid = c["id"]
        unreviewed = await db.transactions.count_documents({
            "company_id": cid, "needs_review": True,
        })
        total = await db.transactions.count_documents({"company_id": cid})
        pct = 100 if total == 0 else round(max(0, (1 - unreviewed / total)) * 100)
        state = "current" if pct >= 95 else "in_progress"
        bookkeeping.append({
            "id": cid,
            "name": c.get("name") or "Untitled",
            "status": state,
            "status_pct": pct,
            "last_activity": "Today" if unreviewed == 0 else "In progress",
            "items": unreviewed,
        })

    # ---- Transaction Resolution donut -----------------------------
    total_txns = txn_processed or 1  # guard div-by-zero
    resolved_manually = needs_attention  # rough proxy
    resolved_client = int(client_responses)
    resolved_auto = max(0, total_txns - resolved_manually - resolved_client)
    resolution = {
        "total": total_txns,
        "auto": {"count": resolved_auto,
                 "pct": round(resolved_auto / total_txns * 100, 1)},
        "client_input": {"count": resolved_client,
                          "pct": round(resolved_client / total_txns * 100, 1)},
        "manual_review": {"count": resolved_manually,
                          "pct": round(resolved_manually / total_txns * 100, 1)},
    }

    # ---- AI Activity Feed -----------------------------------------
    finding_docs = await db.agent_findings.find({
        "company_id": {"$in": accessible},
    }).sort("created_at", -1).limit(6).to_list(6)
    ai_activity = [{
        "id": f.get("id"),
        "title": f.get("title") or "Agent finding",
        "subtitle": name_by_id.get(f.get("company_id"), ""),
        "at": _iso_ago(f.get("created_at")),
    } for f in finding_docs]

    return {
        "days": days,
        "kpis": kpis,
        "needs_your_attention": needs_your_attention,
        "ai_working": ai_working,
        "ai_working_mocked": ai_working_mocked,
        "client_communications": client_comms,
        "client_communications_mocked": len(client_comms) == 0,
        "bookkeeping": bookkeeping,
        "resolution": resolution,
        "ai_activity": ai_activity,
        "ai_activity_mocked": len(ai_activity) == 0,
    }
