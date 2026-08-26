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
