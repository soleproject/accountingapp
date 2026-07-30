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





# --------------------------------------------------------------------------
# Chart of Accounts Import — Excel / CSV / PDF → account rows
#
# Same two-step review flow the contacts import uses. Reuses the file
# parsers directly (routes.contacts._parse_upload) so we get one
# maintenance surface for Excel/CSV/PDF/AI-PDF handling.
# --------------------------------------------------------------------------
import io

# CoA-specific column aliases. Same style as the contacts importer so
# QBO / Xero / Excel exports auto-map without manual intervention.
_COA_HEADER_ALIASES = {
    "code":        ["code", "account code", "number", "account number",
                    "acct #", "acct#", "acct", "num", "no"],
    "name":        ["name", "account name", "account", "description",
                    "title", "gl account", "ledger account"],
    "type":        ["type", "account type", "category", "class"],
    "subtype":     ["subtype", "sub-type", "sub type", "detail type",
                    "sub category", "subcategory"],
    "parent_code": ["parent", "parent code", "parent account",
                    "parent account code", "parent number"],
}


def _coa_canonical_header(h: str) -> Optional[str]:
    if not h:
        return None
    key = str(h).strip().lower()
    for canonical, aliases in _COA_HEADER_ALIASES.items():
        if key in aliases:
            return canonical
    return None


# Loose normalizer for the ``type`` value. Users write "Assets", "Asset",
# "Current Asset", "Bank", "Credit Card", "P&L Income", etc. We map
# whatever we can to our 6 canonical types and stash the granular
# detail into subtype when the source column carried it.
_TYPE_HINTS: dict[str, str] = {
    "asset": "asset", "assets": "asset", "bank": "asset",
    "cash": "asset", "accounts receivable": "asset", "a/r": "asset",
    "fixed asset": "asset", "current asset": "asset",
    "other asset": "asset", "inventory": "asset",
    "liability": "liability", "liabilities": "liability",
    "accounts payable": "liability", "a/p": "liability",
    "credit card": "liability", "loan": "liability", "long-term liability": "liability",
    "current liability": "liability", "other liability": "liability",
    "equity": "equity", "owners equity": "equity", "owner's equity": "equity",
    "retained earnings": "equity",
    "income": "revenue", "revenue": "revenue", "sales": "revenue",
    "other income": "revenue",
    "cogs": "cogs", "cost of goods sold": "cogs",
    "cost of sales": "cogs", "materials": "cogs",
    "expense": "expense", "expenses": "expense",
    "operating expense": "expense", "other expense": "expense",
    "payroll": "expense", "tax": "expense",
}


def _norm_type(raw: str) -> Optional[str]:
    if not raw:
        return None
    key = re.sub(r"\s+", " ", str(raw).strip().lower())
    if key in _TYPE_HINTS:
        return _TYPE_HINTS[key]
    # Try suffix strip ("Assets" → "asset").
    if key.endswith("s") and key[:-1] in _TYPE_HINTS:
        return _TYPE_HINTS[key[:-1]]
    return None


def _norm_subtype(raw: str) -> str:
    """Convert 'Current Asset' → 'current_asset', 'Long-Term Liability'
    → 'long_term_liability'. Left as-is if it already looks snake_case."""
    if not raw:
        return ""
    s = str(raw).strip()
    if "_" in s and s == s.lower():
        return s
    s = re.sub(r"[^\w\s\-]", "", s)
    s = re.sub(r"[\s\-]+", "_", s.strip()).lower()
    return s



class AiClassifyIn(BaseModel):
    names: list[str]


