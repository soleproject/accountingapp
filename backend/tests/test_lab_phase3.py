"""Phase 3 deterministic tests — Steps 6, 7, 8 pure-function coverage.

Zero DB, zero LLM. Sub-second.
"""
from __future__ import annotations
import pytest

from lab_pipeline.step6_directory import (
    _classify_deterministic, SENSITIVE_MERCHANT_TYPES,
)
from lab_pipeline.step7_category import _is_owners_draw, _llm_cache_key


# --- Step 6: merchant type classifier ---------------------------------

class TestPaymentApp:
    def test_hardcoded(self):
        mt, _ = _classify_deterministic("PayPal", None, None, None)
        assert mt == "payment_app"

    def test_movement_type(self):
        mt, _ = _classify_deterministic("XYZ", "payment_app_transfer", None, None)
        assert mt == "payment_app"

    def test_plaid_counterparty(self):
        mt, _ = _classify_deterministic("New Name", None, None,
                                        [{"type": "payment_app", "name": "Venmo"}])
        assert mt == "payment_app"


class TestCreditCard:
    def test_hardcoded(self):
        assert _classify_deterministic("American Express", None, None, None)[0] == "credit_card"
        assert _classify_deterministic("Chase", None, None, None)[0] == "credit_card"

    def test_movement_type(self):
        assert _classify_deterministic("XYZ", "credit_line_payment", None, None)[0] == "credit_card"


class TestBankLender:
    def test_hardcoded(self):
        assert _classify_deterministic("Rocket Mortgage", None, None, None)[0] == "bank_lender"

    def test_pfc_loan(self):
        assert _classify_deterministic("New Loan Co", None, "LOAN_PAYMENTS", None)[0] == "bank_lender"


class TestGovernment:
    def test_hardcoded(self):
        assert _classify_deterministic("IRS", None, None, None)[0] == "government"
        assert _classify_deterministic("City Of Sparks", None, None, None)[0] == "government"

    def test_pfc(self):
        assert _classify_deterministic("Unknown Gov", None, "GOVERNMENT_AND_NON_PROFIT", None)[0] == "government"


class TestPayroll:
    def test_hardcoded(self):
        assert _classify_deterministic("Gusto", None, None, None)[0] == "payroll"
        assert _classify_deterministic("ADP Payroll", None, None, None)[0] == "payroll"

    def test_case_and_suffix_stripping(self):
        # normalize_contact_name lowercases + strips "Inc"
        assert _classify_deterministic("ADP INC.", None, None, None)[0] == "payroll"


class TestUtility:
    def test_hardcoded(self):
        assert _classify_deterministic("Verizon", None, None, None)[0] == "utility"

    def test_pfc(self):
        assert _classify_deterministic("Some Utility", None, "RENT_AND_UTILITIES", None)[0] == "utility"


class TestMultiPurpose:
    def test_hardcoded(self):
        assert _classify_deterministic("Walmart", None, None, None)[0] == "multi_purpose"


class TestFallbackHeuristics:
    def test_business_suffix(self):
        assert _classify_deterministic("Acme Consulting LLC", None, None, None)[0] == "merchant"

    def test_person_name(self):
        assert _classify_deterministic("Jane Doe", None, None, None)[0] == "individual"

    def test_unknown_single_token(self):
        assert _classify_deterministic("Bloop", None, None, None)[0] == "unknown"

    def test_empty(self):
        assert _classify_deterministic("", None, None, None)[0] == "unknown"


class TestSensitiveSet:
    def test_locked_exclusions(self):
        # Feb-2026 cut: insurance + credit_card MUST NOT be in the
        # sensitive-first-time set.
        assert "insurance" not in SENSITIVE_MERCHANT_TYPES
        assert "credit_card" not in SENSITIVE_MERCHANT_TYPES

    def test_locked_inclusions(self):
        assert "bank_lender" in SENSITIVE_MERCHANT_TYPES
        assert "government" in SENSITIVE_MERCHANT_TYPES
        assert "payroll" in SENSITIVE_MERCHANT_TYPES


# --- Step 7: Owner's Draw protection + cache key ----------------------

class TestOwnersDrawGuard:
    @pytest.mark.parametrize("name,expected", [
        ("Owner's Draw",         True),
        ("Owner Distribution",   True),
        ("Owners Draw",          True),
        ("Distributions to Owner", True),
        ("Meals & Entertainment", False),
        ("Cash and Bank",        False),
    ])
    def test_matches(self, name, expected):
        assert _is_owners_draw({"name": name}) is expected


class TestCategoryCacheKey:
    def test_stable_across_junk(self):
        a = _llm_cache_key("STARBUCKS #4321 SEATTLE WA 09/15", "Starbucks", ["Meals", "Office"])
        b = _llm_cache_key("STARBUCKS #4321 SEATTLE WA 09/16", "Starbucks", ["Meals", "Office"])
        assert a == b

    def test_differs_when_coa_differs(self):
        a = _llm_cache_key("PANERA", "Panera", ["Meals"])
        b = _llm_cache_key("PANERA", "Panera", ["Meals", "Office"])
        assert a != b
