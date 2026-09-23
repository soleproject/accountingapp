"""
curated_receipt_accounts — deterministic AI-line-item → real-account
resolution.

Problem: GPT-4o vision can hallucinate account names ("Fertilizer &
Chemicals" for a lumber receipt on a company with an ag-flavored CoA).
Even when the model returns a plausible name, if that name doesn't
actually exist on the company's chart the receipt gets stamped with
garbage that never reconciles against reports / QBO push / Plaid
categorization.

Solution: instead of trusting the AI's `account_name` verbatim, we
have the model return a canonical *kind* enum for each line
(`tax`, `shipping`, `meals`, `fuel`, ...). Server-side we map that
kind → a real account on the company's CoA using:

  1. Alias regex match against existing accounts (`db.accounts`)
  2. Fallback: create the canonical account from the map below
     (same auto-create pattern `get_or_create_owner_liability` uses
     for "Due to Owner")

Result: no hallucinations survive the round-trip. Every line ends up
stamped with a real `account_id` that other parts of the app already
recognize.

The AI's suggested `account_code`/`account_name` is only used as a
TIEBREAKER when the kind is `matched` (a generic bucket) and the
matched name happens to correspond to an existing account.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db

logger = logging.getLogger(__name__)


# Canonical account specs, keyed by the "kind" enum the AI returns.
# Every account we might need to auto-create on a company's CoA is
# defined here — no other module invents account names.
#
# `preferred_code` is a starting point; if it's already taken we
# increment inside the 6000-6999 expense band until we find a free
# slot (mirrors the owner-liability code-picker pattern).
#
# `aliases` is a list of case-insensitive regex fragments — a company
# whose CoA seed already carries any variant matches without creating
# a new account (self-healing across industry templates).
CANONICAL_KINDS: dict[str, dict] = {
    "tax": {
        "preferred_code": "6500",
        "name":           "Taxes & Licenses",
        "detail_type":    "taxes_paid",
        "aliases": [
            r"^taxes?\s*(and|&)?\s*licenses?$",
            r"^sales\s*tax\s*(paid|expense)?$",
            r"^state\s*sales\s*tax$",
            r"^use\s*tax$",
            r"^taxes?\s*paid$",
            r"^property\s*tax$",
            r"^permits?\s*(and|&)?\s*fees?$",
        ],
    },
    "shipping": {
        "preferred_code": "6420",
        "name":           "Shipping & Delivery",
        "detail_type":    "shipping_freight_delivery",
        "aliases": [
            r"^shipping\s*(and|&)?\s*delivery$",
            r"^shipping$",
            r"^freight",
            r"^postage",
            r"^delivery$",
        ],
    },
    "fuel": {
        "preferred_code": "6440",
        "name":           "Fuel",
        "detail_type":    "auto_fuel",
        "aliases": [
            r"^fuel\b",
            r"^gas(oline)?\b",
            r"^diesel",
            r"^vehicle\s*fuel",
        ],
    },
    "vehicle": {
        "preferred_code": "6450",
        "name":           "Vehicle Expenses",
        "detail_type":    "vehicle",
        "aliases": [
            r"^vehicle\s*(expense|maintenance)?",
            r"^auto\s*(expense|maintenance)?",
            r"^car\s*(expense|maintenance)?",
        ],
    },
    "repairs": {
        "preferred_code": "6460",
        "name":           "Repairs & Maintenance",
        "detail_type":    "repair_and_maintenance",
        "aliases": [
            r"^repairs?\s*(and|&)?\s*maintenance$",
            r"^repairs?$",
            r"^maintenance$",
        ],
    },
    "meals": {
        "preferred_code": "6480",
        "name":           "Meals - Business",
        "detail_type":    "meals_and_entertainment",
        "aliases": [
            r"^meals\s*-?\s*business$",
            r"^meals$",
            r"^business\s*meals$",
            r"^dining$",
        ],
    },
    "office_supplies": {
        "preferred_code": "6490",
        "name":           "Office Supplies",
        "detail_type":    "office_expenses",
        "aliases": [
            r"^office\s*supplies$",
            r"^supplies$",
        ],
    },
    "software": {
        "preferred_code": "6410",
        "name":           "Software & Subscriptions",
        "detail_type":    "dues_subscriptions",
        "aliases": [
            r"^software\s*(and|&)?\s*subscriptions$",
            r"^software$",
            r"^subscriptions?$",
            r"^saas$",
        ],
    },
    "utilities": {
        "preferred_code": "6300",
        "name":           "Utilities",
        "detail_type":    "utilities",
        "aliases": [
            r"^utilities$",
            r"^electric(ity)?$",
            r"^water$",
            r"^gas\s*(utility|service)$",
        ],
    },
    "telecom": {
        "preferred_code": "6310",
        "name":           "Internet & Phone",
        "detail_type":    "utilities",
        "aliases": [
            r"^internet\s*(and|&)?\s*phone$",
            r"^internet$",
            r"^phone$",
            r"^telecom",
            r"^cell(ular)?",
        ],
    },
    "insurance": {
        "preferred_code": "6800",
        "name":           "Insurance",
        "detail_type":    "insurance",
        "aliases": [
            r"^insurance$",
            r"^general\s*insurance$",
            r"^business\s*insurance$",
        ],
    },
    "rent": {
        "preferred_code": "6200",
        "name":           "Rent",
        "detail_type":    "rent_or_lease_of_buildings",
        "aliases": [
            r"^rent$",
            r"^rent\s*expense$",
            r"^lease\s*expense$",
        ],
    },
    "professional_fees": {
        "preferred_code": "6600",
        "name":           "Legal & Professional Fees",
        "detail_type":    "legal_professional_fees",
        "aliases": [
            r"^legal\s*(and|&)?\s*professional\s*fees?$",
            r"^legal\s*fees?$",
            r"^accounting\s*fees?$",
            r"^professional\s*fees?$",
        ],
    },
    "bank_fees": {
        "preferred_code": "6700",
        "name":           "Bank & Merchant Fees",
        "detail_type":    "bank_charges",
        "aliases": [
            r"^bank\s*(and|&)?\s*merchant\s*fees?$",
            r"^bank\s*fees?$",
            r"^merchant\s*fees?$",
            r"^card\s*(processing\s*)?fees?$",
        ],
    },
    "travel": {
        "preferred_code": "6470",
        "name":           "Travel",
        "detail_type":    "travel",
        "aliases": [
            r"^travel$",
            r"^business\s*travel$",
        ],
    },
    "advertising": {
        "preferred_code": "6400",
        "name":           "Marketing & Advertising",
        "detail_type":    "advertising",
        "aliases": [
            r"^marketing\s*(and|&)?\s*advertising$",
            r"^advertising$",
            r"^marketing$",
        ],
    },
    "uncategorized_expense": {
        "preferred_code": "6999",
        "name":           "Uncategorized Expense",
        "detail_type":    "expense",
        "aliases": [
            r"^uncategorized\s*expense$",
            r"^uncategori[sz]ed$",
            r"^misc(ellaneous)?\s*expense$",
        ],
    },
}


# Sentinel returned by the AI when the line clearly matches a specific
# non-generic account already on the CoA (materials, cogs, feed, etc.).
# In that case we skip the canonical map and try to match the AI's
# `account_code` / `account_name` against `db.accounts` directly.
KIND_MATCHED = "matched"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _find_by_aliases(company_id: str, aliases: list[str]) -> Optional[dict]:
    """Return the first `db.accounts` doc whose name matches any alias
    regex, scoped to the company and type=expense (so a "Sales Tax
    Payable" liability doesn't get selected for a "tax" kind).
    """
    for alias in aliases:
        hit = await db.accounts.find_one({
            "company_id": company_id,
            "type": {"$in": ["expense", "cogs", "cost of goods sold",
                             "other expense", "cost of sales"]},
            "name": {"$regex": alias, "$options": "i"},
        })
        if hit:
            return hit
    return None


async def _pick_free_code(
    company_id: str, preferred: str, band_start: int = 6000,
    band_end: int = 6999,
) -> str:
    """Return `preferred` if it isn't taken on this company, else the
    next free numeric code inside the given band. Falls back to a
    stable string suffix if the entire band is exhausted (rare)."""
    # Try preferred first.
    taken = await db.accounts.find_one({"company_id": company_id, "code": preferred})
    if not taken:
        return preferred
    # Then scan the band.
    for c in [str(n) for n in range(band_start, band_end + 1)]:
        taken = await db.accounts.find_one({"company_id": company_id, "code": c})
        if not taken:
            return c
    return f"{preferred}-{uuid.uuid4().hex[:4]}"


async def resolve_or_create_kind(
    company_id: str, kind: str,
) -> Optional[dict]:
    """Given an AI-provided line kind (`tax`, `shipping`, ...), return
    the real account doc on this company's CoA that the line should
    land on. Creates the canonical account if none exists yet.

    Returns None only when `kind` isn't in the canonical map — callers
    should treat that as "trust nothing, fall back to Uncategorized".
    """
    spec = CANONICAL_KINDS.get(kind)
    if not spec:
        return None

    # 1. Alias sweep against existing accounts on this company.
    hit = await _find_by_aliases(company_id, spec["aliases"])
    if hit:
        return hit

    # 2. Not present — auto-create using the canonical spec. Pick a
    #    free code near the preferred slot so we don't collide with
    #    seeded industry templates.
    code = await _pick_free_code(company_id, spec["preferred_code"])
    doc = {
        "id":          f"curated-{kind}-{uuid.uuid4().hex[:10]}",
        "company_id":  company_id,
        "code":        code,
        "name":        spec["name"],
        "type":        "expense",
        "subtype":     "operating_expense",
        "detail_type": spec["detail_type"],
        "parent_id":   None,
        "active":      True,
        "created_at":  _now_iso(),
        "updated_at":  _now_iso(),
        "system_generated":     True,
        "auto_created_purpose": f"receipt_kind:{kind}",
    }
    await db.accounts.insert_one(doc)
    logger.info(
        "curated account auto-created for company %s: %s · %s (kind=%s)",
        company_id, code, spec["name"], kind,
    )
    return doc


async def _match_by_code_or_name(
    company_id: str, account_code: str, account_name: str,
) -> Optional[dict]:
    """Fuzzy match the AI's suggested account against real accounts.
    Used when kind == KIND_MATCHED and the AI is claiming a specific
    non-generic bucket (e.g. Materials · Lumber). Returns the real
    account doc or None if nothing plausible exists.
    """
    if account_code:
        hit = await db.accounts.find_one({
            "company_id": company_id, "code": account_code,
        })
        if hit:
            return hit
    if account_name:
        # Exact name match (case-insensitive) first, then substring.
        hit = await db.accounts.find_one({
            "company_id": company_id,
            "name": {"$regex": f"^{account_name}$", "$options": "i"},
        })
        if hit:
            return hit
        # Substring — only inside expense-family accounts so a bad name
        # doesn't accidentally land on a Bank or A/R account.
        hit = await db.accounts.find_one({
            "company_id": company_id,
            "type": {"$in": ["expense", "cogs", "cost of goods sold",
                             "other expense", "cost of sales"]},
            "name": {"$regex": account_name.split()[0] if account_name.split() else account_name,
                     "$options": "i"},
        })
        return hit
    return None


async def resolve_line_account(
    company_id: str, line: dict,
) -> Optional[dict]:
    """Deterministic account resolver for a single AI receipt line.

    Strategy:
      * If `line.line_kind` names a canonical generic kind (tax,
        shipping, etc.) → resolve/create from the canonical map.
      * If `line.line_kind == "matched"` → try to fuzzy-match the AI's
        proposed `account_code` / `account_name` against real accounts.
      * On total miss → resolve/create Uncategorized Expense so the
        line always lands somewhere reviewable.

    Returns the account doc (with `id`, `code`, `name`, `type`), or
    None only if the DB write fails.
    """
    kind = (line.get("line_kind") or line.get("kind") or "").lower()
    if kind and kind != KIND_MATCHED and kind in CANONICAL_KINDS:
        acct = await resolve_or_create_kind(company_id, kind)
        if acct:
            return acct

    if kind == KIND_MATCHED or not kind:
        acct = await _match_by_code_or_name(
            company_id,
            line.get("account_code") or "",
            line.get("account_name") or "",
        )
        if acct:
            return acct

    # Total miss — land on Uncategorized so the split still balances
    # and the human reviewer sees a flag rather than nothing.
    return await resolve_or_create_kind(company_id, "uncategorized_expense")
