"""Pre-flight impact report before flipping ENTITLEMENTS_ENFORCE=true."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from db import db  # noqa: E402
from entitlements import PLAN_RANK, PLAN_QUOTAS, quota_usage  # noqa: E402


async def main():
    print("SHADOW (non-preview) events:", await db.entitlement_events.count_documents({"enforced": False}))
    async for g in db.entitlement_events.aggregate([{"$match": {"enforced": False}}, {"$group": {"_id": {"c": "$company_id", "f": "$feature"}, "n": {"$sum": 1}}}]):
        c = await db.companies.find_one({"id": g["_id"]["c"]}, {"name": 1})
        print("  ", c and c.get("name"), g["_id"]["f"], g["n"])
    print("\nCompanies with a paid plan on file (would be gated):")
    async for c in db.companies.find({"billing_product": {"$in": list(PLAN_RANK)}}, {"id": 1, "name": 1, "billing_product": 1, "billing_payer": 1, "sub_status": 1}):
        u = await quota_usage(c["id"])
        q = PLAN_QUOTAS.get(c["billing_product"], {})
        over = [k for k in ("users", "connected_accounts") if q.get(k) is not None and u[k] > q[k]]
        print(f"  {c.get('name')!r:40} plan={c['billing_product']:13} payer={c.get('billing_payer')} sub={c.get('sub_status')} usage={u} {'OVER:' + ','.join(over) if over else ''}")
    print("\nTotal companies:", await db.companies.count_documents({}), "| no plan on file (all-access):", await db.companies.count_documents({"billing_product": {"$nin": list(PLAN_RANK)}}))


asyncio.run(main())
