"""Seed expired client-review batches so the "Human Assistant Can Help"
panel on Today v7 has more than one item to demo the carousel + View
all page. Idempotent — clears prior `demo_ghost_seed` inserts.

Run:  python -m scripts.seed_demo_ghosted_batches
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime, timezone, timedelta

from db import db


DEMO_TAG = "demo_ghost_seed_v1"


async def _pick_pro_companies(exclude: set[str], limit: int = 3) -> list[dict]:
    pro = await db.users.find_one({"email": "pro@axiom.ai"})
    if not pro:
        return []
    cids = []
    async for m in db.memberships.find({
        "user_id": pro["id"],
        "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}],
    }):
        cid = m.get("company_id")
        if cid and cid not in exclude:
            cids.append(cid)
    picks = []
    for cid in cids:
        if len(picks) >= limit:
            break
        c = await db.companies.find_one({"id": cid})
        if c:
            picks.append(c)
    return picks


async def seed() -> None:
    res = await db.client_review_batches.delete_many({"demo_seed": DEMO_TAG})
    print(f"purged {res.deleted_count} prior demo ghosted batches")

    # Exclude "Sales Tax Tester LLC" (which already has real ghosted data)
    # so we don't double-count.
    excluded = set()
    stt = await db.companies.find_one({"name": "Sales Tax Tester LLC"})
    if stt:
        excluded.add(stt["id"])

    companies = await _pick_pro_companies(excluded, limit=3)
    if not companies:
        print("no companies available")
        return

    now = datetime.now(timezone.utc)
    # Each of 3 companies gets 3 expired batches → cnt >= 2 threshold.
    created = 0
    for c in companies:
        for i in range(3):
            expired_at = (now - timedelta(days=(i + 1) * 3)).isoformat()
            doc = {
                "id": str(uuid.uuid4()),
                "company_id": c["id"],
                "status": "expired",
                "scheduled_for": (now - timedelta(days=(i + 1) * 3 + 7)).isoformat(),
                "expires_at": expired_at,
                "expired_at": expired_at,
                "items": [
                    {"id": str(uuid.uuid4()), "kind": "uncategorized", "status": "pending"},
                    {"id": str(uuid.uuid4()), "kind": "uncategorized", "status": "pending"},
                ],
                "answer_count": 0,
                "defer_count": 0,
                "created_at": (now - timedelta(days=(i + 1) * 3 + 14)).isoformat(),
                "updated_at": expired_at,
                "client_token": str(uuid.uuid4()),
                "demo_seed": DEMO_TAG,
            }
            await db.client_review_batches.insert_one(doc)
            created += 1
        print(f"  · {c.get('name')} → 3 expired batches")
    print(f"seeded {created} expired batches")


if __name__ == "__main__":
    asyncio.run(seed())
