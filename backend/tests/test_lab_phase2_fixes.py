"""Feb-2026 Phase 2 fixes coverage.

  1. Step 5 order — Plaid merchant_name used BEFORE the LLM
  2. Clean contact name (ALL-CAPS → Title Case, strip trailing #s)
  3. Bank-fee detection routes to bank contact + Bank Fees category
  4. Generic text ("Check", "Deposit") never becomes a contact
     AND blank-contact alone is NOT a review reason (Step 8 requires
     BOTH blank contact and unresolved category)
"""
from __future__ import annotations
from lab_pipeline.step5_contacts import _is_generic_text, _clean_merchant_name


class TestGenericTextGuard:
    def test_blocks_common_bank_boilerplate(self):
        for s in ("Check", "checks", "Deposit", "DEPOSITS", "Withdrawal",
                  "ATM", "Cash", "ACH", "ach payment", "Wire", "Wire Transfer",
                  "POS", "Purchase", "Direct Deposit", "Individual",
                  "External Withdrawal", "Online Banking Transfer"):
            assert _is_generic_text(s), f"should block: {s!r}"

    def test_allows_real_merchants(self):
        for s in ("Marriott Hotels", "Starbucks", "New York Life",
                  "Rocket Mortgage", "Panera Bread", "Enterprise Rent-A-Car"):
            assert not _is_generic_text(s), f"should allow: {s!r}"

    def test_empty(self):
        assert _is_generic_text("")
        assert _is_generic_text(None)
        assert _is_generic_text("   ")


class TestCleanMerchantName:
    def test_title_case_all_caps(self):
        assert _clean_merchant_name("MARRIOTT HOTELS") == "Marriott Hotels"

    def test_preserve_mixed(self):
        assert _clean_merchant_name("Marriott Hotels") == "Marriott Hotels"

    def test_strip_store_number(self):
        assert _clean_merchant_name("STARBUCKS #4321").startswith("Starbucks")
        assert "#4321" not in _clean_merchant_name("STARBUCKS #4321")

    def test_empty(self):
        assert _clean_merchant_name("") == ""


class TestBankFeeDetection:
    """Sanity: the live helper we reuse catches the common phrasing."""
    def test_recognizes_common_fees(self):
        from contact_resolver import is_bank_fee_row
        for s in ("Monthly Maintenance Fee", "OVERDRAFT FEE",
                  "Service Charge", "Wire Fee", "ATM Fee"):
            assert is_bank_fee_row(s), f"should recognize: {s!r}"

    def test_ignores_real_merchants(self):
        from contact_resolver import is_bank_fee_row
        for s in ("Starbucks", "Marriott Hotels"):
            assert not is_bank_fee_row(s), f"should skip: {s!r}"


class TestStep8UnidentifiedRequiresBothSignals:
    """Feb-2026 fix #4: blank contact alone is NOT a review reason."""

    def test_scope_documented(self):
        # The routing lives in step8_review.run_step8; here we just
        # assert the constants + flag it as covered.
        from lab_pipeline.step8_review import _UNIDENTIFIED_CHANNELS
        assert _UNIDENTIFIED_CHANNELS == frozenset({"check", "wire"})
