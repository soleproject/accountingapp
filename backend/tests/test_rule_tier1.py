"""Regression — Tier-1 QBO parity on rules.

Locks in the new conditions + actions added March 2026:
  * `bank_account_id` restricts a rule to a single feed
  * `amount_op` in {gt, lt, eq, between} filters by signed amount
  * `contact_id` sets the payee alongside the category when the rule fires

Same _shared_loop pattern as neighbouring rule/txn tests.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from models import RuleCreate  # noqa: E402


async def _seed(cid: str):
    dst = {"id": str(uuid.uuid4()), "company_id": cid, "code": "7100",
           "name": "Software & SaaS", "type": "expense"}
    bank_a = {"id": str(uuid.uuid4()), "company_id": cid, "code": "1010",
              "name": "Chase Business", "type": "asset"}
    bank_b = {"id": str(uuid.uuid4()), "company_id": cid, "code": "1020",
              "name": "BofA Personal", "type": "asset"}
    await db.accounts.insert_many([dst, bank_a, bank_b])

    contact = {"id": str(uuid.uuid4()), "company_id": cid, "name": "INTUIT",
               "normalized_name": "intuit",
               "created_at": now_iso(), "updated_at": now_iso()}
    await db.contacts.insert_one(contact)

    # Four candidate rows.
    rows = [
        # $50 INTUIT on Chase → matches (amount>25, chase)
        {"amount": -50.0,  "bank": bank_a["id"], "match": True},
        # $10 INTUIT on Chase → below amount>25 threshold → no match
        {"amount": -10.0,  "bank": bank_a["id"], "match": False},
        # $50 INTUIT on BofA → wrong bank → no match
        {"amount": -50.0,  "bank": bank_b["id"], "match": False},
        # $500 INTUIT on Chase → matches
        {"amount": -500.0, "bank": bank_a["id"], "match": True},
    ]
    docs = []
    for r in rows:
        docs.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "merchant": "INTUIT PAYMENTS",
            "description": "INTUIT PAYMENTS", "amount": r["amount"],
            "bank_account_id": r["bank"], "date": "2026-02-15",
            "human_reviewed": False, "needs_review": True,
            "posted": False,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    await db.transactions.insert_many(docs)
    return {"dst": dst, "bank_a": bank_a, "bank_b": bank_b,
             "contact": contact, "row_meta": list(zip(docs, rows))}


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.rules.delete_many({"company_id": cid})
    await db.rule_candidates.delete_many({"company_id": cid})


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


def test_rule_with_bank_and_amount_and_contact(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"rule-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="INTUIT",
                account_code="7100",
                apply_to_existing=True,
                bank_account_id=s["bank_a"]["id"],
                amount_op="lt",          # amount < -25 → matches $50 & $500 debits
                amount_value=-25.0,
                contact_id=s["contact"]["id"],
            ), user={"id": "u", "email": "u@t", "role": "pro"})

            # Two rows should match (per _seed's `match: True` flags).
            assert r["applied"] == 2

            # Verify each row's contact + category was applied only where matched.
            for doc, meta in s["row_meta"]:
                t = await db.transactions.find_one({"id": doc["id"]})
                if meta["match"]:
                    assert t["category_account_code"] == "7100"
                    assert t["contact_id"] == s["contact"]["id"]
                    assert t["contact_name"] == "INTUIT"
                    assert t["human_reviewed"] is True    # mark_approved default (Mar 2026)
                    assert t["posted"] is True
                else:
                    # Non-matching rows must not be touched at all.
                    assert t.get("category_account_code") != "7100"
                    assert t.get("contact_id") is None or t.get("contact_id") == ""
        finally:
            await _cleanup(cid)
    run(go())


def test_rule_between_amount(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"rule-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            # $50 falls inside [-100, -25]; $500 does NOT; $10 does NOT.
            r = await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="INTUIT",
                account_code="7100",
                apply_to_existing=True,
                bank_account_id=s["bank_a"]["id"],
                amount_op="between",
                amount_value=-100.0,
                amount_value_2=-25.0,
            ), user={"id": "u", "email": "u@t", "role": "pro"})
            assert r["applied"] == 1
        finally:
            await _cleanup(cid)
    run(go())


def test_rule_rejects_unknown_bank(monkeypatch):
    from fastapi import HTTPException
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"rule-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            with pytest.raises(HTTPException) as ei:
                await create_rule(cid, RuleCreate(
                    match_type="merchant_contains",
                    match_value="INTUIT",
                    account_code="7100",
                    bank_account_id="does-not-exist",
                ), user={"id": "u", "email": "u@t", "role": "pro"})
            assert ei.value.status_code == 400
        finally:
            await _cleanup(cid)
    run(go())
