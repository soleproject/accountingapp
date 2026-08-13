"""Axiom Ledger — FastAPI app assembler.

This file is intentionally short. All route handlers live in
`/app/backend/routes/`, one file per domain (auth, companies, transactions,
reports, plaid, chat, …). Cross-cutting helpers are in `deps.py` and
Pydantic input schemas are in `models.py`.

Startup responsibilities kept here:
- Load .env
- Create the FastAPI app + attach CORS
- Include every sub-router discovered by `routes/__init__.py`
- Ensure Mongo indexes on startup + register background sync tasks
"""
from __future__ import annotations
import os
import json
import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response
from starlette.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from db import db  # noqa: E402
import merchant_cache  # noqa: E402
import contact_resolver  # noqa: E402
from routes import ALL_ROUTERS  # noqa: E402

# Backward-compat re-exports: a handful of tests + one-off scripts import
# these helpers directly off `server`. Keep the aliases so downstream code
# doesn't have to be rewritten to reference `deps.*`.
from deps import (  # noqa: E402,F401
    categorize_and_insert as _categorize_and_insert,
    sync_and_import as _sync_and_import,
    require_company as _require_company,
    company_ids_for_user as _company_ids_for_user,
    log_ai as _log_ai,
    is_period_closed as _is_period_closed,
    assert_open as _assert_open,
)
import plaid_service  # noqa: E402,F401 — tests monkeypatch srv.plaid_service

app = FastAPI(title="SmartBooks API")

for router in ALL_ROUTERS:
    app.include_router(router)

# Role-based write guard — blocks viewer/reviewer writes on
# /api/companies/{cid}/... routes. Register BEFORE CORS so CORS
# pre-flight OPTIONS never hits the guard.
from role_guard import RoleWriteGuardMiddleware
app.add_middleware(RoleWriteGuardMiddleware)

# CORS
# ------------------------------------------------------------------
# CORS_ORIGINS       — comma-separated exact origins (platform host + any
#                      one-off allow-list entries). Empty → falls back to "*".
# CORS_ORIGIN_REGEX  — a single regex that matches acceptable origins. This
#                      is REQUIRED to allow the wildcard private-label root
#                      (e.g. any `https://<firm>.accountingapp.ai`) because
#                      FastAPI's `allow_origins` does not do glob matching.
# Example Railway settings:
#   CORS_ORIGINS=https://app.smartbookssoftware.ai,https://accountingapp.ai
#   CORS_ORIGIN_REGEX=^https://[a-z0-9-]+\.accountingapp\.ai$
# ------------------------------------------------------------------
_cors_origins_env = os.environ.get("CORS_ORIGINS", "*")
_cors_origin_regex = os.environ.get("CORS_ORIGIN_REGEX")  # None means no regex match
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[o.strip() for o in _cors_origins_env.split(",") if o.strip()],
    allow_origin_regex=_cors_origin_regex,
    allow_methods=["*"], allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)


