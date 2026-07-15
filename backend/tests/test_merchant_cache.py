"""Unit + integration tests for merchant_cache.py."""
import asyncio
import sys
import uuid
sys.path.insert(0, "/app/backend")

from db import db
import merchant_cache as mc


# Golden set: (raw_merchant, expected_normalized)
NORMALIZATION_CASES = [
    # Prefix stripping
    ("SQ *Blue Bottle Coffee",             "blue bottle coffee"),
    ("SQ*Blue Bottle Coffee",              "blue bottle coffee"),
    ("BLUE BOTTLE COFFEE",                 "blue bottle coffee"),
    ("TST* Chipotle",                      "chipotle"),
    ("TST*Chipotle",                       "chipotle"),
    ("PAYPAL *DIGITALOCEAN",               "digitalocean"),
    ("PP*DIGITALOCEAN",                    "digitalocean"),
    ("CHECKCARD ATT PAYMENT 1234567",      "att payment"),

    # Trailing junk stripping — the key requirement is that variants of the
    # same merchant collapse to the SAME key. Exact string doesn't matter.
    ("Uber Trip 7/12",                     "uber trip"),
    ("UBER   TRIP",                        "uber trip"),
    ("HOME DEPOT #6742",                   "home depot"),
    ("AMZN Mktp US*A12B3CD",               "amzn mktp"),
    ("AMZN Mktp US",                       "amzn mktp"),
    ("Home Depot Portland OR",             "home depot portland"),  # city preserved when no # or state-only
    ("Netflix Inc",                        "netflix"),
    ("Netflix.com",                        "netflix"),
    ("STARBUCKS #1234",                    "starbucks"),
    ("",                                   ""),
]


def test_normalization():
    for raw, expected in NORMALIZATION_CASES:
        got = mc.normalize_merchant(raw)
        assert got == expected, f"normalize({raw!r}) = {got!r}, expected {expected!r}"
    print(f"✓ Test 1 pass: normalization ({len(NORMALIZATION_CASES)} cases)")


async def test_cache_crud():
    cid = f"test-mc-{uuid.uuid4()}"
    try:
        # Miss
        assert await mc.lookup(cid, "Blue Bottle") is None
        # Upsert LLM
        await mc.upsert(cid, "SQ *Blue Bottle Coffee", "6110", "Meals & Entertainment", 0.87, "llm")
        # Hit (any variant normalizes the same)
        hit = await mc.lookup(cid, "Blue Bottle Coffee")
        assert hit is not None
        assert hit["account_code"] == "6110"
        assert hit["cache_hit"] is True
        assert hit["cache_source"] == "llm"

        # LLM must NOT overwrite user-approved entries
        await mc.upsert(cid, "Uber Trip 7/12", "6120", "Travel", 0.90, "llm")
        await mc.upsert(cid, "Uber Trip 8/10", "6120", "Travel", 0.92, "user")
        # LLM tries to change it — should be ignored
        await mc.upsert(cid, "Uber Trip", "9999", "Ask My Accountant", 0.60, "llm")
        hit = await mc.lookup(cid, "Uber Trip 9/1")
        assert hit["account_code"] == "6120", f"user override was overwritten: {hit}"
        assert hit["cache_source"] == "user"
        print("✓ Test 2 pass: cache lookup + user overrides authoritative")

        # Duplicate upsert should update, not insert
        await mc.upsert(cid, "Netflix", "6300", "Software Subscriptions", 0.99, "user")
        await mc.upsert(cid, "Netflix.com", "6300", "Software Subscriptions", 0.99, "user")
        docs = await db.merchant_cache.find({"company_id": cid, "merchant_normalized": "netflix"}).to_list(10)
        assert len(docs) == 1, f"expected 1 netflix row, got {len(docs)}"
        print("✓ Test 3 pass: no duplicate entries per (company, merchant_normalized)")

        # Batch categorization: mix of hits and misses
        llm_calls = {"count": 0}
        async def fake_llm(merchant, amount, desc, coa):
            llm_calls["count"] += 1
            await asyncio.sleep(0.01)  # simulate network latency
            return {"account_code": "9999", "confidence": 0.70,
                    "reasoning": "fallback", "needs_review": True}

        items = [
            {"merchant": "SQ *Blue Bottle Coffee", "amount": -5.50, "description": "coffee"},   # hit (from earlier)
            {"merchant": "Netflix.com",            "amount": -15.99, "description": "netflix"}, # hit
            {"merchant": "Uber Trip",              "amount": -22.30, "description": "uber"},    # hit
            {"merchant": "Brand New Merchant XYZ", "amount": -100.0, "description": "?"},        # miss
            {"merchant": "Brand New Merchant XYZ", "amount": -50.0,  "description": "?"},        # miss ... but 2nd call to same normalized key
        ]
        coa = [{"code": "9999", "name": "Ask My Accountant", "type": "expense"}]
        results = await mc.categorize_batch(cid, items, coa, fake_llm, concurrency=5)
        assert len(results) == 5
        # 3 cache hits (Blue Bottle, Netflix, Uber) + 1 real LLM call (Brand New Merchant — 2nd occurrence in the batch would race, expected ≤ 2 llm calls)
        assert llm_calls["count"] <= 2, f"expected ≤2 LLM calls, got {llm_calls['count']}"
        cache_hits = sum(1 for r in results if r.get("cache_hit"))
        assert cache_hits >= 3, f"expected ≥3 cache hits, got {cache_hits}"
        print(f"✓ Test 4 pass: batch categorize (5 items, {llm_calls['count']} LLM calls, {cache_hits} cache hits)")

        # Parallelism sanity: 20 misses should complete in ~2 batches with concurrency=10
        llm_calls["count"] = 0
        async def slow_llm(m, a, d, coa):
            llm_calls["count"] += 1
            await asyncio.sleep(0.1)
            return {"account_code": "9999", "confidence": 0.7, "reasoning": ""}
        misses = [{"merchant": f"Uniq-{uuid.uuid4()}", "amount": -1, "description": "x"} for _ in range(20)]
        import time
        t0 = time.perf_counter()
        rs = await mc.categorize_batch(cid, misses, coa, slow_llm, concurrency=10)
        elapsed = time.perf_counter() - t0
        assert len(rs) == 20
        assert llm_calls["count"] == 20
        # Serial would take 2.0s; concurrency=10 should complete in ~0.2s + overhead
        assert elapsed < 0.6, f"expected <0.6s with concurrency=10, took {elapsed:.2f}s"
        print(f"✓ Test 5 pass: 20 misses at concurrency=10 completed in {elapsed:.2f}s (vs 2.0s serial)")

    finally:
        await db.merchant_cache.delete_many({"company_id": cid})


if __name__ == "__main__":
    test_normalization()
    asyncio.run(test_cache_crud())
    print("\n" + "="*60)
    print("ALL MERCHANT CACHE TESTS PASSED")
    print("="*60)
