"""Regression tests for statement-driven auto-reconciliation.

Feb 2026 — every Veryfi statement upload now spawns a `reconciliations`
doc (source=`veryfi_statement`) with `cleared_txn_ids` = every txn from
the import. Deleting the statement cascades to the reconciliation.

Scenarios covered:
  * Upload → recon doc created, `cleared_txn_ids` matches imported txns.
  * Second call for same import_id → idempotent (returns
    `action=already_exists`).
  * Import row missing / status != completed → skipped with reason.
  * Delete import → recon doc removed + txns un-cleared.
  * Manually-cleared txns (attached to another recon) are respected —
    the auto-recon does NOT reclaim them.
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
from reconciliation_engine import (  # noqa: E402
    create_reconciliation_from_statement_import,
    delete_reconciliation_for_statement_import,
)


# ---------- fixtures ----------

async def _seed_company_and_import(
    period_start: str = "2026-04-23",
    period_end: str = "2026-05-20",
    opening: float = 3281.78,
    ending: float = 1003.92,
    txn_amounts: list[float] | None = None,
) -> tuple[str, str, str, list[str]]:
    """Insert a company + bank account + statement_imports + N txns.
    Returns (cid, bank_id, import_id, [txn_ids])."""
    cid = "test-autorecon-" + uuid.uuid4().hex[:8]
    bank_id = str(uuid.uuid4())
    import_id = str(uuid.uuid4())
    await db.companies.insert_one({"id": cid, "name": cid,
                                   "created_at": now_iso()})
    await db.accounts.insert_one({
        "id": bank_id, "company_id": cid, "code": "1011",
        "name": "Bank of America Checking ···6084", "type": "asset",
        "active": True, "created_at": now_iso(),
    })
    await db.statement_imports.insert_one({
        "id": import_id, "company_id": cid, "account_id": bank_id,
        "status": "completed",
        "period_start": period_start, "period_end": period_end,
        "starting_balance": opening, "ending_balance": ending,
        "created_at": now_iso(),
    })
    txn_amounts = txn_amounts or [-100.0, -200.0, 50.0, -1977.86, -50.0]
    txn_ids: list[str] = []
    for i, amt in enumerate(txn_amounts):
        tid = str(uuid.uuid4())
        await db.transactions.insert_one({
            "id": tid, "company_id": cid, "bank_account_id": bank_id,
            "statement_import_id": import_id,
            "date": f"{period_start[:8]}{25 + i:02d}",
            "amount": amt, "posted": True, "description": f"Test {i}",
            "created_at": now_iso(),
        })
        txn_ids.append(tid)
    return cid, bank_id, import_id, txn_ids


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    for coll in ("accounts", "statement_imports", "transactions",
                 "journal_entries", "reconciliations", "close_periods"):
        await db[coll].delete_many({"company_id": cid})


# ---------- tests ----------

def test_upload_creates_reconciliation():
    async def _go():
        cid, bank_id, import_id, txn_ids = await _seed_company_and_import()
        try:
            r = await create_reconciliation_from_statement_import(cid, import_id)
            assert r["ok"] and r["action"] == "created", r
            assert r["cleared_count"] == len(txn_ids), r

            rec = await db.reconciliations.find_one({"id": r["reconciliation_id"]})
            assert rec is not None
            assert rec["source"] == "veryfi_statement"
            assert rec["status"] == "reconciled"
            assert rec["statement_import_id"] == import_id
            assert rec["auto_generated"] is True
            assert rec["bank_account_id"] == bank_id
            assert rec["period_start"] == "2026-04-23"
            assert rec["period_end"] == "2026-05-20"
            assert set(rec["cleared_txn_ids"]) == set(txn_ids)

            # Every txn is now cleared with the new recon's id.
            for tid in txn_ids:
                t = await db.transactions.find_one({"id": tid})
                assert t["cleared_source"] == "veryfi_statement"
                assert t["cleared_reconciliation_id"] == r["reconciliation_id"]
                assert t["cleared_at"] == "2026-05-20"

            # Difference math: closing - opening - sum(txns)
            # = 1003.92 - 3281.78 - (-2277.86) = 0.0
            assert abs(rec["difference"]) < 0.01, rec
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_upload_second_call_is_idempotent():
    async def _go():
        cid, bank_id, import_id, txn_ids = await _seed_company_and_import()
        try:
            r1 = await create_reconciliation_from_statement_import(cid, import_id)
            r2 = await create_reconciliation_from_statement_import(cid, import_id)
            assert r1["action"] == "created"
            assert r2["action"] == "already_exists", r2
            assert r1["reconciliation_id"] == r2["reconciliation_id"]
            # Only ONE reconciliation doc exists.
            count = await db.reconciliations.count_documents({
                "company_id": cid, "statement_import_id": import_id,
            })
            assert count == 1
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_upload_skips_missing_import():
    async def _go():
        r = await create_reconciliation_from_statement_import(
            "cid-nonexistent", "import-nonexistent",
        )
        assert not r["ok"] and r["reason"] == "import_not_found"
    asyncio.run(_go())


def test_upload_skips_missing_required_fields():
    """Statement without ending_balance / period bookends → skipped."""
    async def _go():
        cid, bank_id, import_id, _ = await _seed_company_and_import(
            ending=None,  # simulate an OCR gap
        )
        try:
            # Kill the ending balance so the helper's precondition trips.
            await db.statement_imports.update_one(
                {"id": import_id}, {"$set": {"ending_balance": None}},
            )
            r = await create_reconciliation_from_statement_import(cid, import_id)
            assert not r["ok"] and r["reason"] == "missing_required_fields", r
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_cascade_delete_removes_reconciliation_and_unclears_txns():
    async def _go():
        cid, bank_id, import_id, txn_ids = await _seed_company_and_import()
        try:
            r_create = await create_reconciliation_from_statement_import(cid, import_id)
            rec_id = r_create["reconciliation_id"]

            r_del = await delete_reconciliation_for_statement_import(cid, import_id)
            assert r_del["action"] == "deleted"
            assert r_del["reconciliation_id"] == rec_id

            gone = await db.reconciliations.find_one({"id": rec_id})
            assert gone is None

            # Un-cleared: cleared_at wiped on every txn.
            for tid in txn_ids:
                t = await db.transactions.find_one({"id": tid})
                assert t.get("cleared_at") in (None, ""), t
                assert t.get("cleared_reconciliation_id") in (None, ""), t
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_cascade_delete_is_noop_when_no_recon():
    async def _go():
        cid, bank_id, import_id, _ = await _seed_company_and_import()
        try:
            r = await delete_reconciliation_for_statement_import(cid, import_id)
            assert r["ok"] and r["action"] == "no_op"
        finally:
            await _cleanup(cid)
    asyncio.run(_go())


def test_respects_manually_cleared_txns():
    """Txns already attached to a different reconciliation must NOT be
    reclaimed by the auto-recon — the manual work wins."""
    async def _go():
        cid, bank_id, import_id, txn_ids = await _seed_company_and_import()
        try:
            # Mark the first two txns as cleared by a "manual" recon.
            manual_rec_id = str(uuid.uuid4())
            await db.transactions.update_many(
                {"id": {"$in": txn_ids[:2]}},
                {"$set": {"cleared_at": "2026-04-30",
                          "cleared_source": "manual",
                          "cleared_reconciliation_id": manual_rec_id}},
            )
            r = await create_reconciliation_from_statement_import(cid, import_id)
            assert r["ok"] and r["action"] == "created"
            # Only the last 3 txns should be attached to the new recon.
            assert r["cleared_count"] == 3
            rec = await db.reconciliations.find_one({"id": r["reconciliation_id"]})
            assert set(rec["cleared_txn_ids"]) == set(txn_ids[2:])
            # The first two txns still point at the manual recon.
            for tid in txn_ids[:2]:
                t = await db.transactions.find_one({"id": tid})
                assert t["cleared_source"] == "manual"
                assert t["cleared_reconciliation_id"] == manual_rec_id
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
    print("\nAll statement-driven auto-reconciliation tests passed.")
