"""Axiom Ledger — Reconciliation / Book Review / Close periods routes.

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


# ----------------------- Reconciliation / Book Review / Close periods -----------------------

# The heavy lifting for R1 (Plaid auto-clear), R2 (manual matching), and R3
# (statement fuzzy matcher) lives in `reconciliation_engine`. This module
# stays a thin HTTP shell — validate, delegate, respond.
from reconciliation_engine import (
    auto_clear_settled_plaid_txns,
    preview_recon,
    complete_recon,
    match_statement_lines,
    bootstrap_from_plaid,
)


@router.get("/companies/{cid}/reconciliations")
async def list_recs(cid: str, user: dict = Depends(get_current_user)):
    """List reconciliations enriched with computed `ledger_balance` (sum of
    the cleared txns at snapshot time) and `diff = statement - ledger`.
    Powers the RocketSuite-style history table."""
    await require_company(user, cid)
    docs = await db.reconciliations.find({"company_id": cid}).sort("as_of", -1).to_list(500)
    # Fetch account names in one hit for the join.
    all_bank_ids = list({d.get("bank_account_id") for d in docs if d.get("bank_account_id")})
    accts = {a["id"]: a for a in await db.accounts.find({
        "company_id": cid, "id": {"$in": all_bank_ids},
    }).to_list(200)} if all_bank_ids else {}
    out = []
    for d in docs:
        c = coerce(d)
        bank = accts.get(c.get("bank_account_id")) or {}
        # Prefer the "as-completed" numbers stored by complete_recon(); fall
        # back to a live sum for legacy freeform docs that never had them.
        if c.get("cleared_sum") is not None:
            ledger = float(c["cleared_sum"])
        else:
            ledger = 0.0
            if c.get("cleared_txn_ids"):
                agg = await db.transactions.aggregate([
                    {"$match": {"company_id": cid, "id": {"$in": c["cleared_txn_ids"]}}},
                    {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
                ]).to_list(1)
                if agg: ledger = round(float(agg[0]["total"]), 2)
        stmt = float(c.get("statement_balance") or 0.0)
        # Use the stored `difference` when present (matches what the pro saw
        # on the interactive scoreboard at Finish time). Otherwise best-effort
        # display as statement − ledger.
        if c.get("difference") is not None:
            diff = float(c["difference"])
        else:
            diff = round(stmt - ledger, 2)
        c["account_name"] = bank.get("name")
        c["account_last4"] = bank.get("mask") or bank.get("plaid_mask")
        c["account_code"] = bank.get("code")
        c["ledger_balance"] = ledger
        c["diff"] = diff

        # Drift auto-rebuild (Feb 2026): a "stale snapshot" is one
        # where one or more of `cleared_txn_ids` no longer exists in
        # the ledger (deleted during reprocessing or superadmin
        # cleanup). Only auto-rebuild snapshots that were created
        # from an underlying statement import — manual recons must
        # be rebuilt by the CPA. Guarded to fire ONCE per stale
        # snapshot via `auto_rebuild_attempted_at` to prevent
        # infinite rebuild loops when the drift can't be fixed.
        if c.get("statement_import_id") and c.get("cleared_txn_ids") and not c.get("auto_rebuild_attempted_at"):
            expected_ids = c["cleared_txn_ids"]
            actual = await db.transactions.count_documents(
                {"company_id": cid, "id": {"$in": expected_ids}},
            )
            drift = len(expected_ids) - actual
            if drift > 0:
                try:
                    from reconciliation_engine import (
                        create_reconciliation_from_statement_import,
                    )
                    # Free cleared markers on any surviving txns.
                    if expected_ids:
                        await db.transactions.update_many(
                            {"company_id": cid, "id": {"$in": expected_ids}},
                            {"$unset": {"cleared_at": "", "cleared_source": "",
                                          "cleared_reconciliation_id": ""},
                             "$set":   {"updated_at": now_iso()}},
                        )
                    # Delete the stale recon, rebuild fresh.
                    imp_id = c["statement_import_id"]
                    await db.reconciliations.delete_one(
                        {"id": c["id"], "company_id": cid},
                    )
                    fresh = await create_reconciliation_from_statement_import(
                        cid, imp_id,
                    )
                    if fresh:
                        # Stamp the rebuild + surface it on the response.
                        fresh_at = now_iso()
                        await db.reconciliations.update_one(
                            {"id": fresh["id"]},
                            {"$set": {
                                "auto_rebuild_attempted_at": fresh_at,
                                "auto_rebuilt_at":           fresh_at,
                                "auto_rebuilt_from_rid":     c["id"],
                                "auto_rebuilt_drift_count":  drift,
                            }},
                        )
                        # Substitute the fresh doc into the response so
                        # the CPA sees the corrected numbers immediately.
                        fresh["account_name"]   = bank.get("name")
                        fresh["account_last4"]  = bank.get("mask") or bank.get("plaid_mask")
                        fresh["account_code"]   = bank.get("code")
                        fresh["ledger_balance"] = float(fresh.get("cleared_sum") or 0.0)
                        fresh["diff"] = float(fresh.get("difference") or 0.0)
                        fresh["auto_rebuilt_at"]        = fresh_at
                        fresh["auto_rebuilt_drift_count"] = drift
                        out.append(fresh)
                        continue                                # skip normal append
                except Exception:                               # noqa: BLE001
                    # Best-effort — never fail the list if rebuild bombs.
                    # Stamp so we don't retry on every list call.
                    try:
                        await db.reconciliations.update_one(
                            {"id": c["id"], "company_id": cid},
                            {"$set": {"auto_rebuild_attempted_at": now_iso()}},
                        )
                    except Exception:
                        pass
        out.append(c)
    return {"reconciliations": out}


@router.get("/companies/{cid}/reconciliations/pending-auto-finalize")
async def recon_pending_auto_finalize(
    cid: str, user: dict = Depends(get_current_user),
):
    """Per-account status for last-month reconciliations currently in the
    5-day-settle handoff window.

    Powers the "Pending Reconciliations" card on the Cockpit. Returns one
    row per Plaid-mapped bank/CC account for the prior calendar month,
    labelled with a clear next-step state so the pro knows whether to
    wait (Plaid settle), act (manual), or move on (already done).
    """
    from calendar import monthrange
    from reconciliation_engine import PROVISIONAL_DAYS
    await require_company(user, cid)
    today = datetime.now(timezone.utc).date()
    # Prior calendar month.
    if today.month == 1:
        py, pm = today.year - 1, 12
    else:
        py, pm = today.year, today.month - 1
    last = monthrange(py, pm)[1]
    prior_start = f"{py:04d}-{pm:02d}-01"
    prior_end = f"{py:04d}-{pm:02d}-{last:02d}"
    # Threshold = prior_month_end + PROVISIONAL_DAYS. If today < threshold,
    # auto-finalize is still waiting for settle.
    eligible_at = (datetime(py, pm, last) + timedelta(days=PROVISIONAL_DAYS)).date()
    waiting = today < eligible_at
    days_left = (eligible_at - today).days if waiting else 0

    # All Plaid mappings for this company → ledger account ids.
    mapped_ledger_ids: set[str] = set()
    plaid_mapping_info: dict[str, dict] = {}  # ledger_id → {name, mask, plaid_account_id}
    async for item in db.plaid_items.find({"company_id": cid}):
        for pa_id, mp in (item.get("account_mappings") or {}).items():
            lid = mp.get("ledger_account_id")
            if not lid:
                continue
            mapped_ledger_ids.add(lid)
            plaid_mapping_info[lid] = {
                "plaid_account_id": pa_id,
                "ledger_account_name": mp.get("ledger_account_name"),
            }

    # Candidate accounts: any bank/CC account that is Plaid-mapped OR had
    # activity in the prior month. Order by needing-attention first.
    candidate_ids: set[str] = set(mapped_ledger_ids)
    async for row in db.transactions.aggregate([
        {"$match": {
            "company_id": cid, "posted": True,
            "bank_account_id": {"$exists": True, "$ne": None},
            "date": {"$gte": prior_start, "$lte": prior_end},
        }},
        {"$group": {"_id": "$bank_account_id"}},
    ]):
        candidate_ids.add(row["_id"])

    accts = {}
    async for a in db.accounts.find(
        {"company_id": cid, "id": {"$in": list(candidate_ids)}},
        {"_id": 0, "id": 1, "code": 1, "name": 1, "type": 1},
    ):
        accts[a["id"]] = a

    rows = []
    for aid in candidate_ids:
        a = accts.get(aid) or {"id": aid, "name": "—", "code": "", "type": ""}
        # Does a full-month reconciled doc already exist?
        existing = await db.reconciliations.find_one({
            "company_id": cid, "bank_account_id": aid,
            "status": {"$in": ["reconciled", "qbo_covered"]},
            "period_start": {"$lte": prior_start},
            "period_end": {"$gte": prior_end},
        }, sort=[("period_end", -1)])
        txn_count = await db.transactions.count_documents({
            "company_id": cid, "bank_account_id": aid, "posted": True,
            "date": {"$gte": prior_start, "$lte": prior_end},
        })
        is_plaid_mapped = aid in mapped_ledger_ids
        has_foreign = False
        if is_plaid_mapped:
            fd = await db.transactions.find_one({
                "company_id": cid, "bank_account_id": aid,
                "source": {"$not": {"$regex": "^plaid"}},
                "posted": True,
            })
            has_foreign = bool(fd)

        if existing:
            status = "auto_reconciled" if existing.get("auto_generated") else "manually_reconciled"
            reason = (
                f"{existing.get('source','manual')} · {existing.get('completed_at','')[:10]}"
            )
            eta = None
        elif not is_plaid_mapped:
            status = "manual_required"
            reason = "No Plaid connection — must reconcile manually with a bank statement."
            eta = None
        elif has_foreign:
            status = "ineligible_non_plaid"
            reason = "Non-Plaid transactions on this account — auto path refuses; reconcile manually."
            eta = None
        elif waiting:
            status = "waiting_settle"
            reason = f"Plaid 5-day settle in progress · {days_left} day{'s' if days_left != 1 else ''} left"
            eta = eligible_at.isoformat()
        else:
            # Threshold has passed; next Plaid sync should auto-finalize.
            status = "ready_next_sync"
            reason = "Settle period over — will auto-finalize on next Plaid sync."
            eta = None

        rows.append({
            "account_id": aid,
            "account_code": a.get("code") or "",
            "account_name": a.get("name") or "—",
            "account_type": a.get("type") or "",
            "txn_count": txn_count,
            "plaid_mapped": is_plaid_mapped,
            "has_non_plaid_txns": has_foreign,
            "status": status,
            "reason": reason,
            "eligible_at": eta,
            "reconciliation_id": (existing or {}).get("id"),
            "reconciliation_statement_balance": (existing or {}).get("statement_balance"),
            "verification_method": (existing or {}).get("verification_method"),
        })
    order = {
        "manual_required": 0, "ineligible_non_plaid": 1,
        "waiting_settle": 2, "ready_next_sync": 3,
        "auto_reconciled": 4, "manually_reconciled": 5,
    }
    rows.sort(key=lambda r: (order.get(r["status"], 9), r["account_code"]))
    return {
        "month": f"{py:04d}-{pm:02d}",
        "period_start": prior_start,
        "period_end": prior_end,
        "settle_days": PROVISIONAL_DAYS,
        "eligible_at": eligible_at.isoformat(),
        "today": today.isoformat(),
        "waiting": waiting,
        "days_left": days_left,
        "rows": rows,
        "totals": {
            "accounts": len(rows),
            "auto_reconciled": sum(1 for r in rows if r["status"] == "auto_reconciled"),
            "manually_reconciled": sum(1 for r in rows if r["status"] == "manually_reconciled"),
            "waiting_settle": sum(1 for r in rows if r["status"] == "waiting_settle"),
            "ready_next_sync": sum(1 for r in rows if r["status"] == "ready_next_sync"),
            "manual_required": sum(1 for r in rows if r["status"] in ("manual_required", "ineligible_non_plaid")),
        },
    }


@router.get("/companies/{cid}/reconciliations/month-roster")
async def recon_month_roster(
    cid: str,
    month: str = Query(..., description="YYYY-MM"),
    user: dict = Depends(get_current_user),
):
    """Per-account recon roster for a single month.

    Returns one row per bank / credit-card account that is "relevant" to
    the month — defined as:
      a) having any posted transactions in [month_start, month_end], or
      b) having a reconciliation session whose period overlaps the month.

    Each row carries the txn/cleared counts and the status pros need to
    decide whether to click "Reconcile" for that account. Powers the
    one-click Reconcile roster surfaced from the Cockpit.
    """
    from calendar import monthrange
    await require_company(user, cid)
    try:
        y, m = month.split("-")
        yi, mi = int(y), int(m)
        if not (1 <= mi <= 12) or yi < 1900 or yi > 2999:
            raise ValueError
    except Exception:
        raise HTTPException(400, "month must be formatted YYYY-MM")
    last = monthrange(yi, mi)[1]
    month_start = f"{yi:04d}-{mi:02d}-01"
    month_end = f"{yi:04d}-{mi:02d}-{last:02d}"

    # (a) Transaction counts per bank account for the month.
    txn_rows = {}
    async for row in db.transactions.aggregate([
        {"$match": {
            "company_id": cid, "posted": True,
            "bank_account_id": {"$exists": True, "$ne": None},
            "date": {"$gte": month_start, "$lte": month_end},
        }},
        {"$group": {
            "_id": "$bank_account_id",
            "total": {"$sum": 1},
            "cleared": {"$sum": {"$cond": [{"$ifNull": ["$cleared_at", False]}, 1, 0]}},
            "last_date": {"$max": "$date"},
        }},
    ]):
        txn_rows[row["_id"]] = {
            "total": int(row.get("total") or 0),
            "cleared": int(row.get("cleared") or 0),
            "last_date": row.get("last_date"),
        }

    # (b) Reconciliation sessions that overlap the month, per account.
    recon_by_acct: dict[str, dict] = {}
    async for r in db.reconciliations.find({
        "company_id": cid,
        "period_start": {"$lte": month_end},
        "period_end": {"$gte": month_start},
    }):
        aid = r.get("bank_account_id")
        if not aid:
            continue
        # Keep the latest one for the account (by period_end).
        existing = recon_by_acct.get(aid)
        if not existing or (r.get("period_end") or "") > (existing.get("period_end") or ""):
            recon_by_acct[aid] = r

    # Union of accounts touched by either side; pull account metadata.
    account_ids = set(txn_rows.keys()) | set(recon_by_acct.keys())
    accts = {}
    async for a in db.accounts.find(
        {"company_id": cid, "id": {"$in": list(account_ids)}},
        {"_id": 0, "id": 1, "code": 1, "name": 1, "type": 1,
         "detail_type": 1, "mask": 1, "plaid_mask": 1},
    ):
        accts[a["id"]] = a

    rows = []
    for aid in account_ids:
        a = accts.get(aid) or {"id": aid, "name": "Unknown account", "code": "", "type": ""}
        tx = txn_rows.get(aid, {"total": 0, "cleared": 0, "last_date": None})
        r = recon_by_acct.get(aid)
        reconciled = bool(r) and r.get("status") in ("reconciled", "qbo_covered")
        covers_full_month = bool(
            r and (r.get("period_start") or "") <= month_start
            and (r.get("period_end") or "") >= month_end
        )
        if reconciled and covers_full_month:
            status = "reconciled" if tx["total"] else "reconciled_no_activity"
        elif reconciled:
            status = "partially_reconciled"
        elif tx["total"] == 0:
            # Account has a prior overlap session but no txns and no full-month recon.
            status = "no_activity"
        else:
            status = "needs_reconciliation"
        rows.append({
            "account_id": aid,
            "account_code": a.get("code") or "",
            "account_name": a.get("name") or "—",
            "account_type": a.get("type") or "",
            "account_mask": a.get("mask") or a.get("plaid_mask") or "",
            "txn_count": tx["total"],
            "cleared_count": tx["cleared"],
            "last_txn_date": tx["last_date"],
            "reconciled": reconciled,
            "reconciliation_covers_full_month": covers_full_month,
            "reconciliation_period_start": r.get("period_start") if r else None,
            "reconciliation_period_end": r.get("period_end") if r else None,
            "reconciliation_id": r.get("id") if r else None,
            "statement_balance": r.get("statement_balance") if r else None,
            "status": status,
        })
    # Sort: needs_reconciliation first, then partial, then reconciled, then no activity.
    order = {"needs_reconciliation": 0, "partially_reconciled": 1,
             "reconciled": 2, "reconciled_no_activity": 3, "no_activity": 4}
    rows.sort(key=lambda r: (order.get(r["status"], 9), -r["txn_count"], r["account_code"], r["account_name"]))
    totals = {
        "accounts": len(rows),
        "needs_reconciliation": sum(1 for r in rows if r["status"] == "needs_reconciliation"),
        "partially_reconciled": sum(1 for r in rows if r["status"] == "partially_reconciled"),
        "reconciled": sum(1 for r in rows if r["status"] in ("reconciled", "reconciled_no_activity")),
        "txn_total": sum(r["txn_count"] for r in rows),
    }
    return {
        "month": month,
        "period_start": month_start,
        "period_end": month_end,
        "rows": rows,
        "totals": totals,
    }


@router.get("/companies/{cid}/reconciliations/preview")
async def preview_reconciliation(
    cid: str,
    bank_account_id: str = Query(...),
    as_of: str = Query(...),
    opening_balance: float = Query(0.0),
    closing_balance: float = Query(0.0),
    user: dict = Depends(get_current_user),
):
    """Return uncleared items + diff (closing − opening − cleared_sum)."""
    await require_company(user, cid)
    return await preview_recon(cid, bank_account_id, as_of, opening_balance, closing_balance)


class ReconCompleteIn(BaseModel):
    bank_account_id: str
    period_start: str
    period_end: str
    opening_balance: float
    closing_balance: float
    cleared_txn_ids: List[str]


@router.post("/companies/{cid}/reconciliations/complete")
async def complete_reconciliation(
    cid: str, inp: ReconCompleteIn, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    try:
        result = await complete_recon(
            cid=cid,
            bank_account_id=inp.bank_account_id,
            period_start=inp.period_start,
            period_end=inp.period_end,
            opening_balance=inp.opening_balance,
            closing_balance=inp.closing_balance,
            cleared_txn_ids=inp.cleared_txn_ids,
            user_email=user.get("email") or user.get("id"),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    # Successful complete → drop any resume-draft for this period so the
    # CPA doesn't see stale saved state next time they open a fresh recon
    # for the same account/period. Aug 24 2026.
    await db.reconciliation_drafts.delete_one({
        "company_id": cid,
        "bank_account_id": inp.bank_account_id,
        "period_start": inp.period_start,
        "period_end": inp.period_end,
    })
    return result


class ReconDraftIn(BaseModel):
    bank_account_id: Optional[str] = None
    period_start: str
    period_end: str
    opening_balance: Optional[float] = None
    closing_balance: Optional[float] = None
    cleared_txn_ids: List[str] = []


@router.post("/companies/{cid}/reconciliations/draft")
async def save_recon_draft(
    cid: str, inp: ReconDraftIn, user: dict = Depends(get_current_user),
):
    """Save in-progress reconciliation state (ticked txns + balances) so a
    CPA can pause and pick up later. Keyed by (company, bank_account,
    period_start, period_end) — one draft per period. Idempotent upsert.
    Aug 24 2026.
    """
    await require_company(user, cid)
    now = now_iso()
    key = {
        "company_id": cid,
        "bank_account_id": inp.bank_account_id,
        "period_start": inp.period_start,
        "period_end": inp.period_end,
    }
    await db.reconciliation_drafts.update_one(
        key,
        {
            "$set": {
                **key,
                "opening_balance": inp.opening_balance,
                "closing_balance": inp.closing_balance,
                "cleared_txn_ids": inp.cleared_txn_ids,
                "updated_at": now,
                "updated_by": user.get("email") or user.get("id"),
            },
            "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now},
        },
        upsert=True,
    )
    return {"ok": True, "cleared_count": len(inp.cleared_txn_ids)}


@router.get("/companies/{cid}/reconciliations/draft")
async def get_recon_draft(
    cid: str,
    bank_account_id: Optional[str] = None,
    period_start: str = "",
    period_end: str = "",
    user: dict = Depends(get_current_user),
):
    """Hydrate a saved draft for the given (bank_account, period). Returns
    ``{"draft": null}`` when nothing is saved. Aug 24 2026.
    """
    await require_company(user, cid)
    doc = await db.reconciliation_drafts.find_one({
        "company_id": cid,
        "bank_account_id": bank_account_id,
        "period_start": period_start,
        "period_end": period_end,
    })
    if not doc:
        return {"draft": None}
    doc.pop("_id", None)
    return {"draft": doc}


@router.post("/companies/{cid}/reconciliations/auto-clear")
async def auto_clear_endpoint(cid: str, user: dict = Depends(get_current_user)):
    """On-demand trigger for the Plaid auto-clear pass. Sync path calls this
    automatically too."""
    await require_company(user, cid)
    return await auto_clear_settled_plaid_txns(cid)


class AutoBootstrapIn(BaseModel):
    plaid_item_id: Optional[str] = None
    # If True, delete any prior "placeholder" reconciliations (rows with no
    # bank_account_id or no cleared_txn_ids) before bootstrapping. This is
    # the safe way to replace demo/seed artifacts with real recons — real
    # completed recons are never touched.
    overwrite_placeholders: bool = False


@router.post("/companies/{cid}/reconciliations/auto-bootstrap")
async def auto_bootstrap(
    cid: str,
    inp: AutoBootstrapIn = None,
    user: dict = Depends(get_current_user),
):
    """Generate one reconciliation per completed calendar month for every
    Plaid-linked bank account whose ledger provably matches the Plaid feed.

    Refuses to fabricate: any account or period where the numbers don't line
    up end-to-end is skipped with a reason (surfaced in the response)."""
    await require_company(user, cid)
    inp = inp or AutoBootstrapIn()
    return await bootstrap_from_plaid(
        cid,
        plaid_item_id=inp.plaid_item_id,
        overwrite_placeholders=inp.overwrite_placeholders,
    )


@router.post("/companies/{cid}/reconciliations/purge-placeholders")
async def purge_placeholders(cid: str, user: dict = Depends(get_current_user)):
    """Delete reconciliations with no bank_account_id or empty cleared_txn_ids
    (i.e., demo/seed artifacts that never referenced real transactions).
    Real completed reconciliations are never touched."""
    await require_company(user, cid)
    docs = await db.reconciliations.find({
        "company_id": cid,
        "$or": [
            {"bank_account_id": {"$in": [None, ""]}},
            {"bank_account_id": {"$exists": False}},
            {"cleared_txn_ids": {"$in": [None, []]}},
            {"cleared_txn_ids": {"$exists": False}},
        ],
    }, {"id": 1}).to_list(1000)
    ids = [d["id"] for d in docs]
    if ids:
        await db.reconciliations.delete_many({"company_id": cid, "id": {"$in": ids}})
    return {"purged": len(ids), "ids": ids}



@router.post("/companies/{cid}/reconciliations/match-statement")
async def match_statement(
    cid: str,
    bank_account_id: str = Form(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Veryfi-OCR a statement PDF (or CSV) and return per-line match candidates
    grouped by confidence tier. Nothing is written; UI drives the apply step.

    Auto-corrects the target account when Veryfi's bank-name + last-4
    resolve to a DIFFERENT existing CoA row than the one the user picked
    from the dropdown — otherwise a user who selects "1000 Cash and Bank"
    but uploads a "1011 Bank of America Checking ···6084" statement gets
    94 phantom "missing from ledger" rows.
    """
    await require_company(user, cid)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    try:
        veryfi_data = await veryfi_service.process_bank_statement(
            raw, file.filename or "statement.pdf", file.content_type or "application/pdf",
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Veryfi error: {e}")

    # Try to auto-detect the correct bank account from the Veryfi OCR
    # (bank name + last-4). Only override the user's selection when the
    # resolver LINKED TO AN EXISTING account (matched=True) that differs
    # from the picked one — never silently create a new account here, and
    # never override a spot-on selection.
    import statement_account_resolver
    stmt_fields = statement_account_resolver._statement_fields(veryfi_data)
    resolved = None
    account_override = False
    try:
        existing = await db.accounts.find({
            "company_id": cid, "active": True,
        }).to_list(1000)
        last4 = stmt_fields.get("last4")
        matched_acct = None
        if last4:
            for a in existing:
                if last4 in (a.get("name") or ""):
                    matched_acct = a
                    break
        if matched_acct and matched_acct["id"] != bank_account_id:
            resolved = {
                "id": matched_acct["id"],
                "name": matched_acct["name"],
                "code": matched_acct["code"],
                "reason": f"Detected last-4 ···{last4} in ledger account",
            }
            bank_account_id = matched_acct["id"]
            account_override = True
    except Exception:  # noqa: BLE001 — best-effort auto-detect
        pass

    lines = veryfi_service.extract_transactions(veryfi_data)
    matches = await match_statement_lines(cid, bank_account_id, lines)
    return {
        "line_count": len(lines),
        "auto_count": len(matches["auto"]),
        "suggest_count": len(matches["suggest"]),
        "manual_count": len(matches["manual"]),
        "missing_from_statement_count": len(matches.get("missing_from_statement", [])),
        "resolved_account": resolved,
        "account_overridden": account_override,
        "used_bank_account_id": bank_account_id,
        "statement_bank_name": stmt_fields.get("bank_name"),
        "statement_last4": stmt_fields.get("last4"),
        # Auto-fill payload for the reconciliation form — the frontend
        # populates opening_balance / ending_balance / statement_start /
        # statement_end when these come back non-null so the user doesn't
        # have to re-type numbers already visible on the PDF.
        "statement_opening_balance": (
            float(stmt_fields["starting_balance"])
            if stmt_fields.get("starting_balance") is not None else None
        ),
        "statement_closing_balance": (
            float(stmt_fields["ending_balance"])
            if stmt_fields.get("ending_balance") is not None else None
        ),
        "statement_period_start": stmt_fields.get("period_start"),
        "statement_period_end": stmt_fields.get("period_end"),
        **matches,
    }


class ApplyMatchesIn(BaseModel):
    bank_account_id: str
    period_end: str
    apply_txn_ids: List[str]


@router.post("/companies/{cid}/reconciliations/apply-matches")
async def apply_matches(
    cid: str, inp: ApplyMatchesIn, user: dict = Depends(get_current_user),
):
    """Bulk-clear a set of ledger txn ids after the user confirms fuzzy matches
    from the statement matcher."""
    await require_company(user, cid)
    now = now_iso()
    r = await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": inp.apply_txn_ids}},
        {"$set": {
            "cleared_at": inp.period_end,
            "cleared_source": "statement_match",
            "updated_at": now,
        }},
    )
    return {"cleared": r.modified_count}


