"""Axiom Ledger — Auth endpoints routes.

Auto-extracted from server.py during the Feb 2026 modularization refactor.
Behaviour is intentionally identical to the pre-split codebase.
"""
import os
import re
import uuid
import json
import random
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List, Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Body
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from auth import (
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
from infra import limiter
from fastapi import Request
from ai_service import (
    categorize_transaction, chat_stream, suggest_chart_of_accounts,
    onboarding_interview_questions, onboarding_interview_synthesize,
    parse_voice_intent,
)
import reports as R
import plaid_service
import plaid_connect
import veryfi_service
import merchant_cache
import contact_resolver
from infra import get_cache

from models import (
    LoginIn, SignupIn, CompanyCreate, TransactionUpdate, TransactionCreate,
    SplitIn, RuleCreate, InvoiceCreate, BillCreate, ContactCreate,
    AccountCreate, JECreate, ChatIn, OnboardingUpdate, PaymentCreate,
    ReceiptCreate, GenericCreate, NewClientIn,
)
from deps import (
    DASH_CACHE_TTL,
    company_ids_for_user, require_company, log_ai,
    is_period_closed, assert_open,
    categorize_and_insert, sync_and_import,
)

router = APIRouter(prefix="/api")


# --- Login rate-limit (credential-stuffing defence) ----------------------
# Only FAILED attempts count. On lockout we surface a real 429 with a
# retry-after hint — unlike forgot-password, letting the user know
# they're locked out is helpful (they might otherwise assume the site is
# broken). Attackers already know they're being throttled.
_LOGIN_LIMIT_WINDOW_SECONDS = 10 * 60
_LOGIN_LIMIT_MAX_FAILURES = 5


async def _login_failures_recent(email: str) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=_LOGIN_LIMIT_WINDOW_SECONDS)).isoformat()
    return await db.auth_rate_limits.count_documents({
        "action": "login_fail", "email": email, "ts": {"$gte": cutoff},
    })


async def _record_login_failure(email: str) -> None:
    await db.auth_rate_limits.insert_one({
        "action": "login_fail", "email": email,
        "ts": datetime.now(timezone.utc).isoformat(),
    })


async def _clear_login_failures(email: str) -> None:
    await db.auth_rate_limits.delete_many({"action": "login_fail", "email": email})


# ----------------------- Auth endpoints -----------------------

@router.post("/auth/login")
@limiter.limit("5/minute")
async def login(request: Request, inp: Annotated[LoginIn, Body()]):
    email = inp.email.lower()

    # Locked-out branch. Surface the wait time (in minutes, rounded up)
    # so the user knows what's going on. The window is a sliding count,
    # so "retry in ~N minutes" is an upper bound — the real unlock
    # happens as older failure records age out one-by-one.
    if await _login_failures_recent(email) >= _LOGIN_LIMIT_MAX_FAILURES:
        raise HTTPException(
            429,
            detail={
                "message": (
                    f"Too many failed sign-in attempts. Please wait up to "
                    f"{_LOGIN_LIMIT_WINDOW_SECONDS // 60} minutes and try again, "
                    "or use Forgot password if you're stuck."
                ),
                "retry_after_seconds": _LOGIN_LIMIT_WINDOW_SECONDS,
            },
        )

    u = await db.users.find_one({"email": email})
    if not u or not verify_password(inp.password, u["password"]):
        # Only failed attempts are recorded — a legit user who logs in
        # cleanly never adds to their own count.
        await _record_login_failure(email)
        # Audit — capture the email + IP for a paper trail of intrusion
        # attempts. Never leak whether the email exists.
        try:
            import audit as _audit
            _audit.log_event(
                event_type=_audit.EVENT_LOGIN_FAILED,
                actor={"email": email},
                request=request,
                summary=f"Failed sign-in attempt for {email}",
                metadata={"reason": "invalid_credentials"},
            )
        except Exception:  # noqa: BLE001 — audit failure never blocks auth
            pass
        raise HTTPException(401, "Invalid credentials")

    # Clean slate on successful login so a locked-out user who
    # eventually remembers their password isn't stuck.
    await _clear_login_failures(email)

    # Archived / disabled accounts can't log in. We check AFTER the
    # password verify so an attacker probing valid usernames can't
    # discriminate archived from active accounts.
    if u.get("status") == "archived":
        raise HTTPException(
            403,
            detail={
                "message": (
                    "This account has been archived. Contact your platform "
                    "administrator if you believe this is a mistake."
                ),
                "code": "account_archived",
            },
        )

    token = create_token(u["id"], u["role"])
    # Audit — successful login.
    try:
        import audit as _audit
        _audit.log_event(
            event_type=_audit.EVENT_LOGIN,
            actor={"id": u["id"], "email": u["email"], "role": u["role"]},
            request=request,
            summary=f"Signed in as {u['email']}",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"token": token, "user": {"id": u["id"], "email": u["email"],
            "name": u["name"], "role": u["role"],
            "enterprise_id": u.get("enterprise_id"),
            "partner_id": u.get("partner_id")}}


