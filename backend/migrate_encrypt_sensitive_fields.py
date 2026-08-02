"""One-shot migration: walk every collection listed in
`crypto_service.SENSITIVE_FIELDS` and encrypt any plaintext values that
still sit in the DB from before field-level encryption landed.

Idempotent — values that are already `enc_v1:*` are skipped, so re-runs
are free.

Usage (from inside the pod / any host with backend/.env loaded):
    python -m backend.migrate_encrypt_sensitive_fields
or:
    cd backend && python migrate_encrypt_sensitive_fields.py
"""
from __future__ import annotations
import asyncio
import sys


async def main() -> int:
    from dotenv import load_dotenv
    load_dotenv()

    from db import db, now_iso
    from crypto_service import (
        SENSITIVE_FIELDS, encrypt, is_encrypted, encryption_available,
    )
    if not encryption_available():
        print("❌ FIELD_ENCRYPTION_KEY missing or invalid — refusing to run.",
              file=sys.stderr)
        return 2

    totals: dict[str, dict[str, int]] = {}
    for coll, fields in SENSITIVE_FIELDS.items():
        stats = {"seen": 0, "encrypted": 0, "already": 0, "empty": 0}
        async for doc in db[coll].find():
            stats["seen"] += 1
            updates: dict[str, str] = {}
            for f in fields:
                v = doc.get(f)
                if v in (None, ""):
                    stats["empty"] += 1
                    continue
                if is_encrypted(v):
                    stats["already"] += 1
                    continue
                updates[f] = encrypt(v)
            if updates:
                await db[coll].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {**updates, "updated_at": now_iso()}},
                )
                stats["encrypted"] += 1
        totals[coll] = stats
    print("\nEncryption backfill complete:")
    print(f"{'Collection':<20}{'seen':>10}{'encrypted':>12}{'already':>10}{'empty-cells':>14}")
    for c, s in totals.items():
        print(f"{c:<20}{s['seen']:>10}{s['encrypted']:>12}{s['already']:>10}{s['empty']:>14}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
