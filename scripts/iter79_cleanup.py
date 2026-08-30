import asyncio, sys
sys.path.insert(0, "/app/backend")
from db import db
CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"

async def main():
    for coll,id_ in [("phases","TEST_JAN79_phase"),("tasks","TEST_JAN79_task"),("time_entries","TEST_JAN79_te")]:
        r = await db[coll].delete_one({"id": id_}); print(coll, r.deleted_count)
    # remove the placeholder project only if it was our TEST_ one
    await db.projects.delete_many({"company_id": CID, "name": "TEST_JAN79 Project"})
asyncio.run(main())
