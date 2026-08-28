"""Task ↔ Google Calendar sync (Feb 2026).

Whenever a **meeting** task is created / updated / deleted (or a plain
task with a `due_date` is turned into one), we mirror it to the
creator's Google Calendar iff that user has connected Google.

Design rules
------------
1. **Creator owns the mirror.** We push to the calendar of
   ``task.created_by_user_id`` — that's who gets to be the organizer
   inside Google. Attendees see it via Google's invite emails.
2. **Only ``kind == \"meeting\"`` mirrors.** Regular tasks stay in-app.
3. **Attendees** come from:
     * every contact in ``contact_ids`` that has an email
     * every teammate in ``assignee_user_ids`` (excluding the creator)
       resolved via `users.email`
4. **Idempotency.** Once mirrored the task carries
   ``google_event_id``; subsequent updates PATCH that id, deletes call
   DELETE. If the Google call fails we swallow the error — the app
   task is still authoritative.
5. **Backfill.** When the user connects Google we call
   `sync_all_meetings_for_user` which enumerates every meeting the
   user created in every company they belong to and pushes any that
   don't yet have a ``google_event_id``.
"""
from __future__ import annotations

import logging
from typing import Optional

from db import db
from routes.gmail import _creds_for_user
from routes.google_calendar import _calendar_service

log = logging.getLogger("axiom.tasksync")


# ── time helpers ─────────────────────────────────────────────────────

def _task_time_range(task: dict) -> Optional[tuple[str, str, bool, str]]:
    """Return `(start, end, all_day, time_zone)` in the shape Google
    expects, or None if the task has no usable schedule."""
    due_date = task.get("due_date")
    if not due_date:
        return None
    due_time = task.get("due_time")
    duration = int(task.get("duration_minutes") or 0)
    if not due_time:
        # All-day event
        return (due_date, due_date, True, "UTC")
    # Compute end
    from datetime import datetime, timedelta
    try:
        h, m = map(int, due_time.split(":"))
    except Exception:
        return (due_date, due_date, True, "UTC")
    start_dt = datetime.fromisoformat(f"{due_date}T{h:02d}:{m:02d}:00")
    dur = duration or 30
    end_dt = start_dt + timedelta(minutes=dur)
    start_s = start_dt.isoformat(timespec="seconds")
    end_s = end_dt.isoformat(timespec="seconds")
    return (start_s, end_s, False, task.get("time_zone") or "UTC")


async def _attendee_emails(task: dict) -> list[str]:
    emails: list[str] = []
    cid = task["company_id"]
    for contact_id in (task.get("contact_ids") or []):
        c = await db.contacts.find_one(
            {"company_id": cid, "id": contact_id},
            {"email": 1},
        )
        if c and c.get("email"):
            emails.append(c["email"].lower())
    for uid in (task.get("assignee_user_ids") or []):
        if uid == task.get("created_by_user_id"):
            continue
        u = await db.users.find_one({"id": uid}, {"email": 1})
        if u and u.get("email"):
            emails.append(u["email"].lower())
    # De-dupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for e in emails:
        if e not in seen:
            seen.add(e); out.append(e)
    return out


def _build_body(task: dict, emails: list[str]) -> Optional[dict]:
    rng = _task_time_range(task)
    if not rng:
        return None
    start, end, all_day, tz = rng
    body: dict = {"summary": task.get("title") or "(no title)"}
    if task.get("description"):
        body["description"] = task["description"]
    if all_day:
        body["start"] = {"date": start}
        body["end"]   = {"date": end}
    else:
        body["start"] = {"dateTime": start, "timeZone": tz}
        body["end"]   = {"dateTime": end,   "timeZone": tz}
    if emails:
        body["attendees"] = [{"email": e} for e in emails]
    return body


# ── low-level ops ────────────────────────────────────────────────────

async def _google_creds_or_none(user_id: str):
    """Return credentials for user, or None if not connected."""
    tok = await db.gmail_tokens.find_one({"user_id": user_id})
    if not tok or not tok.get("refresh_token"):
        return None
    try:
        return await _creds_for_user(user_id)
    except Exception:
        return None


