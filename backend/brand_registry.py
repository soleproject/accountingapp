"""Brand Registry — platform-wide directory of known merchants/brands.

Scope (Feb 2026): shared, platform-level. Entries are proposed by the
Review v2 pipeline (either seeded by an admin or auto-suggested when
the LLM identifies a new merchant during audit-preview) and only take
effect once an admin approves them.

Three separate signals — do NOT conflate:
  • ``brand_registry.status``       — candidate | approved | rejected
  • ``contacts.well_known``         — platform-wide fact: matches an
                                      APPROVED registry entry
  • ``contacts.recognized``         — per-company fact: this company
                                      has a CPA/client-confirmed rule
  • ``transactions.verified`` (+ verification_reason / review_reason)
                                      — per-transaction outcome from
                                      the classifier

merchant_type taxonomy (drives Step 3 review rules — see
``routes/reviewv2.py``):

    merchant         — regular business vendor (booked normally)
    multi_purpose    — Walmart / Costco / Amazon / Target style
    payment_app      — PayPal / Venmo / Cash App / Zelle host
    bank_lender      — banks that also lend (loan payments, transfers)
    credit_card      — card issuer (payments = liability, not expense)
    government       — IRS / DMV / SoS / municipality (always review)
    insurance        — carriers, brokers
    utility          — power / water / gas / telco / internet

Fields:
    id, canonical_name, aliases[], merchant_type, category_hint (str),
    mcc[] (optional list of Merchant Category Codes),
    refunds_expected (bool), source (plaid_seed | admin |
    cpa_confirmed | llm_proposed), status, notes,
    proposed_by, proposed_at, approved_by, approved_at
"""
from __future__ import annotations
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db

log = logging.getLogger("axiom.brand_registry")

MERCHANT_TYPES = {
    "merchant", "multi_purpose", "payment_app", "bank_lender",
    "credit_card", "government", "insurance", "utility",
}

# merchant_types that are always sensitive — Step 3 review rules will
# force review regardless of match. Kept here as the single source of
# truth so the classifier and the review-rules engine agree.
SENSITIVE_MERCHANT_TYPES = frozenset({
    "payment_app", "bank_lender", "credit_card", "government",
})

