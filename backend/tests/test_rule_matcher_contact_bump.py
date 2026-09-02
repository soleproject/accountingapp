"""
Regression: Contact-keyed rules get a +3 specificity bump so they beat
plain merchant regexes when both match the same row, but still lose to
targeted merchant rules that layer on direction/amount/bank filters.
Tier-3 `priority` still trumps all specificity.

Bug context (Feb 2026): CPAs think in entities. A contact-keyed rule is
a stronger declaration of intent than a bare merchant regex (often
auto-generated from an ingest quirk). Without the bump, both scored 1
and the loop order picked the winner.
"""
from __future__ import annotations
import sys
sys.path.insert(0, "/app/backend")

from user_rule_matcher import match_and_build_post  # noqa: E402


def _accts():
    return [
        {"id": "a1", "code": "6300", "name": "Office Supplies"},
        {"id": "a2", "code": "4200", "name": "Refunds"},
        {"id": "a3", "code": "1500", "name": "Fixed Assets"},
    ]


def _cand(**overrides):
    base = {
        "merchant":    "WALMART SUPERCENTER",
        "description": "walmart",
        "amount":      -15.0,
        "contact_id":  "c-walmart",
    }
    base.update(overrides)
    return base


def test_contact_rule_beats_bare_merchant_regex():
    """Both match; contact rule (score 4) beats merchant regex (score 1)."""
    rules = [
        {"id": "r-merchant", "match_field": "merchant",
         "match_value": "walmart", "account_code": "6300"},
        {"id": "r-contact", "match_field": "contact",
         "match_value": "c-walmart", "account_code": "6300"},
    ]
    hit = match_and_build_post(_cand(), rules, _accts())
    assert hit is not None
    assert hit["rule_id"] == "r-contact"


def test_targeted_merchant_rule_beats_plain_contact_rule():
    """Merchant rule with direction + amount_op (score 1+1+2=4) beats
    plain contact rule (score 4). Ties break by _specificity's second
    return value + insertion order — but here we want merchant to win
    on a *deposit* where the merchant rule has direction=in.
    """
    rules = [
        {"id": "r-contact", "match_field": "contact",
         "match_value": "c-walmart", "account_code": "6300"},
        {"id": "r-merchant-targeted", "match_field": "merchant",
         "match_value": "walmart", "account_code": "4200",
         "direction": "in", "amount_op": "gt", "amount_value": 5},
    ]
    # Deposit of $50 — matches both, but merchant rule is more specific
    # once you count direction + amount_op filters (score 1+1+2=4 vs
    # contact's 4). We nudge merchant ahead by one more extra to
    # unambiguously test the targeted-wins case.
    rules[1]["extra_conditions"] = [
        {"field": "description", "op": "contains", "value": "walmart"},
    ]
    hit = match_and_build_post(
        _cand(amount=50.0, description="walmart"), rules, _accts(),
    )
    assert hit is not None
    assert hit["rule_id"] == "r-merchant-targeted"


def test_no_contact_falls_back_to_merchant():
    """Contact resolution failed upstream (contact_id=None); contact
    rule can't fire, merchant rule still does."""
    rules = [
        {"id": "r-contact", "match_field": "contact",
         "match_value": "c-walmart", "account_code": "6300"},
        {"id": "r-merchant", "match_field": "merchant",
         "match_value": "walmart", "account_code": "6300"},
    ]
    hit = match_and_build_post(_cand(contact_id=None), rules, _accts())
    assert hit is not None
    assert hit["rule_id"] == "r-merchant"


def test_cpa_priority_overrides_contact_bump():
    """Tier-3 priority still trumps everything — a CPA-set priority=100
    on the merchant rule wins even against a contact rule."""
    rules = [
        {"id": "r-contact", "match_field": "contact",
         "match_value": "c-walmart", "account_code": "6300"},
        {"id": "r-merchant-priority", "match_field": "merchant",
         "match_value": "walmart", "account_code": "1500",
         "priority": 100},
    ]
    hit = match_and_build_post(_cand(), rules, _accts())
    assert hit is not None
    assert hit["rule_id"] == "r-merchant-priority"
