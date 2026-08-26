"""Regression tests for the Standard+ Beta cascade (Feb 2026).

Covers:
    1. `global_vendor_rules.match` first-match-wins on known merchants
    2. `global_vendor_rules.match` returns None for unknown text
    3. `resolve_semantic` falls back to generic when template missing
    4. `resolve_semantic` returns None for template that has no such semantic
    5. `apply_global_rules_override` overrides high-confidence rows
    6. `apply_global_rules_override` respects tri-state (skips <0.50,
       flags 0.50–0.75 with needs_review=True, trusts ≥0.75)
    7. Rows with no matching rule are left untouched (Standard's answer stands)
    8. Malformed / missing merchant + description doesn't crash
"""
from __future__ import annotations
from unittest.mock import AsyncMock

import pytest


class TestGlobalVendorRules:
    def test_starbucks_matches_meals(self):
        import global_vendor_rules as r
        m = r.match_and_resolve("STARBUCKS STORE #12345", "generic")
        assert m is not None
        assert m["semantic"] == "meals"
        assert m["account_code"] == "6400"
        assert m["confidence"] == 0.90

    def test_walmart_matches_office_supplies_with_low_confidence(self):
        # Walmart is intentionally low-confidence (0.60) so tri-state
        # flags it for CPA review.
        import global_vendor_rules as r
        m = r.match_and_resolve("WALMART SUPERCENTER #4321", "generic")
        assert m["semantic"] == "office_supplies"
        assert m["confidence"] == 0.60

    def test_rocket_mortgage_matches_loan_payment(self):
        import global_vendor_rules as r
        m = r.match_and_resolve("ROCKET MORTGAGE PYMT 04/15", "generic")
        assert m["semantic"] == "loan_payment"

    def test_no_match_returns_none(self):
        import global_vendor_rules as r
        assert r.match_and_resolve("SOME OBSCURE VENDOR XYZ", "generic") is None

    def test_first_match_wins_uber_trip_before_uber(self):
        # UBER TRIP must be recognized as transportation (0.90), NOT
        # matched by the looser "UBER" rule (0.65). Order in RULES
        # matters.
        import global_vendor_rules as r
        trip = r.match_and_resolve("UBER *TRIP HELP.UBER.COM", "generic")
        assert trip["semantic"] == "transportation"
        assert trip["confidence"] == 0.90

    def test_resolve_semantic_falls_back_to_generic(self):
        # A template that has this semantic mapped uses its own code.
        import global_vendor_rules as r
        code = r.resolve_semantic("meals", "restaurant")
        assert code == "6400"

    def test_resolve_semantic_returns_none_when_template_missing(self):
        # food_cogs is only relevant for restaurants — returns None for
        # a SaaS company.
        import global_vendor_rules as r
        assert r.resolve_semantic("food_cogs", "professional_services") is None

    def test_empty_text_returns_none(self):
        import global_vendor_rules as r
        assert r.match_and_resolve("", "generic") is None
        assert r.match_and_resolve(None, "generic") is None

    def test_rule_count_positive(self):
        import global_vendor_rules as r
        assert r.rule_count() > 400  # v1 draft shipped ~485


