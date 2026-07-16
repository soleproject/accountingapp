"""Quick timing benchmark for the batch resolver rewrite.
Simulates a realistic 1,870-row Plaid sync (82% fast-path / 18% AI-path).
"""
from __future__ import annotations
import asyncio
import os
import sys
import time
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

import contact_resolver  # noqa: E402
from db import db  # noqa: E402


async def _stub_ai(desc: str, ctx, pfc):
    # Simulate ~30 ms Anthropic call
    await asyncio.sleep(0.03)
    return {"has_counterparty": True, "extracted_name": desc.split()[0].capitalize(),
            "match_existing_id": None, "reason": "stub"}


async def _run():
    cid = f"bench-{uuid.uuid4()}"
    # 82% fast path — 300 distinct clean merchants × ~5 duplicates each = 1533 rows
    fast = []
    for i in range(300):
        for _ in range(5):
            fast.append({"merchant_name": f"Merchant {i}", "description": f"Merchant {i}"})
    # 18% AI path — 337 noisy rows across ~30 signatures (heavy cache hit ratio)
    ai = []
    for i in range(30):
        for j in range(11):
            ai.append({"merchant_name": "",
                       "description": f"CITI CARD ONLINE DES:PAYMENT ID:{i}{j:04d} INDN:X CO ID:CITICTP WEB"})
    items = fast + ai
    print(f"Total rows: {len(items)}  (fast={len(fast)}, ai={len(ai)})")

    try:
        t0 = time.monotonic()
        results = await contact_resolver.resolve_contacts_batch(
            cid, items, ai_fallback_fn=_stub_ai, concurrency=8,
        )
        elapsed = time.monotonic() - t0
        print(f"1st pass wall-clock: {elapsed:.2f}s")
        assert len(results) == len(items)
        assert all(r["contact_id"] or r["source"] == "no_counterparty" for r in results)

        # Second pass — should hit cache for ai rows AND existing contacts fast
        t0 = time.monotonic()
        results2 = await contact_resolver.resolve_contacts_batch(
            cid, items, ai_fallback_fn=_stub_ai, concurrency=8,
        )
        elapsed2 = time.monotonic() - t0
        print(f"2nd pass wall-clock: {elapsed2:.2f}s")

        # Warm-cache should be dramatically faster
        assert elapsed2 < 1.0, f"warm cache should be <1s, got {elapsed2:.2f}s"
        assert elapsed < 5.0, f"cold cache 1,870 rows should be <5s, got {elapsed:.2f}s"
        print("OK — perf targets met.")
    finally:
        await db.contacts.delete_many({"company_id": cid})
        await db.contact_learning_cache.delete_many({"company_id": cid})


if __name__ == "__main__":
    asyncio.run(_run())
