"""Regression tests for the multi-account statement iterator.

Guards the invariant that a combined Veryfi statement (Wells Fargo
Combined, Amex Blue + Gold, Chase Checking + Savings) is split into
one sub-doc per account, preserving per-account balances/period so
downstream `statement_account_resolver._statement_fields` picks each
one up as if it were its own single-account statement.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import dotenv_values
_env = dotenv_values(str(Path(__file__).resolve().parent.parent / ".env"))
for k in ("MONGO_URL", "DB_NAME", "VERYFI_CLIENT_ID", "VERYFI_USERNAME",
          "VERYFI_API_KEY", "VERYFI_CLIENT_SECRET"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from veryfi_service import iter_statement_accounts  # noqa: E402
import statement_account_resolver as sar  # noqa: E402


def test_single_account_returns_one_group():
    doc = {
        "bank_name": "Chase",
        "accounts": [{
            "number": "1234", "account_type": "checking",
            "beginning_balance": 1000, "ending_balance": 1200,
            "transactions": [
                {"date": "2026-01-15", "description": "PAYCHECK", "credit_amount": 200},
            ],
        }],
    }
    groups = iter_statement_accounts(doc)
    assert len(groups) == 1
    assert len(groups[0]["lines"]) == 1


def test_multi_account_fans_out_per_account():
    doc = {
        "bank_name": "Wells Fargo",
        "accounts": [
            {"number": "6084", "account_type": "checking",
             "beginning_balance": 5000, "ending_balance": 5200,
             "transactions": [
                 {"date": "2026-01-10", "description": "PAYROLL", "credit_amount": 200}]},
            {"number": "9911", "account_type": "savings",
             "beginning_balance": 12000, "ending_balance": 12005,
             "transactions": [
                 {"date": "2026-01-15", "description": "INTEREST", "credit_amount": 5}]},
            {"number": "4477", "account_type": "credit_card",
             "beginning_balance": 800, "ending_balance": 950,
             "transactions": [
                 {"date": "2026-01-05", "description": "AMAZON", "debit_amount": 150}]},
        ],
        "period_start_date": "2026-01-01",
        "period_end_date": "2026-01-31",
    }
    groups = iter_statement_accounts(doc)
    assert len(groups) == 3

    # Each sub-doc must resolve as its own single-account statement.
    types = []
    for g in groups:
        f = sar._statement_fields(g["account_ref"])
        types.append((f["account_type"], f["last4"], f["starting_balance"], f["ending_balance"]))
        # Period is propagated to every sub-doc.
        assert f["period_start"] == "2026-01-01"
        assert f["period_end"] == "2026-01-31"
    assert types == [
        ("checking",    "6084", 5000, 5200),
        ("savings",     "9911", 12000, 12005),
        ("credit_card", "4477", 800, 950),
    ]

    # Lines are correctly partitioned per account (1 each).
    assert [len(g["lines"]) for g in groups] == [1, 1, 1]
    # And the right line landed in the right group.
    assert "PAYROLL"  in groups[0]["lines"][0]["description"]
    assert "INTEREST" in groups[1]["lines"][0]["description"]
    assert "AMAZON"   in groups[2]["lines"][0]["description"]


def test_no_accounts_falls_back_to_top_level():
    doc = {
        "transactions": [
            {"date": "2026-01-10", "description": "OLD SHAPE", "credit_amount": 100},
        ],
    }
    groups = iter_statement_accounts(doc)
    assert len(groups) == 1
    assert len(groups[0]["lines"]) == 1
    assert "OLD SHAPE" in groups[0]["lines"][0]["description"]


def test_bank_name_inherited_from_top_level():
    """When a per-account entry lacks bank_name, it inherits the top-level
    bank name so the resolver still matches the correct institution."""
    doc = {
        "bank_name": "Wells Fargo",
        "accounts": [
            {"number": "6084", "account_type": "checking",
             "beginning_balance": 100, "ending_balance": 100,
             "transactions": []},
        ],
    }
    groups = iter_statement_accounts(doc)
    fields = sar._statement_fields(groups[0]["account_ref"])
    assert fields["bank_name"] == "Wells Fargo"
