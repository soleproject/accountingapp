"""Axiom Ledger — Auth endpoints routes.

Auto-extracted from server.py during the Feb 2026 modularization refactor.
Behaviour is intentionally identical to the pre-split codebase.
"""
from __future__ import annotations
import os
import re
import uuid
import json
import random
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from auth import (
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
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
async def login(inp: LoginIn):
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
        raise HTTPException(401, "Invalid credentials")

    # Clean slate on successful login so a locked-out user who
    # eventually remembers their password isn't stuck.
    await _clear_login_failures(email)

    token = create_token(u["id"], u["role"])
    return {"token": token, "user": {"id": u["id"], "email": u["email"],
            "name": u["name"], "role": u["role"]}}


@router.post("/auth/signup")
async def signup(inp: SignupIn):
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
    await db.users.insert_one(doc)
    token = create_token(uid, inp.role)
    return {"token": token, "user": {"id": uid, "email": inp.email.lower(),
            "name": inp.name, "role": inp.role}}


# ----------------------------------------------------------------------
# Affiliate — every user has a shareable referral slug + link.
# ----------------------------------------------------------------------
@router.get("/share")
async def share_info(user: dict = Depends(get_current_user)):
    """Return the current user's affiliate assets: their slug, the shareable
    link (built from PRIMARY_HOST), and a lightweight earnings summary.

    The link uses the platform host by default, but the frontend can
    override to a firm subdomain when the referrer is a pro who wants
    their firm-branded URL to be the share destination.
    """
    from referral_util import mint_slug_for_user
    slug = await mint_slug_for_user(user["id"])
    host = os.environ.get("PRIMARY_HOST", "app.smartbookssoftware.ai")
    link = f"https://{host}/signup?ref={slug}"
    # Placeholder counts until the Stripe webhook lands next session; the
    # UI can already render the empty state without a code change once
    # `payments` + `user_referral_revenue_share` collections exist.
    referred_count = await db.users.count_documents({"referred_by_user_id": user["id"]})
    return {
        "slug": slug,
        "link": link,
        "referred_count": referred_count,
        "paying_count": 0,       # populated by Stripe webhook (P2 session)
        "earnings_cents": 0,      # populated by revenue-share ledger (P2 session)
        "pending_cents": 0,
    }


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return {"user": {k: user[k] for k in ("id", "email", "name", "role")}}


# ----------------------------------------------------------------------
# Change-password (self-service, requires bearer token).
# ----------------------------------------------------------------------
class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/auth/change-password")
async def change_password(inp: ChangePasswordIn, user: dict = Depends(get_current_user)):
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
async def password_set_redeem(token: str, inp: PasswordSetIn):
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
async def forgot_password(inp: ForgotPasswordIn):
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



