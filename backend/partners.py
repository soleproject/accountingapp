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
    try:
        await db.companies.insert_one(company)
    except Exception as e:  # noqa: BLE001
        # DuplicateKeyError from the partial-unique index on
        # `(partner_id, is_partner_books)` — a concurrent request won
        # the race. Return the winning row instead of exploding.
        from pymongo.errors import DuplicateKeyError
        if isinstance(e, DuplicateKeyError):
            winner = await db.companies.find_one(
                {"partner_id": user_id, "is_partner_books": True},
            )
            if winner:
                return winner
        raise
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
        "status": partner_user.get("status"),  # "archived" | None (active)
        "archived_at": partner_user.get("archived_at"),
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



# --------------------------------------------------------------------------
# Financial rollups — real $-value Usage / Costs / Revenue scoped to the
# Partner's tree. Ties three sources together:


async def dedupe_partner_books_companies() -> int:
    """Startup housekeeping — collapse duplicate Partner Books rows
    to one per Partner. Mirrors the Firm Books dedupe in
    `enterprises.py`: keeps the oldest row (lowest `created_at`) and
    deletes the rest plus their child memberships/accounts.

    Concurrent-boot races were the historical source of dupes; the
    new partial-unique index on `(partner_id, is_partner_books)`
    prevents future occurrences, but any pre-existing dupes need
    this one-time cleanup.

    Returns the number of duplicate rows removed. Safe to run every
    boot — no-op when clean.
    """
    removed = 0
    pipeline = [
        {"$match": {"is_partner_books": True,
                    "partner_id": {"$ne": None}}},
        {"$group": {
            "_id": "$partner_id",
            "count": {"$sum": 1},
            "companies": {"$push": {"id": "$id", "created_at": "$created_at"}},
        }},
        {"$match": {"count": {"$gt": 1}}},
    ]
    async for row in db.companies.aggregate(pipeline):
        cos = sorted(
            row["companies"],
            key=lambda c: c.get("created_at") or "",
        )
        keep_id = cos[0]["id"]
        drop_ids = [c["id"] for c in cos[1:]]
        if not drop_ids:
            continue
        for _coll in ("memberships", "accounts", "transactions",
                      "journal_entries", "invoices", "bills"):
            try:
                await getattr(db, _coll).delete_many(
                    {"company_id": {"$in": drop_ids}},
                )
            except Exception:  # noqa: BLE001
                pass
        res = await db.companies.delete_many({"id": {"$in": drop_ids}})
        removed += res.deleted_count
        import logging
        logging.getLogger(__name__).info(
            "Partner Books dedupe: kept %s for partner %s, removed %d dupe(s)",
            keep_id, row["_id"], res.deleted_count,
        )
    return removed

#
#   Usage  — sum of `ai_usage_events.cost_cents` where the event's
#            company_id is in the Partner's tree of companies (any
#            company where `partner_id == self.id`). This is what
#            Partners "consumed" on behalf of their clients.
#
#   Costs  — same source, same tree, but grouped by feature/service so
#            the Partner can see where their spend went (Insights,
#            categorizer, Veryfi OCR, etc.). Alias of Usage — both
#            surface the same underlying $ number; the naming
#            distinction is UX polish so we can show consumption
#            (Usage) alongside a per-service drilldown (Costs).
#
#   Revenue — sum of `enterprise_invoices.amount_due_cents` where the
#             invoice's enterprise_id is in the Partner's tree
#             (enterprises with `partner_id == self.id`) and the
#             invoice is finalized/paid. This is what the Partner is
#             earning through the platform's consolidated billing.
#
# Everything is bucketed by `month_key` (YYYY-MM) for a 3-month trend
# alongside the current month's total. `count_documents` + a single
# `$group` aggregation each — well under the 100 ms budget even at
# 10k events / month.
# --------------------------------------------------------------------------

def _month_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m")


def _month_keys_trailing(n: int) -> list[str]:
    """Return the last `n` YYYY-MM keys ending with the current month
    (in UTC), oldest first. `n=3` on 2026-02-15 → ["2025-12","2026-01","2026-02"]."""
    now = datetime.now(timezone.utc)
    y, m = now.year, now.month
    keys: list[str] = []
    for _ in range(n):
        keys.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return list(reversed(keys))


