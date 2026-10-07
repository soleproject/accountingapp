"""Affiliate Sales Center: Today list + pipeline, manual leads, toolkit, admin editor, public program info."""
from __future__ import annotations

import hashlib
import hmac
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from db import db
from auth import get_current_user, require_role
import affiliate_content as ac

router = APIRouter(prefix="/api", tags=["affiliate-center"])

ROLE_LABEL = {"business_owner": "Business owner", "accounting_pro": "Accounting pro", "enterprise": "Enterprise",
              "affiliate": "Affiliate", "other": "Other"}
STAGES = ["new", "contacted", "signed_up", "trial_ending", "paying", "lost"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _days_since(s: str | None) -> int | None:
    d = _parse(s)
    return None if d is None else max(0, (_now() - d).days)


def _first(name: str | None, email: str | None = None) -> str:
    n = (name or "").strip()
    if n:
        return n.split()[0]
    return (email or "").split("@")[0] or "there"


def unsubscribe_token(email: str) -> str:
    secret = os.environ.get("JWT_SECRET", "dev-secret").encode()
    return hmac.new(secret, email.lower().encode(), hashlib.sha256).hexdigest()[:24]


async def is_unsubscribed(email: str) -> bool:
    return bool(await db.drip_unsubscribes.find_one({"email": email.lower()}))


# ---------------------------------------------------------------- referral state
async def referral_state(user_id: str) -> dict:
    """Company-level facts for a referred user: bank connected, trial, card, canceled, paying."""
    mems = await db.memberships.find({"user_id": user_id, "role": "owner"}, {"_id": 0, "company_id": 1}).to_list(50)
    cids = [m["company_id"] for m in mems]
    if not cids:
        return {"has_company": False, "has_bank": False}
    comps = await db.companies.find({"id": {"$in": cids}}, {"_id": 0, "id": 1, "name": 1, "sub_status": 1, "sub_trial_end": 1,
                                                             "sub_card_last4": 1, "billing_state": 1, "billing_product": 1,
                                                             "stripe_subscription_id": 1, "sub_canceled_at": 1, "created_at": 1}).to_list(50)
    comps.sort(key=lambda c: c.get("created_at") or "", reverse=True)
    c = comps[0] if comps else {}
    bank_count = await db.plaid_items.count_documents({"company_id": {"$in": cids}})
    trial_end = _parse(c.get("sub_trial_end"))
    days_to_trial_end = None if trial_end is None else (trial_end - _now()).days
    canceled = c.get("billing_state") == "canceled" or c.get("sub_status") == "canceled"
    return {
        "has_company": True, "company_id": c.get("id"), "company_name": c.get("name"),
        "has_bank": bank_count > 0, "bank_count": bank_count,
        "sub_status": c.get("sub_status"), "billing_state": c.get("billing_state"), "plan": c.get("billing_product"),
        "has_card": bool(c.get("sub_card_last4")), "trial_end": c.get("sub_trial_end"),
        "days_to_trial_end": days_to_trial_end, "canceled": canceled, "canceled_at": c.get("sub_canceled_at"),
        "active_paid": c.get("billing_state") == "active" and bool(c.get("stripe_subscription_id")),
    }


def derive_stage(row: dict) -> str:
    if row.get("lead_status") == "dead" or row.get("canceled"):
        return "lost"
    if row.get("payments", 0) > 0 or row.get("active_paid"):
        return "paying"
    if row.get("user_id"):
        if row.get("sub_status") == "trialing" and not row.get("has_card") and row.get("days_to_trial_end") is not None and row["days_to_trial_end"] <= 5:
            return "trial_ending"
        return "signed_up"
    if row.get("lead_status") == "contacted" or row.get("booking_at"):
        return "contacted"
    return "new"


def next_step(row: dict, stage: str) -> dict | None:
    fn = _first(row.get("name"), row.get("email"))
    ctx = {"first_name": fn, "company": row.get("company_name") or "", "trial_end_day": _trial_day(row), "bank_count": row.get("bank_count") or 0}
    role = row.get("role") or "business_owner"
    if stage == "new":
        age = _days_since(row.get("submitted_at")) or 0
        if role == "accounting_pro":
            return {"label": "Follow up on the walkthrough", "template": "sms_first_pro", "ctx": ctx}
        if row.get("source") == "manual":
            return {"label": "Send your link", "template": "sms_first_owner", "ctx": ctx}
        return {"label": "Text them" if age >= 3 else "Give it a day, then text", "template": "sms_followup", "ctx": ctx}
    if stage == "contacted":
        if row.get("booking_at"):
            return {"label": f"Walkthrough {row['booking_at'][:10]} — join?", "template": None, "ctx": ctx}
        return {"label": "Follow up", "template": "sms_followup" if role != "accounting_pro" else "email_followup_pro", "ctx": ctx}
    if stage == "signed_up":
        if not row.get("has_bank"):
            return {"label": "Nudge: connect a bank", "template": "sms_signed_up_no_bank", "ctx": ctx}
        return {"label": "On track", "template": None, "ctx": ctx, "ok": True}
    if stage == "trial_ending":
        return {"label": "Text / call now", "template": "sms_trial_ending", "ctx": ctx, "urgent": True}
    if stage == "paying":
        if row.get("payments", 0) >= 3 and not row.get("intro_asked_at"):
            return {"label": "Ask for an intro", "template": "email_intro_ask", "ctx": ctx}
        return None
    if stage == "lost" and row.get("canceled"):
        days = _days_since(row.get("canceled_at"))
        return {"label": "Win-back" if (days or 0) >= 90 else f"Re-engage in {max(0, 90 - (days or 0))}d", "template": "sms_winback" if (days or 0) >= 90 else None, "ctx": ctx}
    return None


def _trial_day(row: dict) -> str:
    d = _parse(row.get("trial_end"))
    return d.strftime("%A") if d else ""


async def build_pipeline(user: dict) -> dict:
    uid = user["id"]
    leads = await db.leads.find({"referrer_user_id": uid}, {"_id": 0}).to_list(5000)
    referred = await db.users.find({"referred_by_user_id": uid}, {"_id": 0, "id": 1, "email": 1, "name": 1, "created_at": 1}).to_list(5000)
    earnings = await db.referral_earnings.find({"referrer_user_id": uid}, {"_id": 0, "referred_user_id": 1, "share_cents": 1, "status": 1}).to_list(50000)
    earn_by: dict[str, list] = {}
    for e in earnings:
        earn_by.setdefault(e.get("referred_user_id"), []).append(e)
    emails = [l["email"] for l in leads if l.get("email")]
    bookings = {b["visitor_email"].lower(): b for b in await db.bookings.find({"visitor_email": {"$in": emails}}, {"_id": 0, "visitor_email": 1, "start_iso": 1}).to_list(1000)} if emails else {}

    rows: dict[str, dict] = {}
    for l in leads:
        em = (l.get("email") or "").lower()
        if not em:
            continue
        rows[em] = {"email": em, "name": l.get("name"), "role": l.get("role"), "company_name": l.get("company_name"),
                    "phone": l.get("phone"), "lead_id": l["id"], "lead_status": l.get("status"), "notes": l.get("notes"),
                    "source": l.get("source"), "variant": l.get("variant"), "submitted_at": l.get("created_at"),
                    "activities": l.get("activities") or [], "intro_asked_at": l.get("intro_asked_at"),
                    "booking_at": (bookings.get(em) or {}).get("start_iso"), "last_seen_at": l.get("last_seen_at") or l.get("created_at")}
    for u in referred:
        em = (u.get("email") or "").lower()
        ents = earn_by.get(u["id"], [])
        base = rows.get(em) or {"email": em, "name": u.get("name"), "role": "business_owner", "company_name": None, "lead_id": None,
                                "lead_status": None, "notes": None, "source": "link", "submitted_at": None, "activities": []}
        st = await referral_state(u["id"])
        base.update({"user_id": u["id"], "signed_up_at": u.get("created_at"), "payments": len(ents),
                     "earned_cents": sum(int(e.get("share_cents") or 0) for e in ents), **st,
                     "company_name": st.get("company_name") or base.get("company_name"),
                     "last_seen_at": max(base.get("last_seen_at") or "", u.get("created_at") or "")})
        rows[em] = base

    entries = []
    for r in rows.values():
        r.setdefault("payments", 0); r.setdefault("earned_cents", 0)
        stage = derive_stage(r)
        r["stage"] = stage
        r["role_label"] = ROLE_LABEL.get(r.get("role") or "", "Business owner")
        r["next"] = next_step(r, stage)
        entries.append(r)
    rank = {s: i for i, s in enumerate(STAGES)}
    entries.sort(key=lambda x: (rank.get(x["stage"], 0), x.get("last_seen_at") or ""), reverse=True)
    counts = {s: sum(1 for e in entries if e["stage"] == s) for s in STAGES}
    return {"rows": entries, "counts": counts}


def build_today(rows: list[dict], clicks_30d: int) -> list[dict]:
    items: list[dict] = []
    for r in rows:
        n = r.get("next") or {}
        fn = _first(r.get("name"), r.get("email"))
        who = r.get("company_name") or r.get("name") or r.get("email")
        if r["stage"] == "trial_ending":
            items.append({"kind": "trial_ending", "priority": 0, "email": r["email"], "phone": r.get("phone"),
                          "title": f"{who}'s trial ends in {max(0, r.get('days_to_trial_end') or 0)} days — no card on file",
                          "body": f"{fn} connected {r.get('bank_count') or 0} bank account(s). A nudge from you converts about 2× better than ours.",
                          "template": "sms_trial_ending", "ctx": n.get("ctx"), "cta": "Text / call"})
        elif r["stage"] == "signed_up" and not r.get("has_bank") and (_days_since(r.get("signed_up_at")) or 0) >= 2:
            items.append({"kind": "no_bank", "priority": 1, "email": r["email"], "phone": r.get("phone"),
                          "title": f"{who} signed up {_days_since(r.get('signed_up_at'))}d ago but hasn't connected a bank",
                          "body": "Nothing happens until a bank is connected. A quick text usually does it.",
                          "template": "sms_signed_up_no_bank", "ctx": n.get("ctx"), "cta": "Send nudge"})
        elif r["stage"] == "new" and (_days_since(r.get("submitted_at")) or 0) >= 3 and r.get("source") != "manual":
            items.append({"kind": "stale_lead", "priority": 2, "email": r["email"], "phone": r.get("phone"),
                          "title": f"{who} hasn't moved in {_days_since(r.get('submitted_at'))} days",
                          "body": f"{r['role_label']} · submitted the form but hasn't signed up. Referrals that hear from you convert ~2×.",
                          "template": "sms_followup" if r.get("role") != "accounting_pro" else "sms_first_pro", "ctx": n.get("ctx"), "cta": "Text them"})
        elif r["stage"] == "paying" and n.get("template") == "email_intro_ask":
            items.append({"kind": "ask_intro", "priority": 3, "email": r["email"], "phone": r.get("phone"),
                          "title": f"{who} has paid {r.get('payments')} invoices — ask for an intro",
                          "body": "Happy customers refer. One intro, template ready.",
                          "template": "email_intro_ask", "ctx": n.get("ctx"), "cta": "Ask for an intro", "lead_id": r.get("lead_id")})
    if not rows and clicks_30d == 0:
        items.append({"kind": "first_text", "priority": 0, "title": "Send your first text today",
                      "body": "Affiliates who text 3 people they know in the first 48 hours earn several times more in year one. Start with the zero-pitch opener.",
                      "template": "sms_first_soft", "ctx": {}, "cta": "Copy the opener"})
    items.sort(key=lambda i: i["priority"])
    return items[:6]


# ---------------------------------------------------------------- endpoints
@router.get("/affiliate/center")
async def affiliate_center(user: dict = Depends(get_current_user)):
    from routes.auth import _share_link_for, _resolve_firm_for_user
    from referral_util import mint_slug_for_user
    slug = user.get("referral_slug") or await mint_slug_for_user(user["id"])
    firm = await _resolve_firm_for_user(user)
    link, _src = _share_link_for(user, slug, firm)
    pipe = await build_pipeline(user)
    since = _iso(_now() - timedelta(days=30))
    clicks_30d = await db.referral_clicks.count_documents({"referrer_user_id": user["id"], "created_at": {"$gte": since}})
    clicks_prev = await db.referral_clicks.count_documents({"referrer_user_id": user["id"], "created_at": {"$gte": _iso(_now() - timedelta(days=60)), "$lt": since}})
    month_start = _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    month_cents = 0
    recurring_cents = 0
    async for e in db.referral_earnings.find({"referrer_user_id": user["id"]}, {"_id": 0, "share_cents": 1, "created_at": 1, "referred_user_id": 1}):
        if (e.get("created_at") or "") >= month_start:
            month_cents += int(e.get("share_cents") or 0)
    paying_rows = [r for r in pipe["rows"] if r["stage"] == "paying"]
    for r in paying_rows:
        recurring_cents += int(r.get("earned_cents") or 0) // max(1, r.get("payments") or 1)
    rows = pipe["rows"]
    return {
        "slug": slug, "link": link, "links": ac.link_variants(link),
        "first_name": _first(user.get("name"), user.get("email")),
        "stats": {"clicks_30d": clicks_30d, "clicks_delta": clicks_30d - clicks_prev,
                  "leads": len(rows), "signed_up": sum(1 for r in rows if r.get("user_id")),
                  "trialing": sum(1 for r in rows if r["stage"] in ("signed_up", "trial_ending")),
                  "paying": len(paying_rows), "month_cents": month_cents, "recurring_cents": recurring_cents},
        "today": build_today(rows, clicks_30d),
        "pipeline": rows, "counts": pipe["counts"], "stages": STAGES,
    }


class ManualLeadIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(None, max_length=40)
    role: str = "business_owner"
    company_name: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=2000)


