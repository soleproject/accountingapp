"""Regression tests for the sequential invoice numbering helper introduced
in Feb 2026. Guards against reverting to the legacy `INV-{random 4-digit}`
scheme, which caused non-monotonic numbers in list views.
"""
import re
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from routes.invoices import _next_invoice_number, _INV_NUM_RE


def _mock_db_with_numbers(numbers):
    """Return an async iterator that mimics `db.invoices.find(...)`
    yielding one doc per supplied invoice number."""
    docs = [{"number": n} for n in numbers]

    class _Cursor:
        def __aiter__(self):
            self._it = iter(docs)
            return self

        async def __anext__(self):
            try:
                return next(self._it)
            except StopIteration:
                raise StopAsyncIteration

    return _Cursor()


@pytest.mark.asyncio
async def test_returns_1001_when_no_prior_invoices():
    """Empty company → INV-1001 (friendly opening number, not INV-1)."""
    with patch("routes.invoices.db") as mdb:
        mdb.invoices.find = MagicMock(return_value=_mock_db_with_numbers([]))
        got = await _next_invoice_number("cid-x")
    assert got == "INV-1001"


@pytest.mark.asyncio
async def test_increments_from_highest_numeric_suffix():
    """Highest = 5162 → next is 5163, regardless of insertion order."""
    with patch("routes.invoices.db") as mdb:
        mdb.invoices.find = MagicMock(return_value=_mock_db_with_numbers([
            "INV-1234", "INV-5162", "INV-100", "INV-9967",
        ]))
        got = await _next_invoice_number("cid-x")
    assert got == "INV-9968"


@pytest.mark.asyncio
async def test_ignores_non_matching_numbers():
    """Bespoke customer schemes like '2026-Q1-001' must not break the
    scan (they simply don't factor into the sequence)."""
    with patch("routes.invoices.db") as mdb:
        mdb.invoices.find = MagicMock(return_value=_mock_db_with_numbers([
            "2026-Q1-001", "INV-42", "handwritten", "",
        ]))
        got = await _next_invoice_number("cid-x")
    # Only INV-42 is numeric — but our floor is 1001.
    assert got == "INV-1001"


@pytest.mark.asyncio
async def test_respects_higher_than_floor():
    """When the max exceeds the 1001 floor we always advance past it."""
    with patch("routes.invoices.db") as mdb:
        mdb.invoices.find = MagicMock(return_value=_mock_db_with_numbers([
            "INV-1500",
        ]))
        got = await _next_invoice_number("cid-x")
    assert got == "INV-1501"


def test_regex_matches_common_shapes():
    """The extractor should tolerate INV-, BILL-, plain digits, and
    reject shapes that would produce a bogus sequence."""
    assert _INV_NUM_RE.match("INV-1001").group("num") == "1001"
    assert _INV_NUM_RE.match("BILL-42").group("num") == "42"
    assert _INV_NUM_RE.match("1234").group("num") == "1234"
    assert _INV_NUM_RE.match("2026-Q1-001") is None
    assert _INV_NUM_RE.match("INV-abc") is None
