"""Shared write helpers for the `contact_cleanup_applied` audit log.

Both the CPA-side reviewv2 routes and the client-side check-in routes
need to `pop` transactions out of an applied cleanup record (bulk
approve, bulk reassign, bulk rule, or single-row edit) with the exact
same audit-safe semantics — `$pull` from `txn_ids`, `$unset` the
per-row `previous_labels` snapshot, decrement `count`, mark the
record as fully-resolved when it empties, and append an entry to
`row_reassignments` for traceability.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

from fastapi import HTTPException

from deps import db


async def pop_txns_from_applied(
    cid: str,
    applied_id: str,
    txn_ids: Iterable[str],
    *,
    via: str,
    extra_row_meta: dict | None = None,
) -> int:
    """Remove `txn_ids` from an applied-cleanup record.

    Returns the number of rows remaining in the bundle after the pop.
    Raises HTTPException(404) if the record is unknown.
    """
    ids = [t for t in txn_ids if t]
    if not ids:
        return 0
    rec = await db.contact_cleanup_applied.find_one(
        {"id": applied_id, "company_id": cid},
        {"_id": 0, "txn_ids": 1, "count": 1},
    )
    if not rec:
        raise HTTPException(404, "Cleanup record not found")
    current = set(rec.get("txn_ids") or [])
    valid = [t for t in ids if t in current]
    if not valid:
        return len(current)
    remaining = [t for t in (rec.get("txn_ids") or []) if t not in set(valid)]
    new_count = max(0, int(rec.get("count") or 0) - len(valid))
    now = datetime.now(timezone.utc).isoformat()
    unset_snap = {f"previous_labels.{tid}": "" for tid in valid}
    status_update: dict = {}
    if not remaining:
        status_update = {
            "status":      f"{via}_all",
            f"{via}_all_at": now,
        }
    push_meta = [
        {**(extra_row_meta or {}), "txn_id": tid, "at": now, "via": via}
        for tid in valid
    ]
    await db.contact_cleanup_applied.update_one(
        {"id": applied_id, "company_id": cid},
        {"$pull":  {"txn_ids": {"$in": valid}},
         "$unset": unset_snap,
         "$set":   {"count": new_count, "updated_at": now,
                    **status_update},
         "$push":  {"row_reassignments": {"$each": push_meta}}},
    )
    return len(remaining)
