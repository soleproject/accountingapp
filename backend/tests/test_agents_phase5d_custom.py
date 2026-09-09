"""Phase 5D — From-scratch custom agents."""
import uuid
import pytest
from unittest.mock import patch

from tests._shared_loop import run as _run
from db import db
from routes import agents as agents_mod


async def _wipe(cid: str):
    for coll in ("agents", "agent_runs", "agent_findings",
                 "transactions", "bills", "invoices"):
        await db[coll].delete_many({"company_id": cid})


def test_tool_catalog_exposes_eight_slices():
    keys = set(agents_mod.TOOL_CATALOG.keys())
    assert keys == {
        "transactions.recent", "transactions.uncategorized",
        "bills.open", "invoices.open", "receipts.recent",
        "journal_entries.recent",
        "reports.income_statement", "reports.balance_sheet",
    }
    for t in agents_mod.TOOL_CATALOG.values():
        assert callable(t["fetch"])
        assert t.get("label")
        assert t.get("description")


def test_custom_agent_run_short_circuits_when_prompt_or_tools_missing():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            # Missing prompt
            findings = await agents_mod._run_custom_agent(
                cid, {"custom_definition": {"tools": ["bills.open"]}}, {}
            )
            assert findings == []
            # Missing tools
            findings = await agents_mod._run_custom_agent(
                cid, {"custom_definition": {"prompt": "hello"}}, {}
            )
            assert findings == []
        finally:
            await _wipe(cid)
    _run(go())


def test_custom_agent_run_parses_llm_json_into_finding():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            fake = '{"title": "$5,000 in unpaid bills exceeds $2,000 in AR", "detail": "AP is 2.5x AR — cash risk.", "severity": "amber", "action_label": "Review AP", "action_route": "/accounting/bills"}'
            async def _mock(*a, **kw):
                return fake
            with patch.object(agents_mod, "_llm_ask", side_effect=_mock):
                findings = await agents_mod._run_custom_agent(
                    cid,
                    {"custom_definition": {
                        "prompt": "Check AP vs AR imbalance",
                        "tools": ["bills.open", "invoices.open"],
                    }},
                    {},
                )
            assert len(findings) == 1
            f = findings[0]
            assert f["kind"] == "custom_agent"
            assert f["severity"] == "amber"
            assert "unpaid bills" in f["title"]
            assert f["action_route"].startswith("/accounting")
        finally:
            await _wipe(cid)
    _run(go())


def test_custom_agent_run_respects_skip_flag():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            async def _mock(*a, **kw):
                return '{"skip": true}'
            with patch.object(agents_mod, "_llm_ask", side_effect=_mock):
                findings = await agents_mod._run_custom_agent(
                    cid,
                    {"custom_definition": {
                        "prompt": "Check something",
                        "tools": ["bills.open"],
                    }},
                    {},
                )
            assert findings == []
        finally:
            await _wipe(cid)
    _run(go())


def test_custom_agent_run_sanitizes_bad_action_route():
    """LLM must NOT be able to inject arbitrary routes."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            fake = '{"title": "test", "detail": "d", "severity": "blue", "action_label": "go", "action_route": "https://evil.com/steal"}'
            async def _mock(*a, **kw):
                return fake
            with patch.object(agents_mod, "_llm_ask", side_effect=_mock):
                findings = await agents_mod._run_custom_agent(
                    cid,
                    {"custom_definition": {"prompt": "hi", "tools": ["bills.open"]}},
                    {},
                )
            assert len(findings) == 1
            assert findings[0]["action_route"] == "/cockpit/agents"
        finally:
            await _wipe(cid)
    _run(go())


def test_template_catalog_still_hides_custom():
    """The `__custom__` template must remain hidden from the library API."""
    assert "__custom__" in agents_mod._TEMPLATES
    assert agents_mod._TEMPLATES["__custom__"].get("hidden") is True
