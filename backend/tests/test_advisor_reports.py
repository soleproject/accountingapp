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


def test_sum_by_type_skips_subtotals_and_missing_totals():
    is_data = {
        "revenue": [
            {"name": "Sales", "total": 5000.0},
            {"name": "Services", "total": 2500.0},
            {"name": "Subtotal", "total": 7500.0, "is_subtotal": True},
        ],
        "expenses": [
            {"name": "Rent", "total": 1000.0},
            {"name": "Salaries"},  # missing total → treated as 0
        ],
    }
    assert _sum_by_type(is_data, "revenue") == 7500.0
    assert _sum_by_type(is_data, "expenses") == 1000.0
    assert _sum_by_type(is_data, "cogs") == 0.0


def test_sum_by_type_handles_none():
    assert _sum_by_type(None, "revenue") == 0.0
    assert _sum_by_type({}, "expenses") == 0.0
    assert _sum_by_type({"revenue": None}, "revenue") == 0.0
