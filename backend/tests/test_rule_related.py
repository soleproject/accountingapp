"""
Tests for the query shape that powers `/rules/related` — the endpoint
that drives the CURRENT pill + sibling chip strip on the Suggested-rule
popup.

Uses the same sync-wrapped loop pattern as the other tests in this
module to avoid pytest-asyncio + motor event-loop teardown flakiness.
"""
from __future__ import annotations
import re
import sys

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run  # noqa: E402


def test_related_query_shapes():
    cid = "test-rule-related-shapes"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.rules.insert_many([
            {"id": "c1", "company_id": cid, "match_field": "contact",
             "match_value": "contact-abc", "account_code": "6000"},
            {"id": "c2", "company_id": cid, "match_field": "contact",
             "match_value": "contact-abc", "account_code": "6100",
             "direction": "in"},
            {"id": "c3", "company_id": cid, "match_field": "contact",
             "match_value": "contact-xyz", "account_code": "6200"},
            {"id": "m1", "company_id": cid, "match_field": "merchant",
             "match_value": "amazon", "account_code": "6100"},
            {"id": "m2", "company_id": cid,
             "match_value": "amazon", "account_code": "6200"},  # legacy
            {"id": "m3", "company_id": cid, "match_field": "merchant",
             "match_value": "walmart", "account_code": "6300"},
        ])

    async def contact_query():
        return await db.rules.find({
            "company_id": cid, "match_field": "contact",
            "match_value": "contact-abc",
        }).to_list(50)

    async def merchant_query():
        rx = {"$regex": re.escape("amazon"), "$options": "i"}
        return await db.rules.find({
            "company_id": cid,
            "$or": [
                {"match_field": "merchant", "match_value": rx},
                {"match_field": {"$exists": False}, "match_value": rx},
            ],
        }).to_list(50)

    async def cleanup():
        await db.rules.delete_many({"company_id": cid})

    try:
        run(prepare())
        contact_docs = run(contact_query())
        assert {d["id"] for d in contact_docs} == {"c1", "c2"}
        merchant_docs = run(merchant_query())
        assert {d["id"] for d in merchant_docs} == {"m1", "m2"}
    finally:
        run(cleanup())