@router.post("/companies/{cid}/accounts/import/ai-classify-types")
async def accounts_import_ai_classify(
    cid: str,
    inp: AiClassifyIn,
    user: dict = Depends(get_current_user),
):
    """Given a list of account names, ask GPT to classify each into one
    of the 6 canonical types (asset / liability / equity / revenue /
    cogs / expense) plus an optional snake_case subtype ("cash",
    "operating_expense", "long_term_liability", …).

    Used by the CoA import modal when the source spreadsheet has no
    Type column — one click on "Detect types with AI" fills in every
    row's type and subtype in a single batched call.

    Returns ``{name → {type, subtype}}`` so the frontend can merge the
    result back into its editable review table. Names GPT couldn't
    classify are omitted from the response — the caller keeps whatever
    default was already set."""
    await require_company(user, cid)
    names = [n.strip() for n in (inp.names or []) if n and n.strip()]
    if not names:
        return {"classified": {}}
    # Bounded — 200 rows is well beyond a typical CoA and keeps token
    # cost predictable.
    names = names[:200]

    from llm_client import LlmChat, UserMessage
    system = (
        "You are a GAAP-fluent bookkeeper. Given a list of account names, "
        "classify each into one of these six canonical `type` values: "
        "asset, liability, equity, revenue, cogs, expense. Also pick a "
        "snake_case `subtype` that matches (examples: cash, accounts_receivable, "
        "current_asset, fixed_asset, current_liability, long_term_liability, "
        "credit_card, retained_earnings, operating_revenue, service_revenue, "
        "operating_expense, payroll_expense, rent_expense, depreciation_expense, "
        "interest_expense). Return ONLY a JSON object shaped like "
        '{"classifications":[{"name":"<verbatim name>","type":"<one of six>","subtype":"<snake_case>"}]}. '
        "No prose, no code fences. Skip names you're unsure about."
    )
    session_id = f"coa-ai-classify-{uuid.uuid4().hex[:8]}"
    chat = LlmChat(
        api_key="",
        session_id=session_id,
        system_message=system,
        feature="ai-coa-classify",
    ).with_model(
        os.environ.get("LLM_PROVIDER", "openai"),
        os.environ.get("LLM_MODEL", "gpt-4o-mini"),
    )
    prompt = "Names:\n" + "\n".join(f"- {n}" for n in names) + "\n\nReturn the JSON now."
    try:
        reply = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"AI classify failed: {e}") from e

    m = re.search(r"\{[\s\S]*\}", str(reply or ""))
    if not m:
        return {"classified": {}}
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        return {"classified": {}}
    items = parsed.get("classifications") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        return {"classified": {}}

    valid_types = {"asset", "liability", "equity", "revenue", "cogs", "expense"}
    out: dict[str, dict] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        nm = (it.get("name") or "").strip()
        tp = (it.get("type") or "").strip().lower()
        st = (it.get("subtype") or "").strip().lower()
        if not nm or tp not in valid_types:
            continue
        out[nm] = {"type": tp, "subtype": _norm_subtype(st)}
    return {"classified": out, "requested": len(names), "returned": len(out)}



def _coa_rows_to_accounts(
    headers: list[str], rows: list[list[str]],
    mapping_override: Optional[dict[int, str]] = None,
) -> tuple[list[dict], dict[int, str]]:
    """Same job as ``_rows_to_contacts`` but shaped for CoA rows.
    Detects code/name/type/subtype/parent_code columns. Rows without
    a resolvable NAME are dropped — code alone isn't enough."""
    resolved: dict[int, str] = {}
    if mapping_override:
        for k, v in mapping_override.items():
            try:
                i = int(k)
            except (ValueError, TypeError):
                continue
            if v and v in _COA_HEADER_ALIASES:
                resolved[i] = v
    else:
        for i, h in enumerate(headers):
            canonical = _coa_canonical_header(h)
            if canonical and canonical not in resolved.values():
                resolved[i] = canonical
        if not resolved and headers:
            resolved[0] = "name"

    by_field: dict[str, int] = {v: k for k, v in resolved.items()}

    def _get(row, field):
        i = by_field.get(field)
        return row[i].strip() if i is not None and i < len(row) and row[i] else ""

    out: list[dict] = []
    for r in rows:
        name = _get(r, "name")
        if not name:
            continue
        raw_type = _get(r, "type")
        norm_type = _norm_type(raw_type) or "expense"
        # If the source `type` column carried a granular value ("Current
        # Asset") that doesn't match a canonical bucket, promote it to
        # subtype so nothing is lost. Explicit subtype column wins.
        subtype = _norm_subtype(_get(r, "subtype"))
        if not subtype and raw_type and _norm_type(raw_type) is not None:
            key = raw_type.strip().lower()
            if key not in ("asset", "assets", "liability", "liabilities",
                           "equity", "revenue", "income", "cogs", "expense",
                           "expenses"):
                subtype = _norm_subtype(raw_type)
        out.append({
            "code": _get(r, "code"),
            "name": name,
            "type": norm_type,
            "subtype": subtype,
            "parent_code": _get(r, "parent_code"),
        })
    return out, resolved


