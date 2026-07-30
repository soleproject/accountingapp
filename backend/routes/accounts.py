"""Axiom Ledger — Accounts (Chart of Accounts) routes.

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


# Auto-managed opening balance JEs are event-driven:
#   - Statement upload → `statements.upload_statement` calls the helper
#     for that account and re-anchors to the earliest known statement
#     (older uploads shift the JE date backwards, newer uploads no-op).
#   - Plaid HISTORICAL_UPDATE webhook → `deps.sync_and_import` retries
#     the OBE post once the account has ≥30 days of history, which is
#     effectively "after the historical backfill has landed" since a
#     fresh INITIAL_UPDATE only carries ~30 days.
# The read path (this file) never triggers recompute — that was the old
# per-request approach that raised scalability concerns.
# One-time backfill for pre-Feb-2026 companies lives in
# `deps.migrate_opening_balances_once` and runs on backend startup.


# ----------------------- Accounts (Chart of Accounts) -----------------------

@router.get("/companies/{cid}/accounts")
async def list_accounts(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.accounts.find({"company_id": cid}).sort("code", 1).to_list(2000)
    return {"accounts": [coerce(d) for d in docs]}


@router.get("/companies/{cid}/accounts/balances")
async def account_balances(
    cid: str,
    as_of: Optional[str] = None,
    basis: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Return per-account balances the Chart of Accounts page shows in
    its balance column.

    ``basis`` (optional) forces one lens across every account:
      • ``ytd``        — Jan 1 of current year → as_of
      • ``month``      — first day of current month → as_of
      • ``cumulative`` — all-time through as_of

    When ``basis`` is None (default) each account uses the mode most
    useful for its type: asset/liability/equity → cumulative,
    revenue/expense/cogs → YTD. Matches how the Balance Sheet vs
    Income Statement each treat their accounts.

    Returns ``{account_id: {balance, rollup, mode}}`` where ``rollup`` is
    parent's balance plus sum of direct children (single-level nesting),
    ``balance`` is the account's own direct postings, and ``mode`` is
    the basis actually applied ("ytd" | "month" | "cumulative"). Signs
    are display-normalized (positive = normal balance for the type)."""
    await require_company(user, cid)
    today = datetime.now(timezone.utc).date().isoformat()
    end = as_of or today
    ytd_start = datetime.now(timezone.utc).date().replace(month=1, day=1).isoformat()
    month_start = datetime.now(timezone.utc).date().replace(day=1).isoformat()

    forced_basis = (basis or "").strip().lower() or None

    # Compute every basis we might need. Cheap enough to run all three:
    # each is one aggregate scan of the JE collection.
    cumulative = await R._signed_balances(cid, start=None, end=end, include_pre_period=True)
    ytd_only = await R._signed_balances(cid, ytd_start, end, include_pre_period=False)
    month_only = None
    if forced_basis == "month":
        month_only = await R._signed_balances(cid, month_start, end, include_pre_period=False)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)

    YTD_TYPES = {"revenue", "expense", "cogs"}

    def _basis_for(a):
        if forced_basis in ("ytd", "month", "cumulative"):
            return forced_basis
        return "ytd" if a.get("type") in YTD_TYPES else "cumulative"

    def _raw_for(a):
        b = _basis_for(a)
        if b == "ytd": src = ytd_only
        elif b == "month": src = month_only
        else: src = cumulative
        return (src or {}).get(a["id"], 0.0)

    children_of: dict[str, list[dict]] = {}
    for a in accts:
        pid = a.get("parent_account_id")
        if pid:
            children_of.setdefault(pid, []).append(a)

    out: dict[str, dict] = {}
    for a in accts:
        direct = R._display_amount(a, _raw_for(a))
        kids = children_of.get(a["id"], [])
        rolled = direct + sum(
            R._display_amount(k, _raw_for(k)) for k in kids
        )
        out[a["id"]] = {
            "balance": round(direct, 2),
            "rollup": round(rolled, 2),
            "mode": _basis_for(a),
        }
    return {"balances": out, "ytd_start": ytd_start,
            "month_start": month_start, "end": end,
            "applied_basis": forced_basis or "smart"}


