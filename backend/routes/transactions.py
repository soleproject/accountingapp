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

@router.get("/companies/{cid}/transactions/cleanup-suggestions")
async def cleanup_suggestions(cid: str, user: dict = Depends(get_current_user)):
    """Powers the Transactions-page Cleanup Copilot hero band. Returns:
      progress:  overall segment counts + pct_reviewed
      top_actions: ordered by impact (contact_in_uncat > contact_split > flagged)
    All counts are for the whole company (no date filter) so the hero reflects
    the true books-health picture, not whatever tab the user just clicked.
    """
    await require_company(user, cid)
    txns = await db.transactions.find({"company_id": cid}).to_list(50000)
    total = len(txns)
    reviewed = sum(1 for t in txns if t.get("human_reviewed"))
    ai_cat  = sum(1 for t in txns
                  if not t.get("human_reviewed") and t.get("posted")
                  and t.get("category_account_code") not in ("9999", "4999"))
    uncat = sum(1 for t in txns
                if not t.get("category_account_id")
                or t.get("category_account_code") in ("9999", "4999"))
    flagged = sum(1 for t in txns if t.get("needs_review"))
    pct = round(100.0 * reviewed / total, 1) if total else 0.0

    # Contacts sitting entirely (or mostly) in Uncategorized.
    from collections import defaultdict
    uncat_by_contact = defaultdict(lambda: {"count": 0, "amount": 0.0, "contact_name": ""})
    split_by_contact = defaultdict(set)
    for t in txns:
        cid_key = t.get("contact_id")
        if not cid_key:
            continue
        if not t.get("category_account_id") or t.get("category_account_code") in ("9999", "4999"):
            b = uncat_by_contact[cid_key]
            b["count"] += 1
            b["amount"] += abs(float(t.get("amount") or 0.0))
            b["contact_name"] = t.get("contact_name") or ""
        if t.get("category_account_id"):
            split_by_contact[cid_key].add(t.get("category_account_id"))

    top_actions: list[dict] = []
    for cidk, b in sorted(uncat_by_contact.items(), key=lambda kv: -kv[1]["count"])[:8]:
        if b["count"] >= 3:
            top_actions.append({
                "kind": "contact_in_uncat",
                "contact_id": cidk, "contact_name": b["contact_name"],
                "count": b["count"], "total_amount": round(b["amount"], 2),
                "label": f"{b['contact_name']} · Uncategorized",
                "why": f"{b['count']} rows from {b['contact_name']} are still uncategorized.",
            })
    for cidk, cats in sorted(split_by_contact.items(), key=lambda kv: -len(kv[1]))[:6]:
        if len(cats) >= 3:
            cname = next((t.get("contact_name") for t in txns if t.get("contact_id") == cidk), "")
            top_actions.append({
                "kind": "contact_split",
                "contact_id": cidk, "contact_name": cname,
                "count": len(cats),
                "label": f"{cname} · {len(cats)} categories",
                "why": f"{cname} is spread across {len(cats)} different accounts — likely a categorization inconsistency.",
            })
    if flagged > 0:
        top_actions.append({
            "kind": "flagged_batch",
            "count": flagged,
            "label": f"Flagged for review ({flagged})",
            "why": "The AI wasn't sure about these and marked them for a human eye.",
        })

    return {
        "progress": {
            "total": total, "reviewed": reviewed, "ai_categorized": ai_cat,
            "uncategorized": uncat, "flagged": flagged, "pct_reviewed": pct,
        },
        "top_actions": top_actions[:8],
    }