@router.post("/companies/{cid}/accounts/import/preview")
async def accounts_import_preview(
    cid: str,
    file: UploadFile = File(...),
    ai: str = Form("false"),
    user: dict = Depends(get_current_user),
):
    """Parse a spreadsheet or PDF of accounts and return the extracted
    rows without touching the database. Auto-detects columns for
    ``code``, ``name``, ``type``, ``subtype``, and ``parent_code``.
    Rows are matched against the existing CoA by CODE (primary) or
    normalized name so the UI can render "will create" vs "will
    update" pills."""
    await require_company(user, cid)
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "File too large. Max 15 MB.")
    # Reuse the contacts importer's file parsers — one implementation
    # for xlsx/csv/pdf/ai-pdf covers both use cases.
    from routes import contacts as _c
    fname = (file.filename or "").lower()
    use_ai = (str(ai).lower() == "true") and fname.endswith(".pdf")
    if use_ai:
        headers, rows = await _c._ai_parse_pdf(data)
        parsed = {"headers": headers, "rows": rows, "source": "pdf-ai"}
    else:
        parsed = _c._parse_upload(file.filename or "", data)
    accts, mapping = _coa_rows_to_accounts(parsed["headers"], parsed["rows"])

    # Dedup within the upload — same code OR normalized name.
    seen_codes: set[str] = set()
    seen_names: set[str] = set()
    deduped: list[dict] = []
    for a in accts:
        code_key = a["code"].strip() if a["code"] else ""
        name_key = a["name"].strip().lower()
        if code_key and code_key in seen_codes:
            continue
        if not code_key and name_key in seen_names:
            continue
        if code_key: seen_codes.add(code_key)
        if name_key: seen_names.add(name_key)
        deduped.append(a)

    # Flag rows that will UPDATE (existing code or name match) vs create.
    existing_by_code: dict[str, dict] = {}
    existing_by_name: dict[str, dict] = {}
    for d in await db.accounts.find(
        {"company_id": cid},
        {"id": 1, "code": 1, "name": 1, "type": 1, "_id": 0},
    ).to_list(3000):
        if d.get("code"):
            existing_by_code[str(d["code"]).strip()] = d
        existing_by_name[str(d.get("name") or "").strip().lower()] = d

    for a in deduped:
        match = existing_by_code.get(a["code"]) if a["code"] else None
        if not match:
            match = existing_by_name.get(a["name"].strip().lower())
        a["existing"] = bool(match)
        a["existing_id"] = match["id"] if match else None

    return {
        "source": parsed["source"],
        "filename": file.filename,
        "detected_headers": parsed["headers"],
        "raw_rows": parsed["rows"],
        "auto_mapping": {str(k): v for k, v in mapping.items()},
        "known_fields": list(_COA_HEADER_ALIASES.keys()),
        "row_count_raw": len(parsed["rows"]),
        "row_count_after_dedupe": len(deduped),
        "accounts": deduped,
    }


class CoAImportRemapIn(BaseModel):
    headers: list[str]
    raw_rows: list[list[str]]
    mapping: dict[str, str]


@router.post("/companies/{cid}/accounts/import/remap")
async def accounts_import_remap(
    cid: str, inp: CoAImportRemapIn,
    user: dict = Depends(get_current_user),
):
    """Re-resolve raw parsed rows with a UI-supplied column mapping."""
    await require_company(user, cid)
    override = {int(k): v for k, v in inp.mapping.items() if v}
    accts, resolved = _coa_rows_to_accounts(inp.headers, inp.raw_rows, override)
    # Re-run the existing-flag pass so pills stay in sync with the remap.
    existing_by_code: dict[str, dict] = {}
    existing_by_name: dict[str, dict] = {}
    for d in await db.accounts.find(
        {"company_id": cid},
        {"id": 1, "code": 1, "name": 1, "_id": 0},
    ).to_list(3000):
        if d.get("code"):
            existing_by_code[str(d["code"]).strip()] = d
        existing_by_name[str(d.get("name") or "").strip().lower()] = d
    for a in accts:
        match = existing_by_code.get(a["code"]) if a["code"] else None
        if not match:
            match = existing_by_name.get(a["name"].strip().lower())
        a["existing"] = bool(match)
        a["existing_id"] = match["id"] if match else None
    return {
        "row_count_after_dedupe": len(accts),
        "resolved_mapping": {str(k): v for k, v in resolved.items()},
        "accounts": accts,
    }


# GAAP-standard code ranges — must match the frontend's nextCodeForType.
_COA_CODE_RANGE = {
    "asset":     (1000, 1999),
    "liability": (2000, 2999),
    "equity":    (3000, 3999),
    "revenue":   (4000, 4999),
    "cogs":      (5000, 5999),
    "expense":   (6000, 9999),
}


