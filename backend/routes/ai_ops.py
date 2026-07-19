"""Axiom Ledger — AI: categorize / recategorize / activity routes.

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
    parse_voice_intent, cpa_review,
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


# ----------------------- AI: categorize / recategorize / activity -----------------------

@router.post("/companies/{cid}/ai/recategorize/{tid}")
async def ai_recategorize(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found")
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    result = await categorize_transaction(
        txn.get("merchant", ""), float(txn.get("amount", 0)), txn.get("description", ""), coa,
    )
    match = next((a for a in accts if a["code"] == result["account_code"]), None)
    upd = {
        "ai_confidence": round(result["confidence"], 2),
        "ai_reasoning": result["reasoning"],
        "needs_review": result["confidence"] < 0.80,
        "posted": result["confidence"] >= 0.80,
        "updated_at": now_iso(),
    }
    if match:
        upd["category_account_id"] = match["id"]
        upd["category_account_code"] = match["code"]
        upd["category_account_name"] = match["name"]
    await db.transactions.update_one({"id": tid, "company_id": cid}, {"$set": upd})
    await log_ai(cid, "categorize", 1)
    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    return {"transaction": coerce(doc)}

class CpaReviewIn(BaseModel):
    message: str
    contact_name: str
    contact_id: Optional[str] = None
    txn_ids: Optional[List[str]] = None


@router.post("/companies/{cid}/ai/cpa-review")
async def ai_cpa_review(cid: str, inp: CpaReviewIn, user: dict = Depends(get_current_user)):
    """LLM-backed CPA gate for cleanup-inquiry answers. Given a user's raw text
    plus the vendor being cleaned up, classifies intent (categorize /
    approve_existing / redirect / skip / question / unclear) and resolves
    categorize answers to real Chart-of-Accounts rows (existing or GAAP-safe
    new). Prevents the client-side regex parser from creating garbage accounts
    like 'they look good the way they are'.
    """
    await require_company(user, cid)

    accts = await db.accounts.find({"company_id": cid, "active": {"$ne": False}}).to_list(500)
    accts_payload = [{
        "id": a.get("id"), "code": a.get("code"), "name": a.get("name"),
        "type": a.get("type"), "subtype": a.get("subtype"),
    } for a in accts]

    txn_sample: List[dict] = []
    current_categories: List[dict] = []
    sample: List[dict] = []
    if inp.txn_ids:
        sample = await db.transactions.find({"id": {"$in": inp.txn_ids[:50]}, "company_id": cid}).to_list(50)
    elif inp.contact_id:
        sample = await db.transactions.find({
            "company_id": cid, "contact_id": inp.contact_id,
            "human_reviewed": {"$ne": True},
        }).limit(50).to_list(50)

    if sample:
        txn_sample = [{
            "amount": t.get("amount"), "date": t.get("date"),
            "description": t.get("description") or t.get("merchant") or "",
        } for t in sample[:5]]
        _cat_agg: dict[str, dict] = {}
        for t in sample:
            code = t.get("category_account_code") or ""
            name = t.get("category_account_name") or "Uncategorized"
            k = f"{code}|{name}"
            if k not in _cat_agg:
                _cat_agg[k] = {"code": code, "name": name, "count": 0}
            _cat_agg[k]["count"] += 1
        current_categories = sorted(_cat_agg.values(), key=lambda x: -x["count"])[:10]

    result = await cpa_review(
        user_message=inp.message,
        contact_name=inp.contact_name,
        contact_id=inp.contact_id,
        accounts=accts_payload,
        txn_sample=txn_sample,
        current_categories=current_categories,
    )
    return result




@router.get("/companies/{cid}/ai/activity")
async def ai_activity(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    cache = get_cache()
    key = cache.key("ai_activity", company_id=cid)

    async def compute():
        docs = await db.ai_activity.find({"company_id": cid}).to_list(100)
        total_txns = await db.transactions.count_documents({"company_id": cid})
        posted = await db.transactions.count_documents({"company_id": cid, "posted": True})
        flagged = await db.transactions.count_documents({"company_id": cid, "needs_review": True})
        rules_count = await db.rules.count_documents({"company_id": cid})
        ai_rules = await db.rules.count_documents({"company_id": cid, "created_by": "ai"})
        veryfi_docs = await db.veryfi_uploads.count_documents({"company_id": cid})
        # Synthesize activity rows from live truth so the Dashboard widget
        # always mirrors the current DB state. `db.ai_activity` remains the
        # source for kinds that aren't derivable from `transactions` (e.g.
        # `coa_generated`, `webhook_sync`), but for `categorize` / `post_je` /
        # `flag_review` / `rule_created` / `veryfi_ocr` we prefer the live
        # count — this backfills existing customers who imported txns before
        # the sync pipeline started emitting per-event counters. Kinds with
        # a truth-derived count of 0 are omitted so the widget stays clean.
        derived = {
            "categorize":   total_txns,
            "post_je":      posted,
            "flag_review":  flagged,
            "rule_created": rules_count,
            "veryfi_ocr":   veryfi_docs,
        }
        by_kind = {d.get("type"): coerce(d) for d in docs}
        activity: list[dict] = []
        for kind, count in derived.items():
            if count <= 0:
                continue
            row = by_kind.pop(kind, None) or {
                "id": None, "company_id": cid, "type": kind,
                "created_at": now_iso(), "updated_at": now_iso(),
            }
            row["count"] = count
            activity.append(row)
        # Preserve any remaining (non-derived) kinds already logged
        # (`coa_generated`, `webhook_sync`, …).
        for row in by_kind.values():
            if (row.get("count") or 0) > 0:
                activity.append(row)
        return {
            "activity": activity,
            "totals": {
                "transactions": total_txns, "posted": posted, "flagged": flagged,
                "rules": rules_count, "ai_rules": ai_rules,
                "accuracy": round((posted / max(total_txns, 1)) * 100, 1),
            },
        }
    return await cache.get_or_compute(key, DASH_CACHE_TTL, compute)


@router.get("/companies/{cid}/dashboard/metrics")
async def dashboard_metrics(cid: str, user: dict = Depends(get_current_user)):
    """Cash-on-hand, outstanding A/R and A/P, and last-30-days cash activity."""
    await require_company(user, cid)
    cache = get_cache()
    # Include today's date in the cache key so a midnight rollover invalidates
    # naturally without hitting the TTL wait.
    today = datetime.now(timezone.utc).date()
    key = cache.key("dash_metrics", company_id=cid, day=today.isoformat())

    async def compute():
        thirty_ago = (today - timedelta(days=30)).isoformat()
        today_str = today.isoformat()

        # Cash-on-hand: sum of postings against Cash / Bank accounts (asset,
        # subtype current_asset, codes starting with '10'). Both transactions
        # AND journal-entry lines contribute — otherwise the opening-balance
        # JE (posted at Plaid connect) is silently excluded and cash-on-hand
        # undercounts by the opening amount.
        # Cash on hand: sum of BOTH raw txn postings AND JE lines against every
        # cash/bank-flavored asset account. Range covers:
        #   1000 Cash and Bank (legacy default)
        #   1010 Business Checking / 1020 Savings / 1030 Money Market / 1040 CD /
        #     1050 PayPal (legacy shared subtype rows)
        #   1011+ Bank of America Checking ···6084 (new-style per-account rows
        #     created by `statement_account_resolver`)
        #   1090 Other Bank Account, 1100 Undeposited Funds
        # A/R (1200), Inventory (1300), Prepaid (1500), Fixed (1600+) are
        # explicitly excluded — those aren't cash even though they're assets.
        # Feb 17, 2026: pre-fix this list was hard-coded to
        # ["1000","1010","1020"] which excluded every account the new Plaid/
        # Veryfi resolver auto-created, so cash-on-hand collapsed to just the
        # 30-day activity that happened to still live on legacy 1010. Now we
        # match by code range so any resolver-created row is included.
        cash_accts = await db.accounts.find({
            "company_id": cid, "type": "asset",
            "$or": [
                {"code": {"$gte": "1000", "$lte": "1099"}},
                {"code": "1100"},  # Undeposited Funds
                {"subtype": "Bank"},  # resolver-flagged bank rows
            ],
        }).to_list(100)
        cash_ids = [a["id"] for a in cash_accts]
        cash = 0.0
        if cash_ids:
            txns = await db.transactions.find({
                "company_id": cid, "posted": True,
                "bank_account_id": {"$in": cash_ids},
            }).to_list(50000)
            cash = sum(float(t.get("amount", 0)) for t in txns)
            # Add JE lines hitting these cash accounts.
            jes = await db.journal_entries.find({"company_id": cid}).to_list(50000)
            for j in jes:
                for l in j.get("lines", []):
                    if l.get("account_id") in cash_ids:
                        cash += float(l.get("debit", 0) or 0) - float(l.get("credit", 0) or 0)

        # Outstanding A/R: unpaid invoice balance_due
        invs = await db.invoices.find({"company_id": cid}).to_list(20000)
        outstanding_ar = sum(float(i.get("balance_due", 0)) for i in invs if i.get("status") != "paid")
        overdue_ar = 0.0
        for i in invs:
            if i.get("status") == "paid":
                continue
            if i.get("due_date") and i["due_date"] < today_str:
                overdue_ar += float(i.get("balance_due", 0))

        # Outstanding A/P: unpaid bill balance_due
        bills = await db.bills.find({"company_id": cid}).to_list(20000)
        outstanding_ap = sum(float(b.get("balance_due", 0)) for b in bills if b.get("status") != "paid")
        overdue_ap = 0.0
        for b in bills:
            if b.get("status") == "paid":
                continue
            if b.get("due_date") and b["due_date"] < today_str:
                overdue_ap += float(b.get("balance_due", 0))

        # Last 30 days cash activity: money in / out through bank accounts
        recent = await db.transactions.find({
            "company_id": cid, "posted": True,
            "date": {"$gte": thirty_ago, "$lte": today_str},
            "bank_account_id": {"$in": cash_ids} if cash_ids else {"$exists": True},
        }).to_list(50000)
        cash_in = sum(float(t["amount"]) for t in recent if float(t.get("amount", 0)) > 0)
        cash_out = sum(-float(t["amount"]) for t in recent if float(t.get("amount", 0)) < 0)
        net_30d = cash_in - cash_out

        return {
            "cash_on_hand": round(cash, 2),
            "outstanding_invoices": round(outstanding_ar, 2),
            "overdue_invoices": round(overdue_ar, 2),
            "invoice_count": sum(1 for i in invs if i.get("status") != "paid"),
            "outstanding_bills": round(outstanding_ap, 2),
            "overdue_bills": round(overdue_ap, 2),
            "bill_count": sum(1 for b in bills if b.get("status") != "paid"),
            "cash_in_30d": round(cash_in, 2),
            "cash_out_30d": round(cash_out, 2),
            "net_cash_30d": round(net_30d, 2),
            "activity_count_30d": len(recent),
        }
    return await cache.get_or_compute(key, DASH_CACHE_TTL, compute)


UNRECONCILED_STALENESS_DAYS = 45


async def _compute_attention(cid: str) -> dict:
    """Compute the per-company "needs your attention" summary. Shared by
    `/dashboard/attention` (single-company) and `/pro/firm-attention`
    (firm-wide aggregate). Cheap: all counts run in parallel and rely on
    existing indexes."""
    today = datetime.now(timezone.utc).date().isoformat()
    cutoff = (datetime.now(timezone.utc).date()
              - timedelta(days=UNRECONCILED_STALENESS_DAYS)).isoformat()

    flagged_task = db.transactions.count_documents(
        {"company_id": cid, "needs_review": True}
    )
    suggested_task = db.rule_candidates.count_documents(
        {"company_id": cid, "approvals": {"$gte": 2}}
    )
    overdue_inv_task = db.invoices.count_documents({
        "company_id": cid,
        "status": {"$ne": "paid"},
        "due_date": {"$lt": today, "$ne": None},
    })
    overdue_bill_task = db.bills.count_documents({
        "company_id": cid,
        "status": {"$ne": "paid"},
        "due_date": {"$lt": today, "$ne": None},
    })
    accts_task = db.accounts.find({
        "company_id": cid, "type": {"$in": ["asset", "liability"]},
        "$or": [
            {"code": {"$gte": "1000", "$lte": "1099"}},
            {"code": {"$regex": "^21"}},
            {"subtype": "Bank"},
        ],
    }).to_list(200)

    (flagged_count, suggested_rules_count, overdue_invoices_count,
     overdue_bills_count, bank_accts) = await asyncio.gather(
        flagged_task, suggested_task, overdue_inv_task,
        overdue_bill_task, accts_task,
    )

    async def _stale(a):
        has_txn = await db.transactions.count_documents({
            "company_id": cid, "bank_account_id": a["id"], "posted": True,
        })
        if not has_txn:
            return None
        latest = await db.reconciliations.find_one(
            {"company_id": cid, "bank_account_id": a["id"]},
            sort=[("as_of", -1)],
        )
        last_as_of = latest.get("as_of") if latest else None
        if last_as_of and last_as_of >= cutoff:
            return None
        return {"id": a["id"], "code": a.get("code"), "name": a.get("name"),
                "last_as_of": last_as_of}

    stale_results = await asyncio.gather(*[_stale(a) for a in bank_accts]) if bank_accts else []
    unreconciled = [x for x in stale_results if x]

    return {
        "flagged_count": flagged_count,
        "suggested_rules_count": suggested_rules_count,
        "overdue_invoices_count": overdue_invoices_count,
        "overdue_bills_count": overdue_bills_count,
        "unreconciled_accounts_count": len(unreconciled),
        "unreconciled_accounts": unreconciled,
        "staleness_days": UNRECONCILED_STALENESS_DAYS,
    }


@router.get("/companies/{cid}/dashboard/attention")
async def dashboard_attention(cid: str, user: dict = Depends(get_current_user)):
    """Compact CPA "needs your attention" summary — single company.

    Cached per-company (day-keyed) at the same TTL as `/dashboard/metrics`.
    """
    await require_company(user, cid)
    cache = get_cache()
    key = cache.key(
        "dash_attention", company_id=cid,
        day=datetime.now(timezone.utc).date().isoformat(),
    )
    return await cache.get_or_compute(key, DASH_CACHE_TTL,
                                       lambda: _compute_attention(cid))


@router.get("/pro/firm-attention")
async def firm_attention(user: dict = Depends(require_role("pro", "superadmin"))):
    """Firm-wide roll-up for the current Pro (or all companies for superadmin).

    Returns a per-client breakdown sorted by `action_count` desc plus the
    aggregated totals across every book the Pro touches. Powers the "morning
    glance" tile on `/pro/clients`. Cached per-user for the same TTL as
    single-company dashboard metrics.
    """
    cache = get_cache()
    key = cache.key(
        "firm_attention", user_id=user["id"],
        day=datetime.now(timezone.utc).date().isoformat(),
    )

    async def compute():
        if user["role"] == "superadmin":
            companies = await db.companies.find({}).to_list(1000)
        else:
            ms = await db.memberships.find(
                {"user_id": user["id"], "role": "pro"}
            ).to_list(1000)
            cids = [m["company_id"] for m in ms]
            companies = await db.companies.find({"id": {"$in": cids}}).to_list(1000)

        per_client_summaries = await asyncio.gather(
            *[_compute_attention(c["id"]) for c in companies]
        )

        clients_out = []
        totals = {"flagged": 0, "suggested_rules": 0, "overdue_invoices": 0,
                  "overdue_bills": 0, "unreconciled": 0}
        for c, s in zip(companies, per_client_summaries):
            action = (s["flagged_count"] + s["suggested_rules_count"]
                      + s["overdue_invoices_count"] + s["overdue_bills_count"]
                      + s["unreconciled_accounts_count"])
            totals["flagged"] += s["flagged_count"]
            totals["suggested_rules"] += s["suggested_rules_count"]
            totals["overdue_invoices"] += s["overdue_invoices_count"]
            totals["overdue_bills"] += s["overdue_bills_count"]
            totals["unreconciled"] += s["unreconciled_accounts_count"]
            clients_out.append({
                "id": c["id"], "name": c["name"],
                "business_type": c.get("business_type", ""),
                "flagged_count": s["flagged_count"],
                "suggested_rules_count": s["suggested_rules_count"],
                "overdue_invoices_count": s["overdue_invoices_count"],
                "overdue_bills_count": s["overdue_bills_count"],
                "unreconciled_accounts_count": s["unreconciled_accounts_count"],
                "action_count": action,
            })
        clients_out.sort(key=lambda x: x["action_count"], reverse=True)
        clients_needing_action = sum(1 for c in clients_out if c["action_count"] > 0)
        return {
            "clients_total": len(clients_out),
            "clients_needing_action": clients_needing_action,
            "totals": totals,
            "clients": clients_out,
        }

    return await cache.get_or_compute(key, DASH_CACHE_TTL, compute)


