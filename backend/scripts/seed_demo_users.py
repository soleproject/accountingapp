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
    {
        # Demo Partner — the one-click "Partner" button on the login
        # page signs in as this user. Auto-provisions Partner Books
        # via the ensure_partner_books_company_for_partner helper so
        # the demo dashboard has data on first click.
        "email":        "partner@axiom.ai",
        "name":         "Jordan Reseller",
        "password":     "partner123",
        "role":         "partner",
        "firm_name":    "AxiomPartners",
        "subdomain":    "axiompartners",
        "primary_color": "#c026d3",
    },
]


async def main() -> None:
    now = datetime.now(timezone.utc).isoformat()
    created = 0
    updated = 0

    for spec in DEMO_USERS:
        email = spec["email"].lower()
        existing = await db.users.find_one({"email": email})
        # Common branding block — used for both pro (firm_name only)
        # and partner (firm_name + subdomain + brand color). Kept as
        # a nested dict so it lines up with the shape the rest of the
        # code expects on `user.branding.firm_name` etc.
        branding: dict = {}
        if "firm_name" in spec:
            branding["firm_name"] = spec["firm_name"]
        if "subdomain" in spec:
            branding["subdomain"] = spec["subdomain"]
        if "primary_color" in spec:
            branding["primary_color"] = spec["primary_color"]

        if existing:
            # Reset the password to the canonical demo password so the
            # sign-in buttons keep working even if some earlier ops
            # rotated the hash. Never touch the id — anything else in
            # the DB (companies, memberships) references it.
            update: dict = {
                "password":   hash_password(spec["password"]),
                "role":       spec["role"],
                "updated_at": now,
            }
            if branding:
                # Merge, don't replace — preserves any brand tweaks the
                # demo partner made through the UI between seed runs.
                merged = dict((existing.get("branding") or {}))
                merged.update(branding)
                update["branding"] = merged
            await db.users.update_one({"email": email}, {"$set": update})
            updated += 1
            user_id = existing["id"]
            print(f"  ↻ reset password + role for {email}")
        else:
            user_id = str(uuid.uuid4())
            doc = {
                "id":         user_id,
                "email":      email,
                "name":       spec["name"],
                "password":   hash_password(spec["password"]),
                "role":       spec["role"],
                "created_at": now,
                "updated_at": now,
            }
            # Legacy top-level `firm_name` kept for backward-compat
            # with older code paths that read it directly. New reads
            # should prefer `user.branding.firm_name`.
            if "firm_name" in spec:
                doc["firm_name"] = spec["firm_name"]
            if branding:
                doc["branding"] = branding
            await db.users.insert_one(doc)
            created += 1
            print(f"  + created {email} ({spec['role']})")

        # Partner-specific side effects: sidecar row + Partner Books.
        # Both are idempotent so calling on every seed run is safe.
        if spec["role"] == "partner":
            existing_sidecar = await db.partners.find_one({"id": user_id})
            if not existing_sidecar:
                await db.partners.insert_one({
                    "id": user_id,
                    "user_id": user_id,
                    "slug": spec.get("subdomain") or "partner",
                    "created_at": now,
                })
            try:
                from partners import ensure_partner_books_company_for_partner
                await ensure_partner_books_company_for_partner(user_id)
            except Exception as _exc:
                # Seed must never crash — worst case the partner logs
                # in and the /partner/me self-heal creates books on
                # first request.
                print(f"    ! partner books provisioning warning: {_exc}")

    print(f"\nDone. created={created} updated={updated}")


if __name__ == "__main__":
    asyncio.run(main())
