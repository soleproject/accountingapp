"""Voice actions — Phase 1 (Feb 2026).

Covers:
  • parse (with hybrid model fallback mocked)
  • parse cache short-circuits the LLM on repeat utterances
  • unknown intent returns cleanly
  • clarifications flag missing when-time / missing-contact
  • execute → create_task / create_appointment persist correctly
  • completed listing + undo within window / rejected past window
"""
from __future__ import annotations
import sys, uuid, json
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _env():
    uid, cid = str(uuid.uuid4()), str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "Sam Owner",
    })
    await db.companies.insert_one({
        "id": cid, "name": "VoiceCo", "created_at": "2026-01-01T00:00:00Z",
    })
    await db.memberships.insert_one({"user_id": uid, "company_id": cid, "role": "owner"})
    return uid, cid, create_token(uid, "client")


async def _cleanup(uid, cid):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})
    await db.tasks.delete_many({"company_id": cid})
    await db.contacts.delete_many({"company_id": cid})
    await db.completed_actions.delete_many({"company_id": cid})
    await db.voice_parse_cache.delete_many({})  # cache is global-keyed


# ── parse ─────────────────────────────────────────────────────────

def test_parse_create_task_resolves_contact_and_assignee():
    async def _t():
        uid, cid, tok = await _env()
        try:
            alice_id = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": alice_id, "company_id": cid,
                "name": "Alice Kim", "email": "alice@example.com",
                "created_at": "2026-01-01T00:00:00Z",
            })
            fake = {
                "intent": "create_task", "confidence": 0.95,
                "entities": {
                    "title": "Send SOW to Alice",
                    "assignee_hint": "me",
                    "contact_hint": "Alice",
                    "when_hint": "friday",
                    "iso_datetime": "2026-03-06T17:00:00+00:00",
                    "duration_min": None,
                    "priority": "medium",
                },
                "clarifications": [],
                "preview": "Task: Send SOW to Alice — Fri",
            }
            with patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "Create a task for Alice to send the SOW by Friday",
                           "company_id": cid},
                )
                assert r.status_code == 200, r.text
                d = r.json()
            assert d["intent"] == "create_task"
            assert d["resolution"]["contact"]["id"] == alice_id
            assert d["resolution"]["assignee"]["id"] == uid
            assert d["clarifications"] == []  # both resolved
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_flags_missing_contact_as_clarification():
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "intent": "create_task", "confidence": 0.9,
                "entities": {
                    "title": "Send SOW to Bob",
                    "contact_hint": "Bob",
                    "priority": "medium",
                },
                "clarifications": [],
                "preview": "Task: Send SOW to Bob",
            }
            with patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "Create a task to send Bob the SOW",
                           "company_id": cid},
                )
            d = r.json()
            assert d["resolution"]["contact"] is None
            fields = [c["field"] for c in d["clarifications"]]
            assert "contact" in fields
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_appointment_without_time_gets_when_clarification():
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "intent": "create_appointment", "confidence": 0.9,
                "entities": {"title": "Sync with Alice", "duration_min": 30},
                "clarifications": [],
                "preview": "Meeting: Sync with Alice",
            }
            with patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "schedule a call with Alice", "company_id": cid},
                )
            fields = [c["field"] for c in r.json()["clarifications"]]
            assert "when" in fields
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_cache_short_circuits_llm_on_repeat():
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "intent": "create_task", "confidence": 0.95,
                "entities": {"title": "Follow up",
                              "assignee_hint": "me",
                              "priority": "medium"},
                "clarifications": [], "preview": "Task: Follow up",
            }
            call_count = {"n": 0}
            async def _mock_parser(*a, **k):
                call_count["n"] += 1
                return {**fake, "_model": "gpt-5-mini"}
            with patch("routes.voice_actions._run_parser", new=_mock_parser):
                client = await _client()
                for _ in range(3):
                    r = await client.post(
                        "/api/voice/actions/parse",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"text": "Create a task to follow up",
                               "company_id": cid},
                    )
                    assert r.status_code == 200
            # LLM only called once thanks to the 5-min cache.
            assert call_count["n"] == 1
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_unknown_intent_is_not_cached():
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {"intent": "unknown", "confidence": 0.0,
                     "entities": {}, "clarifications": [], "preview": ""}
            call_count = {"n": 0}
            async def _mock_parser(*a, **k):
                call_count["n"] += 1
                return fake
            with patch("routes.voice_actions._run_parser", new=_mock_parser):
                client = await _client()
                for _ in range(2):
                    await client.post(
                        "/api/voice/actions/parse",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"text": "asdf bogus utterance",
                               "company_id": cid},
                    )
            # Both calls hit the LLM (no cache on unknown).
            assert call_count["n"] == 2
        finally:
            await _cleanup(uid, cid)
    _run(_t())


# ── execute ───────────────────────────────────────────────────────

