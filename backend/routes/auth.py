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


# ----------------------- Auth endpoints -----------------------

@router.post("/auth/login")
async def login(inp: LoginIn):
    u = await db.users.find_one({"email": inp.email.lower()})
    if not u or not verify_password(inp.password, u["password"]):
        raise HTTPException(401, "Invalid credentials")
    token = create_token(u["id"], u["role"])
    return {"token": token, "user": {"id": u["id"], "email": u["email"],
            "name": u["name"], "role": u["role"]}}


@router.post("/auth/signup")
async def signup(inp: SignupIn):
    if await db.users.find_one({"email": inp.email.lower()}):
        raise HTTPException(400, "Email already registered")
    uid = str(uuid.uuid4())
    now = now_iso()
    await db.users.insert_one({
        "id": uid, "email": inp.email.lower(), "name": inp.name,
        "password": hash_password(inp.password), "role": inp.role,
        "created_at": now, "updated_at": now,
    })
    token = create_token(uid, inp.role)
    return {"token": token, "user": {"id": uid, "email": inp.email.lower(),
            "name": inp.name, "role": inp.role}}


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
    so return the email it belongs to so the UI can greet the user."""
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
    return {"email": u["email"], "name": u.get("name"), "role": u.get("role")}


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


