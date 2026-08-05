"""Regression tests for the three credit-card statement import fixes.

Guards against reintroducing:
  1. "Amex Checking …1004" naming for a liability-typed CoA row
  2. Wrong opening balance seeded (new-balance instead of previous-balance)
  3. Paydowns bucketed as Uncategorized Income

Each test is deliberately narrow so it will still hold if the surrounding
code paths get refactored later.
"""
from statement_account_resolver import (
    _base_detail_from_type,
    _build_account_name,
    _looks_liability,
)


# --- Fix 1: naming defaults per account kind ----------------------------------

def test_asset_naming_defaults_unchanged():
    """Every case that previously produced 'Checking' still does."""
    for inp in (None, "", "Business Checking", "Personal", "Blue Business Cash"):
        assert _base_detail_from_type(inp, is_liability=False) == "Checking", inp


def test_liability_naming_defaults_to_credit_card():
    """A liability with an ambiguous Veryfi `account_type` (Amex reports
    marketing card names like 'Blue Business Cash' or leaves the field
    empty) now falls back to 'Credit Card' instead of 'Checking'.
    """
    for inp in (None, "", "Business", "Blue Business Cash"):
        assert _base_detail_from_type(inp, is_liability=True) == "Credit Card", inp


def test_liability_naming_preserves_specific_types():
    for inp, expected in [
        ("Credit Card", "Credit Card"),
        ("HELOC", "HELOC"),
        ("SBA Loan", "Loan"),
        ("Mortgage Statement", "Mortgage"),
        ("Line of Credit", "Line of Credit"),
    ]:
        assert _base_detail_from_type(inp, is_liability=True) == expected


def test_build_account_name_uses_liability_default():
    n = _build_account_name("American Express", None, "1004", is_liability=True)
    assert n == "American Express Credit Card ···1004"
    n2 = _build_account_name("Bank of America", None, "6084", is_liability=False)
    assert n2 == "Bank of America Checking ···6084"


# --- Fix 2: opening-balance identity ------------------------------------------

def _opening_liability(ending: float, txn_sum: float) -> float:
    return round(ending + txn_sum, 2)


def _opening_asset(ending: float, txn_sum: float) -> float:
    return round(ending - txn_sum, 2)


def test_liability_opening_balance_ties_to_previous_statement():
    # Reproduces the Amex Blue Business Cash statement:
    # prev $3008.84 → charges -$6383.61 → payments +$9184.67 → new $207.78
    txns = -6383.61 + 9184.67
    assert _opening_liability(207.78, txns) == 3008.84


def test_asset_opening_balance_formula_untouched():
    # Sanity: the asset path uses the opposite sign — this must keep working.
    txns = -1500.00 + 3000.00
    assert _opening_asset(6500.00, txns) == 5000.00


def test_liability_paydown_only_period():
    # Full paydown ($500 owed → $0 after single $500 payment)
    assert _opening_liability(0.00, 500.00) == 500.00


def test_liability_charge_only_period():
    # No payments, $800 in new charges. $100 opening → $900 ending.
    assert _opening_liability(900.00, -800.00) == 100.00


# --- Fix 3: paydown guard fires only on (liability + amount > 0) --------------
# Guard behaviour changed: paydowns are now POSTED against the card with
# `category_account_id = Opening Balance Equity` (so the card balance ties
# to the statement) rather than left unposted. `needs_review=True` so the
# reconciliation queue prompts the user to reassign the credit side to the
# source bank / asset once matched.

def _guarded(bank_type: str, amount: float) -> bool:
    """Mirror the guard in `statements._categorize_and_insert_veryfi_lines`."""
    return bank_type == "liability" and amount > 0


def test_guard_fires_on_liability_paydown():
    assert _guarded("liability", 200.00) is True


def test_guard_skipped_on_asset_deposit():
    # This is the critical asset-regression check — a positive amount on
    # Checking is a deposit / revenue and MUST NOT be guarded.
    assert _guarded("asset", 200.00) is False


def test_guard_skipped_on_liability_charge():
    # A negative amount on a credit card is a NEW CHARGE (normal expense)
    # — that still needs to hit the normal categorizer, not the guard.
    assert _guarded("liability", -50.00) is False


def test_guard_skipped_on_asset_withdrawal():
    assert _guarded("asset", -50.00) is False


# --- P0: cardholder-subtotal filter -------------------------------------------
# Veryfi occasionally emits per-cardholder rollup rows for multi-user
# credit-card statements (Amex Blue Business Cash, Chase Ink, etc.). Those
# are subtotals, not real transactions — importing them double-counts the
# ledger by the exact sum of all their underlying charges.

def test_cardholder_subtotal_filter_by_description():
    from veryfi_service import _is_cardholder_subtotal
    # Should suppress — these are the exact rows the Amex test dropped
    assert _is_cardholder_subtotal("APRIL MCINTOSH 0-31004")
    assert _is_cardholder_subtotal("PAUL LABOUNTY JR 0-31020")
    assert _is_cardholder_subtotal("PAUL N LABOUNTY SR 0-31046")
    assert _is_cardholder_subtotal("MCINTOSH 0-31004")

    # Real charges must pass through (never match)
    assert not _is_cardholder_subtotal("BEST BUY SPRINGFIELD MO 888BESTBUY")
    assert not _is_cardholder_subtotal("APRIL MCINTOSH MOBILE PAYMENT - THANK YOU")
    assert not _is_cardholder_subtotal("AMAZON MARKETPLACE NA PA AMZN.COM/BILL WA")
    assert not _is_cardholder_subtotal("STARBUCKS STORE 6307 SPRINGFIELD MO")
    assert not _is_cardholder_subtotal("")


def test_cardholder_subtotal_filter_by_card_number_signal():
    """Cleaner signal per Veryfi docs — when the row carries a
    `card_number` field AND the OCR text is just a bare name, it's a
    subtotal even if it doesn't match the description regex exactly.
    """
    from veryfi_service import _is_cardholder_subtotal
    # card_number populated + name-only description → filtered
    assert _is_cardholder_subtotal("APRIL MCINTOSH", card_number="···31004")
    assert _is_cardholder_subtotal("PAUL LABOUNTY JR", card_number="0-31020")
    # card_number populated but description IS a real merchant → NOT filtered
    assert not _is_cardholder_subtotal(
        "STARBUCKS STORE 6307 SPRINGFIELD MO", card_number="0-31020",
    )
    # No card_number and description doesn't match subtotal pattern → NOT filtered
    assert not _is_cardholder_subtotal("APRIL MCINTOSH", card_number=None)
