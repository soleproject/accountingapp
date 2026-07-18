"""Axiom Ledger — Plaid webhook routes.

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


# ----------------------- Plaid webhook -----------------------

@router.post("/plaid/webhook")
async def plaid_webhook(payload: dict):
    """Receive Plaid webhook events (TRANSACTIONS: SYNC_UPDATES_AVAILABLE, DEFAULT_UPDATE, etc.).

    Public endpoint (no auth) — Plaid signs with JWT via `Plaid-Verification` header in production;
    for MVP we accept, look up the item_id, and trigger a background sync.
    """
    webhook_type = payload.get("webhook_type", "")
    webhook_code = payload.get("webhook_code", "")
    item_id = payload.get("item_id")
    if webhook_type != "TRANSACTIONS" or not item_id:
        return {"ok": True, "ignored": True}
    item = await db.plaid_items.find_one({"item_id": item_id})
    if not item:
        return {"ok": True, "unknown_item": True}
    if webhook_code in ("SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"):
        # Enqueue instead of running inline so:
        #   1) Plaid always gets a fast 200 (avoids retry storms + duplicate imports)
        #   2) the sync creates a sync_jobs record with progress emissions —
        #      which is what the Dashboard Sync-Pill listens to; without it the
        #      pill stays "idle" while a 1,700-txn HISTORICAL_UPDATE lands and
        #      the user sees stale tiles.
        # Dedupe: Plaid frequently fires DEFAULT_UPDATE + HISTORICAL_UPDATE
        # 50–200ms apart on first connect. Without this guard we'd run TWO
        # parallel workers on the same 1,700-row backfill — both burn LLM
        # credits categorizing identical rows even though the plaid_txn_id
        # dedup keeps the DB clean. Skip if a sync is already in flight.
        existing = await db.sync_jobs.find_one({
            "company_id": item["company_id"],
            "kind": "plaid_manual_sync",
            "status": {"$in": ["queued", "running"]},
        })
        if existing:
            return {"ok": True, "queued_job": existing["id"],
                    "webhook_code": webhook_code, "dedup": True}
        from job_queue import enqueue_job
        job_id = await enqueue_job(
            "plaid_manual_sync", item["company_id"], user_id=None,
        )
        return {"ok": True, "queued_job": job_id, "webhook_code": webhook_code}
    if webhook_code == "TRANSACTIONS_REMOVED":
        removed_ids = payload.get("removed_transactions") or []
        for tid in removed_ids:
            await db.transactions.delete_one({
                "company_id": item["company_id"], "plaid_transaction_id": tid,
            })
        return {"ok": True, "removed": len(removed_ids)}
    return {"ok": True, "webhook_code": webhook_code}


@router.post("/companies/{cid}/plaid/reset-and-resync")
async def plaid_reset_and_resync(cid: str, user: dict = Depends(get_current_user)):
    """Enqueue a full-history re-pull. Returns immediately with a job_id so the
    HTTP request never exceeds the ingress timeout. Poll `GET /jobs/{job_id}`
    for progress. Idempotent — dedupes on `(company_id, plaid_transaction_id)`.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No Plaid item linked for this company")
    from job_queue import enqueue_job
    job_id = await enqueue_job(
        "plaid_reset_resync", cid, user_id=user["id"],
    )
    return {"job_id": job_id, "status": "queued"}


@router.post("/companies/{cid}/plaid/manual-sync")
async def plaid_manual_sync(cid: str, user: dict = Depends(get_current_user)):
    """Enqueue a cursor-based delta sync. Returns immediately with job_id."""
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No Plaid item linked for this company")
    from job_queue import enqueue_job
    job_id = await enqueue_job(
        "plaid_manual_sync", cid, user_id=user["id"],
    )
    return {"job_id": job_id, "status": "queued"}


@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str, user: dict = Depends(get_current_user)):
    """Return the current status of an async job. Accountants can see progress
    of the manual-sync / reset-and-resync they kicked off. Company access is
    enforced so a user can't peek at another tenant's job."""
    from job_queue import get_job
    doc = await get_job(job_id)
    if not doc:
        raise HTTPException(404, "Job not found")
    await require_company(user, doc["company_id"])
    return doc


