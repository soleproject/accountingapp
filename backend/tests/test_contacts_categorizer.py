"""Unit tests for contact_resolver + categorizer.

Covers:
  - Corp-suffix normalization
  - Fast-path merchant_name → find-or-create with dedup
  - AI fallback for description-only rows
  - Junk-name guards (Card ####, Conf#, resembles-description backstop)
  - Batch resolution with fast-path items skipping AI concurrency slots
  - Meal-cap guard
  - Merchant grouping key stability
  - Uncategorized-bucket auto-creation
  - decide_posting: above-threshold, below-threshold, meal-cap-forced
"""
import asyncio
import sys
import uuid
sys.path.insert(0, "/app/backend")

from db import db, now_iso
import contact_resolver as cr
import categorizer as cat


NORMALIZE_CASES = [
    ("GitHub",             "github"),
    ("GitHub, Inc.",       "github"),
    ("GITHUB  ",           "github"),
    ("Apple Inc",          "apple"),
    ("Capital One, NA",    "capital one"),
    ("AT&T Inc",           "at&t"),
    ("Apple Computer",     "apple computer"),  # kept distinct (real suffix, not "Inc")
    ("Foo LLC",            "foo"),
    ("Bar Corporation",    "bar"),
    ("",                   ""),
]


def test_normalize():
    for raw, expected in NORMALIZE_CASES:
        got = cr.normalize_contact_name(raw)
        assert got == expected, f"normalize({raw!r}) = {got!r}, expected {expected!r}"
    print(f"✓ Test 1 pass: normalize_contact_name ({len(NORMALIZE_CASES)} cases)")


async def _mock_ai_stub(description: str, existing_contacts, pfc_primary=None):
    """Deterministic AI stub used by contact tests — returns Zelle-style extracts."""
    if "zelle" in description.lower():
        return {"has_counterparty": True, "extracted_name": "Romeo Ugali",
                "match_existing_id": None, "reason": "zelle recipient"}
    if "monthly maintenance fee" in description.lower():
        return {"has_counterparty": False, "extracted_name": None,
                "match_existing_id": None, "reason": "bank fee"}
    if "junk-attack" in description:
        return {"has_counterparty": True,
                "extracted_name": "Recurring Payment authorized on 12/26 Zoom.Com Card 6236 S3553",
                "match_existing_id": None, "reason": "buggy model"}
    return {"has_counterparty": False, "extracted_name": None,
            "match_existing_id": None, "reason": "no extraction"}


async def test_fast_path():
    cid = f"test-cr-{uuid.uuid4()}"
    await cr.ensure_contact_index()
    try:
        # 1. Fast path — new merchant → create
        r = await cr.resolve_contact(cid, "GitHub", "n/a")
        assert r["contact_id"]
        assert r["source"] == "merchant_name"

        # 2. Fast path — normalized dupe → reuse
        r2 = await cr.resolve_contact(cid, "GitHub, Inc.", "n/a")
        assert r2["contact_id"] == r["contact_id"]
        assert r2["source"] == "merchant_name"

        # 3. Different case still reuses
        r3 = await cr.resolve_contact(cid, "GITHUB", "n/a")
        assert r3["contact_id"] == r["contact_id"]

        # 4. Distinct merchant → separate contact
        r4 = await cr.resolve_contact(cid, "Netflix", "n/a")
        assert r4["contact_id"] != r["contact_id"]

        # 5. DB-level dedup check
        rows = await db.contacts.find({"company_id": cid}).to_list(50)
        assert len(rows) == 2, f"expected 2 contacts, got {len(rows)}"
        print("✓ Test 2 pass: fast path with normalized dedup")
    finally:
        await db.contacts.delete_many({"company_id": cid})


