"""Idempotent de-duplicator for Firm Books companies.

Symptom this script fixes: enterprise pro users seeing "— Firm Books"
listed multiple times in the company switcher on production. Root
cause: the boot-time backfill in `enterprises.ensure_default_enterprise`
ran on top of legacy firm-books-named rows that pre-dated the
`is_firm_books=True` flag, so each restart created a new one.

The rewritten helper (`enterprises.ensure_firm_books_company_for_pro`)
now finds legacy rows by name pattern and retro-stamps the flag — but
we still need to clean up any duplicates that already made it in.

## What this script does (safe / idempotent)

1. Groups all firm-books-shaped companies by `owner_user_id`.
2. Picks the CANONICAL one — the oldest by `created_at` (falls back to
   the one flagged `is_firm_books=True` if timestamps are missing).
3. Merges duplicates INTO the canonical:
     - transactions, invoices, bills, journal_entries, accounts,
       payments, contacts, items reassigned via `company_id` update
     - memberships de-duped on (user_id, company_id)
4. Deletes the drained duplicate company rows.

Nothing else touches other collections. Safe to re-run — a second run
finds no duplicates and exits clean.

Usage:
    cd /app/backend && python3 scripts/dedupe_firm_books.py           # dry run
    cd /app/backend && python3 scripts/dedupe_firm_books.py --apply   # actually delete
"""
import asyncio
import sys
from typing import Optional

sys.path.insert(0, "/app/backend")

from db import db

# Collections that carry a `company_id` reference and should be
# migrated onto the canonical company before its duplicates are
# deleted. Skips membership + audit collections (handled separately).
CHILD_COLLECTIONS = [
    "transactions", "invoices", "bills", "journal_entries",
    "accounts", "payments", "contacts", "items",
    "audit_events",       # keep the trail attached to the surviving row
    "recurring_templates", "estimates", "purchase_orders",
    "sales_receipts", "credit_memos", "refund_receipts", "deposits",
    "inventory_adjustments", "loans", "reconciliations",
    "bank_match_pairs", "qbo_settings",
]


async def _find_dup_groups() -> list[dict]:
    pipeline = [
        {"$match": {
            "$or": [
                {"is_firm_books": True},
                {"name": {"$regex": r"—\s*Firm Books\s*$"}},
            ],
        }},
        {"$group": {
            "_id": "$owner_user_id",
            "companies": {"$push": {
                "id": "$id", "name": "$name",
                "is_firm_books": "$is_firm_books",
                "created_at": "$created_at",
            }},
            "n": {"$sum": 1},
        }},
        {"$match": {"n": {"$gt": 1}}},
    ]
    return await db.companies.aggregate(pipeline).to_list(10000)


def _pick_canonical(companies: list[dict]) -> dict:
    """Oldest wins. Prefer one that already has the flag set — if both
    do, still pick oldest. Missing `created_at` sorts last so a legacy
    row without a timestamp is only chosen if nothing else exists."""
    def sort_key(c):
        # Rows with the flag beat rows without (0 vs 1 puts flagged first)
        flag_rank = 0 if c.get("is_firm_books") else 1
        ts = c.get("created_at") or "9999-99-99"
        return (flag_rank, ts)
    return sorted(companies, key=sort_key)[0]


async def _merge_children(from_cid: str, to_cid: str) -> dict:
    """Reassign every child-collection row from `from_cid` onto
    `to_cid`. Returns per-collection row counts touched."""
    touched = {}
    for coll_name in CHILD_COLLECTIONS:
        coll = db[coll_name]
        r = await coll.update_many(
            {"company_id": from_cid},
            {"$set": {"company_id": to_cid}},
        )
        if r.modified_count:
            touched[coll_name] = r.modified_count
    # Memberships need dedup — if the same user already belongs to
    # the canonical company, drop the duplicate row entirely rather
    # than causing a (user_id, company_id) collision.
    async for m in db.memberships.find({"company_id": from_cid}):
        exists = await db.memberships.find_one(
            {"user_id": m["user_id"], "company_id": to_cid},
        )
        if exists:
            await db.memberships.delete_one({"_id": m["_id"]})
        else:
            await db.memberships.update_one(
                {"_id": m["_id"]}, {"$set": {"company_id": to_cid}},
            )
    return touched


async def main() -> None:
    apply = "--apply" in sys.argv
    print(f"{'APPLY' if apply else 'DRY RUN'} — de-duplicating firm-books companies\n")

    groups = await _find_dup_groups()
    if not groups:
        print("No duplicates found. Nothing to do.")
        return

    total_deletes = 0
    for g in groups:
        owner_id = g["_id"]
        u = await db.users.find_one({"id": owner_id}, {"email": 1})
        canonical = _pick_canonical(g["companies"])
        duplicates = [c for c in g["companies"] if c["id"] != canonical["id"]]
        print(f"── {u.get('email') if u else owner_id}")
        print(f"   canonical: {canonical['id']} · {canonical['name']} · created={canonical.get('created_at')}")
        for dup in duplicates:
            print(f"   drop:      {dup['id']} · {dup['name']} · created={dup.get('created_at')}")
            if apply:
                touched = await _merge_children(dup["id"], canonical["id"])
                if touched:
                    print(f"     migrated: {touched}")
                await db.companies.delete_one({"id": dup["id"]})
                total_deletes += 1
        # Ensure the survivor is flagged
        if apply and not canonical.get("is_firm_books"):
            await db.companies.update_one(
                {"id": canonical["id"]},
                {"$set": {"is_firm_books": True}},
            )
            print(f"     flagged canonical as is_firm_books=True")

    print()
    if apply:
        print(f"Done. Deleted {total_deletes} duplicate company row(s).")
    else:
        print(f"Would delete {sum(len(g['companies']) - 1 for g in groups)} rows.")
        print("Re-run with --apply to actually delete.")


if __name__ == "__main__":
    asyncio.run(main())
