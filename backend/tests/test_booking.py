"""Booking / meeting-link settings — Phase 2 (Feb 2026)."""
from __future__ import annotations
import sys, uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _env():
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
        "name": "Sam Owner",
    })
    return uid, create_token(uid, "client")


async def _cleanup(uid):
    await db.users.delete_one({"id": uid})
    await db.user_booking_settings.delete_many({"user_id": uid})
    await db.freebusy_cache.delete_many({})
    await db.bookings.delete_many({"user_id": uid})


def test_get_settings_auto_creates_defaults_and_unique_slug():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            r = await client.get(
                "/api/users/me/booking-settings",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["slug"].startswith("sam-owner")
            assert d["default_meeting_link_type"] == "none"
            assert d["duration_min"] == 30
            assert d["working_hours_start"] == 9 and d["working_hours_end"] == 17
        finally:
            await _cleanup(uid)
    _run(_t())


def test_slug_collision_gets_suffix():
    async def _t():
        uid1, tok1 = await _env()
        uid2 = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid2, "email": "sam@example.com",
            "password": hash_password("x"), "role": "client",
            "name": "Sam Owner",   # same name → same base slug
        })
        try:
            client = await _client()
            await client.get("/api/users/me/booking-settings",
                              headers={"Authorization": f"Bearer {tok1}"})
            tok2 = create_token(uid2, "client")
            r = await client.get("/api/users/me/booking-settings",
                                   headers={"Authorization": f"Bearer {tok2}"})
            slugs = {r.json()["slug"]}
            other = await db.user_booking_settings.find_one({"user_id": uid1})
            slugs.add(other["slug"])
            assert len(slugs) == 2
        finally:
            await db.user_booking_settings.delete_many({"user_id": uid2})
            await db.users.delete_one({"id": uid2})
            await _cleanup(uid1)
    _run(_t())


def test_update_settings_rejects_bad_link_type():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/users/me/booking-settings",
                headers={"Authorization": f"Bearer {tok}"},
                json={"default_meeting_link_type": "webex-fake"},
            )
            assert r.status_code == 400
        finally:
            await _cleanup(uid)
    _run(_t())


def test_update_settings_rejects_conflicting_slug():
    async def _t():
        uid1, tok1 = await _env()
        uid2 = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid2, "email": "b@example.com",
            "password": hash_password("x"), "role": "client",
            "name": "Bob",
        })
        try:
            client = await _client()
            await client.get("/api/users/me/booking-settings",
                              headers={"Authorization": f"Bearer {tok1}"})
            s1 = await db.user_booking_settings.find_one({"user_id": uid1})
            tok2 = create_token(uid2, "client")
            r = await client.post(
                "/api/users/me/booking-settings",
                headers={"Authorization": f"Bearer {tok2}"},
                json={"slug": s1["slug"]},
            )
            assert r.status_code == 400
            assert "taken" in r.text.lower()
        finally:
            await db.user_booking_settings.delete_many({"user_id": uid2})
            await db.users.delete_one({"id": uid2})
            await _cleanup(uid1)
    _run(_t())


def test_update_settings_rejects_end_before_start():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                "/api/users/me/booking-settings",
                headers={"Authorization": f"Bearer {tok}"},
                json={"working_hours_start": 17, "working_hours_end": 9},
            )
            assert r.status_code == 400
        finally:
            await _cleanup(uid)
    _run(_t())


def test_public_profile_hides_email_and_user_id():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            r = await client.get("/api/users/me/booking-settings",
                                   headers={"Authorization": f"Bearer {tok}"})
            slug = r.json()["slug"]
            # NO auth on public endpoint
            r2 = await client.get(f"/api/book/{slug}")
            assert r2.status_code == 200
            d = r2.json()
            assert d["slug"] == slug
            assert d["display_name"] == "Sam Owner"
            assert "user_id" not in d
            assert "email"   not in d
        finally:
            await _cleanup(uid)
    _run(_t())


def test_public_profile_404_for_unknown_slug():
    async def _t():
        client = await _client()
        r = await client.get("/api/book/nobody-here")
        assert r.status_code == 404
    _run(_t())


