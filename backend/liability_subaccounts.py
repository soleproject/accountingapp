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


# Known real-world card issuers / lenders whose name can safely become a
# per-instrument liability sub-account. Anything NOT on this list AND that
# looks like a person's name is rejected — a natural person cannot be the
# holder of a credit-card payable (that would post the accountholder's
# name as a GL account, which is nonsense).
#
# Matched as case-insensitive substrings against the raw memo/description
# BEFORE contact_name is even considered — because ACH memos routinely
# include the accountholder as `INDN:<person>` which the contact resolver
# then mis-adopts as the transaction's counterparty. When the description
# clearly names one of these issuers, use THAT — never the INDN name.
_CARD_ISSUER_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bAMER(?:ICAN)?\s+EXP(?:RESS)?\b|\bAMEX\b",          re.I), "American Express"),
    (re.compile(r"\bCITI\s+CARD\b|\bCITIBANK\s+CARD\b|\bCITICTP\b",   re.I), "Citi Card"),
    (re.compile(r"\bCHASE\s+CARD\b|\bCHASE\s+CREDIT\b|\bCHASE\s+CC\b", re.I), "Chase Card"),
    (re.compile(r"\bCAPITAL\s+ONE\s+CARD\b|\bCAP\s+ONE\s+CRCARDPMT\b|\bCAPITAL\s+ONE\s+CRCARDPMT\b", re.I), "Capital One Card"),
    (re.compile(r"\bBANK\s+OF\s+AMERICA\s+CC\b|\bBOFA\s+CC\b|\bBK\s*OF\s*AMER\s*ONLINE\s*BANKING\b", re.I), "Bank of America Card"),
    (re.compile(r"\bWELLS\s+FARGO\s+CARD\b|\bWF\s+CARD\b|\bWELLSFARGO\s+CARD\b", re.I), "Wells Fargo Card"),
    (re.compile(r"\bUS\s+BANK\s+CARD\b|\bUS\s+BANCORP\s+CARD\b",       re.I), "US Bank Card"),
    (re.compile(r"\bDISCOVER\b",                                       re.I), "Discover"),
    (re.compile(r"\bSYNCHRONY\b|\bSYF\b",                              re.I), "Synchrony"),
    (re.compile(r"\bBARCLAY(S|CARD)?\b",                               re.I), "Barclays Card"),
    (re.compile(r"\bBEST\s*BUY\s+CBNA\b|\bBBY\s+CBNA\b",               re.I), "Best Buy Card"),
    (re.compile(r"\bCOMENITY\b",                                       re.I), "Comenity Bank"),
    (re.compile(r"\bAPPLE\s+CARD\b|\bGOLDMAN\s+SACHS\s+APPLE\b",       re.I), "Apple Card"),
    (re.compile(r"\bPAYPAL\s+CREDIT\b|\bPAYPAL\s+CRED\b",              re.I), "PayPal Credit"),
    (re.compile(r"\bAFFIRM\b",                                         re.I), "Affirm"),
    (re.compile(r"\bKLARNA\b",                                         re.I), "Klarna"),
    (re.compile(r"\bAFTERPAY\b",                                       re.I), "Afterpay"),
    (re.compile(r"\bCONCORA\s+CREDIT\b",                               re.I), "Concora Credit"),
    (re.compile(r"\bCREDIT\s+ONE\s+BANK\b|\bCREDIT\s+ONE\b",           re.I), "Credit One Bank"),
    (re.compile(r"\bMR\.?\s*COOPER\b",                                 re.I), "Mr. Cooper"),
    (re.compile(r"\bROCKET\s+MORTGAGE\b",                              re.I), "Rocket Mortgage"),
    (re.compile(r"\b(AUDI|BMW|MERCEDES(?:[- ]BENZ)?|TOYOTA|HONDA|FORD|CHRYSLER|GM|ALLY)\s+(?:MOTOR\s+)?(?:FINANCIAL|FIN(?:ANCE)?|CREDIT|CAPITAL|ACCEPT)\b", re.I), None),  # dynamic — extract group
    (re.compile(r"\bALLY\s+AUTO\b",                                    re.I), "Ally Auto"),
]


# Tokens that mark the payee as an individual — first-name / last-name
# rather than a business entity. Sub-accounts under liability parents
# should NEVER be named after a natural person: an individual can't
# legally "hold" a company credit-card payable balance. We use these to
# recognize person-shaped cleaned payees and refuse to spawn a
# sub-account with that name.
_PERSON_NAME_HINT = re.compile(r"\bINDN:\s*[A-Z][A-Za-z]+(?:\s+[A-Z](?:\.|[A-Za-z]+))?\s+[A-Z][A-Za-z]+\b")

