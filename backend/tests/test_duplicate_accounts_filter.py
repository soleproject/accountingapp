"""Guards the Chart-of-Accounts duplicate detector against flagging the
system Uncategorized buckets (6999 Uncategorized Expense, 9999
Uncategorized Income) as duplicates. Those rows are seeded on purpose by
`categorizer.ensure_uncategorized_accounts` and merging them would
collapse the AI review queue into an unusable pot.
"""
from routes.accounts import _normalize_account_name


def test_all_uncategorized_variants_normalize_to_uncategorized():
    """The exclusion key in `find_duplicate_accounts` is the literal
    'uncategorized'. Every variant we've seen in the wild must normalize
    to that same key so the guard actually catches them."""
    for name in (
        "Uncategorized Expense",
        "Uncategorized Income",
        "Uncategorized",
        "Uncategorized Expenses",
        "UNCATEGORIZED EXPENSE",
        "  uncategorized  income  ",
    ):
        assert _normalize_account_name(name) == "uncategorized", name


def test_non_uncategorized_names_do_not_match():
    """Regression: make sure the guard doesn't accidentally swallow
    legitimately different account names that just happen to contain
    'uncategorized' as a substring."""
    assert _normalize_account_name("Uncategorized Rent") == "uncategorized rent"
    assert _normalize_account_name("Foo") == "foo"
