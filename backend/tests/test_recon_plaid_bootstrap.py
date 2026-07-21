"""Auto-reconcile-from-Plaid bootstrap.

Deterministic guarantees under test:
  1. Refuses to create a recon when opening + Σ(post-opening Plaid txns) does
     NOT equal Plaid's `balance_current` (never fabricates).
  2. Refuses to auto-clear if a non-Plaid txn exists on the same bank account
     (would poison the ledger sum).
  3. Idempotent — running twice creates recons the first time, zero the
     second time.
  4. Skips (does not overwrite) any real existing recon that overlaps a
     period it would otherwise generate.
  5. Purges only placeholder recons (empty bank_account_id OR empty
     cleared_txn_ids) when `overwrite_placeholders=True`.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
from dotenv import dotenv_values

sys.path.insert(0, "/app/backend")
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso  # noqa: E402
from reconciliation_engine import bootstrap_from_plaid  # noqa: E402


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# --------------------------------------------------------------------------- #
# Test-fixture helpers — write a clean per-test dataset directly to Mongo so
# we don't depend on any seed script.
# --------------------------------------------------------------------------- #

def _mk_cid() -> str:
    return f"testcid_recon_bootstrap_{uuid.uuid4().hex[:8]}"


async def _seed_plaid_account(
    cid: str,
    *,
    opening_balance: float,
    opening_as_of: str,          # ISO date — the day the opening JE lands
    txns: list[tuple[str, float]],  # (date_iso, amount)
    plaid_current: float,
    include_manual_txn: bool = False,
) -> str:
    """Build a company + one Plaid item + one mapped ledger bank + txns.
    Returns the ledger bank account id."""
    ledger_acct_id = str(uuid.uuid4())
    plaid_account_id = f"plaid_acct_{uuid.uuid4().hex[:8]}"
    item_id = str(uuid.uuid4())

    await db.accounts.insert_one({
        "id": ledger_acct_id, "company_id": cid,
        "code": "1010", "name": "Test Checking",
        "type": "asset", "subtype": "current_asset",
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    await db.plaid_items.insert_one({
        "id": item_id, "company_id": cid,
        "item_id": item_id,
        "institution_name": "Test Bank",
        "accounts": [{
            "account_id": plaid_account_id,
            "name": "Adv Plus Banking", "mask": "0000",
            "balance_current": plaid_current,
            "balance_available": plaid_current,
        }],
        "account_mappings": {
            plaid_account_id: {
                "ledger_account_id": ledger_acct_id,
                "ledger_account_name": "Test Checking",
                "opening_balance": opening_balance,
                "opening_as_of": opening_as_of,
                "connected_at": now_iso(),
            },
        },
        "balance_snapshot_at": now_iso(),
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    for date_iso, amt in txns:
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": date_iso, "amount": amt,
            "bank_account_id": ledger_acct_id,
            "source": "plaid", "posted": True,
            "plaid_account_id": plaid_account_id,
            "description": "Test",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    if include_manual_txn:
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": opening_as_of, "amount": 1.0,
            "bank_account_id": ledger_acct_id,
            "source": "manual", "posted": True,
            "description": "Manual test txn",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    return ledger_acct_id


async def _cleanup(cid: str) -> None:
    await db.accounts.delete_many({"company_id": cid})
    await db.plaid_items.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.reconciliations.delete_many({"company_id": cid})


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

def test_bootstrap_creates_real_monthly_recons_when_math_agrees():
    async def _go():
        cid = _mk_cid()
        try:
            # Opening $100 on 2025-01-31. Two full months of activity, then
            # partial current month. Plaid current is derived to match exactly.
            txns = [
                ("2025-02-05", -30.0), ("2025-02-20",  10.0),   # Feb net -20
                ("2025-03-05",  50.0), ("2025-03-15", -25.0),   # Mar net +25
            ]
            plaid_current = 100.0 + sum(a for _, a in txns)  # = 105.0
            await _seed_plaid_account(
                cid,
                opening_balance=100.0,
                opening_as_of="2025-01-31",
                txns=txns,
                plaid_current=plaid_current,
            )
            res = await bootstrap_from_plaid(cid)
            assert res["errors"] == []
            # Feb + Mar both completed months (test runs in 2026), no partial.
            created = res["created"]
            periods = [c["period"] for c in created]
            assert any(p.startswith("2025-02-01") for p in periods), created
            assert any(p.startswith("2025-03-01") for p in periods), created

            # Every recon written must be real: bank_account_id set,
            # cleared_txn_ids non-empty, difference == 0, source flagged.
            docs = await db.reconciliations.find({"company_id": cid}).to_list(50)
            for d in docs:
                assert d["bank_account_id"], d
                assert d["cleared_txn_ids"], d
                assert d["difference"] == 0.0
                assert d["source"] == "plaid_bootstrap"
                assert d["status"] == "reconciled"

            # Cleared_source stamped on the txns.
            cleared = await db.transactions.count_documents({
                "company_id": cid, "cleared_source": "plaid_bootstrap",
            })
            assert cleared == 4
        finally:
            await _cleanup(cid)

    _run(_go())


def test_bootstrap_refuses_when_ledger_disagrees_with_plaid():
    async def _go():
        cid = _mk_cid()
        try:
            # Plaid current is $999 but ledger says $105 → bootstrap must
            # refuse for this account, create nothing, surface an error.
            txns = [("2025-02-05", -30.0), ("2025-02-20", 10.0)]
            await _seed_plaid_account(
                cid,
                opening_balance=100.0,
                opening_as_of="2025-01-31",
                txns=txns,
                plaid_current=999.0,   # intentional divergence
            )
            res = await bootstrap_from_plaid(cid)
            assert res["created"] == []
            assert len(res["errors"]) == 1
            assert "disagrees with Plaid" in res["errors"][0]
            assert await db.reconciliations.count_documents({"company_id": cid}) == 0
        finally:
            await _cleanup(cid)

    _run(_go())


def test_bootstrap_refuses_when_non_plaid_txn_on_account():
    async def _go():
        cid = _mk_cid()
        try:
            # Even if the Plaid-only math is fine, presence of a manual txn
            # on the same bank account is a red flag → skip account.
            txns = [("2025-02-05", -30.0), ("2025-02-20", 10.0)]
            plaid_current = 100.0 + sum(a for _, a in txns)   # 80.0
            await _seed_plaid_account(
                cid,
                opening_balance=100.0,
                opening_as_of="2025-01-31",
                txns=txns,
                plaid_current=plaid_current,
                include_manual_txn=True,
            )
            res = await bootstrap_from_plaid(cid)
            assert res["created"] == []
            assert any("non-Plaid" in e for e in res["errors"])
            assert await db.reconciliations.count_documents({"company_id": cid}) == 0
        finally:
            await _cleanup(cid)

    _run(_go())


def test_bootstrap_is_idempotent():
    async def _go():
        cid = _mk_cid()
        try:
            txns = [("2025-02-05", -30.0), ("2025-03-05", 50.0)]
            await _seed_plaid_account(
                cid,
                opening_balance=100.0,
                opening_as_of="2025-01-31",
                txns=txns,
                plaid_current=120.0,
            )
            r1 = await bootstrap_from_plaid(cid)
            n_created_first = len(r1["created"])
            assert n_created_first >= 1

            r2 = await bootstrap_from_plaid(cid)
            assert r2["created"] == []
            # Every period must now be skipped as "already reconciled".
            reasons = {s["reason"] for s in r2["skipped"]}
            assert reasons.issubset({"already reconciled"})
        finally:
            await _cleanup(cid)

    _run(_go())


def test_bootstrap_selfheals_webhook_race_leaked_txns():
    """A webhook that fires before mapping is persisted routes early txns to
    the fallback 1010 checking. Bootstrap must (a) detect the plaid_account_id
    -> wrong ledger mismatch, (b) reroute those txns to the mapped ledger,
    (c) then successfully reconcile."""
    async def _go():
        cid = _mk_cid()
        try:
            # Standard 2-txn account…
            txns = [("2025-02-05", -30.0), ("2025-02-20", 10.0)]
            plaid_current = 100.0 + sum(a for _, a in txns)   # 80.0
            ledger_id = await _seed_plaid_account(
                cid,
                opening_balance=100.0,
                opening_as_of="2025-01-31",
                txns=txns,
                plaid_current=plaid_current,
            )
            # …plus a fallback "1010 Business Checking" that a webhook race
            # dumped an early Plaid txn onto (same plaid_account_id, wrong
            # bank_account_id).
            fallback_id = str(uuid.uuid4())
            await db.accounts.insert_one({
                "id": fallback_id, "company_id": cid,
                "code": "1010", "name": "Business Checking",
                "type": "asset", "subtype": "current_asset",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            # Read the plaid_account_id off the item we already seeded.
            item = await db.plaid_items.find_one({"company_id": cid})
            leaked_plaid_id = list(item["account_mappings"].keys())[0]
            await db.transactions.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "date": "2025-02-10", "amount": -5.0,
                "bank_account_id": fallback_id,   # WRONG target
                "source": "plaid", "posted": True,
                "plaid_account_id": leaked_plaid_id,
                "description": "Leaked by webhook race",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            # Bump plaid_current so the invariant matches AFTER reroute.
            new_current = plaid_current - 5.0                 # 75.0
            await db.plaid_items.update_one(
                {"id": item["id"]},
                {"$set": {"accounts.0.balance_current": new_current}},
            )
            res = await bootstrap_from_plaid(cid)
            assert res["rerouted"] == 1, res
            assert res["errors"] == [], res
            assert len(res["created"]) >= 1
            # Verify the leaked txn was moved to the mapped ledger.
            leaked = await db.transactions.find_one({
                "company_id": cid, "description": "Leaked by webhook race",
            })
            assert leaked["bank_account_id"] == ledger_id
        finally:
            await _cleanup(cid)

    _run(_go())


def test_bootstrap_purges_only_placeholders():
    async def _go():
        cid = _mk_cid()
        try:
            # Seed a placeholder (no bank + no txns) AND a real completed
            # recon. Only the placeholder should die.
            real_rec_id = str(uuid.uuid4())
            placeholder_id = str(uuid.uuid4())
            await db.reconciliations.insert_many([
                {
                    "id": placeholder_id, "company_id": cid,
                    "bank_account_id": "",             # placeholder
                    "cleared_txn_ids": [],
                    "status": "reconciled",
                    "created_at": now_iso(), "updated_at": now_iso(),
                },
                {
                    "id": real_rec_id, "company_id": cid,
                    "bank_account_id": "real_bank_id",
                    "cleared_txn_ids": ["some_real_txn_id"],
                    "status": "reconciled",
                    "created_at": now_iso(), "updated_at": now_iso(),
                },
            ])
            res = await bootstrap_from_plaid(
                cid, overwrite_placeholders=True,
            )
            assert res["purged"] == 1
            remaining = await db.reconciliations.find(
                {"company_id": cid}, {"id": 1}
            ).to_list(10)
            remaining_ids = {r["id"] for r in remaining}
            assert real_rec_id in remaining_ids
            assert placeholder_id not in remaining_ids
        finally:
            await _cleanup(cid)

    _run(_go())
