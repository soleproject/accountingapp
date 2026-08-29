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
