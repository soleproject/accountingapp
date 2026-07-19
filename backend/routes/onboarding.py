"""Axiom Ledger — Onboarding routes.

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


# ----------------------- Onboarding -----------------------

@router.get("/companies/{cid}/onboarding")
async def get_onboarding(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await db.onboarding_state.find_one({"company_id": cid})
    if not doc:
        doc = {"id": str(uuid.uuid4()), "company_id": cid, "step": 0, "total_steps": 6,
               "complete": False, "answers": {}, "created_at": now_iso(), "updated_at": now_iso()}
        await db.onboarding_state.insert_one(doc)
    return {"onboarding": coerce(doc)}


@router.patch("/companies/{cid}/onboarding")
async def update_onboarding(cid: str, inp: OnboardingUpdate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    upd = {k: v for k, v in inp.model_dump(exclude_unset=True).items() if v is not None}
    upd["updated_at"] = now_iso()
    await db.onboarding_state.update_one({"company_id": cid}, {"$set": upd}, upsert=True)
    if inp.complete:
        await db.companies.update_one({"id": cid}, {"$set": {"onboarding_complete": True}})
    return {"ok": True}


@router.post("/companies/{cid}/onboarding/coa/suggest")
async def suggest_coa(cid: str, user: dict = Depends(get_current_user)):
    """Preview an AI-tailored chart of accounts without writing anything.
    Returns a list of `{code, name, type, subtype, rationale, already_exists}`
    so the UI can render a review-and-select screen before insertion.
    """
    company = await require_company(user, cid)
    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    existing_codes = [a["code"] for a in existing]
    suggestions = await suggest_chart_of_accounts(
        company.get("business_type", ""),
        company.get("business_description", ""),
        existing_codes=existing_codes,
    )
    existing_set = set(existing_codes)
    for s in suggestions:
        s["already_exists"] = s["code"] in existing_set
    return {"business_type": company.get("business_type", ""),
            "suggestions": suggestions}


@router.post("/companies/{cid}/onboarding/generate-coa")
async def generate_coa(cid: str, payload: dict | None = None,
                       user: dict = Depends(get_current_user)):
    """Insert AI-suggested industry-specific accounts.

    Body (optional): `{codes: ["4110", "5210", ...]}` — insert ONLY these
    codes from the current AI suggestion. If omitted, inserts every
    non-duplicate suggestion (legacy behavior).
    """
    company = await require_company(user, cid)
    extras = await suggest_chart_of_accounts(
        company.get("business_type", ""),
        company.get("business_description", ""),
        existing_codes=[a["code"] for a in
                        await db.accounts.find({"company_id": cid}).to_list(2000)],
    )
    wanted_codes = None
    if isinstance(payload, dict) and payload.get("codes"):
        wanted_codes = {str(c).strip() for c in payload["codes"] if c}
    # Refresh existing set to make the insert idempotent even if a concurrent
    # call added a code between the AI call and the write.
    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    codes = {a["code"] for a in existing}
    added = 0
    inserted = []
    for x in extras:
        if x["code"] in codes:
            continue
        if wanted_codes is not None and x["code"] not in wanted_codes:
            continue
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "code": x["code"], "name": x["name"],
            "type": x.get("type", "expense"),
            "subtype": x.get("subtype", "operating_expense"),
            "active": True, "balance": 0.0,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        added += 1
        inserted.append(x)
    await log_ai(cid, "coa_generated", added)
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"added": added, "suggestions": extras, "inserted": inserted}



@router.post("/companies/{cid}/onboarding/interview/questions")
async def onboarding_interview(cid: str, user: dict = Depends(get_current_user)):
    """Return 4-5 targeted onboarding questions tailored to the business type."""
    company = await require_company(user, cid)
    questions = await onboarding_interview_questions(
        company.get("business_type", ""),
        company.get("business_description", ""),
    )
    return {"business_type": company.get("business_type", ""), "questions": questions}


@router.post("/companies/{cid}/onboarding/interview/synthesize")
async def onboarding_interview_apply(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
):
    """Take the interview answers and produce refined CoA + starter rules.

    Body: `{answers: [{id, question, answer}, ...], apply: bool}`
    - `apply=false` (default): preview mode — nothing written.
    - `apply=true`: insert every returned account + create every returned rule
      (rules run `apply_to_existing=true` so historic un-reviewed txns are
      back-filled). Returns counts.

    Persists the raw answers on the company so we can retrain later.
    """
    company = await require_company(user, cid)
    answers = payload.get("answers") or []
    apply = bool(payload.get("apply", False))

    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    existing_min = [{"code": a["code"], "name": a["name"],
                     "type": a.get("type", "")} for a in existing]
    existing_codes = [a["code"] for a in existing]

    result = await onboarding_interview_synthesize(
        company.get("business_type", ""),
        company.get("business_description", ""),
        answers=answers,
        existing_codes=existing_codes,
        existing_accounts=existing_min,
    )
    # Persist raw answers even in preview mode — useful for auditing +
    # future re-runs when the AI improves.
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"onboarding_interview_answers": answers,
                  "onboarding_interview_at": now_iso()}},
    )

    if not apply:
        return {"apply": False, **result}

    now = now_iso()
    # 1) Insert every new account
    inserted_accounts = 0
    inserted_codes: dict[str, dict] = {}
    for a in result.get("accounts", []):
        exists = await db.accounts.find_one({"company_id": cid, "code": a["code"]})
        if exists:
            inserted_codes[a["code"]] = exists
            continue
        aid = str(uuid.uuid4())
        doc = {
            "id": aid, "company_id": cid, "code": a["code"], "name": a["name"],
            "type": a.get("type", "expense"),
            "subtype": a.get("subtype", "operating_expense"),
            "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        }
        await db.accounts.insert_one(doc)
        inserted_codes[a["code"]] = doc
        inserted_accounts += 1

    # 2) Create every rule + back-fill matching un-reviewed txns
    inserted_rules = 0
    rules_applied = 0
    for r in result.get("rules", []):
        acct = await db.accounts.find_one(
            {"company_id": cid, "code": r["account_code"]}
        )
        if not acct:
            continue
        # Skip if a matching rule already exists
        dup = await db.rules.find_one({
            "company_id": cid, "match_type": "merchant_contains",
            "match_value": r["merchant"], "account_code": r["account_code"],
        })
        if dup:
            continue
        rid = str(uuid.uuid4())
        await db.rules.insert_one({
            "id": rid, "company_id": cid,
            "match_type": "merchant_contains",
            "match_value": r["merchant"],
            "account_code": r["account_code"],
            "account_name": acct["name"],
            "created_by": "ai_interview",
            "hits": 0, "created_at": now, "updated_at": now,
        })
        inserted_rules += 1

        # Back-fill any historic un-reviewed txns that match
        q = {
            "company_id": cid, "human_reviewed": False,
            "merchant": {"$regex": re.escape(r["merchant"]), "$options": "i"},
        }
        docs = await db.transactions.find(q).to_list(5000)
        applied_here = 0
        for t in docs:
            if await is_period_closed(cid, t.get("date")):
                continue
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {
                    "category_account_id": acct["id"],
                    "category_account_code": acct["code"],
                    "category_account_name": acct["name"],
                    "ai_confidence": 0.99,
                    "ai_reasoning": f"Onboarding rule: {r['merchant']} → {acct['name']}",
                    "needs_review": False, "posted": True,
                    "updated_at": now_iso(),
                }},
            )
            applied_here += 1
        if applied_here:
            await db.rules.update_one({"id": rid}, {"$set": {"hits": applied_here}})
        rules_applied += applied_here

    await log_ai(cid, "onboarding_interview", inserted_accounts + inserted_rules)

    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    return {
        "apply": True,
        "accounts": result.get("accounts", []),
        "rules": result.get("rules", []),
        "inserted_accounts": inserted_accounts,
        "inserted_rules": inserted_rules,
        "rules_applied_to_transactions": rules_applied,
    }


@router.post("/companies/{cid}/onboarding/plaid/link-token")
async def plaid_link_token(cid: str, user: dict = Depends(get_current_user)):
    """Create a Plaid Link token for the user to link a bank account."""
    await require_company(user, cid)
    # Build the public webhook URL from the backend's own public host if available
    public_base = os.environ.get("PUBLIC_BACKEND_URL", "").rstrip("/")
    webhook_url = f"{public_base}/api/plaid/webhook" if public_base else None
    try:
        token = plaid_service.create_link_token(
            user_id=f"{user['id']}::{cid}",
            client_name="Axiom Ledger",
            webhook_url=webhook_url,
        )
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    return {"link_token": token}


@router.post("/companies/{cid}/plaid/backfill-history-token")
async def plaid_backfill_history_token(cid: str, user: dict = Depends(get_current_user)):
    """Mint a Plaid Link **update-mode** token for the company's existing Plaid
    item, requesting 730 days of history. When the user completes Link, Plaid
    will backfill older transactions and fire a HISTORICAL_UPDATE webhook.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No Plaid item linked for this company")
    public_base = os.environ.get("PUBLIC_BACKEND_URL", "").rstrip("/")
    webhook_url = f"{public_base}/api/plaid/webhook" if public_base else None
    try:
        token = plaid_service.create_link_token(
            user_id=f"{user['id']}::{cid}",
            client_name="Axiom Ledger",
            webhook_url=webhook_url,
            access_token_for_update=item["access_token"],
        )
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    return {"link_token": token, "item_id": item.get("item_id")}


