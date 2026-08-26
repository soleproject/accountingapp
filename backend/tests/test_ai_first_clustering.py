"""Regression tests for AI-First cluster-based categorization (Feb 2026).

The AI-First categorizer groups transactions by (canonical_merchant,
amount_bucket, direction) and sends ONE representative per cluster to
Claude. High-confidence rep results are propagated to every sibling in
the cluster; low-confidence results push the whole cluster to
needs_review. This is what powers Puzzle/Ramp/Brex-style "98%
auto-categorized" at low LLM cost.

Covers:
    1. `_canonicalize_merchant` normalizes noise (store#, LLC suffix, etc.)
    2. `_canonicalize_merchant` returns "" for ACH / wire / check / no-signal rows
    3. `_amount_bucket` splits at the documented thresholds
    4. `_build_clusters` groups same-merchant same-bucket rows together
    5. `_build_clusters` gives every unclusterable row its own solo cluster
    6. `categorize_batch` propagates a high-confidence rep to cluster members
    7. `categorize_batch` fallback-flags cluster members when rep is low-conf
"""
from __future__ import annotations
from unittest.mock import AsyncMock, patch

import pytest

import ai_first_categorizer as afc


# ---- unit tests: pure helpers ---------------------------------------------


class TestCanonicalizeMerchant:
    def test_strips_store_numbers_and_suffixes(self):
        txn = {"merchant": "STARBUCKS #10345"}
        assert afc._canonicalize_merchant(txn) == "STARBUCKS"

    def test_strips_llc_inc_corp(self):
        assert afc._canonicalize_merchant({"merchant": "Blue Bottle Coffee LLC"}) == "BLUE BOTTLE COFFEE"
        assert afc._canonicalize_merchant({"merchant": "Acme Inc"}) == "ACME"

    def test_falls_back_to_description_when_no_merchant(self):
        txn = {"merchant": None, "description": "AMAZON MKTPL*ABC123"}
        assert afc._canonicalize_merchant(txn) == "AMAZON MKTPL ABC"

    def test_returns_empty_for_ach_wire_check(self):
        assert afc._canonicalize_merchant({"merchant": "ACH DEBIT PAYROLL"}) == ""
        assert afc._canonicalize_merchant({"merchant": "WIRE TRANSFER TO OPS"}) == ""
        assert afc._canonicalize_merchant({"merchant": "CHECK #1234"}) == ""
        assert afc._canonicalize_merchant({"merchant": "ATM WITHDRAWAL"}) == ""

    def test_returns_empty_for_missing_data(self):
        assert afc._canonicalize_merchant({"merchant": "", "description": ""}) == ""
        assert afc._canonicalize_merchant({}) == ""


class TestAmountBucket:
    def test_bucket_boundaries(self):
        assert afc._amount_bucket(0) == "s"
        assert afc._amount_bucket(49.99) == "s"
        assert afc._amount_bucket(50) == "m"
        assert afc._amount_bucket(499.99) == "m"
        assert afc._amount_bucket(500) == "l"
        assert afc._amount_bucket(4999.99) == "l"
        assert afc._amount_bucket(5000) == "xl"
        assert afc._amount_bucket(1_000_000) == "xl"

    def test_bucket_uses_absolute_value(self):
        # Expense of -$8 should bucket the same as an income of $8.
        assert afc._amount_bucket(-8) == "s"
        assert afc._amount_bucket(-750) == "l"


class TestBuildClusters:
    def test_50_starbucks_form_one_cluster(self):
        txns = [
            {"id": f"t{i}", "merchant": "STARBUCKS", "amount": -8 - (i % 5)}
            for i in range(50)
        ]
        clusters = afc._build_clusters(txns)
        assert len(clusters) == 1
        # Every txn is in that one cluster.
        only_members = next(iter(clusters.values()))
        assert len(only_members) == 50

    def test_costco_splits_by_amount_bucket(self):
        # Costco food court ($8, small bucket), bigger checkout run
        # ($120, medium bucket), and bulk supplies ($850, large bucket).
        # Three separate clusters even though same merchant.
        txns = [
            {"id": "t1", "merchant": "COSTCO", "amount": -8},
            {"id": "t2", "merchant": "COSTCO", "amount": -120},
            {"id": "t3", "merchant": "COSTCO", "amount": -850},
        ]
        clusters = afc._build_clusters(txns)
        assert len(clusters) == 3

    def test_direction_splits_income_vs_expense(self):
        # Same merchant, one refund (positive) + one purchase (negative).
        # Different account entirely.
        txns = [
            {"id": "t1", "merchant": "AMAZON", "amount": -30},
            {"id": "t2", "merchant": "AMAZON", "amount": 30},  # refund
        ]
        clusters = afc._build_clusters(txns)
        assert len(clusters) == 2

    def test_unclusterable_each_solo(self):
        # ACH, wire, and check with no merchant signal each get their
        # own cluster of one so every row still gets an LLM look.
        txns = [
            {"id": "t1", "merchant": "ACH DEBIT"},
            {"id": "t2", "merchant": "WIRE TRANSFER"},
            {"id": "t3", "merchant": "CHECK #4001"},
        ]
        clusters = afc._build_clusters(txns)
        assert len(clusters) == 3
        for members in clusters.values():
            assert len(members) == 1


