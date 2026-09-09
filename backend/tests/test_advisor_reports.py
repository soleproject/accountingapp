"""Advisor Reports — pure-logic tests for the aggregation + PDF assembly.

The PDF generator + LLM narrative path are exercised via the live smoke
tests. Here we lock in the deterministic scaffolding — period
arithmetic, KPI derivation, and the section-sum helper.
"""
import pytest

from routes.advisor_reports import (
    _period_bounds, _prev_period, _sum_by_type,
)


def test_period_bounds_regular_month():
    assert _period_bounds("2026-02") == ("2026-02-01", "2026-02-28")
    assert _period_bounds("2026-01") == ("2026-01-01", "2026-01-31")


def test_period_bounds_leap_year():
    assert _period_bounds("2024-02") == ("2024-02-01", "2024-02-29")


def test_prev_period_wraps_year():
    assert _prev_period("2026-01") == "2025-12"
    assert _prev_period("2026-06") == "2026-05"


def test_sum_by_type_prefers_precomputed_totals():
    """`reports.py` puts leaf amounts on `.amount` (not `.total`) and
    pre-computes `total_revenue` / `total_expense` at the top level.
    Regression guard for the 2026-03 bug where the PDF rendered $0 for
    every line + wrong section totals because we read the wrong keys."""
    is_data = {
        "revenue": [
            {"name": "Service Revenue", "amount": 750.0},
            {"name": "Product Sales", "amount": 12901.95},
        ],
        "total_revenue": 13651.95,
        "expenses": [
            {"name": "Meals", "amount": 675.54},
            {"name": "Rent", "amount": 5634.61},
        ],
        "total_expense": 6310.15,
    }
    assert _sum_by_type(is_data, "revenue") == 13651.95
    assert _sum_by_type(is_data, "expenses") == 6310.15
    assert _sum_by_type(is_data, "cogs") == 0.0


def test_sum_by_type_fallback_uses_amount_not_total():
    """If pre-computed section total is missing, fall back to summing
    leaf `.amount` values. `.total` fallback preserved for older
    call-sites but `.amount` wins."""
    is_data = {
        "revenue": [
            {"name": "Sales", "amount": 5000.0},
            {"name": "Services", "amount": 2500.0},
            {"name": "Rollup", "amount": 7500.0, "is_subtotal": True},
        ],
    }
    assert _sum_by_type(is_data, "revenue") == 7500.0  # skips is_subtotal


def test_sum_by_type_handles_none():
    assert _sum_by_type(None, "revenue") == 0.0
    assert _sum_by_type({}, "expenses") == 0.0
    assert _sum_by_type({"revenue": None}, "revenue") == 0.0
