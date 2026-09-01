"""Veryfi category catalog + semantic mapping (Phase A).

Veryfi's Bank Statements API accepts a `categories=[...]` array in
the POST body — the AI picks the closest match from whatever list
we supply and stamps `category` on every transaction. This module
holds our curated list (bookkeeping-first, hybrid COA + movement
buckets — see Feb 2026 research thread) and the mapping from each
category name to the SEMANTIC KEY used by the shared
`global_vendor_rules.resolve_semantic_to_account` +
`canonical_semantic_accounts.ensure_semantic_account` chain that
the Plaid Directory stage already uses.

Why semantics (not codes):
  * A company's CoA may not have codes at all, or may renumber
    them (7205 = "Interest Expense" instead of 6110).
  * Two accounts on the same CoA may share a code range with
    different meanings — e.g. code 6400 = "Insurance" on one CoA,
    "Meals" on another. The Feb 2026 "Domino's in Insurance" bug
    proved that code-only mapping is unsafe.
  * Semantic-first matching resolves "Meals" ≡ "Meals &
    Entertainment" ≡ "Client Meals" ≡ "Team Meals" all to the same
    canonical bucket, whatever the CoA happens to name it.

Fallback chain when Stage 0.4 fires on a Veryfi row:
  1. `resolve_semantic_to_account(semantic, coa)` — substring
     match against the company's actual account names, most-
     specific first.
  2. `ensure_semantic_account(db, cid, semantic, template)` —
     idempotently auto-create the account using the canonical
     GAAP name/type/subtype/detail_type + tax-line metadata
     baked into `canonical_semantic_accounts.py`. Never
     duplicates: if a name-collision account already exists
     from a different codepath (QBO import, manual entry) that
     wins.

Movement buckets (Transfer / Credit Card Payment / Loan Payment /
Check Deposit) intentionally return NO semantic — they must never
hit P&L. The caller pairs them with the linked bank / CC-liability
account instead.
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
# Veryfi category → semantic key.
#
# `None` means "do not auto-book" — the caller either routes to the
# paired bank/CC-liability account (movement buckets), or defers to
# the AI stage entirely (Uncategorized / Ask My Accountant).
#
# Every non-None value MUST exist in
# `global_vendor_rules.SEMANTIC_TO_NAME_PATTERNS` and
# `canonical_semantic_accounts.CANONICAL_SEMANTIC_ACCOUNTS`, so
# the resolver → auto-create chain always finds (or creates) an
# account. `test_veryfi_categories.py` locks this contract.
# ---------------------------------------------------------------------------

CATEGORY_TO_SEMANTIC: dict[str, Optional[str]] = {
    # COA expenses
    "Advertising & Marketing":       "marketing",
    "Automotive":                    "automotive",
    "Bank Charges & Fees":           "bank_fees",
    "Contractors":                   "professional_fees",
    "Cost of Goods Sold":            "supplies_cogs",
    "Dues & Subscriptions":          "software_saas",
    "Equipment":                     "equipment",
    "Insurance":                     "insurance",
    "Interest Paid":                 "interest_expense",
    "Job Supplies":                  "job_supplies",
    "Legal & Professional Services": "professional_fees",
    "Meals & Entertainment":         "meals",
    "Office Supplies & Software":    "office_supplies",
    "Payroll Expenses":              "payroll_expense",
    "Rent & Lease":                  "rent",
    "Repairs & Maintenance":         "repairs_maintenance",
    "Taxes & Licenses":              "licenses_permits",
    "Travel":                        "travel",
    "Utilities":                     "utilities",

    # Income
    "Income":                        "revenue_generic",
    "Interest / Dividends":          "interest_income",
    "Refunds & Returns":             "sales_refunds",

    # Movement — never P&L. Caller books to the paired bank / CC
    # liability account, or leaves for the AI to sort out.
    "Transfer":                      None,
    "ATM Withdrawal":                "owner_draw",
    "Credit Card Payment":           None,
    "Check Deposit":                 None,
    "Loan Payment":                  None,
    "Owner Contribution":            "owner_contribution",
    "Owner Draw":                    "owner_draw",

    # Fallbacks — don't book, defer to AI.
    "Uncategorized Expense":         None,
    "Ask My Accountant":             None,
}


def semantic_for_category(category: str | None) -> Optional[str]:
    """Case-insensitive lookup with whitespace tolerance."""
    if not category:
        return None
    return (CATEGORY_TO_SEMANTIC.get(category)
            or CATEGORY_TO_SEMANTIC.get(category.strip())
            or None)


def is_movement(category: str | None) -> bool:
    """True for buckets that must not touch a P&L account
    (Transfer, Credit Card Payment, Check Deposit, Loan Payment)."""
    return category in {"Transfer", "Credit Card Payment",
                         "Check Deposit", "Loan Payment"}


def semantic_matches_sign(semantic: str | None, amount: float) -> bool:
    """Sanity check: does the semantic's expected direction match the
    transaction's amount sign? Used by Stage 0.4 to veto obvious
    Veryfi hallucinations before booking them to the wrong side of
    the P&L.

    Convention: amount > 0 = money in (credit), amount < 0 = money out
    (debit). Works uniformly for bank checking (deposits are +) AND
    credit cards (charges are stored as -, refunds/payments as +).

    Rules:
      * Expense semantic + positive amount → mismatch
        (INTUIT deposit tagged "Interest Paid" by Veryfi — reject,
        defer to Directory / LLM which will correctly identify as
        income).
      * Income semantic + negative amount → mismatch
        (rare — Veryfi labelling an outbound charge as "Income" —
        also reject).
      * Equity / asset / liability semantics → sign-agnostic
        (owner_draw / owner_contribution can flow either way
        depending on the counterparty; skip the check).

    Returns True when it's SAFE to book, False when the semantic
    should be vetoed.
    """
    if not semantic:
        return True                                             # nothing to check
    try:
        from canonical_semantic_accounts import CANONICAL_SEMANTIC_ACCOUNTS
    except Exception:                                           # import fail → don't block ingest
        return True
    spec = CANONICAL_SEMANTIC_ACCOUNTS.get(semantic)
    if not spec:
        return True                                             # unknown semantic — let it through
    typ = spec.get("type")
    if typ == "expense":
        # Expenses should be money-OUT (amount < 0). A tiny epsilon
        # tolerance keeps zero-dollar wash rows from tripping the
        # veto.
        return amount < 1e-6
    if typ in ("income", "revenue"):
        return amount > -1e-6
    # Equity / asset / liability: sign is contextual, let it stand.
    return True