@app.on_event("startup")
async def startup():
    # Baseline indexes
    await db.users.create_index("email", unique=True)
    await db.transactions.create_index([("company_id", 1), ("date", -1)])
    await db.accounts.create_index([("company_id", 1), ("code", 1)])
    # Hot-path indexes (Feb 2026 scale-out)
    await db.transactions.create_index(
        [("company_id", 1), ("plaid_transaction_id", 1)],
        sparse=True, name="company_plaid_txn",
    )
    await db.transactions.create_index(
        [("company_id", 1), ("plaid_account_id", 1)],
        sparse=True, name="company_plaid_acct",
    )
    await db.transactions.create_index(
        [("company_id", 1), ("needs_review", 1), ("date", -1)],
        name="company_review_date",
    )
    # UNIQUE index prevents concurrent webhooks from double-inserting; partial
    # filter so non-Plaid rows (manual, veryfi, JEs) don't collide on null.
    try:
        await db.transactions.create_index(
            [("company_id", 1), ("plaid_transaction_id", 1)],
            unique=True,
            partialFilterExpression={"plaid_transaction_id": {"$type": "string"}},
            name="company_plaid_txn_uniq",
        )
    except Exception:  # noqa: BLE001 — may already exist under a different name
        pass
    await db.journal_entries.create_index([("company_id", 1), ("date", -1)])
    await db.invoices.create_index(
        [("company_id", 1), ("status", 1), ("issue_date", -1)],
        name="company_inv_status_date",
    )
    await db.bills.create_index(
        [("company_id", 1), ("status", 1), ("issue_date", -1)],
        name="company_bill_status_date",
    )
    await db.memberships.create_index([("user_id", 1), ("company_id", 1)])

    # ── (Feb 2026) `id` unique indexes on every application-primary-key
    # collection. Audited via count-of-duplicates before landing; safe
    # to create as unique. Mongo 4.2+ builds these online without a
    # collection lock, so no downtime risk on live traffic. Wrapped in
    # try/except so a single failure (e.g. someone hand-added a dupe
    # after this ships) doesn't crash startup for the whole app.
    _ID_INDEX_COLLECTIONS = [
        "companies", "users", "accounts", "transactions", "invoices",
        "bills", "contacts", "items", "assets", "loans",
        "journal_entries", "payments", "receipts", "memberships",
        "enterprises", "recurring_templates",
        "inventory_movements", "reconciliations", "plaid_items",
        "bank_accounts", "onboarding_sessions", "insights_sessions",
    ]
    for _coll in _ID_INDEX_COLLECTIONS:
        try:
            await db[_coll].create_index(
                "id", unique=True,
                # `sparse` guards against legacy rows that pre-date the
                # id column — they simply don't participate in the
                # uniqueness constraint instead of blocking the build.
                sparse=True,
                name="id_uniq",
            )
        except Exception as e:  # noqa: BLE001
            # We log-and-continue rather than crashing; ops sees the
            # error and can hand-fix. Blocking startup on an index issue
            # is a worse failure mode than serving without it.
            import logging as _l
            _l.getLogger("axiom.app").error(
                "failed to create %s.id unique index: %s", _coll, e,
            )

    # ── (Feb 2026) `is_firm_books` partial-unique index on companies.
    # Guarantees at most ONE Firm Books row per Pro user, so any
    # concurrent-boot race that used to spawn duplicates is now
    # rejected at the database layer with a DuplicateKeyError (which
    # the caller's `find_one`-first pattern recovers from cleanly).
    # `partialFilterExpression` scopes uniqueness to firm-books rows
    # only — regular client companies aren't constrained.
    try:
        await db.companies.create_index(
            [("owner_user_id", 1), ("is_firm_books", 1)],
            unique=True,
            partialFilterExpression={"is_firm_books": True},
            name="firm_books_uniq_per_pro",
        )
    except Exception as e:  # noqa: BLE001
        import logging as _l
        _l.getLogger("axiom.app").error(
            "failed to create firm_books uniqueness index: %s. "
            "Run enterprises.dedupe_firm_books_companies() first "
            "to remove existing duplicates.", e,
        )

    # Same guard for Partner Books — at most one per Partner.
    try:
        await db.companies.create_index(
            [("partner_id", 1), ("is_partner_books", 1)],
            unique=True,
            partialFilterExpression={"is_partner_books": True},
            name="partner_books_uniq_per_partner",
        )
    except Exception as e:  # noqa: BLE001
        import logging as _l
        _l.getLogger("axiom.app").error(
            "failed to create partner_books uniqueness index: %s. "
            "Run partners.dedupe_partner_books_companies() first "
            "to remove existing duplicates.", e,
        )

    # ── Dedupe any pre-existing Firm Books duplicates left behind by
    # concurrent-boot races before the uniqueness index was added.
    try:
        from enterprises import dedupe_firm_books_companies
        n = await dedupe_firm_books_companies()
        if n:
            import logging as _l
            _l.getLogger("axiom.app").warning(
                "startup dedupe removed %d duplicate Firm Books row(s)", n,
            )
    except Exception as e:  # noqa: BLE001
        import logging as _l
        _l.getLogger("axiom.app").exception(
            "firm-books dedupe failed on startup: %s", e,
        )

    # Same one-time dedupe pass for Partner Books.
    try:
        from partners import dedupe_partner_books_companies
        n = await dedupe_partner_books_companies()
        if n:
            import logging as _l
            _l.getLogger("axiom.app").warning(
                "startup dedupe removed %d duplicate Partner Books row(s)", n,
            )
    except Exception as e:  # noqa: BLE001
        import logging as _l
        _l.getLogger("axiom.app").exception(
            "partner-books dedupe failed on startup: %s", e,
        )

    # One-time backfill (Feb 2026) — elevate global role for any user
    # who has an active `role=pro` membership but is still flagged
    # `role=client` globally. Prior invites of *pre-existing* client
    # users left them as clients globally, which hid the /pro/clients
    # sidebar. Idempotent — subsequent startups no-op once caught up.
    await db.users.update_many(
        {"role": "client", "id": {"$in": [
            m["user_id"] for m in await db.memberships.find(
                {"role": "pro", "$or": [
                    {"archived_at": {"$exists": False}},
                    {"archived_at": None},
                ]},
                {"user_id": 1, "_id": 0},
            ).to_list(10000)
        ]}},
        {"$set": {"role": "pro"}},
    )
    await merchant_cache.ensure_indexes()
    await contact_resolver.ensure_contact_index()
    import pfc_resolver
    await pfc_resolver.ensure_pfc_override_indexes()
    import job_queue
    import sync_tasks
    import statements
    await job_queue.ensure_jobs_indexes()
    await statements.ensure_indexes()
    import ai_usage
    await ai_usage.ensure_indexes()
    # Enterprise (billing/branding parent of Pros) — ensure the default
    # SmartBooks record exists and every Pro has an enterprise_id.
    import enterprises as _ent
    await _ent.ensure_indexes()
    await _ent.ensure_default_enterprise()
    # Enterprise consolidated billing (Phase D) — schedules the 5th-of-
    # month invoice run and creates the idempotency index.
    import enterprise_billing_scheduler as _ebs
    await _ebs.ensure_indexes()
    _ebs.start_scheduler()
    sync_tasks.register_all()
    # AI Ask Client — hourly autonomous email loop (opt-out per pro).
    import ai_ask_client_scheduler
    ai_ask_client_scheduler.start_scheduler()
    # Recurring invoices / bills — hourly loop that clones any templates
    # whose next_run_date <= today (default = draft, safe to review).
    import recurring_service as _rec
    await _rec.ensure_indexes()
    _rec.start_scheduler()
    # Audit trail — enterprise-grade record of every mutating action,
    # login, impersonation, sync event, and export. Indexes cover the
    # three main query shapes: by-company timeline, by-user timeline,
    # by-entity timeline. Wrapped defensively so a missing optional
    # dep (zstandard) never bricks the whole app startup — the audit
    # module has its own graceful-degrade path.
    try:
        import audit as _audit
        await _audit.ensure_indexes()
    except Exception as _e:  # noqa: BLE001
        import logging as _log
        _log.getLogger(__name__).error(
            "audit init failed (non-fatal): %s", _e,
        )
    # Any job left in queued/running from a previous process is stuck —
    # mark as failed so the Sync Pill doesn't display "syncing forever".
    stuck = await job_queue.reconcile_stuck_jobs()
    if stuck:
        print(f"[startup] reconciled {stuck} stuck sync job(s) from prior process")

    # Demo Partner user auto-seed — the flagship seed.py only runs on a
    # first-boot empty DB, but the Partner tier shipped later so
    # existing prod DBs still don't have the `partner@axiom.ai` demo
    # user that the login page's "Partner — AxiomPartners" button
    # signs in as. Provision idempotently here so a redeploy auto-
    # backfills it without needing anyone to shell into the container
    # and run the re-seed script by hand. Fully defensive — errors are
    # swallowed and logged so a demo-seed hiccup never blocks real
    # user traffic.
    try:
        from partners import ensure_partner_books_company_for_partner
        from auth import hash_password as _hash_password
        from datetime import datetime as _dt, timezone as _tz
        import uuid as _uuid
        _existing = await db.users.find_one({"email": "partner@axiom.ai"})
        _now = _dt.now(_tz.utc).isoformat()
        if not _existing:
            _pid = str(_uuid.uuid4())
            await db.users.insert_one({
                "id": _pid,
                "email": "partner@axiom.ai",
                "name": "Jordan Reseller",
                "password": _hash_password("partner123"),
                "role": "partner",
                "firm_name": "AxiomPartners",  # legacy top-level
                "branding": {
                    "firm_name": "AxiomPartners",
                    "subdomain": "axiompartners",
                    "primary_color": "#c026d3",
                },
                "created_at": _now, "updated_at": _now,
            })
            await db.partners.insert_one({
                "id": _pid, "user_id": _pid,
                "slug": "axiompartners", "created_at": _now,
            })
            print("[startup] seeded demo partner partner@axiom.ai")
            await ensure_partner_books_company_for_partner(_pid)
        elif _existing.get("role") != "partner":
            # Existing account with the same email but wrong role —
            # DO NOT auto-promote. Log so ops sees it and can decide.
            print(
                f"[startup] SKIP partner seed: partner@axiom.ai already exists "
                f"as role={_existing.get('role')!r}. Fix manually if needed."
            )
        else:
            # Already a partner — ensure Partner Books exists (idempotent)
            # so a slow-role-migration didn't leave them without one.
            await ensure_partner_books_company_for_partner(_existing["id"])
    except Exception as _seed_exc:  # noqa: BLE001
        import logging as _log
        _log.getLogger(__name__).warning(
            "demo partner auto-seed non-fatal error: %s", _seed_exc,
        )

    # One-time backfill (Feb 2026) — for the Enterprise → Partner → Pro
    # branding cascade to work on ENTERPRISES CREATED BEFORE THE FIX,
    # we need to stamp `partner_id` onto the enterprise-owner Pro user
    # whenever their enterprise doc carries a `partner_id`. New
    # enterprises get this stamp inline in `POST /admin/enterprises`;
    # this loop backfills pre-existing rows. Idempotent — the `$ne`
    # guard means users already stamped are skipped.
    try:
        stamped = 0
        async for _ent_doc in db.enterprises.find(
            {"partner_id": {"$exists": True, "$ne": None},
             "owner_user_id": {"$exists": True, "$ne": None}},
            {"id": 1, "partner_id": 1, "owner_user_id": 1, "_id": 0},
        ):
            res = await db.users.update_one(
                {"id": _ent_doc["owner_user_id"],
                 "$or": [
                    {"partner_id": {"$exists": False}},
                    {"partner_id": None},
                    {"partner_id": {"$ne": _ent_doc["partner_id"]}},
                 ]},
                {"$set": {"partner_id": _ent_doc["partner_id"]}},
            )
            if res.modified_count:
                stamped += 1
        if stamped:
            print(f"[startup] branding-cascade backfill: stamped partner_id "
                  f"on {stamped} enterprise-owner pro user(s)")
    except Exception as _bf_exc:  # noqa: BLE001
        import logging as _log
        _log.getLogger(__name__).warning(
            "partner_id backfill non-fatal error: %s", _bf_exc,
        )


@app.on_event("shutdown")
async def shutdown():
    pass