# Curated admin-seed entries. Kept intentionally small — the rest come
# from Plaid enrichment + LLM proposals across live tenants. Every seed
# starts `status=approved, source=admin`.
_ADMIN_SEED = [
    # Multi-purpose retailers (Step 3 flag threshold applies)
    ("Walmart",        ["walmart", "wal-mart", "wal mart", "wm supercenter"],
                       "multi_purpose", "Office Supplies", True),
    ("Costco",         ["costco", "costco wholesale", "costco whse"],
                       "multi_purpose", "Office Supplies", True),
    ("Amazon",         ["amazon", "amzn", "amzn mktp", "amazon.com",
                        "amazon marketplace", "amazon prime"],
                       "multi_purpose", "Office Supplies", True),
    ("Target",         ["target", "target.com"],
                       "multi_purpose", "Office Supplies", True),
    ("Sam's Club",     ["sam's club", "sams club", "samsclub"],
                       "multi_purpose", "Office Supplies", True),
    ("BJ's Wholesale", ["bj's wholesale", "bjs wholesale", "bjs"],
                       "multi_purpose", "Office Supplies", True),

    # Payment apps
    ("PayPal",  ["paypal", "paypal inst xfer", "paypalsi77"],
                "payment_app", None, False),
    ("Venmo",   ["venmo"], "payment_app", None, False),
    ("Cash App",["cash app", "cashapp", "square cash"], "payment_app", None, False),
    ("Zelle",   ["zelle"], "payment_app", None, False),
    ("Stripe",  ["stripe"], "payment_app", None, False),
    ("Square",  ["square inc", "sq *", "squareup"], "payment_app", None, False),

    # Card issuers (payments = liability, not expense)
    ("American Express", ["american express", "amex", "amex epayment"],
                         "credit_card", None, False),
    ("Chase Card",       ["chase card", "chase credit", "jpmorgan chase card"],
                         "credit_card", None, False),
    ("Capital One",      ["capital one", "capital one crcard", "cap one"],
                         "credit_card", None, False),
    ("Citi Card",        ["citi card", "citicards", "citictp"],
                         "credit_card", None, False),
    ("Discover",         ["discover", "discover card"],
                         "credit_card", None, False),

    # Government
    ("IRS",             ["irs", "irs usataxpymt", "united states treasury"],
                        "government", None, False),
    ("EFTPS",           ["eftps"], "government", None, False),

    # Utilities (representative — LLM will extend for the rest)
    ("AT&T",            ["at&t", "att", "at&t mobility"], "utility",
                        "Utilities-Telephone", False),
    ("Verizon",         ["verizon", "vzw", "verizon wireless"], "utility",
                        "Utilities-Telephone", False),
    ("T-Mobile",        ["t-mobile", "tmobile"], "utility",
                        "Utilities-Telephone", False),
    ("Comcast",         ["comcast", "xfinity"], "utility",
                        "Utilities-Internet", False),
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(s: str | None) -> str:
    """Loose match key — lowercase, collapse whitespace, strip
    punctuation except & and '. Registry lookups always go through
    this."""
    if not s:
        return ""
    s = s.strip().lower()
    s = re.sub(r"[\s]+", " ", s)
    s = re.sub(r"[^\w&' ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


async def ensure_indexes() -> None:
    """Idempotent index creation for the brand registry collection.

    Unique on ``canonical_key`` (norm(canonical_name)) so we never
    double-insert the same brand from concurrent LLM proposals; a
    multikey index on ``alias_keys`` (norm applied to every alias)
    powers the fast-path lookup used by the classifier.
    """
    await db.brand_registry.create_index(
        [("canonical_key", 1)], unique=True, name="uk_canonical_key",
    )
    await db.brand_registry.create_index(
        [("alias_keys", 1)], name="idx_alias_keys",
    )
    await db.brand_registry.create_index(
        [("status", 1)], name="idx_status",
    )
    await db.brand_registry.create_index(
        [("merchant_type", 1), ("status", 1)],
        name="idx_type_status",
    )

    # Cache of LLM classification results (see brand_llm.py).
    await db.brand_llm_cache.create_index(
        [("cache_key", 1)], unique=True, name="uk_cache_key",
    )
    await db.brand_llm_cache.create_index(
        [("kind", 1), ("created_at", -1)],
        name="idx_kind_created",
    )

    # Shadow-mode diffs from contact_resolver (Step 2 read-only).
    await db.contact_resolver_shadow.create_index(
        [("company_id", 1), ("created_at", -1)],
        name="idx_shadow_company_created",
    )
    await db.contact_resolver_shadow.create_index(
        [("kind", 1)], name="idx_shadow_kind",
    )


async def seed_admin_defaults() -> int:
    """Idempotent seed of the curated admin entries. Returns count of
    NEW rows inserted (existing entries left untouched — including
    their status)."""
    inserted = 0
    for canonical, aliases, mtype, category_hint, refunds in _ADMIN_SEED:
        key = _norm(canonical)
        if await db.brand_registry.find_one({"canonical_key": key}):
            continue
        alias_set = {_norm(a) for a in aliases if _norm(a)}
        alias_set.add(key)
        doc = {
            "id":              str(uuid.uuid4()),
            "canonical_name":  canonical,
            "canonical_key":   key,
            "aliases":         list(aliases),
            "alias_keys":      sorted(alias_set),
            "merchant_type":   mtype,
            "category_hint":   category_hint,
            "mcc":             [],
            "refunds_expected": bool(refunds),
            "source":          "admin",
            "status":          "approved",
            "approved_by":     "system:admin_seed",
            "approved_at":     _now_iso(),
            "created_at":      _now_iso(),
        }
        try:
            await db.brand_registry.insert_one(doc)
            inserted += 1
        except Exception as e:  # noqa: BLE001 — dupe races are fine
            log.debug("brand_registry seed insert skipped: %s", e)
    if inserted:
        log.info("brand_registry: seeded %d admin entries", inserted)
    return inserted


async def lookup(name: str | None, *, statuses: tuple[str, ...] = ("approved",)) -> Optional[dict]:
    """Return the registry row matching ``name`` (canonical or alias),
    scoped to the requested statuses. None when no match."""
    key = _norm(name)
    if not key:
        return None
    doc = await db.brand_registry.find_one({
        "$or": [{"canonical_key": key}, {"alias_keys": key}],
        "status": {"$in": list(statuses)},
    })
    return doc


async def lookup_many(names: list[str], *,
                      statuses: tuple[str, ...] = ("approved",)) -> dict[str, dict]:
    """Batch lookup — returns ``{original_name: registry_doc}`` for
    every hit. Missing keys are simply absent from the returned dict.
    """
    keys = {n: _norm(n) for n in names if _norm(n)}
    if not keys:
        return {}
    all_keys = set(keys.values())
    hits: dict[str, dict] = {}
    async for doc in db.brand_registry.find({
        "$or": [
            {"canonical_key": {"$in": list(all_keys)}},
            {"alias_keys":    {"$in": list(all_keys)}},
        ],
        "status": {"$in": list(statuses)},
    }):
        matched_keys = {doc.get("canonical_key")} | set(doc.get("alias_keys") or [])
        for orig, k in keys.items():
            if k in matched_keys and orig not in hits:
                hits[orig] = doc
    return hits


async def propose_candidate(
    *,
    canonical_name: str,
    aliases: list[str],
    merchant_type: str,
    category_hint: str | None,
    proposed_by: str,
    llm_reason: str | None = None,
    llm_model: str | None = None,
) -> dict:
    """Insert (or fetch) a candidate registry entry. Status is always
    ``candidate`` — an admin flips it to ``approved`` later. Idempotent
    on ``canonical_key``.

    Adds any new aliases to an existing row (even an approved one) so
    the registry accretes coverage without needing an admin every
    time a bank uses a new descriptor.
    """
    if merchant_type not in MERCHANT_TYPES:
        merchant_type = "merchant"
    key = _norm(canonical_name)
    if not key:
        raise ValueError("canonical_name is required")

    existing = await db.brand_registry.find_one({"canonical_key": key})
    all_alias_keys = {_norm(a) for a in aliases if _norm(a)}
    all_alias_keys.add(key)

    if existing:
        new_keys = all_alias_keys - set(existing.get("alias_keys") or [])
        if new_keys:
            merged_aliases = list({*(existing.get("aliases") or []), *aliases, canonical_name})
            merged_keys = sorted(set(existing.get("alias_keys") or []) | all_alias_keys)
            await db.brand_registry.update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "aliases":     merged_aliases,
                    "alias_keys":  merged_keys,
                    "updated_at":  _now_iso(),
                }},
            )
            existing["aliases"]    = merged_aliases
            existing["alias_keys"] = merged_keys
        return existing

    doc = {
        "id":              str(uuid.uuid4()),
        "canonical_name":  canonical_name,
        "canonical_key":   key,
        "aliases":         list({*aliases, canonical_name}),
        "alias_keys":      sorted(all_alias_keys),
        "merchant_type":   merchant_type,
        "category_hint":   category_hint,
        "mcc":             [],
        "refunds_expected": merchant_type in {"merchant", "multi_purpose"},
        "source":          "llm_proposed",
        "status":          "candidate",
        "proposed_by":     proposed_by,
        "proposed_at":     _now_iso(),
        "llm_reason":      llm_reason,
        "llm_model":       llm_model,
        "created_at":      _now_iso(),
    }
    try:
        await db.brand_registry.insert_one(doc)
    except Exception as e:  # noqa: BLE001 — dupe races
        log.debug("brand_registry candidate insert dupe: %s", e)
        return await db.brand_registry.find_one({"canonical_key": key}) or doc
    return doc


async def counts_by_status() -> dict[str, int]:
    """Convenience — return {status: count} across the whole registry."""
    out: dict[str, int] = {}
    async for row in db.brand_registry.aggregate([
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]):
        out[row["_id"] or "unknown"] = row["n"]
    return out