@router.post("/affiliate/leads")
async def add_manual_lead(inp: ManualLeadIn, user: dict = Depends(get_current_user)):
    if inp.role not in ROLE_LABEL:
        raise HTTPException(400, "Invalid role")
    if not inp.email and not inp.phone:
        raise HTTPException(400, "Email or phone is required")
    email = (inp.email or f"{uuid.uuid4().hex[:10]}@no-email.local").lower()
    if inp.email and await db.leads.find_one({"email": email, "referrer_user_id": user["id"]}):
        raise HTTPException(409, "You already have this lead")
    now = _iso(_now())
    doc = {"id": str(uuid.uuid4()), "name": inp.name.strip(), "email": email, "role": inp.role,
           "phone": (inp.phone or "").strip() or None, "company_name": (inp.company_name or "").strip() or None,
           "ref_slug": user.get("referral_slug"), "referrer_user_id": user["id"], "notes": (inp.notes or "").strip() or None,
           "status": "new", "source": "manual", "activities": [], "created_at": now, "last_seen_at": now}
    await db.leads.insert_one(doc)
    doc.pop("_id", None)
    return {"ok": True, "lead": doc}


class LeadPatch(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None


@router.patch("/affiliate/leads/{lead_id}")
async def patch_my_lead(lead_id: str, inp: LeadPatch, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id, "referrer_user_id": user["id"]})
    if not lead:
        raise HTTPException(404, "Lead not found")
    upd: dict = {"updated_at": _iso(_now())}
    if inp.status is not None:
        if inp.status not in ("new", "contacted", "dead"):
            raise HTTPException(400, "status must be new | contacted | dead")
        upd["status"] = inp.status
    if inp.notes is not None:
        upd["notes"] = inp.notes.strip() or None
    await db.leads.update_one({"id": lead_id}, {"$set": upd})
    return {"ok": True}