@router.post("/auth/signup")
@limiter.limit("5/minute")
async def signup(request: Request, inp: Annotated[SignupIn, Body()]):
    # Roles a self-service signup is allowed to mint. `pro` accounts can
    # be created through the public form (they'll get an empty firm
    # scope until they add clients); `affiliate` accounts are the new
    # referral-only path (see `POST /auth/signup/affiliate`). We
    # explicitly refuse `superadmin` — those are only granted from an
    # existing superadmin session.
    _ALLOWED_SIGNUP_ROLES = {"client", "pro", "affiliate"}
    if inp.role not in _ALLOWED_SIGNUP_ROLES:
        raise HTTPException(400, "Unsupported signup role.")
    if await db.users.find_one({"email": inp.email.lower()}):
        raise HTTPException(400, "Email already registered")
    from referral_util import resolve_referrer_id
    referrer_id = await resolve_referrer_id(inp.ref)
    uid = str(uuid.uuid4())
    now = now_iso()
    doc = {
        "id": uid, "email": inp.email.lower(), "name": inp.name,
        "password": hash_password(inp.password), "role": inp.role,
        "created_at": now, "updated_at": now,
    }
    if referrer_id:
        # Immutable link — never overwritten even if the referring user
        # changes their slug or is deleted. Downstream revenue share reads
        # this field as the source of truth.
        doc["referred_by_user_id"] = referrer_id
    # Enterprise (firm) signups arrive on `/signup/enterprise` with
    # `role='pro'` + `enterprise_name`. Stamp `branding.firm_name` on
    # insert so the Enterprise auto-provisioner (below) has the name
    # to key off of. We do NOT collect the private-label subdomain
    # here — that's gated behind a paid upgrade in a later iteration.
    enterprise_signup = (inp.role == "pro" and (inp.enterprise_name or "").strip())
    if enterprise_signup:
        doc["branding"] = {"firm_name": inp.enterprise_name.strip()}
    await db.users.insert_one(doc)
    token = create_token(uid, inp.role)

    # Fire-and-forget: spawn the Enterprise record + fire the welcome
    # email so the new firm owner lands with everything they need in
    # their inbox on day 0. Same defensive try/except pattern as the
    # affiliate welcome — the response must not 500 on email failure.
    if enterprise_signup:
        try:
            import enterprises as _ent
            import email_templates as _et
            from email_dispatcher import dispatch, public_base_url
            import logging
            ent = await _ent.ensure_personal_enterprise_for_pro(uid)
            # Every enterprise Pro also gets their own "Firm Books"
            # company — their FIRM's accounting books, separate from
            # any client company they manage. Auto-provisioned so the
            # dropdown has it on day 0.
            await _ent.ensure_firm_books_company_for_pro(uid)
            subject, html = _et.enterprise_welcome(
                name=inp.name, enterprise_name=inp.enterprise_name.strip(),
                enterprise_slug=(ent or {}).get("slug"),
                dashboard_url=f"{public_base_url()}/pro/clients",
                invite_url=f"{public_base_url()}/pro/team",
                billing_url=f"{public_base_url()}/billing",
            )
            await dispatch(
                kind="enterprise_welcome", to=inp.email.lower(),
                subject=subject, html=html, initiating_user_id=uid,
            )
        except Exception:
            logging.getLogger(__name__).exception(
                "enterprise welcome dispatch failed for user_id=%s email=%s",
                uid, inp.email,
            )

    # Fire-and-forget: brand-new affiliate → activation email. Wrapped
    # in try/except because dispatcher.dispatch is expected to
    # never-raise, but we defensively cover any import / template blowup
    # so a bad email doesn't 500 the signup. The dispatcher's own audit
    # log will surface the failure.
    if inp.role == "affiliate":
        try:
            from referral_util import mint_slug_for_user
            import email_templates as _et
            from email_dispatcher import dispatch, public_base_url
            slug = await mint_slug_for_user(uid)
            fresh = await db.users.find_one({"id": uid}) or {}
            link, _ = _share_link_for(fresh, slug)
            referrer_name = None
            if referrer_id:
                ref_u = await db.users.find_one({"id": referrer_id}, {"name": 1, "email": 1})
                if ref_u:
                    referrer_name = ref_u.get("name") or (ref_u.get("email") or "").split("@")[0]
            subject, html = _et.affiliate_welcome(
                name=inp.name, share_link=link, slug=slug,
                dashboard_url=f"{public_base_url()}/share",
                referrer_name=referrer_name,
            )
            await dispatch(
                kind="affiliate_welcome", to=inp.email.lower(),
                subject=subject, html=html, initiating_user_id=uid,
            )
        except Exception:
            # Swallowed by design — a broken email template must NEVER
            # 500 the signup. But log it so an unexpected regression
            # (e.g. a bug in mint_slug_for_user or a template import
            # break) is visible in the backend logs rather than
            # silently disappearing.
            import logging
            logging.getLogger(__name__).exception(
                "affiliate welcome dispatch failed for user_id=%s email=%s",
                uid, inp.email,
            )

    return {"token": token, "user": {"id": uid, "email": inp.email.lower(),
            "name": inp.name, "role": inp.role}}