def test_execute_create_task_persists_row_and_completed_action():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={
                    "company_id": cid,
                    "intent": "create_task",
                    "entities": {
                        "title": "Draft renewal quote",
                        "priority": "high",
                        "iso_datetime": "2026-03-06T22:00:00+00:00",
                    },
                    "resolution": {
                        "contact":  {"id": "c1", "name": "Alice Kim"},
                        "assignee": {"id": uid, "name": "Sam Owner"},
                    },
                    "original_text": "remind me to draft the renewal quote friday 5pm",
                },
            )
            assert r.status_code == 200, r.text
            action = r.json()["action"]
            assert action["target_type"] == "task"
            t = await db.tasks.find_one({"id": action["target_id"]})
            assert t["title"] == "Draft renewal quote"
            assert t["priority"] == "high"
            assert t["due_date"] == "2026-03-06"
            assert t["due_time"] == "22:00"
            assert t["contact_id"] == "c1"
            assert t["created_via"] == "voice"
            # Completed action row exists
            c = await db.completed_actions.find_one({"id": action["id"]})
            assert c is not None
            assert c["intent"] == "create_task"
            assert c["status"] == "completed"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_create_appointment_requires_time():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={
                    "company_id": cid,
                    "intent": "create_appointment",
                    "entities": {"title": "Sync with Alice", "duration_min": 45},
                    "resolution": {},
                    "original_text": "meet with alice",
                },
            )
            assert r.status_code == 400
            assert "iso_datetime" in r.text.lower()
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_create_appointment_persists_start_and_end():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={
                    "company_id": cid,
                    "intent": "create_appointment",
                    "entities": {
                        "title": "Renewal call with Alice",
                        "duration_min": 45,
                        "iso_datetime": "2026-03-06T15:00:00+00:00",
                    },
                    "resolution": {
                        "contact":  {"id": "c1", "name": "Alice Kim"},
                        "assignee": {"id": uid, "name": "Sam Owner"},
                    },
                    "original_text": "schedule a 45 min renewal call with alice at 3pm friday",
                },
            )
            assert r.status_code == 200, r.text
            action = r.json()["action"]
            assert action["target_type"] == "appointment"
            t = await db.tasks.find_one({"id": action["target_id"]})
            assert t["kind"] == "meeting"
            assert t["duration_min"] == 45
            assert t["start_iso"].startswith("2026-03-06T15:00:00")
            assert t["end_iso"].startswith("2026-03-06T15:45:00")
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_rejects_unsupported_intent():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "close_the_books",
                       "entities": {}, "resolution": {}},
            )
            assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)
    _run(_t())


# ── completed listing + undo ─────────────────────────────────────

