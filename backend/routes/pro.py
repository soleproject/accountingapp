"""Axiom Ledger — Pro dashboard routes.

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


# ----------------------- Pro dashboard -----------------------

@router.get("/pro/clients")
async def pro_clients(user: dict = Depends(require_role("pro", "superadmin"))):
    ms = await db.memberships.find({"user_id": user["id"], "role": "pro"}).to_list(1000)
    company_ids = [m["company_id"] for m in ms]
    if user["role"] == "superadmin":
        companies = await db.companies.find({}).to_list(1000)
    else:
        companies = await db.companies.find({"id": {"$in": company_ids}}).to_list(1000)
    result = []
    for c in companies:
        txn_count = await db.transactions.count_documents({"company_id": c["id"]})
        needs_review = await db.transactions.count_documents({"company_id": c["id"], "needs_review": True})
        result.append({
            "id": c["id"], "name": c["name"], "business_type": c.get("business_type", ""),
            "onboarding_complete": c.get("onboarding_complete", False),
            "transactions": txn_count, "needs_review": needs_review,
        })
    return {"clients": result}


@router.get("/pro/clients/lookup")
async def pro_lookup_client(email: str, user: dict = Depends(require_role("pro", "superadmin"))):
    """Lightweight probe used by the New-Client dialog to detect whether the
    given email already belongs to a client user. Only reveals name — never
    password / other PII. Returns {exists: bool, name: str|null}.
    """
    u = await db.users.find_one({"email": (email or "").strip().lower(), "role": "client"})
    if not u:
        return {"exists": False, "name": None}
    return {"exists": True, "name": u.get("name")}


@router.post("/pro/clients")
async def pro_create_client(inp: NewClientIn, user: dict = Depends(require_role("pro", "superadmin"))):
    """Create (or reuse) a client user + a new company + memberships, and seed
    the default CoA. If the email already belongs to a `client` user, we reuse
    that user and just add a fresh membership for the new company — this lets
    one owner login switch between multiple companies they own via the company
    dropdown at the top-left.
    """
    now = now_iso()
    email = inp.client_email.lower()
    existing = await db.users.find_one({"email": email})
    reused = False
    if existing:
        if existing.get("role") != "client":
            raise HTTPException(
                400,
                "That email belongs to a non-client account (pro/superadmin) and cannot be reused as a client.",
            )
        client_id = existing["id"]
        reused = True
        # Do NOT overwrite their password — they already have credentials.
    else:
        if not inp.client_password:
            raise HTTPException(400, "Password required — this is a new client email.")
        client_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": client_id, "email": email, "name": inp.client_name,
            "password": hash_password(inp.client_password), "role": "client",
            "created_at": now, "updated_at": now,
        })

    company_id = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": company_id, "name": inp.company_name,
        "business_type": inp.business_type, "business_description": inp.business_description,
        "reporting_basis": inp.reporting_basis,
        "owner_user_id": client_id, "pro_user_id": user["id"],
        "onboarding_complete": False,
        "created_at": now, "updated_at": now,
    })

    # Add memberships (avoid duplicates just in case)
    mems = [
        {"id": str(uuid.uuid4()), "user_id": client_id, "company_id": company_id, "role": "owner", "created_at": now},
        {"id": str(uuid.uuid4()), "user_id": user["id"], "company_id": company_id, "role": "pro", "created_at": now},
    ]
    await db.memberships.insert_many(mems)

    from seed import DEFAULT_COA
    for code, name, atype, subtype in DEFAULT_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id, "code": code, "name": name,
            "type": atype, "subtype": subtype, "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    await db.onboarding_state.insert_one({
        "id": str(uuid.uuid4()), "company_id": company_id, "step": 0, "total_steps": 6,
        "complete": False, "answers": {}, "created_at": now, "updated_at": now,
    })

    # How many companies does this owner now have access to?
    total = await db.memberships.count_documents({"user_id": client_id, "role": "owner"})
    return {
        "company_id": company_id,
        "client_id": client_id,
        "reused_existing_user": reused,
        "owner_company_count": total,
    }


# ---------------------------------------------------------------------------
# Pro branding — enterprise theming for firms managing their own clients.
# All fields live under the user (pro) doc's `branding` sub-doc:
#   { logo_data_url, signin_subdomain, theme_preset }
# `logo_data_url` is a base64 data URL (capped at ~500 KB); this keeps the
# feature single-service without introducing an object-storage dep for MVP.
# ---------------------------------------------------------------------------

_ALLOWED_PRESETS = {"default", "midnight", "forest", "violet"}
_SUBDOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
_MAX_LOGO_BYTES = 512 * 1024  # 500 KB — plenty for a lossless PNG/SVG logo.


class BrandingPatch(BaseModel):
    signin_subdomain: Optional[str] = None
    theme_preset: Optional[str] = None


def _branding_out(user_doc: dict) -> dict:
    b = (user_doc or {}).get("branding") or {}
    return {
        "logo_data_url": b.get("logo_data_url"),
        "signin_subdomain": b.get("signin_subdomain"),
        "theme_preset": b.get("theme_preset") or "default",
    }


@router.get("/pro/branding")
async def get_pro_branding(user: dict = Depends(require_role("pro", "superadmin"))):
    doc = await db.users.find_one({"id": user["id"]})
    return _branding_out(doc or {})


@router.patch("/pro/branding")
async def patch_pro_branding(
    inp: BrandingPatch,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    updates: dict = {}
    if inp.theme_preset is not None:
        if inp.theme_preset not in _ALLOWED_PRESETS:
            raise HTTPException(400, f"Unknown theme preset — must be one of {sorted(_ALLOWED_PRESETS)}")
        updates["branding.theme_preset"] = inp.theme_preset
    if inp.signin_subdomain is not None:
        sub = inp.signin_subdomain.strip().lower()
        if sub == "":
            updates["branding.signin_subdomain"] = None
        else:
            if not _SUBDOMAIN_RE.match(sub):
                raise HTTPException(400, "Subdomain must be 1–32 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen.")
            # Uniqueness across all pros — first come, first served.
            clash = await db.users.find_one({
                "branding.signin_subdomain": sub,
                "id": {"$ne": user["id"]},
            })
            if clash:
                raise HTTPException(409, f"'{sub}' is already taken.")
            updates["branding.signin_subdomain"] = sub
    if updates:
        await db.users.update_one({"id": user["id"]}, {"$set": updates})
    doc = await db.users.find_one({"id": user["id"]})
    return _branding_out(doc or {})


@router.post("/pro/branding/logo")
async def upload_pro_logo(
    file: UploadFile = File(...),
    user: dict = Depends(require_role("pro", "superadmin")),
):
    # Accept PNG/JPG/SVG/WebP up to 500 KB. Store as a base64 data URL so the
    # image round-trips in the same JSON call as the rest of the branding.
    if file.content_type not in {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}:
        raise HTTPException(400, "Logo must be PNG, JPG, SVG, or WebP.")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    if len(raw) > _MAX_LOGO_BYTES:
        raise HTTPException(400, f"Logo too large — max 500 KB (got {len(raw) // 1024} KB).")
    import base64 as _b64
    data_url = f"data:{file.content_type};base64,{_b64.b64encode(raw).decode('ascii')}"
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"branding.logo_data_url": data_url}},
    )
    return {"logo_data_url": data_url}


@router.delete("/pro/branding/logo")
async def delete_pro_logo(user: dict = Depends(require_role("pro", "superadmin"))):
    await db.users.update_one(
        {"id": user["id"]},
        {"$unset": {"branding.logo_data_url": ""}},
    )
    return {"ok": True}


