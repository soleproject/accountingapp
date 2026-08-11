"""Partner role — the "reseller" tier that sits between Superadmin and
the Pro/Enterprise/Client trees (see the hierarchy diagram in PRD).

Partners are stepped-up Pros: they inherit every Pro capability
(managing client books, Partner Books = same protection semantics as
Firm Books) AND gain Enterprise-management privileges scoped to only
the enterprises + clients they created. Partners CANNOT create
Superadmins and MUST NOT see data belonging to other Partners.

This module owns:
  * `ensure_partner_books_company_for_partner(user_id)` — idempotent
    provisioning of the partner's own accounting books (mirrors
    `enterprises.ensure_firm_books_company_for_pro`).
  * `serialize(partner, stats=…)` — narrow public shape (never leaks
    the password hash or private branding secrets).
  * `rollup_stats(partner_id)` — clients/enterprises/txn counts for
    the superadmin partners list view.

Data-model conventions the rest of the code base expects:
  * `users.role == "partner"` — the role gate.
  * `users.branding` on a partner user doc — same shape as pro/firm
    branding: `{firm_name, subdomain, logo_url, primary_color, …}`.
  * `companies.partner_id` — set on any client company / enterprise
    company that a Partner created. Superadmin-created companies have
    this UNSET so their data stays in the platform-wide bucket.
  * `companies.is_partner_books == True` — marks the partner's own
    books. Delete-guarded like `is_firm_books`.
  * `users.partner_id` — set on Pros/Enterprise-owners that a Partner
    provisioned; used to scope "my team" views.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db

logger = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# slug helpers (mirrors enterprises._slugify + _resolve_unique_slug for
# consistency — kept local so partners can migrate independently)
# --------------------------------------------------------------------------

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(raw: str) -> str:
    s = _SLUG_RE.sub("-", (raw or "").lower()).strip("-")
    return s[:60] or "partner"


async def resolve_unique_slug(base: str) -> str:
    """Return `base` if free, else append -2, -3, ... until unique."""
    candidate = base
    n = 2
    while await db.partners.find_one({"slug": candidate}):
        candidate = f"{base}-{n}"
        n += 1
        if n > 5000:  # pragmatic upper bound; should never hit
            from time import time
            return f"{base}-{int(time())}"
    return candidate


# --------------------------------------------------------------------------
# Partner Books — mirrors enterprises.ensure_firm_books_company_for_pro
# --------------------------------------------------------------------------

async def ensure_partner_books_company_for_partner(user_id: str) -> Optional[dict]:
    """Guarantee that a Partner has a dedicated "Partner Books" company —
    their own accounting entity, separate from any client/enterprise
    they resell to. Idempotent: if the partner already owns a company
    flagged `is_partner_books=True`, we return it as-is.

    Semantics (mirrors Firm Books):
      * Cannot be deleted without the `is_partner_books:false` override
        flag on the delete endpoint.
      * Auto-provisioned with the default chart of accounts and marked
        `onboarding_complete=True` so the partner doesn't get pushed
        through the "connect your bank" wizard for their own books.

    We look up by the flag first (fast path), then fall back to a
    name-suffix match to retro-stamp any legacy row that predates the
    flag — same defensive dedupe pattern Firm Books uses to prevent
    the 3-copies-in-the-dropdown bug we hit in production.
    """
    user = await db.users.find_one({"id": user_id, "role": "partner"})
    if not user:
        return None

    existing = await db.companies.find_one({
        "owner_user_id": user_id,
        "is_partner_books": True,
    })
    if existing:
        return existing
    legacy = await db.companies.find_one({
        "owner_user_id": user_id,
        "name": {"$regex": r"—\s*Partner Books\s*$"},
    })
    if legacy:
        await db.companies.update_one(
            {"id": legacy["id"]},
            {"$set": {"is_partner_books": True, "updated_at": now_iso()}},
        )
        legacy["is_partner_books"] = True
        return legacy

    partner_name = ((user.get("branding") or {}).get("firm_name") or "").strip()
    display = f"{partner_name or user.get('name') or 'My Partner'} — Partner Books"

    now = now_iso()
    cid = str(uuid.uuid4())
    company = {
        "id": cid,
        "name": display,
        "business_type": "professional-services",
        "business_description": "Partner's own accounting books",
        "reporting_basis": "accrual",
        "accounting_mode": "advanced",
        "owner_user_id": user_id,
        "partner_id": user_id,
        "is_partner_books": True,
        "onboarding_complete": True,
        "created_at": now, "updated_at": now,
    }
    await db.companies.insert_one(company)
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id, "company_id": cid,
        "role": "owner", "created_at": now,
    })
    # Chart of accounts seed — same DEFAULT_COA every new company gets
    # on POST /companies. Keeps the partner's books usable from
    # second-one-of-existence.
    from seed import DEFAULT_COA
    for code, name, atype, subtype in DEFAULT_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": code, "name": name,
            "type": atype, "subtype": subtype, "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    logger.info("Provisioned Partner Books %s for partner %s", cid, user_id)
    return company


# --------------------------------------------------------------------------
# Serialization + rollup
# --------------------------------------------------------------------------

def serialize(partner_user: dict, *, stats: Optional[dict] = None) -> dict:
    """Public shape for the Partners list + detail endpoints. Never
    leaks the password hash or internal-only fields."""
    branding = partner_user.get("branding") or {}
    return {
        "id": partner_user["id"],
        "email": partner_user["email"],
        "name": partner_user.get("name"),
        "role": partner_user.get("role"),
        "display_name": branding.get("firm_name") or partner_user.get("name"),
        "subdomain": branding.get("subdomain"),
        "primary_color": branding.get("primary_color"),
        "logo_url": branding.get("logo_url"),
        "must_set_password": bool(partner_user.get("must_set_password")),
        "created_at": partner_user.get("created_at"),
        "updated_at": partner_user.get("updated_at"),
        "stats": stats or {},
    }


async def rollup_stats(partner_id: str) -> dict:
    """Count the resources a partner owns / has provisioned. Used by
    the Superadmin Partners list card + the Partner's own dashboard.

    Counts are cheap Mongo `count_documents` calls (each hits an index
    on partner_id) — well under the 5 ms budget for a list card even
    at 100 partners.
    """
    clients = await db.companies.count_documents({
        "partner_id": partner_id,
        # Exclude the partner's own books from the client count so
        # "1 client, 0 enterprises" doesn't confusingly include the
        # Partner Books row.
        "is_partner_books": {"$ne": True},
    })
    enterprises = await db.enterprises.count_documents({"partner_id": partner_id})
    # Pros/end-users the partner has provisioned (not the partner
    # themselves — we filter by partner_id on OTHER users).
    linked_users = await db.users.count_documents({
        "partner_id": partner_id,
        "role": {"$ne": "partner"},
    })
    partner_books = await db.companies.find_one({
        "owner_user_id": partner_id, "is_partner_books": True,
    })
    return {
        "clients": clients,
        "enterprises": enterprises,
        "linked_users": linked_users,
        "has_partner_books": bool(partner_books),
        "partner_books_company_id": (partner_books or {}).get("id"),
    }
