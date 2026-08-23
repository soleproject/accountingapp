"""One-off: pull QBO books-close date for every connected company
and auto-approve every QBO-imported transaction on/before that date.

Mirrors the logic that now lives inline in `qbo_service.run_migration`
so existing companies get the "Reviewed · 100%" treatment without
requiring a full re-migration. Safe to re-run — one-way ratchet:
never un-approves anything.
"""
import os
import sys
import asyncio
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")

from qbo_service import fetch_books_close_date  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    conns = await db.qbo_connections.find({}, {"_id": 0}).to_list(500)
    print(f"QBO connections: {len(conns)}")

    total_approved = 0
    for conn in conns:
        cid = conn.get("company_id")
        realm_id = conn.get("realm_id")
        if not cid or not realm_id:
            continue
        company = await db.companies.find_one({"id": cid}, {"_id": 0, "name": 1})
        cname = (company or {}).get("name", "?")

        try:
            close_date = await fetch_books_close_date(cid, realm_id)
        except Exception as e:
            print(f"  ✗ {cname:40s}  cid={cid}  fetch failed: {e}")
            continue

        if not close_date:
            print(f"  · {cname:40s}  no close date set on QBO — skipped")
            continue

        await db.qbo_connections.update_one(
            {"company_id": cid},
            {"$set": {
                "books_closed_through": close_date,
                "books_closed_synced_at": _now_iso(),
            }},
        )
        res = await db.transactions.update_many(
            {
                "company_id": cid,
                "source": "qbo",
                "date": {"$lte": close_date},
                "human_reviewed": {"$ne": True},
            },
            {"$set": {
                "human_reviewed": True,
                "needs_review": False,
                "ai_confidence": 1.0,
                "qbo_closed_through": close_date,
                "qbo_closed_approved_at": _now_iso(),
            }},
        )
        total_approved += res.modified_count
        print(
            f"  ✓ {cname:40s}  closed_through={close_date}  "
            f"auto-approved={res.modified_count}"
        )

    print(f"\nTotal newly-auto-approved: {total_approved}")


if __name__ == "__main__":
    asyncio.run(main())
