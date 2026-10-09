"""Seed demo "In Progress" conversations for the Cockpit:
  - 3 live client conversations (status in_progress)  → Client Messages tab
  - 2 silent clients (status sent, 4-6 days ago)      → Client Cockpit tab (assistant)
Idempotent: purges rows tagged demo_tag=seed_inprogress_v1 first.

    cd /app/backend && PYTHONPATH=/app/backend python scripts/seed_cockpit_inprogress.py
"""
from __future__ import annotations
import asyncio, os, random, uuid
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient

db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
PRO_EMAIL = "pro@axiom.ai"
DEMO_TAG = "seed_inprogress_v1"

PROMPTS = [
    ("uncategorized", "Home Depot · $240.18 on Sep 14 — supplies for a job, or equipment you'll keep?"),
    ("receipt_match", "We found a $86.40 receipt from Shell but no matching card charge. Paid cash, or a different card?"),
    ("meals", "Olive Garden · $64.20 on Sep 19 — who was there and what was discussed?"),
    ("transfer", "$2,500 from Chase ••4410 to Chase ••7781 on Sep 20 — a transfer between your accounts?"),
    ("personal", "Amazon · $129.99 on Sep 22 — business or personal?"),
    ("w9", "You paid Delgado Electric $1,850 this year — we need their W-9 before 1099 season. Can you ask them?"),
]


def _item(kind: str, prompt: str, status: str, mins_ago: int) -> dict:
    now = datetime.now(timezone.utc)
    answered = status in ("answered", "deferred")
    return {
        "item_id": f"ip-item-{uuid.uuid4()}", "item_type": 1, "kind": kind, "status": status,
        "prompt": prompt, "context": {},
        "answered_at": (now - timedelta(minutes=mins_ago)).isoformat() if answered else None,
        "answer": ("Business — supplies" if status == "answered" else None),
        "deferred": status == "deferred",
    }


async def main() -> int:
    pro = await db.users.find_one({"email": PRO_EMAIL})
    if not pro:
        print("pro not found"); return 2
    companies = [c async for c in db.companies.find({"$or": [
        {"primary_pro_id": pro["id"]}, {"pro_user_id": pro["id"]}, {"owner_user_id": pro["id"]}]}, {"_id": 0, "id": 1, "name": 1})]
    if len(companies) < 2:
        print("not enough companies"); return 2
    res = await db.client_review_batches.delete_many({"demo_tag": DEMO_TAG})
    print(f"purged {res.deleted_count}")
    now = datetime.now(timezone.utc)
    random.shuffle(companies)
    live, silent = companies[:3], companies[3:5] or companies[:2]

    for i, c in enumerate(live):
        picks = random.sample(PROMPTS, k=random.choice([4, 5, 6]))
        answered_n = random.choice([1, 2, 3])
        items = [_item(k, p, "answered" if j < answered_n else ("deferred" if j == answered_n and random.random() < .4 else "open"), (answered_n - j) * 3)
                 for j, (k, p) in enumerate(picks)]
        started = now - timedelta(minutes=random.choice([6, 14, 27, 41]))
        await db.client_review_batches.insert_one({
            "id": str(uuid.uuid4()), "company_id": c["id"], "client_email": None, "client_token": uuid.uuid4().hex,
            "status": "in_progress", "scheduled_for": started.isoformat(), "sent_at": started.isoformat(),
            "started_at": started.isoformat(), "updated_at": (now - timedelta(minutes=i)).isoformat(),
            "items": items, "answer_count": answered_n, "demo_tag": DEMO_TAG,
        })
        print(f"live: {c['name']} · {answered_n}/{len(items)}")

    for c in silent:
        days = random.choice([4, 5, 6])
        sent = now - timedelta(days=days, hours=3)
        items = [_item(k, p, "open", 0) for k, p in random.sample(PROMPTS, k=3)]
        await db.client_review_batches.insert_one({
            "id": str(uuid.uuid4()), "company_id": c["id"], "client_email": None, "client_token": uuid.uuid4().hex,
            "status": "reminded" if days >= 5 else "sent", "scheduled_for": sent.isoformat(), "sent_at": sent.isoformat(),
            "reminder_at": (sent + timedelta(days=2)).isoformat(), "updated_at": sent.isoformat(),
            "items": items, "answer_count": 0, "demo_tag": DEMO_TAG,
        })
        print(f"silent: {c['name']} · {days}d")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
