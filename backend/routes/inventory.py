"""Axiom Ledger — Inventory / Assets / Loans / Tags routes.

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


# ----------------------- Inventory / Assets / Loans / Tags -----------------------

def _make_crud(collection_name: str, path_prefix: str):
    @router.get(f"/companies/{{cid}}/{path_prefix}")
    async def _list(cid: str, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        docs = await db[collection_name].find({"company_id": cid}).to_list(1000)
        return {"items": [coerce(d) for d in docs]}

    @router.post(f"/companies/{{cid}}/{path_prefix}")
    async def _create(cid: str, payload: dict, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        xid = str(uuid.uuid4()); now = now_iso()
        await db[collection_name].insert_one({"id": xid, "company_id": cid, **payload,
                                               "created_at": now, "updated_at": now})
        return {"id": xid}

    @router.patch(f"/companies/{{cid}}/{path_prefix}/{{xid}}")
    async def _update(cid: str, xid: str, payload: dict, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        payload["updated_at"] = now_iso()
        await db[collection_name].update_one({"id": xid, "company_id": cid}, {"$set": payload})
        return {"ok": True}

    @router.delete(f"/companies/{{cid}}/{path_prefix}/{{xid}}")
    async def _delete(cid: str, xid: str, user: dict = Depends(get_current_user)):
        await require_company(user, cid)
        await db[collection_name].delete_one({"id": xid, "company_id": cid})
        return {"ok": True}


_make_crud("inventory_items", "inventory")
# Note: assets uses a custom lifecycle service (see below) — NOT the
# generic CRUD, because adding a fixed asset also creates CoA
# sub-accounts, posts an acquisition JE, and generates a monthly
# depreciation schedule.
_make_crud("loans", "loans")
_make_crud("tags", "tags")
_make_crud("communications", "communications")
_make_crud("connections", "connections")


# ----------------------- Fixed Assets (custom lifecycle) -----------------------

@router.get("/assets/types")
async def list_asset_types():
    """Public metadata used by the FixedAssetsPage modal — returns the
    canonical asset-type dropdown with default useful-life years so the
    frontend can auto-populate the life field on selection."""
    import asset_service
    return {"asset_types": asset_service.ASSET_TYPES}


@router.get("/companies/{cid}/assets")
async def list_assets(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.assets.find({"company_id": cid}).to_list(1000)
    return {"items": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/assets")
async def create_asset(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        import asset_service
        result = await asset_service.create_fixed_asset(cid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.patch("/companies/{cid}/assets/{aid}")
async def update_asset(cid: str, aid: str, payload: dict,
                       user: dict = Depends(get_current_user)):
    """Edit an existing fixed asset.

    Non-financial edits (name/notes/tag_ids/metadata) are cheap — just
    update the row and rename the linked sub-accounts. Financial edits
    (cost / life / dates / offset / asset type) delete the acquisition
    JE + every depreciation JE and re-generate the whole schedule with
    the new values. The asset's `id` stays stable across the swap.
    """
    await require_company(user, cid)
    try:
        import asset_service
        result = await asset_service.update_fixed_asset(cid, aid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.post("/companies/{cid}/assets/fix-hierarchy")
async def fix_asset_hierarchy(cid: str, user: dict = Depends(get_current_user)):
    """One-shot repair: re-home any fixed_asset / accumulated_depreciation
    sub-accounts that were nested under the wrong parent (a legacy bug
    where the code fetched code=1500 assuming it was "Fixed Assets" —
    but 1500 is often "Prepaid Expenses" in seeded CoAs). Idempotent."""
    await require_company(user, cid)
    import asset_service
    parent = await asset_service._ensure_fixed_assets_parent(cid)
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "fixed_assets_parent": {
        "id": parent["id"], "code": parent.get("code"), "name": parent.get("name"),
    }}


@router.post("/companies/{cid}/assets/{aid}/fund")
async def fund_asset(cid: str, aid: str, payload: dict,
                     user: dict = Depends(get_current_user)):
    """Phase-2 funding for an asset created without funding sources.
    Body: `{"sources": [{"account_id": "...", "amount": ...}, ...]}`.
    Sweeps balance out of the Fixed Asset Suspense clearing account
    into the real funding accounts (cash, mortgage, owner, etc.).
    Can be called multiple times if funding trickles in."""
    await require_company(user, cid)
    sources = payload.get("sources") or payload.get("offsets") or []
    try:
        import asset_service
        result = await asset_service.fund_fixed_asset(cid, aid, sources)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.delete("/companies/{cid}/assets/{aid}")
async def delete_asset(cid: str, aid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    import asset_service
    result = await asset_service.delete_fixed_asset(cid, aid)
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return result