class TestApplyGlobalRulesOverride:

    @pytest.mark.asyncio
    async def test_high_confidence_overrides_without_review(self, monkeypatch):
        """AWS at conf=0.95 → override applied, needs_review=False."""
        import standard_plus_categorizer as spc

        # Fake company + CoA + existing txn
        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [
            {"id": "acc-saas", "code": "6300", "name": "Software & Subscriptions"},
            {"id": "acc-uncat", "code": "6999", "name": "Uncategorized Expense"},
        ]
        fake_txn = {"id": "t1", "company_id": "cid",
                    "merchant": "AWS US EAST", "description": "AWS US EAST",
                    "category_account_code": "6999"}

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["matched"] == 1
        assert stats["overridden"] == 1
        assert stats["review_flagged"] == 0
        # Applied update
        assert len(updates) == 1
        _filt, upd = updates[0]
        assert upd["$set"]["category_account_code"] == "6300"
        assert upd["$set"]["needs_review"] is False
        assert upd["$set"]["categorization_source"] == "standard_plus_rule"

    @pytest.mark.asyncio
    async def test_medium_confidence_overrides_with_review(self, monkeypatch):
        """Walmart at conf=0.60 → override applied, needs_review=True."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [
            {"id": "acc-off", "code": "6600", "name": "Office Supplies"},
        ]
        fake_txn = {"id": "t1", "company_id": "cid",
                    "merchant": "WALMART SUPERCENTER",
                    "description": "WALMART SUPERCENTER",
                    "category_account_code": "6800"}

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["overridden"] == 1
        assert stats["review_flagged"] == 1
        _filt, upd = updates[0]
        assert upd["$set"]["needs_review"] is True
        assert upd["$set"]["category_account_code"] == "6600"

    @pytest.mark.asyncio
    async def test_no_rule_match_leaves_row_untouched(self, monkeypatch):
        """Unknown merchant → skipped, no override, Standard's answer wins."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_txn = {"id": "t1", "company_id": "cid",
                    "merchant": "OBSCURE LOCAL VENDOR",
                    "description": "OBSCURE LOCAL VENDOR",
                    "category_account_code": "6800"}

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([])),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["matched"] == 0
        assert stats["overridden"] == 0
        assert stats["skipped"] == 1
        # Standard's answer preserved — no update_one call fired.
        assert updates == []

    @pytest.mark.asyncio
    async def test_empty_id_list_returns_zero_stats(self, monkeypatch):
        import standard_plus_categorizer as spc
        stats = await spc.apply_global_rules_override("cid", [])
        assert stats == {"matched": 0, "overridden": 0,
                         "review_flagged": 0, "skipped": 0}