@router.get("/companies/{cid}/plaid/sync-jobs")
async def list_sync_jobs(cid: str, limit: int = 10,
                         user: dict = Depends(get_current_user)):
    """Return the most recent N sync jobs for this company — used by the
    Connections page's Sync History panel. Each row: kind, status,
    started_at, finished_at, duration_ms, imported, error, triggered_by_email.
    """
    await require_company(user, cid)
    limit = max(1, min(int(limit), 50))
    docs = await db.sync_jobs.find({"company_id": cid}).sort(
        "created_at", -1,
    ).limit(limit).to_list(limit)

    # Resolve `triggered_by` email once per job.
    user_ids = list({d.get("user_id") for d in docs if d.get("user_id")})
    users = {}
    if user_ids:
        async for u in db.users.find({"id": {"$in": user_ids}}, {"id": 1, "email": 1, "name": 1}):
            users[u["id"]] = u

    rows = []
    for d in docs:
        d.pop("_id", None)
        s, f = d.get("started_at"), d.get("finished_at")
        duration_ms = None
        if s and f:
            try:
                from datetime import datetime
                duration_ms = int(
                    (datetime.fromisoformat(f) - datetime.fromisoformat(s))
                    .total_seconds() * 1000
                )
            except Exception:  # noqa: BLE001
                duration_ms = None
        u = users.get(d.get("user_id"))
        rows.append({
            "id":                    d["id"],
            "kind":                  d["kind"],
            "status":                d["status"],
            "created_at":            d.get("created_at"),
            "started_at":            s,
            "finished_at":           f,
            "duration_ms":           duration_ms,
            "imported":              (d.get("result") or {}).get("imported"),
            "reset":                 (d.get("result") or {}).get("reset", False),
            "error":                 (d.get("error") or "").split("\n")[-2:-1][0] if d.get("error") else None,
            "triggered_by_email":    (u or {}).get("email"),
            "triggered_by_name":     (u or {}).get("name"),
        })
    return {"count": len(rows), "jobs": rows}


@router.get("/companies/{cid}/sync-status")
async def sync_status(cid: str, user: dict = Depends(get_current_user)):
    """Cheap poll endpoint (~2 Mongo lookups) for the Dashboard Sync Pill.

    Returns just enough state for the pill to decide idle vs. syncing vs.
    complete, plus the numbers to render `Importing 1,543 of ~1,900 · 82%`.
    Safe to poll every 5s per tab at 3k+ users because each call is a single
    indexed find_one + one count_documents.
    """
    await require_company(user, cid)
    # Most-recent in-flight job (queued or running) — deterministic ordering.
    active = await db.sync_jobs.find_one(
        {"company_id": cid, "status": {"$in": ["queued", "running"]}},
        sort=[("created_at", -1)],
    )
    # Most-recent completed job (any kind), for `last_sync_at` display.
    last = await db.sync_jobs.find_one(
        {"company_id": cid, "status": {"$in": ["completed", "failed"]}},
        sort=[("finished_at", -1)],
    )
    total_txns = await db.transactions.count_documents({"company_id": cid})

    if active:
        prog = active.get("progress") or {}
        imported = int(prog.get("current") or 0)
        target = prog.get("total")   # None if unknown yet
        pct = None
        if target and int(target) > 0:
            pct = round((imported / int(target)) * 100, 1)
        return {
            "status":       "syncing",
            "kind":         active.get("kind"),
            "job_id":       active.get("id"),
            "started_at":   active.get("started_at") or active.get("created_at"),
            "imported":     imported,
            "target":       int(target) if target else None,
            "percent":      pct,
            "stage":        prog.get("stage"),
            "total_txns":   total_txns,
            "last_sync_at": (last or {}).get("finished_at"),
        }

    return {
        "status":       "idle",
        "total_txns":   total_txns,
        "last_sync_at": (last or {}).get("finished_at"),
        "last_kind":    (last or {}).get("kind"),
        "last_status":  (last or {}).get("status"),
    }


