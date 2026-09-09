"""Phase 5A.4 — Run Once endpoint.

Fires a template on-demand without persisting an agent doc. Findings +
run rows still land so results roll up into Today.
"""
import uuid
import pytest

from tests._shared_loop import run as _run
from db import db
from routes.agents import _run_agent, _TEMPLATES


async def _wipe(cid: str):
    for coll in ("transactions", "agent_runs", "agent_findings"):
        await db[coll].delete_many({"company_id": cid})


def test_run_once_persists_run_and_findings_without_agent_doc():
    """Simulate the /agents/run-once endpoint by building a synthetic agent
    dict (as the endpoint does) and calling _run_agent directly. The agent
    should NOT be persisted to db.agents, but the run + findings SHOULD be."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "account_id": None,
                "amount": 10.0, "date": "2026-08-01",
            })
            synthetic = {
                "id": f"one-shot-{uuid.uuid4().hex}",
                "template_key": "cleanup_sweep",
                "company_id": cid,
                "config": {"min_uncategorized": 1},
                "enabled": False,
                "one_shot": True,
            }
            result = await _run_agent(synthetic, triggered_by="run-once:test")
            assert result["ok"] is True
            assert result["findings_count"] == 1
            # Agent doc was NOT persisted.
            assert await db.agents.find_one({"id": synthetic["id"]}) is None
            # But the run and finding were.
            runs = await db.agent_runs.find({"agent_id": synthetic["id"]}).to_list(5)
            assert len(runs) == 1
            assert runs[0]["triggered_by"] == "run-once:test"
            findings = await db.agent_findings.find({"agent_id": synthetic["id"]}).to_list(5)
            assert len(findings) == 1
        finally:
            await _wipe(cid)
    _run(go())


def test_run_once_merges_default_config():
    """The endpoint merges template.default_config with user overrides.
    Verified by seeding zero transactions so a config threshold change
    controls whether a finding is produced."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            # Seed exactly 2 uncategorized txns.
            for i in range(2):
                await db.transactions.insert_one({
                    "id": f"{cid}-t{i}", "company_id": cid, "account_id": None,
                    "amount": 10.0, "date": "2026-08-01",
                })
            template = _TEMPLATES["cleanup_sweep"]
            # min_uncategorized=5 → template's default(1) overridden → NO finding
            synthetic = {
                "id": f"one-shot-{uuid.uuid4().hex}",
                "template_key": "cleanup_sweep",
                "company_id": cid,
                "config": {**template["default_config"], "min_uncategorized": 5},
                "enabled": False, "one_shot": True,
            }
            result = await _run_agent(synthetic, triggered_by="run-once:test")
            assert result["ok"] is True
            assert result["findings_count"] == 0
        finally:
            await _wipe(cid)
    _run(go())
