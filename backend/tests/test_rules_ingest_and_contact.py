"""Regression — Feature A (merchant/contact toggle) + Feature B
(rules run on Plaid ingest).

Locks in:
  1. Rule with match_field="contact" applies retroactively to rows
     whose contact_id equals the primary match_value.
  2. `user_rule_matcher.match_and_build_post()` picks the right rule
     for a candidate and produces a categorization post-dict.
  3. Multiple candidate rules → most-specific wins (has more conditions).
  4. When no rule matches, matcher returns None so the callers fall
     through to their existing PFC/directory/AI cascade.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from models import RuleCreate  # noqa: E402
import user_rule_matcher  # noqa: E402


async def _seed(cid: str):
    dst   = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6100",
             "name": "Office", "type": "expense"}
    dst_b = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6300",
             "name": "Meals", "type": "expense"}
    await db.accounts.insert_many([dst, dst_b])

    contact = {"id": str(uuid.uuid4()), "company_id": cid, "name": "Staples",
               "normalized_name": "staples",
               "created_at": now_iso(), "updated_at": now_iso()}
    await db.contacts.insert_one(contact)
    return {"dst": dst, "dst_b": dst_b, "contact": contact}


async def _cleanup(cid: str):
    for coll in ("accounts", "contacts", "transactions", "rules",
                  "rule_candidates", "classes", "tags"):
        await db[coll].delete_many({"company_id": cid})


def _stub(monkeypatch):
    import routes.rules as m
    async def _ok(user, cid): return None
    async def _open(cid, date): return False
    async def _noop(*a, **k): return None
    class _C:
        async def ainvalidate(self, cid): pass
    monkeypatch.setattr(m, "require_company", _ok)
    monkeypatch.setattr(m, "is_period_closed", _open)
    monkeypatch.setattr(m, "log_ai", _noop)
    monkeypatch.setattr(m, "get_cache", lambda: _C())


def test_contact_keyed_rule_applies_retroactively(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"ct-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            # 2 rows with contact_id=Staples, 1 with contact_id=None.
            docs = [
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "merchant": "STAPLES 1234", "amount": -30.0,
                 "date": "2026-02-01",
                 "contact_id": s["contact"]["id"], "contact_name": "Staples",
                 "human_reviewed": False, "needs_review": True, "posted": False,
                 "created_at": now_iso(), "updated_at": now_iso()},
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "merchant": "STAPLES CANADA", "amount": -50.0,
                 "date": "2026-02-02",
                 "contact_id": s["contact"]["id"], "contact_name": "Staples",
                 "human_reviewed": False, "needs_review": True, "posted": False,
                 "created_at": now_iso(), "updated_at": now_iso()},
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "merchant": "SOME OTHER VENDOR", "amount": -20.0,
                 "date": "2026-02-03",
                 "contact_id": None,
                 "human_reviewed": False, "needs_review": True, "posted": False,
                 "created_at": now_iso(), "updated_at": now_iso()},
            ]
            await db.transactions.insert_many(docs)

            r = await create_rule(cid, RuleCreate(
                match_type="contact_equals",
                match_field="contact",
                match_value=s["contact"]["id"],
                account_code="6100",
                apply_to_existing=True,
            ), user={"id": "u", "email": "u@t", "role": "pro"})
            assert r["applied"] == 2

            after = await db.transactions.find(
                {"company_id": cid}, {"id": 1, "category_account_code": 1}
            ).to_list(10)
            codes = {t["id"]: t.get("category_account_code") for t in after}
            for d in docs[:2]:
                assert codes[d["id"]] == "6100"
            assert codes[docs[2]["id"]] != "6100"    # untouched
        finally:
            await _cleanup(cid)
    run(go())


def test_ingest_matcher_picks_most_specific_rule():
    """Feature B — matcher tie-break: more conditions wins."""
    accts = [{"id": "a1", "code": "6100", "name": "Office"},
             {"id": "a2", "code": "6300", "name": "Meals"}]

    generic = {
        "id":           "r-generic",
        "match_field":  "merchant",
        "match_value":  "STARBUCKS",
        "match_type":   "merchant_contains",
        "account_code": "6100",
        "extra_conditions": [],
    }
    specific = {
        "id":           "r-specific",
        "match_field":  "merchant",
        "match_value":  "STARBUCKS",
        "match_type":   "merchant_contains",
        "account_code": "6300",
        "amount_op":    "lt",
        "amount_value": -20.0,
        "extra_conditions": [
            {"field": "description", "op": "contains", "value": "AIRPORT"},
        ],
        "condition_logic": "all",
    }
    cand = {"merchant": "STARBUCKS AIRPORT",
            "description": "STARBUCKS AIRPORT #42",
            "amount": -25.0}
    hit = user_rule_matcher.match_and_build_post(cand, [generic, specific], accts)
    assert hit is not None
    # Specific rule wins → Meals (6300), not Office (6100).
    assert hit["post"]["category_account_code"] == "6300"
    assert hit["post"]["ai_source"] == "user_rule"


def test_ingest_matcher_returns_none_when_no_rule_matches():
    accts = [{"id": "a1", "code": "6100", "name": "Office"}]
    rules = [{
        "id": "r-nope",
        "match_field":  "merchant",
        "match_value":  "STARBUCKS",
        "match_type":   "merchant_contains",
        "account_code": "6100",
        "extra_conditions": [],
    }]
    cand = {"merchant": "WHOLE FOODS", "amount": -50.0}
    assert user_rule_matcher.match_and_build_post(cand, rules, accts) is None


def test_ingest_matcher_contact_field_needs_resolved_contact():
    """Contact-keyed rules require contact_id to be populated first."""
    accts = [{"id": "a1", "code": "6100", "name": "Office"}]
    rule = {
        "id": "r-ct",
        "match_field":  "contact",
        "match_value":  "contact-uuid-1",
        "match_type":   "contact_equals",
        "account_code": "6100",
        "extra_conditions": [],
    }
    # No contact_id → skip.
    assert user_rule_matcher.match_and_build_post(
        {"merchant": "X", "amount": -10, "contact_id": None},
        [rule], accts) is None
    # Wrong contact_id → skip.
    assert user_rule_matcher.match_and_build_post(
        {"merchant": "X", "amount": -10, "contact_id": "other"},
        [rule], accts) is None
    # Right contact_id → match.
    hit = user_rule_matcher.match_and_build_post(
        {"merchant": "X", "amount": -10, "contact_id": "contact-uuid-1"},
        [rule], accts)
    assert hit is not None
    assert hit["post"]["category_account_code"] == "6100"
