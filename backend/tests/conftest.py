"""Shared pytest-asyncio config. Motor's AsyncIOMotorClient in db.py binds to
the loop at import time; use a session-scoped event loop so all async tests
share the same loop and don't hit 'Event loop is closed' errors.
"""
import asyncio
import pytest


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