@router.get("/companies/{cid}/transactions/contact-category-rollup")
async def contact_category_rollup(
    cid: str,
    q: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    contact_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Group every visible transaction by (contact, category) and report the
    count + amount range for each cell. Powers the "Contact Rollup" view on
    the Transactions page — a cleanup lens that surfaces contacts whose
    transactions span multiple accounts (e.g. AT&T split across Utilities,
    Meals, and Uncategorized).

    Response:
        {
          "contacts": [
            {
              "contact_id": "...", "contact_name": "AT&T",
              "total_count": 10,
              "categories": [
                {"category_account_id": "...", "category_code": "6600",
                 "category_name": "Utilities", "count": 7,
                 "min_amount": 109.28, "max_amount": 237.44,
                 "total_amount": 1234.56},
                ...
              ]
            },
            ...
          ]
        }
    Contacts sorted alphabetically; categories within each contact sorted
    by count desc. Amounts are the absolute value of the transaction amount
    so a single-sign range reads naturally in the UI.
    """
    await require_company(user, cid)

    mongo_q: dict = {"company_id": cid}
    if date_from: mongo_q.setdefault("date", {})["$gte"] = date_from
    if date_to:   mongo_q.setdefault("date", {})["$lte"] = date_to
    if contact_id: mongo_q["contact_id"] = contact_id

    txns = await db.transactions.find(mongo_q).limit(20000).to_list(20000)

    needle = (q or "").strip().lower()
    if needle:
        def _match(t: dict) -> bool:
            hay = " ".join([
                str(t.get("merchant") or ""),
                str(t.get("description") or ""),
                str(t.get("contact_name") or ""),
            ]).lower()
            return needle in hay
        txns = [t for t in txns if _match(t)]

    # Fold into a nested dict for the aggregation, then flatten to lists.
    buckets: dict = {}
    for t in txns:
        cid_key = t.get("contact_id") or "__no_contact__"
        cname = t.get("contact_name") or "(No contact)"
        acat = t.get("category_account_id") or "__uncategorized__"
        aname = t.get("category_account_name") or "(Uncategorized)"
        acode = t.get("category_account_code") or ""
        amt = abs(float(t.get("amount") or 0.0))
        bkey = (cid_key, cname)
        cbucket = buckets.setdefault(bkey, {})
        cell = cbucket.setdefault(acat, {
            "category_account_id": None if acat == "__uncategorized__" else acat,
            "category_code": acode, "category_name": aname,
            "count": 0, "min_amount": None, "max_amount": None, "total_amount": 0.0,
        })
        cell["count"] += 1
        cell["total_amount"] += amt
        cell["min_amount"] = amt if cell["min_amount"] is None else min(cell["min_amount"], amt)
        cell["max_amount"] = amt if cell["max_amount"] is None else max(cell["max_amount"], amt)

    contacts: list[dict] = []
    for (cid_key, cname), cats in buckets.items():
        cat_list = sorted(cats.values(), key=lambda c: (-c["count"], c["category_name"].lower()))
        for c in cat_list:
            c["min_amount"] = round(c["min_amount"] or 0.0, 2)
            c["max_amount"] = round(c["max_amount"] or 0.0, 2)
            c["total_amount"] = round(c["total_amount"], 2)
        contacts.append({
            "contact_id": None if cid_key == "__no_contact__" else cid_key,
            "contact_name": cname,
            "total_count": sum(c["count"] for c in cat_list),
            "categories": cat_list,
        })
    contacts.sort(key=lambda c: c["contact_name"].lower())

    return {"contacts": contacts}


@router.get("/companies/{cid}/transactions")
async def list_transactions(
    cid: str, user: dict = Depends(get_current_user),
    needs_review: Optional[bool] = None,
    status: Optional[str] = None,  # "ai" | "uncategorized" | "unapproved" | "reviewed"
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
    # Status buckets — mutually exclusive tabs on the Transactions UI. Each
    # segment answers a different bookkeeper question:
    #   ai            → auto-posted by the LLM, no human sign-off yet.
    #                   (posted=True + human_reviewed≠True + a real category)
    #   uncategorized → sitting in the fallback 9999/4999 accounts (or none).
    #   unapproved    → catch-all: anything the human hasn't reviewed yet.
    #   reviewed      → human_reviewed=True (the "done" bucket).
    if status == "ai":
        query["human_reviewed"] = {"$ne": True}
        query["posted"] = True
        # exclude the two Uncategorized sink accounts (populated by seed).
        query["category_account_code"] = {"$nin": ["9999", "4999"]}
    elif status == "uncategorized":
        # Wrap in a named clause so an $or search filter below can co-exist.
        query.setdefault("$and", []).append({"$or": [
            {"category_account_id": None},
            {"category_account_id": {"$exists": False}},
            {"category_account_code": {"$in": ["9999", "4999"]}},
        ]})
    elif status == "unapproved":
        query["human_reviewed"] = {"$ne": True}
    elif status == "reviewed":
        query["human_reviewed"] = True
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
        search_or = [
            {"merchant":     {"$regex": pattern, "$options": "i"}},
            {"description":  {"$regex": pattern, "$options": "i"}},
            {"contact_name": {"$regex": pattern, "$options": "i"}},
        ]
        # Nest under $and if another $or clause is already present (e.g. from
        # the uncategorized status filter).
        if "$or" in query or "$and" in query:
            query.setdefault("$and", []).append({"$or": search_or})
        else:
            query["$or"] = search_or
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


class MarkTransferIn(BaseModel):
    matching_leg_id: Optional[str] = None  # if present, also recategorize this row
    account_name: str = "Inter-Account Transfer"


@router.post("/companies/{cid}/transactions/{tid}/mark-as-transfer")
async def mark_as_transfer(cid: str, tid: str, inp: MarkTransferIn = MarkTransferIn(), user: dict = Depends(get_current_user)):
    """Bookkeeper-grade "internal transfer" fix. In one call:
      1. Idempotently ensure an equity account named `Inter-Account Transfer`
         (or caller-provided name) exists — this account is the sink both
         legs of a real inter-account transfer point at, so neither leg
         appears on the P&L.
      2. Reclassify the focused transaction to that account.
      3. If a matching leg id was passed, reclassify that too.
      4. Return the transfer account + any candidate matching legs the UI
         didn't already know about (opposite-sign, same-amount, ±3 days,
         on a *different* bank account, not already categorized as transfer).
    """
    await require_company(user, cid)
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found")
    await assert_open(cid, txn.get("date"))

    # 1. Ensure the Transfer equity account.
    name_norm = re.sub(r"\s+", " ", inp.account_name.strip()).lower()
    xfer = None
    for a in await db.accounts.find({"company_id": cid, "type": "equity"}).to_list(500):
        if re.sub(r"\s+", " ", a.get("name", "").strip()).lower() == name_norm:
            xfer = a
            break
    if not xfer:
        # Pick a free code in the equity range.
        used = {a["code"] for a in await db.accounts.find(
            {"company_id": cid, "code": {"$exists": True}}
        ).to_list(2000)}
        code = None
        for n in range(3200, 3999, 10):
            if str(n) not in used:
                code = str(n); break
        code = code or "3900"
        now = now_iso()
        xfer = {
            "id": str(uuid.uuid4()), "company_id": cid, "code": code,
            "name": inp.account_name.strip(), "type": "equity",
            "subtype": "transfer", "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now, "source": "ai_transfer_fix",
        }
        await db.accounts.insert_one(xfer)

    # 2. Reclassify the focused txn.
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {
            "category_account_id": xfer["id"],
            "category_account_code": xfer["code"],
            "category_account_name": xfer["name"],
            "needs_review": False,
            "posted": True,
            "updated_at": now_iso(),
        }},
    )

    # 3. Also reclassify the caller-specified matching leg, if any.
    matched_id = None
    if inp.matching_leg_id:
        m = await db.transactions.find_one({"id": inp.matching_leg_id, "company_id": cid})
        if m and not await is_period_closed(cid, m.get("date")):
            await db.transactions.update_one(
                {"id": m["id"], "company_id": cid},
                {"$set": {
                    "category_account_id": xfer["id"],
                    "category_account_code": xfer["code"],
                    "category_account_name": xfer["name"],
                    "needs_review": False,
                    "posted": True,
                    "updated_at": now_iso(),
                }},
            )
            matched_id = m["id"]

    # 4. Suggest a matching leg — opposite-sign, same-abs-amount, ±3 days,
    #    different bank account, not already sitting in the transfer account.
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    amt = float(txn.get("amount") or 0.0)
    date = txn.get("date") or ""
    candidates: list[dict] = []
    if amt and date:
        # Compute the ±3 day window.
        try:
            d = datetime.strptime(date, "%Y-%m-%d")
            lo_d = (d - timedelta(days=3)).strftime("%Y-%m-%d")
            hi_d = (d + timedelta(days=3)).strftime("%Y-%m-%d")
        except Exception:
            lo_d, hi_d = date, date
        docs = await db.transactions.find({
            "company_id": cid,
            "date": {"$gte": lo_d, "$lte": hi_d},
            "amount": round(-amt, 2),
            "bank_account_id": {"$ne": txn.get("bank_account_id")},
            "category_account_id": {"$ne": xfer["id"]},
            "id": {"$ne": tid},
        }).limit(5).to_list(5)
        for c in docs:
            if matched_id and c["id"] == matched_id:
                continue
            candidates.append({
                "id": c["id"], "date": c.get("date"),
                "merchant": c.get("merchant") or c.get("description"),
                "amount": c.get("amount"),
                "bank_account_name": c.get("bank_account_name"),
                "current_category": c.get("category_account_name"),
            })

    return {
        "ok": True,
        "transfer_account": {
            "id": xfer["id"], "code": xfer["code"], "name": xfer["name"],
        },
        "matched_leg_id": matched_id,
        "candidates": candidates,
    }


@router.post("/companies/{cid}/transactions/{tid}/approve-with-suggestion")
async def approve_with_suggestion(cid: str, tid: str, user: dict = Depends(get_current_user)):
    """Approve a single transaction, then return a suggestion payload the UI
    can use to offer bulk-approval of every OTHER unapproved transaction with
    the same contact — plus offer to create a merchant/contact rule.

    Response shape:
        {
          "ok": true,
          "approved": {"id", "contact_id", "contact_name", "category_account_id",
                       "category_account_code", "category_account_name"},
          "similar": {
            "contact_id", "contact_name",
            "category_account_id", "category_account_code", "category_account_name",
            "count", "sample": [{"id","date","merchant","amount","category_account_id","category_account_name"}, ...]
          } | null,
          "rule_exists": bool,
        }
    Only returns `similar` when the source txn has a contact + category AND at
    least one other unapproved transaction exists for that contact.
    """
    await require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not existing:
        raise HTTPException(404, "Transaction not found")
    await assert_open(cid, existing.get("date"))
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {"human_reviewed": True, "needs_review": False, "posted": True, "updated_at": now_iso()}},
    )
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    approved_info = {
        "id": txn["id"],
        "contact_id": txn.get("contact_id"),
        "contact_name": txn.get("contact_name"),
        "category_account_id": txn.get("category_account_id"),
        "category_account_code": txn.get("category_account_code"),
        "category_account_name": txn.get("category_account_name"),
    }

    similar = None
    rule_exists = False
    contact_id = txn.get("contact_id")
    category_id = txn.get("category_account_id")
    contact_name = txn.get("contact_name")
    if contact_id and category_id:
        # Find every other transaction for this contact that hasn't been
        # human-reviewed yet. Excludes the one we just approved and anything
        # in a closed period (we can't safely bulk-update those).
        candidates_q = {
            "company_id": cid,
            "contact_id": contact_id,
            "human_reviewed": {"$ne": True},
            "id": {"$ne": tid},
        }
        candidates = await db.transactions.find(candidates_q).sort([("date", -1), ("_id", -1)]).to_list(500)
        # Filter out any in a closed period — bulk approval shouldn't silently
        # skip them; the UI will show only the actionable count.
        actionable: list[dict] = []
        for c in candidates:
            if await is_period_closed(cid, c.get("date")):
                continue
            actionable.append(c)
        if actionable:
            similar = {
                "contact_id": contact_id,
                "contact_name": contact_name,
                "category_account_id": category_id,
                "category_account_code": txn.get("category_account_code"),
                "category_account_name": txn.get("category_account_name"),
                "count": len(actionable),
                "sample": [
                    {
                        "id": c["id"], "date": c.get("date"),
                        "merchant": c.get("merchant"), "amount": c.get("amount"),
                        "category_account_id": c.get("category_account_id"),
                        "category_account_name": c.get("category_account_name"),
                    }
                    for c in actionable[:5]
                ],
            }
        # Detect if a rule for this contact already exists so the client
        # doesn't create a duplicate.
        rule_exists = bool(await db.rules.find_one({
            "company_id": cid,
            "match_type": "contact_id",
            "match_value": contact_id,
        }))

    return {"ok": True, "approved": approved_info, "similar": similar, "rule_exists": rule_exists}


class BulkApproveRuleIn(BaseModel):
    txn_ids: list[str]
    category_account_id: str
    contact_id: Optional[str] = None
    contact_name: Optional[str] = None
    create_rule: bool = True


@router.post("/companies/{cid}/transactions/apply-bulk-approve-rule")
async def apply_bulk_approve_rule(cid: str, inp: BulkApproveRuleIn, user: dict = Depends(get_current_user)):
    """Bulk-set every listed transaction to `category_account_id` + approve
    them (`human_reviewed=True, posted=True, needs_review=False`), and
    optionally create a Rule so future imports match the same contact →
    category mapping automatically. Skips anything already approved to
    honor the promise: 'don't change approved transaction categories'.
    """
    await require_company(user, cid)
    if not inp.txn_ids:
        return {"ok": True, "updated": 0, "rule_id": None}

    acct = await db.accounts.find_one({"id": inp.category_account_id, "company_id": cid})
    if not acct:
        raise HTTPException(404, "Category account not found")

    # Only touch not-yet-approved rows, and only rows that live in an open
    # period. The client already filtered, but re-check server-side.
    docs = await db.transactions.find({
        "id": {"$in": inp.txn_ids},
        "company_id": cid,
        "human_reviewed": {"$ne": True},
    }).to_list(2000)

    actionable_ids: list[str] = []
    for d in docs:
        if await is_period_closed(cid, d.get("date")):
            continue
        actionable_ids.append(d["id"])

    updated = 0
    if actionable_ids:
        res = await db.transactions.update_many(
            {"id": {"$in": actionable_ids}, "company_id": cid},
            {"$set": {
                "category_account_id": acct["id"],
                "category_account_code": acct["code"],
                "category_account_name": acct["name"],
                "human_reviewed": True,
                "posted": True,
                "needs_review": False,
                "ai_confidence": 1.0,
                "updated_at": now_iso(),
            }},
        )
        updated = res.modified_count
        await log_ai(cid, "bulk_approve_rule", updated)

    rule_id = None
    if inp.create_rule and inp.contact_id:
        existing = await db.rules.find_one({
            "company_id": cid,
            "match_type": "contact_id",
            "match_value": inp.contact_id,
        })
        if not existing:
            rule = {
                "id": str(uuid.uuid4()),
                "company_id": cid,
                "match_type": "contact_id",
                "match_value": inp.contact_id,
                "contact_name": inp.contact_name or "",
                "account_code": acct["code"],
                "account_name": acct["name"],
                "category_account_id": acct["id"],
                "source": "user_bulk_approve",
                "created_at": now_iso(),
            }
            await db.rules.insert_one(rule)
            rule_id = rule["id"]

    return {"ok": True, "updated": updated, "rule_id": rule_id}


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