def _normalize_account_name(name: str) -> str:
    """Collapse variations of the same account name so we can spot dupes.

    Examples that all map to ``meal``::
        "Meals", "Meal Expense", "Meals & Entertainment  ", " MEALS ".
    """
    if not name:
        return ""
    s = name.lower().strip()
    # Strip common accounting-noise suffixes.
    for suffix in (
        " expense", " expenses", " income", " revenue",
        " account", " accounts", " payable", " receivable",
    ):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    # Collapse punctuation and whitespace runs.
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    # Drop plural 's' for very short heads so "meal" == "meals".
    if len(s) > 3 and s.endswith("s"):
        s = s[:-1]
    return s


@router.get("/companies/{cid}/accounts/duplicates")
async def find_duplicate_accounts(cid: str, user: dict = Depends(get_current_user)):
    """Group same-type accounts whose normalized name matches, so the
    Chart of Accounts page can flag "3 likely duplicates" and offer the
    Merge dialog pre-filled.

    Returned shape::
        {"groups": [{"key": "meal", "type": "expense",
                     "accounts": [{id, code, name, subtype, is_ai}, ...]}]}
    Only groups with 2+ accounts are returned. Ordered by group size
    desc so the biggest cluster shows up first."""
    await require_company(user, cid)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    buckets: dict[tuple[str, str], list[dict]] = {}
    for a in accts:
        key = _normalize_account_name(a.get("name") or "")
        if not key:
            continue
        buckets.setdefault((a.get("type") or "", key), []).append({
            "id": a["id"],
            "code": a.get("code"),
            "name": a.get("name"),
            "subtype": a.get("subtype") or "",
            "created_by_ai": bool(a.get("created_by_ai")),
            "parent_account_id": a.get("parent_account_id"),
        })
    groups = []
    for (t, key), items in buckets.items():
        if len(items) < 2:
            continue
        items.sort(key=lambda x: str(x.get("code") or ""))
        groups.append({"key": key, "type": t, "accounts": items})
    groups.sort(key=lambda g: (-len(g["accounts"]), g["type"], g["key"]))
    return {"groups": groups, "total_groups": len(groups),
            "total_duplicates": sum(len(g["accounts"]) for g in groups)}


class MergeAccountsIn(BaseModel):
    target_account_id: str


@router.post("/companies/{cid}/accounts/{source_id}/merge-into")
async def merge_accounts(
    cid: str, source_id: str, inp: MergeAccountsIn,
    user: dict = Depends(get_current_user),
):
    """Merge ``source_id`` INTO ``target_id`` — reassigns every journal
    entry line and transaction currently pointing at the source, then
    deletes the source row. Sub-accounts (children of source) are
    re-parented to target so nothing gets orphaned.

    Idempotent: calling it twice does the right thing (second call is a
    no-op — nothing left pointing at source).

    Requires:
      • both accounts belong to the caller's company
      • same type (asset→asset, expense→expense) — merging across types
        would silently rewrite a debit account into a credit one.

    Returns per-collection counts of moved rows so the UI can render a
    "42 journal lines + 15 transactions merged" toast."""
    await require_company(user, cid)
    if source_id == inp.target_account_id:
        raise HTTPException(400, "Source and target must be different accounts.")
    src = await db.accounts.find_one({"id": source_id, "company_id": cid})
    tgt = await db.accounts.find_one({"id": inp.target_account_id, "company_id": cid})
    if not src or not tgt:
        raise HTTPException(404, "Source or target account not found.")
    if src.get("type") != tgt.get("type"):
        raise HTTPException(400, "Accounts must be the same type to merge.")

    moved = {"journal_lines": 0, "transactions": 0, "splits": 0,
             "rules": 0, "reparented_children": 0}

    # 1. Journal entry lines — rewrite account_id inline. Because lines
    # are embedded inside a `lines` array we need arrayFilters. Motor's
    # update_many supports it natively.
    r = await db.journal_entries.update_many(
        {"company_id": cid, "lines.account_id": source_id},
        {"$set": {"lines.$[el].account_id": inp.target_account_id,
                  "updated_at": now_iso()}},
        array_filters=[{"el.account_id": source_id}],
    )
    moved["journal_lines"] = r.modified_count

    # 2. Transactions — the primary category_account_id.
    r = await db.transactions.update_many(
        {"company_id": cid, "category_account_id": source_id},
        {"$set": {"category_account_id": inp.target_account_id,
                  "updated_at": now_iso()}},
    )
    moved["transactions"] = r.modified_count

    # 3. Split lines inside transactions.
    r = await db.transactions.update_many(
        {"company_id": cid, "splits.category_account_id": source_id},
        {"$set": {"splits.$[el].category_account_id": inp.target_account_id,
                  "updated_at": now_iso()}},
        array_filters=[{"el.category_account_id": source_id}],
    )
    moved["splits"] = r.modified_count

    # 4. Rules (auto-categorization rules that pin an account_id).
    r = await db.rules.update_many(
        {"company_id": cid, "category_account_id": source_id},
        {"$set": {"category_account_id": inp.target_account_id}},
    )
    moved["rules"] = r.modified_count

    # 5. Re-parent any sub-accounts whose parent is the source.
    r = await db.accounts.update_many(
        {"company_id": cid, "parent_account_id": source_id},
        {"$set": {"parent_account_id": inp.target_account_id,
                  "updated_at": now_iso()}},
    )
    moved["reparented_children"] = r.modified_count

    # 6. Finally, drop the source account row.
    await db.accounts.delete_one({"id": source_id, "company_id": cid})

    return {"ok": True, "moved": moved, "source_deleted": source_id,
            "target": inp.target_account_id}


