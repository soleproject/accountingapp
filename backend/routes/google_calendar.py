"""Google Calendar — Tier 3 calendar integration (Feb 2026).

Piggybacks on the existing Google OAuth flow in ``routes.gmail`` — the
scopes list there already includes ``calendar`` and ``calendar.events``.
No separate consent step is needed: reconnecting Gmail also grants
calendar access.

Routes (all prefixed ``/api``):

    GET  /google/calendar/list                        — list of user's calendars
    GET  /google/calendar/events?time_min=&time_max=  — pull events
    POST /google/calendar/events                      — create event (+ optional
                                                         auto-invite attendees)
    PATCH /google/calendar/events/{event_id}          — update
    DELETE /google/calendar/events/{event_id}         — delete

Two-way sync model
------------------
* **App → Google (write)**: any handler that creates an app-side meeting
  (task with `kind=meeting`, deal-scheduled meeting) calls POST
  ``/google/calendar/events``. The returned Google `event_id` is
  stored on the source entity (``task.google_event_id``) so future
  updates/deletes flow through.
* **Google → App (read)**: the CRM calendar and the Team Calendar
  page pull Google events on demand (no local mirror). The Team
  Calendar's "Google" toggle just adds these events to the render
  pass alongside tasks/phases/time entries.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from pydantic import BaseModel

from auth import get_current_user
from routes.gmail import _creds_for_user  # reuse token store

router = APIRouter(prefix="/api")


def _calendar_service(creds):
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


# ─── list calendars ─────────────────────────────────────────────────

@router.get("/google/calendar/list")
async def list_calendars(user: dict = Depends(get_current_user)):
    creds = await _creds_for_user(user["id"])
    svc = _calendar_service(creds)
    try:
        res = svc.calendarList().list().execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    cals = res.get("items", []) or []
    return {
        "calendars": [{
            "id":          c.get("id"),
            "summary":     c.get("summary"),
            "primary":     c.get("primary", False),
            "background_color": c.get("backgroundColor"),
            "foreground_color": c.get("foregroundColor"),
            "access_role": c.get("accessRole"),
        } for c in cals]
    }


# ─── list events ────────────────────────────────────────────────────

def _event_to_json(e: dict) -> dict:
    """Shrink a Google Calendar event to a UI-friendly shape."""
    start = e.get("start", {}) or {}
    end   = e.get("end", {}) or {}
    all_day = "date" in start and "dateTime" not in start
    return {
        "id":           e.get("id"),
        "summary":      e.get("summary", ""),
        "description":  e.get("description", ""),
        "location":     e.get("location", ""),
        "html_link":    e.get("htmlLink"),
        "hangout_link": e.get("hangoutLink"),
        "start":        start.get("dateTime") or start.get("date"),
        "end":          end.get("dateTime")   or end.get("date"),
        "all_day":      all_day,
        "organizer":    (e.get("organizer") or {}).get("email"),
        "attendees":    [{
            "email":            a.get("email"),
            "display_name":     a.get("displayName"),
            "response_status":  a.get("responseStatus"),
            "organizer":        a.get("organizer", False),
            "self":             a.get("self", False),
        } for a in (e.get("attendees") or [])],
        "status":       e.get("status"),
        "created":      e.get("created"),
        "updated":      e.get("updated"),
        "recurring_event_id": e.get("recurringEventId"),
    }


@router.get("/google/calendar/events")
async def list_events(
    time_min: str = Query(..., description="ISO 8601 lower bound"),
    time_max: str = Query(..., description="ISO 8601 upper bound"),
    calendar_id: str = "primary",
    q: Optional[str] = None,
    max_results: int = 250,
    user: dict = Depends(get_current_user),
):
    """Return events in [time_min, time_max) for the given calendar.
    Time bounds must be RFC3339 (e.g. ``2026-02-01T00:00:00Z``)."""
    creds = await _creds_for_user(user["id"])
    svc = _calendar_service(creds)
    kwargs = {
        "calendarId":    calendar_id,
        "timeMin":       time_min,
        "timeMax":       time_max,
        "singleEvents":  True,
        "orderBy":       "startTime",
        "maxResults":    max(1, min(max_results, 2500)),
    }
    if q:
        kwargs["q"] = q
    try:
        res = svc.events().list(**kwargs).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    items = res.get("items", []) or []
    return {"events": [_event_to_json(x) for x in items], "calendar_id": calendar_id}


# ─── create / update / delete events ────────────────────────────────

class EventAttendee(BaseModel):
    email: str
    display_name: Optional[str] = None


class EventIn(BaseModel):
    summary: str
    description: Optional[str] = ""
    location: Optional[str] = ""
    # RFC3339 with tz, e.g. "2026-03-05T09:00:00-05:00", OR all-day "YYYY-MM-DD"
    start: str
    end: str
    all_day: bool = False
    time_zone: Optional[str] = "UTC"
    attendees: list[EventAttendee] = []
    calendar_id: str = "primary"
    send_updates: str = "all"    # "all" | "externalOnly" | "none"
    add_meet_link: bool = False  # add a Google Meet conference


def _build_time(v: str, all_day: bool, tz: str) -> dict:
    if all_day:
        return {"date": v}
    return {"dateTime": v, "timeZone": tz or "UTC"}


@router.post("/google/calendar/events")
async def create_event(inp: EventIn, user: dict = Depends(get_current_user)):
    creds = await _creds_for_user(user["id"])
    svc = _calendar_service(creds)

    body = {
        "summary":     inp.summary,
        "description": inp.description or "",
        "location":    inp.location or "",
        "start":       _build_time(inp.start, inp.all_day, inp.time_zone),
        "end":         _build_time(inp.end,   inp.all_day, inp.time_zone),
    }
    if inp.attendees:
        body["attendees"] = [
            {"email": a.email, **({"displayName": a.display_name} if a.display_name else {})}
            for a in inp.attendees
        ]

    kwargs = {
        "calendarId":   inp.calendar_id,
        "body":         body,
        "sendUpdates":  inp.send_updates or "none",
    }
    if inp.add_meet_link:
        import uuid as _u
        body["conferenceData"] = {
            "createRequest": {
                "requestId": _u.uuid4().hex,
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        }
        kwargs["conferenceDataVersion"] = 1

    try:
        e = svc.events().insert(**kwargs).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return _event_to_json(e)


class EventPatch(BaseModel):
    summary: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    all_day: Optional[bool] = None
    time_zone: Optional[str] = None
    attendees: Optional[list[EventAttendee]] = None
    calendar_id: str = "primary"
    send_updates: str = "all"


@router.patch("/google/calendar/events/{event_id}")
async def update_event(
    event_id: str,
    inp: EventPatch,
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _calendar_service(creds)
    body: dict = {}
    if inp.summary is not None:     body["summary"] = inp.summary
    if inp.description is not None: body["description"] = inp.description
    if inp.location is not None:    body["location"] = inp.location
    if inp.start is not None:
        body["start"] = _build_time(inp.start, bool(inp.all_day), inp.time_zone or "UTC")
    if inp.end is not None:
        body["end"] = _build_time(inp.end, bool(inp.all_day), inp.time_zone or "UTC")
    if inp.attendees is not None:
        body["attendees"] = [
            {"email": a.email, **({"displayName": a.display_name} if a.display_name else {})}
            for a in inp.attendees
        ]
    try:
        e = svc.events().patch(
            calendarId=inp.calendar_id, eventId=event_id,
            body=body, sendUpdates=inp.send_updates or "none",
        ).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return _event_to_json(e)


@router.delete("/google/calendar/events/{event_id}")
async def delete_event(
    event_id: str,
    calendar_id: str = "primary",
    send_updates: str = "none",
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _calendar_service(creds)
    try:
        svc.events().delete(
            calendarId=calendar_id, eventId=event_id, sendUpdates=send_updates,
        ).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return {"ok": True}
