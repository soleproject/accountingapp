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
        await db.transactions.delete_many({"company_id": cid})
        await db.rules.insert_many([
            {"id": "c1", "company_id": cid, "match_field": "contact",
             "match_value": "contact-abc", "account_code": "6000"},
            {"id": "c2", "company_id": cid, "match_field": "contact",
             "match_value": "contact-abc", "account_code": "6100",
             "direction": "in"},
            {"id": "c3", "company_id": cid, "match_field": "contact",
             "match_value": "contact-xyz", "account_code": "6200"},
            {"id": "m1", "company_id": cid, "match_field": "merchant",
             "match_value": "wmt", "account_code": "6300"},
            {"id": "m2", "company_id": cid,
             "match_value": "wal-mart", "account_code": "6400"},   # legacy
            {"id": "m3", "company_id": cid, "match_field": "merchant",
             "match_value": "walgreens", "account_code": "6500"},
        ])
        # Seed history so the cross-key aggregation finds an alias:
        # contact-abc rows have merchant strings "WMT SUPERCENTER" and
        # "WAL-MART.COM" — those substrings match m1/m2 but not m3.
        await db.transactions.insert_many([
            {"company_id": cid, "contact_id": "contact-abc", "merchant": "WMT SUPERCENTER"},
            {"company_id": cid, "contact_id": "contact-abc", "merchant": "WAL-MART.COM"},
            {"company_id": cid, "contact_id": "contact-abc", "merchant": "WMT SUPERCENTER"},
        ])

    async def cleanup():
        await db.rules.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})

    async def cross_key_from_contact():
        # Simulate the /rules/related pipeline for match_field=contact
        # — the rule's short token is a substring of the historical
        # merchant, not the other way around.
        merchants = await db.transactions.distinct(
            "merchant", {"company_id": cid, "contact_id": "contact-abc"},
        )
        merchants = [m.lower() for m in (merchants or []) if m][:20]
        all_merch_rules = await db.rules.find({
            "company_id": cid,
            "$or": [
                {"match_field": "merchant"},
                {"match_field": {"$exists": False}},
            ],
        }).to_list(200)
        return [
            r for r in all_merch_rules
            if (r.get("match_value") or "")
               and any((r["match_value"] or "").lower() in m for m in merchants)
        ]

    try:
        run(prepare())
        contact_docs = run(db.rules.find({
            "company_id": cid, "match_field": "contact",
            "match_value": "contact-abc",
        }).to_list(50))
        assert {d["id"] for d in contact_docs} == {"c1", "c2"}
        merchant_docs = run(db.rules.find({
            "company_id": cid,
            "$or": [
                {"match_field": "merchant", "match_value":
                    {"$regex": re.escape("wmt"), "$options": "i"}},
                {"match_field": {"$exists": False}, "match_value":
                    {"$regex": re.escape("wmt"), "$options": "i"}},
            ],
        }).to_list(50))
        assert {d["id"] for d in merchant_docs} == {"m1"}
        # Cross-key: the Wal-Mart contact's history contains merchants
        # that match m1 (wmt) and m2 (wal-mart), but NOT m3 (walgreens).
        cross_docs = run(cross_key_from_contact())
        assert {d["id"] for d in cross_docs} == {"m1", "m2"}
    finally:
        run(cleanup())