@router.get("/companies/{cid}/plaid/accounts")
async def plaid_list_accounts(cid: str, user: dict = Depends(get_current_user)):
    """List every Plaid-linked account for this company along with its connection
    status. An account is *connected* if it has been mapped to a ledger account
    (via /plaid/connect-account) OR has at least one transaction in the ledger.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        return {"connected": [], "available": [], "linked": False}

    accts = item.get("accounts") or []
    mappings = item.get("account_mappings") or {}
    plaid_account_ids = [a["account_id"] for a in accts if a.get("account_id")]
    # Aggregate ledger-side counts for each Plaid account_id
    counts: dict[str, dict] = {}
    if plaid_account_ids:
        cur = db.transactions.aggregate([
            {"$match": {"company_id": cid, "plaid_account_id": {"$in": plaid_account_ids}}},
            {"$group": {"_id": "$plaid_account_id", "count": {"$sum": 1},
                        "last": {"$max": "$date"}}},
        ])
        counts = {row["_id"]: row async for row in cur}

    connected, available = [], []
    for a in accts:
        aid = a.get("account_id")
        row = {
            "account_id": aid,
            "name": a.get("name") or a.get("official_name") or "Account",
            "official_name": a.get("official_name"),
            "type": a.get("type"),
            "subtype": a.get("subtype"),
            "mask": a.get("mask"),
            "balance_current": a.get("balance_current"),
            "currency": a.get("currency", "USD"),
        }
        mapping = mappings.get(aid)
        c = counts.get(aid)
        if mapping or c:
            row.update({
                "transaction_count": (c or {}).get("count", 0),
                "last_transaction_date": (c or {}).get("last"),
                "ledger_account_id": (mapping or {}).get("ledger_account_id"),
                "ledger_account_code": (mapping or {}).get("ledger_account_code"),
                "ledger_account_name": (mapping or {}).get("ledger_account_name"),
                "opening_balance": (mapping or {}).get("opening_balance"),
                "opening_as_of": (mapping or {}).get("opening_as_of"),
            })
            connected.append(row)
        else:
            # Preview which ledger account this would map to when connected
            code, name, _t, _st = plaid_connect.resolve_ledger_for_plaid(a)
            row["suggested_ledger_code"] = code
            row["suggested_ledger_name"] = name
            available.append(row)

    # ---- Per-item coverage summary (proof of import completeness) ----
    # Cheapest single-pass aggregate: earliest date, latest date, total count,
    # unique-day count, and PFC-source breakdown across all connected accounts.
    coverage = None
    if plaid_account_ids:
        cur = db.transactions.aggregate([
            {"$match": {"company_id": cid,
                        "plaid_account_id": {"$in": plaid_account_ids}}},
            {"$group": {
                "_id": None,
                "count":         {"$sum": 1},
                "first_date":    {"$min": "$date"},
                "last_date":     {"$max": "$date"},
                "unique_dates":  {"$addToSet": "$date"},
                "pfc_primary":   {"$sum": {"$cond": [
                    {"$eq": ["$ai_source", "pfc_primary"]}, 1, 0]}},
                "pfc_override":  {"$sum": {"$cond": [
                    {"$eq": ["$ai_source", "pfc_override"]}, 1, 0]}},
                "ai":            {"$sum": {"$cond": [
                    {"$eq": ["$ai_source", "ai"]}, 1, 0]}},
                "uncategorized": {"$sum": {"$cond": [
                    {"$eq": ["$ai_source", "uncategorized"]}, 1, 0]}},
                "needs_review":  {"$sum": {"$cond": ["$needs_review", 1, 0]}},
            }},
        ])
        rows = [r async for r in cur]
        if rows:
            r = rows[0]
            coverage = {
                "total_txns":     r["count"],
                "first_date":     r["first_date"],
                "last_date":      r["last_date"],
                "unique_days":    len(r["unique_dates"]),
                "pfc_deterministic": r["pfc_primary"] + r["pfc_override"],
                "ai_fallback":    r["ai"],
                "uncategorized":  r["uncategorized"],
                "needs_review":   r["needs_review"],
            }

    return {
        "linked": True,
        "item_id": item.get("item_id"),
        "connected": connected,
        "available": available,
        "coverage": coverage,
        # When Plaid last shipped us a balance snapshot (free, bundled with
        # each /transactions/sync call — no /accounts/balance/get charges).
        "balance_snapshot_at": item.get("balance_snapshot_at"),
    }


@router.post("/companies/{cid}/onboarding/mock-plaid")
async def mock_plaid(cid: str, user: dict = Depends(get_current_user)):
    return {"accounts": [
        {"id": "plaid_1", "name": "Business Checking ...4821", "type": "depository",
         "subtype": "checking", "balance": 18452.30, "institution": "Chase Business"},
        {"id": "plaid_2", "name": "Business Savings ...9911", "type": "depository",
         "subtype": "savings", "balance": 42000.00, "institution": "Chase Business"},
        {"id": "plaid_3", "name": "Business Credit Card ...5533", "type": "credit",
         "subtype": "credit card", "balance": -3410.29, "institution": "Amex"},
    ]}


@router.post("/companies/{cid}/onboarding/import-plaid")
async def import_plaid(cid: str, account_ids: List[str], user: dict = Depends(get_current_user)):
    """Import mocked transactions from selected Plaid accounts, AI-categorize each."""
    await require_company(user, cid)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    if not checking:
        raise HTTPException(400, "Business Checking account not found")
    now = now_iso()
    imported = 0
    from liability_subaccounts import maybe_route_to_liability_subaccount
    accts_by_id = {a["id"]: a for a in accts}
    today = datetime.now(timezone.utc)
    from seed import SAMPLE_MERCHANTS
    running = 15000.00
    for _ in range(25):
        merchant, code, amount, conf = random.choice(SAMPLE_MERCHANTS)
        d = (today - timedelta(days=random.randint(0, 45))).date().isoformat()
        # Ask AI to categorize
        result = await categorize_transaction(merchant, amount, merchant, coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        running += amount
        post = {
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
        }
        # Fan out to per-payee liability sub-account if this landed on a
        # generic parent bucket (Credit Card Payable / Loans Payable / …).
        post = await maybe_route_to_liability_subaccount(
            cid, post, merchant=merchant, contact_name=None, accts_by_id=accts_by_id,
        )
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": d,
            "description": merchant, "merchant": merchant, "amount": round(amount, 2),
            "bank_account_id": checking["id"], "bank_account_name": checking["name"],
            "category_account_id": post["category_account_id"],
            "category_account_code": post["category_account_code"],
            "category_account_name": post["category_account_name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "plaid_mock",
            "bank_balance_after": round(running, 2),
            "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
            "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        # Refresh accts_by_id so subsequent iterations see newly-created children.
        if post["category_account_id"] not in accts_by_id:
            new_acct = await db.accounts.find_one({"id": post["category_account_id"]})
            if new_acct:
                accts_by_id[new_acct["id"]] = new_acct
                accts.append(new_acct)
        imported += 1
    await log_ai(cid, "categorize", imported)
    return {"imported": imported}


@router.post("/companies/{cid}/onboarding/veryfi/upload")
async def veryfi_upload(cid: str, file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Upload a bank/credit-card statement to Veryfi, OCR it, AI-categorize each line."""
    await require_company(user, cid)
    file_bytes = await file.read()
    if len(file_bytes) > 20 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 20MB)")
    try:
        veryfi_data = await veryfi_service.process_bank_statement(
            file_bytes, file.filename or "statement.pdf",
            file.content_type or "application/pdf",
        )
    except Exception as e:
        raise HTTPException(502, f"Veryfi error: {e}")

    lines = veryfi_service.extract_transactions(veryfi_data)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    if not checking:
        raise HTTPException(400, "Business Checking (1010) account not found")

    higher_ranges = await plaid_connect.higher_source_ranges(cid, checking["id"], "veryfi")

    candidates: list[dict] = []
    skipped = 0
    for ln in lines:
        ln_date = ln["date"] or datetime.now(timezone.utc).date().isoformat()
        if plaid_connect.in_any_range(ln_date, higher_ranges):
            skipped += 1
            continue
        candidates.append({
            "date": ln_date,
            "description": f"{ln['description']} (Veryfi)",
            "merchant": ln["merchant"],
            "merchant_name": ln["merchant"],  # Veryfi's vendor name is trusted
            "amount": ln["amount"],
            "bank_account_id": checking["id"],
            "bank_account_name": checking["name"],
        })
    imported = await categorize_and_insert(cid, candidates, accts, coa, source="veryfi")
    await log_ai(cid, "veryfi_ocr", imported)
    return {"imported": imported, "skipped_duplicates": skipped, "veryfi_document_id": veryfi_data.get("id")}


