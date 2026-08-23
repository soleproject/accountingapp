"""FINAL pass — delete test users by EMAIL PATTERN only (ignore company
ownership so we don't get looped by the on-startup Firm Books re-seed).

Cascades to: their Firm Books companies, memberships, enterprises they
own, and every user-referencing collection listed in USER_ID_FIELDS.
"""
import os
import sys
import re
import json
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")

# Emails that MUST survive under any circumstance.
PROTECTED_EMAILS = {
    "admin@axiom.ai", "pro@axiom.ai", "client@axiom.ai", "client2@axiom.ai",
    "partner@axiom.ai", "demo-uk@smartbooks.ai",
    "michael.f.giorgi@gmail.com",
}
PROTECTED_EMAIL_REGEX = re.compile(r"@bigsaas\.ai$", re.I)

# Every other identifiable test-user pattern.
TEST_EMAIL_REGEX = re.compile(
    r"@example\.com$"
    r"|@resend\.dev$"
    r"|@rbactest\.co$"
    r"|@t\.t$"
    r"|@smartbooks\.test$"
    r"|@test\."
    r"|^test_"
    r"|^user-cash-"
    r"|^owner_[0-9a-f]{6}@"
    r"|^o-[0-9a-f]{6}@"
    r"|^p_[0-9a-f]{6}@"
    r"|^ent-"
    r"|^partner_[0-9a-f]{6}@"
    r"|^pro_[0-9a-f]{6}@"
    r"|^client_[0-9a-f]{6}@"
    r"|^staff_"
    r"|^cid_"
    r"|^demo-p-"
    r"|^dupe-|dupe_",
    re.I,
)

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

    all_users = await db.users.find({}, {"_id": 0, "id": 1, "email": 1, "role": 1}).to_list(2000)
    print(f"Total users: {len(all_users)}")

    delete_users = []
    keep_users = []
    for u in all_users:
        e = (u.get("email") or "").lower()
        if not e:
            delete_users.append(u)  # null-email orphans go
            continue
        if e in PROTECTED_EMAILS or PROTECTED_EMAIL_REGEX.search(e):
            keep_users.append(u)
        elif TEST_EMAIL_REGEX.search(e):
            delete_users.append(u)
        else:
            keep_users.append(u)  # unknown pattern — err on side of keep
            print(f"  ? unknown-pattern kept: {e}")

    delete_uids = [u["id"] for u in delete_users]
    print(f"Delete users: {len(delete_users)}  Keep: {len(keep_users)}")

    if not delete_uids:
        print("Nothing to delete."); return

    # Which companies are owned by these users?
    owned_cs = await db.companies.find(
        {"owner_user_id": {"$in": delete_uids}},
        {"_id": 0, "id": 1, "name": 1},
    ).to_list(2000)
    orphan_cids = [c["id"] for c in owned_cs]
    print(f"Companies owned by soon-to-delete users: {len(orphan_cids)}")

    # Enterprises owned by these users
    owned_ents = await db.enterprises.find(
        {"owner_user_id": {"$in": delete_uids}},
        {"_id": 0, "id": 1, "name": 1},
    ).to_list(500)
    orphan_eids = [e["id"] for e in owned_ents]
    print(f"Enterprises owned by soon-to-delete users: {len(orphan_eids)}")

    # Also grab enterprises that are already orphaned or test-named
    stray_ents = await db.enterprises.find(
        {"$and": [
            {"id": {"$nin": ["2f4b4d17-4d20-46e8-833b-1b267855eda5",
                             "69fea111-8be0-457d-933c-7f196d09e969"]}},
            {"$or": [
                {"owner_user_id": None},
                {"owner_user_id": {"$in": delete_uids}},
                {"name": {"$regex": r"^(CaseyCPA|ExampleFirm|BoomFirm|TESTFirm|SandboxCPA|Ent$|EntBrand)"}},
            ]},
        ]},
        {"_id": 0, "id": 1, "name": 1, "owner_user_id": 1},
    ).to_list(500)
    orphan_eids = list({*orphan_eids, *[e["id"] for e in stray_ents]})
    print(f"Total enterprises to purge: {len(orphan_eids)}")

    # BACKUP
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = Path(f"/app/backups/purge_final_pass_{stamp}.json")
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    dump = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "delete_users": delete_users,
        "delete_companies": owned_cs,
        "delete_enterprises_ids": orphan_eids,
    }
    with backup_path.open("w") as f:
        json.dump(dump, f, default=str)
    print(f"Backup: {backup_path}")

    # DELETE COMPANIES + their child rows
    print("\n=== DELETING re-seeded Firm Books companies ===")
    if orphan_cids:
        # collections carrying company_id
        coll_names = await db.list_collection_names()
        for cn in coll_names:
            if cn.startswith("system."):
                continue
            try:
                has = await db[cn].find_one({"company_id": {"$exists": True}})
            except Exception:
                has = None
            if has:
                r = await db[cn].delete_many({"company_id": {"$in": orphan_cids}})
                if r.deleted_count:
                    print(f"  {cn:25s}: {r.deleted_count}")
        r = await db.companies.delete_many({"id": {"$in": orphan_cids}})
        print(f"  companies                : {r.deleted_count}")

    # DELETE ENTERPRISES
    print("\n=== DELETING enterprises ===")
    if orphan_eids:
        r = await db.enterprises.delete_many({"id": {"$in": orphan_eids}})
        print(f"  enterprises              : {r.deleted_count}")

    # DELETE USERS + their scattered rows
    print("\n=== DELETING users + references ===")
    for cn, fields in USER_ID_FIELDS.items():
        q = {"$or": [{f: {"$in": delete_uids}} for f in fields]}
        r = await db[cn].delete_many(q)
        if r.deleted_count:
            print(f"  {cn:25s}: {r.deleted_count}")
    r = await db.users.delete_many({"id": {"$in": delete_uids}})
    print(f"  users                    : {r.deleted_count}")


if __name__ == "__main__":
    asyncio.run(main())
