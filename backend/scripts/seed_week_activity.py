"""Seed demo "this week" AI activity for pro@axiom.ai's client companies.

Mints auto-posted transactions (ai_source set, needs_review=False) and
uploaded receipts dated within the last 7 days so the Cockpit
"AI Junior · This week" tile and the Transactions / Receipts pages show
realistic activity for a demo. Last week gets a smaller batch too so the
"vs last week" delta reads as growth.

Usage:
    cd /app/backend && PYTHONPATH=/app/backend python scripts/seed_week_activity.py
Re-running wipes prior rows tagged `seed_week_activity_v1` first.
"""
from __future__ import annotations
import asyncio, os, random, uuid
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient

db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
PRO_EMAIL = "pro@axiom.ai"
DEMO_TAG = "seed_week_activity_v1"

MERCHANTS = [
    ("Staples", "STAPLES #1142", "Office", (24, 180)),
    ("Shell", "SHELL OIL 57442", "Auto", (38, 95)),
    ("Amazon", "AMZN MKTP US*2K7", "Office", (15, 240)),
    ("Costco", "COSTCO WHSE #0441", "Supplies", (85, 420)),
    ("Uber", "UBER *TRIP", "Travel", (12, 64)),
    ("Chipotle", "CHIPOTLE 2291", "Meals", (14, 58)),
    ("Home Depot", "THE HOME DEPOT #6234", "Repairs", (32, 310)),
    ("Verizon", "VERIZON WIRELESS", "Telephone", (110, 190)),
    ("Google", "GOOGLE *WORKSPACE", "Software", (18, 144)),
    ("Delta", "DELTA AIR LINES", "Travel", (180, 640)),
    ("Marriott", "MARRIOTT HOTELS", "Travel", (160, 390)),
    ("FedEx", "FEDEX OFFICE 1180", "Shipping", (9, 72)),
    ("Starbucks", "STARBUCKS STORE 08812", "Meals", (6, 32)),
    ("Lowe's", "LOWES #02285", "Repairs", (28, 260)),
    ("USPS", "USPS PO 0441270", "Shipping", (8, 45)),
]
AI_SOURCES = ["rule", "contact_directory", "llm", "plaid_pfc"]


def _iso(dt): return dt.isoformat()


async def _pick_account(cid, hint):
    acc = await db.accounts.find_one(
        {"company_id": cid, "type": "expense", "name": {"$regex": hint, "$options": "i"}},
        {"id": 1, "name": 1, "code": 1})
    if not acc:
        acc = await db.accounts.find_one({"company_id": cid, "type": "expense", "code": {"$nin": ["9999", "6999"]}},
                                         {"id": 1, "name": 1, "code": 1})
    return acc or {}


async def _bank(cid):
    return await db.accounts.find_one({"company_id": cid, "code": "1010"}, {"id": 1, "name": 1}) \
        or await db.accounts.find_one({"company_id": cid, "type": "asset"}, {"id": 1, "name": 1}) or {}


async def seed_company(co, now, days_lo, days_hi, n_txn, n_receipts):
    cid = co["id"]
    bank = await _bank(cid)
    txn_ids = []
    for _ in range(n_txn):
        m, desc, hint, (lo, hi) = random.choice(MERCHANTS)
        acc = await _pick_account(cid, hint)
        when = now - timedelta(days=random.randint(days_lo, days_hi), hours=random.randint(1, 12))
        amt = -round(random.uniform(lo, hi), 2)
        tid = f"demo-wk-{uuid.uuid4()}"
        txn_ids.append((tid, m, when, -amt, acc))
        await db.transactions.insert_one({
            "id": tid, "company_id": cid, "date": when.date().isoformat(), "amount": amt,
            "description": desc, "merchant": m, "contact_name": m,
            "bank_account_id": bank.get("id"), "bank_account_name": bank.get("name") or "Business Checking",
            "category_account_id": acc.get("id"), "category_account_name": acc.get("name"),
            "category_account_code": acc.get("code"),
            "posted": True, "needs_review": False, "human_reviewed": False,
            "ai_source": random.choice(AI_SOURCES),
            "ai_comment": f"Auto-categorized to {acc.get('name') or 'expense'} from a learned rule.",
            "posted_at": _iso(when), "created_at": _iso(when), "updated_at": _iso(when),
            "demo_tag": DEMO_TAG,
        })
    for i in range(n_receipts):
        if i < len(txn_ids):
            tid, m, when, amt, acc = txn_ids[i]
            match = {"matched_transaction_id": tid, "matched_at": _iso(when + timedelta(minutes=20)),
                     "match_status": "verified"}
            await db.transactions.update_one({"id": tid}, {"$set": {"receipt_match_status": "matched"}})
        else:
            m, _, hint, (lo, hi) = random.choice(MERCHANTS)
            acc = await _pick_account(cid, hint)
            when = now - timedelta(days=random.randint(days_lo, days_hi), hours=random.randint(1, 12))
            amt = round(random.uniform(lo, hi), 2)
            match = {}
        await db.receipts.insert_one({
            "id": f"demo-wk-r-{uuid.uuid4()}", "company_id": cid,
            "date": when.date().isoformat(), "amount": amt, "merchant": m,
            "category_account_id": acc.get("id"), "notes": f"Uploaded via client check-in · {m}",
            "source": "client_review", "ai_narrative": f"{m} receipt — AI matched the total and vendor.",
            "created_at": _iso(when + timedelta(minutes=5)), "updated_at": _iso(when + timedelta(minutes=5)),
            "demo_tag": DEMO_TAG, **match,
        })


async def main():
    pro = await db.users.find_one({"email": PRO_EMAIL})
    if not pro:
        print("pro not found"); return 2
    mids = [m["company_id"] async for m in db.memberships.find({"user_id": pro["id"], "archived_at": None})]
    companies = [c async for c in db.companies.find({"id": {"$in": mids}, "is_firm_books": {"$ne": True}})]
    for coll in (db.transactions, db.receipts):
        r = await coll.delete_many({"demo_tag": DEMO_TAG})
        print(f"cleaned {r.deleted_count} from {coll.name}")
    now = datetime.now(timezone.utc)
    total_t = total_r = 0
    for co in companies:
        nt, nr = random.randint(6, 12), random.randint(3, 6)
        await seed_company(co, now, 0, 6, nt, nr)          # this week
        await seed_company(co, now, 7, 13, max(2, nt // 2), max(1, nr // 2))  # last week
        total_t += nt; total_r += nr
        print(f"  {co['name']:<28} +{nt} txns / +{nr} receipts this week")
    print(f"\nSeeded {total_t} this-week transactions and {total_r} receipts across {len(companies)} companies.")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
