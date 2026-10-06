"""Daily plan-block digest: emails superadmins when real customers hit a plan gate or seat cap.

Called by the cron platform (see .emergent/crons.yml) with a Bearer token.
Quiet by default — no blocks in the window → no email (unless force=True).
"""
from __future__ import annotations

import asyncio
import hmac
import html
import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from auth import require_role
from db import db
from email_service import send_email
from entitlements import PLAN_LABELS, FEATURE_MIN_PLAN

log = logging.getLogger("axiom.cron.entitlement_digest")
router = APIRouter(prefix="/api/cron", tags=["cron"])
RUN_NAME = "entitlement_digest"

FEATURE_NAMES = {
    "chat": "AI Review Chat", "receipts_ai": "Receipt AI", "statements_ai": "Statement AI", "budgets": "Budgets",
    "classes": "Classes", "month_close": "Month-End Close", "bookkeeper_review": "Book Review", "checkins": "Quick Check-ins",
    "auto_emails": "Automated emails", "automations": "AI rules", "outlook": "Projections", "sales_tax": "Sales Tax",
    "inventory": "Inventory", "quota_users": "Team seats", "quota_connected_accounts": "Connected accounts",
}


async def _recipients() -> list[str]:
    env = (os.environ.get("ENTITLEMENT_DIGEST_TO") or "").strip()
    if env:
        return [e.strip() for e in env.split(",") if e.strip()]
    return [u["email"] async for u in db.users.find({"role": "superadmin", "email": {"$ne": None}}, {"_id": 0, "email": 1})]


async def build_digest(hours: int = 24) -> dict:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    pipeline = [
        {"$match": {"at": {"$gte": since}, "enforced": True, "preview": {"$ne": True}}},
        {"$group": {"_id": {"c": "$company_id", "f": "$feature"}, "count": {"$sum": 1}, "last_at": {"$max": "$at"},
                    "plan": {"$last": "$plan"}, "min_plan": {"$last": "$min_plan"}, "users": {"$addToSet": "$user_id"}}},
    ]
    groups = await db.entitlement_events.aggregate(pipeline).to_list(1000)
    by_company: dict[str, dict] = {}
    for g in groups:
        cid, feat = g["_id"]["c"], g["_id"]["f"]
        row = by_company.setdefault(cid, {"company_id": cid, "plan": g.get("plan"), "features": [], "total": 0, "users": set(), "last_at": ""})
        row["features"].append({"feature": feat, "count": g["count"], "min_plan": g.get("min_plan") or FEATURE_MIN_PLAN.get(feat)})
        row["total"] += g["count"]
        row["users"] |= {u for u in g.get("users") or [] if u}
        row["last_at"] = max(row["last_at"], g.get("last_at") or "")
    cids = list(by_company)
    companies = {c["id"]: c async for c in db.companies.find({"id": {"$in": cids}}, {"_id": 0, "id": 1, "name": 1, "owner_email": 1, "billing_payer": 1, "sub_status": 1})}
    rows = []
    for cid, r in by_company.items():
        c = companies.get(cid, {})
        rows.append({**r, "users": len(r["users"]), "name": c.get("name") or cid, "owner_email": c.get("owner_email"),
                     "payer": c.get("billing_payer"), "sub_status": c.get("sub_status"),
                     "features": sorted(r["features"], key=lambda f: -f["count"])})
    rows.sort(key=lambda r: -r["total"])
    return {"since": since, "hours": hours, "rows": rows, "total": sum(r["total"] for r in rows), "companies": len(rows)}