@router.post("/companies/{cid}/accounts")
async def create_account(cid: str, inp: AccountCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    aid = str(uuid.uuid4()); now = now_iso()
    doc = {
        "id": aid, "company_id": cid, "code": inp.code, "name": inp.name,
        "type": inp.type, "subtype": inp.subtype, "active": True, "balance": 0.0,
        "created_at": now, "updated_at": now,
    }
    # Sub-account link — validate the parent belongs to the same company
    # and same type, and isn't itself nested (single-level trees only).
    if inp.parent_account_id:
        parent = await db.accounts.find_one({
            "id": inp.parent_account_id, "company_id": cid,
        })
        if not parent:
            raise HTTPException(400, "Parent account not found in this company.")
        if parent.get("type") != inp.type:
            raise HTTPException(400, "Parent account must be the same type.")
        if parent.get("parent_account_id"):
            raise HTTPException(400, "Parent must be a top-level account (only one level of nesting).")
        doc["parent_account_id"] = inp.parent_account_id
    await db.accounts.insert_one(doc)
    return {"id": aid}


# Idempotent "get-or-create" used by AI-driven flows (voice: "create a Transfer
# category", "make a new equity account named Owner's Contribution"). If an
# account with the same normalized name OR the same code exists we return it
# rather than creating a duplicate. Auto-assigns a code in the next-available
# 100 block for the requested type when the caller didn't specify one.
CODE_RANGES = {
    "asset":      (1200, 1999),  # skip 1010 Business Checking baseline
    "liability":  (2100, 2999),
    "equity":     (3200, 3999),  # skip 3000 Owner block
    "revenue":    (4100, 4999),
    "expense":    (6000, 8999),
    "cogs":       (5000, 5999),
}


class EnsureAccountIn(BaseModel):
    name: str
    type: str
    code: Optional[str] = None
    subtype: Optional[str] = ""
    parent_account_id: Optional[str] = None
    # Optional loan metadata — when the caller (AI or manual UI) knows the
    # lender/principal/rate/term for a new loan/HELOC/mortgage sub-account,
    # a linked Loans row is auto-spawned so the Loans page mirrors the CoA.
    lender: Optional[str] = None
    principal: Optional[float] = None
    rate: Optional[float] = None
    term_months: Optional[int] = None


# ---------- Sub-account policy -----------------------------------------
# Loans, mortgages, HELOCs, and credit cards should ALWAYS live under a
# canonical parent so the balance sheet stays grouped:
#   Loans Payable         (2500)  → loans, mortgages, notes payable, HELOCs
#   Credit Cards Payable  (2100)  → all credit card liabilities
# The helper below auto-creates the parent if it doesn't exist and returns
# its id. It skips when the account BEING created IS the parent itself.
LOAN_KEYWORDS = re.compile(
    r"\b(loan|mortgage|note[s]?\s+payable|line\s+of\s+credit|heloc|home\s+equity)\b",
    re.I,
)
LOAN_SUBTYPES = {"long_term_debt", "long_term_liability", "note_payable",
                 "notes_payable", "line_of_credit", "mortgage_payable", "heloc"}
CARD_KEYWORDS = re.compile(r"\bcredit\s*card\b", re.I)
CARD_SUBTYPES = {"credit_card", "credit_cards_payable"}
PARENT_ROOTS = {"loans payable", "credit cards payable"}


def _is_loan_class(name: str, subtype: str) -> bool:
    """True when a new liability qualifies as a loan/mortgage/HELOC —
    the classes we auto-spawn a Loans row for. Credit cards deliberately
    excluded (they live on their own page/lifecycle)."""
    name_norm = re.sub(r"\s+", " ", (name or "").strip()).lower()
    subtype_norm = (subtype or "").strip().lower()
    if name_norm in PARENT_ROOTS:
        return False  # the parent itself
    if CARD_KEYWORDS.search(name or "") or subtype_norm in CARD_SUBTYPES:
        return False
    return bool(LOAN_KEYWORDS.search(name or "")) or subtype_norm in LOAN_SUBTYPES


def _lender_from_name(name: str) -> str:
    """Heuristic to derive a lender label from an account name.
    "Mortgage Payable — 123 Main" → "123 Main"
    "Wells Fargo Mortgage" → "Wells Fargo"
    "HELOC — Chase" → "Chase"
    Falls back to the account name itself when no split is obvious."""
    s = (name or "").strip()
    # Prefer whatever follows an em-dash / en-dash / hyphen separator.
    for sep in [" — ", " – ", " - ", "—", "–"]:
        if sep in s:
            parts = s.split(sep, 1)
            tail = parts[1].strip()
            if tail:
                return tail
    # Strip common leading category words like "Mortgage Payable", "Loan", etc.
    stripped = re.sub(
        r"^(?:mortgage\s+payable|mortgage|note[s]?\s+payable|loan[s]?\s+payable|"
        r"loan|line\s+of\s+credit|heloc|home\s+equity(?:\s+line(?:\s+of\s+credit)?)?)"
        r"[:\s]*", "", s, flags=re.I,
    ).strip()
    return stripped or s


async def _resolve_liability_parent(cid: str, name: str, subtype: str) -> Optional[str]:
    """Find or create the canonical parent for a loan/HELOC/credit-card
    liability so it's always grouped under a proper root on the balance
    sheet. Returns None when no auto-parenting applies (e.g., the account
    IS the root, or it doesn't match the policy)."""
    name_norm = re.sub(r"\s+", " ", (name or "").strip()).lower()
    subtype_norm = (subtype or "").strip().lower()
    if name_norm in PARENT_ROOTS:
        return None  # don't parent a root to itself
    is_card = bool(CARD_KEYWORDS.search(name or "")) or subtype_norm in CARD_SUBTYPES
    is_loan = (bool(LOAN_KEYWORDS.search(name or "")) or subtype_norm in LOAN_SUBTYPES) and not is_card
    if not (is_card or is_loan):
        return None
    parent_name = "Credit Cards Payable" if is_card else "Loans Payable"
    parent_code = "2100" if is_card else "2500"
    parent_subtype = "credit_card" if is_card else "long_term_liability"
    # Find existing parent by name (case-insensitive) among liability accounts.
    parent_norm = parent_name.lower()
    async for a in db.accounts.find({"company_id": cid, "type": "liability"}):
        if re.sub(r"\s+", " ", (a.get("name") or "").strip()).lower() == parent_norm:
            return a["id"]
    # Create the parent on demand. Prefer the canonical code if free.
    used = {a["code"] for a in await db.accounts.find(
        {"company_id": cid, "code": {"$exists": True}}
    ).to_list(2000)}
    code = parent_code if parent_code not in used else None
    if not code:
        for n in range(2100, 3000, 10):
            if str(n) not in used:
                code = str(n); break
    aid = str(uuid.uuid4()); now = now_iso()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "code": code, "name": parent_name,
        "type": "liability", "subtype": parent_subtype, "active": True,
        "balance": 0.0, "parent_account_id": None,
        "created_at": now, "updated_at": now, "source": "policy_auto_parent",
    })
    return aid