# ----------------------------------------------------------------------
# Affiliate — every user has a shareable referral slug + link.
# ----------------------------------------------------------------------
def _share_link_for(user: dict, slug: str) -> tuple[str, str]:
    """Return ``(link, source)`` — the URL to share and a label
    indicating which config drove it.

    Precedence:
      1. Firm's custom "buy page URL" (``branding.buy_page_url``) —
         referrer's site or a dedicated pricing page. Ref param appended
         as ``?ref=`` (or ``&ref=`` if the URL already has a query).
      2. Firm's private-label subdomain + ``/refer/<slug>`` — when the
         pro has ``branding.signin_subdomain`` set and the platform has
         a ``PRIVATE_LABEL_HOST_TEMPLATE`` env var.
      3. Platform ``/refer/<slug>`` on ``PRIMARY_HOST``.

    Note: link now lands on the ``/refer/<slug>`` lead-capture page
    which forwards to ``/signup?ref=<slug>`` after submission. This
    lets us drop the visitor into a drip campaign even if they don't
    complete signup on the first visit.
    """
    b = (user or {}).get("branding") or {}
    buy_url = (b.get("buy_page_url") or "").strip()
    if buy_url:
        sep = "&" if "?" in buy_url else "?"
        return f"{buy_url}{sep}ref={slug}", "firm_buy_page"
    firm_slug = (b.get("signin_subdomain") or "").strip() or None
    template = os.environ.get("PRIVATE_LABEL_HOST_TEMPLATE")
    if firm_slug and template:
        host_url = template.replace("{slug}", firm_slug).rstrip("/")
        return f"{host_url}/refer/{slug}", "firm_subdomain"
    host = os.environ.get("PRIMARY_HOST", "app.smartbookssoftware.ai")
    return f"https://{host}/refer/{slug}", "platform"


@router.get("/share")
async def share_info(user: dict = Depends(get_current_user)):
    """Return the current user's affiliate assets: their slug, the
    shareable link (auto-computed per branding), and a lightweight
    earnings summary. The frontend renders the Refer & earn page from
    this payload."""
    from referral_util import mint_slug_for_user
    slug = await mint_slug_for_user(user["id"])
    doc = await db.users.find_one({"id": user["id"]}) or {}
    link, link_source = _share_link_for(doc, slug)
    referred_count = await db.users.count_documents({"referred_by_user_id": user["id"]})
    earnings_docs = await db.referral_earnings.find(
        {"referrer_user_id": user["id"]}
    ).to_list(2000)
    accrued = sum(int(e.get("share_cents") or 0) for e in earnings_docs if e.get("status") == "accrued")
    paid_out = sum(int(e.get("share_cents") or 0) for e in earnings_docs if e.get("status") == "paid_out")
    paying = len({e.get("referred_user_id") for e in earnings_docs if e.get("referred_user_id")})
    return {
        "slug": slug,
        "link": link,
        "link_source": link_source,
        "buy_page_url": (doc.get("branding") or {}).get("buy_page_url") or "",
        "referred_count": referred_count,
        "paying_count": paying,
        "earnings_cents": accrued + paid_out,
        "pending_cents": accrued,
    }


