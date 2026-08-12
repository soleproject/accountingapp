"""Shared pytest-asyncio config. Motor's AsyncIOMotorClient in db.py binds to
the loop at import time; use a session-scoped event loop so all async tests
share the same loop and don't hit 'Event loop is closed' errors.

Test modules that manually drive coroutines (via a helper `_run(coro)`)
should import `run` from `tests._shared_loop` — that module owns the
one process-wide loop that Motor binds to. Do NOT create a fresh
`asyncio.new_event_loop()` at the top of a test file; xdist-loadscope
pins two modules to the same worker and the second module will collide
with Motor's cached loop reference.
"""
import asyncio
import pytest


@pytest.fixture(scope="session")
def event_loop():
    # Reuse the loop `_shared_loop.py` created (Motor is bound to it).
    from tests._shared_loop import _LOOP  # noqa: WPS433
    yield _LOOP
    # No close — worker may be reused by pytest-xdist.