async def _partner_tree_company_ids(partner_id: str) -> list[str]:
    """Every company that belongs to the Partner's tree — direct
    partner-provisioned client companies AND companies attached to
    enterprises the Partner provisioned."""
    ids: set[str] = set()
    async for c in db.companies.find(
        {"partner_id": partner_id},
        {"id": 1, "_id": 0},
    ):
        if c.get("id"):
            ids.add(c["id"])
    # Also pull companies attached to any enterprise the partner owns —
    # they may not have `partner_id` themselves if provisioned via a
    # non-partner-scoped flow but still belong to the partner tree.
    ent_ids = [
        e["id"] async for e in db.enterprises.find(
            {"partner_id": partner_id}, {"id": 1, "_id": 0},
        ) if e.get("id")
    ]
    if ent_ids:
        async for c in db.companies.find(
            {"enterprise_id": {"$in": ent_ids}},
            {"id": 1, "_id": 0},
        ):
            if c.get("id"):
                ids.add(c["id"])
    return list(ids)


async def _partner_tree_enterprise_ids(partner_id: str) -> list[str]:
    return [
        e["id"] async for e in db.enterprises.find(
            {"partner_id": partner_id}, {"id": 1, "_id": 0},
        ) if e.get("id")
    ]


async def _usage_by_month(company_ids: list[str], months: list[str]) -> dict[str, dict]:
    """Return `{month_key: {"total_cents": int, "by_service": {name: cents}}}`
    for every month in `months`. Zero-fills months with no activity."""
    out: dict[str, dict] = {m: {"total_cents": 0, "by_service": {}} for m in months}
    if not company_ids:
        return out
    # Use the ISO-string `ts` and match by prefix — one call, one
    # $group, no cross-collection joins. The `ts` field is indexed.
    pipeline = [
        {"$match": {
            "company_id": {"$in": company_ids},
            # Match any month in our window with a prefix regex.
            "ts": {"$regex": f"^({'|'.join(months)})"},
        }},
        {"$project": {
            "month_key": {"$substrBytes": ["$ts", 0, 7]},
            "service": {"$ifNull": ["$service", "unknown"]},
            "cost_cents": {"$ifNull": ["$cost_cents", 0]},
        }},
        {"$group": {
            "_id": {"month": "$month_key", "service": "$service"},
            "cents": {"$sum": "$cost_cents"},
        }},
    ]
    async for row in db.ai_usage_events.aggregate(pipeline):
        mk = row["_id"]["month"]
        svc = row["_id"]["service"]
        cents = int(row.get("cents") or 0)
        if mk not in out:
            continue
        out[mk]["total_cents"] += cents
        out[mk]["by_service"][svc] = out[mk]["by_service"].get(svc, 0) + cents
    return out


async def _revenue_by_month(enterprise_ids: list[str], months: list[str]) -> dict[str, int]:
    """Return `{month_key: cents}` — sum of `amount_due_cents` on
    invoices that reached at least `finalized` state (i.e. billed;
    `paid` obviously counts, `failed`/`empty` don't). Zero-fills."""
    out: dict[str, int] = {m: 0 for m in months}
    if not enterprise_ids:
        return out
    pipeline = [
        {"$match": {
            "enterprise_id": {"$in": enterprise_ids},
            "month_key": {"$in": months},
            "status": {"$in": ["finalized", "paid"]},
        }},
        {"$group": {
            "_id": "$month_key",
            "cents": {"$sum": {"$ifNull": ["$amount_due_cents", 0]}},
        }},
    ]
    async for row in db.enterprise_invoices.aggregate(pipeline):
        mk = row.get("_id")
        if mk in out:
            out[mk] = int(row.get("cents") or 0)
    return out


async def partner_financials(partner_id: str, *, months: int = 3) -> dict:
    """Aggregate the Partner-tree rollup for the dashboard. Returns a
    payload the frontend renders directly with no further math."""
    month_keys = _month_keys_trailing(months)
    current = month_keys[-1]

    company_ids = await _partner_tree_company_ids(partner_id)
    enterprise_ids = await _partner_tree_enterprise_ids(partner_id)

    usage_by_month = await _usage_by_month(company_ids, month_keys)
    revenue_by_month = await _revenue_by_month(enterprise_ids, month_keys)

    trend = [
        {
            "month_key": mk,
            "usage_cents": usage_by_month[mk]["total_cents"],
            "revenue_cents": revenue_by_month[mk],
        }
        for mk in month_keys
    ]

    # `by_service` breakdown for the current month, sorted highest-first.
    current_services = usage_by_month[current]["by_service"]
    by_service_sorted = sorted(
        (
            {"service": svc, "cents": cents}
            for svc, cents in current_services.items()
        ),
        key=lambda r: r["cents"], reverse=True,
    )

    return {
        "current_month_key": current,
        "usage_cents_current": usage_by_month[current]["total_cents"],
        "revenue_cents_current": revenue_by_month[current],
        "by_service_current": by_service_sorted,
        "trend": trend,
        "tree_summary": {
            "company_count": len(company_ids),
            "enterprise_count": len(enterprise_ids),
        },
    }
