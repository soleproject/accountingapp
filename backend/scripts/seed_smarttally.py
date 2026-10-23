"""Seed the SmartTally partner + a SmartTally affiliate for testing the
affiliate custom-pricing flow (production has these; preview didn't).

    cd /app/backend && PYTHONPATH=/app/backend python scripts/seed_smarttally.py
"""
import asyncio, os, uuid
from datetime import datetime, timezone
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient
from auth import hash_password  # noqa: E402

db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]

PARTNER = {"email": "smarttally@axiom.ai", "name": "Chris Tally", "password": "partner123", "role": "partner",
           "branding": {"firm_name": "SmartTally", "subdomain": "smarttally", "signin_subdomain": "smarttally", "primary_color": "#0ea5e9"}}
AFFILIATE = {"email": "affiliate.smarttally@axiom.ai", "name": "Sam Seller", "password": "affiliate123", "role": "affiliate",
             "signup_firm_slug": "smarttally", "referral_slug": "samseller"}


async def upsert(spec):
    now = datetime.now(timezone.utc).isoformat()
    existing = await db.users.find_one({"email": spec["email"]})
    doc = {k: v for k, v in spec.items() if k != "password"}
    doc["password"] = hash_password(spec["password"])
    doc["updated_at"] = now
    if existing:
        await db.users.update_one({"email": spec["email"]}, {"$set": doc})
        return existing["id"]
    doc.update({"id": str(uuid.uuid4()), "created_at": now})
    await db.users.insert_one(doc)
    return doc["id"]


async def main():
    pid = await upsert(PARTNER)
    if not await db.partners.find_one({"id": pid}):
        await db.partners.insert_one({"id": pid, "user_id": pid, "slug": "smarttally", "created_at": datetime.now(timezone.utc).isoformat()})
    try:
        from partners import ensure_partner_books_company_for_partner
        await ensure_partner_books_company_for_partner(pid)
    except Exception as e:  # noqa: BLE001
        print("partner books warning:", e)
    aid = await upsert(AFFILIATE)
    print("partner", pid, "| affiliate", aid)


if __name__ == "__main__":
    asyncio.run(main())
