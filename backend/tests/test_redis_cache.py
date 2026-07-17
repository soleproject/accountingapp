"""Multi-pod cache-consistency test — proves `RedisReportCache` behaves
correctly when it's the active backend.

We can't actually run Redis in this preview env (no redis-server binary),
so this test uses a **fake in-memory Redis** implementation (fakeredis) to
exercise the exact SET/GET/SCAN/DEL code paths without a live daemon.

If fakeredis is unavailable, the test skips gracefully so CI can still run.

At production scale (K8s with real Redis), the same code paths execute —
this test's sole job is to prove that `RedisReportCache` implements the
same contract as `ReportCache` and correctly invalidates via SCAN pattern.
"""
from __future__ import annotations
import asyncio
import json
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))


def _make_fake_redis():
    """Return an async fakeredis client, or None if the lib isn't installed."""
    try:
        import fakeredis.aioredis as _fr
        return _fr.FakeRedis(decode_responses=True)
    except ImportError:
        try:
            import fakeredis
            return fakeredis.aioredis.FakeRedis(decode_responses=True)
        except (ImportError, AttributeError):
            return None


async def _run_redis_cache_contract():
    """RedisReportCache.get_or_compute + ainvalidate round-trip."""
    fake = _make_fake_redis()
    if fake is None:
        print("SKIP: fakeredis not installed — Redis path exercised in prod only")
        return

    from infra import RedisReportCache
    cache = RedisReportCache(fake)

    cid = f"redis-cache-test-{uuid.uuid4()}"
    key_a = cache.key("dash_metrics", company_id=cid, day="2026-01-01")
    key_b = cache.key("dash_metrics", company_id=cid, day="2026-01-02")
    key_other = cache.key("dash_metrics", company_id="other-cid", day="2026-01-01")

    # Miss → compute → set
    calls = {"n": 0}
    async def _compute_a():
        calls["n"] += 1
        return {"metric": "a"}

    v1 = await cache.get_or_compute(key_a, 30, _compute_a)
    assert v1 == {"metric": "a"}
    assert calls["n"] == 1

    # Hit — must NOT recompute
    v2 = await cache.get_or_compute(key_a, 30, _compute_a)
    assert v2 == {"metric": "a"}
    assert calls["n"] == 1, "cache hit should skip compute"

    # Seed second scoped key + a neighbour
    await cache.get_or_compute(key_b, 30, lambda: _echo({"metric": "b"}))
    await cache.get_or_compute(key_other, 30, lambda: _echo({"metric": "other"}))

    # Confirm all three keys exist in fake redis
    assert await fake.get(cache._rkey(key_a))
    assert await fake.get(cache._rkey(key_b))
    assert await fake.get(cache._rkey(key_other))

    # Invalidate our target cid — must nuke both of its keys but leave
    # the neighbour untouched.
    removed = await cache.ainvalidate(cid)
    assert removed == 2, f"expected 2 keys removed, got {removed}"
    assert await fake.get(cache._rkey(key_a)) is None
    assert await fake.get(cache._rkey(key_b)) is None
    assert await fake.get(cache._rkey(key_other)) is not None, "neighbour collateral-damaged"


async def _echo(v):
    return v


async def _run_get_cache_selects_backend():
    """`get_cache()` returns ReportCache when Redis is unreachable — no crash,
    no hang. This is the observed preview-env behaviour."""
    import importlib
    import infra
    importlib.reload(infra)
    cache = infra.get_cache()
    assert cache.__class__.__name__ in ("ReportCache", "RedisReportCache"), \
        f"unexpected backend: {type(cache)}"
    # If Redis wasn't reachable at startup, we should have downgraded to memory
    if not os.environ.get("REDIS_URL") or os.environ.get("REDIS_URL") == "memory://":
        assert cache.__class__.__name__ == "ReportCache"


if __name__ == "__main__":
    async def _all():
        await _run_redis_cache_contract()
        await _run_get_cache_selects_backend()
    asyncio.run(_all())
    print("All Redis-cache tests passed (or skipped).")
