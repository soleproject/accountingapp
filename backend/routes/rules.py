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

    # Tier-3: splits validation. When splits are present the top-level
    # `account_code` is treated as the fallback / display-only; the
    # slice list is what actually posts. All slice codes must resolve
    # to real CoA accounts and slices must sum to 100 (±0.01 rounding).
    splits_docs: list[dict] = []
    if inp.splits:
        total = 0.0
        for s in inp.splits:
            pct = float(s.percent or 0)
            if pct <= 0:
                raise HTTPException(400, "Every split must have percent > 0")
            slice_acct = await db.accounts.find_one(
                {"company_id": cid, "code": s.account_code}
            )
            if not slice_acct:
                raise HTTPException(400,
                    f"Split account code '{s.account_code}' not found")
            splits_docs.append({
                "account_code": s.account_code,
                "account_name": slice_acct["name"],
                "account_id":   slice_acct["id"],
                "percent":      pct,
            })
            total += pct
        if abs(total - 100.0) > 0.01:
            raise HTTPException(400,
                f"Split percents must sum to 100 (got {total:.2f})")

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
        # Direction filter — see RuleCreate.direction docs.
        "direction":        (inp.direction or "").strip().lower() or None,
        # Tier-2
        "extra_conditions": [ec.model_dump() for ec in (inp.extra_conditions or [])],
        "condition_logic":  condition_logic,
        "class_id":         inp.class_id,
        "class_name":       klass.get("name") if klass else None,
        "tag_ids":          list(inp.tag_ids or []),
        "posting_mode":     posting_mode,
        # Tier-3
        "enabled":          bool(inp.enabled),
        "priority":         int(inp.priority or 0),
        "splits":           splits_docs,
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
        # Direction filter contributes as an AND clause too. `direction`
        # is normalized to "in" | "out" | None in the persisted doc.
        _dir = rule_doc.get("direction")
        if _dir == "out":  must_and_clauses.append({"amount": {"$lt": 0}})
        elif _dir == "in": must_and_clauses.append({"amount": {"$gt": 0}})

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
            # Rule creation is an explicit CPA review of the covered rows —
            # `mark_approved` (default True) flips them into Approved so
            # they don't sit orphaned. CPA can uncheck for cautious mode.
            if bool(inp.mark_approved):
                set_doc["human_reviewed"] = True
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
            # Tier-3 splits: when the rule has slices, compute the
            # per-slice amount from the txn's absolute amount + sign,
            # write them into `splits[]`. The top-level category still
            # points at the fallback account_code so listing endpoints
            # stay backward-compatible.
            if splits_docs:
                sign = -1 if (t.get("amount") or 0) < 0 else 1
                abs_amt = abs(float(t.get("amount") or 0))
                slices = []
                for sd in splits_docs:
                    slice_amt = round(abs_amt * (sd["percent"] / 100.0), 2) * sign
                    slices.append({
                        "account_id":   sd["account_id"],
                        "account_code": sd["account_code"],
                        "account_name": sd["account_name"],
                        "amount":       slice_amt,
                        "percent":      sd["percent"],
                    })
                set_doc["splits"] = slices
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


