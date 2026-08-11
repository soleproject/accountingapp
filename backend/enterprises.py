"""Enterprise (accounting-firm) model + helpers.

An `enterprise` is the billing/branding parent of one-or-more Pro users.
Every Pro belongs to exactly one enterprise. The platform-level default
enterprise is called **SmartBooks** — pros that sign up directly (no
private-label parent yet) live under it.

Data model (collection: `enterprises`):
    id                   str (uuid)
    name                 str                — display name ("SmartBooks", "PriyaBooks")
    slug                 str (unique)       — url-safe lower-case handle
    is_default           bool               — true for the SmartBooks platform enterprise
    owner_user_id        str | None         — pro user who owns this enterprise (None for default)
    free_user_allotment  int                — # of companies the enterprise can host free
    default_product      str                — simple_start | essentials | plus | advanced
    default_discount     bool               — apply the discounted price tier by default
    created_at           iso                — creation timestamp
    updated_at           iso                — last update timestamp
"""
from __future__ import annotations

from typing import Optional
import uuid

from db import db, now_iso


DEFAULT_SLUG = "smartbooks"
DEFAULT_NAME = "SmartBooks"

# Valid Stripe-mapped billing products (Phase A stores the choice; Phase C
# wires the Stripe price IDs).
BILLING_PRODUCTS = ("simple_start", "essentials", "plus", "advanced")

# Valid `billing_payer` values recorded on a company. `client_email` /
# `client_card` both mean "the client pays" — they differ only in how the
# card is captured (email an invoice vs the accountant enters the card in
# a form). `enterprise` = firm pays monthly consolidated on the 5th.
# `free_spot` = comp'd, no charge, no Stripe subscription.
BILLING_PAYERS = ("client_email", "client_card", "enterprise", "free_spot")

# Product catalog — regular and discounted USD prices per month. Phase C
# maps each (product, tier) to a Stripe Price ID via env vars, keyed as
# STRIPE_PRICE_<PRODUCT>_<TIER>.
PRICE_CATALOG = {
    "simple_start": {"regular": 38,  "discount": 30,  "label": "Simple Start"},
    "essentials":   {"regular": 75,  "discount": 60,  "label": "Essentials"},
    "plus":         {"regular": 97,  "discount": 78,  "label": "Plus"},
    "advanced":     {"regular": 149, "discount": 119, "label": "Advanced"},
}


import re as _re


def _slugify(text: str) -> str:
    s = _re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or "enterprise"


async def _resolve_unique_slug(base: str) -> str:
    """Return a slug that isn't already in use by another enterprise. If
    the caller's ideal `base` is taken (e.g. two firms both want
    "capstone"), we append `-2`, `-3`, ... until free."""
    slug = base
    for i in range(1, 50):
        if not await db.enterprises.find_one({"slug": slug}):
            return slug
        slug = f"{base}-{i + 1}"
    # Fallback — extremely unlikely; append the current epoch.
    from time import time
    return f"{base}-{int(time())}"


async def ensure_firm_books_company_for_pro(user_id: str) -> Optional[dict]:
    """Guarantee that a Pro user has a dedicated "Firm Books" company —
    their own accounting entity, separate from any client company they
    manage. Idempotent: if the pro already owns a company flagged
    `is_firm_books=True`, we return it unchanged.

    Rationale: an enterprise user (CPA / bookkeeping firm) needs to run
    the software against THEIR OWN books, not just their clients'. The
    Firm Books company lives at the top of their company switcher
    (grouped under a "Firm books" section) and cannot be accidentally
    deleted (guarded via `is_firm_books` in the delete endpoint).

    The company is created with:
      * name  = firm brand ("Northgate Advisory") + " — Firm Books"
      * business_type = "professional-services" (best-fit tax setup)
      * accounting_mode = "advanced" (CPAs want the full editor set)
      * is_firm_books  = True    (dropdown grouping + delete guard)
      * onboarding_complete = True (skip the onboarding wizard —
        firm owners don't need the "let's connect your bank" flow)
    """
    user = await db.users.find_one({"id": user_id, "role": "pro"})
    if not user:
        return None

    # Already have one? Return it as-is.
    existing = await db.companies.find_one({
        "owner_user_id": user_id,
        "is_firm_books": True,
    })
    if existing:
        return existing

    # Derive display name from the firm brand if set; fall back to the
    # user's name so "Priya Patel — Firm Books" still reads naturally
    # for a solo CPA who hasn't set a firm name.
    firm_name = ((user.get("branding") or {}).get("firm_name") or "").strip()
    display = f"{firm_name or user.get('name') or 'My Firm'} — Firm Books"

    now = now_iso()
    cid = str(uuid.uuid4())
    company = {
        "id": cid,
        "name": display,
        "business_type": "professional-services",
        "business_description": "Firm's own accounting books",
        "reporting_basis": "accrual",
        "accounting_mode": "advanced",
        "owner_user_id": user_id,
        "is_firm_books": True,
        "onboarding_complete": True,
        "created_at": now, "updated_at": now,
    }
    await db.companies.insert_one(company)
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id, "company_id": cid,
        "role": "owner", "created_at": now,
    })
    # Auto-provision default chart of accounts — same CoA every new
    # company gets on `POST /companies`, so the firm's books are usable
    # from second-one-of-existence.
    from seed import DEFAULT_COA
    for code, name, atype, subtype in DEFAULT_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": code, "name": name,
            "type": atype, "subtype": subtype, "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    return company