class SlugPatch(BaseModel):
    slug: str


@router.put("/share/slug")
async def rename_share_slug(inp: SlugPatch, user: dict = Depends(get_current_user)):
    """Rename the caller's referral slug — the human-readable ``?ref=``
    handle on their affiliate link. Validation lives in ``referral_util``.
    Returns the new share link so the frontend can update without a
    second round-trip.
    """
    from referral_util import set_slug_for_user
    new_slug = await set_slug_for_user(user["id"], inp.slug)
    doc = await db.users.find_one({"id": user["id"]}) or {}
    link, source = _share_link_for(doc, new_slug)
    return {"slug": new_slug, "link": link, "link_source": source}


@router.get("/share/lookup")
async def share_lookup(ref: str):
    """Public — resolve ``?ref=<slug>`` to the referrer's display name +
    firm brand so the signup page can render a "Referred by X" banner.
    Returns 404 for unknown slugs so the frontend hides the banner
    gracefully rather than showing a broken attribution.
    """
    from referral_util import resolve_referrer_id
    uid = await resolve_referrer_id(ref)
    if not uid:
        raise HTTPException(404, "Unknown referral code.")
    doc = await db.users.find_one({"id": uid}, {
        "id": 1, "name": 1, "email": 1, "branding": 1, "_id": 0,
    }) or {}
    b = doc.get("branding") or {}
    return {
        "name": doc.get("name") or (doc.get("email") or "").split("@")[0],
        "firm_name": b.get("firm_name") or None,
        "firm_subdomain": b.get("signin_subdomain") or None,
    }


@router.get("/share/referrals")
async def share_referrals(user: dict = Depends(get_current_user)):
    """List of every user who signed up under the caller's referral
    slug, plus their attribution stats (signup date, paying-or-not,
    lifetime earned to date). Fuels the "Referrals" table on the Refer
    & earn page.
    """
    referred = await db.users.find(
        {"referred_by_user_id": user["id"]},
        {"id": 1, "email": 1, "name": 1, "created_at": 1, "_id": 0},
    ).to_list(2000)
    if not referred:
        return {"referrals": []}
    uids = [u["id"] for u in referred]
    earnings = await db.referral_earnings.find(
        {"referrer_user_id": user["id"], "referred_user_id": {"$in": uids}},
    ).to_list(20000)
    by_uid: dict[str, list] = {}
    for e in earnings:
        by_uid.setdefault(e["referred_user_id"], []).append(e)
    rows = []
    for u in referred:
        entries = by_uid.get(u["id"], [])
        total = sum(int(e.get("share_cents") or 0) for e in entries)
        rows.append({
            "user_id": u["id"],
            "email": u.get("email"), "name": u.get("name"),
            "signed_up_at": u.get("created_at"),
            "payments": len(entries),
            "earned_cents": total,
            "status": "paying" if entries else "signup_only",
        })
    rows.sort(key=lambda r: r["signed_up_at"] or "", reverse=True)
    return {"referrals": rows}


