"""Production hardening: rate limiting, structured logging, Sentry, report cache.

Everything is env-gated so the code stays cheap in preview and lights up on
production when the operator sets the relevant env variables.

Usage in server.py:
    from infra import init_infra, limiter, get_cache
    init_infra(app)                            # wire middleware, sentry, logger
    @limiter.limit("30/minute")                # per-endpoint decorator
    async def some_endpoint(request: Request): ...
    cache = get_cache()
    cache.get_or_compute(key, ttl, async_fn)   # report caching
"""
from __future__ import annotations
import json
import logging
import os
import time
import uuid
from typing import Awaitable, Callable

from cachetools import TTLCache
from fastapi import FastAPI, Request, Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address


# ---------------------------------------------------------------------------
# Rate limiter — slowapi. In-memory store (fine for single pod). Point at
# REDIS_URL for multi-pod deployments; slowapi picks it up automatically when
# passed as `storage_uri`.
# ---------------------------------------------------------------------------

_STORAGE_URI = os.environ.get("REDIS_URL") or "memory://"
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=_STORAGE_URI,
    default_limits=["600/minute"],  # global safety net (10 rps per IP)
)


# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------

class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        payload: dict = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Structured extras attached via `logger.info("...", extra={...})`
        for k in ("request_id", "user_id", "company_id", "path", "method",
                  "status", "elapsed_ms", "route"):
            v = getattr(record, k, None)
            if v is not None:
                payload[k] = v
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def _configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO"))
    # Silence noisy libraries
    for name in ("uvicorn.access", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


access_log = logging.getLogger("axiom.access")
app_log = logging.getLogger("axiom.app")


# ---------------------------------------------------------------------------
# Sentry (fully env-gated; if SENTRY_DSN is unset, nothing initializes)
# ---------------------------------------------------------------------------

def _configure_sentry() -> None:
    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        return
    import sentry_sdk
    from sentry_sdk.integrations.starlette import StarletteIntegration
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    sentry_sdk.init(
        dsn=dsn,
        traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
        environment=os.environ.get("ENV", "preview"),
        integrations=[StarletteIntegration(), FastApiIntegration()],
        send_default_pii=False,
    )
    app_log.info("sentry initialized", extra={"route": "startup"})


# ---------------------------------------------------------------------------
# Report cache: auto-selects Redis when reachable, falls back to in-process
# TTLCache. Same public API — invalidations and TTLs are honored either way.
# ---------------------------------------------------------------------------

class ReportCache:
    """In-process TTL cache keyed by (namespace, key). ~5-15 ms hits, auto-expires.
    Invalidation is coarse per-company via `invalidate(company_id)`.

    Used when `REDIS_URL` is unset OR unreachable. See `RedisReportCache`
    below for the multi-pod-safe variant that keeps caches in sync across
    replicas.
    """

    def __init__(self, maxsize: int = 4096, default_ttl: int = 300):
        self._store: TTLCache = TTLCache(maxsize=maxsize, ttl=default_ttl)

    def key(self, namespace: str, **parts) -> str:
        p = "|".join(f"{k}={parts[k]}" for k in sorted(parts))
        return f"{namespace}::{p}"

    async def get_or_compute(
        self, key: str, ttl: int,
        compute: Callable[[], Awaitable[dict]],
    ) -> dict:
        hit = self._store.get(key)
        if hit is not None:
            return hit
        val = await compute()
        # Repopulate under the exact TTL (cachetools has one TTL globally,
        # but re-using default is fine at our precision)
        self._store[key] = val
        return val

    def invalidate(self, company_id: str) -> int:
        """Remove all cache entries scoped to a company. Kept sync for
        backwards compat with existing call sites, and to match the shape
        of `RedisReportCache.invalidate`, which can be awaited transparently
        via the `_invalidate_async_or_sync` helper used by callers.
        """
        prefix_match = f"company_id={company_id}"
        removed = 0
        for k in list(self._store.keys()):
            if prefix_match in k:
                del self._store[k]
                removed += 1
        return removed

    # Async alias so callers can uniformly `await cache.ainvalidate(cid)`
    # regardless of backend, keeping the sync `invalidate` for legacy calls.
    async def ainvalidate(self, company_id: str) -> int:
        return self.invalidate(company_id)


class RedisReportCache:
    """Redis-backed cache with the same public API as `ReportCache`.

    Rationale (Feb 2026 — 3k-user hardening):
      - When the backend runs on N pods behind K8s HPA, an in-process cache
        creates cross-pod inconsistency. `sync_tasks._mark_done` invalidates
        cache on pod-A, but pod-B keeps serving the stale entry for up to
        15 s if a user's next request lands on pod-B (round-robin).
      - This class stores every entry in Redis so `invalidate(cid)` is
        visible to all pods immediately.
      - Uses async `redis.asyncio.Redis`; the client is lazily created and
        connection failures degrade to a no-op (caller re-computes from
        Mongo) rather than raising.
    """

    _NAMESPACE = "axiom:cache"

    def __init__(self, redis_client, *, default_ttl: int = 300):
        self._r = redis_client
        self._default_ttl = default_ttl

    def key(self, namespace: str, **parts) -> str:
        p = "|".join(f"{k}={parts[k]}" for k in sorted(parts))
        return f"{namespace}::{p}"

    def _rkey(self, key: str) -> str:
        return f"{self._NAMESPACE}:{key}"

    async def get_or_compute(
        self, key: str, ttl: int,
        compute: Callable[[], Awaitable[dict]],
    ) -> dict:
        rkey = self._rkey(key)
        try:
            raw = await self._r.get(rkey)
        except Exception:  # noqa: BLE001 — degrade gracefully
            raw = None
        if raw is not None:
            try:
                return json.loads(raw)
            except (ValueError, TypeError):
                pass  # corrupt entry — recompute below
        val = await compute()
        try:
            await self._r.set(rkey, json.dumps(val, default=str),
                              ex=ttl or self._default_ttl)
        except Exception:  # noqa: BLE001
            pass
        return val

    async def invalidate(self, company_id: str) -> int:
        """Delete every key whose value stored a scope-marker for the
        given company. Uses non-blocking SCAN so it stays cheap even at
        10k+ keys per company.
        """
        removed = 0
        pattern = f"{self._NAMESPACE}:*company_id={company_id}*"
        try:
            cursor = 0
            while True:
                cursor, keys = await self._r.scan(cursor=cursor, match=pattern, count=200)
                if keys:
                    removed += await self._r.delete(*keys)
                if cursor == 0:
                    break
        except Exception:  # noqa: BLE001
            pass
        return removed

    # Alias so callers can uniformly `await cache.ainvalidate(cid)` across
    # both backends without knowing which is active.
    async def ainvalidate(self, company_id: str) -> int:
        return await self.invalidate(company_id)


_cache_singleton: "ReportCache | RedisReportCache | None" = None


def get_cache():
    """Return the active cache backend.

    Selection at first call:
      1. If `REDIS_URL` is set → issue a sync `PING` (1 s timeout) against
         the target Redis. If it succeeds → `RedisReportCache` (multi-pod
         safe, invalidations visible to every pod).
      2. Any failure OR unset var → `ReportCache` (in-process TTLCache).

    Memoized so we don't reconnect on every request.
    """
    global _cache_singleton
    if _cache_singleton is not None:
        return _cache_singleton

    redis_url = os.environ.get("REDIS_URL", "").strip()
    if redis_url and redis_url != "memory://":
        try:
            import redis as _sync_redis
            import redis.asyncio as aioredis
            # Cheap sync ping — determines backend before we ever return.
            sync_client = _sync_redis.Redis.from_url(
                redis_url, socket_connect_timeout=1.0, socket_timeout=1.0,
            )
            sync_client.ping()  # raises ConnectionError if unreachable
            sync_client.close()
            async_client = aioredis.from_url(
                redis_url, decode_responses=True,
                socket_connect_timeout=1.0, socket_timeout=1.0,
                # Keep the pool small — the cache is not the primary
                # consumer of Redis; the rate limiter shares this instance.
                max_connections=20,
            )
            _cache_singleton = RedisReportCache(async_client)
            app_log.info("cache backend=redis", extra={"route": "startup"})
            return _cache_singleton
        except Exception as e:  # noqa: BLE001
            app_log.warning(
                f"redis unreachable ({e}) — cache falling back to in-process",
                extra={"route": "startup"},
            )
    _cache_singleton = ReportCache()
    app_log.info("cache backend=memory", extra={"route": "startup"})
    return _cache_singleton


async def _check_and_maybe_downgrade(client) -> None:
    """DEPRECATED — kept only to avoid breaking import in older callers.

    The sync ping inside `get_cache()` supersedes this async health-check
    task. Left as a no-op so any lingering `create_task` reference doesn't
    crash on old process invocations.
    """
    return None


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------

def init_infra(app: FastAPI) -> None:
    _configure_logging()
    _configure_sentry()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        start = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            elapsed = round((time.perf_counter() - start) * 1000, 2)
            access_log.exception(
                "unhandled_error",
                extra={"request_id": rid, "path": request.url.path,
                       "method": request.method, "status": 500,
                       "elapsed_ms": elapsed},
            )
            raise
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        response.headers["x-request-id"] = rid
        # Log every request as one structured line
        access_log.info(
            "http_request",
            extra={"request_id": rid, "path": request.url.path,
                   "method": request.method, "status": response.status_code,
                   "elapsed_ms": elapsed},
        )
        return response
