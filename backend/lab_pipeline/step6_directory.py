"""Step 6 — Merchant directory (per-company).

For every unique contact discovered in Step 5, decide the *merchant type*
so Step 7 (category) and Step 8 (review reasons) can route deterministically.

Determination order:
    1. Movement-driven auto-types (from Step 4): payment_app for
       payment_app_transfer, credit_card for credit_line_payment. These
       come "free" from Phase 1 output.
    2. Hardcoded exact-name lookup — payment apps, credit-card issuers,
       big banks / lenders, government, payroll processors, utilities.
    3. Plaid PFC.primary hints:
       - GOVERNMENT_AND_NON_PROFIT → government
       - LOAN_PAYMENTS             → bank_lender
       - RENT_AND_UTILITIES        → utility  (only if not already flagged multi_purpose)
       - INCOME (with description = "PAYROLL"/"DIRECT DEP" from an employer)
         → not a merchant, leave alone
    4. Plaid `counterparties[].type` — Plaid tells us `payment_app`
       explicitly.
    5. Fallback: `merchant` (single-purpose) when the contact is a
       recognized business, `individual` for person names, `unknown`
       otherwise.

LLM is intentionally NOT called here — Phase 3 caps its LLM burn at
Step 7 (category_fits). Merchant type is deterministic-only per the
Feb-2026 scope reduction.

Per-company directory row lives in ``lab_directory_labels`` keyed on
``(company_id, directory_key)`` where ``directory_key`` is the
normalized contact name.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from db import db
from .collections import LAB_TRANSACTIONS, LAB_DIRECTORY_LABELS
from contact_resolver import normalize_contact_name

log = logging.getLogger("axiom.lab.step6")

# --- hardcoded exact / prefix lookup ------------------------------------
# All keys are pre-normalized (lower, corp suffixes stripped) so a lookup
# is one dict hit. Extend cautiously — additions should be truly platform-
# level well-known brands. Anything company-specific belongs in the
# per-company directory row, not here.

_PAYMENT_APPS = {
    "paypal", "venmo", "cash app", "cashapp", "square cash",
    "zelle", "apple pay", "apple cash", "google pay",
    "wise", "revolut",
}

_CREDIT_CARDS = {
    "american express", "amex", "chase", "citi", "citibank",
    "capital one", "discover", "synchrony", "bank of america",
    "wells fargo",
}

_BANK_LENDERS = {
    "rocket mortgage", "mr. cooper", "mr cooper", "wells fargo home mortgage",
    "chase mortgage", "quicken loans", "bank of america mortgage",
    "sallie mae", "navient", "nelnet", "everett financial",
    "audi financial", "audi financial services", "toyota financial",
    "ford motor credit", "gm financial",
}

_GOVERNMENT = {
    "irs", "internal revenue service", "eftps",
    "franchise tax board", "state of nevada dmv", "city of sparks",
    "city of reno", "nv dmv", "dmv",
    "social security administration", "us treasury",
}

_PAYROLL = {
    "gusto", "adp payroll", "adp tax", "adp inc", "adp",
    "paychex", "paychex inc", "quickbooks payroll",
    "intuit payroll", "onpay",
}

_UTILITIES = {
    "at&t", "att", "verizon", "t-mobile", "tmobile", "comcast",
    "xfinity", "nv energy", "cox communications", "spectrum",
    "sparklight",
}

# Common multi-purpose merchants that shouldn't be forced into a single
# category. Copied conservatively from your Step 3 approved list.
_MULTI_PURPOSE = {
    "walmart", "costco", "amazon", "target", "sam's club", "sams club",
    "bj's wholesale", "bjs wholesale", "kroger", "safeway", "whole foods",
    "home depot", "lowe's", "lowes", "best buy",
}


# Merchant types Step 8 treats as sensitive when seen for the first time
# on a company. Insurance and credit_card are intentionally excluded per
# the Feb-2026 scope cut.
SENSITIVE_MERCHANT_TYPES: frozenset[str] = frozenset({
    "bank_lender", "government", "payroll",
})


def _classify_deterministic(name: str,
                             movement_type: str | None,
                             pfc_primary: str | None,
                             counterparties: list[dict] | None,
                             contact_source: str | None = None) -> tuple[str, str]:
    """Return (merchant_type, reason). Never invokes an LLM."""
    # Step-5-driven bank-fee attribution short-circuits everything else.
    if contact_source == "bank_fee":
        return "bank_fee", "contact_source=bank_fee (Step 5)"
    n = normalize_contact_name(name or "")
    if not n:
        return "unknown", "empty name"

    # 1. Movement hints from Step 4.
    if movement_type == "payment_app_transfer":
        return "payment_app", "movement_type=payment_app_transfer"
    if movement_type == "credit_line_payment":
        return "credit_card", "movement_type=credit_line_payment"

    # 2. Hardcoded lookup.
    if n in _PAYMENT_APPS:
        return "payment_app", "hardcoded payment_apps"
    if n in _CREDIT_CARDS:
        return "credit_card", "hardcoded credit_cards"
    if n in _BANK_LENDERS:
        return "bank_lender", "hardcoded bank_lenders"
    if n in _GOVERNMENT:
        return "government", "hardcoded government"
    if n in _PAYROLL:
        return "payroll", "hardcoded payroll"
    if n in _UTILITIES:
        return "utility", "hardcoded utilities"
    if n in _MULTI_PURPOSE:
        return "multi_purpose", "hardcoded multi_purpose"

    # 3. Plaid PFC.primary hints (deterministic).
    pfc = (pfc_primary or "").strip().upper()
    if pfc in ("GOVERNMENT_AND_NON_PROFIT",):
        return "government", "pfc.primary=GOVERNMENT_AND_NON_PROFIT"
    if pfc in ("LOAN_PAYMENTS",):
        return "bank_lender", "pfc.primary=LOAN_PAYMENTS"
    if pfc in ("RENT_AND_UTILITIES",):
        return "utility", "pfc.primary=RENT_AND_UTILITIES"

    # 4. Plaid counterparties[] type=payment_app.
    for cp in (counterparties or []):
        if (cp.get("type") or "").lower() == "payment_app":
            return "payment_app", f"plaid counterparty type=payment_app ({cp.get('name')})"

    # 5. Fallback — heuristic between "merchant" (business) and "individual".
    #    Same signal used elsewhere: presence of a corp-suffix marker.
    business_markers = (" llc", " inc", " corp", " co", " ltd", " company",
                        " services", " group", " holdings", " capital",
                        " partners", " enterprises", " consulting")
    padded = f" {n} "
    if any(m in padded for m in business_markers):
        return "merchant", "business-suffix heuristic"
    # Person-name heuristic: two tokens, first is a plausible first name.
    tokens = [t for t in n.split() if len(t) > 1]
    if 2 <= len(tokens) <= 4 and not any(m.strip() == tokens[-1] for m in business_markers):
        # Two capitalized words: likely a person. But we can't verify —
        # leave as `unknown` so Step 8 routes it to
        # unidentified_counterparty rather than mis-tagging.
        return "individual", "two-token name heuristic"
    return "unknown", "no deterministic signal"


async def run_step6(company_id: str) -> dict:
    """Iterate every ``lab_transactions`` row for the company, compute
    merchant_type per unique contact, and stamp both the transaction
    (``merchant_type``) AND the directory row (``lab_directory_labels``).

    Idempotent — safe to re-run. Never writes to live collections.
    """
    now = datetime.now(timezone.utc).isoformat()

    # Aggregate signals per contact key.
    directory: dict[str, dict] = {}
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id},
        {"contact": 1, "contact_id_lab": 1, "movement_type": 1,
         "contact_source": 1,
         "raw": 1, "channel": 1, "amount": 1},
    ):
        name = (r.get("contact") or "").strip()
        if not name:
            continue
        key = normalize_contact_name(name)
        if not key:
            continue
        d = directory.setdefault(key, {
            "name":            name,
            "normalized_name": key,
            "txn_count":       0,
            "movement_types":  set(),
            "contact_sources": set(),
            "pfc_primaries":   set(),
            "counterparties":  [],
            "sample_txn_id":   None,
            "amount_sum":      0.0,
        })
        d["txn_count"] += 1
        d["amount_sum"] += float(r.get("amount") or 0)
        if r.get("movement_type"):
            d["movement_types"].add(r["movement_type"])
        if r.get("contact_source"):
            d["contact_sources"].add(r["contact_source"])
        raw = r.get("raw") or {}
        pfc = (raw.get("pfc_primary") or "")
        if pfc:
            d["pfc_primaries"].add(pfc)
        for cp in (raw.get("counterparties") or []):
            if isinstance(cp, dict) and cp not in d["counterparties"]:
                d["counterparties"].append(cp)
        if not d["sample_txn_id"]:
            d["sample_txn_id"] = r.get("txn_id")

    # Classify each directory entry.
    dist: dict[str, int] = {}
    for key, d in directory.items():
        movement = next(iter(d["movement_types"]), None)
        pfc      = next(iter(d["pfc_primaries"]), None)
        # bank_fee source overrides everything (fix #3).
        c_source = "bank_fee" if "bank_fee" in d["contact_sources"] else None
        mtype, reason = _classify_deterministic(
            d["name"], movement, pfc, d["counterparties"], c_source,
        )
        d["merchant_type"] = mtype
        d["merchant_type_reason"] = reason
        dist[mtype] = dist.get(mtype, 0) + 1

        await db[LAB_DIRECTORY_LABELS].update_one(
            {"directory_key": f"{company_id}::{key}"},
            {"$set": {
                "directory_key":       f"{company_id}::{key}",
                "company_id":          company_id,
                "name":                d["name"],
                "normalized_name":     key,
                "merchant_type":       mtype,
                "merchant_type_reason": reason,
                "txn_count":           d["txn_count"],
                "amount_sum":          round(d["amount_sum"], 2),
                "sample_txn_id":       d["sample_txn_id"],
                "status":              "candidate",   # promotion is a future step
                "updated_at":          now,
             },
             "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

        # Stamp merchant_type onto every lab_transactions row for this
        # contact — Step 7 and Step 8 read it directly rather than a
        # second directory lookup.
        await db[LAB_TRANSACTIONS].update_many(
            {"company_id": company_id, "contact": d["name"]},
            {"$set": {"merchant_type": mtype,
                      "merchant_type_reason": reason}},
        )

    return {
        "directory_entries":       len(directory),
        "merchant_type_distribution": dist,
    }