@router.post("/companies/{cid}/rules/suggest-from-txns")
async def suggest_rules_from_txns(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
):
    """Derive a deduped list of "suggested rules" from the selected
    transactions on the Transactions grid. Powers the "Make these rules"
    guided flow (Mar 2026).

    Body: { "transaction_ids": [uuid, ...] }

    Algorithm:
      1. Load selected txns; drop those with no `category_account_code`
         or where the code is a parked / uncategorized dumping-ground
         (6999, 4999, 1999, 2999) — you never want to auto-post rules
         that route future rows to Uncategorized.
      2. Group by signature. If a txn has a `contact_id`, key on
         (contact, contact_id, category, class, tag_set); otherwise
         key on (merchant, exact_merchant_string, category, class,
         tag_set). Contact-keyed proposals win when both apply.
      3. Skip signatures already covered by an existing rule
         (same match_field + match_value + account_code).
      4. Return proposals sorted by (contact-first, coverage DESC)
         so the CPA hits the highest-leverage rules first.

    Response:
      {
        proposals: [
          { match_field, match_value, match_value_display,
            account_code, account_name,
            contact_id, class_id, tag_ids,
            posting_mode, priority,
            covered_txn_count },
          ...
        ],
        duplicates_skipped: int,
        uncategorized_skipped: int,
      }
    """
    await require_company(user, cid)
    tids = [x for x in (payload.get("transaction_ids") or []) if x]
    if not tids:
        raise HTTPException(400, "transaction_ids required")

    txns = await db.transactions.find(
        {"id": {"$in": tids}, "company_id": cid}
    ).to_list(len(tids))

    _PARKED_CODES = {"6999", "4999", "1999", "2999"}
    uncategorized_skipped = 0

    # Signature → aggregated proposal shell.
    proposals: dict[tuple, dict] = {}

    for t in txns:
        code = t.get("category_account_code") or ""
        if not code or code in _PARKED_CODES:
            uncategorized_skipped += 1
            continue
        contact_id = t.get("contact_id")
        merchant = (t.get("merchant") or "").strip()
        class_id = t.get("class_id")
        tag_set = tuple(sorted(t.get("tags") or []))

        # Contact axis wins when populated — cleaner grouping.
        if contact_id:
            key = ("contact", contact_id, code, class_id, tag_set)
            match_field  = "contact"
            match_value  = contact_id
            match_display = t.get("contact_name") or merchant or "contact"
        else:
            if not merchant:
                uncategorized_skipped += 1   # no signal to key on
                continue
            key = ("merchant", merchant, code, class_id, tag_set)
            match_field  = "merchant"
            match_value  = merchant
            match_display = merchant

        p = proposals.get(key)
        if p is None:
            proposals[key] = {
                "match_field":         match_field,
                "match_value":         match_value,
                "match_value_display": match_display,
                "account_code":        code,
                "account_name":        t.get("category_account_name") or "",
                "contact_id":          contact_id if match_field != "contact" else None,
                # Contact-keyed rules don't need contact ACTION — condition
                # already keys on contact. We surface it null so the UI
                # hides the Contact selector.
                "class_id":            class_id,
                "class_name":          t.get("class_name"),
                "tag_ids":             list(tag_set),
                "posting_mode":        "auto",   # default; user may flip
                "priority":            10 if match_field == "contact" else 0,
                "covered_txn_ids":     [],
                "posted_count":        0,
                "review_count":        0,
                # Direction tally — used by the frontend to auto-select
                # the Withdrawal / Deposit / Both pill when the CPA is
                # about to save the rule. Any row with a non-zero signed
                # amount contributes; the pill defaults to "Both" if the
                # bucket contains a mix.
                "withdrawal_count":    0,
                "deposit_count":       0,
            }
            p = proposals[key]
        p["covered_txn_ids"].append(t["id"])
        if t.get("posted"):
            p["posted_count"] += 1
        if t.get("needs_review"):
            p["review_count"] += 1
        _amt = float(t.get("amount") or 0.0)
        if   _amt < 0: p["withdrawal_count"] += 1
        elif _amt > 0: p["deposit_count"]    += 1

    # Drop signatures already covered by an existing rule for this company.
    # We look up (match_field, match_value, account_code) — the primary
    # tuple. If a rule with the same primary exists we assume the CPA
    # already handled it (even if Tier-2 conditions differ — false-positive
    # dedupe is fine here since the flow is opt-in).
    duplicates_skipped = 0
    final: list[dict] = []
    for p in proposals.values():
        existing = await db.rules.find_one({
            "company_id":   cid,
            "match_field":  p["match_field"],
            "match_value":  p["match_value"],
            "account_code": p["account_code"],
        })
        # Also match legacy rules that predate the match_field toggle —
        # they have no match_field key and default to "merchant".
        if not existing and p["match_field"] == "merchant":
            existing = await db.rules.find_one({
                "company_id":   cid,
                "match_field":  {"$exists": False},
                "match_value":  p["match_value"],
                "account_code": p["account_code"],
            })
        if existing:
            duplicates_skipped += 1
            continue
        # Posting mode default: mirror what the CPA did to these rows.
        # Majority-posted → auto; majority-review → flag for review.
        p["posting_mode"] = "auto" if p["posted_count"] >= p["review_count"] else "review"
        p["covered_txn_count"] = len(p["covered_txn_ids"])
        # Direction hint: "out" if every row is a withdrawal, "in" if
        # every row is a deposit, "both" for a mixed bucket. The
        # frontend maps this straight onto the new pill selector so
        # users don't have to re-derive it.
        w, d = p.pop("withdrawal_count", 0), p.pop("deposit_count", 0)
        if   w > 0 and d == 0: p["direction_hint"] = "out"
        elif d > 0 and w == 0: p["direction_hint"] = "in"
        else:                  p["direction_hint"] = "both"
        p.pop("covered_txn_ids", None)
        p.pop("posted_count", None)
        p.pop("review_count", None)
        final.append(p)

    # Contact-first, then coverage DESC.
    final.sort(key=lambda p: (
        0 if p["match_field"] == "contact" else 1,
        -p["covered_txn_count"],
    ))
    return {
        "proposals":             final,
        "duplicates_skipped":    duplicates_skipped,
        "uncategorized_skipped": uncategorized_skipped,
    }



