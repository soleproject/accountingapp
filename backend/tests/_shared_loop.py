"""Shared event loop for tests that manually wrap async code via `run(coro)`.

Motor's AsyncIOMotorClient (in db.py) binds to the first loop it sees. When
each test module creates its own new_event_loop(), tests in the second
module hit "attached to a different loop". Import from here instead of
creating a new loop in each module.
"""
import asyncio

_LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(_LOOP)


def run(coro):
    return _LOOP.run_until_complete(coro)
