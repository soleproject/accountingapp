"""Feature-flag reader with a tiny in-process TTL cache.

Phase 0 use case (Feb 2026): `regions.uk_enabled` — global kill switch
that keeps every UK-related UI element and code path hidden until we
flip it on. A single Mongo write can enable UK visibility cluster-wide
in ≤ 10s without redeploying.

Design notes:
  - Two scopes: `global` (applies to everyone) and `company` (applies
    to one specific company_id). Company-scoped flag wins when both
    exist, so we can dogfood on one test company before flipping the
    global switch.
  - 10-second per-process cache. Small enough that ops can flip a
    flag and see it live within a coffee sip; big enough that a
    hot-path check doesn't hammer Mongo. In-process (not Redis) on
    purpose — flags are read from every request handler, and the
    cache is dwarfed by the cost of the Mongo round-trip.
  - Fail-open == disabled: any error (DB down, malformed doc,
    boot-order issue) resolves the flag as `False`. Better to hide a
    beta feature than to leak it during an incident.
"""
from __future__ import annotations

import time
from typing import Optional

from db import db


# Per-key cache: {(key, company_id or None): (bool, expires_at)}.
# Small dict — order-of-flags-count entries, effectively unbounded but
# capped in practice by the number of distinct flags × companies
# using them (a few dozen at most).
_CACHE: dict[tuple[str, Optional[str]], tuple[bool, float]] = {}
_TTL_SECONDS = 10.0


def _cache_get(key: str, company_id: Optional[str]) -> Optional[bool]:
    hit = _CACHE.get((key, company_id))
    if not hit:
        return None
    value, expires_at = hit
    if time.time() >= expires_at:
        _CACHE.pop((key, company_id), None)
        return None
    return value


def _cache_put(key: str, company_id: Optional[str], value: bool) -> None:
    _CACHE[(key, company_id)] = (value, time.time() + _TTL_SECONDS)


async def is_enabled(key: str, company_id: Optional[str] = None) -> bool:
    """Return True iff the flag is enabled for the given scope.

    Resolution order (first match wins):
      1. Company-scoped override for `company_id`
      2. Global flag
      3. Default: False

    Never raises — any exception collapses to False.
    """
    # 1. Company-scoped override
    if company_id:
        cached = _cache_get(key, company_id)
        if cached is not None:
            return cached
        try:
            doc = await db.feature_flags.find_one({
                "key": key, "scope": "company", "company_id": company_id,
            })
        except Exception:  # noqa: BLE001 — fail-open == disabled
            doc = None
        if doc is not None:
            value = bool(doc.get("enabled", False))
            _cache_put(key, company_id, value)
            return value
        # No company-scoped doc → cache the miss under the company key
        # so we don't re-query on every hit before falling back to
        # global. We store `False` as the miss sentinel and let the
        # global lookup below override if it's set.

    # 2. Global flag
    cached = _cache_get(key, None)
    if cached is not None:
        return cached
    try:
        doc = await db.feature_flags.find_one({"key": key, "scope": "global"})
    except Exception:  # noqa: BLE001
        doc = None
    value = bool(doc.get("enabled", False)) if doc else False
    _cache_put(key, None, value)
    return value


def _clear_cache() -> None:
    """Test hook — never called in production code. Pytest uses this
    to reset state between cases."""
    _CACHE.clear()
