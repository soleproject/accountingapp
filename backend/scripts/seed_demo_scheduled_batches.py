"""One-off: seed a small set of realistic scheduled client-review
batches across the current work-week so the Cockpit v7 "This week's
schedule" panel shows something. Idempotent — deletes any prior
`demo_seed=True` scheduled batches before re-creating them.

Run:  python -m backend.scripts.seed_demo_scheduled_batches
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime, timezone, timedelta

from db import db


DEMO_TAG = "demo_scheduled_seed_v1"


# (day-offset from Mon, hour local, minute, item_kind_mix, note)
SLOTS = [
    (0, 10, 0, [("uncategorized", 3), ("w9_missing", 1)], "Mon 10:00 · uncategorized + W-9"),
    (0, 14, 30, [("uncategorized", 2)], "Mon 2:30 · quick uncategorized"),
    (1, 9, 0, [("bank_txfer_ambiguous", 4)], "Tue 9:00 · transfer disambiguation"),
    (1, 15, 0, [("uncategorized", 5), ("unusual_amount", 1)], "Tue 3:00 · big weekly batch"),
    (2, 11, 0, [("w9_missing", 3)], "Wed 11:00 · W-9 chase"),
    (3, 10, 30, [("uncategorized", 2), ("meals_over_cap", 1)], "Thu 10:30 · meals over cap"),
    (3, 16, 0, [("uncategorized", 4)], "Thu 4:00 · month-end sweep"),
    (4, 9, 30, [("uncategorized", 3), ("bank_txfer_ambiguous", 2)], "Fri 9:30 · pre-close batch"),
]


async def _pick_pro_companies(limit: int = 6) -> list[dict]:
    """Companies the pro@axiom.ai user actually has membership in.
    Uses the `memberships` collection (same source of truth the cockpit
    uses via `company_ids_for_user`)."""
    pro = await db.users.find_one({"email": "pro@axiom.ai"})
    if not pro:
        return []
    cids = []
    async for m in db.memberships.find({
        "user_id": pro["id"],
        "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}],
    }):
        cids.append(m.get("company_id"))
    picks = []
    for cid in cids:
        if len(picks) >= limit:
            break
        c = await db.companies.find_one({"id": cid})
        if not c:
            continue
        n = await db.transactions.count_documents({"company_id": cid})
        if n == 0:
            continue
        picks.append(c)
    return picks


def _items_for(kind_mix: list[tuple[str, int]]) -> list[dict]:
    items = []
    for kind, count in kind_mix:
        for _ in range(count):
            items.append({
                "id": str(uuid.uuid4()),
                "kind": kind,
                "status": "pending",
            })
    return items


async def seed() -> None:
    # Purge prior demo seed so this script is idempotent.
    res = await db.client_review_batches.delete_many({"demo_seed": DEMO_TAG})
    print(f"purged {res.deleted_count} prior demo batches")

    companies = await _pick_pro_companies(limit=len(SLOTS))
    if not companies:
        print("no companies with transactions found — nothing to seed")
        return

    now = datetime.now(timezone.utc)
    monday = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    print(f"anchoring to Monday {monday.date().isoformat()}")

    created = 0
    for i, (dow, hour, minute, kind_mix, note) in enumerate(SLOTS):
        company = companies[i % len(companies)]
        scheduled_for = (monday + timedelta(days=dow)).replace(
            hour=hour, minute=minute,
        )
        items = _items_for(kind_mix)
        doc = {
            "id": str(uuid.uuid4()),
            "company_id": company["id"],
            "status": "scheduled",
            "scheduled_for": scheduled_for.isoformat(),
            "expires_at": (scheduled_for + timedelta(days=14)).isoformat(),
            "items": items,
            "answer_count": 0,
            "defer_count": 0,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "client_token": str(uuid.uuid4()),
            "demo_seed": DEMO_TAG,
            "note": note,
        }
        await db.client_review_batches.insert_one(doc)
        created += 1
        print(f"  · {note} → {company.get('name')}")
    print(f"seeded {created} scheduled batches")


if __name__ == "__main__":
    asyncio.run(seed())
