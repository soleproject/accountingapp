"""Daily affiliate drips. Loop A = prospect nurture, Loop B = affiliate activation.
POST /api/cron/affiliate-drips (Bearer WEBHOOK_CRON_SECRET) · idempotent per (email, loop, step)."""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse

from db import db
from auth import require_role
import affiliate_emails as ae
from routes.affiliate_center import referral_state, _days_since, _parse, _first, _now, _iso, is_unsubscribed, unsubscribe_token

router = APIRouter(prefix="/api/cron", tags=["cron"])
log = logging.getLogger(__name__)
RUN_NAME = "affiliate_drips"
LOOKBACK_DAYS = 60


async def _sent(email: str, loop: str, step: str) -> bool:
    return bool(await db.drip_sends.find_one({"email": email, "loop": loop, "step": step}))


async def _mark(email: str, loop: str, step: str, status: str, ref: str | None) -> None:
    await db.drip_sends.insert_one({"id": str(uuid.uuid4()), "email": email, "loop": loop, "step": step,
                                    "status": status, "ref": ref, "at": _iso(_now())})


def _base(firm_slug: str | None) -> str:
    from email_dispatcher import public_base_url
    return public_base_url(firm_slug)


# ---------------------------------------------------------------- Loop A
async def _loop_a_candidates() -> list[dict]:
    cutoff = _iso(_now() - timedelta(days=LOOKBACK_DAYS))
    rows: dict[str, dict] = {}
    async for l in db.leads.find({"created_at": {"$gte": cutoff}, "role": {"$in": ["business_owner", "accounting_pro", "enterprise", "other"]},
                                  "status": {"$ne": "dead"}, "email": {"$not": {"$regex": "@no-email.local$"}}}, {"_id": 0}):
        rows[l["email"].lower()] = {"email": l["email"].lower(), "name": l.get("name"), "role": l.get("role"), "lead_id": l["id"],
                                    "referrer_user_id": l.get("referrer_user_id"), "started_at": l.get("created_at"), "status": l.get("status")}
    async for u in db.users.find({"referred_by_user_id": {"$ne": None}, "role": "client", "created_at": {"$gte": cutoff}},
                                 {"_id": 0, "id": 1, "email": 1, "name": 1, "created_at": 1, "referred_by_user_id": 1}):
        em = (u.get("email") or "").lower()
        r = rows.get(em) or {"email": em, "name": u.get("name"), "role": "business_owner", "lead_id": None,
                             "referrer_user_id": u.get("referred_by_user_id"), "started_at": u.get("created_at"), "status": None}
        r["user"] = u
        rows[em] = r
    return list(rows.values())


async def plan_loop_a(r: dict) -> tuple[str, str, dict] | None:
    """Return (step, link, ctx) due for this prospect, or None."""
    user = r.get("user") or await db.users.find_one({"email": r["email"]}, {"_id": 0, "id": 1, "name": 1})
    st = await referral_state(user["id"]) if user else {"has_company": False, "has_bank": False}
    days = _days_since(r.get("started_at")) or 0
    role = r.get("role") or "business_owner"
    firm_slug = None
    if r.get("referrer_user_id"):
        from routes.auth import _resolve_firm_for_user, _firm_public_info
        ref_u = await db.users.find_one({"id": r["referrer_user_id"]}, {"_id": 0, "id": 1, "branding": 1, "signup_firm_slug": 1, "enterprise_id": 1})
        firm_slug = ((_firm_public_info(await _resolve_firm_for_user(ref_u or {})) or {}).get("slug"))
    base = _base(firm_slug)
    ctx = {"trial_end_day": (_parse(st.get("trial_end")) or _now()).strftime("%A") if st.get("trial_end") else "", "bank_count": st.get("bank_count") or 0}
    paying = bool(st.get("active_paid")) or (user and await db.referral_earnings.find_one({"referred_user_id": user["id"]}))
    if role == "accounting_pro":
        if await db.bookings.find_one({"visitor_email": r["email"]}):
            return None
        for step, day in (("a9_checkin", 9), ("a5_pro", 5), ("a2_pro", 2)):
            if days >= day and not await _sent(r["email"], "A", step):
                from affiliate_content import get_settings
                slug = (await get_settings()).get("walkthrough_booking_slug")
                return step, (f"{base}/book/{slug}" if slug else f"{base}/signup?email={r['email']}"), ctx
        return None
    if role == "enterprise":
        if days >= 3 and r.get("status") == "new" and not await _sent(r["email"], "A", "a3_ent"):
            return "a3_ent", base, ctx
        return None
    if paying:
        return None
    if st.get("canceled"):
        if (_days_since(st.get("canceled_at")) or 0) >= 7 and not await _sent(r["email"], "A", "a_lapsed7"):
            return "a_lapsed7", f"{base}/welcome/pricing", ctx
        return None
    if st.get("sub_status") == "trialing" and not st.get("has_card") and st.get("days_to_trial_end") is not None:
        if st["days_to_trial_end"] <= 1 and not await _sent(r["email"], "A", "a_trial1"):
            return "a_trial1", f"{base}/billing", ctx
        if st["days_to_trial_end"] <= 3 and not await _sent(r["email"], "A", "a_trial3"):
            return "a_trial3", f"{base}/billing", ctx
    if not user:
        if days >= 9 and not await _sent(r["email"], "A", "a9_checkin"):
            return "a9_checkin", f"{base}/signup?email={r['email']}", ctx
        if 2 <= days < 9 and not await _sent(r["email"], "A", "a2_signup"):
            return "a2_signup", f"{base}/signup?email={r['email']}", ctx
        return None
    if days >= 9 and not st.get("has_bank") and not await _sent(r["email"], "A", "a9_checkin"):
        return "a9_checkin", f"{base}/connections", ctx
    if days >= 5 and not await _sent(r["email"], "A", "a5_case"):
        return "a5_case", f"{base}/dashboard", ctx
    if days >= 2 and not st.get("has_bank") and not await _sent(r["email"], "A", "a2_bank"):
        return "a2_bank", f"{base}/connections", ctx
    return None


