"""Standard cascade — Global Contact Directory tier tests.

Verifies the Standard pipeline (not just Standard+) now uses the
directory as a deterministic short-circuit between PFC and the LLM.
"""
from __future__ import annotations
import sys
sys.path.insert(0, "/app/backend")
import pytest


class TestStandardDirectoryTier:
    """Unit tests for the directory-hint short-circuit inside
    `plaid_connect.categorize_and_insert_plaid_txns` / the parallel
    statement path.  We don't spin the whole ingest — just confirm the
    resolver contract we depend on returns what we expect.
    """

    def test_directory_hint_semantic_resolves_via_name_first(self):
        """The Standard directory tier resolves via
        `global_vendor_rules.resolve_semantic_to_account` — the same
        name-first resolver Standard+ uses.  This test locks that in."""
        import global_vendor_rules as gvr
        # Custom CoA (Standard Plus LLC's scenario — swapped codes)
        custom_coa = [
            {"id": "a-meals",  "code": "6000", "name": "Meals"},
            {"id": "a-ins",    "code": "6400", "name": "Insurance"},
        ]
        acct = gvr.resolve_semantic_to_account("meals", custom_coa, "generic")
        # Must land in Meals (a-meals) by NAME, not in Insurance which
        # happens to sit under code 6400 on this CoA.
        assert acct is not None
        assert acct["id"] == "a-meals"

    def test_directory_hint_is_readable_from_contact_resolver(self):
        """Contract check: `contact_resolver.resolve_contact` returns
        `linked_semantic` on directory-driven contact creation.  The
        Standard pipeline picks this up as `linked_semantic` on the
        contact_result dict, then propagates to the candidate as
        `category_hint_semantic`.
        """
        import global_contact_directory as gcd
        hit = gcd.lookup("STARBUCKS #4823 SEATTLE")
        assert hit is not None
        assert hit["canonical_name"] == "Starbucks"
        # This is what gets stamped as `linked_semantic` on the tenant
        # contact, then as `category_hint_semantic` on the txn.
        assert hit["semantic"] == "meals"

    def test_semantic_that_maps_to_no_account_returns_none(self):
        """If the directory says 'food_cogs' but the CoA is a SaaS
        firm's CoA with no food_cogs account, resolve_semantic_to_account
        returns None → the Standard pipeline's `still_deferred` branch
        catches it and hands the row to the LLM instead of forcing a
        bad category."""
        import global_vendor_rules as gvr
        saas_coa = [
            {"id": "a-sw",     "code": "6300", "name": "Software & Subscriptions"},
            {"id": "a-office", "code": "6600", "name": "Office Supplies"},
        ]
        # food_cogs → no name match, no code fallback → None
        acct = gvr.resolve_semantic_to_account("food_cogs", saas_coa, "generic")
        assert acct is None
