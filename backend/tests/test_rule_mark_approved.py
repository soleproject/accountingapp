"""Regression — `mark_approved` on `apply_to_existing` (Mar 2026).

The rule-creation retroactive apply used to leave rows in a weird
"posted + not needing review + not human-reviewed" limbo. Mar 2026 the
default flipped to also stamp `human_reviewed=True` so those rows land
in the Approved queue. The `mark_approved` payload flag preserves the
old cautious behaviour on request.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from models import RuleCreate  # noqa: E402


async def _seed(cid: str):
    acct = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6000",
            "name": "Office", "type": "expense"}
    await db.accounts.insert_one(acct)
    return acct


async def _cleanup(cid: str):
    for coll in ("accounts", "transactions", "rules"):
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


def test_default_marks_rows_approved(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"ma-{uuid.uuid4().hex[:8]}"
        try:
            _ = await _seed(cid)
            tid = str(uuid.uuid4())
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "merchant": "STAPLES 1234", "amount": -25.0, "date": "2026-03-01",
                "human_reviewed": False, "needs_review": True, "posted": False,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="STAPLES",
                account_code="6000",
                apply_to_existing=True,
                # mark_approved omitted → default True
            ), user={"role": "pro"})
            t = await db.transactions.find_one({"id": tid})
            assert t["human_reviewed"] is True
            assert t["needs_review"] is False
            assert t["posted"] is True
        finally:
            await _cleanup(cid)
    run(go())


def test_mark_approved_false_leaves_review_flag(monkeypatch):
    from routes.rules import create_rule
    _stub(monkeypatch)

    async def go():
        cid = f"ma-{uuid.uuid4().hex[:8]}"
        try:
            _ = await _seed(cid)
            tid = str(uuid.uuid4())
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "merchant": "STAPLES 1234", "amount": -25.0, "date": "2026-03-01",
                "human_reviewed": False, "needs_review": True, "posted": False,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            await create_rule(cid, RuleCreate(
                match_type="merchant_contains",
                match_value="STAPLES",
                account_code="6000",
                apply_to_existing=True,
                mark_approved=False,     # cautious mode
            ), user={"role": "pro"})
            t = await db.transactions.find_one({"id": tid})
            assert t["human_reviewed"] is False   # NOT auto-approved
            assert t["posted"] is True             # category still applied
        finally:
            await _cleanup(cid)
    run(go())
