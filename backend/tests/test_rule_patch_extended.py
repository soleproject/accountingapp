"""
Regression: PATCH /rules/{rid} was extended (Feb 2026) to accept the
full writable field set so the "Update current rule" button on the
Suggested-rule popup can flip direction / class / tags / posting_mode
without a DELETE + POST cycle.
"""
from __future__ import annotations
import sys
sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from routes.rules import patch_rule  # noqa: E402


def _fake_user(cid: str) -> dict:
    return {"id": "u", "role": "superadmin", "company_ids": [cid]}


def test_patch_sets_direction_and_class_tags():
    cid = "test-patch-extended"
    rid = "r-patch-1"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.companies.update_one(
            {"id": cid}, {"$set": {"id": cid, "name": "Test"}}, upsert=True,
        )
        await db.accounts.update_one(
            {"company_id": cid, "code": "6300"},
            {"$set": {"company_id": cid, "code": "6300", "name": "Office Supplies"}},
            upsert=True,
        )
        await db.rules.insert_one({
            "id": rid, "company_id": cid, "match_field": "merchant",
            "match_value": "Walmart", "account_code": "6300",
            "account_name": "Office Supplies",
        })

    async def act():
        return await patch_rule(
            cid=cid, rid=rid,
            payload={
                "direction":     "out",
                "class_id":      "cls-fleet",
                "tag_ids":       ["t1", "t2"],
                "posting_mode":  "review",
                "amount_op":     "gt",
                "amount_value":  100,
            },
            user=_fake_user(cid),
        )

    async def read():
        return await db.rules.find_one({"id": rid, "company_id": cid})

    async def cleanup():
        await db.rules.delete_many({"company_id": cid})
        await db.accounts.delete_many({"company_id": cid, "code": "6300"})

    run(prepare())
    try:
        resp = run(act())
        doc = run(read())
    finally:
        run(cleanup())

    assert resp["ok"] is True
    assert doc["direction"] == "out"
    assert doc["class_id"] == "cls-fleet"
    assert doc["tag_ids"] == ["t1", "t2"]
    assert doc["posting_mode"] == "review"
    assert doc["amount_op"] == "gt"
    assert doc["amount_value"] == 100.0


def test_patch_unsets_direction_when_set_to_both():
    cid = "test-patch-unset-direction"
    rid = "r-patch-2"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.companies.update_one(
            {"id": cid}, {"$set": {"id": cid, "name": "Test"}}, upsert=True,
        )
        await db.rules.insert_one({
            "id": rid, "company_id": cid, "match_field": "merchant",
            "match_value": "Shell", "account_code": "6120",
            "direction": "out",
        })

    async def act():
        return await patch_rule(
            cid=cid, rid=rid,
            payload={"direction": "both"},
            user=_fake_user(cid),
        )

    async def read():
        return await db.rules.find_one({"id": rid, "company_id": cid})

    async def cleanup():
        await db.rules.delete_many({"company_id": cid})

    run(prepare())
    try:
        run(act())
        doc = run(read())
    finally:
        run(cleanup())

    # Setting direction=both should unset the field entirely.
    assert "direction" not in doc or doc.get("direction") is None