@router.get("/share/pipeline")
async def share_pipeline(user: dict = Depends(get_current_user)):
    """Unified funnel view for the affiliate: every prospect the caller
    has ever touched, whether they submitted the referral form
    (leads collection), came in through their slug and signed up
    (users.referred_by_user_id), or both — de-duped on email.

    Stages (industry-standard SaaS affiliate funnel — Rewardful,
    PartnerStack, FirstPromoter):

        lead        →  Submitted the referral form; hasn't signed up.
        contacted   →  Superadmin marked as contacted (drip started).
        signed_up   →  Created a user account under this slug.
        trial       →  Signed up, has a company, not paying yet.
        paying      →  At least one payment recorded.
        dead        →  Superadmin marked dead OR churned.

    Returns funnel counts + per-row entries with the most-advanced
    stage, last-activity timestamp, and a suggested next action so
    the affiliate can see who needs a nudge.
    """
    my_slug = user.get("referral_slug")
    uid = user["id"]

    # ---- 1. Leads submitted through the form (attributed to me) ----
    leads = await db.leads.find(
        {"referrer_user_id": uid},
        {"_id": 0},
    ).to_list(5000)

    # ---- 2. Users who signed up under my slug ----
    referred = await db.users.find(
        {"referred_by_user_id": uid},
        {"id": 1, "email": 1, "name": 1, "created_at": 1, "_id": 0},
    ).to_list(5000)
    referred_ids = [u["id"] for u in referred]

    # ---- 3. Earnings ledger (for paying detection + amounts) ----
    earnings = await db.referral_earnings.find(
        {"referrer_user_id": uid, "referred_user_id": {"$in": referred_ids}}
        if referred_ids else {"referrer_user_id": uid},
    ).to_list(50000)
    earn_by_uid: dict[str, list] = {}
    for e in earnings:
        earn_by_uid.setdefault(e["referred_user_id"], []).append(e)

    # ---- 4. Fold leads + referrals together on email ----
    rows: dict[str, dict] = {}   # email → row

    for lead in leads:
        email = (lead.get("email") or "").lower()
        if not email: continue
        rows[email] = {
            "email":       email,
            "name":        lead.get("name"),
            "role":        lead.get("role"),
            "company_name":lead.get("company_name"),
            "lead_id":     lead.get("id"),
            "lead_status": lead.get("status"),
            "lead_notes":  lead.get("notes"),
            "submitted_at":lead.get("created_at"),
            "signed_up_at":None,
            "user_id":     None,
            "payments":    0,
            "earned_cents":0,
            "last_seen_at":lead.get("last_seen_at") or lead.get("created_at"),
        }

    for u in referred:
        email = (u.get("email") or "").lower()
        entries = earn_by_uid.get(u["id"], [])
        total = sum(int(e.get("share_cents") or 0) for e in entries)
        base = rows.get(email) or {
            "email": email, "name": u.get("name"),
            "role": None, "company_name": None,
            "lead_id": None, "lead_status": None, "lead_notes": None,
            "submitted_at": None,
        }
        base.update({
            "signed_up_at": u.get("created_at"),
            "user_id":      u["id"],
            "payments":     len(entries),
            "earned_cents": total,
            "last_seen_at": u.get("created_at"),
        })
        rows[email] = base

    # ---- 5. Compute stage + suggested next action ----
    def derive_stage(r: dict) -> tuple[str, str]:
        """Return (stage, next_action_hint)."""
        if r.get("lead_status") == "dead":
            return ("dead", "Archived — no action")
        if r.get("payments", 0) > 0:
            return ("paying", "Keep them happy — this is recurring revenue")
        if r.get("user_id"):
            return ("trial", "Nudge them to add a payment method")
        if r.get("lead_status") == "contacted":
            return ("contacted", "Follow-up in 48h if no reply")
        # New lead only
        return ("lead", "Send intro email + calendar link")

    entries = []
    for r in rows.values():
        stage, hint = derive_stage(r)
        entries.append({**r, "stage": stage, "next_action": hint})

    # Sort: most-advanced first, then most-recent activity
    stage_rank = {"paying": 5, "trial": 4, "contacted": 3,
                  "signed_up": 2, "lead": 1, "dead": 0}
    entries.sort(
        key=lambda x: (stage_rank.get(x["stage"], 0),
                       x.get("last_seen_at") or ""),
        reverse=True,
    )

    # ---- 6. Funnel counts + conversion % ----
    total = len(entries)
    counts = {
        "lead":      sum(1 for e in entries if e["stage"] == "lead"),
        "contacted": sum(1 for e in entries if e["stage"] == "contacted"),
        "trial":     sum(1 for e in entries if e["stage"] == "trial"),
        "paying":    sum(1 for e in entries if e["stage"] == "paying"),
        "dead":      sum(1 for e in entries if e["stage"] == "dead"),
    }
    signed_up_total = counts["trial"] + counts["paying"]
    lead_to_signup = (signed_up_total / total * 100.0) if total else 0.0
    signup_to_paying = (counts["paying"] / signed_up_total * 100.0) if signed_up_total else 0.0

    total_earned = sum(int(e.get("earned_cents") or 0) for e in entries)

    return {
        "entries": entries,
        "totals": {
            "total": total,
            "counts": counts,
            "signed_up_total": signed_up_total,
            "lead_to_signup_pct": round(lead_to_signup, 1),
            "signup_to_paying_pct": round(signup_to_paying, 1),
            "total_earned_cents": total_earned,
        },
        "slug": my_slug,
    }