def render_digest(d: dict, app_url: str) -> tuple[str, str]:
    e = html.escape
    date = datetime.now(timezone.utc).strftime("%b %d, %Y")
    link = f"{app_url.rstrip('/')}/admin/entitlements"
    if not d["rows"]:
        subject = f"Plan gating digest — no blocks ({date})"
        body = "<p>No customer hit a plan gate or seat cap in the last 24 hours.</p>"
    else:
        subject = f"Plan gating digest — {d['total']} block{'s' if d['total'] != 1 else ''} across {d['companies']} compan{'ies' if d['companies'] != 1 else 'y'} ({date})"
        cards = []
        for r in d["rows"]:
            feats = "".join(
                f"<li>{e(FEATURE_NAMES.get(f['feature'], f['feature']))} — <b>{f['count']}×</b>"
                + (f" <span style='color:#64748b'>(needs {e(PLAN_LABELS.get(f['min_plan'], f['min_plan'] or ''))})</span>" if f.get("min_plan") else "") + "</li>"
                for f in r["features"])
            contact = f"<a href='mailto:{e(r['owner_email'])}'>{e(r['owner_email'])}</a>" if r.get("owner_email") else "<i>no owner email on file</i>"
            cards.append(
                f"<div style='border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin:0 0 12px'>"
                f"<div style='font-size:15px;font-weight:600'>{e(r['name'])}</div>"
                f"<div style='font-size:12px;color:#64748b;margin:2px 0 8px'>On <b>{e(PLAN_LABELS.get(r['plan'], r['plan'] or '—'))}</b>"
                f" · {r['users']} user{'s' if r['users'] != 1 else ''} affected · {r['total']} block{'s' if r['total'] != 1 else ''} · contact: {contact}</div>"
                f"<ul style='margin:0;padding-left:18px;font-size:13px'>{feats}</ul></div>")
        body = (f"<p>These customers tried to use something above their plan in the last 24 hours. "
                f"A quick note from you now beats a churned account later.</p>{''.join(cards)}")
    html_doc = (
        "<div style='font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:620px;margin:0 auto;color:#0f172a'>"
        f"<h2 style='font-size:18px;margin:0 0 12px'>Plan gating digest</h2>{body}"
        f"<p style='margin-top:18px'><a href='{e(link)}' style='display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:999px;font-size:13px'>Open the review page</a></p>"
        "<p style='font-size:11px;color:#94a3b8;margin-top:24px'>Sent daily while plan enforcement is on. Preview-pill test blocks are excluded.</p></div>")
    return subject, html_doc


async def run_digest(force: bool = False, run_id: str | None = None) -> dict:
    now = datetime.now(timezone.utc)
    stats = {"sent": False, "blocks": 0, "companies": 0, "recipients": 0, "skipped": None, "run_id": run_id}
    try:
        if run_id and await db.cron_run_history.find_one({"name": RUN_NAME, "run_id": run_id}):
            stats["skipped"] = "duplicate_run_id"
            return stats
        d = await build_digest()
        stats.update(blocks=d["total"], companies=d["companies"])
        if not d["rows"] and not force:
            stats["skipped"] = "no_blocks"
        else:
            to = await _recipients()
            stats["recipients"] = len(to)
            if not to:
                stats["skipped"] = "no_recipients"
            else:
                subject, body = render_digest(d, os.environ.get("PUBLIC_APP_URL") or os.environ.get("PUBLIC_BACKEND_URL") or "")
                await send_email(to, subject, body)
                stats["sent"] = True
    except Exception as ex:  # noqa: BLE001
        log.exception("entitlement digest failed")
        stats["error"] = str(ex)[:300]
    try:
        await db.cron_runs.update_one({"name": RUN_NAME}, {"$set": {"name": RUN_NAME, "last_run_at": now.isoformat(), "last_stats": stats}}, upsert=True)
        await db.cron_run_history.insert_one({"name": RUN_NAME, "run_id": run_id, "run_at": now.isoformat(), "stats": stats})
    except Exception:  # noqa: BLE001
        pass
    return stats


# Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
@router.post("/entitlement-digest")
async def entitlement_digest_cron(authorization: str | None = Header(None), x_webhook_id: str | None = Header(None)):
    secret = os.environ.get("WEBHOOK_CRON_SECRET")
    if not secret:
        raise HTTPException(500, "WEBHOOK_CRON_SECRET not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer")
    if not hmac.compare_digest(authorization.split(" ", 1)[1].strip().encode(), secret.encode()):
        raise HTTPException(401, "invalid bearer")
    asyncio.create_task(run_digest(run_id=x_webhook_id))
    return {"accepted": True, "run_id": x_webhook_id or ""}


@router.post("/entitlement-digest/trigger", tags=["admin"])
async def trigger_entitlement_digest(force: bool = Query(True), user: dict = Depends(require_role("superadmin"))):
    """Admin: send the digest right now (force=true sends even when there are no blocks)."""
    return await run_digest(force=force)


@router.get("/entitlement-digest/preview", tags=["admin"])
async def preview_entitlement_digest(user: dict = Depends(require_role("superadmin"))):
    d = await build_digest()
    subject, body = render_digest(d, os.environ.get("PUBLIC_APP_URL") or "")
    return {"subject": subject, "html": body, "recipients": await _recipients(), "blocks": d["total"], "companies": d["companies"]}