async def ensure_personal_enterprise_for_pro(user_id: str) -> Optional[dict]:
    """If the given Pro has a `branding.firm_name` set AND is still on
    the default SmartBooks enterprise (or has no enterprise_id at all),
    spawn a new Enterprise record OWNED BY THE PRO and move them onto it.

    Idempotent: if the pro already owns their own enterprise we return it
    unchanged. Returns the enterprise doc (or None if the pro has no
    firm_name to key off of).
    """
    user = await db.users.find_one({"id": user_id, "role": "pro"})
    if not user:
        return None
    firm_name = ((user.get("branding") or {}).get("firm_name") or "").strip()
    if not firm_name:
        return None

    # Already owns an enterprise? Re-use it and just keep the name synced.
    owned = await db.enterprises.find_one({"owner_user_id": user_id})
    if owned:
        if owned.get("name") != firm_name:
            await db.enterprises.update_one(
                {"id": owned["id"]},
                {"$set": {"name": firm_name, "updated_at": now_iso()}},
            )
            owned["name"] = firm_name
        # Make sure the user's `enterprise_id` points at their own record
        # (defensive — in case they were previously on the default).
        if user.get("enterprise_id") != owned["id"]:
            await db.users.update_one(
                {"id": user_id},
                {"$set": {"enterprise_id": owned["id"]}},
            )
        return owned

    # Otherwise mint a fresh enterprise. Slug preference: signin_subdomain
    # (nice URL match) → slugify(firm_name).
    b = user.get("branding") or {}
    base_slug = _slugify(b.get("signin_subdomain") or firm_name)
    slug = await _resolve_unique_slug(base_slug)
    now = now_iso()
    ent = {
        "id": str(uuid.uuid4()),
        "name": firm_name,
        "slug": slug,
        "is_default": False,
        "owner_user_id": user_id,
        # Inherit the default enterprise's allotment on birth so a new
        # private label doesn't unexpectedly start at 0 free spots.
        "free_user_allotment": 0,
        "default_product": "simple_start",
        "default_discount": False,
        "created_at": now,
        "updated_at": now,
    }
    await db.enterprises.insert_one(ent)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"enterprise_id": ent["id"]}},
    )
    return ent


