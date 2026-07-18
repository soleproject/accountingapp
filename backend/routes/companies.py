"""Axiom Ledger — Companies routes.

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


# ----------------------- Companies -----------------------

@router.get("/companies")
async def list_companies(user: dict = Depends(get_current_user)):
    ids = await company_ids_for_user(user)
    docs = await db.companies.find({"id": {"$in": ids}}).to_list(1000)
    return {"companies": [coerce(d) for d in docs]}


@router.post("/companies")
async def create_company(inp: CompanyCreate, user: dict = Depends(get_current_user)):
    cid = str(uuid.uuid4())
    now = now_iso()
    await db.companies.insert_one({
        "id": cid, "name": inp.name, "business_type": inp.business_type,
        "business_description": inp.business_description,
        "reporting_basis": inp.reporting_basis,
        "owner_user_id": user["id"], "onboarding_complete": False,
        "created_at": now, "updated_at": now,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "company_id": cid,
        "role": "owner", "created_at": now,
    })
    # Auto-provision default CoA
    from seed import DEFAULT_COA
    for code, name, atype, subtype in DEFAULT_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": code, "name": name,
            "type": atype, "subtype": subtype, "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    await db.onboarding_state.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "step": 0, "total_steps": 6,
        "complete": False, "answers": {}, "created_at": now, "updated_at": now,
    })
    return {"company_id": cid}


@router.post("/companies/{cid}/contacts/backfill")
async def contacts_backfill(cid: str, user: dict = Depends(get_current_user)):
    """One-time migration: resolve + assign contacts on every transaction that
    doesn't yet have one. Uses the fast merchant_name path when available,
    Claude Haiku otherwise. Idempotent — running twice is safe.
    """
    await require_company(user, cid)
    from ai_service import resolve_contact_ai
    # Find txns missing contact_id (either field absent or explicit null)
    missing = await db.transactions.find({
        "company_id": cid,
        "$or": [{"contact_id": None}, {"contact_id": {"$exists": False}}],
    }).to_list(20000)
    if not missing:
        return {"scanned": 0, "resolved": 0, "created": 0, "left_null": 0}

    items = [{
        "merchant_name": t.get("merchant"),
        "description": t.get("description"),
        "amount": t.get("amount"),
        # Pass PFC so the new NO_COUNTERPARTY_PFC gate can filter out
        # transfers/ATM/fees/interest — otherwise the backfill would create
        # a bogus "BofA ATM 07/16 ..." contact for every self-transfer.
        "pfc_primary": t.get("pfc_primary"),
    } for t in missing]
    results = await contact_resolver.resolve_contacts_batch(
        cid, items, ai_fallback_fn=resolve_contact_ai, concurrency=5,
    )
    resolved = 0
    created = 0
    left_null = 0
    created_ids: set[str] = set()
    now = now_iso()
    for t, r in zip(missing, results):
        if r.get("contact_id"):
            await db.transactions.update_one(
                {"id": t["id"], "company_id": cid},
                {"$set": {"contact_id": r["contact_id"],
                          "contact_name": r["contact_name"],
                          "contact_source": r.get("source"),
                          "updated_at": now}},
            )
            resolved += 1
            if r.get("source") in ("merchant_name", "ai_new") and r["contact_id"] not in created_ids:
                created += 1
                created_ids.add(r["contact_id"])
        else:
            # Explicit no_counterparty marker so we know we've evaluated
            # this row (vs "never scanned yet") and can skip it next time.
            await db.transactions.update_one(
                {"id": t["id"], "company_id": cid},
                {"$set": {"contact_source": r.get("source") or "no_counterparty",
                          "updated_at": now}},
            )
            left_null += 1
    return {"scanned": len(missing), "resolved": resolved,
            "created": created, "left_null": left_null}


@router.patch("/companies/{cid}/settings/auto-post-threshold")
async def set_auto_post_threshold(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Per-company AI auto-post threshold (default 0.80)."""
    await require_company(user, cid)
    try:
        v = float(payload.get("threshold"))
    except Exception:
        raise HTTPException(400, "threshold must be a number 0.0-1.0")
    if not (0.0 <= v <= 1.0):
        raise HTTPException(400, "threshold must be between 0.0 and 1.0")
    await db.companies.update_one({"id": cid}, {"$set": {
        "auto_post_threshold": v, "updated_at": now_iso(),
    }})
    return {"auto_post_threshold": v}


# ---------------------------------------------------------------------------
# Plaid PFC → Chart-of-Accounts overrides (per Rocketbooks' pfc_org_overrides)
# ---------------------------------------------------------------------------

