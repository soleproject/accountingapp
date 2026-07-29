"""Cleanup any TEST_ prefixed rows created during iter50 UI/regression tests."""
import asyncio, sys
sys.path.insert(0, "/app/backend")
from db import db

async def main():
    r1 = await db.referral_earnings.delete_many({"id": {"$regex": "^TEST_"}})
    r2 = await db.referral_payout_batches.delete_many(
        {"$or": [{"external_ref": {"$in": ["WISE-UI-TEST", "WISE-TEST", "CHERRY-1", "IDEMP-1", "REV-TEST"]}},
                 {"note": "UI iter50 test"}]})
    print(f"deleted earnings: {r1.deleted_count}, batches: {r2.deleted_count}")

asyncio.run(main())
