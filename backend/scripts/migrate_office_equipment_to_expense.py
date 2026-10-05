"""One-off: flip unused asset-typed "Office Equipment" accounts to operating expense.

Only accounts with zero balance AND no journal/transaction references are
touched. Accounts with postings are reported and left alone.
Run: cd /app/backend && python scripts/migrate_office_equipment_to_expense.py [--dry-run]
"""
from __future__ import annotations
import asyncio
import sys
sys.path.insert(0, "/app/backend")
from db import db, now_iso  # noqa: E402

NEW_CODE = {"uk": "6330"}
DEFAULT_NEW_CODE = "6350"


async def _has_postings(cid: str, aid: str) -> bool:
    if await db.journal_entries.find_one({"company_id": cid, "lines.account_id": aid}, {"_id": 1}):
        return True
    if await db.transactions.find_one(
        {"company_id": cid, "$or": [{"category_account_id": aid}, {"splits.category_account_id": aid}]}, {"_id": 1}
    ):
        return True
    return False


async def main(dry_run: bool) -> None:
    cursor = db.accounts.find({"name": "Office Equipment", "type": "asset"})
    flipped, skipped = [], []
    async for a in cursor:
        cid = a["company_id"]
        if abs(float(a.get("balance") or 0)) > 0.005 or await _has_postings(cid, a["id"]):
            skipped.append((cid, a["code"], a["id"]))
            continue
        company = await db.companies.find_one({"id": cid}, {"region": 1, "name": 1}) or {}
        code = NEW_CODE.get((company.get("region") or "").lower(), DEFAULT_NEW_CODE)
        if await db.accounts.find_one({"company_id": cid, "code": code, "id": {"$ne": a["id"]}}, {"_id": 1}):
            code = f"{code}1"
        update = {"code": code, "type": "expense", "subtype": "operating_expense",
                  "detail_type": "operating_expense", "updated_at": now_iso()}
        if not dry_run:
            await db.accounts.update_one({"id": a["id"]}, {"$set": update})
        flipped.append((cid, company.get("name"), a["code"], code))
    print(f"{'DRY RUN — would flip' if dry_run else 'Flipped'} {len(flipped)} account(s):")
    for row in flipped:
        print("  ", row)
    print(f"Skipped (has balance/postings) {len(skipped)}:")
    for row in skipped:
        print("  ", row)


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv))