# ---- integration test: end-to-end propagate -------------------------------


@pytest.mark.asyncio
async def test_categorize_batch_propagates_high_confidence(monkeypatch):
    """50 Starbucks → 1 LLM call, all 50 rows return `ai_first` for the
    rep + `ai_first_propagated` for the 49 siblings, all with the same
    category."""
    # Fake DB
    fake_company = {"id": "cid", "name": "Test Co", "industry_template": "generic"}
    fake_accts = [
        {"id": "acc-meals", "code": "6100", "name": "Meals & Entertainment",
         "type": "expense", "active": True},
    ]
    fake_contacts = []

    fake_db = type("_DB", (), {})()
    fake_db.companies = AsyncMock()
    fake_db.companies.find_one = AsyncMock(return_value=fake_company)

    class _FakeCursor:
        def __init__(self, data): self._data = data
        async def to_list(self, _): return self._data
        def sort(self, *_a, **_kw): return self
        def limit(self, *_a, **_kw): return self
        def __aiter__(self):
            async def gen():
                for x in self._data:
                    yield x
            return gen()

    fake_db.accounts = type("_A", (), {"find": lambda *a, **kw: _FakeCursor(fake_accts)})()
    fake_db.contacts = type("_C", (), {"find": lambda *a, **kw: _FakeCursor(fake_contacts)})()
    fake_db.transactions = type("_T", (), {"find": lambda *a, **kw: _FakeCursor([])})()

    monkeypatch.setattr(afc, "db", fake_db)

    # Fake LLM: whichever rep it gets, return account 6100 with high conf.
    llm_calls = []

    async def _fake_llm(system, user_prompt):
        llm_calls.append(user_prompt)
        # Extract the id= tokens from the prompt.
        import re
        ids = re.findall(r"id=(\S+)", user_prompt)
        return "[" + ",".join(
            f'{{"txn_id":"{i}","account_code":"6100","contact_id":null,'
            f'"contact_name_new":null,"confidence":0.9,"reasoning":"coffee shop"}}'
            for i in ids
        ) + "]"

    monkeypatch.setattr(afc, "_call_llm", _fake_llm)

    txns = [
        {"id": f"t{i}", "merchant": "STARBUCKS", "amount": -8 - (i % 3),
         "date": "2026-01-15", "description": f"STARBUCKS #{i}"}
        for i in range(50)
    ]
    results = await afc.categorize_batch("cid", txns)

    # 50 input → 50 output, keyed by txn_id
    assert len(results) == 50
    by_id = {r["txn_id"]: r for r in results}
    assert len(by_id) == 50

    # Every row went to 6100 Meals
    for r in results:
        assert r["category_account_code"] == "6100"
        assert r["confidence"] == 0.9

    # Only ONE llm call was made — the cluster collapsed 50 → 1 rep.
    assert len(llm_calls) == 1

    # Exactly one row is the rep (source=ai_first); the other 49 are
    # propagated.
    reps = [r for r in results if r["source"] == "ai_first"]
    propagated = [r for r in results if r["source"] == "ai_first_propagated"]
    assert len(reps) == 1
    assert len(propagated) == 49


