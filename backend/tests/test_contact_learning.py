"""
Contact learning module — mines the CPA's approved history for a
contact and applies the majority category. Feb 2026.

Locks in:
  * Fires when sample ≥3 and majority ≥80%.
  * Abstains when sample is too small.
  * Abstains when the sample is split (below 80% majority).
  * Ignores parked / uncategorized codes in the signal count.
  * `is_weak_merchant_rule` correctly classifies rules.
"""
from __future__ import annotations
import sys
sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from contact_learning import (  # noqa: E402
    get_learned_category,
    is_weak_merchant_rule,
)


def _accts():
    return [
        {"id": "a1", "code": "6300", "name": "Office Supplies"},
        {"id": "a2", "code": "6100", "name": "Travel"},
        {"id": "a3", "code": "6999", "name": "Uncategorized Expense"},
    ]


def _mk_txn(cid: str, contact_id: str, code: str, i: int, **overrides):
    base = {
        "id":     f"t-{contact_id}-{i}",
        "company_id":   cid,
        "contact_id":   contact_id,
        "contact_name": "Walmart",
        "merchant":     "WALMART",
        "amount":       -25.0,
        "date":         f"2026-01-{i:02d}",
        "human_reviewed": True,
        "posted":       True,
        "category_account_code": code,
        "category_account_name": "Office Supplies" if code == "6300" else "Travel",
    }
    base.update(overrides)
    return base


def test_learning_fires_on_strong_majority():
    cid = "test-learn-strong"
    cx = "c-walmart"

    async def prepare():
        await db.transactions.delete_many({"company_id": cid})
        rows = [_mk_txn(cid, cx, "6300", i) for i in range(1, 6)]  # 5 hits
        await db.transactions.insert_many(rows)

    async def act():
        return await get_learned_category(cid, cx, _accts())

    async def cleanup():
        await db.transactions.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    assert result is not None
    assert result["post"]["category_account_code"] == "6300"
    assert result["sample_size"] == 5
    assert result["confidence"] == 1.0
    assert result["post"]["ai_source"] == "contact_learning"
    assert "Learned from 5 of 5" in result["post"]["ai_reasoning"]


def test_learning_abstains_below_min_sample():
    cid = "test-learn-tiny"
    cx = "c-walmart"

    async def prepare():
        await db.transactions.delete_many({"company_id": cid})
        rows = [_mk_txn(cid, cx, "6300", i) for i in range(1, 3)]  # 2 hits
        await db.transactions.insert_many(rows)

    async def act():
        return await get_learned_category(cid, cx, _accts())

    async def cleanup():
        await db.transactions.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    assert result is None


def test_learning_abstains_when_split():
    cid = "test-learn-split"
    cx = "c-walmart"

    async def prepare():
        await db.transactions.delete_many({"company_id": cid})
        # 3 → 6300, 2 → 6100. Winner is 3/5 = 60% < 80%.
        rows = [_mk_txn(cid, cx, "6300", i) for i in range(1, 4)] + \
               [_mk_txn(cid, cx, "6100", i + 10) for i in range(1, 3)]
        await db.transactions.insert_many(rows)

    async def act():
        return await get_learned_category(cid, cx, _accts())

    async def cleanup():
        await db.transactions.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    assert result is None


def test_learning_ignores_parked_categories():
    """Rows sitting in 6999 (Uncategorized Expense) shouldn't count as
    signal even though human_reviewed=True. Otherwise a bulk 'approve
    to Uncategorized' would train the system to keep dumping there."""
    cid = "test-learn-parked"
    cx = "c-walmart"

    async def prepare():
        await db.transactions.delete_many({"company_id": cid})
        # 4 parked + 1 real. Should treat as sample_size=1 → below MIN_SAMPLE.
        rows = [_mk_txn(cid, cx, "6999", i) for i in range(1, 5)] + [
            _mk_txn(cid, cx, "6300", 10),
        ]
        await db.transactions.insert_many(rows)

    async def act():
        return await get_learned_category(cid, cx, _accts())

    async def cleanup():
        await db.transactions.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    assert result is None


def test_is_weak_merchant_rule_classification():
    """The gatekeeper that decides whether learning is allowed to
    override a rule. Only plain merchant regexes are 'weak'."""
    # Plain merchant regex → weak.
    assert is_weak_merchant_rule({
        "match_field": "merchant", "match_value": "walmart",
        "account_code": "6300",
    }) is True
    # Legacy no-match_field defaults to merchant → also weak.
    assert is_weak_merchant_rule({
        "match_value": "walmart", "account_code": "6300",
    }) is True
    # Contact-keyed → never weak.
    assert is_weak_merchant_rule({
        "match_field": "contact", "match_value": "c-walmart",
        "account_code": "6300",
    }) is False
    # Merchant + direction filter → targeted, not weak.
    assert is_weak_merchant_rule({
        "match_field": "merchant", "match_value": "walmart",
        "direction": "out", "account_code": "6300",
    }) is False
    # Merchant + amount filter → targeted, not weak.
    assert is_weak_merchant_rule({
        "match_field": "merchant", "match_value": "walmart",
        "amount_op": "gt", "amount_value": 100, "account_code": "6300",
    }) is False
    # Merchant + bank filter → targeted, not weak.
    assert is_weak_merchant_rule({
        "match_field": "merchant", "match_value": "walmart",
        "bank_account_id": "bank-1", "account_code": "6300",
    }) is False
    # Merchant + extra_conditions → targeted, not weak.
    assert is_weak_merchant_rule({
        "match_field": "merchant", "match_value": "walmart",
        "extra_conditions": [{"field": "description", "op": "contains", "value": "gas"}],
        "account_code": "6300",
    }) is False
