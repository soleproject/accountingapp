"""Phase 5B — Runbooks (agent orchestration).

Verifies:
  - `_run_runbook` chains steps in order and persists a runbook_run row
  - `on_fail: stop` halts execution when a step fails
  - `on_fail: continue` allows the chain to keep going after a failure
  - `tick_due_runbooks` respects cadence
  - Default runbook templates carry 4 gated close-cadence steps
"""
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

import pytest

from tests._shared_loop import run as _run
from db import db
from routes import agents as agents_mod


async def _wipe(cid: str):
    for coll in (
        "transactions", "agents", "agent_runs", "agent_findings",
        "runbooks", "runbook_runs",
    ):
        await db[coll].delete_many({"company_id": cid})


def test_default_runbook_templates_include_end_of_month():
    keys = {t["key"] for t in agents_mod.DEFAULT_RUNBOOK_TEMPLATES}
    assert "end_of_month" in keys
    assert "weekly_health_check" in keys
    assert "board_prep" in keys
    eom = next(t for t in agents_mod.DEFAULT_RUNBOOK_TEMPLATES if t["key"] == "end_of_month")
    step_keys = [s["template_key"] for s in eom["steps"]]
    assert step_keys == [
        "cleanup_sweep", "je_auto_drafter",
        "advisor_report_send", "signoff_reminder",
    ]
    # First two are gated; the last two are non-gated.
    assert eom["steps"][0]["on_fail"] == "stop"
    assert eom["steps"][1]["on_fail"] == "stop"


def test_runbook_executes_steps_and_persists_run():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            # Seed 1 uncategorized txn so cleanup_sweep produces a finding.
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "account_id": None,
                "amount": 10.0, "date": "2026-08-01",
            })
            runbook = {
                "id": f"rb-{uuid.uuid4().hex[:8]}", "name": "test",
                "company_id": cid, "schedule": "monthly", "enabled": True,
                "steps": [
                    {"template_key": "cleanup_sweep", "config": {"min_uncategorized": 1}, "on_fail": "continue"},
                ],
            }
            await db.runbooks.insert_one(runbook)
            result = await agents_mod._run_runbook(runbook, triggered_by="test")
            assert result["ok"] is True
            assert result["status"] == "success"
            assert result["findings_count"] == 1

            runs = await db.runbook_runs.find({"runbook_id": runbook["id"]}).to_list(5)
            assert len(runs) == 1
            assert runs[0]["status"] == "success"
            assert len(runs[0]["step_results"]) == 1

            # The per-step agent_run was persisted too (composes with agent history).
            agent_runs = await db.agent_runs.find({"triggered_by": f"runbook:{runbook['id']}"}).to_list(5)
            assert len(agent_runs) == 1
        finally:
            await _wipe(cid)
    _run(go())


def test_runbook_halts_on_stop_when_step_fails():
    """Force a step failure via monkeypatch and confirm `on_fail: stop`
    halts the chain."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            runbook = {
                "id": f"rb-{uuid.uuid4().hex[:8]}", "name": "test",
                "company_id": cid, "schedule": "monthly", "enabled": True,
                "steps": [
                    {"template_key": "cleanup_sweep",  "config": {}, "on_fail": "stop"},
                    {"template_key": "portal_chase",   "config": {}, "on_fail": "continue"},
                ],
            }
            await db.runbooks.insert_one(runbook)
            # Make the FIRST template raise so the runbook halts.
            async def _boom(*a, **kw):
                raise RuntimeError("kaboom")
            original = agents_mod._TEMPLATES["cleanup_sweep"]["run"]
            agents_mod._TEMPLATES["cleanup_sweep"]["run"] = _boom
            try:
                result = await agents_mod._run_runbook(runbook, triggered_by="test")
            finally:
                agents_mod._TEMPLATES["cleanup_sweep"]["run"] = original
            assert result["status"] == "halted"
            assert len(result["step_results"]) == 1  # second step never ran
            assert result["step_results"][0]["status"] == "failed"
        finally:
            await _wipe(cid)
    _run(go())


def test_runbook_continues_past_failure_when_on_fail_is_continue():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            runbook = {
                "id": f"rb-{uuid.uuid4().hex[:8]}", "name": "test",
                "company_id": cid, "schedule": "monthly", "enabled": True,
                "steps": [
                    {"template_key": "cleanup_sweep", "config": {}, "on_fail": "continue"},
                    {"template_key": "portal_chase",  "config": {}, "on_fail": "continue"},
                ],
            }
            await db.runbooks.insert_one(runbook)
            async def _boom(*a, **kw):
                raise RuntimeError("boom")
            original = agents_mod._TEMPLATES["cleanup_sweep"]["run"]
            agents_mod._TEMPLATES["cleanup_sweep"]["run"] = _boom
            try:
                result = await agents_mod._run_runbook(runbook, triggered_by="test")
            finally:
                agents_mod._TEMPLATES["cleanup_sweep"]["run"] = original
            assert result["status"] == "partial"
            # BOTH steps have entries in step_results.
            assert len(result["step_results"]) == 2
            assert result["step_results"][0]["status"] == "failed"
            assert result["step_results"][1]["status"] == "success"
        finally:
            await _wipe(cid)
    _run(go())


def test_tick_due_runbooks_respects_cadence():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        stale_id = f"rb-stale-{uuid.uuid4().hex[:6]}"
        fresh_id = f"rb-fresh-{uuid.uuid4().hex[:6]}"
        try:
            stale_last = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
            fresh_last = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
            await db.runbooks.insert_many([
                {"id": stale_id, "company_id": cid, "enabled": True,
                 "schedule": "monthly", "last_run_at": stale_last,
                 "steps": [{"template_key": "cleanup_sweep", "config": {},
                            "on_fail": "continue"}]},
                {"id": fresh_id, "company_id": cid, "enabled": True,
                 "schedule": "monthly", "last_run_at": fresh_last,
                 "steps": [{"template_key": "cleanup_sweep", "config": {},
                            "on_fail": "continue"}]},
            ])
            launched = await agents_mod.tick_due_runbooks([cid], background=None)
            assert launched == 1
            stale = await db.runbooks.find_one({"id": stale_id})
            fresh = await db.runbooks.find_one({"id": fresh_id})
            assert stale["last_run_at"] != stale_last  # was executed
            assert fresh["last_run_at"] == fresh_last  # skipped
        finally:
            await _wipe(cid)
    _run(go())