class ActivityIn(BaseModel):
    kind: str = Field(..., description="text | call | email | note | intro_asked")
    note: Optional[str] = Field(None, max_length=1000)


@router.post("/affiliate/leads/{lead_id}/activity")
async def log_activity(lead_id: str, inp: ActivityIn, user: dict = Depends(get_current_user)):
    if inp.kind not in ("text", "call", "email", "note", "intro_asked"):
        raise HTTPException(400, "Invalid activity kind")
    lead = await db.leads.find_one({"id": lead_id, "referrer_user_id": user["id"]})
    if not lead:
        raise HTTPException(404, "Lead not found")
    now = _iso(_now())
    act = {"id": str(uuid.uuid4()), "kind": inp.kind, "note": (inp.note or "").strip() or None, "at": now}
    upd: dict = {"$push": {"activities": act}, "$set": {"last_seen_at": now}}
    if inp.kind in ("text", "call", "email") and lead.get("status") == "new":
        upd["$set"]["status"] = "contacted"
    if inp.kind == "intro_asked":
        upd["$set"]["intro_asked_at"] = now
    await db.leads.update_one({"id": lead_id}, upd)
    return {"ok": True, "activity": act}


@router.post("/affiliate/referrals/{referred_email}/activity")
async def log_activity_by_email(referred_email: str, inp: ActivityIn, user: dict = Depends(get_current_user)):
    """Referrals that signed up via the link (no lead row yet) get a shadow lead so activity can be logged."""
    em = referred_email.lower()
    lead = await db.leads.find_one({"email": em, "referrer_user_id": user["id"]})
    if not lead:
        u = await db.users.find_one({"email": em, "referred_by_user_id": user["id"]}, {"_id": 0, "name": 1})
        if not u:
            raise HTTPException(404, "Referral not found")
        now = _iso(_now())
        lead = {"id": str(uuid.uuid4()), "name": u.get("name"), "email": em, "role": "business_owner", "ref_slug": user.get("referral_slug"),
                "referrer_user_id": user["id"], "status": "converted", "source": "link", "activities": [], "created_at": now, "last_seen_at": now}
        await db.leads.insert_one(lead)
    return await log_activity(lead["id"], inp, user)