@router.post("/companies/{cid}/reconciliations")
async def create_rec(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Legacy freeform endpoint — kept so existing clients (the old UI, the
    demo seed script) don't 404. New flows should use `/complete` above."""
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    doc = {"id": rid, "company_id": cid, **payload, "created_at": now, "updated_at": now}
    await db.reconciliations.insert_one(doc)
    return {"id": rid}


# NOTE: This parameterized GET must come AFTER every literal /reconciliations/*
# route above (preview, complete, auto-clear, match-statement, apply-matches),
# otherwise FastAPI will match `/preview` against `/{rid}` and 404.
@router.get("/companies/{cid}/reconciliations/{rid}")
async def get_rec_detail(cid: str, rid: str, user: dict = Depends(get_current_user)):
    """Detail page — the reconciliation snapshot + every transaction it
    cleared, so the pro can drill into any past close."""
    await require_company(user, cid)
    rec = await db.reconciliations.find_one({"id": rid, "company_id": cid})
    if not rec:
        raise HTTPException(404, "Reconciliation not found.")
    rec = coerce(rec)
    bank = None
    if rec.get("bank_account_id"):
        bank = await db.accounts.find_one({"id": rec["bank_account_id"], "company_id": cid})
    txn_ids = rec.get("cleared_txn_ids") or []
    txns = await db.transactions.find({
        "company_id": cid, "id": {"$in": txn_ids},
    }).sort("date", 1).to_list(2000) if txn_ids else []
    if rec.get("cleared_sum") is not None:
        ledger = float(rec["cleared_sum"])
    else:
        ledger = round(sum(float(t.get("amount") or 0) for t in txns), 2)
    rec["ledger_balance"] = ledger
    if rec.get("difference") is not None:
        rec["diff"] = float(rec["difference"])
    else:
        rec["diff"] = round(float(rec.get("statement_balance") or 0.0) - ledger, 2)
    return {
        "reconciliation": rec,
        "account": coerce(bank) if bank else None,
        "transactions": [coerce(t) for t in txns],
    }


@router.delete("/companies/{cid}/reconciliations/{rid}")
async def unreconcile(cid: str, rid: str, user: dict = Depends(get_current_user)):
    """Un-reconcile: delete the reconciliation snapshot and `$unset` the
    cleared markers on every transaction it touched. Idempotent — deleting an
    already-deleted recon returns 404 so accidental double-clicks are safe."""
    await require_company(user, cid)
    rec = await db.reconciliations.find_one({"id": rid, "company_id": cid})
    if not rec:
        raise HTTPException(404, "Reconciliation not found.")
    txn_ids = rec.get("cleared_txn_ids") or []
    unset = 0
    if txn_ids:
        r = await db.transactions.update_many(
            {"company_id": cid, "id": {"$in": txn_ids}},
            {"$unset": {
                "cleared_at": "",
                "cleared_source": "",
                "cleared_reconciliation_id": "",
            }, "$set": {"updated_at": now_iso()}},
        )
        unset = r.modified_count
    await db.reconciliations.delete_one({"id": rid, "company_id": cid})
    return {"deleted": rid, "un_cleared": unset}


@router.post("/companies/{cid}/reconciliations/{rid}/rebuild")
async def rebuild_reconciliation(
    cid: str, rid: str,
    user: dict = Depends(get_current_user),
):
    """Delete the stale reconciliation snapshot AND immediately recreate
    a fresh one from the underlying statement import. Fixes the "MATCHED
    (0) · reconciliation snapshot is off" scenario where the original
    matched txns were reprocessed / edited / deleted since the recon
    was recorded.

    Only works for auto-generated Veryfi reconciliations (they carry a
    `statement_import_id` we can regenerate from). Manual reconciliations
    require the CPA to un-reconcile and redo the workflow.
    """
    from reconciliation_engine import create_reconciliation_from_statement_import
    await require_company(user, cid)
    rec = await db.reconciliations.find_one({"id": rid, "company_id": cid})
    if not rec:
        raise HTTPException(404, "Reconciliation not found.")
    imp_id = rec.get("statement_import_id")
    if not imp_id:
        raise HTTPException(
            400,
            "This reconciliation was created manually (no statement import "
            "attached) — click 'Un-reconcile' and redo the workflow instead.",
        )
    # 1. Un-reconcile — free cleared markers on any surviving txns.
    txn_ids = rec.get("cleared_txn_ids") or []
    if txn_ids:
        await db.transactions.update_many(
            {"company_id": cid, "id": {"$in": txn_ids}},
            {"$unset": {"cleared_at": "", "cleared_source": "",
                          "cleared_reconciliation_id": ""},
             "$set":   {"updated_at": now_iso()}},
        )
    await db.reconciliations.delete_one({"id": rid, "company_id": cid})
    # 2. Recompute from current ledger against the same statement import.
    fresh = await create_reconciliation_from_statement_import(cid, imp_id)
    if not fresh:
        raise HTTPException(
            500,
            "Rebuild failed — the statement import may be missing or "
            "corrupted. Try re-uploading the PDF.",
        )
    return {"deleted": rid, "created": fresh.get("id"), "recon": fresh}



@router.get("/companies/{cid}/book-reviews")
async def list_reviews(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.book_reviews.find({"company_id": cid}).sort("period", -1).to_list(500)
    return {"reviews": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/book-reviews")
async def create_review(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.book_reviews.insert_one({"id": rid, "company_id": cid, **payload,
                                       "created_at": now, "updated_at": now})
    return {"id": rid}


@router.get("/companies/{cid}/close-periods")
async def list_close(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.close_periods.find({"company_id": cid}).sort("period_end", -1).to_list(500)
    return {"periods": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/close-periods")
async def create_close(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.close_periods.insert_one({"id": rid, "company_id": cid, **payload,
                                        "kind": payload.get("kind", "month"),
                                        "created_at": now, "updated_at": now})
    return {"id": rid}


