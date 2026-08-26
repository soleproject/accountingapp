"""Regression tests for the Plaid backfill polling scheduler (Feb 2026).

Two design constraints matter here:
  1. **Semaphore-safe** — sleeps must NOT happen inside the job_queue
     semaphore, or 1,000+ concurrent onboardings would starve real
     work behind sleeping tasks.
  2. **Durable across pod restart** — `next_backfill_poll_at` +
     `next_backfill_poll_attempt` are persisted on the plaid_items
     doc so `reconcile_pending_backfill_polls` can re-arm on startup.

Covers:
    A. `schedule_plaid_backfill_poll` persists next-poll state on the item
       and spawns an in-process timer (fire-and-forget, no semaphore).
    B. Scheduling attempt >= max is a no-op (chain ends).
    C. `reconcile_pending_backfill_polls` re-arms every pending row
       with the correct remaining delay.
    D. Reconciler skips items whose `historical_update_received: True`
       (that means a real webhook already landed).
"""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_schedule_persists_next_poll_and_spawns_timer(monkeypatch):
    """`schedule_plaid_backfill_poll(0)` stamps `next_backfill_poll_at`
    on the item and creates a live task (which we cancel immediately
    to avoid a real 30s sleep in the test)."""
    import sync_tasks

    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = AsyncMock()
    fake_db.plaid_items.update_one = AsyncMock()
    monkeypatch.setattr(sync_tasks, "db", fake_db)

    # Pre-emptively stub the timer so it doesn't actually run.
    async def _noop(*a, **kw):
        await asyncio.sleep(0)
    monkeypatch.setattr(sync_tasks, "_backfill_timer", _noop)

    await sync_tasks.schedule_plaid_backfill_poll("cid-1", "iid-1", attempt=0)

    # Persist call happened with the correct fields.
    fake_db.plaid_items.update_one.assert_awaited_once()
    args, kwargs = fake_db.plaid_items.update_one.call_args
    filter_arg, update_arg = args
    assert filter_arg == {"id": "iid-1"}
    assert "next_backfill_poll_at" in update_arg["$set"]
    assert update_arg["$set"]["next_backfill_poll_attempt"] == 0

    # Give the fire-and-forget task time to finish.
    for _ in range(10):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_schedule_past_max_attempts_is_noop(monkeypatch):
    """When `attempt >= len(_BACKFILL_POLL_DELAYS)`, the chain has ended
    — no persistence, no timer."""
    import sync_tasks

    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = AsyncMock()
    fake_db.plaid_items.update_one = AsyncMock()
    monkeypatch.setattr(sync_tasks, "db", fake_db)

    await sync_tasks.schedule_plaid_backfill_poll(
        "cid-1", "iid-1",
        attempt=len(sync_tasks._BACKFILL_POLL_DELAYS),
    )
    fake_db.plaid_items.update_one.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconciler_rearms_every_pending_row(monkeypatch):
    """`reconcile_pending_backfill_polls` iterates every plaid_item
    with a future `next_backfill_poll_at` and re-arms a timer for
    each. Items already stamped `historical_update_received: True`
    are excluded by the mongo filter — verified by asserting the
    filter passed in."""
    import sync_tasks

    now = datetime.now(timezone.utc)
    pending_rows = [
        {"id": "iid-a", "company_id": "cid-a",
         "next_backfill_poll_at": (now + timedelta(seconds=60)).isoformat(),
         "next_backfill_poll_attempt": 1},
        {"id": "iid-b", "company_id": "cid-b",
         "next_backfill_poll_at": (now + timedelta(seconds=600)).isoformat(),
         "next_backfill_poll_attempt": 2},
    ]

    class _FakeCursor:
        def __init__(self, rows): self._rows = rows
        def __aiter__(self):
            async def gen():
                for r in self._rows:
                    yield r
            return gen()

    seen_find_filter = {}

    def _find(filter_arg):
        seen_find_filter.update(filter_arg)
        return _FakeCursor(pending_rows)

    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = type("_PI", (), {"find": staticmethod(_find)})()
    monkeypatch.setattr(sync_tasks, "db", fake_db)

    timer_calls = []

    async def _fake_timer(company_id, item_id, attempt, delay):
        timer_calls.append((company_id, item_id, attempt, delay))
    monkeypatch.setattr(sync_tasks, "_backfill_timer", _fake_timer)

    armed = await sync_tasks.reconcile_pending_backfill_polls()
    assert armed == 2

    # The mongo filter excludes items whose historical update already landed.
    assert seen_find_filter["historical_update_received"] == {"$ne": True}
    assert seen_find_filter["next_backfill_poll_at"] == {"$ne": None}

    # Give the fire-and-forget tasks a tick to run.
    for _ in range(10):
        await asyncio.sleep(0)

    # Each row got a timer with its own attempt + a positive delay.
    assert len(timer_calls) == 2
    tasks_by_item = {c[1]: c for c in timer_calls}
    assert tasks_by_item["iid-a"][2] == 1  # attempt
    assert tasks_by_item["iid-a"][3] > 0    # delay is positive
    assert tasks_by_item["iid-b"][2] == 2


@pytest.mark.asyncio
async def test_reconciler_skips_bad_iso_dates(monkeypatch):
    """A malformed `next_backfill_poll_at` doesn't crash the reconciler
    — it just skips that row."""
    import sync_tasks

    rows = [
        {"id": "iid-x", "company_id": "cid-x",
         "next_backfill_poll_at": "not-a-date",
         "next_backfill_poll_attempt": 0},
    ]

    class _FakeCursor:
        def __init__(self, r): self._r = r
        def __aiter__(self):
            async def gen():
                for x in self._r:
                    yield x
            return gen()

    fake_db = type("_DB", (), {})()
    fake_db.plaid_items = type("_PI", (), {
        "find": staticmethod(lambda *a, **kw: _FakeCursor(rows)),
    })()
    monkeypatch.setattr(sync_tasks, "db", fake_db)

    armed = await sync_tasks.reconcile_pending_backfill_polls()
    assert armed == 0