@router.post("/companies/{cid}/onboarding/plaid/exchange")
async def plaid_exchange(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Exchange the public_token from Plaid Link for an access_token, persist Item, return accounts."""
    await require_company(user, cid)
    public_token = payload.get("public_token")
    if not public_token:
        raise HTTPException(400, "public_token required")
    try:
        ex = plaid_service.exchange_public_token(public_token)
        accounts = plaid_service.get_accounts(ex["access_token"])
        institution_name = plaid_service.get_institution_name(ex["access_token"])
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    now = now_iso()
    # Upsert Plaid item per company (single-item MVP: replace prior)
    await db.plaid_items.update_one(
        {"company_id": cid, "user_id": user["id"]},
        {"$set": {
            "id": str(uuid.uuid4()), "company_id": cid, "user_id": user["id"],
            "item_id": ex["item_id"], "access_token": ex["access_token"],
            "cursor": None, "accounts": accounts,
            "institution_name": institution_name,
            "created_at": now, "updated_at": now,
        }},
        upsert=True,
    )
    return {"accounts": accounts, "item_id": ex["item_id"],
            "institution_name": institution_name}


@router.post("/companies/{cid}/onboarding/plaid/import")
async def plaid_import(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Import transactions for the selected Plaid account IDs via /transactions/sync."""
    await require_company(user, cid)
    selected: list[str] = payload.get("account_ids") or []
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No linked Plaid item — link first")
    try:
        synced = plaid_service.sync_transactions(item["access_token"], item.get("cursor"))
    except Exception as e:
        raise HTTPException(502, f"Plaid sync error: {e}")
    await db.plaid_items.update_one({"id": item["id"]}, {"$set": {"cursor": synced["next_cursor"], "updated_at": now_iso()}})

    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    fallback_bank = next((a for a in accts if a["code"] == "1010"), None)
    if not fallback_bank:
        raise HTTPException(400, "Business Checking (1010) account not found")

    mappings = item.get("account_mappings") or {}
    range_cache: dict[str, list[tuple[str, str]]] = {}

    candidates: list[dict] = []
    for t in synced["added"]:
        if selected and t["account_id"] not in selected:
            continue
        if await db.transactions.find_one({"company_id": cid, "plaid_transaction_id": t["transaction_id"]}):
            continue
        if await is_period_closed(cid, t["date"]):
            continue
        mapping = mappings.get(t["account_id"])
        ledger_bank = next((a for a in accts if a["id"] == mapping["ledger_account_id"]), fallback_bank) if mapping else fallback_bank
        ranges = range_cache.get(ledger_bank["id"])
        if ranges is None:
            ranges = await plaid_connect.higher_source_ranges(cid, ledger_bank["id"], "plaid")
            range_cache[ledger_bank["id"]] = ranges
        if plaid_connect.in_any_range(t["date"], ranges):
            continue
        pfc = t.get("personal_finance_category")
        candidates.append({
            "date": t["date"], "description": t["name"],
            "merchant": t.get("merchant_name") or t.get("name") or "Unknown",
            "merchant_name": t.get("merchant_name"),
            "amount": t["amount"],
            "bank_account_id": ledger_bank["id"],
            "bank_account_name": ledger_bank["name"],
            "plaid_transaction_id": t["transaction_id"],
            "plaid_account_id": t["account_id"],
            "pending": t.get("pending", False),
            "pfc": pfc, "pfc_primary": (pfc or {}).get("primary"),
        })
    imported = await categorize_and_insert(cid, candidates, accts, coa, source="plaid")
    return {"imported": imported}


@router.post("/companies/{cid}/plaid/connect-account")
async def plaid_connect_account(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Connect a single Plaid account to a ledger bank account. Auto-maps
    the Plaid subtype to (or creates) the correct chart-of-accounts entry,
    pulls full Plaid history for that account (skipping any date range already
    covered by a higher-priority source per QBO > Plaid > Veryfi), and posts an
    opening-balance JE derived from the current Plaid balance and the oldest
    imported transaction.
    """
    await require_company(user, cid)
    plaid_account_id = payload.get("plaid_account_id")
    if not plaid_account_id:
        raise HTTPException(400, "plaid_account_id required")
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No linked Plaid item — launch Plaid Link first")
    try:
        result = await plaid_connect.connect_plaid_account(
            cid, item, plaid_account_id,
            categorize_fn=categorize_transaction,
            is_period_closed_fn=is_period_closed,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    await log_ai(cid, "categorize", result["imported"])
    return result


@router.post("/companies/{cid}/plaid/repair-collided-mappings")
async def plaid_repair_collided_mappings(cid: str, user: dict = Depends(get_current_user)):
    """One-shot repair for the pre-fix bug where two Plaid accounts from the
    same bank (e.g. Bank of America Checking ···6084 + ···9917) collapsed
    onto ONE CoA row. Detects any case where multiple `plaid_account_id`s
    share the same `ledger_account_id`, re-resolves each collided mask
    using the fixed resolver (which now creates a dedicated CoA row per
    unique last-4), moves that Plaid account's transactions to the new CoA
    row, and posts a fresh opening-balance JE for it.

    Idempotent — safe to run multiple times. Returns a per-account summary.
    """
    await require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No linked Plaid item — nothing to repair")

    mappings = dict(item.get("account_mappings") or {})
    if not mappings:
        return {"ok": True, "repaired": [], "note": "No Plaid account mappings on this item."}

    # Group plaid_account_ids by their current ledger row.
    from collections import defaultdict
    by_ledger: dict[str, list[str]] = defaultdict(list)
    for pa_id, m in mappings.items():
        lid = m.get("ledger_account_id")
        if lid:
            by_ledger[lid].append(pa_id)

    # Fetch Plaid accounts once so we can re-resolve.
    try:
        plaid_accts = plaid_service.get_accounts(item["access_token"])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't fetch Plaid accounts: {e}")
    inst_name = item.get("institution_name")

    repaired: list[dict] = []
    for ledger_id, pa_ids in by_ledger.items():
        if len(pa_ids) < 2:
            continue
        # Keep the FIRST plaid_account_id on the original ledger row —
        # everyone else gets a dedicated new CoA row.
        for pa_id in pa_ids[1:]:
            plaid_acct = next((a for a in plaid_accts if a.get("account_id") == pa_id), None)
            if not plaid_acct:
                repaired.append({"plaid_account_id": pa_id, "status": "skipped_no_plaid_data"})
                continue
            new_ledger = await plaid_connect.get_ledger_for_plaid_account(
                cid, plaid_acct, institution_name=inst_name,
            )
            if not new_ledger or new_ledger.get("id") == ledger_id:
                repaired.append({
                    "plaid_account_id": pa_id,
                    "status": "no_change",
                    "reason": "Resolver still returned same ledger row — the collision may already be fixed.",
                })
                continue
            # Move this Plaid account's transactions to the new ledger row.
            moved = await db.transactions.update_many(
                {"company_id": cid, "plaid_account_id": pa_id, "bank_account_id": ledger_id},
                {"$set": {
                    "bank_account_id": new_ledger["id"],
                    "updated_at": now_iso(),
                }},
            )
            # Update the mapping to point to the new ledger row.
            mappings[pa_id] = {
                **mappings[pa_id],
                "ledger_account_id": new_ledger["id"],
                "ledger_account_code": new_ledger["code"],
                "ledger_account_name": new_ledger["name"],
                "repaired_at": now_iso(),
                "previous_ledger_account_id": ledger_id,
            }
            # Recompute + post opening-balance JE for the new row if we don't
            # already have one.
            existing_obe = await db.journal_entries.find_one({
                "company_id": cid, "source": "opening_balance",
                "lines.account_id": new_ledger["id"],
            })
            je_id = None
            if not existing_obe:
                # Use Plaid's current balance as the opening (matches the
                # connect flow's fallback semantics). `plaid_service.get_accounts`
                # returns FLAT keys (`balance_current`/`balance_available`),
                # not a nested `balances` dict.
                current = (
                    plaid_acct.get("balance_current")
                    or plaid_acct.get("balance_available")
                    or 0.0
                )
                is_liability = new_ledger.get("type") == "liability"
                opening = -float(current) if is_liability else float(current)
                as_of = datetime.now(timezone.utc).date().isoformat()
                oldest = await db.transactions.find({
                    "company_id": cid, "plaid_account_id": pa_id,
                }).sort("date", 1).limit(1).to_list(1)
                if oldest and oldest[0].get("date"):
                    from datetime import date as _d
                    try:
                        as_of = (_d.fromisoformat(oldest[0]["date"]) - timedelta(days=1)).isoformat()
                    except Exception:
                        pass
                je_id = await plaid_connect.post_opening_balance_je(
                    cid, new_ledger, opening, as_of,
                    f"Opening balance — {plaid_acct.get('name') or new_ledger['name']} (repaired)",
                )
            repaired.append({
                "plaid_account_id": pa_id,
                "status": "repaired",
                "old_ledger": {"id": ledger_id},
                "new_ledger": {
                    "id": new_ledger["id"],
                    "code": new_ledger["code"],
                    "name": new_ledger["name"],
                },
                "transactions_moved": moved.modified_count,
                "opening_je_id": je_id,
            })

    if repaired:
        await db.plaid_items.update_one(
            {"id": item["id"]},
            {"$set": {"account_mappings": mappings, "updated_at": now_iso()}},
        )
        await log_ai(cid, "plaid_repair", len(repaired))

    # Second pass — ensure every current mapping has an opening-balance JE.
    # Covers the case where a collision was fixed in a previous run but the
    # OBE JE was skipped (e.g. balance parsing bug) — re-running repair now
    # backfills it.
    obe_posted: list[dict] = []
    for pa_id, m in mappings.items():
        ledger_id = m.get("ledger_account_id")
        if not ledger_id:
            continue
        existing_obe = await db.journal_entries.find_one({
            "company_id": cid, "source": "opening_balance",
            "lines.account_id": ledger_id,
        })
        if existing_obe:
            continue
        plaid_acct = next((a for a in plaid_accts if a.get("account_id") == pa_id), None)
        if not plaid_acct:
            continue
        ledger = await db.accounts.find_one({"id": ledger_id, "company_id": cid})
        if not ledger:
            continue
        current = (
            plaid_acct.get("balance_current")
            or plaid_acct.get("balance_available")
            or 0.0
        )
        is_liability = ledger.get("type") == "liability"
        opening = -float(current) if is_liability else float(current)
        if abs(opening) < 0.005:
            continue
        as_of = datetime.now(timezone.utc).date().isoformat()
        oldest = await db.transactions.find({
            "company_id": cid, "plaid_account_id": pa_id,
        }).sort("date", 1).limit(1).to_list(1)
        if oldest and oldest[0].get("date"):
            from datetime import date as _d
            try:
                as_of = (_d.fromisoformat(oldest[0]["date"]) - timedelta(days=1)).isoformat()
            except Exception:
                pass
        je_id = await plaid_connect.post_opening_balance_je(
            cid, ledger, opening, as_of,
            f"Opening balance — {plaid_acct.get('name') or ledger['name']} (repair backfill)",
        )
        if je_id:
            obe_posted.append({
                "plaid_account_id": pa_id,
                "ledger_code": ledger["code"],
                "ledger_name": ledger["name"],
                "opening": opening,
                "je_id": je_id,
            })

    return {"ok": True, "repaired": repaired, "obe_backfilled": obe_posted}