async def _send_a(r: dict, step: str, link: str, ctx: dict, dry: bool) -> str:
    from email_dispatcher import dispatch
    ref = await db.users.find_one({"id": r["referrer_user_id"]}, {"_id": 0, "name": 1, "email": 1}) if r.get("referrer_user_id") else None
    ref_name = (ref or {}).get("name") or ((ref or {}).get("email") or "").split("@")[0] or None
    unsub = f"{_base(None)}/api/public/drips/unsubscribe?e={r['email']}&t={unsubscribe_token(r['email'])}"
    built = ae.loop_a(step, first_name=_first(r.get("name"), r["email"]), referrer=ref_name, link=link, brand=None, unsubscribe_url=unsub, ctx=ctx)
    if not built:
        return "no_template"
    if dry:
        return "would_send"
    subject, html = built
    res = await dispatch(kind="prospect_drip", to=r["email"], subject=subject, html=html, reply_to=(ref or {}).get("email"),
                         related={"lead_id": r.get("lead_id"), "step": step})
    status = res.get("status", "sent")
    await _mark(r["email"], "A", step, status, r.get("lead_id"))
    return status


# ---------------------------------------------------------------- Loop B
async def plan_loop_b(u: dict) -> tuple[str, dict] | None:
    days = _days_since(u.get("created_at")) or 0
    clicks = await db.referral_clicks.count_documents({"referrer_user_id": u["id"]})
    leads = await db.leads.count_documents({"referrer_user_id": u["id"]}) + await db.users.count_documents({"referred_by_user_id": u["id"]})
    ctx = {"clicks": clicks, "leads": leads}
    em = u["email"].lower()
    if days >= 14 and leads == 0 and not await _sent(em, "B", "b14_noleads"):
        return "b14_noleads", ctx
    if days >= 7 and clicks == 0 and not await _sent(em, "B", "b7_noclicks"):
        return "b7_noclicks", ctx
    if days >= 3 and not await _sent(em, "B", "b3_accountant"):
        return "b3_accountant", ctx
    if days >= 1 and not await _sent(em, "B", "b1_whofirst"):
        return "b1_whofirst", ctx
    return None


async def _send_b(u: dict, step: str, ctx: dict, dry: bool) -> str:
    from email_dispatcher import dispatch
    from routes.auth import _share_link_for, _resolve_firm_for_user
    from referral_util import mint_slug_for_user
    slug = u.get("referral_slug") or await mint_slug_for_user(u["id"])
    firm = await _resolve_firm_for_user(u)
    link, _ = _share_link_for(u, slug, firm)
    built = ae.loop_b(step, first_name=_first(u.get("name"), u["email"]), link=link, center_url=f"{_base(None)}/share", slug=slug, ctx=ctx)
    if not built:
        return "no_template"
    if dry:
        return "would_send"
    subject, html = built
    res = await dispatch(kind="affiliate_drip", to=u["email"], subject=subject, html=html, initiating_user_id=u["id"], related={"step": step})
    status = res.get("status", "sent")
    await _mark(u["email"].lower(), "B", step, status, u["id"])
    return status