class TestTenantPriorityGuard:
    """Standard+ must respect per-tenant categorization decisions.
    If Standard's cascade applied a customer-specific rule (`ai_source == "rule"`)
    or a hit from the customer's own merchant memory (`ai_source == "memory"`),
    the Global 485 must NOT override it. Priority stack:

        Tenant Custom Rule > Tenant Rules Miner > Tenant Merchant Cache
          > Global 485 > Plaid PFC > LLM fallback

    Without this guard, a tenant who explicitly categorized Walmart
    as COGS in their own Custom Rules would get silently clobbered
    back to Global Rules' Walmart → Supplies default.
    """

    @pytest.mark.asyncio
    async def test_tenant_rule_wins_over_global_rule(self, monkeypatch):
        """ai_source='rule' → Global Rules must NOT override."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [
            {"id": "acc-cogs", "code": "5000", "name": "COGS"},
        ]
        # Customer has a per-tenant rule that already put this Walmart
        # into COGS. Standard applied it and stamped ai_source='rule'.
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "WALMART SUPERCENTER #4321",
            "description": "WALMART SUPERCENTER #4321",
            "amount": -50,
            "ai_source": "rule",
            "category_account_code": "5000",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        # No update_one call: tenant's rule preserved.
        assert updates == []
        assert stats["skipped_tenant_priority"] == 1
        assert stats["overridden"] == 0

    @pytest.mark.asyncio
    async def test_tenant_memory_hit_wins_over_global_rule(self, monkeypatch):
        """ai_source='memory' → per-tenant merchant cache wins."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [{"id": "a", "code": "5000", "name": "COGS"}]
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "COSTCO WHSE",
            "description": "COSTCO WHSE",
            "amount": -800,
            "ai_source": "memory",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])
        assert updates == []
        assert stats["skipped_tenant_priority"] == 1

    @pytest.mark.asyncio
    async def test_llm_sourced_row_is_still_overridable(self, monkeypatch):
        """ai_source='ai' or 'pfc_*' → Global Rules CAN override.
        This is the normal case: Standard's LLM/PFC guess is replaced
        by a curated Global Rule that's more specific."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [
            {"id": "a-saas", "code": "6300", "name": "Software & Subs"},
        ]
        # Standard's LLM guessed something for AWS — Global Rule
        # should override to Software & Subscriptions.
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "AWS US EAST",
            "description": "AWS US EAST",
            "amount": -1200,
            "ai_source": "ai",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        # Should override — LLM-sourced rows are fair game.
        assert stats["overridden"] == 1
        assert stats["skipped_tenant_priority"] == 0
        _, upd = updates[0]
        assert upd["$set"]["category_account_code"] == "6300"



class TestPfcFallback:
    """Plaid PFC (Personal Finance Category) is the Standard+ stage-2
    fallback: when a merchant string doesn't match any Global Vendor
    Rule but Plaid tagged the txn with a PFC, we use the PFC's
    semantic-key mapping. Per-template resolution via
    `resolve_semantic` gives industry-aware account codes for free."""

    def test_resolve_pfc_known_maps(self):
        import pfc_semantic_map as psm
        m = psm.resolve_pfc("FOOD_AND_DRINK_COFFEE", "HIGH")
        assert m["semantic"] == "meals"
        assert 0.75 <= m["confidence"] <= 0.95

    def test_resolve_pfc_low_confidence_stays_below_high_threshold(self):
        import pfc_semantic_map as psm
        m = psm.resolve_pfc("TRAVEL_LODGING", "LOW")
        assert m["confidence"] == 0.55

    def test_resolve_pfc_returns_none_for_unmapped(self):
        import pfc_semantic_map as psm
        assert psm.resolve_pfc("OTHER_OTHER", "HIGH") is None
        assert psm.resolve_pfc(None) is None
        assert psm.resolve_pfc("") is None

    def test_pfc_coverage_meaningful(self):
        import pfc_semantic_map as psm
        cov = psm.pfc_coverage()
        assert cov["total_pfc_categories"] > 80  # Plaid taxonomy is ~104
        assert cov["mapped"] > 60

    @pytest.mark.asyncio
    async def test_standard_plus_uses_pfc_when_no_rule_match(self, monkeypatch):
        """Unknown merchant + mapped Plaid PFC → PFC hit applied."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [
            {"id": "acc-meals", "code": "6400", "name": "Meals - Business"},
        ]
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "OBSCURE ARTISAN CAFE LLC",
            "description": "OBSCURE ARTISAN CAFE LLC",
            "pfc_detailed": "FOOD_AND_DRINK_COFFEE",
            "pfc_confidence_level": "HIGH",
            "category_account_code": "6800",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["matched"] == 1
        assert stats["matched_via_pfc"] == 1
        assert stats["matched_via_rule"] == 0
        assert stats["overridden"] == 1
        assert stats["review_flagged"] == 0
        _, upd = updates[0]
        assert upd["$set"]["category_account_code"] == "6400"
        assert upd["$set"]["categorization_source"] == "standard_plus_pfc"

    @pytest.mark.asyncio
    async def test_rule_beats_pfc(self, monkeypatch):
        """When BOTH match, the merchant rule wins (more specific)."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        fake_accts = [
            {"id": "acc-meals", "code": "6400", "name": "Meals"},
        ]
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "STARBUCKS #4321",
            "description": "STARBUCKS #4321",
            "pfc_detailed": "FOOD_AND_DRINK_COFFEE",
            "pfc_confidence_level": "HIGH",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(fake_accts)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["matched_via_rule"] == 1
        assert stats["matched_via_pfc"] == 0
        _, upd = updates[0]
        assert upd["$set"]["categorization_source"] == "standard_plus_rule"



class TestSemanticNameFallback:
    """Regression suite for the "Domino's in Insurance" bug (Feb 2026).

    Standard Plus LLC's Chart of Accounts had a NON-standard code
    layout: code 6400 = Insurance, code 6000 = Meals & Entertainment
    (opposite of the generic template). The old code-based lookup
    matched a Domino's txn to semantic "meals", then blindly
    resolved that to code 6400 in the generic template, then found
    the company's 6400 account (Insurance) and put Domino's there.

    The fix: resolve by account NAME first via
    `SEMANTIC_TO_NAME_PATTERNS`, and only fall back to code lookup
    when no name matches. Name matching is CoA-agnostic.
    """

    def test_resolve_meals_by_name_on_custom_coa(self):
        """Domino's → semantic meals → Meals & Ent (code 6000)
        even though generic template says meals=6400."""
        import global_vendor_rules as r
        custom_coa = [
            {"id": "ins", "code": "6400", "name": "Insurance"},
            {"id": "meals", "code": "6000", "name": "Meals & Entertainment"},
        ]
        acct = r.resolve_semantic_to_account("meals", custom_coa, "generic")
        assert acct is not None
        assert acct["id"] == "meals"
        assert acct["name"] == "Meals & Entertainment"
        assert acct["code"] == "6000"  # NOT 6400 (Insurance)

    def test_resolve_meals_by_name_prefers_specific_pattern(self):
        """When both "Meals & Entertainment" and "Meals" exist, the
        first pattern in SEMANTIC_TO_NAME_PATTERNS wins — patterns
        are ordered most-specific-first."""
        import global_vendor_rules as r
        accts = [
            {"id": "a", "code": "6400", "name": "Meals"},
            {"id": "b", "code": "6500", "name": "Meals & Entertainment"},
        ]
        acct = r.resolve_semantic_to_account("meals", accts, "generic")
        # Pattern order: "meals & entertainment" comes first
        assert acct["id"] == "b"

    def test_resolve_falls_back_to_code_when_no_name_match(self):
        """CoA with no name match — code lookup still resolves via
        the template numbering."""
        import global_vendor_rules as r
        # No "meals" in any name; but code 6400 exists
        accts = [
            {"id": "x", "code": "6400", "name": "Client Entertainment Costs"},
            {"id": "y", "code": "6600", "name": "Random Bucket"},
        ]
        acct = r.resolve_semantic_to_account("meals", accts, "generic")
        assert acct is not None
        assert acct["code"] == "6400"  # generic template's meals code

    def test_resolve_returns_none_when_both_paths_miss(self):
        """CoA totally lacks the semantic — both name and code fail."""
        import global_vendor_rules as r
        accts = [
            {"id": "x", "code": "5000", "name": "Cost of Goods"},
        ]
        # food_cogs is None in generic template, and no name pattern matches
        assert r.resolve_semantic_to_account(
            "food_cogs", accts, "generic",
        ) is None

    def test_resolve_handles_missing_or_empty_inputs(self):
        import global_vendor_rules as r
        assert r.resolve_semantic_to_account("meals", [], "generic") is None
        assert r.resolve_semantic_to_account("", [{"name": "X"}], "generic") is None
        assert r.resolve_semantic_to_account(None, [{"name": "X"}], "generic") is None

    def test_resolve_case_insensitive_name_match(self):
        import global_vendor_rules as r
        accts = [
            {"id": "a", "code": "6400", "name": "MEALS & ENTERTAINMENT"},
        ]
        acct = r.resolve_semantic_to_account("meals", accts, "generic")
        assert acct is not None
        assert acct["id"] == "a"

    def test_resolve_insurance_on_conflicting_custom_coa(self):
        """The other side of the Domino's bug — an actual insurance
        payment on the SAME conflicting CoA should still resolve
        correctly to the Insurance account by NAME."""
        import global_vendor_rules as r
        custom_coa = [
            {"id": "ins", "code": "6400", "name": "Insurance"},
            {"id": "meals", "code": "6000", "name": "Meals & Entertainment"},
        ]
        acct = r.resolve_semantic_to_account("insurance", custom_coa, "generic")
        assert acct is not None
        assert acct["id"] == "ins"

    @pytest.mark.asyncio
    async def test_dominos_lands_in_meals_on_custom_coa(self, monkeypatch):
        """End-to-end regression: a Domino's txn on a company with a
        SWAPPED CoA (6400=Insurance, 6000=Meals) must land in Meals,
        NOT in Insurance. This is the exact bug the user reported."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        # Custom CoA where 6400 = Insurance (opposite of generic)
        custom_coa = [
            {"id": "acc-ins",   "code": "6400", "name": "Insurance"},
            {"id": "acc-meals", "code": "6000", "name": "Meals & Entertainment"},
            {"id": "acc-unc",   "code": "6999", "name": "Uncategorized Expense"},
        ]
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "DOMINO'S PIZZA #1234",
            "description": "DOMINO'S PIZZA #1234",
            "amount": -28.50,
            "category_account_code": "6999",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(custom_coa)),
        })()
        updates = []

        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["overridden"] == 1
        _filt, upd = updates[0]
        # THE fix: must land in Meals & Entertainment (code 6000),
        # NOT in Insurance (code 6400).
        assert upd["$set"]["category_account_id"] == "acc-meals"
        assert upd["$set"]["category_account_name"] == "Meals & Entertainment"
        assert upd["$set"]["category_account_code"] == "6000"


