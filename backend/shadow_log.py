"""Shadow-mode diff logger for Step 2.

We want to introduce the INDN-blocks-contact rule and the advanced
name normalizer WITHOUT changing production ``contact_resolver``
behavior. Every call site that would behave differently under the new
rules writes an entry here so we can report "how many contacts would
have been created / matched differently" during the Step 2 review,
without touching live contact creation.

Collection: ``contact_resolver_shadow``

Indexes are declared in ``brand_registry.ensure_indexes`` so both
Step 2 collections share the same startup path.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db

log = logging.getLogger("axiom.shadow")


async def log_diff(
    *,
    company_id: str,
    kind: str,               # "indn_would_block" | "normalizer_would_merge"
                             # | "normalizer_would_disambiguate"
    description: str,
    would_do: str,           # short human summary of the new behavior
    live_did: str,           # short human summary of what live actually did
    context: Optional[dict] = None,
) -> None:
    """Write a shadow diff. Never raises — logging must never block a
    live path. ``kind`` is a stable string so the reporter can filter.
    """
    try:
        doc = {
            "id":          str(uuid.uuid4()),
            "company_id":  company_id,
            "kind":        kind,
            "description": description[:400] if description else "",
            "would_do":    would_do[:200] if would_do else "",
            "live_did":    live_did[:200] if live_did else "",
            "context":     context or {},
            "created_at":  datetime.now(timezone.utc).isoformat(),
        }
        await db.contact_resolver_shadow.insert_one(doc)
    except Exception as e:  # noqa: BLE001
        log.debug("shadow_log.log_diff failed: %s", e)


async def summarize(company_id: str, since_iso: str | None = None) -> dict:
    """Return {kind: count} + a small sample per kind for reporting."""
    q: dict = {"company_id": company_id}
    if since_iso:
        q["created_at"] = {"$gte": since_iso}
    counts: dict[str, int] = {}
    samples: dict[str, list] = {}
    async for row in db.contact_resolver_shadow.find(q).sort("created_at", -1).limit(2000):
        k = row.get("kind", "other")
        counts[k] = counts.get(k, 0) + 1
        s = samples.setdefault(k, [])
        if len(s) < 5:
            s.append({
                "description": row.get("description"),
                "would_do":    row.get("would_do"),
                "live_did":    row.get("live_did"),
                "context":     row.get("context"),
            })
    return {"counts": counts, "samples": samples}
