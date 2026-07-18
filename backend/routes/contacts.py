"""Axiom Ledger — Contacts routes.

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


# ----------------------- Contacts -----------------------

@router.get("/companies/{cid}/contacts")
async def list_contacts(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)

    # Cache the enriched response briefly. For 3k concurrent users each
    # refreshing every ~30 s, this drops the aggregation load on Mongo by
    # ~40x while staying fresh enough for a UI list. The cache is
    # invalidated in all contact-mutating endpoints AND by sync completion
    # (see sync_tasks._mark_done → get_cache().ainvalidate).
    from infra import get_cache
    cache = get_cache()
    ckey = cache.key("contacts_list", company_id=cid)

    async def _compute() -> dict:
        docs = await db.contacts.find({"company_id": cid}).sort("name", 1).to_list(2000)
        ytd_start = f"{datetime.now(timezone.utc).year}-01-01"
        pipeline = [
            {"$match": {"company_id": cid, "contact_id": {"$nin": [None, ""]}}},
            {"$group": {
                "_id": "$contact_id",
                "hits": {"$sum": 1},
                "last_seen": {"$max": "$date"},
                "ytd_in": {"$sum": {"$cond": [
                    {"$and": [{"$gt": ["$amount", 0]},
                              {"$gte": ["$date", ytd_start]}]},
                    "$amount", 0]}},
                "ytd_out_neg": {"$sum": {"$cond": [
                    {"$and": [{"$lt": ["$amount", 0]},
                              {"$gte": ["$date", ytd_start]}]},
                    "$amount", 0]}},
            }},
        ]
        stats: dict[str, dict] = {}
        async for row in db.transactions.aggregate(pipeline):
            ytd_in = round(row.get("ytd_in") or 0.0, 2)
            ytd_out = round(-(row.get("ytd_out_neg") or 0.0), 2)
            stats[row["_id"]] = {
                "hits": row.get("hits") or 0,
                "last_seen": row.get("last_seen"),
                "ytd_in": ytd_in,
                "ytd_out": ytd_out,
                "net": round(ytd_in - ytd_out, 2),
            }
        out = []
        empty = {"hits": 0, "last_seen": None, "ytd_in": 0.0,
                 "ytd_out": 0.0, "net": 0.0}
        for d in docs:
            c = coerce(d)
            s = stats.get(c["id"], empty)
            c["hits"] = s["hits"]
            c["last_seen"] = s["last_seen"]
            c["ytd_in"] = s["ytd_in"]
            c["ytd_out"] = s["ytd_out"]
            c["net"] = s["net"]
            # Back-compat alias: older UI referenced `txn_count`.
            c["txn_count"] = s["hits"]
            out.append(c)
        return {"contacts": out}

    return await cache.get_or_compute(ckey, ttl=45, compute=_compute)


@router.post("/companies/{cid}/contacts")
async def create_contact(cid: str, inp: ContactCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    xid = str(uuid.uuid4()); now = now_iso()
    payload = inp.model_dump()
    # The `contacts` collection has a unique index on (company_id, normalized_name).
    # Without this key set, every second manual contact creation in a given
    # company would fail with a duplicate-null-key error.
    from contact_resolver import normalize_contact_name  # local import to avoid cycle
    payload["normalized_name"] = normalize_contact_name(payload.get("name"))
    await db.contacts.insert_one({
        "id": xid, "company_id": cid, **payload,
        "created_at": now, "updated_at": now,
    })
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"id": xid}


@router.patch("/companies/{cid}/contacts/{xid}")
async def update_contact(cid: str, xid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    payload["updated_at"] = now_iso()
    await db.contacts.update_one({"id": xid, "company_id": cid}, {"$set": payload})
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@router.delete("/companies/{cid}/contacts/{xid}")
async def delete_contact(cid: str, xid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.contacts.delete_one({"id": xid, "company_id": cid})
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@router.post("/companies/{cid}/contacts/merge")
async def merge_contacts(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Merge one or more "loser" contacts into a single "keeper".

    Body: {"keeper_id": str, "loser_ids": [str, ...]}

    - Reassigns contact_id + contact_name on every collection that references
      contacts (transactions, invoices, bills, payments, receipts,
      contact_learning_cache) from losers → keeper.
    - Deletes the loser contact rows.
    - Invalidates the report cache so dashboards refresh immediately.
    """
    await require_company(user, cid)
    keeper_id = payload.get("keeper_id")
    loser_ids = [x for x in (payload.get("loser_ids") or []) if x and x != keeper_id]
    if not keeper_id or not loser_ids:
        raise HTTPException(400, "keeper_id and non-empty loser_ids required")

    keeper = await db.contacts.find_one({"id": keeper_id, "company_id": cid})
    if not keeper:
        raise HTTPException(404, "Keeper contact not found in this company")
    loser_docs = await db.contacts.find(
        {"id": {"$in": loser_ids}, "company_id": cid}
    ).to_list(1000)
    if len(loser_docs) != len(loser_ids):
        raise HTTPException(404, "One or more loser contacts not found in this company")

    keeper_name = keeper.get("name")
    reassignment = {"$set": {"contact_id": keeper_id, "contact_name": keeper_name,
                             "updated_at": now_iso()}}
    match = {"company_id": cid, "contact_id": {"$in": loser_ids}}

    results = {}
    for coll_name in ("transactions", "invoices", "bills", "payments", "receipts"):
        r = await db[coll_name].update_many(match, reassignment)
        results[coll_name] = r.modified_count

    # Learning cache stores contact_id without contact_name; migrate too so
    # future AI resolves land on the keeper.
    lc = await db.contact_learning_cache.update_many(
        {"company_id": cid, "contact_id": {"$in": loser_ids}},
        {"$set": {"contact_id": keeper_id, "contact_name": keeper_name}},
    )
    results["contact_learning_cache"] = lc.modified_count

    deleted = await db.contacts.delete_many(
        {"id": {"$in": loser_ids}, "company_id": cid}
    )

    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "keeper_id": keeper_id,
        "keeper_name": keeper_name,
        "merged_contacts": deleted.deleted_count,
        "reassigned": results,
    }