class TestAmountBucketRules:
    """Amount-bucket rules let ambiguous merchants (Costco, Walmart,
    Amazon, Home Depot, etc.) resolve to different categories based
    on transaction size. Small Costco = food court → meals. Large
    Costco = bulk supplies. Same merchant, different bucket, different
    account. Deterministic — no LLM needed."""

    def test_costco_small_amount_maps_to_meals(self):
        """$8 Costco = food court → meals @ 0.75"""
        import global_vendor_rules as r
        m = r.match_and_resolve("COSTCO WHSE #4321", "generic", amount=-8)
        assert m["semantic"] == "meals"
        assert m["confidence"] == 0.75
        assert m["bucket"] == "s"

    def test_costco_large_amount_maps_to_supplies(self):
        """$850 Costco = bulk supplies → supplies_cogs @ 0.75"""
        import global_vendor_rules as r
        m = r.match_and_resolve("COSTCO WHSE #4321", "generic", amount=-850)
        assert m["semantic"] == "supplies_cogs"
        assert m["confidence"] == 0.75
        assert m["bucket"] == "l"

    def test_home_depot_small_stays_repairs(self):
        """$25 Home Depot = repairs & maintenance"""
        import global_vendor_rules as r
        m = r.match_and_resolve("HOME DEPOT #501", "generic", amount=-25)
        assert m["semantic"] == "repairs_maintenance"
        assert m["bucket"] == "s"

    def test_home_depot_large_becomes_cogs(self):
        """$3000 Home Depot = COGS (contractor materials)"""
        import global_vendor_rules as r
        m = r.match_and_resolve("HOME DEPOT #501", "construction", amount=-3000)
        assert m["semantic"] == "supplies_cogs"
        assert m["bucket"] == "l"

    def test_walmart_income_amount_uses_absolute_value(self):
        """A refund/credit at -$8 (income) buckets by absolute value."""
        import global_vendor_rules as r
        m = r.match_and_resolve("WALMART #123", "generic", amount=8)
        assert m["bucket"] == "s"

    def test_no_amount_falls_back_to_flat_semantic(self):
        """When no amount is supplied, rules use their default flat semantic."""
        import global_vendor_rules as r
        m = r.match_and_resolve("COSTCO WHSE #4321", "generic")
        assert m["semantic"] == "office_supplies"  # rule's default
        assert m["bucket"] is None

    def test_gas_station_amount_split(self):
        """$4 at Wawa = meals/snacks; $50 at Wawa = fuel."""
        import global_vendor_rules as r
        small = r.match_and_resolve("WAWA STORE 402", "generic", amount=-4)
        assert small["semantic"] == "meals"
        big = r.match_and_resolve("WAWA STORE 402", "generic", amount=-55)
        assert big["semantic"] == "fuel"

    def test_amount_bucket_helper_matches_ai_first_cutoffs(self):
        """The bucket cutoffs use the standard $50 / $500 / $5000
        thresholds so amount-bucket rules split by consistent
        magnitudes across the codebase."""
        import global_vendor_rules as r
        assert r.amount_bucket(0) == "s"
        assert r.amount_bucket(49.99) == "s"
        assert r.amount_bucket(50) == "m"
        assert r.amount_bucket(499.99) == "m"
        assert r.amount_bucket(500) == "l"
        assert r.amount_bucket(4999.99) == "l"
        assert r.amount_bucket(5000) == "xl"
