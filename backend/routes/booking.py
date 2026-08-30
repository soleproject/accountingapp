"""Booking + meeting-link settings — Phase 2 (Feb 2026).

Two capabilities:
  1. Per-user meeting-link preference (Google Meet / Zoom / Teams / Whereby / Custom)
     stored in ``user_booking_settings``. Voice intents ``send_meeting_link``
     and ``send_calendar_link`` (in ``voice_actions.py``) pick this up.

  2. Calendly-style public booking page at ``/book/{slug}``. Anyone with
     the URL can pick a time from the user's free/busy calendar; a
     confirmation creates the Google Calendar event with them as an
     attendee (Meet link auto-attached when the user's default type is
     ``google_meet``). External bookers never sign in — no auth on
     ``/api/book/*`` GET/POST.

The GCal free/busy call is the only expensive path; results are cached
per user for 5 min so a public page hammered by refreshes doesn't melt
Google API quota.
"""
from __future__ import annotations
import os
import re
import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user
from db import db, now_iso

log = logging.getLogger("booking")
router = APIRouter(prefix="/api")

# ── constants ────────────────────────────────────────────────────
MEETING_LINK_TYPES = {"google_meet", "zoom", "teams", "whereby", "custom", "none"}
DEFAULT_DURATION_MIN = 30
SLOT_CACHE_TTL_SEC = 5 * 60


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:40] or ("u-" + uuid.uuid4().hex[:6])


# ── settings CRUD ────────────────────────────────────────────────

class BookingSettingsIn(BaseModel):
    slug: Optional[str] = None
    default_meeting_link_type: Optional[str] = None
    static_link_url: Optional[str] = None
    working_hours_start: Optional[int] = None   # 0-23, local hour
    working_hours_end:   Optional[int] = None
    working_days:        Optional[list[int]] = None  # 0=Mon .. 6=Sun
    duration_min: Optional[int] = None
    timezone:     Optional[str] = None


DEFAULT_SETTINGS = {
    "default_meeting_link_type": "none",
    "static_link_url": "",
    "working_hours_start": 9,
    "working_hours_end":   17,
    "working_days":        [0, 1, 2, 3, 4],   # Mon-Fri
    "duration_min":        DEFAULT_DURATION_MIN,
    "timezone":            "America/New_York",
}