@router.get("/affiliate/toolkit")
async def my_toolkit(user: dict = Depends(get_current_user)):
    from routes.auth import _share_link_for, _resolve_firm_for_user
    from referral_util import mint_slug_for_user
    slug = user.get("referral_slug") or await mint_slug_for_user(user["id"])
    firm = await _resolve_firm_for_user(user)
    link, _ = _share_link_for(user, slug, firm)
    ctx = {**ac.link_variants(link), "affiliate_name": (user.get("name") or "").split()[0] if user.get("name") else "",
           "firm_name": (firm or {}).get("name") or ""}
    settings = await ac.get_settings()
    return {"toolkit": await ac.get_toolkit(), "ctx": ctx, "links": ac.link_variants(link), "merge_fields": ac.MERGE_FIELDS,
            "booking_url": f"/book/{settings['walkthrough_booking_slug']}" if settings.get("walkthrough_booking_slug") else None}


# ---------------------------------------------------------------- admin editor
@router.get("/admin/affiliate/toolkit")
async def admin_get_toolkit(user: dict = Depends(require_role("superadmin"))):
    return {"toolkit": await ac.get_toolkit(), "defaults": ac.DEFAULT_TOOLKIT, "overrides": await ac._overrides(ac.TOOLKIT_KEY),
            "merge_fields": ac.MERGE_FIELDS}