@router.post("/companies/{cid}/onboarding/mock-veryfi")
async def mock_veryfi(cid: str, user: dict = Depends(get_current_user)):
    """Simulate Veryfi statement upload: returns fake OCR'd transactions."""
    await require_company(user, cid)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    now = now_iso()
    from seed import SAMPLE_MERCHANTS
    from liability_subaccounts import maybe_route_to_liability_subaccount
    accts_by_id = {a["id"]: a for a in accts}
    imported = 0
    today = datetime.now(timezone.utc)
    for _ in range(8):
        merchant, code, amount, conf = random.choice(SAMPLE_MERCHANTS)
        d = (today - timedelta(days=random.randint(30, 90))).date().isoformat()
        result = await categorize_transaction(merchant, amount, merchant, coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        post = {
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
        }
        post = await maybe_route_to_liability_subaccount(
            cid, post, merchant=merchant, contact_name=None, accts_by_id=accts_by_id,
        )
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": d,
            "description": f"{merchant} (Veryfi)", "merchant": merchant, "amount": round(amount, 2),
            "bank_account_id": checking["id"] if checking else None,
            "bank_account_name": checking["name"] if checking else "",
            "category_account_id": post["category_account_id"],
            "category_account_code": post["category_account_code"],
            "category_account_name": post["category_account_name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "veryfi_mock",
            "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
            "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        if post["category_account_id"] not in accts_by_id:
            new_acct = await db.accounts.find_one({"id": post["category_account_id"]})
            if new_acct:
                accts_by_id[new_acct["id"]] = new_acct
                accts.append(new_acct)
        imported += 1
    await log_ai(cid, "veryfi_ocr", imported)
    return {"imported": imported}


