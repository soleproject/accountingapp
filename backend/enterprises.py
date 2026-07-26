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


async def ensure_default_enterprise() -> dict:
    """Guarantee the platform-default SmartBooks enterprise exists and every
    existing Pro is attached to it. Idempotent — safe to call on every boot.
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

    # Back-fill every Pro without an enterprise_id → attach to default. This
    # is a one-shot migration effect: pros created before enterprises existed
    # get slotted into SmartBooks. Once we build the "Move Pro" UI (Phase B+)
    # a superadmin can reassign them.
    await db.users.update_many(
        {"role": "pro", "enterprise_id": {"$in": [None, ""]}},
        {"$set": {"enterprise_id": existing["id"]}},
    )
    await db.users.update_many(
        {"role": "pro", "enterprise_id": {"$exists": False}},
        {"$set": {"enterprise_id": existing["id"]}},
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
