"""CRM My Day aggregator (Feb 2026)."""
from __future__ import annotations
import sys, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _env(*, default_days=7, per_activity=None):
    uid, cid = str(uuid.uuid4()), str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "MD",
    })
    await db.companies.insert_one({
        "id": cid, "name": "MDCo", "created_at": "2026-01-01T00:00:00Z",
    })
    await db.memberships.insert_one({"user_id": uid, "company_id": cid, "role": "owner"})
    if default_days or per_activity:
        await db.crm_settings.insert_one({
            "company_id": cid,
            "follow_up": {
                "default_days": default_days,
                "per_activity": per_activity or {},
            },
        })
    return uid, cid, create_token(uid, "client")


async def _cleanup(uid, cid):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})
    await db.tasks.delete_many({"company_id": cid})
    await db.deals.delete_many({"company_id": cid})
    await db.crm_settings.delete_many({"company_id": cid})


def _today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def _yesterday():
    return (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")


def test_my_day_returns_partitioned_tasks():
    async def _t():
        uid, cid, tok = await _env()
        try:
            today = _today()
            # Seed a meeting + call + task due today
            for k in ("meeting", "call", "task"):
                await db.tasks.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "kind": k, "title": f"{k} today", "due_date": today,
                    "status": "open", "priority": "medium",
                    "created_by_user_id": uid, "assignee_user_ids": [uid],
                })
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/my-day",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert len(d["appointments"]) == 1
            assert d["appointments"][0]["kind"] == "meeting"
            assert len(d["calls"]) == 1
            assert d["calls"][0]["kind"] == "call"
            assert len(d["tasks"]) == 1
            assert d["tasks"][0]["kind"] == "task"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_my_day_overdue_captures_past_open_tasks():
    async def _t():
        uid, cid, tok = await _env()
        try:
            # Overdue open task from yesterday + done one should not appear
            await db.tasks.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "kind": "task", "title": "past-due", "due_date": _yesterday(),
                "status": "open", "created_by_user_id": uid,
            })
            await db.tasks.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "kind": "task", "title": "past-done", "due_date": _yesterday(),
                "status": "done", "created_by_user_id": uid,
            })
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/my-day",
                headers={"Authorization": f"Bearer {tok}"},
            )
            d = r.json()
            titles = [t["title"] for t in d["overdue"]]
            assert "past-due" in titles
            assert "past-done" not in titles
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_follow_ups_respect_default_threshold():
    async def _t():
        uid, cid, tok = await _env(default_days=5)
        try:
            # Deal touched 6 days ago → should flag
            long_ago = (datetime.now(timezone.utc) - timedelta(days=6)).isoformat()
            recent   = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
            # Won deals must be excluded
            for i, (stage, at) in enumerate([
                ("qualified", long_ago),
                ("proposal",   recent),
                ("won",        long_ago),
            ]):
                await db.deals.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "title": f"deal-{i}", "stage": stage, "value": 100 * i,
                    "created_at": long_ago,
                    "activities": [{"kind": "note", "at": at, "body": "hi",
                                     "id": str(uuid.uuid4())}],
                })
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/my-day",
                headers={"Authorization": f"Bearer {tok}"},
            )
            d = r.json()
            titles = [f["title"] for f in d["follow_ups"]]
            assert "deal-0" in titles
            assert "deal-1" not in titles
            assert "deal-2" not in titles  # won stage excluded
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_follow_ups_respect_per_activity_override():
    async def _t():
        # Default 30, but call overrides to 2 days → 3-day-old call flags
        uid, cid, tok = await _env(default_days=30, per_activity={"call": 2})
        try:
            three_days = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
            await db.deals.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "title": "d-call", "stage": "qualified", "value": 100,
                "created_at": three_days,
                "activities": [{"kind": "call", "at": three_days,
                                 "id": str(uuid.uuid4()), "body": ""}],
            })
            await db.deals.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "title": "d-note", "stage": "qualified", "value": 100,
                "created_at": three_days,
                "activities": [{"kind": "note", "at": three_days,
                                 "id": str(uuid.uuid4()), "body": ""}],
            })
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/my-day",
                headers={"Authorization": f"Bearer {tok}"},
            )
            d = r.json()
            titles = [f["title"] for f in d["follow_ups"]]
            assert "d-call" in titles       # 3 days > 2 threshold → flagged
            assert "d-note" not in titles   # 3 days < 30 default → not flagged
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_settings_accepts_follow_up_patch():
    async def _t():
        uid, cid, tok = await _env(default_days=7)
        try:
            client = await _client()
            r = await client.patch(
                f"/api/companies/{cid}/crm-settings",
                headers={"Authorization": f"Bearer {tok}"},
                json={"follow_up": {"default_days": 14,
                                     "per_activity": {"call": 2}}},
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["follow_up"]["default_days"] == 14
            assert d["follow_up"]["per_activity"]["call"] == 2
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_morning_brief_falls_back_when_llm_disabled(monkeypatch):
    """With EMERGENT_LLM_KEY unset, the endpoint returns the
    deterministic summary instead of raising."""
    async def _t():
        uid, cid, tok = await _env(default_days=5)
        try:
            today = _today()
            # Seed: 1 meeting today + 1 stale follow-up
            await db.tasks.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "kind": "meeting", "title": "kickoff", "due_date": today,
                "status": "open", "priority": "medium",
                "created_by_user_id": uid,
            })
            long_ago = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
            await db.deals.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "title": "Acme deal", "stage": "qualified", "value": 45000,
                "created_at": long_ago,
                "activities": [{"kind": "note", "at": long_ago,
                                 "id": str(uuid.uuid4()), "body": ""}],
            })
            import os as _os
            monkeypatch.delenv("EMERGENT_LLM_KEY", raising=False)
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/my-day/brief",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["brief"]
            assert "meeting" in d["brief"].lower()
            assert "Acme deal" in d["brief"]  # top follow-up mentioned
            # Second call should be cached
            r2 = await client.get(
                f"/api/companies/{cid}/my-day/brief",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r2.json()["cached"] is True
        finally:
            await _cleanup(uid, cid)
            await db.my_day_briefs.delete_many({"company_id": cid})
    _run(_t())


def test_my_day_overlays_google_calendar_events_and_dedupes():
    """
    - Two GCal events today; one is mirrored by an app task (matching
      google_event_id) and should NOT be duplicated in appointments.
    - One is user-declined and should be excluded.
    - A truly-external event should appear as an appointment with
      source=gcal and no snooze/done rewrite path.
    """
    async def _t():
        from unittest.mock import patch, MagicMock
        uid, cid, tok = await _env()
        try:
            today = _today()
            # App task mirroring GCal event id "EV_MIRROR"
            await db.tasks.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "title": "Mirrored meeting", "kind": "meeting",
                "status": "open", "due_date": today, "due_time": "10:00",
                "google_event_id": "EV_MIRROR",
                "created_at": "2026-02-28T00:00:00Z",
            })

            fake_events = {"items": [
                {
                    "id": "EV_MIRROR",   # should be de-duped away
                    "status": "confirmed",
                    "summary": "Mirrored meeting",
                    "start": {"dateTime": "2026-02-28T10:00:00+00:00"},
                    "end":   {"dateTime": "2026-02-28T10:30:00+00:00"},
                },
                {
                    "id": "EV_DECLINED",  # should be skipped
                    "status": "confirmed",
                    "summary": "Optional standup",
                    "start": {"dateTime": "2026-02-28T14:00:00+00:00"},
                    "end":   {"dateTime": "2026-02-28T14:30:00+00:00"},
                    "attendees": [
                        {"email": "me@example.com", "self": True,
                          "responseStatus": "declined"},
                    ],
                },
                {
                    "id": "EV_EXTERNAL",  # should appear as an appointment
                    "status": "confirmed",
                    "summary": "Nexxsuite Investor Call",
                    "location": "Zoom",
                    "start": {"dateTime": "2026-02-28T09:00:00+00:00"},
                    "end":   {"dateTime": "2026-02-28T09:45:00+00:00"},
                    "htmlLink": "https://cal.google.com/event/EV_EXTERNAL",
                },
                {
                    "id": "EV_CANCELLED",  # should be skipped
                    "status": "cancelled",
                    "summary": "Cancelled meeting",
                    "start": {"dateTime": "2026-02-28T16:00:00+00:00"},
                    "end":   {"dateTime": "2026-02-28T16:30:00+00:00"},
                },
            ]}

            # Mock the Google API service so no real network call is made.
            fake_svc = MagicMock()
            fake_svc.events.return_value.list.return_value.execute.return_value = fake_events

            with patch("routes.crm_my_day._calendar_service" if False else
                       "routes.google_calendar._calendar_service",
                       return_value=fake_svc), \
                 patch("routes.gmail._creds_for_user",
                       return_value=object()):  # any truthy creds obj
                client = await _client()
                r = await client.get(
                    f"/api/companies/{cid}/my-day",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                d = r.json()

            titles = [a["title"] for a in d["appointments"]]
            # Mirrored + external appear once (not twice); declined + cancelled excluded
            assert "Mirrored meeting" in titles
            assert "Nexxsuite Investor Call" in titles
            assert "Optional standup" not in titles
            assert "Cancelled meeting" not in titles
            # Only 2 total appointments (mirror + external)
            assert len(d["appointments"]) == 2

            ext = next(a for a in d["appointments"] if a["title"] == "Nexxsuite Investor Call")
            assert ext["source"] == "gcal"
            assert ext["id"] == "gcal:EV_EXTERNAL"
            assert ext["due_time"] == "09:00"
            assert ext["location"] == "Zoom"
            assert ext["html_link"] == "https://cal.google.com/event/EV_EXTERNAL"

            # Sorted by time — 09:00 external first, then 10:00 mirror
            assert titles == ["Nexxsuite Investor Call", "Mirrored meeting"]
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_my_day_ignores_gcal_when_user_not_connected():
    """If _creds_for_user raises (user hasn't linked Google), my-day
    should still return successfully with appointments coming from
    tasks only."""
    async def _t():
        from unittest.mock import patch
        uid, cid, tok = await _env()
        try:
            today = _today()
            await db.tasks.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "title": "App-only meeting", "kind": "meeting",
                "status": "open", "due_date": today, "due_time": "11:00",
                "created_at": "2026-02-28T00:00:00Z",
            })
            with patch("routes.gmail._creds_for_user",
                       side_effect=RuntimeError("no gmail token")):
                client = await _client()
                r = await client.get(
                    f"/api/companies/{cid}/my-day",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                d = r.json()
            assert [a["title"] for a in d["appointments"]] == ["App-only meeting"]
        finally:
            await _cleanup(uid, cid)
    _run(_t())

