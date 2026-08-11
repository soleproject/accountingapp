"""Idempotent demo-user seeder — safe to run on production.

Unlike `seed.py` (which calls `wipe()` first and destroys the DB), this
script ONLY creates the three demo accounts if they don't exist and
ONLY resets their passwords if they do. It never touches companies,
transactions, or any other collection.

Usage:
    cd /app/backend && python3 scripts/seed_demo_users.py

Safe to re-run any time — a working demo login is required by the
public marketing site, so this is what production should run
post-deploy to keep the demo buttons green.
"""
import asyncio
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db
from auth import hash_password


DEMO_USERS = [
    {
        "email":    "admin@axiom.ai",
        "name":     "Alex Admin",
        "password": "admin123",
        "role":     "superadmin",
    },
    {
        "email":     "pro@axiom.ai",
        "name":      "Priya Patel, CPA",
        "password":  "pro123",
        "role":      "pro",
        "firm_name": "Northgate Advisory",
    },
    {
        "email":    "client@axiom.ai",
        "name":     "Michael Chen",
        "password": "client123",
        "role":     "client",
    },
]


async def main() -> None:
    now = datetime.now(timezone.utc).isoformat()
    created = 0
    updated = 0

    for spec in DEMO_USERS:
        email = spec["email"].lower()
        existing = await db.users.find_one({"email": email})
        if existing:
            # Reset the password to the canonical demo password so the
            # sign-in buttons keep working even if some earlier ops
            # rotated the hash. Never touch the id — anything else in
            # the DB (companies, memberships) references it.
            await db.users.update_one(
                {"email": email},
                {"$set": {
                    "password":   hash_password(spec["password"]),
                    "role":       spec["role"],
                    "updated_at": now,
                }},
            )
            updated += 1
            print(f"  ↻ reset password + role for {email}")
        else:
            doc = {
                "id":         str(uuid.uuid4()),
                "email":      email,
                "name":       spec["name"],
                "password":   hash_password(spec["password"]),
                "role":       spec["role"],
                "created_at": now,
                "updated_at": now,
            }
            if "firm_name" in spec:
                doc["firm_name"] = spec["firm_name"]
            await db.users.insert_one(doc)
            created += 1
            print(f"  + created {email} ({spec['role']})")

    print(f"\nDone. created={created} updated={updated}")


if __name__ == "__main__":
    asyncio.run(main())
