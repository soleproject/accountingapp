"""Regression lock-in for Phase 0.

The single most important thing this suite guarantees: **existing US
customers see zero behavior change**. Every test here asserts a US
default or an identical output for a US-region call.

Run:  cd /app/backend && pytest tests/test_region_defaults.py -q
"""
from __future__ import annotations

import pytest

from regions import REGIONS, defaults_for, get


class TestRegionRegistry:
    def test_us_exists_and_is_canonical(self):
        assert "US" in REGIONS
        us = REGIONS["US"]
        assert us["currency"] == "USD"
        assert us["currency_symbol"] == "$"
        assert us["locale"] == "en-US"
        assert us["date_format"] == "MM/DD/YYYY"

    def test_uk_exists_with_expected_shape(self):
        assert "UK" in REGIONS
        uk = REGIONS["UK"]
        assert uk["currency"] == "GBP"
        assert uk["currency_symbol"] == "£"
        assert uk["locale"] == "en-GB"
        assert uk["date_format"] == "DD/MM/YYYY"

    def test_unknown_region_falls_back_to_us(self):
        # Legacy docs, malformed input, empty string, None — all US.
        assert get(None)["code"] == "US"
        assert get("")["code"] == "US"
        assert get("ZZ")["code"] == "US"
        assert get("uk")["code"] == "UK"  # case-insensitive

    def test_defaults_for_us_matches_legacy_hardcodes(self):
        """The three fields Phase 0 persists on every company MUST match
        what the app has always assumed for US customers. If this ever
        changes, existing US behavior is at risk."""
        d = defaults_for("US")
        assert d == {
            "region": "US",
            "currency": "USD",
            "date_format": "MM/DD/YYYY",
        }

    def test_defaults_for_none_is_us(self):
        assert defaults_for(None) == defaults_for("US")


class TestFeatureFlagCacheShape:
    """Feature-flag DB access is exercised by the integration suite;
    here we lock in the *shape* of the cache so a refactor can't
    silently change TTL semantics."""

    def test_ttl_is_at_least_five_seconds(self):
        # Ops needs to be able to flip a flag and see the change
        # within a reasonable window. Anything under 5s risks
        # thundering-herd on Mongo; anything over 60s frustrates ops.
        from feature_flags import _TTL_SECONDS
        assert 5 <= _TTL_SECONDS <= 60


@pytest.mark.asyncio
class TestBackfillIdempotence:
    async def test_backfill_only_touches_docs_missing_region(self, monkeypatch):
        """The migration must NEVER overwrite a company that already
        has a region set — otherwise a future UK company would get
        stomped back to US on a re-run."""
        updates: list[dict] = []

        class FakeCollection:
            async def count_documents(self, q):
                return 0
            async def update_many(self, filter_, update):
                updates.append({"filter": filter_, "update": update})
                class R:
                    modified_count = 0
                return R()

        class FakeDB:
            companies = FakeCollection()

        # Import lazily so monkeypatch of `db` takes effect.
        import scripts.backfill_region as bf
        monkeypatch.setattr(bf, "db", FakeDB())
        await bf._run()

        assert len(updates) == 1
        assert updates[0]["filter"] == {"region": {"$exists": False}}
        # Never a $unset, never a wholesale $set on the whole doc.
        assert "$set" in updates[0]["update"]
        assert "$unset" not in updates[0]["update"]
