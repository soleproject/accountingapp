"""Lab-only liability sub-account proposer (Feb-2026).

Ports the auto-issue detection engine from the live pipeline
(`/app/backend/liability_subaccounts.py`) into the lab, but writes
proposed sub-accounts to the lab-only collection ``lab_pending_accounts``
instead of the live ``db.accounts`` collection. The lab pipeline stays
strictly read-only against live schemas.

Given a raw bank memo like:
    "CAPITAL ONE DES:MOBILE PMT ID:CA08... INDN:Michael F Giorgi WEB"
we:
    1. Extract a canonical issuer name ("Capital One Card") via the
       shared ``_extract_card_issuer`` regex table.
    2. Choose a parent liability bucket ("Credit Card Payable" for card
       issuers, "Loans Payable" for auto/mortgage lenders) — either
       matched to an existing live parent in ``chart_of_accounts`` OR
       proposed as a new pending parent under ``lab_pending_accounts``.
    3. Look for an existing pending child (or live child under the
       matched live parent). If found, return it. Otherwise create a
       new pending child.

When the CPA later "accepts" a pending account via the Compare-page
banner (Phase 4), a separate accept endpoint will insert the row into
live ``db.accounts`` and blank the pending doc — that flow lives
elsewhere; this module is purely proposal-side.
"""
from __future__ import annotations
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db
from liability_subaccounts import (
    _CARD_ISSUER_PATTERNS,
    _clean_payee,
    _extract_card_issuer,
    _looks_like_person_name,
    _norm,
    is_parent_liability_bucket,
)

log = logging.getLogger("axiom.lab.liability")

LAB_PENDING_ACCOUNTS = "lab_pending_accounts"


# Which parent bucket does this canonical issuer belong under?
# Names align with the ``GENERIC_LIABILITY_PARENT_PATTERNS`` regex table
# in the live module so `is_parent_liability_bucket()` accepts them.
_CARD_ISSUERS = frozenset({
    "American Express", "Citi Card", "Chase Card", "Capital One Card",
    "Bank of America Card", "Wells Fargo Card", "US Bank Card",
    "Discover", "Synchrony", "Barclays Card", "Best Buy Card",
    "Comenity Bank", "Apple Card", "PayPal Credit", "Affirm",
    "Klarna", "Afterpay", "Concora Credit", "Credit One Bank",
})
_LOAN_ISSUERS = frozenset({"Mr. Cooper", "Rocket Mortgage", "Ally Auto"})

# Bare car-brand names (no "Financial"/"Credit" suffix) that should
# still route under Loans Payable — e.g. Plaid returns just "Audi" as
# the merchant string on some auto-loan autopays.
_CAR_BRAND_RE = re.compile(
    r"^(audi|bmw|mercedes(?:[- ]benz)?|toyota|honda|ford|chrysler|"
    r"gm|chevrolet|nissan|volkswagen|vw|subaru|mazda|kia|hyundai|"
    r"lexus|acura|infiniti|volvo|tesla|porsche|jaguar|land[- ]rover|"
    r"mini|fiat|jeep|dodge|ram|buick|cadillac|lincoln)"
    r"(\s+(motor\s+)?(financial|finance|credit|capital|accept|leasing))?$",
    re.IGNORECASE,
)


def _parent_bucket_for_issuer(issuer: str) -> tuple[str, str, str]:
    """Return (parent_name, subtype, detail_type) for a canonical issuer.
    Auto-finance issuers (dynamic pattern, e.g. "Audi Financial Services"
    or bare "Audi") route to Loans Payable / long_term_liability.
    Everything else defaults to Credit Card Payable."""
    if issuer in _LOAN_ISSUERS:
        return "Loans Payable", "long_term_liability", "Loan and Line of Credit"
    if _CAR_BRAND_RE.match(issuer.strip()):
        return "Loans Payable", "long_term_liability", "Loan and Line of Credit"
    return "Credit Card Payable", "credit_card", "Credit Card"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _find_live_parent(
    company_id: str, parent_name: str, live_parents: list[dict],
) -> Optional[dict]:
    """Return a live liability parent bucket whose name matches
    ``parent_name`` (via ``is_parent_liability_bucket``)."""
    for p in live_parents:
        if not is_parent_liability_bucket(p):
            continue
        if _norm(p.get("name")) == _norm(parent_name):
            return p
    return None


