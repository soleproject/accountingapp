"""Backfill: mine rule candidates for every existing company.

Ships alongside the new `rules_miner.py`. Runs the same logic that
now fires at the tail of `qbo_service.run_migration`, but against
every company already in the DB so pros see the effect immediately
without needing a re-migration.

Safe to re-run — the miner is idempotent (never creates duplicates,
never touches already-existing rules).
"""
import os
import sys
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")

from rules_miner import mine_rule_candidates  # noqa: E402


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    companies = await db.companies.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(500)
    print(f"Companies to scan: {len(companies)}")

    total_scanned = 0
    total_candidates = 0
    total_auto = 0
    for c in companies:
        cid = c["id"]
        name = c.get("name") or "(unnamed)"
        try:
            r = await mine_rule_candidates(cid)
        except Exception as e:
            print(f"  ✗ {name[:38]:38s}  ERROR {e}")
            continue
        if r["scanned"] == 0:
            continue
        print(
            f"  · {name[:38]:38s}  "
            f"scanned={r['scanned']:5d}  clusters={r['clusters']:4d}  "
            f"candidates={r['candidates']:3d}  auto={r['auto_applied']:3d}  "
            f"already={r['skipped_existing']:3d}"
        )
        total_scanned += r["scanned"]
        total_candidates += r["candidates"]
        total_auto += r["auto_applied"]

    print(
        f"\nTOTAL — scanned {total_scanned}, "
        f"new candidates {total_candidates}, "
        f"auto-applied rules {total_auto}"
    )


if __name__ == "__main__":
    asyncio.run(main())
