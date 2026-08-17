"""Feature-flag routes — read-only for now.

Phase 0 exposes a single GET so the frontend can hydrate its flag
cache once per session. Superadmin write endpoints (flip a flag on/off,
scope it to a company) are deferred to Phase 1 because in Phase 0 the
only flag is `regions.uk_enabled` and it stays `false` cluster-wide —
easier to flip that one via a direct Mongo write than to build a UI
for it now.

Fail-open: if the collection doesn't exist or the query errors, we
return `{"flags": {}}` rather than 500. Every frontend caller reads
missing keys as `false`, so an outage on this endpoint hides UK
features (correct) instead of leaking them (wrong).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from auth import get_current_user
from db import db

router = APIRouter(prefix="/api", tags=["feature-flags"])


@router.get("/feature-flags")
async def list_feature_flags(user: dict = Depends(get_current_user)):
    """Return every global flag + every company-scoped flag for
    companies the caller belongs to. Small, cache-friendly payload
    the frontend fetches once and reuses."""
    from deps import company_ids_for_user
    company_ids = await company_ids_for_user(user)

    flags: dict[str, bool] = {}
    try:
        # Global scope first (baseline)
        async for doc in db.feature_flags.find({"scope": "global"}):
            flags[doc["key"]] = bool(doc.get("enabled", False))
        # Company overrides for this user's companies win over global
        if company_ids:
            async for doc in db.feature_flags.find({
                "scope": "company",
                "company_id": {"$in": company_ids},
            }):
                flags[doc["key"]] = bool(doc.get("enabled", False))
    except Exception:  # noqa: BLE001 — fail-open == every flag disabled
        return {"flags": {}}

    return {"flags": flags}
