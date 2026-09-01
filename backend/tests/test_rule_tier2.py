"""Regression — Tier-2 QBO parity on rules (Mar 2026).

Locks in the new features:
  * multi-condition builder with `condition_logic` = "all" | "any"
  * `class_id` action stamps `class_id` + `class_name` on matched rows
  * `tag_ids` action unions onto the row's existing tags
  * `posting_mode` = "review" flips `needs_review=True`, `posted=False`
    instead of auto-posting

Reuses the auth-stub pattern from tests/test_rule_tier1.py.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from models import RuleCreate, RuleExtraCondition  # noqa: E402


async def _seed(cid: str):
    dst = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6000",
           "name": "Meals & Entertainment", "type": "expense"}
    await db.accounts.insert_one(dst)

    klass = {"id": str(uuid.uuid4()), "company_id": cid,
             "name": "Sales · Client Meals",
             "created_at": now_iso(), "updated_at": now_iso()}
    await db.classes.insert_one(klass)

    tag_a = {"id": str(uuid.uuid4()), "company_id": cid, "name": "billable",
             "created_at": now_iso(), "updated_at": now_iso()}
    tag_b = {"id": str(uuid.uuid4()), "company_id": cid, "name": "audit-2026",
             "created_at": now_iso(), "updated_at": now_iso()}
    await db.tags.insert_many([tag_a, tag_b])

    rows = [
        # Row 1: merchant=STARBUCKS, amount=-8 → matches "any" (both conds hit),
        # matches "all" too.
        {"merchant": "STARBUCKS #1234", "amount": -8.0,
         "id": str(uuid.uuid4()), "tags": ["pre-existing"]},
        # Row 2: merchant=CHIPOTLE, amount=-40 → matches "any" (amount hits,
        # merchant doesn't), does NOT match "all".
        {"merchant": "CHIPOTLE",         "amount": -40.0,
         "id": str(uuid.uuid4()), "tags": []},
        # Row 3: merchant=STARBUCKS, amount=-2 → matches "any" (merchant hits),
        # does NOT match "all" (amount too small).
        {"merchant": "STARBUCKS AIRPORT", "amount": -2.0,
         "id": str(uuid.uuid4()), "tags": []},
        # Row 4: merchant=OFFICE DEPOT, amount=-100 → matches neither.
        {"merchant": "OFFICE DEPOT",     "amount": -100.0,
         "id": str(uuid.uuid4()), "tags": []},
    ]
    docs = [{
        "id": r["id"], "company_id": cid, "merchant": r["merchant"],
        "description": r["merchant"], "amount": r["amount"],
        "date": "2026-03-01", "human_reviewed": False, "needs_review": True,
        "posted": False, "tags": r["tags"],
        "created_at": now_iso(), "updated_at": now_iso(),
    } for r in rows]
    await db.transactions.insert_many(docs)
    return {"dst": dst, "klass": klass, "tag_a": tag_a, "tag_b": tag_b, "rows": docs}


async def _cleanup(cid: str):
    for coll in ("accounts", "contacts", "classes", "tags",
                  "transactions", "rules", "rule_candidates"):
        await db[coll].delete_many({"company_id": cid})


def _stub(monkeypatch):
    import routes.rules as m
    async def _ok(user, cid): return None
    async def _open(cid, date): return False
    async def _noop_log(cid, kind, count): return None
    class _C:
        async def ainvalidate(self, cid): pass
    monkeypatch.setattr(m, "require_company", _ok)
    monkeypatch.setattr(m, "is_period_closed", _open)
    monkeypatch.setattr(m, "log_ai", _noop_log)
    monkeypatch.setattr(m, "get_cache", lambda: _C())


def test_condition_logic_all_narrows_matches(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"r2-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="STARBUCKS",
                account_code="6000",
                apply_to_existing=True,
                condition_logic="all",
                extra_conditions=[
                    RuleExtraCondition(field="amount", op="lt", value="-5"),
                ],
            ), user={"role": "pro"})
            # Only row 1 matches BOTH conditions.
            assert r["applied"] == 1
        finally:
            await _cleanup(cid)
    run(go())


def test_condition_logic_any_widens_matches(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"r2-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="STARBUCKS",
                account_code="6000",
                apply_to_existing=True,
                condition_logic="any",
                extra_conditions=[
                    RuleExtraCondition(field="amount", op="lt", value="-30"),
                ],
            ), user={"role": "pro"})
            # Rows 1 (STARBUCKS -8) + 2 (CHIPOTLE -40) + 3 (STARBUCKS -2) +
            # 4 (OFFICE DEPOT -100) all match under "any" — STARBUCKS
            # merchant OR amount<-30 covers every row.
            assert r["applied"] == 4
        finally:
            await _cleanup(cid)
    run(go())


def test_class_and_tags_stamp_onto_matched_rows(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"r2-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="STARBUCKS",
                account_code="6000",
                apply_to_existing=True,
                class_id=s["klass"]["id"],
                tag_ids=[s["tag_a"]["id"], s["tag_b"]["id"]],
            ), user={"role": "pro"})
            assert r["applied"] == 2

            starbucks_rows = await db.transactions.find(
                {"company_id": cid,
                 "merchant": {"$regex": "STARBUCKS", "$options": "i"}}
            ).to_list(10)
            for t in starbucks_rows:
                assert t["class_id"] == s["klass"]["id"]
                assert t["class_name"] == "Sales · Client Meals"
                assert set(t["tags"]) >= {s["tag_a"]["id"], s["tag_b"]["id"]}
            # Row 1 also keeps its pre-existing 'pre-existing' tag.
            row1 = next(t for t in starbucks_rows
                        if "1234" in t.get("merchant", ""))
            assert "pre-existing" in row1["tags"]
        finally:
            await _cleanup(cid)
    run(go())


def test_posting_mode_review_flags_instead_of_posting(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"r2-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="STARBUCKS",
                account_code="6000",
                apply_to_existing=True,
                posting_mode="review",
            ), user={"role": "pro"})
            assert r["applied"] == 2
            starbucks_rows = await db.transactions.find(
                {"company_id": cid,
                 "merchant": {"$regex": "STARBUCKS", "$options": "i"}}
            ).to_list(10)
            for t in starbucks_rows:
                assert t["needs_review"] is True
                assert t["posted"] is False
        finally:
            await _cleanup(cid)
    run(go())