# ---------------------------------------------------------------- runner
async def run_drips(run_id: str | None = None, dry: bool = False) -> dict:
    if run_id and await db.cron_run_history.find_one({"name": RUN_NAME, "run_id": run_id}):
        return {"skipped": "duplicate run_id"}
    stats = {"a_considered": 0, "a_sent": 0, "b_considered": 0, "b_sent": 0, "plan": []}
    for r in await _loop_a_candidates():
        stats["a_considered"] += 1
        if await is_unsubscribed(r["email"]):
            continue
        try:
            due = await plan_loop_a(r)
            if due:
                step, link, ctx = due
                status = await _send_a(r, step, link, ctx, dry)
                stats["plan"].append({"loop": "A", "email": r["email"], "step": step, "status": status})
                if status in ("sent", "would_send"):
                    stats["a_sent"] += 1
        except Exception:
            log.exception("loop A failed for %s", r.get("email"))
    cutoff = _iso(_now() - timedelta(days=LOOKBACK_DAYS))
    async for u in db.users.find({"role": "affiliate", "created_at": {"$gte": cutoff}}, {"_id": 0, "id": 1, "email": 1, "name": 1, "created_at": 1,
                                                                                         "referral_slug": 1, "branding": 1, "signup_firm_slug": 1, "enterprise_id": 1}):
        stats["b_considered"] += 1
        if await is_unsubscribed(u["email"]):
            continue
        try:
            due = await plan_loop_b(u)
            if due:
                step, ctx = due
                status = await _send_b(u, step, ctx, dry)
                stats["plan"].append({"loop": "B", "email": u["email"], "step": step, "status": status})
                if status in ("sent", "would_send"):
                    stats["b_sent"] += 1
        except Exception:
            log.exception("loop B failed for %s", u.get("email"))
    if not dry:
        now = _iso(_now())
        summary = {k: v for k, v in stats.items() if k != "plan"}
        await db.cron_runs.update_one({"name": RUN_NAME}, {"$set": {"name": RUN_NAME, "last_run_at": now, "last_stats": summary}}, upsert=True)
        await db.cron_run_history.insert_one({"name": RUN_NAME, "run_id": run_id, "at": now, "stats": summary})
    return stats


@router.post("/affiliate-drips")
async def affiliate_drips_cron(authorization: str | None = Header(None), x_webhook_id: str | None = Header(None)):
    secret = os.environ.get("WEBHOOK_CRON_SECRET")
    if not secret:
        raise HTTPException(500, "WEBHOOK_CRON_SECRET not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer")
    if not hmac.compare_digest(authorization.split(" ", 1)[1].strip().encode(), secret.encode()):
        raise HTTPException(401, "Bad bearer")
    asyncio.create_task(run_drips(run_id=x_webhook_id))
    return {"accepted": True, "run_id": x_webhook_id or ""}


@router.post("/affiliate-drips/trigger")
async def affiliate_drips_trigger(dry: bool = Query(True), user: dict = Depends(require_role("superadmin"))):
    return await run_drips(run_id=None, dry=dry)


@router.get("/affiliate-drips/preview", response_class=HTMLResponse)
async def affiliate_drips_preview(loop: str = Query("A"), step: str = Query("a2_bank"), user: dict = Depends(require_role("superadmin"))):
    base = _base(None)
    if loop.upper() == "A":
        built = ae.loop_a(step, first_name="Dan", referrer="Maria Lopez", link=f"{base}/connections", brand=None,
                          unsubscribe_url="#", ctx={"trial_end_day": "Thursday", "bank_count": 1})
    else:
        built = ae.loop_b(step, first_name="Maria", link=f"{base}/r/maria-lopez", center_url=f"{base}/share", slug="maria-lopez", ctx={"clicks": 0, "leads": 0})
    if not built:
        raise HTTPException(404, "Unknown step")
    subject, html = built
    return HTMLResponse(f"<div style='font:600 14px system-ui;padding:12px;background:#eee'>Subject: {subject}</div>{html}")


@router.get("/affiliate-drips/steps")
async def affiliate_drips_steps(user: dict = Depends(require_role("superadmin"))):
    return {"A": ["a2_signup", "a2_bank", "a5_case", "a9_checkin", "a_trial3", "a_trial1", "a_lapsed7", "a2_pro", "a5_pro", "a3_ent"],
            "B": ["b0_welcome", "b1_whofirst", "b3_accountant", "b7_noclicks", "b14_noleads"],
            "last_run": await db.cron_runs.find_one({"name": RUN_NAME}, {"_id": 0})}