@router.post("/companies/{cid}/accounts/ensure")
async def ensure_account(cid: str, inp: EnsureAccountIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    t = (inp.type or "").lower().strip()
    if t not in CODE_RANGES:
        raise HTTPException(400, f"Unsupported account type: {inp.type}")

    # Resolve parent_account_id: LLM proposals may pass a 4-digit code
    # ("2500") or a plain name ("Loans Payable") instead of the actual
    # UUID. Look it up so the parent link is always a real account id.
    if inp.parent_account_id:
        pid = inp.parent_account_id.strip()
        is_uuid_like = bool(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", pid.lower()))
        if not is_uuid_like:
            # Try code, then name (case-insensitive).
            parent = await db.accounts.find_one({"company_id": cid, "code": pid})
            if not parent:
                pid_norm = re.sub(r"\s+", " ", pid).lower()
                async for a in db.accounts.find({"company_id": cid, "type": t}):
                    if re.sub(r"\s+", " ", (a.get("name") or "").strip()).lower() == pid_norm:
                        parent = a
                        break
            inp.parent_account_id = parent["id"] if parent else None

    # Policy: loans, mortgages, HELOCs, and credit cards are ALWAYS created
    # as sub-accounts under a canonical parent so the balance sheet stays
    # grouped. If no parent was explicitly passed, auto-resolve one now
    # (creating "Loans Payable" or "Credit Cards Payable" if missing).
    if t == "liability" and not inp.parent_account_id:
        auto_parent = await _resolve_liability_parent(cid, inp.name, inp.subtype or "")
        if auto_parent:
            inp.parent_account_id = auto_parent

    # Match by normalized name (case-insensitive) OR exact code.
    # When creating a sub-account, don't reuse the parent's code —
    # always mint a new child so property-specific mortgages, etc.
    # don't get silently swallowed by an existing "Loans Payable 2500".
    name_norm = re.sub(r"\s+", " ", inp.name.strip()).lower()
    existing = None
    if inp.code and not inp.parent_account_id:
        existing = await db.accounts.find_one({"company_id": cid, "code": inp.code})
    if not existing:
        # Case-insensitive name match on same type; avoids "Transfer" vs "transfer".
        all_of_type = await db.accounts.find({"company_id": cid, "type": t}).to_list(1000)
        for a in all_of_type:
            if re.sub(r"\s+", " ", a.get("name", "").strip()).lower() == name_norm:
                # If caller wants a sub-account under a specific parent,
                # only reuse when the existing row is under the same parent.
                if inp.parent_account_id and a.get("parent_account_id") != inp.parent_account_id:
                    continue
                existing = a
                break
    if existing:
        return {"created": False, **coerce(existing)}

    # Assign a code: caller-provided if free, else next-available in the type range.
    lo, hi = CODE_RANGES[t]
    used = {a["code"] for a in await db.accounts.find(
        {"company_id": cid, "code": {"$exists": True}}
    ).to_list(2000)}
    if inp.code and inp.code not in used:
        code = inp.code
    else:
        code = None
        for n in range(lo, hi + 1, 10):
            candidate = str(n)
            if candidate not in used:
                code = candidate
                break
        if not code:
            code = str(lo + len([u for u in used if u.startswith(str(lo)[0])]))

    aid = str(uuid.uuid4()); now = now_iso()
    doc = {
        "id": aid, "company_id": cid, "code": code, "name": inp.name.strip(),
        "type": t, "subtype": inp.subtype or "", "active": True, "balance": 0.0,
        "parent_account_id": inp.parent_account_id,
        "created_at": now, "updated_at": now, "source": "ai_ensure",
    }
    await db.accounts.insert_one(doc)

    # Auto-spawn a linked Loans row when the new sub-account is a
    # loan/HELOC/mortgage (i.e., it's parented under Loans Payable via
    # the policy). This mirrors the fixed-asset lifecycle — the balance
    # sheet, the Loans page, and the loan schedule all stay in sync.
    if t == "liability" and inp.parent_account_id and _is_loan_class(inp.name, inp.subtype or ""):
        # Derive a sensible default lender from the account name if the
        # caller didn't provide one. "Mortgage Payable — 123 Main" →
        # "123 Main"; "Wells Fargo Mortgage" → "Wells Fargo"; etc.
        lender = (inp.lender or "").strip() or _lender_from_name(inp.name)
        loan_doc = {
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "account_id": aid,   # <— link back to the CoA sub-account
            "lender": lender,
            "principal": float(inp.principal) if inp.principal is not None else 0.0,
            "rate": float(inp.rate) if inp.rate is not None else None,
            "term_months": int(inp.term_months) if inp.term_months is not None else None,
            "created_at": now, "updated_at": now, "source": "auto_from_account",
        }
        await db.loans.insert_one(loan_doc)

    return {"created": True, **coerce(doc)}


@router.patch("/companies/{cid}/accounts/{aid}")
async def update_account(cid: str, aid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Sub-account parent — validate before saving so we never persist an
    # orphan or a 3-level tree. `None` / empty string clears the parent
    # (promotes to top-level).
    if "parent_account_id" in payload:
        pid = payload.get("parent_account_id")
        if pid in ("", None):
            payload["parent_account_id"] = None
        else:
            if pid == aid:
                raise HTTPException(400, "An account can't be its own parent.")
            parent = await db.accounts.find_one({"id": pid, "company_id": cid})
            if not parent:
                raise HTTPException(400, "Parent account not found in this company.")
            # Determine the effective type after this PATCH — the caller
            # can be changing type + parent in the same request.
            effective_type = payload.get("type")
            if effective_type is None:
                me = await db.accounts.find_one({"id": aid, "company_id": cid})
                effective_type = (me or {}).get("type")
            if parent.get("type") != effective_type:
                raise HTTPException(400, "Parent account must be the same type.")
            if parent.get("parent_account_id"):
                raise HTTPException(400, "Parent must be a top-level account (only one level of nesting).")
            # And any existing children of THIS account block it from being
            # nested (would create a 3-level tree).
            child_count = await db.accounts.count_documents({
                "company_id": cid, "parent_account_id": aid,
            })
            if child_count:
                raise HTTPException(400, "This account has sub-accounts of its own — flatten them before nesting.")
    payload["updated_at"] = now_iso()
    await db.accounts.update_one({"id": aid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@router.delete("/companies/{cid}/accounts/{aid}")
async def delete_account(cid: str, aid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.accounts.delete_one({"id": aid, "company_id": cid})
    # Cascade: drop any auto-spawned Loan row that pointed at this account
    # so the Loans page and CoA never desync.
    await db.loans.delete_many({"company_id": cid, "account_id": aid})
    return {"ok": True}


@router.post("/companies/{cid}/accounts/recompute-opening-balances")
async def recompute_opening_balances(cid: str, user: dict = Depends(get_current_user)):
    """Run the auto-managed opening balance helper across every bank
    ledger account in the company. Idempotent — safe to call any time.

    Backfills companies whose statements were uploaded BEFORE the
    auto-OBE service shipped in Feb 2026, and gives users a manual retry
    knob when a closed period previously blocked the auto-post.
    """
    await require_company(user, cid)
    import opening_balance_service as obs
    bank_types = ("asset", "liability")
    accts = await db.accounts.find({
        "company_id": cid, "active": True, "type": {"$in": list(bank_types)},
    }).to_list(1000)
    # Only run against accounts that at least ONE statement_imports row
    # references — no point iterating equity/income accounts.
    imported_account_ids = set(
        (await db.statement_imports.distinct("account_id", {"company_id": cid})) or []
    )
    results = []
    for a in accts:
        if a["id"] not in imported_account_ids:
            continue
        r = await obs.ensure_opening_balance_for_account(cid, a["id"])
        results.append({
            "account_id": a["id"],
            "account_name": a["name"],
            "account_code": a["code"],
            **r,
        })
    return {
        "processed": len(results),
        "posted": sum(1 for r in results if r.get("action") == "upserted"),
        "deleted": sum(1 for r in results if r.get("action") == "deleted"),
        "skipped": sum(1 for r in results if not r.get("ok")),
        "results": results,
    }