@router.patch("/companies/{cid}/rules/{rid}")
async def patch_rule(
    cid: str, rid: str, payload: dict,
    user: dict = Depends(get_current_user),
):
    """Partial update — Tier-3 toggle + priority reorder + rename.

    Body accepts any subset of:
      { enabled: bool, priority: int, match_value: str, account_code: str }

    Renames route through the CoA to keep `account_name` denormalised
    correctly. Full rule rewrites (conditions, splits, actions) still
    go through DELETE + POST for now.
    """
    await require_company(user, cid)
    rule = await db.rules.find_one({"id": rid, "company_id": cid})
    if not rule:
        raise HTTPException(404, "Rule not found")

    set_doc: dict = {"updated_at": now_iso()}
    if "enabled"  in payload: set_doc["enabled"]  = bool(payload["enabled"])
    if "priority" in payload:
        try:
            set_doc["priority"] = int(payload["priority"])
        except (TypeError, ValueError):
            raise HTTPException(400, "priority must be an integer") from None
    if "match_value" in payload:
        set_doc["match_value"] = str(payload["match_value"]).strip()
    if "account_code" in payload:
        acct = await db.accounts.find_one(
            {"company_id": cid, "code": payload["account_code"]}
        )
        if not acct:
            raise HTTPException(400, "account_code not found")
        set_doc["account_code"] = acct["code"]
        set_doc["account_name"] = acct["name"]
    if len(set_doc) == 1:
        raise HTTPException(400, "nothing to update")
    await db.rules.update_one({"id": rid, "company_id": cid}, {"$set": set_doc})
    return {"ok": True, "updated": {k: v for k, v in set_doc.items() if k != "updated_at"}}


@router.post("/companies/{cid}/rules/{rid}/copy-to")
async def copy_rule_to_companies(
    cid: str, rid: str, payload: dict,
    user: dict = Depends(get_current_user),
):
    """Copy a rule from one company to N other companies the caller has
    access to. Pro/Accountant persona feature (Mar 2026, Tier-3).

    Body: { "target_company_ids": [uuid, ...] }

    For every target company:
      - Resolve `account_code` against the target's CoA. Skip target
        with a `missing_account` reason if the code doesn't exist
        (accountants often work across books with divergent CoAs).
      - Resolve any splits' `account_code` similarly.
      - Contact / class / tag / bank ids are dropped when copying —
        those are company-local and wouldn't resolve. Structural
        fields (conditions, amount_op, posting_mode, enabled, priority,
        splits by code) copy verbatim.
      - Insert as a fresh rule with `created_by="copy"` and
        `copied_from_rule_id=rid` for provenance.

    Returns: { copied: N, skipped: [{cid, reason}, ...] }
    """
    await require_company(user, cid)
    src = await db.rules.find_one({"id": rid, "company_id": cid})
    if not src:
        raise HTTPException(404, "Source rule not found")

    targets = payload.get("target_company_ids") or []
    if not isinstance(targets, list) or not targets:
        raise HTTPException(400, "target_company_ids must be a non-empty list")

    copied: list[dict] = []
    skipped: list[dict] = []
    now = now_iso()
    for tcid in targets:
        if tcid == cid:
            skipped.append({"cid": tcid, "reason": "same_company"}); continue
        try:
            await require_company(user, tcid)
        except HTTPException:
            skipped.append({"cid": tcid, "reason": "forbidden"}); continue
        acct = await db.accounts.find_one(
            {"company_id": tcid, "code": src["account_code"]}
        )
        if not acct:
            skipped.append({"cid": tcid,
                             "reason": f"missing_account:{src['account_code']}"})
            continue
        # Reproject splits against the target CoA. Skip target if ANY
        # slice's account_code is missing so we never post a partial
        # split rule.
        new_splits: list[dict] = []
        split_ok = True
        for s in (src.get("splits") or []):
            sa = await db.accounts.find_one(
                {"company_id": tcid, "code": s.get("account_code")}
            )
            if not sa:
                skipped.append({"cid": tcid,
                                 "reason": f"missing_split_account:{s.get('account_code')}"})
                split_ok = False
                break
            new_splits.append({
                "account_code": sa["code"], "account_name": sa["name"],
                "account_id":   sa["id"],   "percent": s["percent"],
            })
        if not split_ok:
            continue
        new_rid = str(uuid.uuid4())
        await db.rules.insert_one({
            "id":            new_rid,
            "company_id":    tcid,
            "match_type":    src.get("match_type"),
            "match_field":   src.get("match_field", "merchant"),
            "match_value":   src.get("match_value"),
            "account_code":  acct["code"],
            "account_name":  acct["name"],
            "created_by":    "copy",
            "copied_from_rule_id": rid,
            "copied_from_company_id": cid,
            "hits": 0,
            "created_at": now, "updated_at": now,
            # Tier-1 conditions carried verbatim except company-local ids.
            "bank_account_id": None,     # can't safely map across cos
            "amount_op":       src.get("amount_op"),
            "amount_value":    src.get("amount_value"),
            "amount_value_2":  src.get("amount_value_2"),
            "contact_id":      None,     # local id
            "contact_name":    None,
            # Tier-2
            "extra_conditions": list(src.get("extra_conditions") or []),
            "condition_logic":  src.get("condition_logic", "all"),
            "class_id":         None,    # local id
            "class_name":       None,
            "tag_ids":          [],      # local ids
            "posting_mode":     src.get("posting_mode", "auto"),
            # Tier-3
            "enabled":          bool(src.get("enabled", True)),
            "priority":         int(src.get("priority", 0)),
            "splits":           new_splits,
        })
        copied.append({"cid": tcid, "new_rule_id": new_rid})
    return {"copied": len(copied), "created": copied, "skipped": skipped}