def test_slots_returns_empty_on_non_working_day():
    """Sunday (weekday=6) is outside the default Mon-Fri working days."""
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            await client.get("/api/users/me/booking-settings",
                              headers={"Authorization": f"Bearer {tok}"})
            slug = (await db.user_booking_settings.find_one({"user_id": uid}))["slug"]
            # Pick a Sunday
            d = datetime.now(timezone.utc)
            while d.weekday() != 6:
                d += timedelta(days=1)
            r = await client.get(f"/api/book/{slug}/slots",
                                   params={"date": d.date().isoformat()})
            assert r.status_code == 200
            assert r.json()["slots"] == []
        finally:
            await _cleanup(uid)
    _run(_t())


def test_slots_excludes_busy_intervals_and_past_times():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            await client.get("/api/users/me/booking-settings",
                              headers={"Authorization": f"Bearer {tok}"})
            slug = (await db.user_booking_settings.find_one({"user_id": uid}))["slug"]
            # Pick a weekday far enough in the future that all slots are valid.
            future = datetime.now(timezone.utc) + timedelta(days=7)
            while future.weekday() >= 5:
                future += timedelta(days=1)
            date = future.date().isoformat()

            # Busy from 10:00 UTC to 11:00 UTC — should remove one slot (10:00)
            busy_start = future.replace(hour=10, minute=0, second=0, microsecond=0)
            busy_end   = busy_start + timedelta(hours=1)

            async def _fake_busy(user_id, ds, de):
                return [(busy_start, busy_end)]
            with patch("routes.booking._load_busy_periods", new=_fake_busy):
                r = await client.get(f"/api/book/{slug}/slots",
                                       params={"date": date})
            assert r.status_code == 200
            slot_strs = r.json()["slots"]
            # 9-17 with 30 min slots = 16 potential; busy 10-11 kills 10:00 AND 10:30 → 14
            assert len(slot_strs) == 14
            # None of the slots start inside the busy window
            for s in slot_strs:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                assert not (dt.hour == 10)
        finally:
            await _cleanup(uid)
    _run(_t())


def test_book_creates_gcal_event_and_saves_booking():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            r0 = await client.post(
                "/api/users/me/booking-settings",
                headers={"Authorization": f"Bearer {tok}"},
                json={"default_meeting_link_type": "google_meet"},
            )
            slug = r0.json()["slug"]

            future = datetime.now(timezone.utc) + timedelta(days=3)
            while future.weekday() >= 5:
                future += timedelta(days=1)
            slot_iso = future.replace(hour=14, minute=0, second=0, microsecond=0).isoformat()

            fake_ev = {
                "id": "gcal_evt_1",
                "conferenceData": {"entryPoints": [
                    {"entryPointType": "video", "uri": "https://meet.google.com/xyz-abc"},
                ]},
            }
            fake_svc = MagicMock()
            fake_svc.events.return_value.insert.return_value.execute.return_value = fake_ev
            with patch("routes.gmail._creds_for_user",
                       new=AsyncMock(return_value=object())), \
                 patch("routes.google_calendar._calendar_service",
                       return_value=fake_svc):
                r = await client.post(
                    f"/api/book/{slug}/book",
                    json={"slot_iso": slot_iso, "name": "Alice Kim",
                           "email": "alice@example.com", "note": "renewal"},
                )
                assert r.status_code == 200, r.text
                b = r.json()["booking"]
                assert b["gcal_event_id"] == "gcal_evt_1"
                assert b["meet_link"] == "https://meet.google.com/xyz-abc"
                assert b["visitor_email"] == "alice@example.com"
            # Persisted
            row = await db.bookings.find_one({"id": b["id"]})
            assert row is not None
            # Free/busy cache for that day was invalidated
            cache_key = f"{uid}::{future.date().isoformat()}"
            assert await db.freebusy_cache.find_one({"_id": cache_key}) is None
        finally:
            await _cleanup(uid)
    _run(_t())


def test_book_rejects_past_slot():
    async def _t():
        uid, tok = await _env()
        try:
            client = await _client()
            await client.get("/api/users/me/booking-settings",
                              headers={"Authorization": f"Bearer {tok}"})
            slug = (await db.user_booking_settings.find_one({"user_id": uid}))["slug"]
            past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
            r = await client.post(
                f"/api/book/{slug}/book",
                json={"slot_iso": past, "name": "A", "email": "a@x.com"},
            )
            assert r.status_code == 400
        finally:
            await _cleanup(uid)
    _run(_t())