async def _stamp_event(cid: str, task_id: str, event_id: str, calendar_id: str, by_user: str):
    await db.tasks.update_one(
        {"company_id": cid, "id": task_id},
        {"$set": {
            "google_event_id":  event_id,
            "google_calendar_id": calendar_id,
            "google_synced_by_user_id": by_user,
        }},
    )


# ── public API — called from tasks.py hooks ─────────────────────────

async def sync_task_created(task: dict) -> Optional[str]:
    """Push a newly-created meeting task to the creator's Google.
    Returns the Google event id on success, or None otherwise."""
    if task.get("kind") != "meeting":
        return None
    creator_id = task.get("created_by_user_id")
    if not creator_id:
        return None
    creds = await _google_creds_or_none(creator_id)
    if not creds:
        return None
    emails = await _attendee_emails(task)
    body = _build_body(task, emails)
    if not body:
        return None
    try:
        svc = _calendar_service(creds)
        ev = svc.events().insert(
            calendarId="primary", body=body, sendUpdates="all" if emails else "none",
        ).execute()
    except Exception as e:
        log.warning("sync_task_created failed: %s", e)
        return None
    event_id = ev.get("id")
    if event_id:
        await _stamp_event(task["company_id"], task["id"], event_id, "primary", creator_id)
    return event_id


async def sync_task_updated(task: dict) -> Optional[str]:
    """PATCH the mirror event if it already exists, or INSERT if the
    kind was just flipped to 'meeting' and there's no mirror yet."""
    if task.get("kind") != "meeting":
        # Might have been changed away from meeting → delete stale event
        if task.get("google_event_id"):
            await sync_task_deleted(task)
        return None
    if not task.get("google_event_id"):
        return await sync_task_created(task)
    creator_id = task.get("google_synced_by_user_id") or task.get("created_by_user_id")
    if not creator_id:
        return None
    creds = await _google_creds_or_none(creator_id)
    if not creds:
        return None
    emails = await _attendee_emails(task)
    body = _build_body(task, emails)
    if not body:
        return None
    try:
        svc = _calendar_service(creds)
        svc.events().patch(
            calendarId=task.get("google_calendar_id") or "primary",
            eventId=task["google_event_id"],
            body=body, sendUpdates="all" if emails else "none",
        ).execute()
    except Exception as e:
        log.warning("sync_task_updated failed: %s", e)
    return task.get("google_event_id")


async def sync_task_deleted(task: dict) -> None:
    event_id = task.get("google_event_id")
    if not event_id:
        return
    creator_id = task.get("google_synced_by_user_id") or task.get("created_by_user_id")
    if not creator_id:
        return
    creds = await _google_creds_or_none(creator_id)
    if not creds:
        return
    try:
        svc = _calendar_service(creds)
        svc.events().delete(
            calendarId=task.get("google_calendar_id") or "primary",
            eventId=event_id, sendUpdates="all",
        ).execute()
    except Exception as e:
        log.warning("sync_task_deleted failed: %s", e)


# ── backfill on Google connect ───────────────────────────────────────

async def sync_all_meetings_for_user(user_id: str) -> int:
    """Push every un-mirrored meeting the user created (across all
    companies) to their Google Calendar. Returns count pushed."""
    creds = await _google_creds_or_none(user_id)
    if not creds:
        return 0
    cursor = db.tasks.find({
        "created_by_user_id": user_id,
        "kind": "meeting",
        "$or": [
            {"google_event_id": {"$exists": False}},
            {"google_event_id": None},
            {"google_event_id": ""},
        ],
        "due_date": {"$ne": None},
    })
    pushed = 0
    async for task in cursor:
        try:
            ev_id = await sync_task_created(task)
            if ev_id:
                pushed += 1
        except Exception as e:
            log.warning("backfill failed for task %s: %s", task.get("id"), e)
    return pushed