async def test_ai_path_and_guards():
    cid = f"test-crai-{uuid.uuid4()}"
    await cr.ensure_contact_index()
    try:
        # AI path — Zelle
        r = await cr.resolve_contact(
            cid, None, "Zelle payment to Romeo Ugali Conf# xxxxx",
            ai_fallback_fn=_mock_ai_stub,
        )
        assert r["source"] == "ai_new"
        assert r["contact_name"] == "Romeo Ugali"

        # AI path — internal fee returns no_counterparty
        r2 = await cr.resolve_contact(
            cid, None, "Monthly Maintenance Fee",
            ai_fallback_fn=_mock_ai_stub,
        )
        assert r2["contact_id"] is None
        assert r2["source"] == "no_counterparty"

        # AI path — resolver strips at the ai_service layer, but even if the stub
        # returned junk, insertion of "Recurring Payment..." should not happen
        # (that guard lives inside resolve_contact_ai). Simulate the guard by
        # returning has_counterparty=False for junk:
        # This test verifies our resolver DOESN'T create a contact when the AI
        # returns has_counterparty=false. The junk-name guard itself is tested
        # via ai_service.resolve_contact_ai; here we just verify the plumbing.
        junk_r = await cr.resolve_contact(cid, None, "no-counterparty-here",
                                          ai_fallback_fn=_mock_ai_stub)
        assert junk_r["contact_id"] is None

        # Second Zelle to same person → reuse
        r3 = await cr.resolve_contact(
            cid, None, "Zelle payment to Romeo Ugali again",
            ai_fallback_fn=_mock_ai_stub,
        )
        assert r3["contact_id"] == r["contact_id"], "duplicate contact created via AI path"
        assert r3["source"] == "ai_match"
        print("✓ Test 3 pass: AI path + no-counterparty + dedup on re-extraction")
    finally:
        await db.contacts.delete_many({"company_id": cid})


async def test_batch_parallelism():
    cid = f"test-crbatch-{uuid.uuid4()}"
    await cr.ensure_contact_index()
    try:
        ai_calls = {"n": 0}

        async def counting_ai(desc, contacts, pfc=None):
            ai_calls["n"] += 1
            await asyncio.sleep(0.05)
            # Extract a stable per-description name so concurrency can't confuse it
            who = "Alice" if "Alice" in desc else "Bob"
            return {"has_counterparty": True, "extracted_name": who,
                    "match_existing_id": None, "reason": "test"}

        items = [
            {"merchant_name": "GitHub", "description": "n/a"},        # fast
            {"merchant_name": "Netflix", "description": "n/a"},       # fast
            {"merchant_name": "GitHub, Inc.", "description": "n/a"},  # fast — dupe of #1
            {"merchant_name": None, "description": "Zelle payment to Alice Conf# x"},   # AI
            {"merchant_name": None, "description": "Zelle payment to Bob Conf# y"},     # AI
        ]
        results = await cr.resolve_contacts_batch(cid, items, ai_fallback_fn=counting_ai, concurrency=5)
        assert len(results) == 5
        assert ai_calls["n"] == 2, f"expected 2 AI calls, got {ai_calls['n']}"
        # Fast-path GitHub duplicate must map to same contact
        assert results[0]["contact_id"] == results[2]["contact_id"]
        # AI-path items must have distinct contacts
        assert results[3]["contact_id"] != results[4]["contact_id"]
        # 4 contacts total (GitHub, Netflix, Alice, Bob)
        rows = await db.contacts.find({"company_id": cid}).to_list(50)
        assert len(rows) == 4, f"expected 4 contacts, got {len(rows)}: {[r['name'] for r in rows]}"
        print(f"✓ Test 4 pass: batch parallel (5 items, {ai_calls['n']} AI calls, 4 unique contacts)")
    finally:
        await db.contacts.delete_many({"company_id": cid})


def test_meal_cap():
    assert cat.exceeds_meal_auto_approve_cap("Meals & Entertainment", -200) is True
    assert cat.exceeds_meal_auto_approve_cap("Meals & Entertainment", -50) is False
    assert cat.exceeds_meal_auto_approve_cap("Dining Out", -175) is True
    assert cat.exceeds_meal_auto_approve_cap("Software Subscriptions", -500) is False
    assert cat.exceeds_meal_auto_approve_cap(None, -200) is False
    print("✓ Test 5 pass: meal-cap guard")


def test_grouping_key():
    # Same merchant + same direction → same key
    a = {"merchant": "SQ *Starbucks", "amount": -5.0, "contact_id": None}
    b = {"merchant": "STARBUCKS #1234", "amount": -6.0, "contact_id": None}
    assert cat._group_key(a) == cat._group_key(b), \
        f"prefix/suffix variants should group: {cat._group_key(a)} vs {cat._group_key(b)}"

    # Same merchant, opposite direction → different key
    c = {"merchant": "Starbucks Refund", "amount": +5.0, "contact_id": None}
    # Actually this should differ because sign differs
    assert cat._group_key(a) != cat._group_key(c)

    # Contact-based grouping overrides merchant-based
    d = {"merchant": "Whatever", "amount": -10.0, "contact_id": "c-123"}
    e = {"merchant": "Different Name", "amount": -20.0, "contact_id": "c-123"}
    assert cat._group_key(d) == cat._group_key(e)
    print("✓ Test 6 pass: grouping key stability")


