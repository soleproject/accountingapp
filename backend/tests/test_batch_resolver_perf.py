"""Batch resolver perf + correctness — verifies the Feb 2026 rewrite that
moves fast-path lookups off Mongo and bulk-writes new contacts + cache
upserts.

Focus:
  - Fast-path rows never hit Mongo per-row (single snapshot load).
  - New contacts are inserted once via `insert_many`, not per-row.
  - Cache lookups are batched via `$in`, cache writes via `bulk_write`.
  - Same-batch same-normalized-name rows collapse to one insert.
  - AI-path cache HITs skip the LLM entirely.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from unittest.mock import patch

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

import contact_resolver  # noqa: E402
from db import db  # noqa: E402


def _fresh_cid() -> str:
    return f"test-perf-{uuid.uuid4()}"


async def _cleanup(cid: str) -> None:
    await db.contacts.delete_many({"company_id": cid})
    await db.contact_learning_cache.delete_many({"company_id": cid})


# ---------- 1. Fast-path bulk insert dedupes ----------

async def _run_fast_path_bulk_insert_dedupes():
    cid = _fresh_cid()
    items = []
    merchants = ["Starbucks", "Walmart", "AT&T", "Amazon", "Costco"]
    for m in merchants:
        for _ in range(4):
            items.append({"merchant_name": m, "description": m})

    async def _ai_stub(*args, **kwargs):
        raise AssertionError("AI must NOT be called on fast-path rows")

    try:
        results = await contact_resolver.resolve_contacts_batch(
            cid, items, ai_fallback_fn=_ai_stub, concurrency=8,
        )
        assert len(results) == 20
        for r in results:
            assert r["source"] == "merchant_name"
            assert r["contact_id"] is not None
        contacts = await db.contacts.find({"company_id": cid}).to_list(None)
        assert len(contacts) == 5, f"expected 5, got {len(contacts)}"
    finally:
        await _cleanup(cid)


def test_fast_path_bulk_insert_dedupes():
    asyncio.run(_run_fast_path_bulk_insert_dedupes())


# ---------- 2. Fast-path reuses existing contact ----------

async def _run_fast_path_reuses_existing():
    cid = _fresh_cid()
    seed = contact_resolver._new_contact_doc(cid, "Netflix", source="merchant_name")
    await db.contacts.insert_one(seed)

    items = [{"merchant_name": "Netflix, Inc.", "description": "Netflix"}] * 3

    async def _ai_stub(*args, **kwargs):
        raise AssertionError("AI must NOT be called on fast-path rows")

    try:
        results = await contact_resolver.resolve_contacts_batch(
            cid, items, ai_fallback_fn=_ai_stub,
        )
        for r in results:
            assert r["contact_id"] == seed["id"]
            assert r["source"] == "merchant_name"
        assert await db.contacts.count_documents({"company_id": cid}) == 1
    finally:
        await _cleanup(cid)


def test_fast_path_reuses_existing_contact():
    asyncio.run(_run_fast_path_reuses_existing())


# ---------- 3. AI cache hit skips LLM ----------

async def _run_ai_uses_learning_cache():
    cid = _fresh_cid()
    call_count = {"n": 0}

    async def _ai_stub(desc, ctx, pfc):
        call_count["n"] += 1
        return {"has_counterparty": True, "extracted_name": "Citi Card",
                "match_existing_id": None, "reason": "extracted"}

    items = [
        {"merchant_name": "", "description": "CITI CARD ONLINE DES:PAYMENT ID:11111"},
        {"merchant_name": "", "description": "CITI CARD ONLINE DES:PAYMENT ID:22222"},
    ]

    try:
        r1 = await contact_resolver.resolve_contacts_batch(
            cid, items[:1], ai_fallback_fn=_ai_stub,
        )
        assert r1[0]["source"] == "ai_new"
        assert call_count["n"] == 1
        r2 = await contact_resolver.resolve_contacts_batch(
            cid, items[1:], ai_fallback_fn=_ai_stub,
        )
        assert r2[0]["contact_id"] == r1[0]["contact_id"]
        assert r2[0]["source"] == "cache"
        assert call_count["n"] == 1, "AI must not be called on cache hit"
    finally:
        await _cleanup(cid)


def test_ai_path_uses_learning_cache():
    asyncio.run(_run_ai_uses_learning_cache())


# ---------- 4. Negative result cached ----------

async def _run_no_counterparty_cached():
    cid = _fresh_cid()
    call_count = {"n": 0}

    async def _ai_stub(desc, ctx, pfc):
        call_count["n"] += 1
        return {"has_counterparty": False, "extracted_name": None,
                "match_existing_id": None, "reason": "bank fee"}

    items = [{"merchant_name": "", "description": "Monthly Maintenance Fee"}]

    try:
        for _ in range(3):
            await contact_resolver.resolve_contacts_batch(cid, items, ai_fallback_fn=_ai_stub)
        assert call_count["n"] == 1, "Negative result must be cached"
    finally:
        await _cleanup(cid)


def test_ai_path_no_counterparty_cached():
    asyncio.run(_run_no_counterparty_cached())


# ---------- 5. Bounded Mongo round-trips on 500 rows ----------

async def _run_bounded_round_trips():
    cid = _fresh_cid()
    items = [{"merchant_name": f"Merchant {i}", "description": f"Merchant {i}"}
             for i in range(500)]

    async def _ai_stub(*args, **kwargs):
        raise AssertionError("no AI expected")

    counters = {"find": 0, "find_one": 0}
    orig_find = db.contacts.find
    orig_find_one = db.contacts.find_one

    def counting_find(*a, **k):
        counters["find"] += 1
        return orig_find(*a, **k)

    async def counting_find_one(*a, **k):
        counters["find_one"] += 1
        return await orig_find_one(*a, **k)

    try:
        with patch.object(db.contacts, "find", side_effect=counting_find), \
             patch.object(db.contacts, "find_one", side_effect=counting_find_one):
            await contact_resolver.resolve_contacts_batch(cid, items, ai_fallback_fn=_ai_stub)

        assert counters["find_one"] == 0, f"per-row find_one leaked: {counters['find_one']}"
        assert counters["find"] <= 2, f"too many find() calls: {counters['find']}"
        assert await db.contacts.count_documents({"company_id": cid}) == 500
    finally:
        await _cleanup(cid)


def test_mongo_round_trips_are_bounded():
    asyncio.run(_run_bounded_round_trips())


# ---------- 6. No gaps in result rows ----------

async def _run_no_gaps():
    cid = _fresh_cid()
    items = [{"merchant_name": f"Vendor {i}", "description": f"Vendor {i}"}
             for i in range(20)]

    async def _ai_stub(*a, **k):
        raise AssertionError("no AI expected")

    try:
        results = await contact_resolver.resolve_contacts_batch(cid, items, ai_fallback_fn=_ai_stub)
        for i, r in enumerate(results):
            assert r["contact_id"] is not None, f"row {i}: {r}"
            assert r["source"] == "merchant_name"
    finally:
        await _cleanup(cid)


def test_all_rows_get_contact_id_no_gaps():
    asyncio.run(_run_no_gaps())


if __name__ == "__main__":
    async def _all():
        await _run_fast_path_bulk_insert_dedupes()
        await _run_fast_path_reuses_existing()
        await _run_ai_uses_learning_cache()
        await _run_no_counterparty_cached()
        await _run_bounded_round_trips()
        await _run_no_gaps()
    asyncio.run(_all())
    print("All 6 tests passed.")
