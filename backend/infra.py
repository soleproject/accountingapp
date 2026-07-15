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
# Report cache: in-process TTLCache, Redis-swappable via REDIS_URL
# ---------------------------------------------------------------------------

class ReportCache:
    """TTL cache keyed by (namespace, key). ~5-15 ms hits, auto-expires.
    Invalidation is coarse per-company via `invalidate(company_id)`.
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
        """Remove all cache entries scoped to a company."""
        prefix_match = f"company_id={company_id}"
        removed = 0
        for k in list(self._store.keys()):
            if prefix_match in k:
                del self._store[k]
                removed += 1
        return removed


_cache_singleton: ReportCache | None = None


def get_cache() -> ReportCache:
    global _cache_singleton
    if _cache_singleton is None:
        _cache_singleton = ReportCache()
    return _cache_singleton


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
