"""Who gets a company's client-facing email (Check-ins, Clean Up digests)?

Order: explicit `client_email` → stored `owner_email` → the user behind
`owner_user_id` / legacy `owner_id` → the `memberships` owner row.
"""
from db import db


async def resolve_owner_email(company: dict | None) -> str | None:
    if not company:
        return None
    email = company.get("client_email") or company.get("owner_email")
    if email:
        return email
    uid = company.get("owner_user_id") or company.get("owner_id")
    if not uid and company.get("id"):
        m = await db.memberships.find_one({"company_id": company["id"], "role": "owner"}, {"user_id": 1})
        uid = (m or {}).get("user_id")
    if uid:
        u = await db.users.find_one({"id": uid}, {"email": 1})
        if u and u.get("email"):
            return u["email"]
    return None


async def owner_email_for(company_id: str) -> str | None:
    c = await db.companies.find_one({"id": company_id}, {"_id": 0, "id": 1, "client_email": 1, "owner_email": 1, "owner_user_id": 1, "owner_id": 1})
    return await resolve_owner_email(c)


async def backfill_owner_email(company_id: str | None = None) -> int:
    """Stamp `owner_email` on companies missing it. Returns rows updated."""
    q = {"$or": [{"owner_email": {"$exists": False}}, {"owner_email": {"$in": [None, ""]}}]}
    if company_id:
        q["id"] = company_id
    n = 0
    async for c in db.companies.find(q, {"_id": 0, "id": 1, "client_email": 1, "owner_email": 1, "owner_user_id": 1, "owner_id": 1}):
        email = await resolve_owner_email(c)
        if email:
            await db.companies.update_one({"id": c["id"]}, {"$set": {"owner_email": email}})
            n += 1
    return n
