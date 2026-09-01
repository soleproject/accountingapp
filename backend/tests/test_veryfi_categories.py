"""Veryfi category → semantic mapping tests.

Locks in the curated `BANK_STATEMENT_CATEGORIES` list + the
`CATEGORY_TO_SEMANTIC` semantic mapping so future edits don't
accidentally break the Phase 2 auto-categorization path. All pure
data + regex lookups — no DB, no HTTP.

Phase A migration (Feb 2026): switched from code-only
(`CATEGORY_TO_CODE`) to semantic-based mapping so Veryfi rides
the same name-first `resolve_semantic_to_account` +
`ensure_semantic_account` chain the Plaid Directory stage uses.
The bar these tests enforce:

  1. Every category we send Veryfi maps to a semantic (or
     explicit None for movement/fallback buckets).
  2. Every semantic value MUST exist in
     `global_vendor_rules.SEMANTIC_TO_NAME_PATTERNS` (name-first
     resolver has patterns to match against).
  3. Every semantic value MUST exist in
     `canonical_semantic_accounts.CANONICAL_SEMANTIC_ACCOUNTS`
     (auto-create fallback has GAAP metadata).
  4. Movement buckets still return `is_movement=True` so Stage 0.4
     skips them (they route to bank/CC-liability instead of P&L).
"""
import sys, os
sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from veryfi_categories import (
    BANK_STATEMENT_CATEGORIES,
    CATEGORY_TO_SEMANTIC,
    semantic_for_category,
    is_movement,
)


def test_every_veryfi_category_is_mapped():
    """Every entry we send Veryfi must have an explicit mapping
    (even if that mapping is `None`). Missing keys would silently
    break the auto-book path."""
    for cat in BANK_STATEMENT_CATEGORIES:
        assert cat in CATEGORY_TO_SEMANTIC, f"{cat!r} sent to Veryfi but not mapped"


def test_no_orphan_mappings():
    """Every mapped category must also appear in the list we send —
    otherwise the mapping is dead code."""
    for cat in CATEGORY_TO_SEMANTIC:
        assert cat in BANK_STATEMENT_CATEGORIES, f"{cat!r} mapped but not sent"


def test_semantic_lookup_case_insensitive_and_whitespace_tolerant():
    assert semantic_for_category("Meals & Entertainment") == "meals"
    assert semantic_for_category(" Meals & Entertainment ") == "meals"
    assert semantic_for_category(None) is None
    assert semantic_for_category("") is None
    assert semantic_for_category("Not A Real Bucket") is None


def test_expense_buckets_map_to_expense_semantics():
    """Sanity spot-check: expense buckets go to expense semantics."""
    assert CATEGORY_TO_SEMANTIC["Advertising & Marketing"] == "marketing"
    assert CATEGORY_TO_SEMANTIC["Rent & Lease"] == "rent"
    assert CATEGORY_TO_SEMANTIC["Utilities"] == "utilities"
    assert CATEGORY_TO_SEMANTIC["Payroll Expenses"] == "payroll_expense"
    assert CATEGORY_TO_SEMANTIC["Insurance"] == "insurance"
    assert CATEGORY_TO_SEMANTIC["Interest Paid"] == "interest_expense"


def test_income_buckets_map_to_income_semantics():
    assert CATEGORY_TO_SEMANTIC["Income"] == "revenue_generic"
    assert CATEGORY_TO_SEMANTIC["Interest / Dividends"] == "interest_income"
    assert CATEGORY_TO_SEMANTIC["Refunds & Returns"] == "sales_refunds"


def test_cogs_maps_to_supplies_cogs():
    assert CATEGORY_TO_SEMANTIC["Cost of Goods Sold"] == "supplies_cogs"


def test_movement_buckets_never_book_to_pnl():
    # Movement buckets that must NEVER hit P&L — Stage 0.4 skips them
    # entirely so contact/rule engine (or a matched Plaid txn on the
    # paired account) does the linking.
    for cat in ("Transfer", "Credit Card Payment", "Check Deposit",
                 "Loan Payment"):
        assert is_movement(cat)
        # These are also intentionally None in the semantic map so
        # even a caller that forgets `is_movement` can't book them.
        assert CATEGORY_TO_SEMANTIC[cat] is None


def test_atm_and_owner_flows_book_to_equity_semantics():
    assert CATEGORY_TO_SEMANTIC["ATM Withdrawal"] == "owner_draw"
    assert CATEGORY_TO_SEMANTIC["Owner Draw"] == "owner_draw"
    assert CATEGORY_TO_SEMANTIC["Owner Contribution"] == "owner_contribution"


def test_fallbacks_return_none():
    assert CATEGORY_TO_SEMANTIC["Uncategorized Expense"] is None
    assert CATEGORY_TO_SEMANTIC["Ask My Accountant"] is None


# ---------------------------------------------------------------------------
# Cross-module contract: every semantic value must be resolvable AND
# creatable via the shared library — otherwise Stage 0.4 quietly drops
# rows into the LLM fallback (which is precisely what Phase A is
# meant to prevent).
# ---------------------------------------------------------------------------

def test_every_semantic_has_name_patterns():
    """Any semantic we route through must have at least one
    substring pattern in `SEMANTIC_TO_NAME_PATTERNS`, or the
    name-first resolver has nothing to match on."""
    from global_vendor_rules import SEMANTIC_TO_NAME_PATTERNS
    missing: list[str] = []
    for cat, sem in CATEGORY_TO_SEMANTIC.items():
        if sem is None:
            continue
        patterns = SEMANTIC_TO_NAME_PATTERNS.get(sem)
        if not patterns:
            missing.append(f"{cat!r} → {sem!r}")
    assert not missing, (
        f"Semantic(s) missing from SEMANTIC_TO_NAME_PATTERNS: {missing}"
    )


def test_every_semantic_has_canonical_account_metadata():
    """Any semantic we route through must have GAAP metadata in
    `CANONICAL_SEMANTIC_ACCOUNTS` so the auto-create fallback can
    seed the account with proper name/type/subtype/detail_type."""
    from canonical_semantic_accounts import CANONICAL_SEMANTIC_ACCOUNTS
    missing: list[str] = []
    for cat, sem in CATEGORY_TO_SEMANTIC.items():
        if sem is None:
            continue
        if sem not in CANONICAL_SEMANTIC_ACCOUNTS:
            missing.append(f"{cat!r} → {sem!r}")
    assert not missing, (
        f"Semantic(s) missing from CANONICAL_SEMANTIC_ACCOUNTS: {missing}"
    )


def test_canonical_metadata_has_valid_shape():
    """Every canonical entry we'll auto-create must have complete
    name/type/subtype/detail_type/code_by_template fields, else
    `ensure_semantic_account` will crash mid-insert."""
    from canonical_semantic_accounts import CANONICAL_SEMANTIC_ACCOUNTS
    valid_types = {"asset", "liability", "equity", "revenue",
                    "expense", "income"}
    for cat, sem in CATEGORY_TO_SEMANTIC.items():
        if sem is None:
            continue
        spec = CANONICAL_SEMANTIC_ACCOUNTS[sem]
        for key in ("name", "type", "subtype", "detail_type",
                     "code_by_template"):
            assert key in spec, f"{sem!r}: missing {key!r}"
        assert spec["type"] in valid_types, (
            f"{sem!r}: bad type {spec['type']!r}"
        )
        assert "generic" in spec["code_by_template"], (
            f"{sem!r}: code_by_template missing 'generic' fallback"
        )
