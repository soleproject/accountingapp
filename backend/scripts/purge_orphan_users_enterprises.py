"""Preview-only purge of orphan test enterprises + orphan test users.

Runs AFTER purge_test_companies.py. Cleans up the residual metadata
that no longer points at any surviving company.

KEEP RULES for enterprises:
  * id ∈ {SmartBooks, Northgate Advisory}
  * ALSO keep any enterprise whose owner_user_id is a protected user
  * ALSO keep any enterprise referenced by a surviving company

KEEP RULES for users:
  * email ∈ PROTECTED_EMAILS or matches PROTECTED_EMAIL_REGEX
  * owns any surviving company
  * has any membership to a surviving company
  * appears in db.partners as a real partner
  * is the owner_user_id of a surviving enterprise

Everything else is orphan test scaffolding and gets purged.

Backup written to /app/backups/purge_users_ents_<ts>.json before delete.
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


PROTECTED_EMAILS = {
    "admin@axiom.ai", "pro@axiom.ai", "client@axiom.ai", "client2@axiom.ai",
    "partner@axiom.ai", "demo-uk@smartbooks.ai",
    "michael.f.giorgi@gmail.com",
}
PROTECTED_EMAIL_REGEX = r"@bigsaas\.ai$"

REAL_ENTERPRISE_IDS = {
    "2f4b4d17-4d20-46e8-833b-1b267855eda5",  # SmartBooks
    "69fea111-8be0-457d-933c-7f196d09e969",  # Northgate Advisory
}

# Fields on each collection that reference a user id — used both for
# the orphan-user backup dump and the delete step.
USER_ID_FIELDS = {
    "account_imports":      ["user_id"],
    "ai_usage_events":      ["user_id"],
    "audit_events":         ["actor_user_id"],
    "comms_prefs":          ["user_id"],
    "communications":       ["user_id"],
    "contact_imports":      ["user_id"],
    "insights_chat_log":    ["user_id"],
    "journal_entries":      ["created_by"],
    "memberships":          ["user_id"],
    "partners":             ["user_id"],
    "password_set_tokens":  ["user_id"],
    "plaid_items":          ["user_id"],
    "qbo_oauth_states":     ["user_id"],
    "rules":                ["created_by"],
    "sync_jobs":            ["user_id"],
    "users_companies":      ["user_id"],
}


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # =========================================================
    # 1. Compute survivor sets
    # =========================================================
    surviving_cids = set(await db.companies.distinct("id"))
    print(f"Surviving companies: {len(surviving_cids)}")

    # Explicit protected user ids
    protected_uids: set[str] = set()
    async for u in db.users.find(
        {"$or": [
            {"email": {"$in": list(PROTECTED_EMAILS)}},
            {"email": {"$regex": PROTECTED_EMAIL_REGEX, "$options": "i"}},
        ]},
        {"_id": 0, "id": 1, "email": 1},
    ):
        protected_uids.add(u["id"])
    print(f"Whitelist protected users: {len(protected_uids)}")

    # Add owners of surviving companies
    async for c in db.companies.find(
        {}, {"_id": 0, "owner_user_id": 1, "pro_user_id": 1},
    ):
        for k in ("owner_user_id", "pro_user_id"):
            if c.get(k):
                protected_uids.add(c[k])

    # Add users who have any membership to surviving companies
    async for m in db.memberships.find(
        {"company_id": {"$in": list(surviving_cids)}},
        {"_id": 0, "user_id": 1},
    ):
        protected_uids.add(m["user_id"])

    # Add users referenced by db.partners (real partners)
    async for p in db.partners.find({}, {"_id": 0, "user_id": 1}):
        if p.get("user_id"):
            protected_uids.add(p["user_id"])

    print(f"Total protected user ids: {len(protected_uids)}")

    # =========================================================
    # 2. Compute enterprise KEEP set
    # =========================================================
    keep_ent_ids = set(REAL_ENTERPRISE_IDS)
    async for e in db.enterprises.find({}, {"_id": 0, "id": 1, "owner_user_id": 1}):
        if e.get("owner_user_id") in protected_uids:
            keep_ent_ids.add(e["id"])
    async for c in db.companies.find(
        {"enterprise_id": {"$exists": True, "$ne": None}},
        {"_id": 0, "enterprise_id": 1},
    ):
        keep_ent_ids.add(c["enterprise_id"])

    all_ent_ids = set(await db.enterprises.distinct("id"))
    delete_ent_ids = list(all_ent_ids - keep_ent_ids)
    print(f"\nEnterprises: total={len(all_ent_ids)}  keep={len(keep_ent_ids)}  delete={len(delete_ent_ids)}")

    # =========================================================
    # 3. Compute users to delete
    # =========================================================
    all_uids = set(await db.users.distinct("id"))
    delete_uids = list(all_uids - protected_uids)
    print(f"Users:       total={len(all_uids)}  keep={len(protected_uids)}  delete={len(delete_uids)}")

    if not delete_ent_ids and not delete_uids:
        print("\nNothing to delete. Exiting.")
        return

    # =========================================================
    # 4. Backup
    # =========================================================
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = Path("/app/backups")
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"purge_users_ents_{stamp}.json"

    dump: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "delete_enterprises_count": len(delete_ent_ids),
        "delete_users_count": len(delete_uids),
        "delete_enterprise_ids": delete_ent_ids,
        "delete_user_ids": delete_uids,
        "enterprises": [],
        "users": [],
        "by_collection": {},
    }

    async for e in db.enterprises.find({"id": {"$in": delete_ent_ids}}, {"_id": 0}):
        dump["enterprises"].append(e)

    async for u in db.users.find({"id": {"$in": delete_uids}}, {"_id": 0}):
        dump["users"].append(u)

    for cn, fields in USER_ID_FIELDS.items():
        query = {"$or": [{f: {"$in": delete_uids}} for f in fields]}
        rows = []
        async for r in db[cn].find(query, {"_id": 0}):
            rows.append(r)
        dump["by_collection"][cn] = rows

    with backup_path.open("w") as f:
        json.dump(dump, f, default=str)
    print(f"\nBackup written: {backup_path}  ({backup_path.stat().st_size / 1024:.1f} KB)")

    # =========================================================
    # 5. Delete enterprises
    # =========================================================
    print("\n=== DELETING ENTERPRISES ===")
    if delete_ent_ids:
        res = await db.enterprises.delete_many({"id": {"$in": delete_ent_ids}})
        print(f"  enterprises            : {res.deleted_count:6d}")

    # =========================================================
    # 6. Delete users + their scattered rows
    # =========================================================
    print("\n=== DELETING USERS + REFERENCES ===")
    total = 0
    if delete_uids:
        res = await db.users.delete_many({"id": {"$in": delete_uids}})
        print(f"  users                  : {res.deleted_count:6d}")
        total += res.deleted_count
        for cn, fields in USER_ID_FIELDS.items():
            query = {"$or": [{f: {"$in": delete_uids}} for f in fields]}
            r = await db[cn].delete_many(query)
            if r.deleted_count:
                print(f"  {cn:25s}: {r.deleted_count:6d}")
            total += r.deleted_count
    print(f"\nTOTAL ROWS DELETED (users + user-refs): {total}")
    print(f"Backup: {backup_path}")


if __name__ == "__main__":
    asyncio.run(main())
