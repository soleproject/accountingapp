"""Seed fake "This Week's Schedule" appointments on the Cockpit.

The Cockpit's `WeekGrid` reads `db.client_review_batches` where
``status: "scheduled"`` and ``scheduled_for`` falls in the current
Mon..Sun window. This script minta a handful of those per weekday
(2-4 each) across every company the target pro can access, so the
demo view actually shows a full week's book of check-ins instead of
the "No remaining check-ins this week" fallback.

Usage
-----
    cd /app/backend && PYTHONPATH=/app/backend \
        python scripts/seed_week_schedule.py

The script:
  1. Wipes any prior fake schedule rows tagged `seed_week_schedule_v1`.
  2. Fetches every company where `primary_pro_id == pro@axiom.ai`.
  3. For Mon-Fri of the current week, picks 2-4 companies and mints
     a `status: "scheduled"` batch at a plausible business-hour time
     (9 AM · 11 AM · 1 PM · 3 PM · 4:30 PM slots).
  4. Each batch carries a tiny synthetic items[] so the WeekGrid
     shows a real "count + type mix" pill instead of "0 items".
"""
from __future__ import annotations
import asyncio, os, random, uuid
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME   = os.environ["DB_NAME"]

_client = AsyncIOMotorClient(MONGO_URL)
db      = _client[DB_NAME]

PRO_EMAIL = "pro@axiom.ai"
DEMO_TAG  = "seed_week_schedule_v1"

# Business-hour time slots (24h). Each day picks 2-4 of these.
SLOTS = ["09:00", "10:30", "12:00", "14:00", "15:30", "16:30"]

# Item-mix templates. Each maps to a plausible types breakdown so the
# WeekGrid pill reads like real check-in work.
MIXES = [
    [1, 1, 1, 3, 10],       # uncat + missing receipt + meals
    [1, 1, 11, 12],         # uncat + owner draw + deposit
    [2, 3, 3],              # vendor confirm + 2 missing receipts
    [1, 8, 14],             # uncat + split + travel
    [4, 6, 7],              # w9 + recurring + setup
    [1, 1, 1, 1, 15],       # bulk uncat + ai cleanup
]

WHY = [
    "Weekly bookkeeping review",
    "Month-end close prep",
    "Payroll-week reconciliation",
    "Receipts + owner draws",
    "1099 prep",
    "IRS §274 substantiation",
]


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _make_items(mix: list[int]) -> list[dict]:
    """Cheapest possible synthetic item list so the WeekGrid can show
    a count + type-mix pill without any downstream side effects."""
    return [{
        "item_id":   f"sched-item-{uuid.uuid4()}",
        "item_type": t,
        "kind":      f"type_{t}",
        "status":    "open",
        "prompt":    "scheduled placeholder",
        "context":   {},
        "answered_at": None,
        "answer":      None,
        "deferred":    False,
    } for t in mix]


async def main() -> int:
    pro = await db.users.find_one({"email": PRO_EMAIL})
    if not pro:
        print(f"FATAL: {PRO_EMAIL!r} not found.")
        return 2

    companies: list[dict] = []
    async for c in db.companies.find({"$or": [
        {"primary_pro_id": pro["id"]},
        {"pro_user_id":    pro["id"]},
        {"owner_user_id":  pro["id"]},
    ]}):
        companies.append(c)
    if not companies:
        print(f"FATAL: {PRO_EMAIL!r} has no companies.")
        return 2

    # Wipe prior fake schedule rows.
    del_res = await db.client_review_batches.delete_many({"demo_tag": DEMO_TAG})
    print(f"cleaned up {del_res.deleted_count} prior scheduled batches")

    # Current-week Mon..Fri anchor (in UTC — the Cockpit compares by ISO).
    now = datetime.now(timezone.utc)
    week_start = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )

    minted = 0
    for dow, dayname in enumerate(("Mon", "Tue", "Wed", "Thu", "Fri")):
        day = week_start + timedelta(days=dow)
        # 2-4 appointments per day.
        n = random.choice([2, 3, 4])
        # Pick n unique companies (with repeat if fewer companies exist).
        picks = (random.sample(companies, k=n) if len(companies) >= n
                 else random.choices(companies, k=n))
        # Distinct time slots per day.
        slots = random.sample(SLOTS, k=n)
        for co, slot in zip(picks, slots):
            hh, mm = (int(x) for x in slot.split(":"))
            scheduled_at = day.replace(hour=hh, minute=mm)
            mix   = random.choice(MIXES)
            items = _make_items(mix)
            batch_id = f"sched-{DEMO_TAG}-{uuid.uuid4()}"
            await db.client_review_batches.insert_one({
                "id":              batch_id,
                "company_id":      co["id"],
                "client_email":    co.get("client_email") or "client@example.test",
                "client_token":    uuid.uuid4().hex,   # required, unused for scheduled
                "status":          "scheduled",
                "scheduled_for":   _iso(scheduled_at),
                "scheduled_reason": random.choice(WHY),
                "items":           items,
                "answer_count":    0,
                "created_at":      _iso(now),
                "updated_at":      _iso(now),
                "demo_tag":        DEMO_TAG,
            })
            minted += 1
            print(f"  {dayname} {slot} · {co.get('name'):<24} · {len(items)} items ({','.join(str(t) for t in mix)})")

    print("\n" + "=" * 60)
    print(f"  Seeded {minted} scheduled batches across Mon-Fri")
    print(f"  Companies: {len(companies)} · Demo tag: {DEMO_TAG}")
    print(f"  Refresh the Cockpit — 'This week's schedule' will fill in.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
