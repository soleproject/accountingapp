"""Phase 5A.3 — LLM Insight Trio (Key Business Insight, What's Going Well,
Board Meeting Prep).

We patch `_llm_ask` to return None so the deterministic fallback branch
runs deterministically in CI. Real LLM output is exercised via the
existing advisor-report smoke tests.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from tests._shared_loop import run as _run
from db import db
from routes import agents as agents_mod


async def _seed_company_with_kpis(cid: str, period: str = "2026-08"):
    """Minimal fixture so `_generate_report_data` returns non-empty KPIs."""
    await db.companies.insert_one({"id": cid, "name": "TestCo"})
    await db.accounts.insert_many([
        {"id": f"{cid}-rev", "code": "4000", "company_id": cid,
         "name": "Service Revenue", "type": "revenue", "active": True},
        {"id": f"{cid}-exp", "code": "6100", "company_id": cid,
         "name": "Rent Expense", "type": "expense", "active": True},
    ])
    await db.journal_entries.insert_one({
        "id": f"{cid}-je1", "company_id": cid,
        "date": f"{period}-15", "posted": True,
        "lines": [
            {"account_id": f"{cid}-rev", "debit": 0, "credit": 12000},
            {"account_id": f"{cid}-exp", "debit": 3000, "credit": 0},
        ],
    })


async def _wipe_company(cid: str):
    for coll in ("companies", "accounts", "journal_entries",
                 "advisor_reports", "transactions"):
        await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_many({"id": cid})
    await db.accounts.delete_many({"id": {"$regex": f"^{cid}-"}})


def test_key_business_insight_falls_back_when_llm_fails():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await _seed_company_with_kpis(cid)
            with patch.object(agents_mod, "_llm_ask", return_value=None):
                findings = await agents_mod._run_key_business_insight(
                    cid, {"id": "a"}, {"period": "2026-08"}
                )
            assert len(findings) == 1
            assert findings[0]["kind"] == "key_business_insight"
            assert findings[0]["severity"] == "blue"
            # Fallback narrative always mentions a revenue number.
            assert "$" in findings[0]["detail"]
        finally:
            await _wipe_company(cid)
    _run(go())


def test_key_business_insight_uses_llm_when_available():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await _seed_company_with_kpis(cid)
            fake = '{"insight": "Revenue grew 25% while gross margin held steady at 75%.", "email": "Hi — the numbers look great this month."}'
            async def _mock(*a, **kw):
                return fake
            with patch.object(agents_mod, "_llm_ask", side_effect=_mock):
                findings = await agents_mod._run_key_business_insight(
                    cid, {"id": "a"}, {"period": "2026-08"}
                )
            assert len(findings) == 1
            assert "25%" in findings[0]["detail"]
            assert "email" in findings[0]["meta"]
            assert "Hi — the numbers" in findings[0]["meta"]["email"]
        finally:
            await _wipe_company(cid)
    _run(go())


def test_whats_going_well_produces_bright_spots():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await _seed_company_with_kpis(cid)
            fake = '{"bright_spots": ["Revenue was $12,000.", "Margin at 75%.", "Cash flow positive.", "OPEX in check.", "Clean books."]}'
            async def _mock(*a, **kw):
                return fake
            with patch.object(agents_mod, "_llm_ask", side_effect=_mock):
                findings = await agents_mod._run_whats_going_well(
                    cid, {"id": "a"}, {"period": "2026-08"}
                )
            assert len(findings) == 1
            assert findings[0]["count"] == 5
            assert len(findings[0]["meta"]["bright_spots"]) == 5
        finally:
            await _wipe_company(cid)
    _run(go())


def test_whats_going_well_falls_back_to_kpis():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await _seed_company_with_kpis(cid)
            with patch.object(agents_mod, "_llm_ask", return_value=None):
                findings = await agents_mod._run_whats_going_well(
                    cid, {"id": "a"}, {"period": "2026-08"}
                )
            assert len(findings) == 1
            assert findings[0]["count"] >= 3
        finally:
            await _wipe_company(cid)
    _run(go())


def test_board_meeting_prep_notes_missing_advisor_pack():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await _seed_company_with_kpis(cid)
            with patch.object(agents_mod, "_llm_ask", return_value=None):
                findings = await agents_mod._run_board_meeting_prep(
                    cid, {"id": "a"}, {"period": "2026-08"}
                )
            assert len(findings) == 1
            f = findings[0]
            assert f["kind"] == "board_meeting_prep"
            # No advisor_reports row exists → note appended to detail.
            assert "Advisor pack not yet generated" in f["detail"]
            assert f["meta"]["advisor_pack_ready"] is False
        finally:
            await _wipe_company(cid)
    _run(go())


def test_board_meeting_prep_when_advisor_pack_exists():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await _seed_company_with_kpis(cid)
            await db.advisor_reports.insert_one({
                "id": f"{cid}-r1", "company_id": cid, "period": "2026-08",
                "kpis": {}, "narrative": {},
                "generated_at": datetime.now(timezone.utc).isoformat(),
            })
            fake = '{"talking_points": ["Revenue $12k, up 20%", "Margin 75%", "Cash strong"]}'
            async def _mock(*a, **kw):
                return fake
            with patch.object(agents_mod, "_llm_ask", side_effect=_mock):
                findings = await agents_mod._run_board_meeting_prep(
                    cid, {"id": "a"}, {"period": "2026-08"}
                )
            f = findings[0]
            assert f["meta"]["advisor_pack_ready"] is True
            assert "Advisor pack not yet generated" not in f["detail"]
            assert len(f["meta"]["talking_points"]) == 3
        finally:
            await _wipe_company(cid)
    _run(go())