def test_completed_lists_only_own_and_scrubs_mongo_id():
    async def _t():
        uid, cid, tok = await _env()
        uid2 = str(uuid.uuid4())
        try:
            # Own action
            await db.completed_actions.insert_one({
                "id": "a1", "user_id": uid, "company_id": cid,
                "intent": "create_task", "target_id": "t1", "target_type": "task",
                "summary": "Own task", "status": "completed",
                "created_at": "2026-02-28T00:00:00Z",
            })
            # Someone else's action in same company — should NOT leak
            await db.completed_actions.insert_one({
                "id": "a2", "user_id": uid2, "company_id": cid,
                "intent": "create_task", "target_id": "t2", "target_type": "task",
                "summary": "Not mine", "status": "completed",
                "created_at": "2026-02-28T00:00:00Z",
            })
            client = await _client()
            r = await client.get(
                "/api/voice/actions/completed",
                headers={"Authorization": f"Bearer {tok}"},
                params={"company_id": cid},
            )
            actions = r.json()["actions"]
            assert [a["id"] for a in actions] == ["a1"]
            assert "_id" not in actions[0]
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_undo_within_window_deletes_task_and_marks_undone():
    async def _t():
        uid, cid, tok = await _env()
        try:
            # First create a real task via execute
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "create_task",
                       "entities": {"title": "Undo test"},
                       "resolution": {}},
            )
            action_id = r.json()["action"]["id"]
            target_id = r.json()["action"]["target_id"]
            # Task exists
            assert await db.tasks.find_one({"id": target_id}) is not None
            r2 = await client.post(
                f"/api/voice/actions/{action_id}/undo",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r2.status_code == 200
            # Task gone; action marked undone
            assert await db.tasks.find_one({"id": target_id}) is None
            a = await db.completed_actions.find_one({"id": action_id})
            assert a["status"] == "undone"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_undo_past_window_returns_400():
    async def _t():
        uid, cid, tok = await _env()
        try:
            past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
            await db.completed_actions.insert_one({
                "id": "a-stale", "user_id": uid, "company_id": cid,
                "intent": "create_task", "target_id": "t-stale", "target_type": "task",
                "summary": "Old", "status": "completed",
                "undo_deadline": past,
                "created_at": past,
            })
            await db.tasks.insert_one({"id": "t-stale", "company_id": cid,
                                          "title": "Stale", "created_at": past})
            client = await _client()
            r = await client.post(
                "/api/voice/actions/a-stale/undo",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 400
            # Task still exists (undo refused)
            assert await db.tasks.find_one({"id": "t-stale"}) is not None
        finally:
            await _cleanup(uid, cid)
    _run(_t())


# ── recap (Phase 1.5) ────────────────────────────────────────────

def test_parse_recap_extracts_structure_and_resolves_contact():
    async def _t():
        uid, cid, tok = await _env()
        try:
            alice_id = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": alice_id, "company_id": cid,
                "name": "Alice Kim", "email": "alice@example.com",
                "created_at": "2026-01-01T00:00:00Z",
            })
            fake = {
                "meeting": {
                    "contact_hint": "Alice",
                    "when_hint": "just now",
                    "activity_time_iso": "2026-02-28T15:00:00+00:00",
                    "title": "Renewal call with Alice",
                    "summary": "Alice pushing back on pricing; multi-year quote needed.",
                    "notes": "",
                },
                "tasks": [
                    {"title": "Send multi-year pricing quote to Alice",
                      "assignee_hint": "me", "due_iso": "2026-03-06T22:00:00+00:00",
                      "priority": "high"},
                    {"title": "Book follow-up call",
                      "assignee_hint": "me", "due_iso": "2026-03-10T15:00:00+00:00",
                      "priority": "medium"},
                ],
                "emails": [
                    {"to_hint": "Alice", "to_email": None,
                      "subject": "Nexxsuite renewal — multi-year pricing",
                      "body":  "Hi Alice,\n\nThanks for the call today..."},
                ],
                "questions": [],
            }
            with patch("routes.voice_actions._run_recap_parser",
                       new=AsyncMock(return_value=fake)), \
                 patch("routes.voice_actions._find_linked_gcal_event",
                       new=AsyncMock(return_value=None)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse-recap",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "I just had a call with Alice — she's pushing back on pricing, need to send her a multi-year quote by Friday and book a follow-up.",
                           "company_id": cid},
                )
                assert r.status_code == 200, r.text
                d = r.json()
            # Contact resolved
            assert d["meeting"]["resolved_contact"]["id"] == alice_id
            # Assignees resolved to current user for "me"
            assert d["tasks"][0]["assignee"]["id"] == uid
            # Email recipient falls back to meeting contact
            assert d["emails"][0]["recipient"]["email"] == "alice@example.com"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_recap_flags_missing_contact():
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "meeting": {"contact_hint": "Bob", "title": "Q4 planning",
                              "summary": "..."},
                "tasks": [], "emails": [], "questions": [],
            }
            with patch("routes.voice_actions._run_recap_parser",
                       new=AsyncMock(return_value=fake)), \
                 patch("routes.voice_actions._find_linked_gcal_event",
                       new=AsyncMock(return_value=None)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse-recap",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "I just spoke with Bob about Q4 planning.",
                           "company_id": cid},
                )
            d = r.json()
            assert d["meeting"]["resolved_contact"] is None
            assert any("Bob" in q for q in d["questions"])
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_recap_too_short_returns_400():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/parse-recap",
                headers={"Authorization": f"Bearer {tok}"},
                json={"text": "hi", "company_id": cid},
            )
            assert r.status_code == 400
            assert "too short" in r.text.lower()
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_recap_creates_activity_tasks_and_email_drafts():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute-recap",
                headers={"Authorization": f"Bearer {tok}"},
                json={
                    "company_id": cid,
                    "meeting": {
                        "title": "Renewal call with Alice",
                        "summary": "Alice needs multi-year quote.",
                        "activity_time_iso": "2026-02-28T15:00:00+00:00",
                        "resolved_contact": {"id": "c1", "name": "Alice", "email": "a@ex.com"},
                        "linked_gcal_event": None,
                    },
                    "tasks": [
                        {"title": "Send SOW",
                          "assignee": {"id": uid, "name": "Sam"},
                          "due_iso": "2026-03-06T22:00:00+00:00",
                          "priority": "high"},
                        {"title": "Book follow-up",
                          "assignee": None,
                          "due_iso": None,
                          "priority": "medium"},
                    ],
                    "emails": [
                        {"recipient": {"email": "a@ex.com", "name": "Alice"},
                          "subject": "Renewal quote",
                          "body":    "Hi Alice, ...",
                          "disposition": "draft"},
                    ],
                    "original_text": "I just spoke with alice…",
                },
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert a["intent"] == "meeting_recap"
            # Activity persisted
            act = await db.contact_activities.find_one({"id": r.json()["activity_id"]})
            assert act is not None
            assert act["title"] == "Renewal call with Alice"
            # 2 tasks persisted with source_activity_id
            n = await db.tasks.count_documents({
                "company_id": cid, "source_activity_id": act["id"]
            })
            assert n == 2
            # 1 email as draft
            em = await db.recap_emails.find_one({"source_activity_id": act["id"]})
            assert em is not None
            assert em["status"] == "draft"
            assert em["to_email"] == "a@ex.com"
            # Completed action log
            comp = await db.completed_actions.find_one({"id": a["id"]})
            assert comp["intent"] == "meeting_recap"
            assert len(comp["task_ids"]) == 2
            assert len(comp["draft_email_ids"]) == 1
        finally:
            await db.contact_activities.delete_many({"company_id": cid})
            await db.recap_emails.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


# ── send_meeting_link / send_calendar_link ────────────────────────