@router.get("/share/report")
async def share_report(
    start: Optional[str] = None,
    end: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Payout report for a date range. Defaults to the current
    calendar month (UTC). Returns aggregate totals plus a line-by-line
    ledger so the frontend can render both a summary card and an
    exportable table (CSV button lives on the client).
    """
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    if not start:
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        start_dt = month_start
    else:
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    if not end:
        end_dt = now
    else:
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    start_iso = start_dt.isoformat()
    end_iso = end_dt.isoformat()
    earnings = await db.referral_earnings.find({
        "referrer_user_id": user["id"],
        "created_at": {"$gte": start_iso, "$lte": end_iso},
    }).to_list(5000)
    # Enrich each row with the payer's email so the report is human-
    # readable without a second fetch.
    payer_ids = list({e["referred_user_id"] for e in earnings})
    payers = {
        u["id"]: u for u in await db.users.find(
            {"id": {"$in": payer_ids}}, {"id": 1, "email": 1, "name": 1, "_id": 0},
        ).to_list(2000)
    }
    lines = [{
        "date": e.get("created_at"),
        "referred_email": (payers.get(e["referred_user_id"]) or {}).get("email"),
        "referred_name": (payers.get(e["referred_user_id"]) or {}).get("name"),
        "gross_cents": int(e.get("gross_cents") or 0),
        "share_cents": int(e.get("share_cents") or 0),
        "share_bps": int(e.get("share_bps") or 0),
        "status": e.get("status") or "accrued",
    } for e in earnings]
    lines.sort(key=lambda r: r["date"] or "", reverse=True)
    accrued = sum(l["share_cents"] for l in lines if l["status"] == "accrued")
    paid_out = sum(l["share_cents"] for l in lines if l["status"] == "paid_out")
    gross_total = sum(l["gross_cents"] for l in lines)
    return {
        "start": start_iso,
        "end": end_iso,
        "totals": {
            "invoice_count": len(lines),
            "gross_cents": gross_total,
            "accrued_cents": accrued,
            "paid_out_cents": paid_out,
            "total_cents": accrued + paid_out,
        },
        "lines": lines,
    }


@router.post("/affiliate/upgrade")
async def affiliate_upgrade(user: dict = Depends(get_current_user)):
    """Convert an affiliate-only account into a regular client account.

    Idempotent — calling it on a non-affiliate user is a no-op that
    still returns the caller's current role, so the frontend can retry
    safely. Elevated users keep their referral slug + earnings intact
    (the ``id`` never changes, just ``users.role``), so any links they
    already shared continue to attribute revenue share correctly.

    After the flip the client goes through the normal empty-state
    onboarding flow — no company is auto-created here since we don't
    know the business name. The frontend routes the user to
    ``/onboarding`` on success.
    """
    if user["role"] == "affiliate":
        await db.users.update_one(
            {"id": user["id"]},
            {"$set": {"role": "client", "upgraded_from_affiliate_at": now_iso()}},
        )
        new_role = "client"
    else:
        new_role = user["role"]
    token = create_token(user["id"], new_role)
    return {"token": token, "user": {
        "id": user["id"], "email": user["email"],
        "name": user["name"], "role": new_role,
    }}


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    # `enterprise_id` and `partner_id` are surfaced so the frontend
    # can render role-context labels (e.g. sidebar "Enterprise Clients"
    # vs "Partner Clients" vs plain "Clients") without a second DB
    # round-trip. Missing values fall through to None — the sidebar
    # treats null/undefined identically to "not set".
    return {"user": {
        **{k: user[k] for k in ("id", "email", "name", "role")},
        "enterprise_id": user.get("enterprise_id"),
        "partner_id": user.get("partner_id"),
        # Surface the demo-visitor marker so the frontend can show the
        # read-only pill + signup CTA on every screen (see
        # `components/DemoVisitorPill.jsx`).
        "is_demo_visitor": bool(user.get("is_demo_visitor")),
    }}


# ----------------------------------------------------------------------
# Change-password (self-service, requires bearer token).
# ----------------------------------------------------------------------
class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/auth/change-password")
@limiter.limit("5/minute")
async def change_password(request: Request, inp: Annotated[ChangePasswordIn, Body()], user: dict = Depends(get_current_user)):
    """Verify the current password, then rotate to the new one. Bcrypt hash
    is stored on the user doc as ``password`` (keeps the schema in sync
    with the rest of auth). Existing JWTs are left valid on purpose — the
    user is already authenticated by definition, so invalidating other
    sessions would be surprising. If you need forced re-login, log the
    user out on the client side after this call succeeds."""
    fresh = await db.users.find_one({"id": user["id"]})
    if not fresh or not verify_password(inp.current_password, fresh["password"]):
        raise HTTPException(400, "Current password is incorrect.")
    if inp.current_password == inp.new_password:
        raise HTTPException(400, "New password must be different from your current one.")
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"password": hash_password(inp.new_password), "updated_at": now_iso()}},
    )
    return {"ok": True}


# ----------------------------------------------------------------------
# Change-email (self-service, requires bearer token + current password
# for confirmation). Used by the Enterprise settings page so an
# enterprise-owner Pro can rotate the address the login/magic-link
# emails go to when their company transitions between people.
# ----------------------------------------------------------------------
class ChangeEmailIn(BaseModel):
    current_password: str
    new_email: EmailStr


@router.post("/auth/change-email")
@limiter.limit("5/minute")
async def change_email(
    request: Request,
    inp: Annotated[ChangeEmailIn, Body()],
    user: dict = Depends(get_current_user),
):
    """Rotate the caller's login email.

    Requires the current password so a stolen JWT alone can't hijack
    the account. Rejects duplicate emails (case-insensitive) and
    no-op changes. Existing JWTs remain valid — auth is by user id,
    not email — so no forced re-login.
    """
    fresh = await db.users.find_one({"id": user["id"]})
    if not fresh or not verify_password(inp.current_password, fresh["password"]):
        raise HTTPException(400, "Current password is incorrect.")
    new_email = str(inp.new_email).lower().strip()
    if new_email == (fresh.get("email") or "").lower():
        raise HTTPException(400, "That is already your email address.")
    # Case-insensitive collision check across all users.
    existing = await db.users.find_one({"email": new_email})
    if existing and existing.get("id") != user["id"]:
        # Don't leak whether the email is registered — return the same
        # error users see when they type their current email.
        raise HTTPException(400, "That email is already in use.")
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"email": new_email, "updated_at": now_iso()}},
    )
    return {"ok": True, "email": new_email}


# ----------------------------------------------------------------------
# Password-set magic link (used for newly-invited clients).
#
# When a Pro creates a client from the "New Client" modal, we mint a
# one-time token here so the client's welcome email contains a
# ``/set-password/{token}`` link instead of a plaintext temp password.
# Tokens live in ``password_set_tokens`` — one document per invite, TTL
# 7 days, single-use.
# ----------------------------------------------------------------------

async def mint_password_set_token(user_id: str, *, purpose: str = "welcome", ttl_days: int = 7) -> str:
    """Create a fresh password-set token for ``user_id``. Any older
    still-valid tokens for the same user are marked ``superseded`` so
    only the most recent invite email can be redeemed (defence-in-depth
    against someone re-sending the invite by accident)."""
    import secrets as _secrets
    token = _secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    await db.password_set_tokens.update_many(
        {"user_id": user_id, "used": False},
        {"$set": {"used": True, "superseded_at": now.isoformat()}},
    )
    await db.password_set_tokens.insert_one({
        "id": token,
        "user_id": user_id,
        "purpose": purpose,
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=ttl_days)).isoformat(),
        "used": False,
    })
    return token


@router.get("/auth/password-set/{token}")
async def password_set_check(token: str):
    """Public — check whether a magic-link token is redeemable, and if
    so return the email + purpose so the UI can greet the user
    correctly ("Welcome" vs. "Reset your password")."""
    doc = await db.password_set_tokens.find_one({"id": token})
    if not doc:
        raise HTTPException(404, "This link is invalid.")
    if doc.get("used"):
        raise HTTPException(410, "This link has already been used.")
    if doc.get("expires_at") and doc["expires_at"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(410, "This link has expired.")
    u = await db.users.find_one({"id": doc["user_id"]})
    if not u:
        raise HTTPException(404, "Account no longer exists.")
    return {
        "email": u["email"], "name": u.get("name"), "role": u.get("role"),
        "purpose": doc.get("purpose") or "welcome",
    }


class PasswordSetIn(BaseModel):
    password: str = Field(min_length=8, max_length=200)


@router.post("/auth/password-set/{token}")
@limiter.limit("5/minute")
async def password_set_redeem(request: Request, token: str, inp: Annotated[PasswordSetIn, Body()]):
    """Public — redeem the magic-link token, set the password, and issue
    a JWT so the client is logged in immediately. Single-use: the token
    is marked ``used`` before the JWT is returned, and any concurrent
    redemption will 410."""
    doc = await db.password_set_tokens.find_one({"id": token})
    if not doc:
        raise HTTPException(404, "This link is invalid.")
    if doc.get("used"):
        raise HTTPException(410, "This link has already been used.")
    if doc.get("expires_at") and doc["expires_at"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(410, "This link has expired.")
    now = datetime.now(timezone.utc).isoformat()
    # Atomic single-use guard — if two tabs redeem at once, only one wins.
    claim = await db.password_set_tokens.update_one(
        {"id": token, "used": False},
        {"$set": {"used": True, "used_at": now}},
    )
    if claim.modified_count != 1:
        raise HTTPException(410, "This link has already been used.")
    u = await db.users.find_one({"id": doc["user_id"]})
    if not u:
        raise HTTPException(404, "Account no longer exists.")
    await db.users.update_one(
        {"id": u["id"]},
        {"$set": {"password": hash_password(inp.password), "updated_at": now}},
    )
    jwt_token = create_token(u["id"], u["role"])
    return {
        "token": jwt_token,
        "user": {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"]},
    }


# ----------------------------------------------------------------------
# Forgot-password (public magic-link reset).
#
# Anti-enumeration: always returns 200 whether or not the email exists.
# If it does, we mint a fresh password-set token with purpose=reset and
# send the reset email via Resend. Reuses the same token-check + redeem
# endpoints as the initial welcome flow — the redeem path issues a JWT
# on success so the user is logged in immediately.
# ----------------------------------------------------------------------

class ForgotPasswordIn(BaseModel):
    email: EmailStr


# --- Rate limits for /auth/forgot-password -------------------------------
# Per-email, sliding-window counter stored in Mongo. Kept intentionally
# silent — legitimate users NEVER see a 429; instead, over-limit requests
# just silently no-op (matches the anti-enumeration behaviour of the main
# endpoint). This blunts anyone spamming the endpoint to flood an inbox.
_FORGOT_LIMIT_WINDOW_SECONDS = 15 * 60
_FORGOT_LIMIT_MAX_PER_WINDOW = 3


async def _forgot_password_rate_limited(email: str) -> bool:
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    cutoff = (_dt.now(_tz.utc) - _td(seconds=_FORGOT_LIMIT_WINDOW_SECONDS)).isoformat()
    count = await db.auth_rate_limits.count_documents({
        "action": "forgot_password", "email": email, "ts": {"$gte": cutoff},
    })
    return count >= _FORGOT_LIMIT_MAX_PER_WINDOW


async def _record_forgot_password_attempt(email: str) -> None:
    await db.auth_rate_limits.insert_one({
        "action": "forgot_password", "email": email,
        "ts": datetime.now(timezone.utc).isoformat(),
    })


@router.post("/auth/forgot-password")
@limiter.limit("3/minute")
async def forgot_password(request: Request, inp: Annotated[ForgotPasswordIn, Body()]):
    email = str(inp.email).lower()
    # Rate-limit hit → silent no-op (still 200). Never reveals whether
    # the address is registered *or* whether it's rate-limited.
    if await _forgot_password_rate_limited(email):
        import logging as _lg
        _lg.getLogger(__name__).warning(
            "Forgot-password rate limit hit for %s (max %s / %ss)",
            email, _FORGOT_LIMIT_MAX_PER_WINDOW, _FORGOT_LIMIT_WINDOW_SECONDS,
        )
        return {"ok": True}
    await _record_forgot_password_attempt(email)

    u = await db.users.find_one({"email": email})
    if not u:
        # Silent success — do NOT leak whether the address is registered.
        return {"ok": True}
    try:
        token = await mint_password_set_token(u["id"], purpose="reset", ttl_days=1)
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        subject, html = _tmpl.password_reset(
            name=u.get("name") or u["email"].split("@")[0],
            magic_url=f"{public_base_url()}/set-password/{token}",
        )
        await dispatch(
            kind="password_reset", to=email,
            subject=subject, html=html,
            initiating_user_id=u["id"],
            related={"purpose": "reset"},
        )
    except Exception:  # noqa: BLE001 — never leak errors, just log
        import logging as _lg
        _lg.getLogger(__name__).exception("Password-reset email failed for %s", email)
    return {"ok": True}



