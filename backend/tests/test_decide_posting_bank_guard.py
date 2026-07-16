"""Regression: `decide_posting` must reject any category returned by the LLM
that is a bank/cash asset account (code 10xx). Otherwise the LLM will happily
categorize an "Online Banking transfer to CHK 6278" as bank code 1010,
producing a self-cancelling JE that inflates the ledger balance.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import categorizer


def _accts_fixture():
    """Minimal COA with bank + expense + uncat accounts."""
    return [
        {"id": "bank-1010", "code": "1010", "name": "Business Checking",
         "type": "asset", "subtype": "current_asset"},
        {"id": "bank-1020", "code": "1020", "name": "Business Savings",
         "type": "asset", "subtype": "current_asset"},
        {"id": "cash-1000", "code": "1000", "name": "Cash and Bank",
         "type": "asset", "subtype": "current_asset"},
        {"id": "meals-6000", "code": "6000", "name": "Meals",
         "type": "expense", "subtype": "operating_expense"},
        {"id": "uncat-6999", "code": "6999", "name": "Uncategorized Expense",
         "type": "expense", "subtype": "operating_expense"},
        {"id": "uncat-4999", "code": "4999", "name": "Uncategorized Income",
         "type": "revenue", "subtype": "operating_revenue"},
    ]


UNCAT_EXP = {"id": "uncat-6999", "code": "6999", "name": "Uncategorized Expense"}
UNCAT_INC = {"id": "uncat-4999", "code": "4999", "name": "Uncategorized Income"}


def test_llm_pick_of_bank_1010_routed_to_uncategorized():
    """LLM claims a withdrawal is 'Business Checking' (1010) with 0.95 conf →
    must be rejected because 1010 is a bank asset."""
    result = {
        "account_code": "1010", "confidence": 0.95,
        "reasoning": "Online transfer to another checking",
    }
    out = categorizer.decide_posting(
        result, threshold=0.8, uncat_exp=UNCAT_EXP, uncat_inc=UNCAT_INC,
        accts=_accts_fixture(), amount=-500.0,
    )
    assert out["ai_source"] == "uncategorized"
    assert out["category_account_code"] == "6999"     # expense bucket
    assert out["needs_review"] is True
    assert "bank/cash" in out["ai_reasoning"].lower()


def test_llm_pick_of_savings_1020_also_rejected():
    """Same guard applies to any 10xx account, not just the exact bank leg."""
    result = {"account_code": "1020", "confidence": 0.9, "reasoning": ""}
    out = categorizer.decide_posting(
        result, 0.8, UNCAT_EXP, UNCAT_INC, _accts_fixture(), amount=1000.0,
    )
    assert out["ai_source"] == "uncategorized"
    assert out["category_account_code"] == "4999"     # income bucket (positive amt)
    assert out["needs_review"] is True


def test_llm_pick_of_cash_1000_rejected():
    """Cash 1000 also 4-digit + starts with 10 — must be rejected."""
    result = {"account_code": "1000", "confidence": 0.9, "reasoning": ""}
    out = categorizer.decide_posting(
        result, 0.8, UNCAT_EXP, UNCAT_INC, _accts_fixture(), amount=-25.0,
    )
    assert out["ai_source"] == "uncategorized"


def test_legitimate_expense_still_passes():
    """A normal Meals 6000 pick with high confidence flows through untouched."""
    result = {"account_code": "6000", "confidence": 0.92,
              "reasoning": "Coffee shop"}
    out = categorizer.decide_posting(
        result, 0.8, UNCAT_EXP, UNCAT_INC, _accts_fixture(), amount=-5.75,
    )
    assert out["category_account_code"] == "6000"
    assert out["ai_source"] == "ai"                    # LLM path (no cache_hit)
    assert out["needs_review"] is False


def test_five_digit_code_starting_with_10_not_rejected():
    """The guard is intentionally narrow: `starts with '10' AND len == 4`.
    A 5-digit code like 10500 is NOT a bank account by convention.
    """
    accts = _accts_fixture() + [
        {"id": "special-10500", "code": "10500", "name": "Special Sub-account",
         "type": "expense", "subtype": "operating_expense"},
    ]
    result = {"account_code": "10500", "confidence": 0.9, "reasoning": ""}
    out = categorizer.decide_posting(
        result, 0.8, UNCAT_EXP, UNCAT_INC, accts, amount=-25.0,
    )
    assert out["category_account_code"] == "10500"    # not rejected
    assert out["ai_source"] == "ai"