async def ensure_default_enterprise() -> dict:
    """Guarantee the platform-default SmartBooks enterprise exists and every
    existing Pro is attached to it. Idempotent — safe to call on every boot.
    Also spawns personal enterprises for any Pro that has a branding
    firm_name set (deferred private-label migration).
    """
    now = now_iso()
    existing = await db.enterprises.find_one({"slug": DEFAULT_SLUG})
    if not existing:
        existing = {
            "id": str(uuid.uuid4()),
            "name": DEFAULT_NAME,
            "slug": DEFAULT_SLUG,
            "is_default": True,
            "owner_user_id": None,
            "free_user_allotment": 0,
            "default_product": "simple_start",
            "default_discount": False,
            "created_at": now,
            "updated_at": now,
        }
        await db.enterprises.insert_one(existing)

    # Back-fill every Pro without an enterprise_id → attach to default.
    await db.users.update_many(
        {"role": "pro", "enterprise_id": {"$in": [None, ""]}},
        {"$set": {"enterprise_id": existing["id"]}},
    )
    await db.users.update_many(
        {"role": "pro", "enterprise_id": {"$exists": False}},
        {"$set": {"enterprise_id": existing["id"]}},
    )

    # Then, for every Pro who has set a Private Label Name, promote them
    # onto their own Enterprise record + guarantee they have a Firm
    # Books company. Both helpers are idempotent, so re-running on
    # every boot is safe.
    branded_pros = await db.users.find(
        {"role": "pro", "branding.firm_name": {"$nin": [None, ""]}},
        {"_id": 0, "id": 1},
    ).to_list(1000)
    for p in branded_pros:
        try:
            await ensure_personal_enterprise_for_pro(p["id"])
        except Exception:
            import logging
            logging.getLogger(__name__).exception(
                "Failed to spawn personal enterprise for pro %s", p["id"],
            )
        try:
            await ensure_firm_books_company_for_pro(p["id"])
        except Exception:
            import logging
            logging.getLogger(__name__).exception(
                "Failed to spawn firm books company for pro %s", p["id"],
            )

    # Every Pro also gets a "Firm Books" company for their own
    # accounting — including those WITHOUT a private-label brand set
    # (solo CPAs who haven't customized their firm brand yet). The
    # helper is idempotent so this pass is cheap on every boot.
    all_pros = await db.users.find(
        {"role": "pro"}, {"_id": 0, "id": 1},
    ).to_list(5000)
    for p in all_pros:
        try:
            await ensure_firm_books_company_for_pro(p["id"])
        except Exception:
            import logging
            logging.getLogger(__name__).exception(
                "Firm books backfill failed for pro %s", p["id"],
            )

    return existing


async def ensure_indexes() -> None:
    await db.enterprises.create_index("slug", unique=True)
    await db.enterprises.create_index("is_default")


async def rollup_stats(enterprise_id: str) -> dict:
    """One-pass aggregation: how many pros / clients / companies does this
    enterprise host, and how many of its free spots are already consumed.

    All counts run in parallel because they hit different collections.
    """
    # Pros belonging to this enterprise.
    pro_ids = await db.users.distinct("id", {"role": "pro", "enterprise_id": enterprise_id})
    pros_count = len(pro_ids)

    # Companies where any of our pros has a `pro` membership.
    if pro_ids:
        company_ids = await db.memberships.distinct(
            "company_id", {"user_id": {"$in": pro_ids}, "role": "pro"}
        )
    else:
        company_ids = []
    companies_count = len(company_ids)

    # Distinct client owners across those companies.
    if company_ids:
        owner_ids = await db.memberships.distinct(
            "user_id", {"company_id": {"$in": company_ids}, "role": "owner"}
        )
    else:
        owner_ids = []
    clients_count = len(owner_ids)

    # Free spots consumed = # of companies where billing_payer=free_spot.
    free_used = await db.companies.count_documents({
        "id": {"$in": company_ids},
        "billing_payer": "free_spot",
    })

    return {
        "pros_count": pros_count,
        "clients_count": clients_count,
        "companies_count": companies_count,
        "free_used": free_used,
        "pro_ids": pro_ids,
        "company_ids": company_ids,
        "owner_ids": owner_ids,
    }


def serialize(ent: dict, *, stats: Optional[dict] = None) -> dict:
    """Public shape returned by the API. Never leaks Mongo `_id`."""
    out = {
        "id": ent["id"],
        "name": ent.get("name") or "",
        "slug": ent.get("slug") or "",
        "is_default": bool(ent.get("is_default")),
        "owner_user_id": ent.get("owner_user_id"),
        "free_user_allotment": int(ent.get("free_user_allotment") or 0),
        "default_product": ent.get("default_product") or "simple_start",
        "default_discount": bool(ent.get("default_discount")),
        "created_at": ent.get("created_at"),
        "updated_at": ent.get("updated_at"),
    }
    if stats is not None:
        out.update({
            "pros_count": stats["pros_count"],
            "clients_count": stats["clients_count"],
            "companies_count": stats["companies_count"],
            "free_used": stats["free_used"],
            "free_remaining": max(0, out["free_user_allotment"] - stats["free_used"]),
        })
    return out
