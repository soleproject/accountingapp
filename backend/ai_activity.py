"""Shared helper for the `db.ai_activity` counter collection.

Extracted from server.py so background sync code (plaid_connect,
sync_tasks) can log AI events without a circular import.

The Dashboard's "AI Activity" widget reads from this collection to show
running counters for: Transactions Categorized, Journal Entries Auto-Posted,
Flagged for Review, Rules Created, CoA Accounts Suggested, Statement Lines
OCR'd, Webhook Auto-Syncs.
"""
from __future__ import annotations
import uuid

from db import db, now_iso


async def log_ai_event(company_id: str, kind: str, count: int = 1) -> None:
    """Upsert `(company_id, kind)` row with `+count` on the counter.

    Safe to call concurrently — the `$inc` operator handles the race.
    """
    if count <= 0:
        return
    existing = await db.ai_activity.find_one(
        {"company_id": company_id, "type": kind},
    )
    if existing:
        await db.ai_activity.update_one(
            {"id": existing["id"]},
            {"$inc": {"count": count}, "$set": {"updated_at": now_iso()}},
        )
    else:
        await db.ai_activity.insert_one({
            "id": str(uuid.uuid4()),
            "company_id": company_id,
            "type": kind,
            "count": count,
            "created_at": now_iso(),
        })


__all__ = ["log_ai_event"]
