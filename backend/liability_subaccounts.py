"""Liability sub-account auto-creation.

Enterprise CoAs typically have generic parent liability buckets:
    2100 Credit Card Payable      (parent)
    2500 Loans Payable            (parent)
    2400 Notes Payable            (parent)
    2200 Line of Credit           (parent)

But actual bookkeeping requires per-instrument tracking:
    2100 Credit Card Payable
      2110 Chase Sapphire ···1234
      2120 Amex Business Platinum ···9876
    2500 Loans Payable
      2510 Mr. Cooper Mortgage
      2520 Rocket Mortgage
      2530 Mercedes-Benz Financial

This module inspects a proposed liability categorization + the transaction's
payee (contact_name or merchant), and returns a specific SUB-account so the
balance sheet can nest debtor lines under their parent bucket.

The heuristic is intentionally conservative — it only routes to a sub-account
when the parent account name is one of the well-known "generic bucket" names.
Everything else is left alone.
"""
from __future__ import annotations
import re
import uuid
from typing import Optional

from db import db, now_iso


# Parent-bucket account NAMES that we auto-fan out into per-payee children.
# The check is case-insensitive substring — "Loans Payable", "Long-Term
# Loans Payable", "Mortgages Payable" all qualify.
GENERIC_LIABILITY_PARENT_PATTERNS = [
    re.compile(r"^credit\s+card(s)?\s+payable$", re.IGNORECASE),
    re.compile(r"^credit\s+card(s)?$",           re.IGNORECASE),
    re.compile(r"^loans?\s+payable$",            re.IGNORECASE),
    re.compile(r"^mortgages?\s+payable$",        re.IGNORECASE),
    re.compile(r"^notes?\s+payable$",            re.IGNORECASE),
    re.compile(r"^lines?\s+of\s+credit$",        re.IGNORECASE),
    re.compile(r"^long[- ]term\s+debt$",         re.IGNORECASE),
    re.compile(r"^auto\s+loans?\s+payable$",     re.IGNORECASE),
    re.compile(r"^vehicle\s+loans?\s+payable$",  re.IGNORECASE),
]


# Merchant strings that look like generic transfers, not real payees.
_GENERIC_PAYEE = re.compile(
    r"^(payment|transfer|online\s+banking|autopay|ach|wire|bank|deposit|withdrawal|"
    r"electronic\s+payment|internet\s+banking|debit|credit|check|refund)\b",
    re.IGNORECASE,
)


def is_parent_liability_bucket(account: dict) -> bool:
    if not account:
        return False
    if account.get("type") != "liability":
        return False
    nm = (account.get("name") or "").strip()
    return any(p.match(nm) for p in GENERIC_LIABILITY_PARENT_PATTERNS)