# Tokens that mark the string as a BUSINESS entity — these override the
# person-name shape check.
_BUSINESS_HINTS = re.compile(
    r"\b(LLC|L\.L\.C\.|INC|INCORPORATED|CORP|CORPORATION|CO\b|COMPANY|PLLC|LTD|LP|LLP|"
    r"BANK|CARD|MORTGAGE|LOAN|FINANCIAL|CAPITAL|CREDIT|SERVICES|SOLUTIONS|"
    r"INSURANCE|GROUP|HOLDINGS|EXPRESS|DISCOVER|AMEX|SYF|SYNCHRONY|"
    r"VISA|MASTERCARD|BARCLAYS|PAYPAL|AFFIRM|KLARNA|AFTERPAY)\b",
    re.IGNORECASE,
)


def _extract_card_issuer(raw_memo: str) -> Optional[str]:
    """Given a raw bank memo/description string, return the CANONICAL
    card-issuer name if any of the `_CARD_ISSUER_PATTERNS` match. Never
    returns an INDN accountholder name. Returns None when no known
    issuer is found."""
    if not raw_memo:
        return None
    for pat, canonical in _CARD_ISSUER_PATTERNS:
        m = pat.search(raw_memo)
        if m:
            if canonical:
                return canonical
            # Dynamic patterns (auto-finance issuers) — build title-case
            # from the matched group.
            hit = m.group(0)
            words = re.split(r"\s+", hit.strip())
            titled = " ".join(w.capitalize() if w.isupper() else w for w in words)
            return titled
    return None


def _looks_like_person_name(cleaned: str) -> bool:
    """Return True when the cleaned payee string is shaped like a natural
    person's name (First [Middle] Last, no business-entity keywords).
    We only allow person-shaped inputs when they DON'T land under a
    liability parent — see `resolve_or_create_liability_subaccount`."""
    if not cleaned:
        return False
    if _BUSINESS_HINTS.search(cleaned):
        return False
    tokens = re.split(r"\s+", cleaned.strip())
    if not (2 <= len(tokens) <= 4):
        return False
    for t in tokens:
        # Middle initial "G." is OK; every other token must be all-alpha.
        if re.fullmatch(r"[A-Z]\.?", t):
            continue
        if not re.fullmatch(r"[A-Za-z][A-Za-z'\-]+", t):
            return False
    return True


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
    *,
    raw_memo: str | None = None,
) -> dict | None:
    """Given a parent liability account + a transaction payee, return the
    matching child sub-account (creating one if needed).

    Returns None if the payee is generic ("transfer", empty, etc.) OR if
    the cleaned payee looks like a natural person's name (a person can't
    legally hold a company credit-card / loan payable balance — spawning
    "Eimorlain Ugali" as a Current Liability sub-account is nonsense).
    When `raw_memo` is provided we FIRST try to extract a known card
    issuer / lender from the memo — that's the true payee on
    accountholder-driven ACH lines like "CITI CARD ONLINE DES:PAYMENT
    ID:XXX INDN:ACCOUNTHOLDER" where `payee` (contact_name) is the
    INDN individual, not the counterparty.
    """
    # 1. Prefer a KNOWN card issuer / lender extracted from the raw
    #    memo. This bypasses the accountholder-INDN trap entirely.
    clean: Optional[str] = None
    if raw_memo:
        issuer = _extract_card_issuer(raw_memo)
        if issuer:
            clean = issuer
    # 2. Fall back to cleaning the caller-supplied payee (contact_name
    #    or merchant).
    if not clean:
        clean = _clean_payee(payee)
    if not clean:
        return None
    # 3. Reject person-name shapes — a natural person is never the right
    #    label for a liability sub-account.
    if _looks_like_person_name(clean):
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
        # Inherit parent's Wave-style detail_type so the sub-account
        # renders in the same CoA section as its parent (Credit Card,
        # Loan and Line of Credit, etc.). Falls back to subtype for
        # legacy parents that predate the unification.
        "detail_type": parent_account.get("detail_type") or parent_account.get("subtype") or "",
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
    *,
    raw_memo: str | None = None,
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
        raw_memo=raw_memo or merchant,
    )
    if not child:
        return post
    post["category_account_id"] = child["id"]
    post["category_account_code"] = child.get("code")
    post["category_account_name"] = child.get("name")
    # If we picked the child via a card-issuer extraction that differs
    # from contact_name, flag the row for review so the CPA can decide
    # whether the ai-guessed counterparty is right.
    if raw_memo and _extract_card_issuer(raw_memo):
        post.setdefault("needs_review", True)
    return post


__all__ = [
    "GENERIC_LIABILITY_PARENT_PATTERNS",
    "is_parent_liability_bucket",
    "resolve_or_create_liability_subaccount",
    "maybe_route_to_liability_subaccount",
]