async def _find_or_propose_parent(
    company_id: str, parent_name: str, subtype: str, detail_type: str,
    live_parents: list[dict], pending_parents_cache: dict,
) -> dict:
    """Return either the live parent doc (from chart_of_accounts) or a
    pending parent doc (from ``lab_pending_accounts``). Creates the
    pending parent on first miss and caches it in memory for this run.

    The returned doc always has ``id``, ``name``, ``type``,
    ``is_pending`` (True/False), and a ``code`` field. Pending parents
    are auto-numbered based on the type (2100 for CC, 2500 for Loans).
    """
    live = await _find_live_parent(company_id, parent_name, live_parents)
    if live:
        return {**live, "is_pending": False}

    key = _norm(parent_name)
    if key in pending_parents_cache:
        return pending_parents_cache[key]

    # Check if the pending parent already exists in Mongo (idempotent re-run).
    existing = await db[LAB_PENDING_ACCOUNTS].find_one({
        "company_id":       company_id,
        "is_parent_bucket": True,
        "normalized_name":  key,
    })
    if existing:
        pending_parents_cache[key] = {**existing, "is_pending": True}
        return pending_parents_cache[key]

    default_code = "2100" if subtype == "credit_card" else "2500"
    doc = {
        "id":               str(uuid.uuid4()),
        "company_id":       company_id,
        "code":             default_code,
        "name":             parent_name,
        "normalized_name":  key,
        "type":             "liability",
        "subtype":          subtype,
        "detail_type":      detail_type,
        "parent_account_id": None,
        "parent_pending_id": None,
        "is_parent_bucket": True,
        "system_generated": True,
        "source":           "lab_auto",
        "status":           "proposed",
        "created_at":       _now_iso(),
        "updated_at":       _now_iso(),
    }
    await db[LAB_PENDING_ACCOUNTS].insert_one(doc)
    pending_parents_cache[key] = {**doc, "is_pending": True}
    return pending_parents_cache[key]


async def _next_pending_child_code(
    company_id: str, parent: dict, pending_children_cache: dict,
) -> str:
    """+10 stride under the parent code, checking BOTH live accounts and
    already-issued pending accounts so we don't collide."""
    try:
        base = int(parent.get("code") or "0")
    except (TypeError, ValueError):
        return f"{parent.get('code','')}-sub"

    used: set[int] = set()
    async for a in db.accounts.find(
        {"company_id": company_id}, {"code": 1, "_id": 0},
    ):
        try:
            used.add(int(a.get("code")))
        except (TypeError, ValueError):
            pass
    async for a in db[LAB_PENDING_ACCOUNTS].find(
        {"company_id": company_id}, {"code": 1, "_id": 0},
    ):
        try:
            used.add(int(a.get("code")))
        except (TypeError, ValueError):
            pass
    for c in pending_children_cache.values():
        try:
            used.add(int(c.get("code")))
        except (TypeError, ValueError):
            pass

    for step in (10, 1):
        code = base + step
        while code < base + 900:
            if code not in used and code != base:
                return str(code)
            code += step
    return str(base + 900)


