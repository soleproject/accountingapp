"""Task → Google Calendar sync (Feb 2026)."""
from __future__ import annotations
import sys, uuid, asyncio
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env(*, with_token=True):
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    contact_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"user_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "Sync User",
    })
    await db.companies.insert_one({
        "id": cid, "name": "SyncCo", "created_at": "2026-01-01T00:00:00Z",
    })
    await db.memberships.insert_one({
        "user_id": uid, "company_id": cid, "role": "owner",
    })
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Alice", "email": "alice@example.com", "type": "customer",
        "activities": [],
    })
    if with_token:
        await db.gmail_tokens.insert_one({
            "user_id": uid, "email": "me@bigsaas.ai",
            "access_token": "at", "refresh_token": "rt",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "scopes": [],
        })
    return uid, cid, contact_id, create_token(uid, "client")


async def _cleanup(uid, cid, contact_id):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})
    await db.contacts.delete_one({"id": contact_id})
    await db.tasks.delete_many({"company_id": cid})
    await db.gmail_tokens.delete_many({"user_id": uid})


# ── create meeting task with Google connected → mirror is created ───
def test_create_meeting_task_mirrors_to_google():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            svc = MagicMock()
            captured = {}
            def _insert(**kw):
                captured.update(kw)
                call = MagicMock()
                call.execute.return_value = {"id": "GEV-1"}
                return call
            svc.events().insert.side_effect = _insert

            with patch("routes.task_gcal_sync._calendar_service", return_value=svc):
                client = await _client()
                r = await client.post(
                    f"/api/companies/{cid}/tasks",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "title": "Client sync",
                        "kind": "meeting",
                        "due_date": "2026-03-05",
                        "due_time": "14:00",
                        "duration_minutes": 30,
                        "contact_ids": [contact_id],
                    },
                )
                assert r.status_code == 200, r.text
                task = r.json()["task"]
                assert task["google_event_id"] == "GEV-1"

            # Attendees include the contact email
            body = captured["body"]
            attendee_emails = [a["email"] for a in body.get("attendees", [])]
            assert "alice@example.com" in attendee_emails
            assert body["start"]["dateTime"].startswith("2026-03-05T14:00:00")
            assert captured["sendUpdates"] == "all"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── create meeting without Google connected → no crash, no mirror ───
def test_create_meeting_without_google_ok():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env(with_token=False)
        try:
            client = await _client()
            r = await client.post(
                f"/api/companies/{cid}/tasks",
                headers={"Authorization": f"Bearer {tok}"},
                json={"title": "solo", "kind": "meeting",
                      "due_date": "2026-03-05", "due_time": "14:00"},
            )
            assert r.status_code == 200, r.text
            task = r.json()["task"]
            assert not task.get("google_event_id")
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── update meeting task → patches existing google event ─────────────
def test_update_meeting_task_patches_google_event():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            # Seed a task that's already mirrored
            task_id = str(uuid.uuid4())
            await db.tasks.insert_one({
                "id": task_id, "company_id": cid,
                "title": "Sync", "kind": "meeting",
                "due_date": "2026-03-05", "due_time": "14:00",
                "duration_minutes": 30, "status": "open", "priority": "medium",
                "created_by_user_id": uid,
                "assignee_user_ids": [uid],
                "contact_ids": [contact_id],
                "google_event_id": "GEV-1", "google_calendar_id": "primary",
                "google_synced_by_user_id": uid,
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            })

            svc = MagicMock()
            patched = {}
            def _patch(**kw):
                patched.update(kw)
                call = MagicMock(); call.execute.return_value = {"id": "GEV-1"}
                return call
            svc.events().patch.side_effect = _patch

            with patch("routes.task_gcal_sync._calendar_service", return_value=svc):
                client = await _client()
                r = await client.patch(
                    f"/api/companies/{cid}/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"title": "Renamed Sync"},
                )
                assert r.status_code == 200, r.text

            assert patched["eventId"] == "GEV-1"
            assert patched["body"]["summary"] == "Renamed Sync"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── delete meeting task → deletes google event ──────────────────────
def test_delete_meeting_task_deletes_google_event():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            task_id = str(uuid.uuid4())
            await db.tasks.insert_one({
                "id": task_id, "company_id": cid,
                "title": "Sync", "kind": "meeting",
                "due_date": "2026-03-05", "due_time": "14:00",
                "status": "open", "priority": "medium",
                "created_by_user_id": uid,
                "assignee_user_ids": [uid], "contact_ids": [contact_id],
                "google_event_id": "GEV-1", "google_calendar_id": "primary",
                "google_synced_by_user_id": uid,
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            })
            svc = MagicMock()
            captured = {}
            def _del(**kw):
                captured.update(kw)
                call = MagicMock(); call.execute.return_value = None
                return call
            svc.events().delete.side_effect = _del

            with patch("routes.task_gcal_sync._calendar_service", return_value=svc):
                client = await _client()
                r = await client.delete(
                    f"/api/companies/{cid}/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200

            assert captured["eventId"] == "GEV-1"
            assert captured["sendUpdates"] == "all"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── backfill pushes existing meetings ───────────────────────────────
def test_backfill_pushes_existing_meetings():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            # Seed two meetings, one already mirrored → only one pushes
            for i, mirror in enumerate([None, "EXISTING"]):
                doc = {
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "title": f"m{i}", "kind": "meeting",
                    "due_date": "2026-03-05", "due_time": "14:00",
                    "duration_minutes": 30, "status": "open", "priority": "medium",
                    "created_by_user_id": uid,
                    "assignee_user_ids": [uid], "contact_ids": [contact_id],
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }
                if mirror:
                    doc["google_event_id"] = mirror
                await db.tasks.insert_one(doc)

            svc = MagicMock()
            svc.events().insert.return_value.execute.return_value = {"id": "GEV-NEW"}

            from routes.task_gcal_sync import sync_all_meetings_for_user
            with patch("routes.task_gcal_sync._calendar_service", return_value=svc):
                n = await sync_all_meetings_for_user(uid)
                assert n == 1
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── kind changed away from meeting → mirror event is deleted ────────
def test_kind_change_to_non_meeting_deletes_mirror():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            task_id = str(uuid.uuid4())
            await db.tasks.insert_one({
                "id": task_id, "company_id": cid,
                "title": "Sync", "kind": "meeting",
                "due_date": "2026-03-05", "due_time": "14:00",
                "status": "open", "priority": "medium",
                "created_by_user_id": uid,
                "assignee_user_ids": [uid], "contact_ids": [contact_id],
                "google_event_id": "GEV-1", "google_calendar_id": "primary",
                "google_synced_by_user_id": uid,
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            })
            svc = MagicMock()
            captured = {}
            def _del(**kw):
                captured.update(kw)
                call = MagicMock(); call.execute.return_value = None
                return call
            svc.events().delete.side_effect = _del

            with patch("routes.task_gcal_sync._calendar_service", return_value=svc):
                client = await _client()
                r = await client.patch(
                    f"/api/companies/{cid}/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"kind": "task"},
                )
                assert r.status_code == 200

            assert captured.get("eventId") == "GEV-1"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())
