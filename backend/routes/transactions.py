"""Axiom Ledger — Transactions routes.

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


# ----------------------- Transactions -----------------------

@router.get("/companies/{cid}/transactions")
async def list_transactions(
    cid: str, user: dict = Depends(get_current_user),
    needs_review: Optional[bool] = None,
    page: int = 1, limit: int = 250,
    q: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    contact_id: Optional[str] = None,
    category_account_id: Optional[str] = None,
):
    await require_company(user, cid)
    query: dict = {"company_id": cid}
    if needs_review is not None:
        query["needs_review"] = needs_review
    if contact_id:
        query["contact_id"] = contact_id
    if category_account_id:
        query["category_account_id"] = category_account_id
    if date_from or date_to:
        date_clause: dict = {}
        if date_from:
            date_clause["$gte"] = date_from
        if date_to:
            date_clause["$lte"] = date_to
        query["date"] = date_clause
    if q and q.strip():
        # Simple case-insensitive substring search across merchant, description,
        # and contact_name. Escape regex specials so user input like "$5.00" or
        # "AT&T" doesn't blow up.
        pattern = re.escape(q.strip())
        query["$or"] = [
            {"merchant":     {"$regex": pattern, "$options": "i"}},
            {"description":  {"$regex": pattern, "$options": "i"}},
            {"contact_name": {"$regex": pattern, "$options": "i"}},
        ]
    # Clamp inputs to sane bounds. limit=0 returns everything (used by exports
    # and legacy callers that expect the full list).
    page = max(1, int(page or 1))
    limit = max(0, min(int(limit or 0), 5000))
    total = await db.transactions.count_documents(query)
    cursor = db.transactions.find(query).sort([("date", -1), ("_id", -1)])
    if limit > 0:
        skip = (page - 1) * limit
        cursor = cursor.skip(skip).limit(limit)
        pages = max(1, (total + limit - 1) // limit)
    else:
        pages = 1
    docs = await cursor.to_list(length=None)
    return {
        "transactions": [coerce(d) for d in docs],
        "pagination": {
            "total": total,
            "page": page,
            "pages": pages,
            "limit": limit,
        },
    }


@router.post("/companies/{cid}/transactions")
async def create_transaction(cid: str, inp: TransactionCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await assert_open(cid, inp.date)
    now = now_iso()
    tid = str(uuid.uuid4())
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}
    category_id = inp.category_account_id
    conf = 1.0
    reasoning = "Manually created"
    if inp.auto_categorize and not category_id:
        coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
        result = await categorize_transaction(inp.merchant or inp.description, inp.amount, inp.description, coa)
        match = next((a for a in accts if a["code"] == result["account_code"]), None)
        if match:
            category_id = match["id"]
        conf = result["confidence"]
        reasoning = result["reasoning"]
        await log_ai(cid, "categorize", 1)
    acct = accts_by_id.get(category_id) if category_id else None
    bank_id = inp.bank_account_id
    if not bank_id:
        # auto-default to Business Checking (code 1010) to preserve double-entry
        checking = next((a for a in accts if a.get("code") == "1010"), None)
        if checking:
            bank_id = checking["id"]
    bank = accts_by_id.get(bank_id) if bank_id else None
    # If the resolved category is a generic parent liability bucket, fan
    # out to a per-payee sub-account so the balance sheet stays instrument-level.
    if acct:
        from liability_subaccounts import is_parent_liability_bucket, resolve_or_create_liability_subaccount
        if is_parent_liability_bucket(acct):
            payee = inp.merchant or inp.description or ""
            child = await resolve_or_create_liability_subaccount(cid, acct, payee)
            if child:
                acct = child
                category_id = child["id"]
    doc = {
        "id": tid, "company_id": cid, "date": inp.date,
        "description": inp.description, "merchant": inp.merchant or inp.description,
        "amount": round(inp.amount, 2),
        "bank_account_id": bank_id,
        "bank_account_name": bank["name"] if bank else "",
        "category_account_id": category_id,
        "category_account_code": acct["code"] if acct else None,
        "category_account_name": acct["name"] if acct else None,
        "ai_confidence": round(conf, 2),
        "ai_reasoning": reasoning,
        "needs_review": conf < 0.80,
        "human_reviewed": False,
        "posted": conf >= 0.80 or not inp.auto_categorize,
        "source": "manual",
        "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
        "linked_payment_id": None, "tags": [],
        "created_at": now, "updated_at": now,
    }
    if doc["posted"]:
        await log_ai(cid, "post_je", 1)
    if doc["needs_review"]:
        await log_ai(cid, "flag_review", 1)
    await db.transactions.insert_one(doc)
    return {"id": tid, "transaction": coerce(doc)}


@router.patch("/companies/{cid}/transactions/{tid}")
async def update_transaction(cid: str, tid: str, inp: TransactionUpdate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await assert_open(cid, existing.get("date"))
        if inp.date:
            await assert_open(cid, inp.date)
    upd = {k: v for k, v in inp.model_dump(exclude_unset=True).items() if v is not None}
    if "category_account_id" in upd:
        acct = await db.accounts.find_one({"id": upd["category_account_id"], "company_id": cid})
        if acct:
            # If the caller picked a generic parent liability bucket, auto-route
            # to the matching per-payee sub-account so the balance sheet stays
            # instrument-level.
            from liability_subaccounts import is_parent_liability_bucket, resolve_or_create_liability_subaccount
            if is_parent_liability_bucket(acct):
                payee = existing.get("contact_name") if existing else None
                if not payee and existing:
                    payee = existing.get("merchant")
                child = await resolve_or_create_liability_subaccount(cid, acct, payee)
                if child:
                    acct = child
                    upd["category_account_id"] = child["id"]
            upd["category_account_code"] = acct["code"]
            upd["category_account_name"] = acct["name"]
        upd["human_reviewed"] = True
        upd["needs_review"] = False
    upd["updated_at"] = now_iso()
    await db.transactions.update_one({"id": tid, "company_id": cid}, {"$set": upd})
    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    # Persist merchant→category override into cache (user is authoritative)
    if "category_account_id" in upd and doc:
        merch = (doc.get("merchant") or "").strip()
        code = doc.get("category_account_code")
        if merch and code:
            await merchant_cache.upsert(
                cid, merch, code,
                account_name=doc.get("category_account_name") or "",
                confidence=1.0, source="user",
            )
    return {"transaction": coerce(doc)}


@router.post("/companies/{cid}/transactions/{tid}/split")
async def split_transaction(cid: str, tid: str, inp: SplitIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found")
    await assert_open(cid, txn.get("date"))

    # Normalize splits: each must carry a resolvable category_account_id.
    # Accept either 'category_account_id' or 'account_code' from clients.
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    by_id = {a["id"]: a for a in accts}
    by_code = {a["code"]: a for a in accts}
    normalized: list[dict] = []
    total = 0.0
    for s in inp.splits:
        amt = float(s.get("amount", 0) or 0)
        cat_id = s.get("category_account_id") or s.get("account_id")
        if not cat_id or cat_id not in by_id:
            code = s.get("account_code") or s.get("code")
            if code and code in by_code:
                cat_id = by_code[code]["id"]
            else:
                raise HTTPException(400, f"Split is missing a valid category account (received {s})")
        acct = by_id[cat_id]
        normalized.append({
            "amount": round(amt, 2),
            "category_account_id": cat_id,
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "description": s.get("description") or s.get("memo") or "",
        })
        total += amt
    if abs(total - float(txn["amount"])) > 0.01:
        raise HTTPException(400, f"Splits must total {txn['amount']}, got {total}")
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {"splits": normalized, "human_reviewed": True, "needs_review": False, "updated_at": now_iso()}},
    )
    return {"ok": True, "splits": normalized}


@router.post("/companies/{cid}/transactions/{tid}/link")
async def link_transaction(
    cid: str, tid: str,
    invoice_id: Optional[str] = None, bill_id: Optional[str] = None, payment_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    upd = {"updated_at": now_iso()}
    if invoice_id is not None:
        upd["linked_invoice_id"] = invoice_id
    if bill_id is not None:
        upd["linked_bill_id"] = bill_id
    if payment_id is not None:
        upd["linked_payment_id"] = payment_id
    await db.transactions.update_one({"id": tid, "company_id": cid}, {"$set": upd})
    return {"ok": True}


@router.post("/companies/{cid}/transactions/{tid}/approve")
async def approve_transaction(cid: str, tid: str, user: dict = Depends(get_current_user)):
    """Mark human-reviewed & posted."""
    await require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await assert_open(cid, existing.get("date"))
    await db.transactions.update_one({"id": tid, "company_id": cid},
        {"$set": {"human_reviewed": True, "needs_review": False, "posted": True, "updated_at": now_iso()}})
    # Track approval count on merchant for rule suggestion + upsert merchant cache
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if txn:
        merch = (txn.get("merchant") or "").strip()
        acct = txn.get("category_account_code")
        if merch and acct:
            # Upsert merchant cache as authoritative (user-approved)
            await merchant_cache.upsert(
                cid, merch, acct,
                account_name=txn.get("category_account_name") or "",
                confidence=1.0, source="user",
            )
            key = f"{merch}::{acct}"
            existing = await db.rule_candidates.find_one({"company_id": cid, "key": key})
            if existing:
                await db.rule_candidates.update_one({"id": existing["id"]}, {"$inc": {"approvals": 1}})
            else:
                await db.rule_candidates.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid, "key": key,
                    "merchant": merch, "account_code": acct,
                    "account_name": txn.get("category_account_name"),
                    "approvals": 1, "created_at": now_iso(),
                })
    return {"ok": True}


@router.post("/companies/{cid}/transactions/{tid}/unapprove")
async def unapprove_transaction(cid: str, tid: str, user: dict = Depends(get_current_user)):
    """Reverse a human approval — flips `human_reviewed` back to False so the
    row loses its 'Reviewed' badge. Doesn't touch `posted` or `needs_review`;
    if the user wants to re-flag it for review they can do that explicitly.
    """
    await require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await assert_open(cid, existing.get("date"))
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {"human_reviewed": False, "updated_at": now_iso()}},
    )
    return {"ok": True}


@router.post("/companies/{cid}/transactions/bulk-approve")
async def bulk_approve(cid: str, ids: List[str], user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.transactions.update_many(
        {"id": {"$in": ids}, "company_id": cid},
        {"$set": {"human_reviewed": True, "needs_review": False, "posted": True, "updated_at": now_iso()}},
    )
    return {"ok": True, "count": len(ids)}


@router.post("/companies/{cid}/transactions/bulk-reclassify")
async def bulk_reclassify(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Reclassify multiple transactions to a new category in one shot.

    Body: {"transaction_ids": [str, ...], "category_account_id": str}

    Because our reports compute the ledger directly from `transactions.posted=True`
    (bank_account gets +amount, category_account gets -amount — see
    `reports._signed_balances`), reclassifying is a single `category_account_*`
    update. No manual JE reversal is required — the trial balance recalculates
    automatically on the next report/dashboard fetch.

    Side effects:
    - Marks rows `human_reviewed=True`, `posted=True`, `needs_review=False`.
    - Bumps `rule_candidates.approvals` for every distinct merchant→account pair
      touched by the bulk op. When any candidate crosses the `approvals >= 2`
      threshold the response includes a `rule_suggestion` so the UI can offer
      "Turn this into a rule?".
    - Logs an `ai_activity` `post_je` event with the count.
    - Enforces closed-period lock per row.
    """
    await require_company(user, cid)
    ids = [x for x in (payload.get("transaction_ids") or []) if x]
    cat_id = payload.get("category_account_id")
    if not ids or not cat_id:
        raise HTTPException(400, "transaction_ids and category_account_id are required")

    acct = await db.accounts.find_one({"id": cat_id, "company_id": cid})
    if not acct:
        raise HTTPException(404, "Target category account not found in this company")

    txns = await db.transactions.find(
        {"id": {"$in": ids}, "company_id": cid}
    ).to_list(len(ids))
    if not txns:
        raise HTTPException(404, "No matching transactions in this company")

    # Closed-period guard: skip locked rows rather than failing the whole op.
    skipped_closed: list[str] = []
    editable: list[dict] = []
    for t in txns:
        if await is_period_closed(cid, t.get("date")):
            skipped_closed.append(t["id"])
        else:
            editable.append(t)

    if not editable:
        return {"ok": True, "updated": 0, "skipped_closed": skipped_closed,
                "rule_suggestion": None}

    now = now_iso()
    editable_ids = [t["id"] for t in editable]

    # If the target is a generic parent liability bucket, fan out to per-payee
    # sub-accounts so each instrument tracks separately on the balance sheet.
    from liability_subaccounts import is_parent_liability_bucket, resolve_or_create_liability_subaccount
    fanout = is_parent_liability_bucket(acct)
    subaccounts_created = 0
    if fanout:
        # Group by payee, create/resolve one child per group, and issue a
        # separate update_many per child.
        by_payee: dict[str, list[dict]] = {}
        for t in editable:
            payee = (t.get("contact_name") or t.get("merchant") or "").strip()
            by_payee.setdefault(payee, []).append(t)
        touched = 0
        for payee, txns_group in by_payee.items():
            target = acct  # fall back to parent when payee is generic
            if payee:
                child = await resolve_or_create_liability_subaccount(cid, acct, payee)
                if child:
                    target = child
                    # Track whether it was actually new to report to caller.
                    if child.get("created_by_ai") and child.get("created_at") == now_iso():
                        subaccounts_created += 1
            group_ids = [t["id"] for t in txns_group]
            await db.transactions.update_many(
                {"id": {"$in": group_ids}, "company_id": cid},
                {"$set": {
                    "category_account_id":   target["id"],
                    "category_account_code": target["code"],
                    "category_account_name": target["name"],
                    "ai_confidence": 1.0,
                    "ai_reasoning": f"Manual bulk reclassify → {target['name']}",
                    "ai_source": "manual_bulk",
                    "needs_review": False,
                    "human_reviewed": True,
                    "posted": True,
                    "updated_at": now,
                }},
            )
            touched += len(txns_group)
    else:
        await db.transactions.update_many(
            {"id": {"$in": editable_ids}, "company_id": cid},
            {"$set": {
                "category_account_id":   acct["id"],
                "category_account_code": acct["code"],
                "category_account_name": acct["name"],
                "ai_confidence": 1.0,
                "ai_reasoning": f"Manual bulk reclassify → {acct['name']}",
                "ai_source": "manual_bulk",
                "needs_review": False,
                "human_reviewed": True,
                "posted": True,
                "updated_at": now,
            }},
        )
    await log_ai(cid, "post_je", len(editable))

    # Bump rule_candidates per (merchant, account_code) pair, then look for a
    # suggestion whose threshold just crossed (approvals >= 2).
    merchant_counts: dict[str, int] = {}
    for t in editable:
        merch = (t.get("merchant") or t.get("contact_name") or "").strip()
        if merch:
            merchant_counts[merch] = merchant_counts.get(merch, 0) + 1

    rule_suggestion = None
    for merch, added in merchant_counts.items():
        key = f"{merch}::{acct['code']}"
        existing = await db.rule_candidates.find_one({"company_id": cid, "key": key})
        if existing:
            new_ct = int(existing.get("approvals", 0)) + added
            await db.rule_candidates.update_one(
                {"id": existing["id"]}, {"$set": {"approvals": new_ct}},
            )
            approvals = new_ct
        else:
            approvals = added
            await db.rule_candidates.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid, "key": key,
                "merchant": merch, "account_code": acct["code"],
                "account_name": acct["name"],
                "approvals": approvals, "created_at": now,
            })
        # Suggest the *strongest* candidate that isn't already a rule.
        if approvals >= 2:
            has_rule = await db.rules.find_one({
                "company_id": cid,
                "match_type": "merchant_contains",
                "match_value": {"$regex": f"^{re.escape(merch)}$", "$options": "i"},
                "account_code": acct["code"],
            })
            if not has_rule and (rule_suggestion is None
                                  or approvals > rule_suggestion["approvals"]):
                rule_suggestion = {
                    "merchant": merch,
                    "account_code": acct["code"],
                    "account_name": acct["name"],
                    "approvals": approvals,
                }

    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "updated": len(editable),
        "skipped_closed": skipped_closed,
        "rule_suggestion": rule_suggestion,
    }


@router.delete("/companies/{cid}/transactions/{tid}")
async def delete_transaction(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await assert_open(cid, existing.get("date"))
    await db.transactions.delete_one({"id": tid, "company_id": cid})
    return {"ok": True}


