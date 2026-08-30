"""Google Calendar — CRUD endpoints piggybacking on Gmail tokens (Feb 2026)."""
from __future__ import annotations
import sys, uuid
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


async def _mk_user_with_token():
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"cal_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "Cal Tester",
    })
    await db.gmail_tokens.insert_one({
        "user_id": uid, "email": "u@gmail.com",
        "access_token": "at", "refresh_token": "rt",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "scopes": [],
    })
    return uid, create_token(uid, "client")


async def _cleanup(uid):
    await db.users.delete_one({"id": uid})
    await db.gmail_tokens.delete_many({"user_id": uid})


def test_list_calendars_requires_connection():
    async def _t():
        # user with no token
        uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": f"nc_{uid[:6]}@example.com",
            "password": hash_password("x"), "role": "client", "name": "NC",
        })
        try:
            tok = create_token(uid, "client")
            client = await _client()
            r = await client.get("/api/google/calendar/list",
                                  headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 401
        finally:
            await db.users.delete_one({"id": uid})
    _run(_t())


def test_list_events_returns_shape_with_mock():
    async def _t():
        uid, tok = await _mk_user_with_token()
        try:
            svc = MagicMock()
            list_call = MagicMock()
            list_call.execute.return_value = {
                "items": [{
                    "id": "E1",
                    "summary": "Kickoff",
                    "description": "Deal sync",
                    "location": "Zoom",
                    "htmlLink": "https://calendar.google.com/e/1",
                    "start": {"dateTime": "2026-03-05T14:00:00Z"},
                    "end":   {"dateTime": "2026-03-05T15:00:00Z"},
                    "attendees": [
                        {"email": "a@x.com", "responseStatus": "accepted"},
                    ],
                }]
            }
            svc.events().list.return_value = list_call

            with patch("routes.google_calendar._calendar_service", return_value=svc):
                client = await _client()
                r = await client.get(
                    "/api/google/calendar/events"
                    "?time_min=2026-03-01T00:00:00Z&time_max=2026-03-31T00:00:00Z",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert len(d["events"]) == 1
                e = d["events"][0]
                assert e["summary"] == "Kickoff"
                assert e["start"] == "2026-03-05T14:00:00Z"
                assert e["attendees"][0]["email"] == "a@x.com"
                assert e["all_day"] is False
        finally:
            await _cleanup(uid)
    _run(_t())


def test_create_event_with_attendees_and_send_all():
    async def _t():
        uid, tok = await _mk_user_with_token()
        try:
            svc = MagicMock()
            insert_call = MagicMock()
            captured = {}
            def _exec():
                return {
                    "id": "NEW1",
                    "summary": captured.get("body", {}).get("summary"),
                    "start": {"dateTime": "2026-03-05T14:00:00-05:00"},
                    "end":   {"dateTime": "2026-03-05T15:00:00-05:00"},
                    "attendees": captured.get("body", {}).get("attendees", []),
                }
            insert_call.execute.side_effect = _exec

            def _insert(**kwargs):
                captured.update(kwargs)
                return insert_call
            svc.events().insert.side_effect = _insert

            with patch("routes.google_calendar._calendar_service", return_value=svc):
                client = await _client()
                r = await client.post(
                    "/api/google/calendar/events",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "summary": "Sales sync",
                        "start": "2026-03-05T14:00:00-05:00",
                        "end":   "2026-03-05T15:00:00-05:00",
                        "attendees": [{"email": "client@example.com"}],
                        "send_updates": "all",
                        "time_zone": "America/New_York",
                    },
                )
                assert r.status_code == 200, r.text
                data = r.json()
                assert data["summary"] == "Sales sync"
                assert data["attendees"][0]["email"] == "client@example.com"
                # captured request checks
                assert captured["sendUpdates"] == "all"
                body = captured["body"]
                assert body["start"]["timeZone"] == "America/New_York"
                assert body["attendees"] == [{"email": "client@example.com"}]
        finally:
            await _cleanup(uid)
    _run(_t())


def test_create_event_with_meet_link_sets_conference_data():
    async def _t():
        uid, tok = await _mk_user_with_token()
        try:
            svc = MagicMock()
            call = MagicMock()
            captured = {}
            call.execute.return_value = {
                "id": "M1", "summary": "M",
                "start": {"dateTime": "2026-03-05T14:00:00Z"},
                "end":   {"dateTime": "2026-03-05T15:00:00Z"},
                "hangoutLink": "https://meet.google.com/x",
            }
            def _insert(**kwargs):
                captured.update(kwargs); return call
            svc.events().insert.side_effect = _insert

            with patch("routes.google_calendar._calendar_service", return_value=svc):
                client = await _client()
                r = await client.post(
                    "/api/google/calendar/events",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "summary": "Meet",
                        "start": "2026-03-05T14:00:00Z",
                        "end":   "2026-03-05T15:00:00Z",
                        "add_meet_link": True,
                    },
                )
                assert r.status_code == 200, r.text
                assert captured["conferenceDataVersion"] == 1
                assert "conferenceData" in captured["body"]
                assert r.json()["hangout_link"] == "https://meet.google.com/x"
        finally:
            await _cleanup(uid)
    _run(_t())


def test_delete_event():
    async def _t():
        uid, tok = await _mk_user_with_token()
        try:
            svc = MagicMock()
            svc.events().delete().execute.return_value = None

            with patch("routes.google_calendar._calendar_service", return_value=svc):
                client = await _client()
                r = await client.delete(
                    "/api/google/calendar/events/E1?send_updates=all",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200
                assert r.json()["ok"] is True
        finally:
            await _cleanup(uid)
    _run(_t())