async def _get_or_create_settings(user: dict) -> dict:
    doc = await db.user_booking_settings.find_one({"user_id": user["id"]})
    if doc:
        doc.pop("_id", None)
        return doc
    slug_base = _slugify(user.get("name") or user.get("email") or "u")
    slug = slug_base
    # Ensure uniqueness
    while await db.user_booking_settings.find_one({"slug": slug}):
        slug = f"{slug_base}-{uuid.uuid4().hex[:4]}"
    doc = {
        "user_id": user["id"], "slug": slug,
        "display_name": user.get("name") or user.get("email"),
        **DEFAULT_SETTINGS,
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.user_booking_settings.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/users/me/booking-settings")
async def get_booking_settings(user: dict = Depends(get_current_user)) -> dict:
    doc = await _get_or_create_settings(user)
    return doc


@router.post("/users/me/booking-settings")
async def update_booking_settings(inp: BookingSettingsIn,
                                     user: dict = Depends(get_current_user)) -> dict:
    current = await _get_or_create_settings(user)
    updates: dict = {"updated_at": now_iso()}

    if inp.slug and inp.slug != current["slug"]:
        clean = _slugify(inp.slug)
        clash = await db.user_booking_settings.find_one(
            {"slug": clean, "user_id": {"$ne": user["id"]}},
        )
        if clash:
            raise HTTPException(400, "That URL is taken — pick another")
        updates["slug"] = clean

    if inp.default_meeting_link_type is not None:
        if inp.default_meeting_link_type not in MEETING_LINK_TYPES:
            raise HTTPException(400, f"Invalid link type: {inp.default_meeting_link_type}")
        updates["default_meeting_link_type"] = inp.default_meeting_link_type

    if inp.static_link_url is not None:
        updates["static_link_url"] = inp.static_link_url.strip()

    for k in ("working_hours_start", "working_hours_end", "duration_min",
               "timezone", "working_days"):
        v = getattr(inp, k)
        if v is not None:
            updates[k] = v

    # Sanity: end > start
    hs = updates.get("working_hours_start", current["working_hours_start"])
    he = updates.get("working_hours_end", current["working_hours_end"])
    if not (0 <= hs < he <= 24):
        raise HTTPException(400, "Working hours must have end > start (24h format)")

    await db.user_booking_settings.update_one(
        {"user_id": user["id"]}, {"$set": updates},
    )
    doc = await db.user_booking_settings.find_one({"user_id": user["id"]})
    doc.pop("_id", None)
    return doc


# ── public booking page ─────────────────────────────────────────

@router.get("/book/{slug}")
async def public_profile(slug: str) -> dict:
    doc = await db.user_booking_settings.find_one({"slug": slug})
    if not doc:
        raise HTTPException(404, "Booking page not found")
    return {
        "slug":          doc["slug"],
        "display_name":  doc.get("display_name") or "Team member",
        "duration_min":  doc.get("duration_min") or DEFAULT_DURATION_MIN,
        "timezone":      doc.get("timezone") or "UTC",
        "working_days":  doc.get("working_days") or [0, 1, 2, 3, 4],
        "working_hours": {
            "start": doc.get("working_hours_start") or 9,
            "end":   doc.get("working_hours_end")   or 17,
        },
    }


async def _load_busy_periods(user_id: str, day_start: datetime,
                                day_end: datetime) -> list[tuple[datetime, datetime]]:
    """Fetch GCal busy intervals for the day. Cached 5 min per (user,day).
    Silent fail → returns []."""
    try:
        from routes.gmail import _creds_for_user
        from routes.google_calendar import _calendar_service
    except Exception:
        return []
    cache_key = f"{user_id}::{day_start.date().isoformat()}"
    cached = await db.freebusy_cache.find_one({"_id": cache_key})
    if cached:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(cached["at"])).total_seconds()
            if age < SLOT_CACHE_TTL_SEC:
                return [(datetime.fromisoformat(b[0]), datetime.fromisoformat(b[1]))
                         for b in (cached.get("busy") or [])]
        except Exception:
            pass
    try:
        creds = await _creds_for_user(user_id)
        if not creds:
            return []
        svc = _calendar_service(creds)
        fb = svc.freebusy().query(body={
            "timeMin": day_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "timeMax": day_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "items":   [{"id": "primary"}],
        }).execute()
        busy_raw = ((fb.get("calendars") or {}).get("primary") or {}).get("busy") or []
        pairs = []
        for b in busy_raw:
            try:
                s = datetime.fromisoformat(b["start"].replace("Z", "+00:00"))
                e = datetime.fromisoformat(b["end"].replace("Z", "+00:00"))
                pairs.append((s, e))
            except Exception:
                continue
        await db.freebusy_cache.update_one(
            {"_id": cache_key},
            {"$set": {"_id": cache_key,
                       "busy": [[s.isoformat(), e.isoformat()] for s, e in pairs],
                       "at":   now_iso()}},
            upsert=True,
        )
        return pairs
    except Exception as e:
        log.warning("freebusy failed for %s: %s", user_id, e)
        return []


@router.get("/book/{slug}/slots")
async def public_slots(slug: str, date: str) -> dict:
    """Return available start times for the given YYYY-MM-DD.
    Everything computed in the host's tz (settings.timezone) so
    slots line up with their working hours; results returned as UTC
    ISO strings the client can format in the visitor's tz."""
    doc = await db.user_booking_settings.find_one({"slug": slug})
    if not doc:
        raise HTTPException(404, "Booking page not found")
    try:
        y, mo, d = map(int, date.split("-"))
        target_date = datetime(y, mo, d, tzinfo=timezone.utc)
    except Exception:
        raise HTTPException(400, "Bad date (expected YYYY-MM-DD)")

    working_days = doc.get("working_days") or [0, 1, 2, 3, 4]
    if target_date.weekday() not in working_days:
        return {"date": date, "slots": []}

    hs = doc.get("working_hours_start") or 9
    he = doc.get("working_hours_end")   or 17
    duration = int(doc.get("duration_min") or DEFAULT_DURATION_MIN)

    day_start = target_date.replace(hour=hs, minute=0)
    day_end   = target_date.replace(hour=he, minute=0)
    busy = await _load_busy_periods(doc["user_id"],
                                       day_start - timedelta(hours=1),
                                       day_end   + timedelta(hours=1))
    slots: list[str] = []
    cur = day_start
    while cur + timedelta(minutes=duration) <= day_end:
        slot_end = cur + timedelta(minutes=duration)
        # Skip slots that overlap any busy interval
        overlaps = any((cur < e) and (slot_end > s) for s, e in busy)
        # Skip past slots (visitor can't book yesterday's 2pm)
        if not overlaps and cur > datetime.now(timezone.utc):
            slots.append(cur.isoformat())
        cur += timedelta(minutes=duration)
    return {"date": date, "duration_min": duration, "slots": slots}


