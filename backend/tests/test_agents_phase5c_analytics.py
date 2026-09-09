"""Phase 5C — Agent cost metering & analytics."""
import uuid
from datetime import datetime, timezone

import pytest

from tests._shared_loop import run as _run
from db import db
from routes.agents import (
    _run_agent, _template_cost_cents, _DEFAULT_COST_CENTS, _LLM_COST_CENTS,
)


async def _wipe(cid: str, agent_id: str | None = None):
    for coll in ("agents", "agent_runs", "agent_findings", "transactions"):
        await db[coll].delete_many({"company_id": cid})
    if agent_id:
        await db.agent_runs.delete_many({"agent_id": agent_id})


def test_cost_table_llm_vs_deterministic():
    assert _template_cost_cents("cleanup_sweep") == _DEFAULT_COST_CENTS
    assert _template_cost_cents("txn_vendor_inconsistencies") == _DEFAULT_COST_CENTS
    assert _template_cost_cents("key_business_insight") == _LLM_COST_CENTS
    assert _template_cost_cents("whats_going_well") == _LLM_COST_CENTS
    assert _template_cost_cents("board_meeting_prep") == _LLM_COST_CENTS


def test_run_persists_cost_cents_stamp():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        agent_id = f"agent-{uuid.uuid4().hex[:8]}"
        try:
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "account_id": None,
                "amount": 10, "date": "2026-08-01",
            })
            agent = {
                "id": agent_id, "template_key": "cleanup_sweep",
                "company_id": cid, "config": {"min_uncategorized": 1},
                "enabled": True,
            }
            await db.agents.insert_one(agent)
            result = await _run_agent(agent, triggered_by="test")
            assert result["ok"] is True
            run = await db.agent_runs.find_one({"id": result["run_id"]})
            assert run is not None
            assert run.get("cost_cents") == _DEFAULT_COST_CENTS
        finally:
            await _wipe(cid, agent_id)
    _run(go())


def test_analytics_aggregates_across_scopes():
    """Seed 3 runs across 2 templates + 2 companies and confirm the
    endpoint rolls them up correctly."""
    async def go():
        cid_a = f"cid-a-{uuid.uuid4().hex[:6]}"
        cid_b = f"cid-b-{uuid.uuid4().hex[:6]}"
        try:
            now = datetime.now(timezone.utc)
            iso = lambda: now.isoformat()  # noqa: E731
            await db.agent_runs.insert_many([
                {"id": f"r1-{uuid.uuid4().hex[:6]}", "company_id": cid_a,
                 "template_key": "cleanup_sweep", "status": "success",
                 "findings_count": 2, "cost_cents": 0.2, "started_at": iso()},
                {"id": f"r2-{uuid.uuid4().hex[:6]}", "company_id": cid_a,
                 "template_key": "cleanup_sweep", "status": "success",
                 "findings_count": 1, "cost_cents": 0.2, "started_at": iso()},
                {"id": f"r3-{uuid.uuid4().hex[:6]}", "company_id": cid_b,
                 "template_key": "key_business_insight", "status": "success",
                 "findings_count": 1, "cost_cents": 2.0, "started_at": iso()},
            ])
            from routes.agents import agents_analytics  # invoke as function
            # Fake user with access to both cids.
            class _FakeReq:
                pass
            user = {"email": "test@axiom.ai", "role": "accounting_pro"}
            # Patch require_firm_or_pro to return our two cids.
            import routes.agents as m
            original = m.require_firm_or_pro
            async def _fake(u): return [cid_a, cid_b]
            m.require_firm_or_pro = _fake
            try:
                data = await agents_analytics(period=None, user=user)
            finally:
                m.require_firm_or_pro = original
            assert data["totals"]["runs"] == 3
            assert data["totals"]["findings"] == 4
            # 0.2 + 0.2 + 2.0 = 2.4 ¢ → $0.024
            assert abs(data["totals"]["cost"] - 0.024) < 1e-6
            # By template rollup.
            by_tpl = {t["template_key"]: t for t in data["by_template"]}
            assert by_tpl["cleanup_sweep"]["runs"] == 2
            assert by_tpl["key_business_insight"]["runs"] == 1
            # By client rollup.
            by_client = {c["company_id"]: c for c in data["by_client"]}
            assert by_client[cid_a]["runs"] == 2
            assert by_client[cid_b]["runs"] == 1
        finally:
            await db.agent_runs.delete_many({"company_id": cid_a})
            await db.agent_runs.delete_many({"company_id": cid_b})
    _run(go())
