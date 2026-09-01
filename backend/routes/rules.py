"""Axiom Ledger — Rules routes.

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


# ----------------------- Rules -----------------------

@router.get("/companies/{cid}/rules")
async def list_rules(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.rules.find({"company_id": cid}).sort("created_at", -1).to_list(500)
    candidates = await db.rule_candidates.find(
        {"company_id": cid, "approvals": {"$gte": 2}}
    ).sort("approvals", -1).to_list(200)

    # For each candidate compute how many CURRENT un-reviewed transactions
    # would be back-filled if the rule is accepted. The list is short
    # (typically < 30) and the regex is anchored, so parallel count_documents
    # calls are cheap. This is what powers the "would clean up N txns" preview
    # on the Rules page.
    async def _preview(c):
        try:
            n = await db.transactions.count_documents({
                "company_id": cid,
                "human_reviewed": False,
                "merchant": {"$regex": re.escape(c["merchant"]), "$options": "i"},
            })
        except Exception:  # noqa: BLE001
            n = 0
        return c["id"], n

    if candidates:
        pairs = await asyncio.gather(*[_preview(c) for c in candidates])
        preview_by_id = dict(pairs)
    else:
        preview_by_id = {}

    out_candidates = []
    for c in candidates:
        d = coerce(c)
        d["applies_to_count"] = preview_by_id.get(c["id"], 0)
        out_candidates.append(d)

    return {"rules": [coerce(d) for d in docs], "candidates": out_candidates}


@router.post("/companies/{cid}/rules")
async def create_rule(cid: str, inp: RuleCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    acct = await db.accounts.find_one({"company_id": cid, "code": inp.account_code})
    if not acct:
        raise HTTPException(400, "Account code not found")

    # Resolve optional bank-account and contact filters up front so we
    # can 400 early if the caller sent stale ids (avoids silently
    # creating a rule that never matches anything).
    bank_account = None
    if inp.bank_account_id:
        bank_account = await db.accounts.find_one(
            {"id": inp.bank_account_id, "company_id": cid}
        )
        if not bank_account:
            raise HTTPException(400, "Bank account not found in this company")
    contact = None
    if inp.contact_id:
        contact = await db.contacts.find_one(
            {"id": inp.contact_id, "company_id": cid}
        )
        if not contact:
            raise HTTPException(400, "Contact not found in this company")

    # Tier-2: resolve Class + Tag actions and validate posting-mode +
    # condition_logic vocabularies. Fail-fast beats silent no-ops.
    klass = None
    if inp.class_id:
        klass = await db.classes.find_one(
            {"id": inp.class_id, "company_id": cid}
        )
        if not klass:
            raise HTTPException(400, "Class not found in this company")
    if inp.tag_ids:
        found = await db.tags.count_documents(
            {"id": {"$in": inp.tag_ids}, "company_id": cid}
        )
        if found != len(inp.tag_ids):
            raise HTTPException(400, "One or more tags not found in this company")
    posting_mode = (inp.posting_mode or "auto").strip().lower()
    if posting_mode not in ("auto", "review"):
        raise HTTPException(400, "posting_mode must be 'auto' or 'review'")
    condition_logic = (inp.condition_logic or "all").strip().lower()
    if condition_logic not in ("all", "any"):
        raise HTTPException(400, "condition_logic must be 'all' or 'any'")

    # Primary-condition field selector. When set to "contact" the
    # `match_value` MUST be a valid contact id in this company — otherwise
    # the rule would never fire.
    match_field = (inp.match_field or "merchant").strip().lower()
    if match_field not in ("merchant", "contact"):
        raise HTTPException(400, "match_field must be 'merchant' or 'contact'")
    if match_field == "contact":
        prim_contact = await db.contacts.find_one(
            {"id": inp.match_value, "company_id": cid}
        )
        if not prim_contact:
            raise HTTPException(400, "Primary contact not found in this company")

    # Normalise the amount comparator so downstream matchers don't have
    # to defensively re-validate on every txn.
    amount_op    = (inp.amount_op or "").strip().lower() or None
    amount_value = inp.amount_value
    amount_value_2 = inp.amount_value_2
    if amount_op and amount_op not in ("gt", "lt", "eq", "between"):
        raise HTTPException(400, "amount_op must be gt|lt|eq|between")
    if amount_op and amount_value is None:
        raise HTTPException(400, "amount_value is required when amount_op is set")
    if amount_op == "between" and amount_value_2 is None:
        raise HTTPException(400, "amount_value_2 is required when amount_op='between'")

    # Build Mongo clauses for each Tier-2 extra condition. We collect
    # them as a flat list so both AND and OR modes are trivial to compose.
    _TEXT_OPS  = {"contains", "not_contains", "starts_with", "ends_with", "equals"}
    _AMT_OPS   = {"gt", "lt", "eq", "between"}
    extra_clauses: list[dict] = []
    for ec in (inp.extra_conditions or []):
        field = (ec.field or "").strip().lower()
        op    = (ec.op or "").strip().lower()
        raw   = ec.value if ec.value is not None else ""
        if field in ("merchant", "description"):
            if op not in _TEXT_OPS:
                raise HTTPException(400,
                    f"op '{op}' not supported for field '{field}'")
            escaped = re.escape(str(raw))
            regex = {
                "contains":     escaped,
                "starts_with":  f"^{escaped}",
                "ends_with":    f"{escaped}$",
                "equals":       f"^{escaped}$",
                "not_contains": None,
            }[op]
            if op == "not_contains":
                extra_clauses.append({field: {"$not": {
                    "$regex": escaped, "$options": "i"}}})
            else:
                extra_clauses.append({field: {
                    "$regex": regex, "$options": "i"}})
        elif field == "amount":
            if op not in _AMT_OPS:
                raise HTTPException(400,
                    f"op '{op}' not supported for field '{field}'")
            try:
                v = float(raw)
            except (TypeError, ValueError):
                raise HTTPException(400, "amount condition value must be numeric") from None
            if op == "gt":     extra_clauses.append({"amount": {"$gt": v}})
            elif op == "lt":   extra_clauses.append({"amount": {"$lt": v}})
            elif op == "eq":   extra_clauses.append({"amount": v})
            elif op == "between":
                v2 = ec.value_2
                if v2 is None:
                    raise HTTPException(400, "amount between requires value_2")
                lo, hi = sorted([v, float(v2)])
                extra_clauses.append({"amount": {"$gte": lo, "$lte": hi}})
        elif field == "bank_account":
            if op != "equals":
                raise HTTPException(400, "bank_account condition supports only op='equals'")
            aid = str(raw)
            extra_clauses.append({"$or": [
                {"bank_account_id":  aid},
                {"plaid_account_id": aid},
            ]})
        else:
            raise HTTPException(400, f"Unsupported condition field: '{field}'")

    rid = str(uuid.uuid4()); now = now_iso()
    rule_doc = {
        "id": rid, "company_id": cid, "match_type": inp.match_type,
        "match_field": match_field,
        "match_value": inp.match_value, "account_code": inp.account_code,
        "account_name": acct["name"], "created_by": "human", "hits": 0,
        "created_at": now, "updated_at": now,
        # Tier-1
        "bank_account_id":  inp.bank_account_id,
        "amount_op":        amount_op,
        "amount_value":     amount_value,
        "amount_value_2":   amount_value_2,
        "contact_id":       inp.contact_id,
        "contact_name":     contact.get("name") if contact else None,
        # Tier-2
        "extra_conditions": [ec.model_dump() for ec in (inp.extra_conditions or [])],
        "condition_logic":  condition_logic,
        "class_id":         inp.class_id,
        "class_name":       klass.get("name") if klass else None,
        "tag_ids":          list(inp.tag_ids or []),
        "posting_mode":     posting_mode,
    }
    await db.rules.insert_one(rule_doc)
    applied = 0
    if inp.apply_to_existing:
        # Primary condition: either merchant regex OR exact contact_id match.
        # Every rule has exactly one primary condition.
        if match_field == "contact":
            primary = {"contact_id": inp.match_value}
        else:
            primary = {"merchant": {"$regex": inp.match_value, "$options": "i"}}

        # Assemble the CONDITION set that will drive apply_to_existing.
        # For backwards-compat, Tier-1 conditions (bank_account_id,
        # amount_op) always contribute as AND clauses — they are not
        # part of the AND/OR toggle. Only Tier-2 extra_conditions honour
        # the condition_logic switch.
        must_and_clauses: list[dict] = []
        if inp.bank_account_id:
            must_and_clauses.append({"$or": [
                {"bank_account_id":  inp.bank_account_id},
                {"plaid_account_id": inp.bank_account_id},
            ]})
        if amount_op == "gt":       must_and_clauses.append({"amount": {"$gt": float(amount_value)}})
        elif amount_op == "lt":     must_and_clauses.append({"amount": {"$lt": float(amount_value)}})
        elif amount_op == "eq":     must_and_clauses.append({"amount": float(amount_value)})
        elif amount_op == "between":
            lo, hi = sorted([float(amount_value), float(amount_value_2)])
            must_and_clauses.append({"amount": {"$gte": lo, "$lte": hi}})

        if extra_clauses:
            if condition_logic == "any":
                # Primary + Tier-1 all AND together; Tier-2 extras are OR'd
                # among themselves and OR'd with the primary. That matches
                # QBO's "any" semantics: any single row-level condition
                # matching is enough to fire the rule.
                combined_any = [primary, *extra_clauses]
                must_and_clauses.append({"$or": combined_any})
                q: dict = {
                    "company_id": cid, "human_reviewed": False,
                    "$and": must_and_clauses,
                }
            else:
                must_and_clauses.append(primary)
                must_and_clauses.extend(extra_clauses)
                q = {
                    "company_id": cid, "human_reviewed": False,
                    "$and": must_and_clauses,
                }
        else:
            q = {
                "company_id": cid, "human_reviewed": False,
                **primary,
            }
            if must_and_clauses:
                q["$and"] = must_and_clauses

        docs = await db.transactions.find(q).to_list(5000)
        for t in docs:
            if await is_period_closed(cid, t.get("date")):
                continue  # rules never edit closed-period activity
            set_doc = {
                "category_account_id": acct["id"],
                "category_account_code": acct["code"],
                "category_account_name": acct["name"],
                "ai_confidence": 0.99,
                "ai_reasoning": f"Auto-applied rule: {inp.match_value} → {acct['name']}",
                "updated_at": now_iso(),
            }
            # Posting mode gates the review flow.
            if posting_mode == "auto":
                set_doc["needs_review"] = False
                set_doc["posted"] = True
            else:
                set_doc["needs_review"] = True
                set_doc["posted"] = False
            if contact:
                set_doc["contact_id"]   = contact["id"]
                set_doc["contact_name"] = contact.get("name")
            if klass:
                set_doc["class_id"]   = klass["id"]
                set_doc["class_name"] = klass.get("name")
            if inp.tag_ids:
                # Union onto whatever tags are already on the row so
                # rules stack cleanly instead of clobbering existing tags.
                existing_tags = set(t.get("tags") or [])
                existing_tags.update(inp.tag_ids)
                set_doc["tags"] = list(existing_tags)
            await db.transactions.update_one({"id": t["id"]}, {"$set": set_doc})
            applied += 1
        await db.rules.update_one({"id": rid}, {"$set": {"hits": applied}})
    # Consume any matching candidate — once promoted to a rule it should not
    # keep surfacing on the "Suggested rules" panel.
    await db.rule_candidates.delete_many({
        "company_id": cid,
        "key": f"{inp.match_value}::{inp.account_code}",
    })
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    await log_ai(cid, "rule_created", 1)
    return {"id": rid, "applied": applied}


@router.delete("/companies/{cid}/rules/{rid}")
async def delete_rule(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.rules.delete_one({"id": rid, "company_id": cid})
    return {"ok": True}


@router.delete("/companies/{cid}/rule-candidates/{candidate_id}")
async def dismiss_rule_candidate(cid: str, candidate_id: str,
                                  user: dict = Depends(get_current_user)):
    """Remove a suggested rule so it stops surfacing on the Rules page.

    Note: the underlying `(merchant, account_code)` pair may be re-created
    by future manual reclassifies — that's the intended feedback loop.
    """
    await require_company(user, cid)
    r = await db.rule_candidates.delete_one({"id": candidate_id, "company_id": cid})
    return {"ok": True, "deleted": r.deleted_count}


@router.get("/companies/{cid}/miner-notification")
async def miner_notification(cid: str,
                              user: dict = Depends(get_current_user)):
    """Dashboard banner payload: how many rules the miner has silently
    auto-applied since the pro last dismissed the notification.

    Zero count → banner hides. Feb 28 2026.
    """
    await require_company(user, cid)
    company = await db.companies.find_one(
        {"id": cid},
        {"_id": 0, "miner_banner_dismissed_at": 1},
    ) or {}
    dismissed_at = company.get("miner_banner_dismissed_at") or ""

    q: dict[str, Any] = {"company_id": cid, "created_by": "ai_miner"}
    if dismissed_at:
        q["mined_at"] = {"$gt": dismissed_at}

    new_count = await db.rules.count_documents(q)
    # Latest 3 for the banner's example strip
    samples = await db.rules.find(
        q, {"_id": 0, "match_value": 1, "account_name": 1, "hits": 1},
    ).sort("mined_at", -1).limit(3).to_list(3)
    return {
        "new_rules_count": new_count,
        "sample_rules": samples,
        "last_dismissed_at": dismissed_at,
    }


@router.post("/companies/{cid}/miner-notification/dismiss")
async def dismiss_miner_notification(
    cid: str, user: dict = Depends(get_current_user),
):
    """Mark the current miner-notification stream as seen."""
    await require_company(user, cid)
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"miner_banner_dismissed_at": now_iso()}},
    )
    return {"ok": True}


@router.post("/companies/{cid}/rules/mine")
async def mine_rules_endpoint(cid: str,
                               user: dict = Depends(get_current_user)):
    """Manually re-run the rules miner for a company.

    Fired automatically at the end of every QBO migration, but exposed
    here so pros can trigger it after bulk reclassifies without waiting
    for the next migration. Idempotent. Superadmin OR company member.
    """
    await require_company(user, cid)
    from rules_miner import mine_rule_candidates
    result = await mine_rule_candidates(cid)
    await log_ai(cid, "rules_mined", result.get("candidates", 0)
                 + result.get("auto_applied", 0))
    return {"ok": True, **result}


