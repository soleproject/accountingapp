"""Veryfi native-categorization mapping tests.

Locks in the curated `BANK_STATEMENT_CATEGORIES` list + the
`CATEGORY_TO_CODE` GAAP mapping so future edits don't accidentally
break the Phase 2 auto-categorization path. All pure data + regex
lookups — no DB, no HTTP.
"""
from veryfi_categories import (
    BANK_STATEMENT_CATEGORIES,
    CATEGORY_TO_CODE,
    code_for_category,
    is_movement,
)


def test_categories_and_mapping_stay_in_sync():
    """Every category we send Veryfi must have an explicit mapping
    (even if that mapping is `None` meaning 'defer to AI'). Missing
    keys would silently break the auto-book path once Veryfi is
    enabled."""
    for cat in BANK_STATEMENT_CATEGORIES:
        assert cat in CATEGORY_TO_CODE, f"{cat!r} sent to Veryfi but not mapped"


def test_no_orphan_mappings():
    """Every mapped category must also appear in the list we send —
    otherwise the mapping is dead code."""
    for cat in CATEGORY_TO_CODE:
        assert cat in BANK_STATEMENT_CATEGORIES, f"{cat!r} mapped but not sent"


def test_code_lookup_case_insensitive_and_whitespace_tolerant():
    assert code_for_category("Meals & Entertainment") == "6240"
    assert code_for_category(" Meals & Entertainment ") == "6240"
    assert code_for_category(None) is None
    assert code_for_category("") is None
    assert code_for_category("Not A Real Bucket") is None


def test_expense_buckets_map_to_6xxx():
    for cat in ("Advertising & Marketing", "Rent & Lease", "Utilities",
                 "Payroll Expenses", "Insurance"):
        code = CATEGORY_TO_CODE[cat]
        assert code and code.startswith("6"), f"{cat} should map to a 6xxx account"


def test_income_buckets_map_to_4xxx():
    for cat in ("Income", "Interest / Dividends", "Refunds & Returns"):
        code = CATEGORY_TO_CODE[cat]
        assert code and code.startswith("4"), f"{cat} should map to a 4xxx account"


def test_cogs_maps_to_5000():
    assert CATEGORY_TO_CODE["Cost of Goods Sold"] == "5000"


def test_movement_buckets_never_book_to_pnl():
    # Movement buckets that must NEVER hit P&L — Stage 0.4 skips them
    # entirely so contact/rule engine (or a matched Plaid txn on the
    # paired account) does the linking.
    for cat in ("Transfer", "Credit Card Payment", "Check Deposit",
                 "Loan Payment"):
        assert is_movement(cat)
        # ATM Withdrawal is a "soft" movement — book to Owner Draw as
        # safe default, still classified via the code path.
        assert CATEGORY_TO_CODE[cat] is None


def test_atm_and_owner_draw_book_to_equity():
    # ATM w/d is not a P&L category — it lands in Owner Draw (equity).
    assert CATEGORY_TO_CODE["ATM Withdrawal"] == "3500"
    assert CATEGORY_TO_CODE["Owner Draw"] == "3500"
    assert CATEGORY_TO_CODE["Owner Contribution"] == "3400"


def test_fallbacks_return_none():
    assert CATEGORY_TO_CODE["Uncategorized Expense"] is None
    assert CATEGORY_TO_CODE["Ask My Accountant"] is None
