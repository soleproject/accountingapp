"""One-off: rebuild contacts for 607, LLC using the new NO_COUNTERPARTY_PFC
gate + description scrubber. Deletes all bot-created contacts first so the
backfill starts clean; user-created / manually-tagged contacts are preserved.

Safe to re-run.
"""
import asyncio, os
from dotenv import dotenv_values
env = dotenv_values("/app/backend/.env")
os.environ["MONGO_URL"] = env["MONGO_URL"].strip('"')
os.environ["DB_NAME"]  = env["DB_NAME"].strip('"')
from motor.motor_asyncio import AsyncIOMotorClient

CID = "b8dd2b57-6719-44ee-af39-68731a55963d"  # 607, LLC

async def main():
    c = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = c[os.environ["DB_NAME"]]

    before_contacts = await db.contacts.count_documents({"company_id": CID})
    print(f"contacts BEFORE = {before_contacts}")

    # Clear bot-created contacts + unpin them from txns
    del_res = await db.contacts.delete_many({"company_id": CID, "created_by_ai": True})
    await db.transactions.update_many(
        {"company_id": CID},
        {"$unset": {"contact_id": "", "contact_name": "", "contact_source": ""}},
    )
    print(f"deleted {del_res.deleted_count} bot contacts and cleared txn assignments")

asyncio.run(main())
