"""Regression: `dashboard_metrics.cash_on_hand` must include journal-entry
lines hitting cash accounts, not only the `transactions` collection.

The bug: initial opening-balance JEs (posted at Plaid connect) live in the
`journal_entries` collection, not in `transactions`. If the endpoint sums only
txns, Cash on Hand undercounts by the opening amount — a visible mismatch
against the Balance Sheet's Cash line, which does include JEs.

This test wires a minimal company with:
  - 1 asset account 1010 Business Checking
  - 1 opening-balance JE of $10,000 DR 1010 / CR 3050
  - 3 txns: -$200, -$300, +$100 (net -$400) against 1010
and asserts cash_on_hand == 10_000 + (-400) = $9,600.
"""
import asyncio
import sys
import uuid

sys.path.insert(0, '/app/backend')
from db import db, now_iso


# Reuse a single event loop for all tests (motor client binds to loop at import).
_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


async def _seed_org():
    cid = f"cash-oh-test-{uuid.uuid4()}"
    uid = f"cash-user-{uuid.uuid4()}"
    now = now_iso()

    # Minimal user + membership so `_require_company` passes
    await db.users.insert_one({
        "id": uid, "email": f"{uid}@test.io", "name": "Test",
        "password": "x", "role": "client", "created_at": now, "updated_at": now,
    })
    await db.companies.insert_one({
        "id": cid, "name": "Cash-OH Test", "business_type": "test",
        "owner_user_id": uid, "created_at": now, "updated_at": now,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "user_id": uid,
        "role": "owner", "created_at": now,
    })

    bank_id = str(uuid.uuid4())
    obe_id  = str(uuid.uuid4())
    await db.accounts.insert_many([
        {"id": bank_id, "company_id": cid, "code": "1010",
         "name": "Business Checking", "type": "asset",
         "subtype": "current_asset", "is_active": True},
        {"id": obe_id,  "company_id": cid, "code": "3050",
         "name": "Opening Balance Equity", "type": "equity",
         "subtype": "equity", "is_active": True},
    ])
    # Opening balance JE: DR bank 10,000 / CR OBE 10,000
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "date": "2026-01-01",
        "memo": "Opening balance", "source": "opening_balance",
        "lines": [
            {"account_id": bank_id, "account_code": "1010",
             "account_name": "Business Checking",
             "debit": 10_000.0, "credit": 0.0},
            {"account_id": obe_id, "account_code": "3050",
             "account_name": "Opening Balance Equity",
             "debit": 0.0, "credit": 10_000.0},
        ],
        "created_at": now, "updated_at": now,
    })
    # Three txns against the bank
    for i, amt in enumerate([-200.0, -300.0, 100.0]):
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": f"2026-01-{i+2:02d}",
            "description": f"txn {i}", "merchant": f"m{i}", "amount": amt,
            "bank_account_id": bank_id, "bank_account_name": "Business Checking",
            "category_account_id": obe_id,      # dummy category (equity — cheap)
            "category_account_code": "3050",
            "posted": True, "needs_review": False, "source": "manual",
            "created_at": now, "updated_at": now,
        })
    return cid


async def _cleanup(cid):
    await db.transactions.delete_many({"company_id": cid})
    await db.journal_entries.delete_many({"company_id": cid})
    await db.accounts.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"company_id": cid})


def test_cash_on_hand_includes_opening_balance_je():
    async def run():
        cid = await _seed_org()
        try:
            # Bypass HTTP — call the endpoint fn directly with a mock user
            from server import dashboard_metrics
            owner = await db.companies.find_one({"id": cid})
            user = await db.users.find_one({"id": owner["owner_user_id"]})
            res = await dashboard_metrics(cid, user=user)
            # Expected: opening 10_000 + txns (-200 - 300 + 100) = 9_600
            assert res["cash_on_hand"] == 9_600.0, (
                f"cash_on_hand should be 9600 (10000 JE + txn net -400), "
                f"got {res['cash_on_hand']}"
            )
        finally:
            await _cleanup(cid)
    _run(run())


def test_cash_on_hand_no_je_only_txns():
    """Sanity: with no JEs, cash_on_hand == sum of bank txns (unchanged behavior)."""
    async def run():
        cid = await _seed_org()
        try:
            await db.journal_entries.delete_many({"company_id": cid})
            from server import dashboard_metrics
            owner = await db.companies.find_one({"id": cid})
            user = await db.users.find_one({"id": owner["owner_user_id"]})
            res = await dashboard_metrics(cid, user=user)
            assert res["cash_on_hand"] == -400.0
        finally:
            await _cleanup(cid)
    _run(run())
