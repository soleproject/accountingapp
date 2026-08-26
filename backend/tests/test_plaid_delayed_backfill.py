"""Regression tests for the Plaid delayed-backfill poller (Feb 2026).

Bug context:
    Plaid's `/transactions/sync` on a fresh Item may only return a
    partial window at connect time (~30 days). In classic-webhook mode
    the follow-up `HISTORICAL_UPDATE` webhook fills the rest; in the
    newer sync-mode the follow-up may never fire, leaving items stuck
    with ~30 days even though the link_token requested 730.

    `plaid_delayed_backfill_sync` re-runs `_run_sync` at +30s, +2m, +5m,
    +15m, +30m after connect, stops early when we reach the requested
    `import_start_date`, and stamps `historical_update_received: True`
    on the final attempt so opening-balance JEs still land.

Covers:
    1. Poll re-schedules itself while more history is expected.
    2. Poll stops early when we've reached the requested floor.
    3. Poll stops if `historical_update_received` was already set.
    4. Final attempt uses `HISTORICAL_UPDATE` trigger.
"""
from __future__ import annotations
import asyncio
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_poller_stops_when_history_already_received(monkeypatch):
    """When a real HISTORICAL_UPDATE webhook already landed, the poller
    exits immediately without hitting Plaid."""
    import sync_tasks

    # Fake plaid_items row with the marker already set.
    fake_item = {
        "id": "iid-1", "company_id": "cid-x",
        "historical_update_received": True,
        "import_start_date": "2024-01-01",
    }

    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = AsyncMock()
    fake_db.plaid_items.find_one = AsyncMock(return_value=fake_item)
    fake_db.sync_jobs = AsyncMock()
    fake_db.sync_jobs.find_one = AsyncMock(return_value={"company_id": "cid-x"})

    monkeypatch.setattr(sync_tasks, "db", fake_db)
    monkeypatch.setattr(sync_tasks.job_queue, "update_job", AsyncMock())
    # Zero-delay sleep so the test runs instantly.
    monkeypatch.setattr(sync_tasks.asyncio, "sleep", AsyncMock())

    run_sync = AsyncMock()
    monkeypatch.setattr(sync_tasks, "_run_sync", run_sync)
    enqueue = AsyncMock()
    monkeypatch.setattr(sync_tasks.job_queue, "enqueue_job", enqueue)

    await sync_tasks.plaid_delayed_backfill_sync(
        job_id="jid", company_id="cid-x", item_id="iid-1", attempt=0,
    )

    # Poller must NOT hit Plaid and must NOT re-schedule.
    run_sync.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_poller_reschedules_when_more_history_expected(monkeypatch):
    """When the sync returns 0 new rows but the oldest txn is still
    newer than `import_start_date`, the poller schedules another attempt."""
    import sync_tasks

    fake_item = {
        "id": "iid-2", "company_id": "cid-y",
        "historical_update_received": False,
        "import_start_date": "2024-01-01",
    }

    # find_one is called twice (pre-sync + post-sync). Both return the same.
    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = AsyncMock()
    fake_db.plaid_items.find_one = AsyncMock(return_value=fake_item)
    fake_db.sync_jobs = AsyncMock()
    fake_db.sync_jobs.find_one = AsyncMock(return_value={"company_id": "cid-y"})
    fake_db.transactions = AsyncMock()
    # Oldest imported row is dated 2025-07-01 — still 18 months short of
    # the requested 2024-01-01 floor, so we haven't caught up yet.
    fake_db.transactions.find_one = AsyncMock(return_value={"date": "2025-07-01"})

    monkeypatch.setattr(sync_tasks, "db", fake_db)
    monkeypatch.setattr(sync_tasks.job_queue, "update_job", AsyncMock())
    monkeypatch.setattr(sync_tasks.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(sync_tasks, "_run_sync", AsyncMock(return_value=0))
    enqueue = AsyncMock()
    monkeypatch.setattr(sync_tasks.job_queue, "enqueue_job", enqueue)

    await sync_tasks.plaid_delayed_backfill_sync(
        job_id="jid", company_id="cid-y", item_id="iid-2", attempt=0,
    )

    # Must re-schedule with attempt=1.
    enqueue.assert_awaited_once()
    kwargs = enqueue.call_args.kwargs
    assert kwargs["item_id"] == "iid-2"
    assert kwargs["attempt"] == 1


@pytest.mark.asyncio
async def test_poller_stops_at_floor(monkeypatch):
    """When we've imported down to the requested import_start_date
    floor and this attempt added 0 rows, the poller stops."""
    import sync_tasks

    fake_item = {
        "id": "iid-3", "company_id": "cid-z",
        "historical_update_received": False,
        "import_start_date": "2024-01-01",
    }

    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = AsyncMock()
    fake_db.plaid_items.find_one = AsyncMock(return_value=fake_item)
    fake_db.sync_jobs = AsyncMock()
    fake_db.sync_jobs.find_one = AsyncMock(return_value={"company_id": "cid-z"})
    fake_db.transactions = AsyncMock()
    # Oldest imported row is before the requested floor — we're done.
    fake_db.transactions.find_one = AsyncMock(return_value={"date": "2023-12-15"})

    monkeypatch.setattr(sync_tasks, "db", fake_db)
    monkeypatch.setattr(sync_tasks.job_queue, "update_job", AsyncMock())
    monkeypatch.setattr(sync_tasks.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(sync_tasks, "_run_sync", AsyncMock(return_value=0))
    enqueue = AsyncMock()
    monkeypatch.setattr(sync_tasks.job_queue, "enqueue_job", enqueue)

    await sync_tasks.plaid_delayed_backfill_sync(
        job_id="jid", company_id="cid-z", item_id="iid-3", attempt=0,
    )

    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_poller_final_attempt_uses_historical_trigger(monkeypatch):
    """The very last polling attempt sends `trigger="HISTORICAL_UPDATE"`
    into `_run_sync` so opening-balance JEs still get posted even when
    Plaid never fires its own webhook."""
    import sync_tasks

    fake_item = {
        "id": "iid-4", "company_id": "cid-q",
        "historical_update_received": False,
        "import_start_date": "2024-01-01",
    }
    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = AsyncMock()
    fake_db.plaid_items.find_one = AsyncMock(return_value=fake_item)
    fake_db.sync_jobs = AsyncMock()
    fake_db.sync_jobs.find_one = AsyncMock(return_value={"company_id": "cid-q"})
    fake_db.transactions = AsyncMock()
    fake_db.transactions.find_one = AsyncMock(return_value=None)

    monkeypatch.setattr(sync_tasks, "db", fake_db)
    monkeypatch.setattr(sync_tasks.job_queue, "update_job", AsyncMock())
    monkeypatch.setattr(sync_tasks.asyncio, "sleep", AsyncMock())
    run_sync = AsyncMock(return_value=42)
    monkeypatch.setattr(sync_tasks, "_run_sync", run_sync)
    monkeypatch.setattr(sync_tasks.job_queue, "enqueue_job", AsyncMock())

    # attempt=4 is the last one (index len(delays)-1).
    last_attempt = len(sync_tasks._BACKFILL_POLL_DELAYS) - 1
    await sync_tasks.plaid_delayed_backfill_sync(
        job_id="jid", company_id="cid-q", item_id="iid-4",
        attempt=last_attempt,
    )

    run_sync.assert_awaited_once()
    assert run_sync.call_args.kwargs["trigger"] == "HISTORICAL_UPDATE"
