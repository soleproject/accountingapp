"""Advanced-features foundation (Feb 2026) — Classes / Projects / Budgets.

Phase 1 is the invisible-foundation phase: schema + indexes + a
feature-flag helper. Nothing renders in the UI yet and no report
path branches on these fields. Turning any flag on later requires
zero data migration because every existing document tolerates the
new nullable foreign keys.

Ships:
    * `get_features(cid)` — returns the merged features dict with
      safe defaults so callers can always do
      `features["projects_enabled"]` without a missing-key guard.
    * `ensure_indexes()` — idempotent, sparse indexes on the new
      foreign-key fields + the new collections. Called at backend
      startup via `server.py::startup`.
    * Field taxonomy documented below (single source of truth for
      the phased UI work).

Feature-flag defaults (all OFF):
    features.classes_enabled  : bool
    features.projects_enabled : bool
    features.budgets_enabled  : bool

New collections (created lazily on first insert):
    classes           — permanent business segments
    projects          — time-bound customer jobs
    project_phases    — optional sub-milestones inside a project
    budgets           — envelope for a plan (scope: company/class/project/phase)
    budget_lines      — per (account, period_key) targets

Nullable foreign keys added on existing docs (never populated until
a Phase 2+ UI writes them):
    transactions.class_id, .project_id, .phase_id
    invoices.class_id, .project_id, .phase_id
    bills.class_id, .project_id, .phase_id
    payments.class_id, .project_id, .phase_id
    receipts.class_id, .project_id, .phase_id
    estimates.class_id, .project_id, .phase_id
    journal_entries.lines[].class_id, .project_id, .phase_id
    transactions.qbo_legacy_tags — read-only capture of QBO Tags
        (QBO retires Tags May 19 2028; we keep the data for audit).
"""
from __future__ import annotations
import logging

from db import db

log = logging.getLogger("axiom.features")

DEFAULT_FEATURES = {
    "classes_enabled":  False,
    "projects_enabled": False,
    "budgets_enabled":  False,
}


async def get_features(company_id: str) -> dict:
    """Return the merged features dict for a company. Missing / legacy
    companies get all-False so callers can rely on the keys."""
    doc = await db.companies.find_one(
        {"id": company_id}, projection={"features": 1},
    )
    stored = (doc or {}).get("features") or {}
    return {**DEFAULT_FEATURES, **stored}


async def is_enabled(company_id: str, flag: str) -> bool:
    """Convenience wrapper — `if await is_enabled(cid, "projects_enabled"): …`"""
    features = await get_features(company_id)
    return bool(features.get(flag, False))


async def ensure_indexes() -> None:
    """Create sparse indexes for the new foreign-key fields + new
    collections. Idempotent — Mongo `create_index` is a no-op if the
    index already exists. Called from backend startup."""
    # Existing docs — nullable foreign keys (sparse so we don't inflate
    # index size while ~all rows have these unset).
    for coll in ("transactions", "invoices", "bills", "payments",
                 "receipts", "estimates"):
        for fk in ("class_id", "project_id", "phase_id"):
            await db[coll].create_index(
                [("company_id", 1), (fk, 1), ("date", -1)],
                sparse=True,
                name=f"idx_{coll}_{fk}",
            )

    # Journal-entry line-level FKs — indexed with dotted path.
    for fk in ("class_id", "project_id", "phase_id"):
        await db.journal_entries.create_index(
            [("company_id", 1), (f"lines.{fk}", 1)],
            sparse=True,
            name=f"idx_je_line_{fk}",
        )

    # New collections.
    await db.classes.create_index(
        [("company_id", 1), ("name", 1)], name="idx_classes_name",
    )
    await db.classes.create_index(
        [("company_id", 1), ("active", 1)], name="idx_classes_active",
    )
    await db.projects.create_index(
        [("company_id", 1), ("contact_id", 1)], name="idx_projects_contact",
    )
    await db.projects.create_index(
        [("company_id", 1), ("status", 1)], name="idx_projects_status",
    )
    await db.project_phases.create_index(
        [("company_id", 1), ("project_id", 1), ("sort_order", 1)],
        name="idx_phases_project",
    )
    await db.budgets.create_index(
        [("company_id", 1), ("status", 1)], name="idx_budgets_status",
    )
    await db.budgets.create_index(
        [("company_id", 1), ("scope", 1), ("scope_ref_id", 1)],
        name="idx_budgets_scope",
    )
    await db.budget_lines.create_index(
        [("budget_id", 1), ("account_id", 1), ("period_key", 1)],
        unique=True,
        name="idx_budget_lines_uk",
    )
    await db.budget_lines.create_index(
        [("company_id", 1), ("account_id", 1), ("period_key", 1)],
        name="idx_budget_lines_query",
    )

    log.info("advanced_features: indexes ensured")


async def backfill_defaults() -> int:
    """One-shot backfill — stamp `features={}` on any existing company
    that predates this feature. Idempotent; safe to re-run. Returns
    the count of rows touched."""
    result = await db.companies.update_many(
        {"features": {"$exists": False}},
        {"$set": {"features": DEFAULT_FEATURES}},
    )
    if result.modified_count:
        log.info("advanced_features: backfilled defaults on %d companies",
                 result.modified_count)
    return result.modified_count
