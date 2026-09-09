"""Client sign-off loop — end-to-end tests.

Covers the two paths a client can take on a monthly advisor report:
approve (creates client_signoffs, marks report client_approved_at) or
send-back-with-questions (creates client_questions + client_signoffs
with status=questioned).
"""
import uuid
import pytest
from datetime import datetime, timezone, timedelta

from tests._shared_loop import run as _run
from db import db


def _now(): return datetime.now(timezone.utc).isoformat()


async def _seed(cid: str, email: str) -> tuple[str, str]:
    """Seed a portal + a sent advisor report. Returns (portal_token, report_id)."""
    await db.companies.insert_one({"id": cid, "name": "SignoffTest", "created_at": _now()})
    token = f"tok-{uuid.uuid4().hex}"
    await db.client_portals.insert_one({
        "id": token, "company_id": cid,
        "client_email": email, "client_name": "Sam",
        "brand_snapshot": {"company_name": "SignoffTest", "primary_color": "#123456"},
        "created_at": _now(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "revoked_at": None,
    })
    rid = str(uuid.uuid4())
    await db.advisor_reports.insert_one({
        "id": rid, "company_id": cid, "period": "2026-01",
        "basis": "accrual",
        "kpis": {"revenue": 10000, "net_income": 2000, "cash": 5000},
        "narrative": {"revenue": "R", "expenses": "E", "position": "P"},
        "generated_at": _now(),
        "sent_to_client_at": _now(),
        "pdf_base64": "AAAA",
    })
    return token, rid


async def _cleanup(cid: str):
    for coll in ("companies", "client_portals", "advisor_reports",
                 "client_signoffs", "client_questions"):
        await db[coll].delete_many({"company_id": cid})


def test_portal_home_exposes_pending_signoff():
    async def go():
        from routes.client_portal import portal_home
        cid = str(uuid.uuid4())
        email = f"{uuid.uuid4().hex[:8]}@x.com"
        try:
            token, rid = await _seed(cid, email)
            r = await portal_home(token)
            assert len(r["pending_signoffs"]) == 1
            s = r["pending_signoffs"][0]
            assert s["report_id"] == rid
            assert s["period"] == "2026-01"
            assert s["status"] == "awaiting_approval"
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_signoff_approve_flips_state():
    async def go():
        from routes.client_portal import portal_signoff_approve, SignoffApproveIn, portal_home
        cid = str(uuid.uuid4())
        email = f"{uuid.uuid4().hex[:8]}@x.com"
        try:
            token, rid = await _seed(cid, email)
            r = await portal_signoff_approve(token, rid, SignoffApproveIn(note="LGTM"))
            assert r == {"status": "approved", "period": "2026-01"}

            # After approve, pending_signoffs should be empty.
            home = await portal_home(token)
            assert home["pending_signoffs"] == []

            # advisor_reports.client_approved_at should be set.
            rep = await db.advisor_reports.find_one({"id": rid})
            assert rep["client_approved_at"] is not None

            # client_signoffs row exists with correct shape.
            sig = await db.client_signoffs.find_one({"company_id": cid, "period": "2026-01"})
            assert sig["status"] == "approved"
            assert sig["note"] == "LGTM"
            assert sig["client_email"] == email
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_signoff_send_back_with_questions_creates_thread():
    async def go():
        from routes.client_portal import portal_signoff_question, SignoffQuestionIn
        cid = str(uuid.uuid4())
        email = f"{uuid.uuid4().hex[:8]}@x.com"
        try:
            token, rid = await _seed(cid, email)
            r = await portal_signoff_question(token, rid, SignoffQuestionIn(
                question="Why is marketing so high in January?",
            ))
            assert r["status"] == "questioned"
            assert r["question_id"]

            sig = await db.client_signoffs.find_one({"company_id": cid, "period": "2026-01"})
            assert sig["status"] == "questioned"
            assert sig["last_question_id"] == r["question_id"]

            q = await db.client_questions.find_one({"id": r["question_id"]})
            assert q["flow_type"] == "signoff_question"
            assert q["advisor_report_id"] == rid
            assert "marketing" in q["question"].lower()
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_signoff_rejects_report_not_sent():
    async def go():
        from routes.client_portal import portal_signoff_approve, SignoffApproveIn
        from fastapi import HTTPException
        cid = str(uuid.uuid4())
        email = f"{uuid.uuid4().hex[:8]}@x.com"
        try:
            token, rid = await _seed(cid, email)
            # Unsend the report.
            await db.advisor_reports.update_one({"id": rid}, {"$set": {"sent_to_client_at": None}})
            with pytest.raises(HTTPException) as exc:
                await portal_signoff_approve(token, rid, SignoffApproveIn(note=None))
            assert exc.value.status_code == 400
        finally:
            await _cleanup(cid)
    _run(go())


def test_close_card_exposes_signoff_state():
    async def go():
        from routes.cockpit import _close_card
        cid = str(uuid.uuid4())
        try:
            await db.companies.insert_one({"id": cid, "name": "T", "created_at": _now()})
            await db.client_signoffs.insert_one({
                "id": str(uuid.uuid4()),
                "company_id": cid, "period": "2026-01",
                "status": "approved", "approved_at": _now(),
            })
            card = await _close_card(cid, "T", None, 2026, 1)
            assert card["client_signoff"]["status"] == "approved"
            assert card["client_signoff"]["approved_at"]
        finally:
            await _cleanup(cid)
    _run(go())
