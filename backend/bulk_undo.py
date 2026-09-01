"""Bulk-action snapshots — the storage layer that powers Undo.

Every mutating bulk endpoint on `routes/transactions.py`
(bulk-reclassify, bulk-set-contact, bulk-approve) writes a snapshot
row BEFORE it mutates the target transactions. The response returns
the snapshot's `id` as `undo_token` so the UI can show a toast:

    "Reclassified 25 txns → Meals · Undo"

The undo endpoint reads the snapshot back, restores the pre-image
onto each row it can still find, and marks the snapshot consumed.

Retention: 24 hours via a Mongo TTL index on `expires_at`.
Storage: `bulk_action_snapshots` collection.

Snapshot shape:
    {
      "id":            "<uuid>",
      "company_id":    "<uuid>",
      "action":        "bulk-reclassify" | "bulk-set-contact" | "bulk-approve",
      "actor_email":   "..."  (audit only — anyone in the company can undo),
      "actor_id":      "...",
      "created_at":    "2026-03-01T14:22:00Z",
      "expires_at":    datetime — TTL trigger (24 h later),
      "consumed_at":   null | iso,
      "consumed_by":   null | email,
      "row_count":     25,
      "summary":       "Reclassified 25 txns → Meals (6000)",
      "before_rows":   [
        {"id": "<txn_uuid>",
         "contact_id":     "<old>",
         "contact_name":   "<old>",
         "category_account_id":   "<old>",
         "category_account_code": "<old>",
         "category_account_name": "<old>",
         "needs_review":   bool,
         "human_reviewed": bool,
         "posted":         bool,
         "ai_source":      "..."},
        ...
      ]
    }
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone, timedelta
from typing import Iterable

from db import db, now_iso

# TTL — 24 hours. Backing index created on first use; safe to call
# repeatedly.
_TTL_SECONDS = 24 * 60 * 60

# Fields we snapshot per row. Whatever the bulk endpoint might mutate
# lands here so undo is byte-exact.
_TXN_FIELDS = [
    "contact_id", "contact_name",
    "category_account_id", "category_account_code", "category_account_name",
    "needs_review", "human_reviewed", "posted", "ai_source",
    "ai_confidence", "ai_reasoning",
]


async def ensure_indexes() -> None:
    """Idempotent — creates the TTL + lookup indexes on first call."""
    await db.bulk_action_snapshots.create_index(
        "expires_at", expireAfterSeconds=0
    )
    await db.bulk_action_snapshots.create_index(
        [("company_id", 1), ("created_at", -1)]
    )


def _project_row(t: dict) -> dict:
    """Extract just the fields we might restore."""
    out = {"id": t["id"]}
    for f in _TXN_FIELDS:
        if f in t:
            out[f] = t.get(f)
    return out


async def snapshot(
    *,
    company_id: str,
    action: str,
    summary: str,
    rows: Iterable[dict],
    actor: dict | None = None,
) -> str:
    """Persist a pre-image snapshot of `rows` and return `snapshot.id`.

    `rows` is a list of raw txn dicts as they exist in Mongo BEFORE
    the mutation runs. Caller must fetch these fresh from Mongo
    (not stale) inside the same request so undo restores the true
    pre-image.
    """
    await ensure_indexes()
    before = [_project_row(r) for r in rows]
    now = datetime.now(timezone.utc)
    doc = {
        "id":           str(uuid.uuid4()),
        "company_id":   company_id,
        "action":       action,
        "actor_id":     (actor or {}).get("id"),
        "actor_email":  (actor or {}).get("email"),
        "created_at":   now.isoformat(),
        "expires_at":   now + timedelta(seconds=_TTL_SECONDS),
        "consumed_at":  None,
        "consumed_by":  None,
        "row_count":    len(before),
        "summary":      summary,
        "before_rows":  before,
    }
    await db.bulk_action_snapshots.insert_one(doc)
    return doc["id"]


async def get(company_id: str, snapshot_id: str) -> dict | None:
    return await db.bulk_action_snapshots.find_one(
        {"id": snapshot_id, "company_id": company_id}
    )


async def list_recent(company_id: str, limit: int = 20) -> list[dict]:
    """Recent bulk actions for the company, newest first. Trims the
    heavy `before_rows` blob so the listing endpoint stays cheap."""
    cur = db.bulk_action_snapshots.find(
        {"company_id": company_id},
        {"before_rows": 0},
    ).sort("created_at", -1).limit(limit)
    out: list[dict] = []
    async for d in cur:
        d.pop("_id", None)
        out.append(d)
    return out


async def apply_undo(company_id: str, snapshot_id: str, actor: dict | None = None) -> dict:
    """Restore the pre-image onto every row in the snapshot that
    still exists in Mongo. Rows that were deleted since the bulk
    action ran are skipped (reported in `skipped_missing`).

    Marks the snapshot consumed so it can't be undone twice.
    """
    snap = await get(company_id, snapshot_id)
    if not snap:
        return {"ok": False, "error": "snapshot_not_found"}
    if snap.get("consumed_at"):
        return {"ok": False, "error": "snapshot_already_consumed",
                "consumed_at": snap["consumed_at"],
                "consumed_by": snap.get("consumed_by")}

    restored = 0
    skipped_missing: list[str] = []
    now = now_iso()

    for row in snap.get("before_rows") or []:
        tid = row.get("id")
        if not tid:
            continue
        # Build the $set from whatever fields we snapshotted for this row.
        set_doc: dict = {"updated_at": now, "ai_source": "undo_bulk"}
        for f in _TXN_FIELDS:
            if f in row:
                set_doc[f] = row.get(f)
        r = await db.transactions.update_one(
            {"id": tid, "company_id": company_id},
            {"$set": set_doc},
        )
        if r.matched_count == 0:
            skipped_missing.append(tid)
        else:
            restored += 1

    await db.bulk_action_snapshots.update_one(
        {"id": snap["id"]},
        {"$set": {
            "consumed_at": now,
            "consumed_by": (actor or {}).get("email"),
        }},
    )
    return {
        "ok":              True,
        "restored":        restored,
        "skipped_missing": skipped_missing,
        "action":          snap.get("action"),
        "summary":         snap.get("summary"),
    }