def _next_code_for(type_: str, used: set) -> str:
    lo, hi = _COA_CODE_RANGE.get(type_, _COA_CODE_RANGE["expense"])
    for n in range(lo, hi + 1, 10):
        if str(n) not in used:
            used.add(str(n))
            return str(n)
    for n in range(lo, hi + 1):
        if str(n) not in used:
            used.add(str(n))
            return str(n)
    return str(hi)


class CoAImportCommitIn(BaseModel):
    accounts: list[dict]
    filename: Optional[str] = None
    source: Optional[str] = None


@router.post("/companies/{cid}/accounts/import/commit")
async def accounts_import_commit(
    cid: str, inp: CoAImportCommitIn,
    user: dict = Depends(get_current_user),
):
    """Insert (or update) every account in the payload. Match rule:
    prefer explicit ``existing_id`` from preview → then code within
    company → then normalized name. Auto-assigns a code when the
    caller left it blank (uses the GAAP range for the account's type).

    Writes a batch log in ``account_imports`` with per-row previous-doc
    snapshots so a bad import can be one-click undone."""
    await require_company(user, cid)
    now = now_iso()
    existing = await db.accounts.find({"company_id": cid}).to_list(3000)
    by_id = {a["id"]: a for a in existing}
    by_code = {str(a.get("code") or "").strip(): a for a in existing if a.get("code")}
    by_name = {str(a.get("name") or "").strip().lower(): a for a in existing}
    used_codes = set(by_code.keys())

    created_ids: list[str] = []
    updated_snapshots: list[dict] = []
    skipped = 0

    # First pass: assign IDs so parent_code links can be resolved after
    # every account exists (a spreadsheet may list children before parents).
    passes: list[dict] = []
    for a in inp.accounts:
        name = (a.get("name") or "").strip()
        if not name:
            skipped += 1
            continue
        type_ = (a.get("type") or "expense").strip().lower()
        if type_ not in _COA_CODE_RANGE:
            type_ = "expense"
        code = str(a.get("code") or "").strip()
        if not code:
            code = _next_code_for(type_, used_codes)
        else:
            used_codes.add(code)
        subtype = (a.get("subtype") or "").strip()
        # Match order: existing_id > code > name.
        match = None
        if a.get("existing_id") and a["existing_id"] in by_id:
            match = by_id[a["existing_id"]]
        elif code in by_code:
            match = by_code[code]
        else:
            match = by_name.get(name.lower())
        passes.append({
            "name": name, "code": code, "type": type_, "subtype": subtype,
            "parent_code": (a.get("parent_code") or "").strip(),
            "match": match,
        })

    # Second pass: apply upserts. Parent-code resolution needs the FINAL
    # code map (built from the first pass + existing rows).
    final_code_to_id: dict[str, str] = {c: v["id"] for c, v in by_code.items()}
    for p in passes:
        if not p["match"]:
            # Preallocate an id so we can wire children to a just-created
            # parent within the same import.
            new_id = str(uuid.uuid4())
            final_code_to_id[p["code"]] = new_id

    for p in passes:
        parent_id = None
        if p["parent_code"] and p["parent_code"] in final_code_to_id:
            candidate_id = final_code_to_id[p["parent_code"]]
            # Guard: parent must be same type, top-level. Same-type check
            # is enforced by looking up either passes-under-creation or
            # the existing set.
            candidate_type = None
            candidate_parent = None
            candidate_existing = by_id.get(candidate_id)
            if candidate_existing:
                candidate_type = candidate_existing.get("type")
                candidate_parent = candidate_existing.get("parent_account_id")
            else:
                # Match within this batch.
                for q in passes:
                    if final_code_to_id.get(q["code"]) == candidate_id:
                        candidate_type = q["type"]
                        break
            if candidate_type == p["type"] and not candidate_parent \
               and candidate_id != final_code_to_id.get(p["code"]):
                parent_id = candidate_id

        payload = {
            "company_id": cid,
            "code": p["code"],
            "name": p["name"],
            "type": p["type"],
            "subtype": p["subtype"],
            "active": True,
            "updated_at": now,
        }
        if parent_id:
            payload["parent_account_id"] = parent_id
        elif p["match"] and p["match"].get("parent_account_id"):
            # Clearing parent explicitly requires an empty parent_code
            # column — otherwise we preserve whatever the row already had.
            payload["parent_account_id"] = p["match"]["parent_account_id"]

        if p["match"]:
            prev = {k: v for k, v in p["match"].items() if k != "_id"}
            await db.accounts.update_one(
                {"id": p["match"]["id"], "company_id": cid},
                {"$set": payload},
            )
            updated_snapshots.append({"id": p["match"]["id"], "prev": prev})
        else:
            payload["id"] = final_code_to_id[p["code"]]
            payload["balance"] = 0.0
            payload["created_at"] = now
            await db.accounts.insert_one(payload)
            created_ids.append(payload["id"])

    log_id: Optional[str] = None
    if created_ids or updated_snapshots:
        log_id = str(uuid.uuid4())
        await db.account_imports.insert_one({
            "id": log_id,
            "company_id": cid,
            "user_id": user.get("id"),
            "at": now,
            "filename": inp.filename or "(unknown)",
            "source": inp.source or "",
            "created_ids": created_ids,
            "updated_snapshots": updated_snapshots,
            "created_count": len(created_ids),
            "updated_count": len(updated_snapshots),
            "skipped_count": skipped,
            "undone": False,
        })
    return {"ok": True, "created": len(created_ids),
            "updated": len(updated_snapshots), "skipped": skipped,
            "total": len(created_ids) + len(updated_snapshots) + skipped,
            "batch_id": log_id}