class BookIn(BaseModel):
    slot_iso: str
    name: str
    email: str
    note: Optional[str] = ""


@router.post("/book/{slug}/book")
async def public_book(slug: str, inp: BookIn) -> dict:
    doc = await db.user_booking_settings.find_one({"slug": slug})
    if not doc:
        raise HTTPException(404, "Booking page not found")
    try:
        start_dt = datetime.fromisoformat(inp.slot_iso.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(400, "Bad slot_iso")
    if start_dt < datetime.now(timezone.utc):
        raise HTTPException(400, "That slot has passed")
    duration = int(doc.get("duration_min") or DEFAULT_DURATION_MIN)
    end_dt = start_dt + timedelta(minutes=duration)

    booking_id = str(uuid.uuid4())
    booking = {
        "id":          booking_id,
        "slug":        slug,
        "user_id":     doc["user_id"],
        "visitor_name":  inp.name.strip(),
        "visitor_email": inp.email.strip().lower(),
        "note":        (inp.note or "").strip(),
        "start_iso":   start_dt.isoformat(),
        "end_iso":     end_dt.isoformat(),
        "duration_min": duration,
        "status":      "confirmed",
        "gcal_event_id": None,
        "meet_link":   None,
        "created_at":  now_iso(),
    }

    # Create the GCal event on the host's calendar
    try:
        from routes.gmail import _creds_for_user
        from routes.google_calendar import _calendar_service
        creds = await _creds_for_user(doc["user_id"])
        if creds:
            svc = _calendar_service(creds)
            event_body = {
                "summary": f"{inp.name} <> {doc.get('display_name') or 'Meeting'}",
                "description": booking["note"] or "Booked via SmartBooks",
                "start": {"dateTime": start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")},
                "end":   {"dateTime": end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")},
                "attendees": [{"email": booking["visitor_email"], "displayName": inp.name}],
            }
            # Auto-attach a Meet link when the host prefers Google Meet
            if doc.get("default_meeting_link_type") == "google_meet":
                event_body["conferenceData"] = {
                    "createRequest": {"requestId": booking_id,
                                       "conferenceSolutionKey": {"type": "hangoutsMeet"}},
                }
                ev = svc.events().insert(calendarId="primary", body=event_body,
                                           conferenceDataVersion=1,
                                           sendUpdates="all").execute()
                for ep in ((ev.get("conferenceData") or {}).get("entryPoints") or []):
                    if ep.get("entryPointType") == "video":
                        booking["meet_link"] = ep.get("uri")
                        break
            else:
                ev = svc.events().insert(calendarId="primary", body=event_body,
                                           sendUpdates="all").execute()
                # For static-link types, embed the URL in the event
                link_url = doc.get("static_link_url") or ""
                if link_url:
                    booking["meet_link"] = link_url
            booking["gcal_event_id"] = ev.get("id")
    except Exception as e:
        log.warning("gcal booking event failed (slot still saved): %s", e)

    await db.bookings.insert_one(booking)
    # Invalidate that day's free/busy cache so subsequent visitors see the new busy interval
    await db.freebusy_cache.delete_one(
        {"_id": f"{doc['user_id']}::{start_dt.date().isoformat()}"},
    )
    booking.pop("_id", None)
    return {"ok": True, "booking": booking}