@pytest.mark.asyncio
async def test_categorize_batch_low_confidence_falls_back_cluster(monkeypatch):
    """When the LLM returns VERY low confidence (< _MIN_CONFIDENCE=0.5)
    on the rep, the rep itself dumps to 6999 and every cluster member
    also lands in fallback. The whole cluster surfaces to the CPA."""
    fake_company = {"id": "cid", "name": "Test Co", "industry_template": "generic"}
    fake_accts = [
        {"id": "acc-x", "code": "6100", "name": "Meals",
         "type": "expense", "active": True},
    ]

    class _FakeCursor:
        def __init__(self, data): self._data = data
        async def to_list(self, _): return self._data
        def sort(self, *_a, **_kw): return self
        def limit(self, *_a, **_kw): return self
        def __aiter__(self):
            async def gen():
                for x in self._data:
                    yield x
            return gen()

    fake_db = type("_DB", (), {})()
    fake_db.companies = AsyncMock()
    fake_db.companies.find_one = AsyncMock(return_value=fake_company)
    fake_db.accounts = type("_A", (), {"find": lambda *a, **kw: _FakeCursor(fake_accts)})()
    fake_db.contacts = type("_C", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    fake_db.transactions = type("_T", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    monkeypatch.setattr(afc, "db", fake_db)

    async def _fake_llm(system, user_prompt):
        import re
        ids = re.findall(r"id=(\S+)", user_prompt)
        # Return VERY low confidence — below _MIN_CONFIDENCE (0.5).
        return "[" + ",".join(
            f'{{"txn_id":"{i}","account_code":"6100","contact_id":null,'
            f'"contact_name_new":null,"confidence":0.3,"reasoning":"guessing"}}'
            for i in ids
        ) + "]"

    monkeypatch.setattr(afc, "_call_llm", _fake_llm)

    txns = [
        {"id": f"t{i}", "merchant": "SKETCHY LLC", "amount": -25,
         "date": "2026-01-15", "description": f"SKETCHY LLC {i}"}
        for i in range(10)
    ]
    results = await afc.categorize_batch("cid", txns)

    # All 10 rows should land in fallback (rep dumped + 9 members
    # dumped) because the LLM's 0.3 confidence is below _MIN_CONFIDENCE.
    assert len(results) == 10
    fallbacks = [r for r in results if r["source"] == "ai_first_fallback"]
    assert len(fallbacks) == 10
    for r in fallbacks:
        assert r["needs_review"] is True
        assert r["category_account_code"] == "6999"


@pytest.mark.asyncio
async def test_categorize_batch_medium_confidence_applies_with_review(monkeypatch):
    """When the rep confidence is medium (0.50 <= conf < 0.75), the
    LLM's category IS applied — but every cluster member (rep included)
    is flagged needs_review=True so the CPA double-checks."""
    fake_company = {"id": "cid", "name": "Test Co", "industry_template": "generic"}
    fake_accts = [
        {"id": "acc-supplies", "code": "6800", "name": "Supplies & Materials",
         "type": "expense", "active": True},
    ]

    class _FakeCursor:
        def __init__(self, data): self._data = data
        async def to_list(self, _): return self._data
        def sort(self, *_a, **_kw): return self
        def limit(self, *_a, **_kw): return self
        def __aiter__(self):
            async def gen():
                for x in self._data:
                    yield x
            return gen()

    fake_db = type("_DB", (), {})()
    fake_db.companies = AsyncMock()
    fake_db.companies.find_one = AsyncMock(return_value=fake_company)
    fake_db.accounts = type("_A", (), {"find": lambda *a, **kw: _FakeCursor(fake_accts)})()
    fake_db.contacts = type("_C", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    fake_db.transactions = type("_T", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    monkeypatch.setattr(afc, "db", fake_db)

    async def _fake_llm(system, user_prompt):
        import re
        ids = re.findall(r"id=(\S+)", user_prompt)
        # Walmart-style medium confidence — could be Supplies, Meals, etc.
        return "[" + ",".join(
            f'{{"txn_id":"{i}","account_code":"6800","contact_id":null,'
            f'"contact_name_new":null,"confidence":0.6,"reasoning":"probably supplies"}}'
            for i in ids
        ) + "]"

    monkeypatch.setattr(afc, "_call_llm", _fake_llm)

    txns = [
        {"id": f"t{i}", "merchant": "WALMART", "amount": -55,
         "date": "2026-01-15", "description": f"WALMART {i}"}
        for i in range(10)
    ]
    results = await afc.categorize_batch("cid", txns)

    # Every row keeps the LLM's category (6800), NOT dumped to 6999,
    # AND every row is flagged needs_review=True.
    assert len(results) == 10
    for r in results:
        assert r["category_account_code"] == "6800"
        assert r["needs_review"] is True
        assert r["source"] in ("ai_first", "ai_first_propagated")


@pytest.mark.asyncio
async def test_categorize_batch_high_confidence_no_review(monkeypatch):
    """When conf >= 0.75, the LLM's category is applied AND
    needs_review=False (we trust the AI)."""
    fake_company = {"id": "cid", "name": "Test Co", "industry_template": "generic"}
    fake_accts = [
        {"id": "acc-meals", "code": "6000", "name": "Meals",
         "type": "expense", "active": True},
    ]

    class _FakeCursor:
        def __init__(self, data): self._data = data
        async def to_list(self, _): return self._data
        def sort(self, *_a, **_kw): return self
        def limit(self, *_a, **_kw): return self
        def __aiter__(self):
            async def gen():
                for x in self._data:
                    yield x
            return gen()

    fake_db = type("_DB", (), {})()
    fake_db.companies = AsyncMock()
    fake_db.companies.find_one = AsyncMock(return_value=fake_company)
    fake_db.accounts = type("_A", (), {"find": lambda *a, **kw: _FakeCursor(fake_accts)})()
    fake_db.contacts = type("_C", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    fake_db.transactions = type("_T", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    monkeypatch.setattr(afc, "db", fake_db)

    async def _fake_llm(system, user_prompt):
        import re
        ids = re.findall(r"id=(\S+)", user_prompt)
        return "[" + ",".join(
            f'{{"txn_id":"{i}","account_code":"6000","contact_id":null,'
            f'"contact_name_new":null,"confidence":0.9,"reasoning":"coffee"}}'
            for i in ids
        ) + "]"

    monkeypatch.setattr(afc, "_call_llm", _fake_llm)

    txns = [
        {"id": f"t{i}", "merchant": "STARBUCKS", "amount": -8,
         "date": "2026-01-15", "description": f"STARBUCKS {i}"}
        for i in range(10)
    ]
    results = await afc.categorize_batch("cid", txns)

    assert len(results) == 10
    for r in results:
        assert r["category_account_code"] == "6000"
        assert r["needs_review"] is False
        assert r["source"] in ("ai_first", "ai_first_propagated")


@pytest.mark.asyncio
async def test_categorize_batch_unclusterable_each_hit_llm(monkeypatch):
    """ACH, wires, checks each form solo clusters — every row hits the
    LLM individually (no propagation)."""
    fake_company = {"id": "cid", "name": "Test Co", "industry_template": "generic"}
    fake_accts = [
        {"id": "acc-x", "code": "6100", "name": "Meals",
         "type": "expense", "active": True},
    ]

    class _FakeCursor:
        def __init__(self, data): self._data = data
        async def to_list(self, _): return self._data
        def sort(self, *_a, **_kw): return self
        def limit(self, *_a, **_kw): return self
        def __aiter__(self):
            async def gen():
                for x in self._data:
                    yield x
            return gen()

    fake_db = type("_DB", (), {})()
    fake_db.companies = AsyncMock()
    fake_db.companies.find_one = AsyncMock(return_value=fake_company)
    fake_db.accounts = type("_A", (), {"find": lambda *a, **kw: _FakeCursor(fake_accts)})()
    fake_db.contacts = type("_C", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    fake_db.transactions = type("_T", (), {"find": lambda *a, **kw: _FakeCursor([])})()
    monkeypatch.setattr(afc, "db", fake_db)

    seen_ids = []

    async def _fake_llm(system, user_prompt):
        import re
        ids = re.findall(r"id=(\S+)", user_prompt)
        seen_ids.extend(ids)
        return "[" + ",".join(
            f'{{"txn_id":"{i}","account_code":"6100","contact_id":null,'
            f'"contact_name_new":null,"confidence":0.9,"reasoning":"ok"}}'
            for i in ids
        ) + "]"

    monkeypatch.setattr(afc, "_call_llm", _fake_llm)

    txns = [
        {"id": "t1", "merchant": "ACH DEBIT", "amount": -100, "date": "2026-01-15"},
        {"id": "t2", "merchant": "WIRE TRANSFER", "amount": -500, "date": "2026-01-16"},
        {"id": "t3", "merchant": "CHECK #4001", "amount": -75, "date": "2026-01-17"},
    ]
    results = await afc.categorize_batch("cid", txns)

    # Every row hit the LLM (no propagation for unclusterable rows).
    assert set(seen_ids) == {"t1", "t2", "t3"}
    assert len(results) == 3
    for r in results:
        assert r["source"] == "ai_first"
