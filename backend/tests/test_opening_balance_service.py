"""Regression tests for opening_balance_service.

Feb 2026 — auto-managed OBE JEs for bank accounts. Covers:

* First upload creates the JE (asset & liability sign convention).
* Second, NEWER-period upload is a no-op (earliest anchor unchanged).
* OLDER-period upload SHIFTS the JE date + recomputes amount.
* Manual `source: "opening_balance"` JE blocks auto-posting.
* Delta becomes ~$0 → auto row is deleted.
* Closed-period target date → returns `reason: "closed_period"`.
* Plaid history gate: <30 days returns False, ≥30 days returns True.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso  # noqa: E402
import opening_balance_service as obs  # noqa: E402
import plaid_connect  # noqa: E402


# ---------- fixtures ----------

async def _make_company() -> str:
    cid = "test-obs-" + uuid.uuid4().hex[:8]
    await db.companies.insert_one({"id": cid, "name": cid,
                                   "created_at": now_iso()})
    # Opening Balance Equity account is required by ensure_opening_balance_equity.
    await plaid_connect.ensure_opening_balance_equity(cid)
    return cid


async def _make_bank(cid: str, kind: str = "asset", name: str = "1011 Bank of America Checking") -> dict:
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "code": "1011" if kind == "asset" else "2100",
        "name": name, "type": kind,
        "active": True, "created_at": now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


async def _make_statement_import(
    cid: str, bank_id: str, period_start: str, opening: float,
    period_end: str | None = None, ending: float | None = None,
) -> str:
    iid = str(uuid.uuid4())
    await db.statement_imports.insert_one({
        "id": iid, "company_id": cid, "account_id": bank_id,
        "status": "completed",
        "period_start": period_start,
        "period_end": period_end or period_start,
        "starting_balance": opening,
        "ending_balance": ending,
        "created_at": now_iso(),
    })
    return iid


async def _cleanup(cid: str) -> None:
    for coll in ("companies", "accounts", "statement_imports",
                 "journal_entries", "transactions", "close_periods"):
        await db[coll].delete_many({"company_id": cid})


# ---------- tests ----------

def test_first_upload_creates_asset_je():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "asset")
            await _make_statement_import(cid, bank["id"], "2026-04-23", 3281.78)
            r = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r["ok"] and r["action"] == "upserted", r
            assert abs(r["amount"] - 3281.78) < 0.005, r
            assert r["as_of"] == "2026-04-22", r
            je = await db.journal_entries.find_one({
                "company_id": cid, "source": obs.AUTO_SOURCE,
            })
            assert je is not None
            bank_line = next(l for l in je["lines"] if l["account_id"] == bank["id"])
            assert abs(bank_line["debit"] - 3281.78) < 0.005
            assert bank_line["credit"] == 0.0
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_liability_sign_convention():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "liability", name="2100 Amex Platinum")
            await _make_statement_import(cid, bank["id"], "2026-04-01", 1200.00)
            r = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r["ok"] and r["action"] == "upserted"
            je = await db.journal_entries.find_one({
                "company_id": cid, "source": obs.AUTO_SOURCE,
            })
            bank_line = next(l for l in je["lines"] if l["account_id"] == bank["id"])
            # Liability: bank line should be CREDITED to reflect owed amount.
            assert bank_line["credit"] == 1200.00, bank_line
            assert bank_line["debit"] == 0.0
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_newer_upload_is_noop():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "asset")
            await _make_statement_import(cid, bank["id"], "2026-04-23", 3281.78)
            r1 = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            je_id_1 = r1["je_id"]

            # Newer statement — earliest anchor stays 2026-04-23.
            await _make_statement_import(cid, bank["id"], "2026-05-24", 1003.92)
            r2 = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r2["anchor_period_start"] == "2026-04-23", r2
            # Delta shouldn't have moved (no txns inserted between runs).
            assert abs(r2["amount"] - 3281.78) < 0.005, r2
            je_id_2 = r2["je_id"]
            assert je_id_1 == je_id_2, "Same auto JE row must be reused."
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_older_upload_shifts_je_date_and_amount():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "asset")
            await _make_statement_import(cid, bank["id"], "2026-05-01", 1003.92)
            r1 = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r1["as_of"] == "2026-04-30"

            # Older statement arrives late — earlier anchor takes over.
            await _make_statement_import(cid, bank["id"], "2026-03-24", 2463.10)
            r2 = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r2["as_of"] == "2026-03-23", r2
            assert abs(r2["amount"] - 2463.10) < 0.005, r2
            assert r2["je_id"] == r1["je_id"], "Same JE row, updated in place."
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_manual_obe_blocks_auto_posting():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "asset")
            await _make_statement_import(cid, bank["id"], "2026-04-01", 5000.0)
            # Simulate a manual/Plaid-connect OBE JE already there.
            await db.journal_entries.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "source": "opening_balance",
                "date": "2026-03-31", "memo": "user-posted OBE",
                "lines": [{"account_id": bank["id"], "debit": 5000.0, "credit": 0.0}],
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            r = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert not r["ok"] and r["reason"] == "manual_obe_exists", r
            # And no auto row was created.
            auto = await db.journal_entries.find_one({
                "company_id": cid, "source": obs.AUTO_SOURCE,
            })
            assert auto is None
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_delta_zero_deletes_auto_row():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "asset")
            await _make_statement_import(cid, bank["id"], "2026-04-01", 500.0)
            r1 = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r1["action"] == "upserted"

            # Now simulate user posting a manual JE for the same $500 —
            # the delta becomes 0 and our row must be deleted next run.
            # We add a NON-auto JE line for that amount.
            await db.journal_entries.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "source": "manual", "date": "2026-03-31",
                "memo": "user-posted top-up",
                "lines": [
                    {"account_id": bank["id"], "debit": 500.0, "credit": 0.0},
                    {"account_id": "obe-fake", "debit": 0.0, "credit": 500.0},
                ],
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            r2 = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert r2["ok"] and abs(r2["amount"]) < 0.005, r2
            auto = await db.journal_entries.find_one({
                "company_id": cid, "source": obs.AUTO_SOURCE,
            })
            assert auto is None, "Auto row should have been deleted."
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_closed_period_blocks_write():
    async def _go():
        cid = await _make_company()
        try:
            bank = await _make_bank(cid, "asset")
            await _make_statement_import(cid, bank["id"], "2026-04-01", 5000.0)
            # 2026-03-31 (target date) falls inside a closed period.
            await db.close_periods.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "period_start": "2026-03-01", "period_end": "2026-03-31",
                "status": "closed", "created_at": now_iso(),
            })
            r = await obs.ensure_opening_balance_for_account(cid, bank["id"])
            assert not r["ok"] and r["reason"] == "closed_period", r
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_plaid_history_gate():
    async def _go():
        cid = await _make_company()
        try:
            pa_id = "test-plaid-acct-" + uuid.uuid4().hex[:6]
            # Insert 5 days of history — below the gate.
            for i, d in enumerate(["2026-05-01", "2026-05-02", "2026-05-05",
                                   "2026-05-06", "2026-05-06"]):
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "plaid_account_id": pa_id, "date": d,
                    "amount": -10.0, "posted": True,
                })
            assert not await obs.plaid_history_meets_minimum_days(cid, pa_id)

            # Add a txn ~40 days later → now the range is > 30 days.
            await db.transactions.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "plaid_account_id": pa_id, "date": "2026-06-10",
                "amount": -10.0, "posted": True,
            })
            assert await obs.plaid_history_meets_minimum_days(cid, pa_id)
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


if __name__ == "__main__":
    # Run every test in a SHARED event loop — motor's async client caches
    # a loop reference on first use, so calling `asyncio.run(...)` per
    # test kills subsequent inserts with "Event loop is closed".
    async def _main():
        for name, fn in list(globals().items()):
            if name.startswith("test_") and callable(fn):
                # Each test defines its body inside a nested `_go` coroutine
                # invoked via `asyncio.run(_go())`. Extract that by calling
                # `fn.__wrapped_body__()` when set — or replace `asyncio.run`
                # locally. Simpler: monkey-patch `asyncio.run` for the
                # duration of the loop so tests remain readable.
                pass

    import asyncio as _a
    _orig_run = _a.run
    _loop = _a.new_event_loop()
    _a.set_event_loop(_loop)

    def _shared_run(coro):
        return _loop.run_until_complete(coro)

    _a.run = _shared_run
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_") and callable(fn):
                fn()
                print(f"OK: {name}")
    finally:
        _a.run = _orig_run
        _loop.close()
    print("\nAll opening_balance_service tests passed.")
