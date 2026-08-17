"""Region registry — the single source of truth for jurisdiction-aware
defaults. Every UK-specific behavior in the app (currency symbol, date
format, statutory report layout, tax engine, etc.) reads its config
from here so we never scatter magic strings across the codebase.

Phase 0 (Feb 2026): US + UK entries with currency, locale, and date
format only. Chart-of-accounts template + tax provider slots are
reserved for Phase 1/2; kept `None` here so callers can `if x is
None: skip` without special-casing per-region.

Invariant: `US` MUST always exist, `US` MUST always be the fallback
when a caller passes an unknown region. Every existing US customer
depends on this — see test_region_defaults.py for the regression
lock-in.
"""
from __future__ import annotations

from typing import Literal, TypedDict


RegionCode = Literal["US", "UK"]


class RegionSpec(TypedDict):
    code: RegionCode
    display_name: str
    currency: str          # ISO 4217
    currency_symbol: str
    locale: str            # BCP 47
    date_format: str       # display-only token; frontend uses this
    fiscal_year_convention: str  # informational; not enforced yet
    # Reserved for Phase 1/2 — kept as None so lookups don't KeyError
    # while we're still on Phase 0.
    coa_template: str | None
    tax_provider: str | None


REGIONS: dict[RegionCode, RegionSpec] = {
    "US": {
        "code": "US",
        "display_name": "United States",
        "currency": "USD",
        "currency_symbol": "$",
        "locale": "en-US",
        "date_format": "MM/DD/YYYY",
        "fiscal_year_convention": "calendar",
        "coa_template": "us_gaap_default",
        "tax_provider": "us_sales_tax",
    },
    "UK": {
        "code": "UK",
        "display_name": "United Kingdom",
        "currency": "GBP",
        "currency_symbol": "£",
        "locale": "en-GB",
        "date_format": "DD/MM/YYYY",
        "fiscal_year_convention": "company_defined",  # UK companies pick their own
        "coa_template": None,   # Phase 1 lands "frs_102_small"
        "tax_provider": None,   # Phase 2 lands "uk_vat"
    },
}


def get(code: str | None) -> RegionSpec:
    """Look up a region by code, US-safe fallback. Anything unknown
    (None, empty string, garbled input) resolves to US so we never
    accidentally serve a UK-only path to a legacy company that
    predates the `region` field."""
    if not code:
        return REGIONS["US"]
    return REGIONS.get(code.upper(), REGIONS["US"])  # type: ignore[arg-type]


def defaults_for(code: str | None) -> dict:
    """Return the three fields we persist on `companies` at creation
    time given a region code. Kept as a dict (not the TypedDict)
    because it's meant to be spread into `insert_one`."""
    spec = get(code)
    return {
        "region": spec["code"],
        "currency": spec["currency"],
        "date_format": spec["date_format"],
    }
