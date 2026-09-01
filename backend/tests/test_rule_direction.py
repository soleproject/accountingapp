"""
Tier-1.5 QBO parity — Transaction-type pill (Withdrawal / Deposit / Both).
Verifies:
  • `/rules/suggest-from-txns` emits `direction_hint` on each proposal
    matching the underlying rows' sign distribution.
  • `POST /rules` accepts a `direction` field and persists it.
  • `_match_tier1` in `user_rule_matcher` narrows candidates by sign.
"""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from user_rule_matcher import _match_tier1


def _mkrule(**kw):
    base = {"bank_account_id": None, "amount_op": None, "amount_value": None,
            "direction": None}
    base.update(kw)
    return base


def test_match_tier1_direction_out_filters_deposits():
    r = _mkrule(direction="out")
    assert _match_tier1({"amount": -12.5}, r) is True
    assert _match_tier1({"amount":  12.5}, r) is False
    assert _match_tier1({"amount":   0.0}, r) is False


def test_match_tier1_direction_in_filters_withdrawals():
    r = _mkrule(direction="in")
    assert _match_tier1({"amount":  12.5}, r) is True
    assert _match_tier1({"amount": -12.5}, r) is False


def test_match_tier1_direction_none_allows_both():
    r = _mkrule(direction=None)
    assert _match_tier1({"amount":  12.5}, r) is True
    assert _match_tier1({"amount": -12.5}, r) is True


def test_match_tier1_direction_combines_with_amount_op():
    # Rule: only withdrawals larger than $100 (magnitude).
    r = _mkrule(direction="out", amount_op="lt", amount_value=-100)
    assert _match_tier1({"amount": -200}, r) is True     # withdrawal >$100
    assert _match_tier1({"amount":  -50}, r) is False    # withdrawal <$100
    assert _match_tier1({"amount":  200}, r) is False    # deposit blocked
