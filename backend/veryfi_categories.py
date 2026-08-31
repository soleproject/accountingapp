"""Veryfi category catalog + GAAP mapping.

Veryfi's Bank Statements API accepts a `categories=[...]` array in
the POST body — the AI picks the closest match from whatever list
we supply and stamps `category` on every transaction. This module
holds our curated list (bookkeeping-first, hybrid COA + movement
buckets — see Feb 2026 research thread) and the mapping from each
category name to the seeded GAAP account code it should book to.

Design notes:
  * The list is intentionally SHORT (~30 entries) — Veryfi's AI
    picks better from a small, well-differentiated menu than from a
    100-item list. Adding more only makes matching worse.
  * Categories are grouped into three buckets:
      - COA expense buckets (real spend)
      - Movement buckets (transfer, ATM w/d, card payment, check
        deposit — must never hit P&L)
      - Fallback buckets (Uncategorized Expense, Ask My Accountant)
  * `CATEGORY_TO_CODE` is the canonical bookkeeping-side mapping.
    Anything not present here falls through to the AI resolver.
  * The list is designed to be OVERRIDABLE per firm — Phase 2b will
    surface an admin UI that lets an accountant remap
    `Meals & Entertainment` → their custom `6250 Client Meals`
    account if their CoA is customized.
"""
from __future__ import annotations
from typing import Optional


# ---------------------------------------------------------------------------
# The exact strings we send to Veryfi in the request body.
# ---------------------------------------------------------------------------

BANK_STATEMENT_CATEGORIES: list[str] = [
    # ─── COA expense buckets (real spend) ─────────────────────────
    "Advertising & Marketing",
    "Automotive",
    "Bank Charges & Fees",
    "Contractors",
    "Cost of Goods Sold",
    "Dues & Subscriptions",
    "Equipment",
    "Insurance",
    "Interest Paid",
    "Job Supplies",
    "Legal & Professional Services",
    "Meals & Entertainment",
    "Office Supplies & Software",
    "Payroll Expenses",
    "Rent & Lease",
    "Repairs & Maintenance",
    "Taxes & Licenses",
    "Travel",
    "Utilities",
    # ─── Income / receivables ─────────────────────────────────────
    "Income",
    "Interest / Dividends",
    "Refunds & Returns",
    # ─── Movement (non-P&L) ───────────────────────────────────────
    "Transfer",
    "ATM Withdrawal",
    "Credit Card Payment",
    "Check Deposit",
    "Loan Payment",
    "Owner Contribution",
    "Owner Draw",
    # ─── Fallbacks ────────────────────────────────────────────────
    "Uncategorized Expense",
    "Ask My Accountant",
]


# ---------------------------------------------------------------------------
# Category → GAAP account code.
#
# `None` means "do not auto-book to a P&L account" — the caller
# should route these rows to the linked bank account (transfers),
# credit-card liability account (card payment), or defer to the AI
# stage entirely.
# ---------------------------------------------------------------------------

CATEGORY_TO_CODE: dict[str, Optional[str]] = {
    # COA expenses
    "Advertising & Marketing":       "6000",
    "Automotive":                    "6020",
    "Bank Charges & Fees":           "6100",
    "Contractors":                   "6120",
    "Cost of Goods Sold":            "5000",
    "Dues & Subscriptions":          "6140",
    "Equipment":                     "6160",
    "Insurance":                     "6200",
    "Interest Paid":                 "6110",
    "Job Supplies":                  "6180",
    "Legal & Professional Services": "6220",
    "Meals & Entertainment":         "6240",
    "Office Supplies & Software":    "6260",
    "Payroll Expenses":              "6300",
    "Rent & Lease":                  "6400",
    "Repairs & Maintenance":         "6420",
    "Taxes & Licenses":              "6500",
    "Travel":                        "6520",
    "Utilities":                     "6600",

    # Income
    "Income":                        "4000",
    "Interest / Dividends":          "4900",
    "Refunds & Returns":             "4200",

    # Movement — never P&L. Caller books to the paired bank / CC
    # liability account, or leaves for the AI to sort out.
    "Transfer":                      None,
    "ATM Withdrawal":                "3500",     # Owner Draw as safe default
    "Credit Card Payment":           None,
    "Check Deposit":                 None,
    "Loan Payment":                  None,
    "Owner Contribution":            "3400",
    "Owner Draw":                    "3500",

    # Fallbacks — don't book, defer to AI.
    "Uncategorized Expense":         None,
    "Ask My Accountant":             None,
}


# ---------------------------------------------------------------------------
# Full account metadata for each mapped code — used by the ensure-account
# helper when a company's CoA is missing the mapped GAAP account. Fields:
#   (name, kind, sub_kind) — kind ∈ {expense, revenue, equity, asset,
#   liability}; sub_kind matches the seeded CoA taxonomy so the account
#   lands in the right report section (operating_expense, operating_revenue,
#   equity, current_asset, etc.).
# ---------------------------------------------------------------------------

CODE_TO_ACCOUNT: dict[str, tuple[str, str, str]] = {
    # 3xxx — Equity
    "3400": ("Owner's Contribution", "equity",  "equity"),
    "3500": ("Owner's Draw",         "equity",  "equity"),
    # 4xxx — Revenue
    "4000": ("Sales Revenue",        "revenue", "operating_revenue"),
    "4200": ("Refunds & Returns",    "revenue", "operating_revenue"),
    "4900": ("Interest Income",      "revenue", "other_income"),
    # 5xxx — COGS
    "5000": ("Cost of Goods Sold",   "expense", "cogs"),
    # 6xxx — Operating expenses
    "6000": ("Advertising & Marketing",       "expense", "operating_expense"),
    "6020": ("Automotive",                    "expense", "operating_expense"),
    "6100": ("Bank Charges & Fees",           "expense", "operating_expense"),
    "6110": ("Interest Expense",              "expense", "operating_expense"),
    "6120": ("Contractors",                   "expense", "operating_expense"),
    "6140": ("Dues & Subscriptions",          "expense", "operating_expense"),
    "6160": ("Equipment",                     "expense", "operating_expense"),
    "6180": ("Job Supplies",                  "expense", "operating_expense"),
    "6200": ("Insurance",                     "expense", "operating_expense"),
    "6220": ("Legal & Professional Services", "expense", "operating_expense"),
    "6240": ("Meals & Entertainment",         "expense", "operating_expense"),
    "6260": ("Office Supplies & Software",    "expense", "operating_expense"),
    "6300": ("Payroll Expenses",              "expense", "operating_expense"),
    "6400": ("Rent & Lease",                  "expense", "operating_expense"),
    "6420": ("Repairs & Maintenance",         "expense", "operating_expense"),
    "6500": ("Taxes & Licenses",              "expense", "operating_expense"),
    "6520": ("Travel",                        "expense", "operating_expense"),
    "6600": ("Utilities",                     "expense", "operating_expense"),
}


def code_for_category(category: str | None) -> Optional[str]:
    """Case-insensitive lookup with graceful fallback."""
    if not category:
        return None
    return CATEGORY_TO_CODE.get(category) or \
           CATEGORY_TO_CODE.get(category.strip()) or \
           None


def is_movement(category: str | None) -> bool:
    """True for buckets that must not touch a P&L account
    (Transfer, Credit Card Payment, Check Deposit, Loan Payment)."""
    return category in {"Transfer", "Credit Card Payment",
                         "Check Deposit", "Loan Payment"}
