"""Regression tests for the liability-aware auto-reconciliation math
introduced in Feb 2026.

Bug: `create_reconciliation_from_statement_import` was using the ASSET
sign convention (`closing = opening + sum(amount)`) for LIABILITY
accounts too. Since Veryfi stores charges with a negative `amount` even
though they INCREASE the liability, the classic formula produced huge
false differences on every credit-card auto-recon (see the AmEx-1004
report showing diff=-$5,602.12 on a statement that ties perfectly).

Fix: flip the sign of `cleared_sum` when the bank account is a
liability, so the recon formula reduces to 0 when the ledger + statement
truly tie.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def _cursor(docs):
    """Return an async iterator mimicking `motor` cursors."""
    class _C:
        def __init__(self, d): self._d = list(d)
        def to_list(self, n=None):
            async def _r(): return self._d
            return _r()
    return _C(docs)


@pytest.mark.asyncio
async def test_liability_recon_zero_difference_on_perfect_tie():
    """A credit-card statement whose txns fully explain the opening→closing
    change must produce diff=0. Opening $0, five charges totaling
    -$500 (Veryfi sign), closing $500 owed → perfect tie."""
    from reconciliation_engine import create_reconciliation_from_statement_import

    import_id = "imp-1"
    cid = "cid-1"
    bank_account_id = "acct-cc"

    with patch("reconciliation_engine.db") as mdb:
        mdb.statement_imports.find_one = AsyncMock(return_value={
            "id": import_id, "company_id": cid, "status": "completed",
            "account_id": bank_account_id,
            "period_start": "2026-02-01", "period_end": "2026-02-28",
            "starting_balance": 0.0, "ending_balance": 500.0,
        })
        mdb.reconciliations.find_one = AsyncMock(return_value=None)
        mdb.transactions.find = MagicMock(return_value=_cursor([
            {"id": f"t{i}", "amount": -100.0} for i in range(5)
        ]))
        # bank_acct fetch for sign detection
        mdb.accounts.find_one = AsyncMock(return_value={
            "id": bank_account_id, "type": "liability", "name": "AmEx"
        })
        # sinks — must not fail:
        mdb.reconciliations.insert_one = AsyncMock()
        mdb.transactions.update_many = AsyncMock()

        result = await create_reconciliation_from_statement_import(cid, import_id)

    assert result["ok"] is True
    assert result["action"] == "created"
    # Perfect tie → difference should be 0 for a liability recon
    assert result["difference"] == 0.0

    # And the persisted doc should carry the SIGN-FLIPPED cleared_sum
    call = mdb.reconciliations.insert_one.await_args
    doc = call.args[0]
    assert doc["cleared_sum"] == 500.0  # -(-500) flipped for liability
    assert doc["difference"] == 0.0


@pytest.mark.asyncio
async def test_asset_recon_unchanged_behaviour():
    """An asset account (checking) must NOT flip the sign — the classic
    `closing = opening + sum(amount)` still holds and a perfect tie
    still produces diff=0."""
    from reconciliation_engine import create_reconciliation_from_statement_import

    import_id = "imp-2"
    cid = "cid-2"
    bank_account_id = "acct-chk"

    with patch("reconciliation_engine.db") as mdb:
        mdb.statement_imports.find_one = AsyncMock(return_value={
            "id": import_id, "company_id": cid, "status": "completed",
            "account_id": bank_account_id,
            "period_start": "2026-02-01", "period_end": "2026-02-28",
            "starting_balance": 1000.0, "ending_balance": 500.0,
        })
        mdb.reconciliations.find_one = AsyncMock(return_value=None)
        # 5 withdrawals of $100 each → sum = -500 → closing = 1000 + (-500) = 500 ✓
        mdb.transactions.find = MagicMock(return_value=_cursor([
            {"id": f"t{i}", "amount": -100.0} for i in range(5)
        ]))
        mdb.accounts.find_one = AsyncMock(return_value={
            "id": bank_account_id, "type": "asset", "name": "Chase Checking"
        })
        mdb.reconciliations.insert_one = AsyncMock()
        mdb.transactions.update_many = AsyncMock()

        result = await create_reconciliation_from_statement_import(cid, import_id)

    assert result["difference"] == 0.0
    doc = mdb.reconciliations.insert_one.await_args.args[0]
    # Asset: cleared_sum stored RAW (negative), matches txn.amount sum
    assert doc["cleared_sum"] == -500.0
    assert doc["difference"] == 0.0


@pytest.mark.asyncio
async def test_liability_recon_with_paydown_included():
    """A mixed statement — four $100 charges plus one $50 paydown (positive
    on liability) — must still tie. Opening $0, ending $350 owed."""
    from reconciliation_engine import create_reconciliation_from_statement_import

    import_id = "imp-3"
    cid = "cid-3"
    bank_account_id = "acct-cc"

    with patch("reconciliation_engine.db") as mdb:
        mdb.statement_imports.find_one = AsyncMock(return_value={
            "id": import_id, "company_id": cid, "status": "completed",
            "account_id": bank_account_id,
            "period_start": "2026-02-01", "period_end": "2026-02-28",
            "starting_balance": 0.0, "ending_balance": 350.0,
        })
        mdb.reconciliations.find_one = AsyncMock(return_value=None)
        mdb.transactions.find = MagicMock(return_value=_cursor([
            {"id": "t1", "amount": -100.0},
            {"id": "t2", "amount": -100.0},
            {"id": "t3", "amount": -100.0},
            {"id": "t4", "amount": -100.0},
            {"id": "t5", "amount":  50.0},   # paydown
        ]))
        mdb.accounts.find_one = AsyncMock(return_value={
            "id": bank_account_id, "type": "liability", "name": "AmEx"
        })
        mdb.reconciliations.insert_one = AsyncMock()
        mdb.transactions.update_many = AsyncMock()

        result = await create_reconciliation_from_statement_import(cid, import_id)

    # raw_sum = -350, liability flip → cleared_sum = +350
    # closing - opening - cleared_sum = 350 - 0 - 350 = 0 ✓
    assert result["difference"] == 0.0
    doc = mdb.reconciliations.insert_one.await_args.args[0]
    assert doc["cleared_sum"] == 350.0