class ToolkitPut(BaseModel):
    toolkit: dict


@router.put("/admin/affiliate/toolkit")
async def admin_put_toolkit(inp: ToolkitPut, user: dict = Depends(require_role("superadmin"))):
    bad = [k for k in inp.toolkit if k not in ac.DEFAULT_TOOLKIT]
    if bad:
        raise HTTPException(400, f"Unknown sections: {bad}")
    for k, v in inp.toolkit.items():
        if not isinstance(v, list):
            raise HTTPException(400, f"Section {k} must be a list")
    await ac.save_override(ac.TOOLKIT_KEY, inp.toolkit, user.get("email"))
    return {"ok": True, "toolkit": await ac.get_toolkit()}


@router.delete("/admin/affiliate/toolkit/{section}")
async def admin_reset_section(section: str, user: dict = Depends(require_role("superadmin"))):
    if section not in ac.DEFAULT_TOOLKIT:
        raise HTTPException(404, "Unknown section")
    ov = await ac._overrides(ac.TOOLKIT_KEY)
    ov.pop(section, None)
    await ac.save_override(ac.TOOLKIT_KEY, ov, user.get("email"))
    return {"ok": True, "toolkit": await ac.get_toolkit()}


@router.get("/admin/affiliate/settings")
async def admin_get_settings(user: dict = Depends(require_role("superadmin"))):
    settings = await ac.get_settings()
    slugs = await db.user_booking_settings.find({}, {"_id": 0, "slug": 1, "user_id": 1}).to_list(200)
    uids = [s["user_id"] for s in slugs]
    users = {u["id"]: u for u in await db.users.find({"id": {"$in": uids}}, {"_id": 0, "id": 1, "name": 1, "email": 1}).to_list(200)}
    return {"settings": settings, "booking_slugs": [{"slug": s["slug"], "owner": (users.get(s["user_id"]) or {}).get("name") or (users.get(s["user_id"]) or {}).get("email")} for s in slugs]}


class SettingsPut(BaseModel):
    settings: dict


@router.put("/admin/affiliate/settings")
async def admin_put_settings(inp: SettingsPut, user: dict = Depends(require_role("superadmin"))):
    clean = {k: v for k, v in inp.settings.items() if k in ac.DEFAULT_SETTINGS}
    slug = (clean.get("walkthrough_booking_slug") or "").strip()
    if slug and not await db.user_booking_settings.find_one({"slug": slug}):
        raise HTTPException(400, f"No booking page with slug '{slug}'")
    clean["walkthrough_booking_slug"] = slug
    await ac.save_override(ac.SETTINGS_KEY, clean, user.get("email"))
    return {"ok": True, "settings": await ac.get_settings()}


# ---------------------------------------------------------------- public
@router.get("/public/affiliate-program")
async def public_program():
    settings = await ac.get_settings()
    tk = await ac.get_toolkit()
    return {"payouts": ac.PAYOUT_TABLE, "share_pct": settings.get("program_share_pct", 20), "faq": tk.get("faq", [])}


@router.get("/public/drips/unsubscribe")
async def unsubscribe(e: str, t: str):
    if not hmac.compare_digest(unsubscribe_token(e), t):
        raise HTTPException(400, "Invalid link")
    await db.drip_unsubscribes.update_one({"email": e.lower()}, {"$set": {"email": e.lower(), "at": _iso(_now())}}, upsert=True)
    return {"ok": True, "email": e.lower()}