def test_execute_send_calendar_link_drafts_email_with_booking_url():
    async def _t():
        uid, cid, tok = await _env()
        try:
            await db.user_booking_settings.insert_one({
                "user_id": uid, "slug": "sam-owner",
                "display_name": "Sam Owner",
                "default_meeting_link_type": "google_meet",
                "static_link_url": "",
                "working_hours_start": 9, "working_hours_end": 17,
                "working_days": [0,1,2,3,4], "duration_min": 30,
                "timezone": "UTC",
                "created_at": now_iso_import(), "updated_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "send_calendar_link",
                       "entities": {"title": "Send Alice my booking link",
                                     "contact_hint": "Alice"},
                       "resolution": {
                           "contact": {"id": "c1", "name": "Alice Kim",
                                        "email": "alice@example.com"},
                       },
                       "original_text": "send alice my booking link"},
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert a["target_type"] == "email_draft"
            em = await db.recap_emails.find_one({"id": a["target_id"]})
            assert em is not None
            assert em["status"] == "draft"
            assert em["to_email"] == "alice@example.com"
            assert "/book/sam-owner" in em["link_url"]
            assert "/book/sam-owner" in em["body"]
            assert em["subject"].startswith("Book time with")
        finally:
            await db.user_booking_settings.delete_many({"user_id": uid})
            await db.recap_emails.delete_many({"user_id": uid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_send_meeting_link_uses_static_zoom_url():
    async def _t():
        uid, cid, tok = await _env()
        try:
            await db.user_booking_settings.insert_one({
                "user_id": uid, "slug": "sam",
                "display_name": "Sam",
                "default_meeting_link_type": "zoom",
                "static_link_url": "https://zoom.us/j/12345",
                "working_hours_start": 9, "working_hours_end": 17,
                "working_days": [0,1,2,3,4], "duration_min": 30,
                "timezone": "UTC",
                "created_at": now_iso_import(), "updated_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "send_meeting_link",
                       "entities": {"title": "Send Bob my zoom link",
                                     "contact_hint": "Bob"},
                       "resolution": {
                           "contact": {"id": "c2", "name": "Bob McKenzie",
                                        "email": "bob@ex.com"},
                       }},
            )
            assert r.status_code == 200
            em = await db.recap_emails.find_one({"user_id": uid})
            assert em["link_url"] == "https://zoom.us/j/12345"
            assert "https://zoom.us/j/12345" in em["body"]
        finally:
            await db.user_booking_settings.delete_many({"user_id": uid})
            await db.recap_emails.delete_many({"user_id": uid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_send_meeting_link_400_when_zoom_url_missing():
    async def _t():
        uid, cid, tok = await _env()
        try:
            await db.user_booking_settings.insert_one({
                "user_id": uid, "slug": "sam",
                "default_meeting_link_type": "zoom",   # picked zoom
                "static_link_url": "",                   # …but no URL saved
                "working_hours_start": 9, "working_hours_end": 17,
                "working_days": [0,1,2,3,4], "duration_min": 30,
                "created_at": now_iso_import(), "updated_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "send_meeting_link",
                       "entities": {"contact_hint": "Bob"},
                       "resolution": {"contact": {"email": "b@x.com"}}},
            )
            assert r.status_code == 400
            assert "haven't set a URL" in r.text
        finally:
            await db.user_booking_settings.delete_many({"user_id": uid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_send_link_400_when_settings_missing():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "send_calendar_link",
                       "entities": {"contact_hint": "X"},
                       "resolution": {"contact": {"email": "x@x.com"}}},
            )
            assert r.status_code == 400
            assert "haven't set up your meeting links" in r.text
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def now_iso_import():
    from db import now_iso as _n
    return _n()



def test_execute_recap_saves_as_draft_when_no_recipient_email():
    """User picked 'send' but recipient has no email — must fall back to draft (never fail)."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute-recap",
                headers={"Authorization": f"Bearer {tok}"},
                json={
                    "company_id": cid,
                    "meeting": {"title": "Chat with unknown", "summary": "..."},
                    "tasks": [],
                    "emails": [
                        {"recipient": {"name": "Nobody"},
                          "subject": "hi", "body": "hey",
                          "disposition": "send"},   # user picked send but no email
                    ],
                },
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert len(a["draft_email_ids"]) == 1
            assert len(a["sent_email_ids"]) == 0
        finally:
            await db.contact_activities.delete_many({"company_id": cid})
            await db.recap_emails.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())



# ══════════════════════════════════════════════════════════════════
# Phase 3 (Feb 2026) — log_call, move_deal_stage, follow_up_reminder,
#                        snooze_task, draft_proposal
# ══════════════════════════════════════════════════════════════════

def test_execute_log_call_creates_contact_activity():
    async def _t():
        uid, cid, tok = await _env()
        try:
            alice_id = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": alice_id, "company_id": cid,
                "name": "Alice Kim", "email": "alice@example.com",
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "log_call",
                       "entities": {
                           "title": "Call with Alice",
                           "contact_hint": "Alice",
                           "notes": "Talked pricing, she's in.",
                           "outcome": "connected",
                       },
                       "resolution": {
                           "contact": {"id": alice_id, "name": "Alice Kim",
                                        "email": "alice@example.com"},
                       }},
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert a["target_type"] == "call_log"
            act = await db.contact_activities.find_one({"id": a["target_id"]})
            assert act is not None
            assert act["kind"] == "call"
            assert act["contact_id"] == alice_id
            assert "pricing" in act["notes"]
            assert act["outcome"] == "connected"
        finally:
            await db.contact_activities.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_log_call_400_without_resolved_contact_is_allowed():
    """log_call is still valid with no contact — it becomes a generic phone log."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "log_call",
                       "entities": {"notes": "quick chat"},
                       "resolution": {}},
            )
            assert r.status_code == 200
            a = r.json()["action"]
            assert a["target_type"] == "call_log"
        finally:
            await db.contact_activities.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_move_deal_stage_updates_deal_and_stamps_activity():
    async def _t():
        uid, cid, tok = await _env()
        try:
            did = str(uuid.uuid4())
            await db.deals.insert_one({
                "id": did, "company_id": cid, "title": "Acme Renewal",
                "stage": "qualified", "order": 1000.0,
                "probability": 25, "value": 5000,
                "activities": [],
                "created_at": now_iso_import(), "updated_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "move_deal_stage",
                       "entities": {"deal_hint": "Acme",
                                     "new_stage": "negotiation"},
                       "resolution": {
                           "deal": {"id": did, "title": "Acme Renewal",
                                     "stage": "qualified", "activities": []},
                       }},
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert a["target_type"] == "deal_move"
            fresh = await db.deals.find_one({"id": did})
            assert fresh["stage"] == "negotiation"
            kinds = [x.get("kind") for x in (fresh.get("activities") or [])]
            assert "stage_change" in kinds
        finally:
            await db.deals.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_move_deal_stage_won_sets_probability_100():
    async def _t():
        uid, cid, tok = await _env()
        try:
            did = str(uuid.uuid4())
            await db.deals.insert_one({
                "id": did, "company_id": cid, "title": "Big One",
                "stage": "negotiation", "order": 1000.0,
                "probability": 75, "activities": [],
                "created_at": now_iso_import(), "updated_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "move_deal_stage",
                       "entities": {"new_stage": "won"},
                       "resolution": {
                           "deal": {"id": did, "title": "Big One",
                                     "stage": "negotiation", "activities": []}}},
            )
            assert r.status_code == 200
            fresh = await db.deals.find_one({"id": did})
            assert fresh["stage"] == "won"
            assert fresh["probability"] == 100
        finally:
            await db.deals.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_move_deal_stage_400_when_unresolved():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "move_deal_stage",
                       "entities": {"deal_hint": "ghost", "new_stage": "won"},
                       "resolution": {}},
            )
            assert r.status_code == 400
            assert "not resolved" in r.text.lower()
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_move_deal_stage_400_on_invalid_stage():
    async def _t():
        uid, cid, tok = await _env()
        try:
            did = str(uuid.uuid4())
            await db.deals.insert_one({
                "id": did, "company_id": cid, "title": "X",
                "stage": "lead", "order": 1.0, "activities": [],
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "move_deal_stage",
                       "entities": {"new_stage": "closed"},
                       "resolution": {"deal": {"id": did, "title": "X",
                                                 "stage": "lead"}}},
            )
            assert r.status_code == 400
            assert "invalid stage" in r.text.lower()
        finally:
            await db.deals.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_follow_up_reminder_creates_task_with_follow_up_kind():
    async def _t():
        uid, cid, tok = await _env()
        try:
            alice_id = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": alice_id, "company_id": cid,
                "name": "Alice Kim", "email": "a@x.com",
                "created_at": now_iso_import(),
            })
            iso = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "follow_up_reminder",
                       "entities": {"contact_hint": "Alice",
                                     "iso_datetime": iso},
                       "resolution": {
                           "contact": {"id": alice_id, "name": "Alice Kim"},
                       }},
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert a["target_type"] == "follow_up"
            t = await db.tasks.find_one({"id": a["target_id"]})
            assert t["kind"] == "follow_up"
            assert t["contact_id"] == alice_id
            assert t["title"].startswith("Follow up with")
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_snooze_task_by_days_updates_due_date():
    async def _t():
        uid, cid, tok = await _env()
        try:
            tid = str(uuid.uuid4())
            base_due = (datetime.now(timezone.utc)).date().isoformat()
            await db.tasks.insert_one({
                "id": tid, "company_id": cid, "title": "Follow up with Bob",
                "status": "open", "kind": "task", "priority": "medium",
                "assignee_id": uid, "due_date": base_due,
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "snooze_task",
                       "entities": {"task_hint": "Follow up with Bob",
                                     "snooze_by_days": 3},
                       "resolution": {"task": {"id": tid,
                                                 "title": "Follow up with Bob",
                                                 "due_date": base_due}}},
            )
            assert r.status_code == 200, r.text
            fresh = await db.tasks.find_one({"id": tid})
            expected = (datetime.fromisoformat(base_due) + timedelta(days=3)).date().isoformat()
            assert fresh["due_date"] == expected
            assert fresh["snoozed_from"] == base_due
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_snooze_task_400_without_when():
    async def _t():
        uid, cid, tok = await _env()
        try:
            tid = str(uuid.uuid4())
            await db.tasks.insert_one({
                "id": tid, "company_id": cid, "title": "x",
                "status": "open", "assignee_id": uid,
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "snooze_task",
                       "entities": {"task_hint": "x"},
                       "resolution": {"task": {"id": tid, "title": "x"}}},
            )
            assert r.status_code == 400
            assert "snooze" in r.text.lower()
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_draft_proposal_saves_as_draft_with_amount_in_body():
    async def _t():
        uid, cid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "draft_proposal",
                       "entities": {"contact_hint": "Bob",
                                     "notes": "Two-week onboarding + support",
                                     "amount": 12500, "currency": "USD"},
                       "resolution": {
                           "contact": {"id": "c1", "name": "Bob McKenzie",
                                        "email": "bob@ex.com"},
                       }},
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            assert a["target_type"] == "proposal_draft"
            em = await db.recap_emails.find_one({"id": a["target_id"]})
            assert em["status"] == "draft"
            assert em["to_email"] == "bob@ex.com"
            assert em["amount"] == 12500
            assert "USD 12,500" in em["body"]
            assert "onboarding" in em["body"]
        finally:
            await db.recap_emails.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_undo_move_deal_stage_restores_prior_stage():
    async def _t():
        uid, cid, tok = await _env()
        try:
            did = str(uuid.uuid4())
            await db.deals.insert_one({
                "id": did, "company_id": cid, "title": "Undo Test",
                "stage": "qualified", "order": 1.0, "activities": [],
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "move_deal_stage",
                       "entities": {"new_stage": "won"},
                       "resolution": {"deal": {"id": did, "title": "Undo Test",
                                                 "stage": "qualified",
                                                 "activities": []}}},
            )
            aid = r.json()["action"]["id"]
            ru = await client.post(
                f"/api/voice/actions/{aid}/undo",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert ru.status_code == 200
            fresh = await db.deals.find_one({"id": did})
            assert fresh["stage"] == "qualified"
        finally:
            await db.deals.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_undo_snooze_task_restores_prior_due_date():
    async def _t():
        uid, cid, tok = await _env()
        try:
            tid = str(uuid.uuid4())
            base_due = (datetime.now(timezone.utc)).date().isoformat()
            await db.tasks.insert_one({
                "id": tid, "company_id": cid, "title": "Ping Bob",
                "status": "open", "assignee_id": uid, "due_date": base_due,
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "snooze_task",
                       "entities": {"snooze_by_days": 5},
                       "resolution": {"task": {"id": tid, "title": "Ping Bob",
                                                 "due_date": base_due}}},
            )
            aid = r.json()["action"]["id"]
            ru = await client.post(
                f"/api/voice/actions/{aid}/undo",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert ru.status_code == 200
            fresh = await db.tasks.find_one({"id": tid})
            assert fresh["due_date"] == base_due
            assert fresh.get("snoozed_from") in (None,)  # unset after undo
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_enrich_move_deal_stage_flags_no_matching_deal():
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "intent": "move_deal_stage", "confidence": 0.9,
                "entities": {"deal_hint": "Ghost Deal", "new_stage": "negotiation"},
                "clarifications": [], "preview": "Move deal",
            }
            with patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "move Ghost Deal to negotiation",
                           "company_id": cid},
                )
            d = r.json()
            fields = [c["field"] for c in d["clarifications"]]
            assert "deal" in fields
        finally:
            await _cleanup(uid, cid)
    _run(_t())


