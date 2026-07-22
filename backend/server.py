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
    await merchant_cache.ensure_indexes()
    await contact_resolver.ensure_contact_index()
    import pfc_resolver
    await pfc_resolver.ensure_pfc_override_indexes()
    import job_queue
    import sync_tasks
    import statements
    await job_queue.ensure_jobs_indexes()
    await statements.ensure_indexes()
    sync_tasks.register_all()
    # AI Ask Client — hourly autonomous email loop (opt-out per pro).
    import ai_ask_client_scheduler
    ai_ask_client_scheduler.start_scheduler()
    # Any job left in queued/running from a previous process is stuck —
    # mark as failed so the Sync Pill doesn't display "syncing forever".
    stuck = await job_queue.reconcile_stuck_jobs()
    if stuck:
        print(f"[startup] reconciled {stuck} stuck sync job(s) from prior process")


@app.on_event("shutdown")
async def shutdown():
    pass
