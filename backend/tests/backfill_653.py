"""One-off: backfill contacts on 653, LLC with the new Rocketbooks-style
resolver. Runs the full AI path for ~1,871 rows.
"""
import asyncio, os, sys, time
sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
env = dotenv_values("/app/backend/.env")
os.environ["MONGO_URL"] = env["MONGO_URL"].strip('"')
os.environ["DB_NAME"]  = env["DB_NAME"].strip('"')

from db import db, now_iso
import contact_resolver
from ai_service import resolve_contact_ai

CID = "b81dd049-9018-47b6-b485-83fe5ff8a2c3"

async def main():
    missing = await db.transactions.find({"company_id": CID}).to_list(20000)
    total = len(missing)
    print(f"backfilling {total} rows with rocketbooks-style resolver...")
    items = [{
        "merchant_name": t.get("merchant_name"),   # may be None
        "description":   t.get("description"),
        "pfc_primary":   t.get("pfc_primary"),
    } for t in missing]
    t0 = time.time()
    results = await contact_resolver.resolve_contacts_batch(
        CID, items, ai_fallback_fn=resolve_contact_ai, concurrency=8,
    )
    elapsed = time.time() - t0
    resolved = no_cp = 0
    now = now_iso()
    for t, r in zip(missing, results):
        if r.get("contact_id"):
            await db.transactions.update_one(
                {"id": t["id"], "company_id": CID},
                {"$set": {"contact_id":r["contact_id"], "contact_name":r["contact_name"],
                          "contact_source":r.get("source"), "updated_at":now}},
            )
            resolved += 1
        else:
            await db.transactions.update_one(
                {"id": t["id"], "company_id": CID},
                {"$set": {"contact_source": r.get("source") or "no_counterparty", "updated_at": now}},
            )
            no_cp += 1
    n = await db.contacts.count_documents({"company_id": CID})
    print(f"DONE in {elapsed:.1f}s")
    print(f"contacts={n}  resolved={resolved}  no_counterparty={no_cp}")

asyncio.run(main())