# ══════════════════════════════════════════════════════════════════
# UX regressions (Feb 2026) — timezone + clarification dedup
# ══════════════════════════════════════════════════════════════════

def test_parse_drops_redundant_when_clarification_when_iso_present():
    """The LLM sometimes tacks on a 'When?' question even after
    resolving iso_datetime. We must not surface it."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "intent": "create_appointment", "confidence": 0.9,
                "entities": {
                    "title": "Study prospectus",
                    "iso_datetime": "2026-08-30T12:00:00-07:00",
                    "duration_min": 30,
                },
                "clarifications": [
                    {"field": "when", "question": "When would you like this meeting?"},
                    {"field": "attendee", "question": "Who's the meeting with?"},
                ],
                "preview": "Study 30 min tomorrow at 12pm",
            }
            with patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "block 30 minutes tomorrow at noon to study",
                           "company_id": cid,
                           "tz": "America/Los_Angeles",
                           "now_local": "2026-08-29T09:00:00-07:00"},
                )
            d = r.json()
            fields = [c["field"] for c in d["clarifications"]]
            # When and attendee should BOTH be suppressed — user said "block time
            # tomorrow at noon to study" (solo).
            assert "when" not in fields
            assert "attendee" not in fields
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_dedups_clarifications_by_field():
    """Two clarifications targeting the same field collapse to one."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake = {
                "intent": "create_task", "confidence": 0.7,
                "entities": {"title": "Call Alice"},
                "clarifications": [
                    {"field": "contact", "question": "Which Alice?"},
                    {"field": "contact", "question": "Confirm Alice?"},
                ],
                "preview": "Task",
            }
            with patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "call alice", "company_id": cid},
                )
            fields = [c["field"] for c in r.json()["clarifications"]]
            assert fields.count("contact") <= 1
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_caches_per_timezone():
    """Same words in a different timezone must NOT hit the cache."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            fake_pt = {
                "intent": "create_appointment", "confidence": 0.9,
                "entities": {"title": "x",
                              "iso_datetime": "2026-08-30T12:00:00-07:00"},
                "clarifications": [], "preview": "",
            }
            fake_et = {
                "intent": "create_appointment", "confidence": 0.9,
                "entities": {"title": "x",
                              "iso_datetime": "2026-08-30T12:00:00-04:00"},
                "clarifications": [], "preview": "",
            }
            call_count = {"n": 0}
            responses = [fake_pt, fake_et]
            async def _mock(*_a, **_k):
                call_count["n"] += 1
                return responses[call_count["n"] - 1]
            with patch("routes.voice_actions._run_parser", new=_mock):
                client = await _client()
                r1 = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "meet tomorrow at noon",
                           "company_id": cid, "tz": "America/Los_Angeles"},
                )
                r2 = await client.post(
                    "/api/voice/actions/parse",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "meet tomorrow at noon",
                           "company_id": cid, "tz": "America/New_York"},
                )
            assert call_count["n"] == 2  # each tz produced its own parse
            assert "-07:00" in r1.json()["entities"]["iso_datetime"]
            assert "-04:00" in r2.json()["entities"]["iso_datetime"]
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_multi_splits_compound_utterance_into_queue():
    """Compound "I want to X AND email Y AND send Z my link" → queue of 3."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            # Mock the splitter to return 3 atomic sentences.
            split_calls = {"n": 0}
            async def _mock_split(txt):
                split_calls["n"] += 1
                return [
                    "block time tomorrow at 12 pm to review the prospectus",
                    "email Larry today to remind him to send the perspectives",
                    "send Larry my calendar link so he can book next Tuesday",
                ]
            # Each sub-utterance gets its own mocked parse — keyed by
            # utterance text since asyncio.gather may schedule in any
            # order.
            _fake_parses = {
                "block time tomorrow at 12 pm to review the prospectus": {
                    "intent": "create_appointment", "confidence": 0.9,
                    "entities": {"title": "Review prospectus",
                                  "iso_datetime": "2026-08-30T12:00:00-07:00",
                                  "duration_min": 30},
                    "clarifications": [], "preview": "solo review"},
                "email Larry today to remind him to send the perspectives": {
                    "intent": "follow_up_reminder", "confidence": 0.9,
                    "entities": {"title": "Email Larry re: perspectives",
                                  "contact_hint": "Larry",
                                  "iso_datetime": "2026-08-29T17:00:00-07:00"},
                    "clarifications": [], "preview": "follow up today"},
                "send Larry my calendar link so he can book next Tuesday": {
                    "intent": "send_calendar_link", "confidence": 0.9,
                    "entities": {"contact_hint": "Larry"},
                    "clarifications": [], "preview": "share calendar"},
            }
            async def _mock_parse(text, *a, **k):
                return _fake_parses[text]
            with patch("routes.voice_actions._run_splitter", new=_mock_split), \
                 patch("routes.voice_actions._run_parser", new=_mock_parse):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse-multi",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text":
                          "I want to review the prospectus tomorrow at 12 pm "
                          "also email Larry today to remind him to send the "
                          "perspectives and then send Larry my calendar link "
                          "so he can book next Tuesday",
                          "company_id": cid, "tz": "America/Los_Angeles"},
                )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["count"] == 3
            assert len(d["actions"]) == 3
            intents = [a["intent"] for a in d["actions"]]
            assert intents == ["create_appointment", "follow_up_reminder", "send_calendar_link"]
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_multi_falls_back_to_single_when_splitter_returns_one():
    """Splitter says 'this is one action' → parse-multi behaves like /parse."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            async def _mock_split(txt):
                return [txt]
            fake = {
                "intent": "create_task", "confidence": 0.9,
                "entities": {"title": "Call Alice"},
                "clarifications": [], "preview": "task",
            }
            with patch("routes.voice_actions._run_splitter", new=_mock_split), \
                 patch("routes.voice_actions._run_parser",
                       new=AsyncMock(return_value=fake)):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse-multi",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "remind me to call Alice", "company_id": cid},
                )
            d = r.json()
            assert d["count"] == 1
            assert d["actions"][0]["intent"] == "create_task"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_parse_multi_drops_unknown_sub_utterances():
    """A sub-utterance that parses to 'unknown' should not fail the batch."""
    async def _t():
        uid, cid, tok = await _env()
        try:
            async def _mock_split(txt):
                return ["remind me to call Alice", "the weather is nice"]
            _fake_map = {
                "remind me to call Alice": {
                    "intent": "create_task", "confidence": 0.9,
                    "entities": {"title": "Call Alice"},
                    "clarifications": [], "preview": ""},
                "the weather is nice": {
                    "intent": "unknown", "confidence": 0.0,
                    "entities": {}, "clarifications": [], "preview": ""},
            }
            async def _mock_parse(text, *a, **k):
                return _fake_map[text]
            with patch("routes.voice_actions._run_splitter", new=_mock_split), \
                 patch("routes.voice_actions._run_parser", new=_mock_parse):
                client = await _client()
                r = await client.post(
                    "/api/voice/actions/parse-multi",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "remind me to call Alice. the weather is nice",
                           "company_id": cid},
                )
            d = r.json()
            assert d["count"] == 1  # unknown dropped
            assert d["actions"][0]["intent"] == "create_task"
        finally:
            await _cleanup(uid, cid)
    _run(_t())

# ══════════════════════════════════════════════════════════════════
# Cross-linking (Feb 2026) — every voice action for a contact must
# surface on that contact's activity feed, and log_call must also
# mark a completed task so "Completed today" picks it up.
# ══════════════════════════════════════════════════════════════════

def test_execute_log_call_pushes_activity_to_contact_and_marks_done_task():
    async def _t():
        uid, cid, tok = await _env()
        try:
            larry = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": larry, "company_id": cid, "name": "Larry Brown",
                "email": "larry@example.com", "activities": [],
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "log_call",
                       "entities": {"title": "Call with Larry",
                                     "contact_hint": "Larry",
                                     "notes": "Discussed 123 Main St",
                                     "outcome": "connected"},
                       "resolution": {"contact": {"id": larry,
                                                    "name": "Larry Brown",
                                                    "email": "larry@example.com"}}},
            )
            assert r.status_code == 200, r.text
            # Contact should now have a call activity in its embedded array.
            c = await db.contacts.find_one({"id": larry})
            acts = c.get("activities") or []
            call_acts = [a for a in acts if a.get("kind") == "call"]
            assert len(call_acts) == 1
            assert "123 Main St" in call_acts[0]["body"]
            assert call_acts[0].get("source") == "voice"
            # And a completed task exists in db.tasks.
            done = await db.tasks.find_one({"company_id": cid,
                                              "kind": "call", "status": "done",
                                              "contact_id": larry})
            assert done is not None
            assert done["title"].startswith("Call with")
        finally:
            await db.contacts.delete_many({"company_id": cid})
            await db.tasks.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_create_appointment_pushes_meeting_activity_to_contact():
    async def _t():
        uid, cid, tok = await _env()
        try:
            larry = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": larry, "company_id": cid, "name": "Larry Brown",
                "email": None, "activities": [],
                "created_at": now_iso_import(),
            })
            iso = (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat()
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "create_appointment",
                       "entities": {"title": "Review prospectus with Larry",
                                     "iso_datetime": iso,
                                     "duration_min": 30,
                                     "contact_hint": "Larry"},
                       "resolution": {"contact": {"id": larry,
                                                    "name": "Larry Brown"}}},
            )
            assert r.status_code == 200, r.text
            c = await db.contacts.find_one({"id": larry})
            acts = c.get("activities") or []
            assert any(a.get("kind") == "meeting" for a in acts), acts
        finally:
            await db.contacts.delete_many({"company_id": cid})
            await db.tasks.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())


def test_execute_send_calendar_link_pushes_email_activity_to_contact():
    async def _t():
        uid, cid, tok = await _env()
        try:
            larry = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": larry, "company_id": cid, "name": "Larry Brown",
                "email": "larry@example.com", "activities": [],
                "created_at": now_iso_import(),
            })
            await db.user_booking_settings.insert_one({
                "user_id": uid, "slug": "priya",
                "display_name": "Priya",
                "default_meeting_link_type": "none",
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "send_calendar_link",
                       "entities": {"contact_hint": "Larry"},
                       "resolution": {"contact": {"id": larry,
                                                    "name": "Larry Brown",
                                                    "email": "larry@example.com"}}},
            )
            assert r.status_code == 200, r.text
            a = r.json()["action"]
            # Summary must NOT falsely imply the email was sent.
            assert "not sent" in a["summary"].lower(), a["summary"]
            # Contact should carry an email activity.
            c = await db.contacts.find_one({"id": larry})
            acts = c.get("activities") or []
            assert any(x.get("kind") == "email" for x in acts), acts
        finally:
            await db.contacts.delete_many({"company_id": cid})
            await db.recap_emails.delete_many({"company_id": cid})
            await db.user_booking_settings.delete_many({"user_id": uid})
            await _cleanup(uid, cid)
    _run(_t())


def test_undo_log_call_removes_contact_activity_and_done_task():
    async def _t():
        uid, cid, tok = await _env()
        try:
            larry = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": larry, "company_id": cid, "name": "Larry Brown",
                "email": None, "activities": [],
                "created_at": now_iso_import(),
            })
            client = await _client()
            r = await client.post(
                "/api/voice/actions/execute",
                headers={"Authorization": f"Bearer {tok}"},
                json={"company_id": cid, "intent": "log_call",
                       "entities": {"title": "Call", "notes": "x"},
                       "resolution": {"contact": {"id": larry,
                                                    "name": "Larry Brown"}}},
            )
            aid = r.json()["action"]["id"]
            # Both artifacts exist
            c = await db.contacts.find_one({"id": larry})
            assert any(a.get("kind") == "call" for a in c["activities"])
            assert await db.tasks.count_documents({"voice_action_id": aid}) == 1
            # Undo — trail should vanish
            ru = await client.post(
                f"/api/voice/actions/{aid}/undo",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert ru.status_code == 200
            c2 = await db.contacts.find_one({"id": larry})
            assert not any(a.get("voice_action_id") == aid
                            for a in (c2.get("activities") or []))
            assert await db.tasks.count_documents({"voice_action_id": aid}) == 0
        finally:
            await db.contacts.delete_many({"company_id": cid})
            await db.tasks.delete_many({"company_id": cid})
            await _cleanup(uid, cid)
    _run(_t())