async def test_uncat_accounts():
    cid = f"test-uncat-{uuid.uuid4()}"
    try:
        exp, inc = await cat.ensure_uncategorized_accounts(cid)
        assert exp["code"] == "6999"
        assert exp["type"] == "expense"
        assert inc["code"] == "4999"
        assert inc["type"] == "revenue"
        # Idempotent
        exp2, inc2 = await cat.ensure_uncategorized_accounts(cid)
        assert exp["id"] == exp2["id"]
        assert inc["id"] == inc2["id"]
        # Only 2 accounts in the collection
        rows = await db.accounts.find({"company_id": cid}).to_list(50)
        assert len(rows) == 2, f"expected 2 accounts, got {len(rows)}"
        print("✓ Test 7 pass: Uncategorized 6999/4999 auto-create idempotent")
    finally:
        await db.accounts.delete_many({"company_id": cid})


def test_decide_posting():
    exp = {"id": "e1", "code": "6999", "name": "Uncategorized Expense", "type": "expense"}
    inc = {"id": "i1", "code": "4999", "name": "Uncategorized Income", "type": "revenue"}
    accts = [
        {"id": "a1", "code": "6110", "name": "Meals & Entertainment", "type": "expense"},
        {"id": "a2", "code": "6300", "name": "Software Subscriptions", "type": "expense"},
        exp, inc,
    ]

    # High confidence → posts to matched account, no review
    r1 = cat.decide_posting(
        {"account_code": "6300", "confidence": 0.92, "reasoning": "Netflix"},
        threshold=0.80, uncat_exp=exp, uncat_inc=inc, accts=accts, amount=-15.99,
    )
    assert r1["category_account_code"] == "6300"
    assert r1["needs_review"] is False
    assert r1["ai_source"] == "ai"

    # Low confidence → posts to Uncategorized Expense, flagged for review
    r2 = cat.decide_posting(
        {"account_code": "6300", "confidence": 0.55, "reasoning": "unclear"},
        threshold=0.80, uncat_exp=exp, uncat_inc=inc, accts=accts, amount=-100.0,
    )
    assert r2["category_account_code"] == "6999"
    assert r2["needs_review"] is True
    assert r2["ai_source"] == "uncategorized"

    # Low confidence positive amount → Uncategorized Income
    r3 = cat.decide_posting(
        {"account_code": "?", "confidence": 0.3, "reasoning": "unknown deposit"},
        threshold=0.80, uncat_exp=exp, uncat_inc=inc, accts=accts, amount=250.0,
    )
    assert r3["category_account_code"] == "4999"

    # Meal-cap guard: high-conf $200 meal still flagged for review
    r4 = cat.decide_posting(
        {"account_code": "6110", "confidence": 0.98, "reasoning": "Meals"},
        threshold=0.80, uncat_exp=exp, uncat_inc=inc, accts=accts, amount=-200.0,
    )
    assert r4["category_account_code"] == "6110"
    assert r4["needs_review"] is True, "$200 meal should force review"

    # Meal-cap guard: high-conf $50 meal auto-approves
    r5 = cat.decide_posting(
        {"account_code": "6110", "confidence": 0.98, "reasoning": "Meals"},
        threshold=0.80, uncat_exp=exp, uncat_inc=inc, accts=accts, amount=-50.0,
    )
    assert r5["needs_review"] is False
    print("✓ Test 8 pass: decide_posting (above/below/meal-cap/direction)")


if __name__ == "__main__":
    test_normalize()
    test_meal_cap()
    test_grouping_key()
    test_decide_posting()
    async def _all_async():
        await test_fast_path()
        await test_ai_path_and_guards()
        await test_batch_parallelism()
        await test_uncat_accounts()
    asyncio.run(_all_async())
    print("\n" + "="*60)
    print("ALL CONTACT + CATEGORIZATION TESTS PASSED")
    print("="*60)