async def resolve_or_propose_lab_liability_subaccount(
    company_id: str,
    *,
    raw_memo: Optional[str],
    contact_name: Optional[str],
    live_parents: list[dict],
    live_children_by_parent: dict[str, list[dict]],
    pending_parents_cache: dict,
    pending_children_cache: dict,
    strict_person_filter: bool = False,
) -> Optional[dict]:
    """Return a resolved parent+child pair for a credit-line payment row.

    Output shape:
        {
          "child": <account-like dict, either live or pending>,
          "child_is_pending": bool,
          "parent": <account-like dict>,
          "parent_is_pending": bool,
        }
    or None when the memo can't be resolved (generic transfer, person
    name, no issuer match, no clean payee).

    When ``strict_person_filter=False`` (default when called from
    Step 7's credit_line_payment path) the person-name guard is bypassed
    for names that already survived Plaid's LOAN_PAYMENTS classification
    — otherwise legit 2-token retailers like "Best Buy" get rejected
    for looking person-shaped.
    """
    # 1. Extract canonical issuer from raw memo (bypasses INDN trap).
    clean: Optional[str] = None
    if raw_memo:
        issuer = _extract_card_issuer(raw_memo)
        if issuer:
            clean = issuer
    if not clean:
        clean = _clean_payee(contact_name or raw_memo)
    if not clean:
        return None
    if strict_person_filter and _looks_like_person_name(clean):
        return None
    # Even with the guard relaxed, still reject obvious INDN-shaped
    # accountholder names (e.g. "Michael F Giorgi", "Eimorlain G Ugali")
    # — those have 3+ tokens and no business hints, which the strict
    # person-name matcher already covers even outside strict mode.
    if _looks_like_person_name(clean) and len(clean.split()) >= 3:
        return None

    # 2. Choose the parent bucket.
    parent_name, subtype, detail_type = _parent_bucket_for_issuer(clean)
    parent = await _find_or_propose_parent(
        company_id, parent_name, subtype, detail_type,
        live_parents, pending_parents_cache,
    )
    parent_is_pending = parent.get("is_pending", False)

    # 3. Look for an existing child under the parent, live or pending.
    key = _norm(clean)
    if not parent_is_pending:
        for c in live_children_by_parent.get(parent["id"], []):
            n = _norm(c.get("name"))
            if n == key or (key in n) or (n and n in key):
                return {"child": c, "child_is_pending": False,
                        "parent": parent, "parent_is_pending": False}

    # Check pending children (cross-run persistence).
    pending_children_cache_key = (parent["id"], key)
    if pending_children_cache_key in pending_children_cache:
        return {
            "child": pending_children_cache[pending_children_cache_key],
            "child_is_pending": True,
            "parent": parent,
            "parent_is_pending": parent_is_pending,
        }
    existing = await db[LAB_PENDING_ACCOUNTS].find_one({
        "company_id":       company_id,
        "is_parent_bucket": False,
        "$or": [
            {"parent_account_id": parent["id"]},
            {"parent_pending_id": parent["id"]},
        ],
        "normalized_name":  key,
    })
    if existing:
        pending_children_cache[pending_children_cache_key] = existing
        return {"child": existing, "child_is_pending": True,
                "parent": parent, "parent_is_pending": parent_is_pending}

    # 4. Create a new pending child.
    code = await _next_pending_child_code(
        company_id, parent, pending_children_cache,
    )
    doc = {
        "id":               str(uuid.uuid4()),
        "company_id":       company_id,
        "code":             code,
        "name":             clean,
        "normalized_name":  key,
        "type":             parent.get("type") or "liability",
        "subtype":          parent.get("subtype"),
        "detail_type":      parent.get("detail_type"),
        "parent_account_id": None if parent_is_pending else parent["id"],
        "parent_pending_id": parent["id"] if parent_is_pending else None,
        "parent_name":      parent.get("name"),
        "is_parent_bucket": False,
        "system_generated": True,
        "source":           "lab_auto",
        "status":           "proposed",
        "created_at":       _now_iso(),
        "updated_at":       _now_iso(),
    }
    await db[LAB_PENDING_ACCOUNTS].insert_one(doc)
    pending_children_cache[pending_children_cache_key] = doc
    return {"child": doc, "child_is_pending": True,
            "parent": parent, "parent_is_pending": parent_is_pending}


async def load_lab_liability_context(company_id: str) -> dict:
    """Pre-load once per pipeline run: live liability parents in the
    CoA, and their existing children. Returns the caches Step 7 threads
    through per-row."""
    live_parents: list[dict] = []
    async for a in db.chart_of_accounts.find(
        {"company_id": company_id, "type": "liability"},
        {"_id": 0, "id": 1, "code": 1, "name": 1, "type": 1,
         "subtype": 1, "detail_type": 1, "parent_account_id": 1},
    ):
        live_parents.append(a)

    live_children_by_parent: dict[str, list[dict]] = {}
    for p in live_parents:
        live_children_by_parent[p["id"]] = [
            c for c in live_parents if c.get("parent_account_id") == p["id"]
        ]

    return {
        "live_parents":           live_parents,
        "live_children_by_parent": live_children_by_parent,
        "pending_parents_cache":  {},
        "pending_children_cache": {},
    }


async def reset_pending_accounts(company_id: str) -> int:
    """Drop all still-proposed pending accounts for this company.
    Called at the start of each pipeline run so re-runs re-issue codes
    deterministically. Accepted accounts (status != 'proposed') are
    preserved so the CPA's approvals aren't erased."""
    res = await db[LAB_PENDING_ACCOUNTS].delete_many({
        "company_id": company_id,
        "status":     "proposed",
    })
    return res.deleted_count
