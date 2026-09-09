"""Cockpit Phase 5A — Agent Platform tests.

Covers:
  - Template catalog exposure
  - Cleanup Sweep detects uncategorized transactions
  - Portal Chase detects stale portal questions
  - Sign-off Reminder detects stale sign-offs
  - _run_agent persists a run + findings and updates the agent doc
  - tick_due_agents respects schedule cadence (idempotency guard)
  - Finding status patch (open → resolved)
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from tests._shared_loop import run as _run
from db import db
from routes.agents import (
    _TEMPLATES, _run_agent, tick_due_agents,
    _run_cleanup_sweep, _run_portal_chase, _run_signoff_reminder,
)


async def _cleanup(cid: str, agent_id: str | None = None):
    for coll in ("agents", "agent_runs", "agent_findings",
                 "transactions", "client_questions", "client_signoffs"):
        await db[coll].delete_many({"company_id": cid})
    if agent_id:
        await db.agents.delete_many({"id": agent_id})
        await db.agent_runs.delete_many({"agent_id": agent_id})
        await db.agent_findings.delete_many({"agent_id": agent_id})


def test_template_catalog_has_16_agents():
    """Locked in by the PRD — 6 starter templates + 10 Puzzle-parity additions."""
    keys = set(_TEMPLATES.keys())
    assert keys == {
        "cleanup_sweep", "je_auto_drafter", "advisor_report_send",
        "tax_1099_watcher", "portal_chase", "signoff_reminder",
        # Phase 5A.2 (Puzzle-parity)
        "txn_vendor_inconsistencies", "first_time_large_txn",
        "internal_transfers", "match_unpaid_bills", "match_unpaid_invoices",
        "missing_receipts", "variance_analysis", "profit_margin_analysis",
        "pdf_txn_import_watcher", "receipt_capture_watcher",
    }
    # every template exposes a `run` callable + default schedule + category
    for t in _TEMPLATES.values():
        assert callable(t["run"])
        assert t["default_schedule"] in {"hourly", "daily", "weekly", "monthly", "quarterly"}
        assert t.get("category"), f"Missing category on template {t.get('key')}"


def test_cleanup_sweep_finds_uncategorized_transactions():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            # 3 uncat'd, 2 flagged, 5 clean.
            for i in range(3):
                await db.transactions.insert_one({
                    "id": f"t-un-{i}", "company_id": cid, "account_id": None,
                    "amount": 10.0, "date": "2026-08-01",
                })
            for i in range(2):
                await db.transactions.insert_one({
                    "id": f"t-fl-{i}", "company_id": cid, "account_id": "acc1",
                    "needs_review": True, "amount": 20.0, "date": "2026-08-01",
                })
            for i in range(5):
                await db.transactions.insert_one({
                    "id": f"t-ok-{i}", "company_id": cid, "account_id": "acc1",
                    "amount": 30.0, "date": "2026-08-01",
                })
            agent = {"id": "a1", "template_key": "cleanup_sweep", "company_id": cid}
            findings = await _run_cleanup_sweep(cid, agent, {"min_uncategorized": 1})
            assert len(findings) == 1
            assert findings[0]["count"] == 5
            assert findings[0]["kind"] == "cleanup_sweep"
        finally:
            await _cleanup(cid)
    _run(go())


def test_cleanup_sweep_respects_threshold():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.transactions.insert_one({
                "id": "t-solo", "company_id": cid, "account_id": None,
                "amount": 10.0, "date": "2026-08-01",
            })
            agent = {"id": "a1", "template_key": "cleanup_sweep", "company_id": cid}
            findings = await _run_cleanup_sweep(cid, agent, {"min_uncategorized": 5})
            assert findings == []
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_chase_flags_stale_questions():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
            recent = datetime.now(timezone.utc).isoformat()
            await db.client_questions.insert_many([
                {"id": "q1", "company_id": cid, "status": "pending", "sent_at": old},
                {"id": "q2", "company_id": cid, "status": "pending", "sent_at": old},
                {"id": "q3", "company_id": cid, "status": "pending", "sent_at": recent},
                {"id": "q4", "company_id": cid, "status": "answered", "sent_at": old},
            ])
            findings = await _run_portal_chase(cid, {"id": "a"}, {"stale_days": 3})
            assert len(findings) == 1
            assert findings[0]["count"] == 2
        finally:
            await _cleanup(cid)
    _run(go())


def test_signoff_reminder_only_waiting_status():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            old = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()
            await db.client_signoffs.insert_many([
                {"id": "s1", "company_id": cid, "status": "waiting", "sent_at": old},
                {"id": "s2", "company_id": cid, "status": "approved", "sent_at": old},
            ])
            findings = await _run_signoff_reminder(cid, {"id": "a"}, {"stale_days": 3})
            assert len(findings) == 1
            assert findings[0]["count"] == 1
        finally:
            await _cleanup(cid)
    _run(go())


def test_run_agent_persists_run_findings_and_updates_agent():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        agent_id = f"agent-{uuid.uuid4().hex[:8]}"
        try:
            await db.transactions.insert_one({
                "id": "t1", "company_id": cid, "account_id": None,
                "amount": 10.0, "date": "2026-08-01",
            })
            agent = {
                "id": agent_id, "template_key": "cleanup_sweep",
                "company_id": cid, "schedule": "daily",
                "enabled": True, "config": {"min_uncategorized": 1},
            }
            await db.agents.insert_one(agent)
            result = await _run_agent(agent, triggered_by="test")
            assert result["ok"] is True
            assert result["findings_count"] == 1

            runs = await db.agent_runs.find({"agent_id": agent_id}).to_list(10)
            assert len(runs) == 1
            assert runs[0]["status"] == "success"
            assert runs[0]["findings_count"] == 1

            findings = await db.agent_findings.find({"agent_id": agent_id}).to_list(10)
            assert len(findings) == 1
            assert findings[0]["status"] == "open"

            refreshed = await db.agents.find_one({"id": agent_id})
            assert refreshed["last_run_status"] == "success"
            assert refreshed["last_findings_count"] == 1
        finally:
            await _cleanup(cid, agent_id)
    _run(go())


def test_tick_due_agents_respects_cadence():
    """A daily agent that ran 1 hour ago should NOT be re-run; one that
    ran 25 hours ago SHOULD be. Uses the sync path (background=None)."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        recent_id = f"agent-recent-{uuid.uuid4().hex[:8]}"
        stale_id = f"agent-stale-{uuid.uuid4().hex[:8]}"
        try:
            await db.transactions.insert_one({
                "id": "t1", "company_id": cid, "account_id": None,
                "amount": 10.0, "date": "2026-08-01",
            })
            recent_last = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
            stale_last = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
            await db.agents.insert_many([
                {"id": recent_id, "template_key": "cleanup_sweep",
                 "company_id": cid, "schedule": "daily", "enabled": True,
                 "config": {"min_uncategorized": 1}, "last_run_at": recent_last},
                {"id": stale_id, "template_key": "cleanup_sweep",
                 "company_id": cid, "schedule": "daily", "enabled": True,
                 "config": {"min_uncategorized": 1}, "last_run_at": stale_last},
            ])
            launched = await tick_due_agents([cid], background=None)
            assert launched == 1
            recent = await db.agents.find_one({"id": recent_id})
            stale = await db.agents.find_one({"id": stale_id})
            # Recent should NOT have moved.
            assert recent["last_run_at"] == recent_last
            # Stale WAS re-run.
            assert stale["last_run_at"] != stale_last
        finally:
            await _cleanup(cid, recent_id)
            await _cleanup(cid, stale_id)
    _run(go())


def test_finding_run_carries_severity_and_action():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            for i in range(30):
                await db.transactions.insert_one({
                    "id": f"t-{i}", "company_id": cid, "account_id": None,
                    "amount": 5.0, "date": "2026-08-01",
                })
            agent = {"id": "a", "template_key": "cleanup_sweep", "company_id": cid}
            findings = await _run_cleanup_sweep(cid, agent, {"min_uncategorized": 1})
            assert findings[0]["severity"] == "red"  # ≥25 flips red
            assert "Cleanup" in findings[0]["action_label"]
            assert findings[0]["action_route"].startswith("/accounting")
        finally:
            await _cleanup(cid)
    _run(go())
