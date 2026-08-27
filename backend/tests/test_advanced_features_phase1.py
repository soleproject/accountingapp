"""Phase 1 advanced-features foundation (Feb 2026).

Guardrails for the invisible-foundation phase — Classes / Projects /
Budgets. Nothing user-facing changes here; the tests ensure:

  1. Every new company gets `features={classes_enabled: False,
     projects_enabled: False, budgets_enabled: False}` by default.
  2. `advanced_features.get_features()` returns all-False for legacy
     companies that predate the field.
  3. `advanced_features.backfill_defaults()` is idempotent and safely
     stamps missing rows without touching companies that already
     have the field.
  4. `reports._signed_balances(class_id=..., project_id=...)`:
        a. When both filters are None (today's default), the result
           is byte-for-byte identical to today's output.
        b. When a filter is set, only rows tagged with that FK are
           counted.
  5. Sparse indexes on the new FK fields exist after startup.
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from advanced_features import (  # noqa: E402
    DEFAULT_FEATURES,
    get_features,
    is_enabled,
    backfill_defaults,
    ensure_indexes,
)
from reports import _signed_balances  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _mk_company(features: dict | None = None) -> tuple[str, str]:
    """Create a bare company (no memberships needed for these tests)."""
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    doc = {
        "id": cid, "name": f"Adv Feat {cid[:6]}",
        "owner_user_id": uid,
        "reporting_basis": "accrual",
    }
    if features is not None:
        doc["features"] = features
    await db.companies.insert_one(doc)
    return uid, cid


async def _cleanup(uid: str, cid: str) -> None:
    await db.transactions.delete_many({"company_id": cid})
    await db.journal_entries.delete_many({"company_id": cid})
    await db.accounts.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})


# --- 1. defaults ------------------------------------------------------
def test_new_company_features_default_all_false():
    """POST /api/companies stamps features with all-False keys."""
    async def _t():
        from httpx import AsyncClient, ASGITransport
        from server import app
        uid = str(uuid.uuid4())
        email = f"advfeat_{uid[:6]}@example.com"
        await db.users.insert_one({
            "id": uid, "email": email,
            "password": hash_password("x"), "role": "client",
        })
        token = create_token(uid, "client")
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test",
            ) as ac:
                r = await ac.post(
                    "/api/companies",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"name": "Adv Feat Co",
                          "business_type": "llc",
                          "business_description": "test",
                          "reporting_basis": "accrual"},
                )
                assert r.status_code == 200, r.text
                cid = r.json()["company_id"]
            company = await db.companies.find_one({"id": cid})
            assert company["features"] == DEFAULT_FEATURES
        finally:
            await db.companies.delete_one({"id": cid})
            await db.memberships.delete_many({"user_id": uid})
            await db.accounts.delete_many({"company_id": cid})
            await db.onboarding_state.delete_many({"company_id": cid})
            await db.users.delete_one({"id": uid})

    _run(_t())


# --- 2. legacy companies read as all-False ---------------------------
def test_legacy_company_reads_all_false():
    """A company that predates the `features` field gets all-False
    when read via `get_features()`."""
    async def _t():
        uid, cid = await _mk_company(features=None)
        try:
            feats = await get_features(cid)
            assert feats == DEFAULT_FEATURES
            # is_enabled convenience wrapper.
            assert not await is_enabled(cid, "projects_enabled")
            assert not await is_enabled(cid, "budgets_enabled")
            assert not await is_enabled(cid, "classes_enabled")
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# --- 3. backfill is idempotent + non-destructive ---------------------
def test_backfill_defaults_idempotent_and_scoped():
    async def _t():
        # One legacy company (no features field), one already-stamped.
        uid1, cid_legacy = await _mk_company(features=None)
        uid2, cid_stamped = await _mk_company(
            features={"classes_enabled": True,
                      "projects_enabled": False,
                      "budgets_enabled": False},
        )
        try:
            # First run — legacy row gets stamped.
            first = await backfill_defaults()
            assert first >= 1
            legacy_doc = await db.companies.find_one({"id": cid_legacy})
            assert legacy_doc["features"] == DEFAULT_FEATURES

            # Stamped row wasn't touched — its bespoke flag survives.
            stamped_doc = await db.companies.find_one({"id": cid_stamped})
            assert stamped_doc["features"]["classes_enabled"] is True

            # Second run — nothing to do.
            second = await backfill_defaults()
            assert second == 0
        finally:
            await _cleanup(uid1, cid_legacy)
            await _cleanup(uid2, cid_stamped)

    _run(_t())


# --- 4a. _signed_balances no-op when filters absent -------------------
def test_signed_balances_no_filter_unchanged():
    """With no class/project filter, output must match the historic
    behavior — same key set, same values."""
    async def _t():
        uid, cid = await _mk_company()
        try:
            # Seed a cash + expense account and one manual txn.
            cash = {"id": f"a-cash-{cid[:6]}", "company_id": cid,
                    "code": "1000", "name": "Cash",
                    "type": "asset", "detail_type": "cash_and_bank"}
            exp = {"id": f"a-exp-{cid[:6]}", "company_id": cid,
                   "code": "6100", "name": "Meals",
                   "type": "expense", "detail_type": "operating_expense"}
            await db.accounts.insert_many([cash, exp])
            await db.transactions.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "date": "2026-02-10", "posted": True,
                "amount": -50.0, "merchant": "Cafe",
                "bank_account_id": cash["id"],
                "category_account_id": exp["id"],
            })

            baseline = await _signed_balances(cid, None, "2026-12-31")
            # Cash goes down 50, expense goes up 50 (debit-positive).
            assert round(baseline[cash["id"]], 2) == -50.0
            assert round(baseline[exp["id"]], 2) == 50.0

            # Filter that matches nothing must return an empty-ish map
            # (or zero on those accounts). No exceptions.
            filtered = await _signed_balances(
                cid, None, "2026-12-31", project_id="nonexistent-project",
            )
            assert filtered.get(cash["id"], 0) == 0
            assert filtered.get(exp["id"], 0) == 0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# --- 4b. _signed_balances filters at the txn level -------------------
def test_signed_balances_project_filter_scopes_to_tagged_txns():
    async def _t():
        uid, cid = await _mk_company()
        try:
            cash = {"id": f"a-cash-{cid[:6]}", "company_id": cid,
                    "code": "1000", "name": "Cash",
                    "type": "asset", "detail_type": "cash_and_bank"}
            exp = {"id": f"a-exp-{cid[:6]}", "company_id": cid,
                   "code": "6100", "name": "Meals",
                   "type": "expense", "detail_type": "operating_expense"}
            await db.accounts.insert_many([cash, exp])
            pid = str(uuid.uuid4())
            # Two txns: one tagged to the project, one un-tagged.
            await db.transactions.insert_many([
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "date": "2026-02-10", "posted": True, "amount": -50.0,
                 "merchant": "In project", "bank_account_id": cash["id"],
                 "category_account_id": exp["id"],
                 "project_id": pid},
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "date": "2026-02-11", "posted": True, "amount": -80.0,
                 "merchant": "Not in project",
                 "bank_account_id": cash["id"],
                 "category_account_id": exp["id"]},
            ])
            # Unfiltered: both hit.
            full = await _signed_balances(cid, None, "2026-12-31")
            assert round(full[exp["id"]], 2) == 130.0

            # Filtered to the project: only the tagged $50 shows up on
            # the expense account. Cash-side isn't included because
            # payment/bank movements aren't project-scoped in QBO's
            # model (see filtered_view guard in _signed_balances_native_layer).
            scoped = await _signed_balances(
                cid, None, "2026-12-31", project_id=pid)
            assert round(scoped[exp["id"]], 2) == 50.0
            # Cash side is included via the txn walker (it's on the
            # same txn that carries project_id).
            assert round(scoped[cash["id"]], 2) == -50.0

            # A different project id returns nothing.
            other = await _signed_balances(
                cid, None, "2026-12-31", project_id="other-pid")
            assert other.get(exp["id"], 0) == 0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# --- 4c. _signed_balances filters at the JE line level ---------------
def test_signed_balances_project_filter_scopes_je_lines():
    """A multi-project JE should only contribute the matching lines."""
    async def _t():
        uid, cid = await _mk_company()
        try:
            proj_a = str(uuid.uuid4())
            proj_b = str(uuid.uuid4())
            rev = {"id": f"a-rev-{cid[:6]}", "company_id": cid,
                   "code": "4000", "name": "Revenue",
                   "type": "revenue", "detail_type": "income"}
            ar = {"id": f"a-ar-{cid[:6]}", "company_id": cid,
                  "code": "1200", "name": "A/R",
                  "type": "asset", "detail_type": "expected_payments_from_customers"}
            await db.accounts.insert_many([rev, ar])
            # One JE, two projects — 100 to A, 200 to B.
            await db.journal_entries.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "date": "2026-02-15",
                "lines": [
                    {"account_id": ar["id"], "debit": 100.0, "credit": 0.0,
                     "project_id": proj_a},
                    {"account_id": rev["id"], "debit": 0.0, "credit": 100.0,
                     "project_id": proj_a},
                    {"account_id": ar["id"], "debit": 200.0, "credit": 0.0,
                     "project_id": proj_b},
                    {"account_id": rev["id"], "debit": 0.0, "credit": 200.0,
                     "project_id": proj_b},
                ],
            })

            # Total unfiltered: A/R = 300, Revenue = -300 (debit-pos).
            total = await _signed_balances(cid, None, "2026-12-31")
            assert round(total[ar["id"]], 2) == 300.0
            assert round(total[rev["id"]], 2) == -300.0

            # Filter to project A → 100 / -100.
            only_a = await _signed_balances(
                cid, None, "2026-12-31", project_id=proj_a)
            assert round(only_a[ar["id"]], 2) == 100.0
            assert round(only_a[rev["id"]], 2) == -100.0

            # Filter to project B → 200 / -200.
            only_b = await _signed_balances(
                cid, None, "2026-12-31", project_id=proj_b)
            assert round(only_b[ar["id"]], 2) == 200.0
            assert round(only_b[rev["id"]], 2) == -200.0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# --- 5. indexes are created after startup ---------------------------
def test_indexes_exist():
    async def _t():
        # Re-run to be sure (it's idempotent).
        await ensure_indexes()
        idx = await db.transactions.index_information()
        # Sanity checks — one per FK.
        assert "idx_transactions_class_id" in idx
        assert "idx_transactions_project_id" in idx
        assert "idx_transactions_phase_id" in idx

        idx_je = await db.journal_entries.index_information()
        assert "idx_je_line_class_id" in idx_je
        assert "idx_je_line_project_id" in idx_je

        idx_budget_lines = await db.budget_lines.index_information()
        assert any(v.get("unique") for v in idx_budget_lines.values()), \
            "budget_lines must have a unique (budget, account, period) index"
    _run(_t())