@router.get("/companies/{cid}/accounts/imports")
async def accounts_import_history(
    cid: str, limit: int = 20,
    user: dict = Depends(get_current_user),
):
    """List recent account-import batches so the CoA import UI can offer
    Undo. Same shape as the contacts import log."""
    await require_company(user, cid)
    docs = await db.account_imports.find(
        {"company_id": cid},
        {"_id": 0, "updated_snapshots": 0},
    ).sort("at", -1).to_list(min(limit, 100))
    user_ids = list({d.get("user_id") for d in docs if d.get("user_id")})
    name_map: dict[str, str] = {}
    if user_ids:
        for u in await db.users.find(
            {"id": {"$in": user_ids}}, {"id": 1, "name": 1, "email": 1, "_id": 0},
        ).to_list(len(user_ids)):
            name_map[u["id"]] = u.get("name") or u.get("email") or "—"
    for d in docs:
        d["user_name"] = name_map.get(d.get("user_id"), "—")
    return {"batches": docs}


@router.post("/companies/{cid}/accounts/imports/{batch_id}/undo")
async def accounts_import_undo(
    cid: str, batch_id: str,
    user: dict = Depends(get_current_user),
):
    """Roll a specific import batch back — delete every account it
    created, restore every account it overwrote from the snapshot.
    Blocks the delete leg if a created account has journal-entry
    postings against it (would strand JE lines pointing at a ghost)."""
    await require_company(user, cid)
    batch = await db.account_imports.find_one({"id": batch_id, "company_id": cid})
    if not batch:
        raise HTTPException(404, "Import batch not found")
    if batch.get("undone"):
        return {"ok": True, "already_undone": True, "deleted": 0, "restored": 0}
    created_ids = batch.get("created_ids") or []
    snapshots = batch.get("updated_snapshots") or []

    # Refuse to delete accounts that already have JE activity — the
    # import would leave stranded lines. Better to surface the conflict
    # so the user picks a different fix (e.g. merge).
    if created_ids:
        conflict = await db.journal_entries.count_documents({
            "company_id": cid, "lines.account_id": {"$in": created_ids},
        })
        if conflict:
            raise HTTPException(400,
                "One or more accounts created by this import already have "
                f"journal-entry activity ({conflict} entries). Merge or "
                "reclassify those entries first, then re-run undo.")
    deleted = 0
    if created_ids:
        r = await db.accounts.delete_many({"id": {"$in": created_ids}, "company_id": cid})
        deleted = r.deleted_count
    restored = 0
    for snap in snapshots:
        prev = snap.get("prev") or {}
        if not prev.get("id"):
            continue
        r = await db.accounts.replace_one(
            {"id": prev["id"], "company_id": cid}, prev,
        )
        restored += r.modified_count
    await db.account_imports.update_one(
        {"id": batch_id, "company_id": cid},
        {"$set": {"undone": True, "undone_at": now_iso(), "undone_by": user.get("id")}},
    )
    return {"ok": True, "deleted": deleted, "restored": restored}

