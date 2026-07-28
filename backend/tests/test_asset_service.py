"""Regression tests for asset_service (Feb 2026).

Covers:
  * Cash-purchase acquisition: DR fixed asset · CR bank account.
  * Loan-financed acquisition: DR fixed asset · CR loan liability.
  * Straight-line depreciation schedule generated for full life.
  * Depreciation total = cost - salvage (rounding drift absorbed on
    the final month).
  * Delete cascades: JEs wiped, sub-accounts removed, `assets` row gone.
  * Closed-period guard on acquisition date rejects with ValueError.
  * Closed-period on depreciation month SKIPS that month silently.
  * Auto-code allocator produces distinct 15N0/15N5 pairs across
    successive assets.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from calendar import monthrange
from datetime import date

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso  # noqa: E402
import asset_service as A  # noqa: E402
import plaid_connect as P  # noqa: E402


async def _seed_company_with_cash(cash: float = 100_000) -> tuple[str, dict]:
    cid = "test-fa-" + uuid.uuid4().hex[:8]
    await db.companies.insert_one({"id": cid, "name": cid,
                                   "created_at": now_iso()})
    cash_acct = await P._ensure_account(
        cid, "1010", "Business Checking", "asset", "bank",
    )
    # Seed the cash balance via a JE so the acquisition credit has
    # something real to draw down (not required for the test but keeps
    # the ledger honest).
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "date": "2026-01-01",
        "source": "seed", "memo": "seed cash",
        "lines": [
            {"account_id": cash_acct["id"], "debit": cash, "credit": 0.0},
            {"account_id": (await P.ensure_opening_balance_equity(cid))["id"],
             "debit": 0.0, "credit": cash},
        ],
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return cid, cash_acct


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    for coll in ("accounts", "assets", "journal_entries", "transactions",
                 "close_periods"):
        await db[coll].delete_many({"company_id": cid})


def test_cash_purchase_creates_full_lifecycle():
    async def _go():
        cid, cash = await _seed_company_with_cash(200_000)
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "123 Main St.",
                "purchase_date": "2026-01-01",
                "cost": 100_000,
                "useful_life_years": 27.5,  # residential real estate
                "offset_account_id": cash["id"],
                "salvage_value": 0,
            })
            aid = r["id"]

            # Assets row exists.
            row = await db.assets.find_one({"id": aid})
            assert row is not None
            assert row["monthly_depreciation"] == round(100_000 / (27.5 * 12), 2)

            # CoA sub-accounts created and nested under 1500 Fixed Assets.
            parent = await db.accounts.find_one({"company_id": cid, "code": "1500"})
            assert parent and parent["subtype"] == "fixed_asset"
            asset_a = await db.accounts.find_one({"id": row["ledger_account_id"]})
            contra_a = await db.accounts.find_one({"id": row["accumulated_depreciation_account_id"]})
            assert asset_a["parent_account_id"] == parent["id"]
            assert contra_a["parent_account_id"] == parent["id"]
            assert asset_a["subtype"] == "fixed_asset"
            assert contra_a["subtype"] == "accumulated_depreciation"
            assert asset_a["code"] == "1510"
            assert contra_a["code"] == "1515"

            # Acquisition JE: DR asset $100k · CR cash $100k.
            acq = await db.journal_entries.find_one({"id": r["acquisition_je_id"]})
            assert acq["source"] == "asset_acquisition"
            assert acq["asset_id"] == aid
            bank_line = next(l for l in acq["lines"] if l["account_id"] == cash["id"])
            asset_line = next(l for l in acq["lines"] if l["account_id"] == asset_a["id"])
            assert bank_line["credit"] == 100_000
            assert asset_line["debit"] == 100_000

            # Depreciation schedule: 27.5 years * 12 = 330 monthly JEs.
            months = 330
            dep = await db.journal_entries.find({
                "company_id": cid, "asset_id": aid, "source": "depreciation",
            }).to_list(1000)
            assert len(dep) == months
            # Total depreciation = cost - salvage exactly (rounding drift
            # absorbed on final month).
            total_dep = sum(
                next(l for l in d["lines"] if l["account_id"] == contra_a["id"])["credit"]
                for d in dep
            )
            assert abs(total_dep - 100_000) < 0.01, total_dep
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_loan_purchase_credits_liability():
    async def _go():
        cid, _cash = await _seed_company_with_cash()
        try:
            loan = await db.accounts.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "code": "2500", "name": "Rocket Mortgage",
                "type": "liability", "subtype": "loan",
                "active": True, "created_at": now_iso(),
            })
            loan_doc = await db.accounts.find_one({"code": "2500", "company_id": cid})
            r = await A.create_fixed_asset(cid, {
                "name": "Ford F-150",
                "purchase_date": "2026-02-15",
                "cost": 45_000,
                "useful_life_years": 5,
                "offset_account_id": loan_doc["id"],
            })
            acq = await db.journal_entries.find_one({"id": r["acquisition_je_id"]})
            loan_line = next(l for l in acq["lines"] if l["account_id"] == loan_doc["id"])
            assert loan_line["credit"] == 45_000
            assert loan_line["debit"] == 0
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_delete_cascades_everything():
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "Espresso Machine",
                "purchase_date": "2026-03-01",
                "cost": 8000,
                "useful_life_years": 5,
                "offset_account_id": cash["id"],
            })
            aid = r["id"]
            # 60 depreciation JEs expected (5 * 12).
            del_r = await A.delete_fixed_asset(cid, aid)
            assert del_r["ok"] and del_r["journal_entries_deleted"] == 61
            # Every JE gone.
            assert await db.journal_entries.count_documents({
                "company_id": cid, "asset_id": aid,
            }) == 0
            # Sub-accounts gone.
            assert await db.accounts.count_documents({
                "company_id": cid, "id": {"$in": [
                    (await db.accounts.find_one({"code": "1510", "company_id": cid}) or {}).get("id"),
                    (await db.accounts.find_one({"code": "1515", "company_id": cid}) or {}).get("id"),
                ]},
            }) == 0
            # Assets row gone.
            assert await db.assets.find_one({"id": aid}) is None
            # Parent 1500 Fixed Assets NOT deleted (shared).
            parent = await db.accounts.find_one({"code": "1500", "company_id": cid})
            assert parent is not None
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_second_asset_gets_next_code_pair():
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            r1 = await A.create_fixed_asset(cid, {
                "name": "Asset One", "purchase_date": "2026-01-01",
                "cost": 1000, "useful_life_years": 3,
                "offset_account_id": cash["id"],
            })
            r2 = await A.create_fixed_asset(cid, {
                "name": "Asset Two", "purchase_date": "2026-01-01",
                "cost": 2000, "useful_life_years": 3,
                "offset_account_id": cash["id"],
            })
            assert r1["ledger_account"]["code"] == "1510"
            assert r1["accumulated_depreciation_account"]["code"] == "1515"
            assert r2["ledger_account"]["code"] == "1520"
            assert r2["accumulated_depreciation_account"]["code"] == "1525"
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_closed_period_blocks_acquisition():
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            await db.close_periods.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "period_start": "2026-01-01", "period_end": "2026-01-31",
                "status": "closed", "created_at": now_iso(),
            })
            try:
                await A.create_fixed_asset(cid, {
                    "name": "Blocked", "purchase_date": "2026-01-15",
                    "cost": 500, "useful_life_years": 3,
                    "offset_account_id": cash["id"],
                })
                assert False, "should have raised"
            except ValueError as e:
                assert "closed period" in str(e).lower(), e
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_closed_period_skips_depreciation_months():
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            # Close two future months. Depreciation for those months should skip.
            for ps, pe in [("2026-03-01", "2026-03-31"), ("2026-04-01", "2026-04-30")]:
                await db.close_periods.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "period_start": ps, "period_end": pe,
                    "status": "closed", "created_at": now_iso(),
                })
            r = await A.create_fixed_asset(cid, {
                "name": "Partial", "purchase_date": "2026-02-01",
                "cost": 1200, "useful_life_years": 1,  # 12 months
                "offset_account_id": cash["id"],
            })
            dep = await db.journal_entries.find({
                "company_id": cid, "asset_id": r["id"], "source": "depreciation",
            }).to_list(1000)
            # 12 months expected - 2 closed = 10 posted.
            assert len(dep) == 10, len(dep)
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_salvage_value_reduces_depreciable_base():
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "Salvage",
                "purchase_date": "2026-01-01",
                "cost": 12_000, "salvage_value": 2_000,
                "useful_life_years": 1,
                "offset_account_id": cash["id"],
            })
            # (12000 - 2000) / 12 = 833.33/month, total = 10000.
            assert abs(r["monthly_depreciation"] - round(10_000 / 12, 2)) < 0.005
            dep = await db.journal_entries.find({
                "company_id": cid, "asset_id": r["id"], "source": "depreciation",
            }).to_list(100)
            contra_id = (await db.assets.find_one({"id": r["id"]}))["accumulated_depreciation_account_id"]
            total = sum(
                next(l for l in d["lines"] if l["account_id"] == contra_id)["credit"]
                for d in dep
            )
            assert abs(total - 10_000) < 0.01, total
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_asset_type_land_skips_depreciation():
    """Land is non-depreciable — creation should post acquisition JE
    only and skip both the contra-asset sub-account and the schedule."""
    async def _go():
        cid, cash = await _seed_company_with_cash(500_000)
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "12 acres, Rte 22",
                "purchase_date": "2026-01-01",
                "cost": 250_000,
                "asset_type": "land",
                "offset_account_id": cash["id"],
            })
            assert r["depreciable"] is False
            assert r["depreciation_jes_posted"] == 0
            assert r["depreciation_months"] == 0
            assert r["accumulated_depreciation_account"] is None
            # Acquisition JE exists.
            acq = await db.journal_entries.find_one({"id": r["acquisition_je_id"]})
            assert acq is not None
            # No depreciation JEs.
            dep = await db.journal_entries.count_documents({
                "company_id": cid, "asset_id": r["id"], "source": "depreciation",
            })
            assert dep == 0
            # No accum-depreciation sub-account was created for this asset.
            assets_row = await db.assets.find_one({"id": r["id"]})
            assert assets_row["accumulated_depreciation_account_id"] is None
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_asset_type_preset_fills_useful_life():
    """When asset_type has a preset years, `useful_life_years` is
    auto-derived and the schedule matches the preset."""
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "1234 Elm St. rental",
                "purchase_date": "2026-01-01",
                "cost": 200_000,
                "asset_type": "residential_real_estate",  # 27.5 yrs preset
                "offset_account_id": cash["id"],
            })
            assert r["depreciation_months"] == 330  # 27.5 * 12
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_update_rename_only_is_cheap():
    """Non-financial edit — just renames the row + sub-accounts, no
    teardown of JEs."""
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "Old name", "purchase_date": "2026-01-01",
                "cost": 10_000, "useful_life_years": 5,
                "offset_account_id": cash["id"],
            })
            aid = r["id"]
            original_acq_id = r["acquisition_je_id"]
            up = await A.update_fixed_asset(cid, aid, {"name": "New name"})
            assert up["action"] == "renamed"
            row = await db.assets.find_one({"id": aid})
            assert row["name"] == "New name"
            # Sub-accounts renamed too.
            asset_a = await db.accounts.find_one({"id": row["ledger_account_id"]})
            contra_a = await db.accounts.find_one({"id": row["accumulated_depreciation_account_id"]})
            assert asset_a["name"] == "New name"
            assert contra_a["name"] == "New name — Accumulated Depreciation"
            # Acquisition JE untouched.
            acq = await db.journal_entries.find_one({"id": original_acq_id})
            assert acq is not None
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_update_financial_change_regenerates_schedule():
    """Editing cost/life triggers a full teardown + regenerate. Asset
    id is preserved so external references still resolve."""
    async def _go():
        cid, cash = await _seed_company_with_cash(500_000)
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "Widget", "purchase_date": "2026-01-01",
                "cost": 10_000, "useful_life_years": 5,
                "offset_account_id": cash["id"],
            })
            aid = r["id"]
            original_acq = r["acquisition_je_id"]

            # Cost doubles.
            up = await A.update_fixed_asset(cid, aid, {"cost": 20_000})
            assert up["action"] == "regenerated"
            assert up["id"] == aid, "asset_id must be stable across regenerate"
            # New acquisition JE — different id from the old one.
            row = await db.assets.find_one({"id": aid})
            assert row["cost"] == 20_000
            assert row["acquisition_je_id"] != original_acq
            # Old JE should be gone (teardown wiped it).
            old = await db.journal_entries.find_one({"id": original_acq})
            assert old is None
            # New monthly depreciation reflects new cost.
            assert abs(row["monthly_depreciation"] - round(20_000 / (5 * 12), 2)) < 0.005
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_mixed_funding_creates_multiline_acquisition_je():
    """User buys a $100k house with $20k cash down + $80k mortgage. The
    acquisition JE should have three lines: DR asset $100k, CR cash $20k,
    CR loan $80k."""
    async def _go():
        cid, cash = await _seed_company_with_cash(50_000)
        try:
            # Seed a mortgage liability.
            loan_id = str(uuid.uuid4())
            await db.accounts.insert_one({
                "id": loan_id, "company_id": cid,
                "code": "2500", "name": "Rocket Mortgage",
                "type": "liability", "subtype": "loan",
                "active": True, "created_at": now_iso(),
            })
            r = await A.create_fixed_asset(cid, {
                "name": "123 Main St.", "purchase_date": "2026-01-01",
                "cost": 100_000, "asset_type": "residential_real_estate",
                "offsets": [
                    {"account_id": cash["id"], "amount": 20_000},
                    {"account_id": loan_id, "amount": 80_000},
                ],
            })
            acq = await db.journal_entries.find_one({"id": r["acquisition_je_id"]})
            assert acq is not None
            assert len(acq["lines"]) == 3
            # Verify each line
            asset_line = next(l for l in acq["lines"] if l["debit"] > 0)
            cash_line = next(l for l in acq["lines"] if l["account_id"] == cash["id"])
            loan_line = next(l for l in acq["lines"] if l["account_id"] == loan_id)
            assert asset_line["debit"] == 100_000
            assert cash_line["credit"] == 20_000
            assert loan_line["credit"] == 80_000
            # Balanced: debits == credits
            total_dr = sum(l["debit"] for l in acq["lines"])
            total_cr = sum(l["credit"] for l in acq["lines"])
            assert abs(total_dr - total_cr) < 0.005
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_offsets_must_sum_to_cost():
    """Total of offsets must match cost exactly."""
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            try:
                await A.create_fixed_asset(cid, {
                    "name": "Underfunded", "purchase_date": "2026-01-01",
                    "cost": 100_000, "useful_life_years": 5,
                    "offsets": [{"account_id": cash["id"], "amount": 50_000}],
                })
                assert False, "should have raised"
            except ValueError as e:
                assert "match exactly" in str(e).lower(), e
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_legacy_single_offset_still_accepted():
    """Backward compat — passing `offset_account_id` as before still works."""
    async def _go():
        cid, cash = await _seed_company_with_cash()
        try:
            r = await A.create_fixed_asset(cid, {
                "name": "Legacy", "purchase_date": "2026-01-01",
                "cost": 5000, "useful_life_years": 3,
                "offset_account_id": cash["id"],
            })
            # Row should have a synthesized offsets list.
            row = await db.assets.find_one({"id": r["id"]})
            assert row["offsets"] == [{"account_id": cash["id"], "amount": 5000}]
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


if __name__ == "__main__":
    import asyncio as _a
    _orig_run = _a.run
    _loop = _a.new_event_loop()
    _a.set_event_loop(_loop)
    _a.run = lambda coro: _loop.run_until_complete(coro)
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_") and callable(fn):
                fn()
                print(f"OK: {name}")
    finally:
        _a.run = _orig_run
        _loop.close()
    print("\nAll asset_service tests passed.")
