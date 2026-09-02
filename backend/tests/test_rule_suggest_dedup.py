"""
Regression: `/rules/suggest-from-txns` must collapse proposals that
share (match_field, match_value, account_code) even when class_id /
tag_set differ across the source rows.

Bug context (Feb 2026): CPA selected 5 Walmart txns → the popup showed
5 proposal cards (4 duplicates for 6300 Office Supplies + 1 for 6120
Transportation) because signature keying split on class/tag. Merged
result should be 2 cards.
"""
from __future__ import annotations
import sys
sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from routes.rules import suggest_rules_from_txns  # noqa: E402


def _fake_user(cid: str) -> dict:
    return {"id": "u", "role": "superadmin", "company_ids": [cid]}


def test_dedup_collapses_near_identical_walmart_rows():
    cid = "test-suggest-dedup-walmart"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        await db.companies.update_one(
            {"id": cid}, {"$set": {"id": cid, "name": "Test"}}, upsert=True,
        )
        # 4 Walmart → 6300 rows (with varying class/tags) + 1 Walmart → 6120
        rows = [
            {"id": "t1", "company_id": cid, "contact_id": "contact-walmart",
             "contact_name": "Walmart", "merchant": "WALMART",
             "category_account_code": "6300",
             "category_account_name": "Office Supplies",
             "class_id": None, "tags": [], "amount": -15.0, "posted": True},
            {"id": "t2", "company_id": cid, "contact_id": "contact-walmart",
             "contact_name": "Walmart", "merchant": "Walmart",
             "category_account_code": "6300",
             "category_account_name": "Office Supplies",
             "class_id": "cls-a", "tags": [], "amount": -12.95, "posted": True},
            {"id": "t3", "company_id": cid, "contact_id": "contact-walmart",
             "contact_name": "Walmart", "merchant": "WALMART",
             "category_account_code": "6300",
             "category_account_name": "Office Supplies",
             "class_id": None, "tags": ["reimbursable"],
             "amount": -60.0, "posted": True},
            {"id": "t4", "company_id": cid, "contact_id": "contact-walmart",
             "contact_name": "Walmart", "merchant": "Walmart",
             "category_account_code": "6300",
             "category_account_name": "Office Supplies",
             "class_id": None, "tags": [], "amount": -51.03, "posted": True},
            {"id": "t5", "company_id": cid, "contact_id": "contact-walmart",
             "contact_name": "Walmart", "merchant": "Walmart",
             "category_account_code": "6120",
             "category_account_name": "Transportation",
             "class_id": None, "tags": [], "amount": -20.0, "posted": True},
        ]
        await db.transactions.insert_many(rows)

    async def act():
        return await suggest_rules_from_txns(
            cid=cid,
            payload={"transaction_ids": ["t1", "t2", "t3", "t4", "t5"]},
            user=_fake_user(cid),
        )

    async def cleanup():
        await db.transactions.delete_many({"company_id": cid})
        await db.rules.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    props = result["proposals"]
    # 2 cards total — one for 6300, one for 6120.
    assert len(props) == 2, f"expected 2 merged proposals, got {len(props)}: {props}"

    by_code = {p["account_code"]: p for p in props}
    assert set(by_code) == {"6300", "6120"}

    office = by_code["6300"]
    assert office["covered_txn_count"] == 4
    # Class disagreed across siblings → dropped.
    assert office["class_id"] is None
    # Tags disagreed across siblings → intersected to empty.
    assert office["tag_ids"] == []

    transport = by_code["6120"]
    assert transport["covered_txn_count"] == 1


def test_dedup_preserves_class_when_all_siblings_agree():
    cid = "test-suggest-dedup-class-agree"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        await db.companies.update_one(
            {"id": cid}, {"$set": {"id": cid, "name": "Test"}}, upsert=True,
        )
        await db.transactions.insert_many([
            {"id": "a1", "company_id": cid, "contact_id": "c-shell",
             "contact_name": "Shell", "merchant": "SHELL",
             "category_account_code": "6120",
             "category_account_name": "Transportation",
             "class_id": "cls-fleet", "class_name": "Fleet", "tags": [],
             "amount": -40.0, "posted": True},
            {"id": "a2", "company_id": cid, "contact_id": "c-shell",
             "contact_name": "Shell", "merchant": "Shell",
             "category_account_code": "6120",
             "category_account_name": "Transportation",
             "class_id": "cls-fleet", "class_name": "Fleet", "tags": [],
             "amount": -35.0, "posted": True},
        ])

    async def act():
        return await suggest_rules_from_txns(
            cid=cid,
            payload={"transaction_ids": ["a1", "a2"]},
            user=_fake_user(cid),
        )

    async def cleanup():
        await db.transactions.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    props = result["proposals"]
    assert len(props) == 1
    assert props[0]["class_id"] == "cls-fleet"
    assert props[0]["covered_txn_count"] == 2
