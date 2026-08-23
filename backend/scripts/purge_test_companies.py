"""Preview-only purge of orphaned test companies.

Deletes 942 auto-generated test/fixture companies and every record
tied to them across all collections that carry `company_id`. A full
JSON dump of every deleted row is written to /app/backups/ first so
the operation is recoverable if anything is over-selected.

KEEP RULES (any match = keep):
  * id ends with "-preview-clone"                    (prod → preview clones)
  * has an entry in qbo_connections                  (QBO-connected)
  * is_uk_demo=True OR region=UK OR currency=GBP     (UK demo/test)
  * owner_user_id ∈ protected_users                  (real users)
  * appears in memberships for protected_users
  * is_partner_books AND partner_id ∈ db.partners    (real partner books)
  * enterprise_id ∈ {SmartBooks, Northgate Advisory} (real enterprises)

Protected users:
  * demo accounts: admin/pro/client/client2/partner @axiom.ai, demo-uk@smartbooks.ai
  * you: michael@bigsaas.ai + any michael+*@bigsaas.ai alias
  * michael.f.giorgi@gmail.com
"""
import os
import sys
import json
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")


PROTECTED_EMAILS = [
    "admin@axiom.ai", "pro@axiom.ai", "client@axiom.ai", "client2@axiom.ai",
    "partner@axiom.ai", "demo-uk@smartbooks.ai",
    "michael.f.giorgi@gmail.com",
]
PROTECTED_EMAIL_REGEX = r"@bigsaas\.ai$"  # covers michael@ and michael+*@

REAL_ENTERPRISE_IDS = [
    "2f4b4d17-4d20-46e8-833b-1b267855eda5",  # SmartBooks
    "69fea111-8be0-457d-933c-7f196d09e969",  # Northgate Advisory
]


async def build_keep_set(db) -> set[str]:
    keep: set[str] = set()

    # protected user ids
    protected_users = await db.users.find({
        "$or": [
            {"email": {"$in": PROTECTED_EMAILS}},
            {"email": {"$regex": PROTECTED_EMAIL_REGEX, "$options": "i"}},
        ]
    }, {"_id": 0, "id": 1, "email": 1}).to_list(200)
    protected_uids = [u["id"] for u in protected_users]

    all_c = await db.companies.find({}, {
        "_id": 0, "id": 1, "owner_user_id": 1,
        "is_uk_demo": 1, "region": 1, "currency": 1,
        "is_partner_books": 1, "partner_id": 1, "enterprise_id": 1,
    }).to_list(2000)

    for c in all_c:
        cid = c["id"]
        if cid.endswith("-preview-clone"):
            keep.add(cid)
        if c.get("is_uk_demo") or c.get("region") == "UK" or c.get("currency") == "GBP":
            keep.add(cid)
        if c.get("owner_user_id") in protected_uids:
            keep.add(cid)
        if c.get("enterprise_id") in REAL_ENTERPRISE_IDS:
            keep.add(cid)

    for cid in await db.qbo_connections.distinct("company_id"):
        keep.add(cid)

    ms = await db.memberships.find(
        {"user_id": {"$in": protected_uids}},
        {"_id": 0, "company_id": 1},
    ).to_list(1000)
    for m in ms:
        keep.add(m["company_id"])

    real_partner_ids = await db.partners.distinct("id")
    pb = await db.companies.find(
        {"is_partner_books": True, "partner_id": {"$in": real_partner_ids}},
        {"_id": 0, "id": 1},
    ).to_list(200)
    for c in pb:
        keep.add(c["id"])

    return keep


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    keep = await build_keep_set(db)
    all_ids = await db.companies.distinct("id")
    delete_ids = [cid for cid in all_ids if cid not in keep]

    print(f"Total companies:  {len(all_ids)}")
    print(f"KEEP:             {len(keep)}")
    print(f"DELETE:           {len(delete_ids)}")

    if not delete_ids:
        print("Nothing to delete. Exiting.")
        return

    # find every collection that carries company_id
    coll_names = await db.list_collection_names()
    coll_with_cid = []
    for cn in coll_names:
        # skip system collections
        if cn.startswith("system."):
            continue
        try:
            has = await db[cn].find_one({"company_id": {"$exists": True}})
        except Exception:
            has = None
        if has:
            coll_with_cid.append(cn)
    coll_with_cid.sort()
    print(f"\nCollections carrying company_id: {len(coll_with_cid)}")

    # 1. BACKUP
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = Path("/app/backups")
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"purge_preview_{stamp}.json"

    dump: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "delete_count": len(delete_ids),
        "delete_ids": delete_ids,
        "companies": [],
        "by_collection": {},
    }

    # companies rows
    async for c in db.companies.find({"id": {"$in": delete_ids}}, {"_id": 0}):
        dump["companies"].append(c)

    # child rows per collection (dump batched to avoid huge memory)
    for cn in coll_with_cid:
        cursor = db[cn].find({"company_id": {"$in": delete_ids}}, {"_id": 0})
        rows = []
        async for r in cursor:
            rows.append(r)
        dump["by_collection"][cn] = rows

    with backup_path.open("w") as f:
        json.dump(dump, f, default=str)
    print(f"\nBackup written: {backup_path}  ({backup_path.stat().st_size / 1024 / 1024:.2f} MB)")

    # 2. DELETE
    print("\n=== DELETING ===")
    total_deleted = 0

    company_res = await db.companies.delete_many({"id": {"$in": delete_ids}})
    print(f"  companies                : {company_res.deleted_count:6d}")
    total_deleted += company_res.deleted_count

    for cn in coll_with_cid:
        res = await db[cn].delete_many({"company_id": {"$in": delete_ids}})
        if res.deleted_count:
            print(f"  {cn:25s}: {res.deleted_count:6d}")
        total_deleted += res.deleted_count

    print(f"\nTOTAL ROWS DELETED: {total_deleted}")
    print(f"Backup: {backup_path}")


if __name__ == "__main__":
    asyncio.run(main())