@router.get("/companies/{cid}/pfc-overrides")
async def list_pfc_overrides(cid: str, user: dict = Depends(get_current_user)):
    """List every Plaid PFCv2 detailed code alongside:
      - the default mapping (from `pfc_mapping.PFC_COA_MAPPINGS`)
      - the org's override, if pinned
    Used to render the PFC-mapping settings page.
    """
    await require_company(user, cid)
    import pfc_mapping as _pfcm
    overrides = await db.pfc_org_overrides.find({"company_id": cid}).to_list(500)
    by_pfc = {o["pfc_detailed"]: o for o in overrides}
    accts = await db.accounts.find({"company_id": cid, "is_active": {"$ne": False}}).to_list(2000)
    by_id = {a["id"]: a for a in accts}
    by_code = {a["code"]: a for a in accts}
    rows = []
    for m in _pfcm.PFC_COA_MAPPINGS:
        default_acct = by_code.get(m.account_code)
        ov = by_pfc.get(m.pfc_detailed)
        ov_acct = by_id.get(ov["category_account_id"]) if ov else None
        rows.append({
            "pfc_primary": m.pfc_primary,
            "pfc_detailed": m.pfc_detailed,
            "classification": m.classification,
            "description": m.description_v2,
            "default_account_code": m.account_code,
            "default_account_name": (default_acct or {}).get("name"),
            "override_account_id": (ov or {}).get("category_account_id"),
            "override_account_code": (ov_acct or {}).get("code"),
            "override_account_name": (ov_acct or {}).get("name"),
            "override_source": (ov or {}).get("source"),
            "override_confidence": (ov or {}).get("confidence"),
        })
    return {"count": len(rows), "rows": rows}


@router.put("/companies/{cid}/pfc-overrides/{pfc_detailed}")
async def set_pfc_override(cid: str, pfc_detailed: str, payload: dict,
                           user: dict = Depends(get_current_user)):
    """Pin a Plaid PFCv2 code to a specific chart-of-accounts row for this org.
    Body: {"category_account_id": "<coa-id>"}. `source` defaults to 'user'.
    """
    await require_company(user, cid)
    import pfc_mapping as _pfcm
    import pfc_resolver as _pfcr
    if not _pfcm.get_pfc_mapping(pfc_detailed):
        raise HTTPException(400, f"Unknown PFC detailed code: {pfc_detailed}")
    account_id = (payload or {}).get("category_account_id")
    if not account_id:
        raise HTTPException(400, "category_account_id is required")
    acct = await db.accounts.find_one({"company_id": cid, "id": account_id})
    if not acct:
        raise HTTPException(404, "Account not found on this company")
    saved = await _pfcr.set_pfc_override(
        cid, pfc_detailed, account_id,
        source=payload.get("source", "user"),
        confidence=payload.get("confidence"),
        reasoning=payload.get("reasoning"),
        ai_model=payload.get("ai_model"),
    )
    return {"ok": True, "override": saved}


@router.delete("/companies/{cid}/pfc-overrides/{pfc_detailed}")
async def delete_pfc_override(cid: str, pfc_detailed: str,
                              user: dict = Depends(get_current_user)):
    """Remove an override; the PFC falls back to the default mapping."""
    await require_company(user, cid)
    r = await db.pfc_org_overrides.delete_one({
        "company_id": cid, "pfc_detailed": pfc_detailed,
    })
    return {"ok": True, "deleted": r.deleted_count}


@router.patch("/companies/{cid}")
async def update_company(cid: str, patch: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    allowed = {"name", "business_type", "business_description", "reporting_basis", "auto_post_threshold"}
    updates = {k: v for k, v in (patch or {}).items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No editable fields provided")
    updates["updated_at"] = now_iso()
    r = await db.companies.update_one({"id": cid}, {"$set": updates})
    if r.matched_count == 0:
        raise HTTPException(404, "Company not found")
    doc = await db.companies.find_one({"id": cid})
    return coerce(doc)



    await require_company(user, cid)
    allowed = {"name", "business_type", "business_description", "reporting_basis"}
    updates = {k: v for k, v in (patch or {}).items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No editable fields provided")
    updates["updated_at"] = now_iso()
    r = await db.companies.update_one({"id": cid}, {"$set": updates})
    if r.matched_count == 0:
        raise HTTPException(404, "Company not found")
    doc = await db.companies.find_one({"id": cid})
    return coerce(doc)


@router.delete("/companies/{cid}")
async def delete_company(cid: str, confirm: str = "", user: dict = Depends(get_current_user)):
    """Hard-delete a company and every record scoped to it. Requires
    `?confirm=<company_name>` in the query string as a safeguard against
    accidental deletes. The requester must have an owner/pro/superadmin
    membership on the company.
    """
    await require_company(user, cid)
    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found")
    if not confirm or confirm.strip() != company.get("name", "").strip():
        raise HTTPException(
            400,
            f"To confirm deletion, pass ?confirm=<exact company name>. Got: {confirm!r}",
        )
    # Every collection that carries a `company_id` field
    per_company_collections = [
        "accounts", "transactions", "journal_entries", "invoices", "bills",
        "customers", "vendors", "payments", "onboarding_state",
        "plaid_items", "veryfi_uploads", "ai_activity_log", "rules",
        "audit_logs", "period_locks", "memberships",
    ]
    deleted: dict[str, int] = {}
    for coll in per_company_collections:
        try:
            r = await db[coll].delete_many({"company_id": cid})
            if r.deleted_count:
                deleted[coll] = r.deleted_count
        except Exception:
            pass
    # Finally the company itself
    r = await db.companies.delete_one({"id": cid})
    deleted["companies"] = r.deleted_count
    return {"deleted": True, "company_id": cid, "records_removed": deleted}


