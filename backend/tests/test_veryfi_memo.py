"""Regression cases for Veryfi memo cleanup + prefix classification.

Every string here was pulled from a real problematic import
(PDF Test Co LLC, Feb 2026). Locking them in as tests so any future
regex change breaks CI before it hits the ingest."""
from veryfi_memo import (
    clean_bank_memo,
    classify_by_memo_prefix,
    extract_payment_channel,
)


# ---------------------------------------------------------------------------
# clean_bank_memo — the "vendor cleanup" job.
# ---------------------------------------------------------------------------

def test_clean_strips_pmnt_sent_prefix_and_state():
    # The single biggest source of pseudo-vendors in the PDF import.
    assert clean_bank_memo(
        "PMNT SENT 0109 VENMO *Susan Visa Direct NY"
    ) == "VENMO *Susan Visa Direct"


def test_clean_strips_purchase_prefix_and_phone_and_state():
    assert clean_bank_memo(
        "PURCHASE 0113 STARBUCKS 800-782-7282 WA"
    ) == "STARBUCKS"


def test_clean_preserves_merchant_middle_words():
    assert clean_bank_memo(
        "PURCHASE 0106 SUMMIT CHURCH SUMMITNV.ORG NV"
    ) == "SUMMIT CHURCH SUMMITNV.ORG"


def test_clean_strips_store_number():
    assert clean_bank_memo(
        "PURCHASE 0116 THE HOME DEPOT #3313 SPARKS NV"
    ) == "THE HOME DEPOT"


def test_clean_check_row_keeps_label():
    # Not a purchase — the row is a check reference. We at minimum
    # strip the trailing #NNNN store-number match, which leaves the
    # human-readable "CHECK" label. Fine — downstream check-detection
    # keys off the amount + `check #` prefix elsewhere.
    assert clean_bank_memo("CHECK #1042") == "CHECK"


def test_clean_amazon_amzn_pattern():
    # Common pattern: `PURCHASE 0207 AMZN Mktp US*1A2B3 WA`
    result = clean_bank_memo("PURCHASE 0207 AMZN Mktp US*1A2B3 WA")
    assert result.startswith("AMZN") and "WA" not in result


def test_clean_no_op_on_already_clean():
    # Idempotent — repeated cleaning of a clean string is unchanged.
    assert clean_bank_memo("Starbucks") == "Starbucks"
    assert clean_bank_memo("Google Ads") == "Google Ads"


def test_clean_empty_and_none():
    assert clean_bank_memo(None) == ""
    assert clean_bank_memo("") == ""
    assert clean_bank_memo("   ") == ""


def test_clean_handles_check_row_removed():
    pass                                              # replaced by test_clean_check_row_keeps_label


# ---------------------------------------------------------------------------
# classify_by_memo_prefix — the mini-PFC.
# ---------------------------------------------------------------------------

def test_classify_nsf_fee_hits_bank_charges():
    r = classify_by_memo_prefix("NSF FEE")
    assert r["code"] == "6100"


def test_classify_interest_paid_hits_interest_income():
    r = classify_by_memo_prefix("INTEREST PAID THIS PERIOD")
    assert r["code"] == "4900"


def test_classify_atm_withdrawal_hits_owner_draw():
    r = classify_by_memo_prefix("ATM WITHDRAWAL 0912 CHASE #1234")
    assert r["code"] == "3500"


def test_classify_transfer_returns_transfer_hint():
    r = classify_by_memo_prefix("TRANSFER TO SAVINGS X1234")
    assert r["channel"] == "transfer"
    # Transfers explicitly have no P&L code — caller books to the
    # matched bank account instead.
    assert r["code"] is None


def test_classify_direct_deposit_hits_sales_revenue():
    r = classify_by_memo_prefix("DIRECT DEP ACME CORP PAYROLL", amount=1500.0)
    assert r["code"] == "4000"


def test_classify_generic_purchase_returns_none():
    # Regular purchases should NOT be auto-classified — they need the
    # AI + merchant cache path to pick the right expense account.
    assert classify_by_memo_prefix("PURCHASE 0113 STARBUCKS WA") is None
    assert classify_by_memo_prefix("PMNT SENT 0109 VENMO *Susan") is None
    assert classify_by_memo_prefix("") is None
    assert classify_by_memo_prefix(None) is None


# ---------------------------------------------------------------------------
# extract_payment_channel — surfaces "Venmo" / "PayPal" for chip UI.
# ---------------------------------------------------------------------------

def test_channel_detects_venmo_paypal_cashapp():
    assert extract_payment_channel("PMNT SENT VENMO *Susan") == "Venmo"
    assert extract_payment_channel("PAYPAL *TRANSFER 12345") == "Paypal"
    assert extract_payment_channel("CashApp *Kevin") == "Cash App"


def test_channel_returns_none_when_absent():
    assert extract_payment_channel("PURCHASE 0113 STARBUCKS WA") is None
    assert extract_payment_channel(None) is None