def _clean_payee(payee: str) -> Optional[str]:
    """Turn 'MR COOPER PMT PPD ID:1234' → 'Mr. Cooper'.

    Strips ACH memo cruft, upper-cases initials, and rejects generic-transfer
    verbs so we don't spawn subaccounts named 'Online Banking Transfer'.
    """
    if not payee:
        return None
    s = str(payee).strip()
    if not s or _GENERIC_PAYEE.match(s):
        return None
    # Drop common ACH suffixes.
    s = re.sub(r"\bPPD\s+ID:\S+\b",              " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\bWEB\s+ID:\S+\b",              " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\bDES:\S+\b",                    " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\bINDN:[^A-Z]*[A-Z]+\b",         " ", s)  # payee-side memo
    s = re.sub(r"\bCO\s+ID:\S+\b",                " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\b(PMT|PAYMENT|AUTO ?PAY|EPAY)\b", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\bCONFIRMATION\s*#?\s*\w+\b",    " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\b(?:CHK|ACH|WEB|POS)\b",         " ", s, flags=re.IGNORECASE)
    s = re.sub(r"[#*]+\s*[\dxX]+\b",              " ", s)  # ···1234 / #1234
    s = re.sub(r"\s+",                             " ", s).strip()
    if len(s) < 3:
        return None
    # Title-case ("MR COOPER" → "Mr Cooper" → "Mr. Cooper")
    words = s.split()
    if all(w.isupper() for w in words if any(c.isalpha() for c in w)):
        words = [w.capitalize() for w in words]
    out = " ".join(words)
    out = re.sub(r"\bMr\b(?!\.)", "Mr.", out)
    out = re.sub(r"\bMrs\b(?!\.)", "Mrs.", out)
    out = re.sub(r"\bMs\b(?!\.)", "Ms.", out)
    out = re.sub(r"\bLlc\b", "LLC", out)
    out = re.sub(r"\bInc\b", "Inc.", out)
    return out


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


async def _next_child_code(company_id: str, parent_code: str) -> str:
    """Pick the next free numeric code near the parent.

    e.g. parent 2500 → try 2510, 2520, 2530, …; parent 2100 → 2110, 2120, …

    Falls back to `<parent><next-int>` if the +10 sequence collides too
    much (unlikely — only when >89 sub-accounts exist).
    """
    try:
        base = int(parent_code)
    except (TypeError, ValueError):
        return parent_code + "-sub"
    used = set()
    async for a in db.accounts.find(
        {"company_id": company_id}, {"code": 1, "_id": 0},
    ):
        try:
            used.add(int(a.get("code")))
        except (TypeError, ValueError):
            continue
    # +10 stride first (2510, 2520…), then +1 fill.
    for step in (10, 1):
        code = base + step
        while code < base + 900:
            if code not in used and code != base:
                return str(code)
            code += step
    return str(base + 900)


async def resolve_or_create_liability_subaccount(
    company_id: str,
    parent_account: dict,
    payee: str | None,
    source: str = "auto",
) -> dict | None:
    """Given a parent liability account + a transaction payee, return the
    matching child sub-account (creating one if needed).

    Returns None if the payee is generic ("transfer", empty, etc.) so the
    caller can leave the transaction on the parent bucket.
    """
    clean = _clean_payee(payee)
    if not clean:
        return None

    # Look for an existing child under this parent.
    existing = await db.accounts.find({
        "company_id": company_id,
        "parent_account_id": parent_account["id"],
    }).to_list(500)
    key = _norm(clean)
    for a in existing:
        if _norm(a.get("name")) == key:
            return a
        # Loose match: payee substring in child name (handles "Mr. Cooper"
        # child while payee is "MR COOPER MORTGAGE").
        if key and (key in _norm(a.get("name")) or _norm(a.get("name")) in key):
            return a

    # Create a new child sub-account.
    code = await _next_child_code(company_id, str(parent_account.get("code", "")))
    now = now_iso()
    xid = str(uuid.uuid4())
    doc = {
        "id": xid,
        "company_id": company_id,
        "code": code,
        "name": clean,
        "type": parent_account["type"],
        "subtype": parent_account.get("subtype"),
        "parent_account_id": parent_account["id"],
        "active": True,
        "balance": 0.0,
        "created_by_ai": True,
        "system_generated": True,
        "source": source,
        "created_at": now,
        "updated_at": now,
    }
    await db.accounts.insert_one(doc)
    return doc


async def maybe_route_to_liability_subaccount(
    company_id: str,
    post: dict,
    merchant: str | None,
    contact_name: str | None,
    accts_by_id: dict | None = None,
) -> dict:
    """Post-processor for `categorizer.decide_posting()` output.

    If the picked category is a generic parent liability bucket AND we have
    a real payee, swap in (or create) a per-payee child sub-account.

    Mutates & returns the same `post` dict for convenience.
    """
    aid = post.get("category_account_id")
    if not aid:
        return post
    if accts_by_id is not None:
        parent = accts_by_id.get(aid)
    else:
        parent = await db.accounts.find_one({"id": aid, "company_id": company_id})
    if not is_parent_liability_bucket(parent):
        return post
    child = await resolve_or_create_liability_subaccount(
        company_id, parent, contact_name or merchant,
    )
    if not child:
        return post
    post["category_account_id"] = child["id"]
    post["category_account_code"] = child.get("code")
    post["category_account_name"] = child.get("name")
    return post


__all__ = [
    "GENERIC_LIABILITY_PARENT_PATTERNS",
    "is_parent_liability_bucket",
    "resolve_or_create_liability_subaccount",
    "maybe_route_to_liability_subaccount",
]
