"""Regression — Tier-3 QBO parity on rules (Mar 2026).

Locks in:
  1. `enabled=False` rules are skipped by `load_active_rules`.
  2. `priority` breaks ties (higher priority wins) over specificity.
  3. Splits sum to 100 or the create endpoint 400s.
  4. Retroactive splits populate `txn.splits[]` with signed slice amounts.
  5. `copy-to` clones a rule into another company by account code and
     drops company-local ids (contact / class / tags / bank).
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from models import RuleCreate, RuleSplit  # noqa: E402
import user_rule_matcher  # noqa: E402


async def _seed(cid: str, *, with_second_account=False):
    """Every test gets a minimal CoA + one txn."""
    acct = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6000",
            "name": "Office", "type": "expense"}
    docs_to_insert = [acct]
    if with_second_account:
        acct_b = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6300",
                  "name": "Meals", "type": "expense"}
        docs_to_insert.append(acct_b)
    await db.accounts.insert_many(docs_to_insert)
    return acct


async def _cleanup(cid: str):
    for coll in ("accounts", "contacts", "classes", "tags",
                  "transactions", "rules", "rule_candidates"):
        await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_many({"id": cid})


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


def test_load_active_skips_disabled_rules():
    async def go():
        cid = f"t3-{uuid.uuid4().hex[:8]}"
        try:
            now = now_iso()
            await db.rules.insert_many([
                {"id": "r1", "company_id": cid, "match_value": "X",
                 "match_type": "merchant_contains", "account_code": "6000",
                 "enabled": True,  "created_at": now, "updated_at": now},
                {"id": "r2", "company_id": cid, "match_value": "Y",
                 "match_type": "merchant_contains", "account_code": "6000",
                 "enabled": False, "created_at": now, "updated_at": now},
                {"id": "r3", "company_id": cid, "match_value": "Z",
                 "match_type": "merchant_contains", "account_code": "6000",
                 # no enabled key at all — legacy rule → treated as enabled
                 "created_at": now, "updated_at": now},
            ])
            rules = await user_rule_matcher.load_active_rules(cid)
            ids = {r["id"] for r in rules}
            assert ids == {"r1", "r3"}
        finally:
            await _cleanup(cid)
    run(go())


def test_priority_wins_over_specificity():
    """Even without extra conditions, a higher-priority rule beats a
    more-specific competitor."""
    accts = [{"id": "a1", "code": "6000", "name": "Office"},
             {"id": "a2", "code": "6300", "name": "Meals"}]
    generic_but_priority = {
        "id": "hi-pri", "match_field": "merchant", "match_value": "STARBUCKS",
        "match_type": "merchant_contains", "account_code": "6300",
        "extra_conditions": [], "priority": 100,
    }
    very_specific = {
        "id": "specific", "match_field": "merchant", "match_value": "STARBUCKS",
        "match_type": "merchant_contains", "account_code": "6000",
        "amount_op": "lt", "amount_value": -1,
        "extra_conditions": [
            {"field": "description", "op": "contains", "value": "AIRPORT"},
        ],
        "condition_logic": "all", "priority": 0,
    }
    cand = {"merchant": "STARBUCKS AIRPORT",
            "description": "STARBUCKS AIRPORT #42",
            "amount": -25.0}
    hit = user_rule_matcher.match_and_build_post(
        cand, [very_specific, generic_but_priority], accts)
    assert hit["post"]["category_account_code"] == "6300"    # high-pri wins


def test_split_rule_persists_and_applies(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"t3-{uuid.uuid4().hex[:8]}"
        try:
            _ = await _seed(cid, with_second_account=True)
            # One $100 debit that should split 60/40 Office/Meals → -60/-40.
            tid = str(uuid.uuid4())
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "merchant": "AMAZON MKTPL", "description": "AMAZON",
                "amount": -100.0, "date": "2026-03-01",
                "human_reviewed": False, "needs_review": True, "posted": False,
                "created_at": now_iso(), "updated_at": now_iso(),
            })

            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="AMAZON",
                account_code="6000",          # fallback account
                apply_to_existing=True,
                splits=[
                    RuleSplit(account_code="6000", percent=60),
                    RuleSplit(account_code="6300", percent=40),
                ],
            ), user={"role": "pro"})
            assert r["applied"] == 1

            t = await db.transactions.find_one({"id": tid})
            slices = t.get("splits") or []
            assert len(slices) == 2
            by_code = {s["account_code"]: s for s in slices}
            assert by_code["6000"]["amount"] == -60.0
            assert by_code["6300"]["amount"] == -40.0
            assert by_code["6000"]["percent"] == 60
            assert by_code["6300"]["percent"] == 40
        finally:
            await _cleanup(cid)
    run(go())


def test_split_rule_rejects_non_100_sum(monkeypatch):
    from fastapi import HTTPException
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"t3-{uuid.uuid4().hex[:8]}"
        try:
            _ = await _seed(cid, with_second_account=True)
            with pytest.raises(HTTPException) as ei:
                await create_rule(cid, RuleCreate(
                    match_type="merchant_contains",
                    match_value="X", account_code="6000",
                    splits=[
                        RuleSplit(account_code="6000", percent=50),
                        RuleSplit(account_code="6300", percent=30),   # sum=80
                    ],
                ), user={"role": "pro"})
            assert ei.value.status_code == 400
            assert "sum to 100" in str(ei.value.detail)
        finally:
            await _cleanup(cid)
    run(go())


def test_copy_to_creates_rule_in_target_company(monkeypatch):
    from routes.rules import create_rule, copy_rule_to_companies
    _stub(monkeypatch)

    async def go():
        cid_src = f"src-{uuid.uuid4().hex[:8]}"
        cid_dst = f"dst-{uuid.uuid4().hex[:8]}"
        try:
            await db.companies.insert_many([
                {"id": cid_src, "name": "SRC LLC"},
                {"id": cid_dst, "name": "DST LLC"},
            ])
            # Both companies get an identical CoA code so the copy resolves.
            for c in (cid_src, cid_dst):
                await db.accounts.insert_one({
                    "id": str(uuid.uuid4()), "company_id": c,
                    "code": "6100", "name": "Software", "type": "expense",
                })
            r = await create_rule(cid_src, RuleCreate(
                match_type="merchant_contains",
                match_value="GITHUB",
                account_code="6100",
                apply_to_existing=False,
                priority=5,
            ), user={"role": "pro"})
            rid = r["id"]

            result = await copy_rule_to_companies(cid_src, rid, {
                "target_company_ids": [cid_dst],
            }, user={"role": "pro"})
            assert result["copied"] == 1
            new_rule = await db.rules.find_one({
                "company_id": cid_dst,
                "copied_from_rule_id": rid,
            })
            assert new_rule is not None
            assert new_rule["match_value"] == "GITHUB"
            assert new_rule["account_code"] == "6100"
            assert new_rule["priority"] == 5
            # Company-local ids never copy across.
            assert new_rule.get("contact_id") is None
            assert new_rule.get("class_id") is None
            assert new_rule.get("tag_ids") == []
        finally:
            for c in (cid_src, cid_dst):
                await _cleanup(c)
    run(go())


def test_copy_to_skips_when_account_missing(monkeypatch):
    from routes.rules import create_rule, copy_rule_to_companies
    _stub(monkeypatch)

    async def go():
        cid_src = f"src-{uuid.uuid4().hex[:8]}"
        cid_dst = f"dst-{uuid.uuid4().hex[:8]}"
        try:
            await db.companies.insert_many([
                {"id": cid_src, "name": "SRC"},
                {"id": cid_dst, "name": "DST"},
            ])
            await db.accounts.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid_src,
                "code": "7999", "name": "Weird custom", "type": "expense",
            })
            # DST has NO 7999 — copy should skip with reason=missing_account.
            r = await create_rule(cid_src, RuleCreate(
                match_type="merchant_contains",
                match_value="X", account_code="7999",
                apply_to_existing=False,
            ), user={"role": "pro"})
            result = await copy_rule_to_companies(cid_src, r["id"], {
                "target_company_ids": [cid_dst],
            }, user={"role": "pro"})
            assert result["copied"] == 0
            assert result["skipped"][0]["reason"].startswith("missing_account")
        finally:
            for c in (cid_src, cid_dst):
                await _cleanup(c)
    run(go())
