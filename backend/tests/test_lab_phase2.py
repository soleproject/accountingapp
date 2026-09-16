"""Phase 2 deterministic tests — pure-function coverage for Step 5.

No DB, no LLM, no Plaid. Runs in <1 s.
"""
from __future__ import annotations

from lab_pipeline.step5_contacts import (
    _match_name,
    _matches_person_name,
    _matches_business_name,
    _is_business_name,
    _looks_indn_only,
    _first_non_app_counterparty,
    _payment_app_only,
    _person_tokens,
)


class TestPersonNameMatch:
    def test_exact(self):
        assert _matches_person_name("Jane Doe", "Jane Doe")

    def test_middle_initial(self):
        assert _matches_person_name("John F Kennedy", "John Kennedy")
        assert _matches_person_name("John F. Kennedy", "John Kennedy")

    def test_order_swap(self):
        # Only via run-together in the current rule set — that catches
        # "Doe, Jane" swaps that would run-together identically.
        assert _matches_person_name("DoeJane", "Jane Doe")
        assert _matches_person_name("Jane Doe", "DoeJane")

    def test_run_together(self):
        assert _matches_person_name("janedoe", "jane doe")

    def test_same_last_name_not_match(self):
        assert not _matches_person_name("Jane Doe", "John Doe")

    def test_reject_single_token(self):
        assert not _matches_person_name("Kennedy", "John F Kennedy")

    def test_empty(self):
        assert not _matches_person_name("", "Jane Doe")
        assert not _matches_person_name("Jane Doe", "")


class TestBusinessNameMatch:
    def test_llc_stripping(self):
        assert _matches_business_name("Acme LLC", "Acme")
        assert _matches_business_name("Acme, Inc.", "Acme, LLC")

    def test_case_insensitive(self):
        assert _matches_business_name("BigCorp Inc", "bigcorp")

    def test_different(self):
        assert not _matches_business_name("Acme Inc", "Zeta LLC")

    def test_is_business_heuristic(self):
        assert _is_business_name("Acme LLC")
        assert _is_business_name("Kevin Petersen Construction Co")
        assert not _is_business_name("Jane Doe")


class TestUnifiedMatch:
    def test_business_path(self):
        assert _match_name("Acme LLC", "Acme, Inc.")

    def test_person_path(self):
        assert _match_name("Jane Doe", "Jane M Doe")

    def test_business_vs_person_no_match(self):
        assert not _match_name("Acme LLC", "Jane Doe")


class TestIndnGuard:
    def test_indn_only_matches(self):
        desc = "NEW YORK LIFE DES:INS. PREM. ID:16 939 428 INDN:MICHAEL F GIORGI  CO ID:1234567890"
        assert _looks_indn_only(desc, "Michael F Giorgi")

    def test_indn_only_case_insensitive(self):
        desc = "PAYPAL DES:INST XFER ID:JOESPIZZA INDN:Michael F Giorgi CO ID:PAYPALSI81"
        assert _looks_indn_only(desc, "michael f giorgi")

    def test_indn_only_does_not_match_merchant(self):
        desc = "PAYPAL DES:INST XFER ID:JOESPIZZA INDN:MICHAEL F GIORGI CO ID:PAYPALSI81"
        assert not _looks_indn_only(desc, "Joespizza")

    def test_no_indn(self):
        assert not _looks_indn_only("STARBUCKS #4321", "Starbucks")


class TestCounterpartyHelpers:
    def test_payment_app_only_true(self):
        cps = [{"name": "Venmo", "type": "payment_app"}]
        assert _payment_app_only(cps)

    def test_payment_app_only_false(self):
        cps = [{"name": "Venmo", "type": "payment_app"},
               {"name": "Jane Doe", "type": "individual"}]
        assert not _payment_app_only(cps)

    def test_first_non_app(self):
        cps = [{"name": "PayPal", "type": "payment_app"},
               {"name": "Starbucks", "type": "merchant"}]
        got = _first_non_app_counterparty(cps)
        assert got and got["name"] == "Starbucks"

    def test_first_non_app_all_apps(self):
        cps = [{"name": "PayPal", "type": "payment_app"}]
        assert _first_non_app_counterparty(cps) is None


class TestTokens:
    def test_strip_punct(self):
        assert _person_tokens("O'Brien, Jane") == ["o", "brien", "jane"]

    def test_empty(self):
        assert _person_tokens("") == []


# --- Enrich cache key stability -----------------------------------------

def test_enrich_cache_key_stable():
    from lab_pipeline.enrich import _build_cache_key
    a = _build_cache_key(description="STARBUCKS #4321 SEATTLE WA 09/15",
                         direction="OUTFLOW", account_type="depository",
                         mcc=None, location=None)
    b = _build_cache_key(description="STARBUCKS #4321 SEATTLE WA 09/16",
                         direction="OUTFLOW", account_type="depository",
                         mcc=None, location=None)
    # Different date tails normalize away → same key.
    assert a == b


def test_enrich_cache_key_differs_on_direction():
    from lab_pipeline.enrich import _build_cache_key
    a = _build_cache_key(description="STARBUCKS", direction="OUTFLOW",
                         account_type="depository", mcc=None, location=None)
    b = _build_cache_key(description="STARBUCKS", direction="INFLOW",
                         account_type="depository", mcc=None, location=None)
    assert a != b


def test_enrich_cache_key_ignores_amount():
    """Amount is intentionally EXCLUDED from the cache key (spec #9).
    We prove this by not exposing amount to the function at all."""
    from inspect import signature
    from lab_pipeline.enrich import _build_cache_key
    params = signature(_build_cache_key).parameters
    assert "amount" not in params
