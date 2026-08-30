"""CRM — "My Day" aggregator endpoint (Feb 2026).

Returns everything a user needs to execute on a single day, in one round-trip:
  * today's meetings/appointments (app tasks + Google Calendar overlay)
  * tasks due today
  * calls to make today (`kind == call`)
  * unread Gmail preview (if connected)
  * deals needing follow-up (per company follow_up config)
  * overdue items (any past-due tasks not yet done)

Follow-up rule
--------------
For every deal where stage NOT IN {won, lost}:
  * look at the timestamp of the most recent activity (`activities[-1].at`)
    or, if no activity, the deal's `created_at`
  * pick a threshold — if the last activity's `kind` has a per-activity
    override in `crm_settings.follow_up.per_activity`, use that;
    otherwise use `crm_settings.follow_up.default_days` (default 7).
  * flag when now − last_touch ≥ threshold.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from deps import require_company
from db import db, now_iso

router = APIRouter(prefix="/api")


def _parse(dt: Optional[str]) -> Optional[datetime]:
    if not dt:
        return None
    try:
        d = datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except Exception:
        return None


def _today_bounds(tz_offset_min: int = 0) -> tuple[str, str]:
    """Return (today_YYYY-MM-DD, tomorrow_YYYY-MM-DD) shifted by offset."""
    now = datetime.now(timezone.utc) + timedelta(minutes=tz_offset_min)
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    return today, tomorrow


async def _follow_up_config(cid: str) -> dict:
    doc = await db.crm_settings.find_one({"company_id": cid}, {"follow_up": 1})
    fu = ((doc or {}).get("follow_up") or {}) if doc else {}
    return {
        "default_days": int(fu.get("default_days") or 7),
        "per_activity": {str(k).lower(): int(v)
                          for k, v in (fu.get("per_activity") or {}).items()},
    }


@router.get("/companies/{cid}/my-day")
async def my_day(
    cid: str,
    tz_offset_min: int = 0,   # client-supplied so "today" matches the user's clock
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    today, tomorrow = _today_bounds(tz_offset_min)
    uid = user["id"]

    # ── Tasks scheduled for today (any status) ─────────────────────
    tasks_today_cur = db.tasks.find({
        "company_id": cid,
        "due_date": today,
    }).sort([("due_time", 1)])
    all_today = []
    async for t in tasks_today_cur:
        t.pop("_id", None)
        all_today.append(t)

    # Partition — open by kind, plus completed lists
    def _is_done(t): return (t.get("status") or "").lower() == "done"
    tasks_today = [t for t in all_today if not _is_done(t)]
    completed_today = [t for t in all_today if _is_done(t)]

    appointments = [t for t in tasks_today if t.get("kind") == "meeting"]
    calls        = [t for t in tasks_today if t.get("kind") == "call"]
    other_tasks  = [t for t in tasks_today if t.get("kind") not in ("meeting", "call")]

    completed_appointments = [t for t in completed_today if t.get("kind") == "meeting"]
    completed_calls        = [t for t in completed_today if t.get("kind") == "call"]
    completed_other        = [t for t in completed_today if t.get("kind") not in ("meeting", "call")]

    # ── Overdue (past due, still open) ────────────────────────────
    overdue_cur = db.tasks.find({
        "company_id": cid,
        "due_date": {"$lt": today},
        "$or": [{"status": {"$ne": "done"}}, {"status": {"$exists": False}}],
    }).sort([("due_date", -1)]).limit(50)
    overdue = []
    async for t in overdue_cur:
        t.pop("_id", None)
        overdue.append(t)

    # ── Deals needing follow-up ────────────────────────────────────
    fu_cfg = await _follow_up_config(cid)
    now = datetime.now(timezone.utc)
    deals_cur = db.deals.find({
        "company_id": cid,
        "stage": {"$nin": ["won", "lost"]},
    })
    follow_ups: list[dict] = []
    async for d in deals_cur:
        d.pop("_id", None)
        acts = d.get("activities") or []
        # Ignore system/stage_change auto-events when computing "last touch"
        touch_acts = [a for a in acts
                       if a.get("kind") not in ("stage_change", "system")]
        last_touch: Optional[datetime] = None
        last_kind = ""
        if touch_acts:
            last = touch_acts[-1]
            last_touch = _parse(last.get("at"))
            last_kind = (last.get("kind") or "").lower()
        if last_touch is None:
            last_touch = _parse(d.get("created_at"))
        if last_touch is None:
            continue
        threshold = fu_cfg["per_activity"].get(last_kind, fu_cfg["default_days"])
        days_since = (now - last_touch).days
        if days_since >= threshold:
            follow_ups.append({
                **d,
                "days_since_activity": days_since,
                "last_activity_kind":  last_kind,
                "threshold_days":      threshold,
            })
    # Sort: most-overdue first
    follow_ups.sort(key=lambda x: (-x["days_since_activity"], x.get("stage", "")))
    follow_ups = follow_ups[:15]

    # ── Unread emails count + last few threads (best-effort) ──────
    unread = {"connected": False, "count": 0, "threads": []}
    tok = await db.gmail_tokens.find_one({"user_id": uid})
    if tok and tok.get("refresh_token"):
        unread["connected"] = True
        try:
            from routes.gmail import _creds_for_user, _gmail_service, _get_header
            from googleapiclient.errors import HttpError
            creds = await _creds_for_user(uid)
            svc = _gmail_service(creds)
            res = svc.users().threads().list(
                userId="me", q="is:unread label:inbox", maxResults=5,
            ).execute()
            for t in (res.get("threads") or []):
                try:
                    td = svc.users().threads().get(
                        userId="me", id=t["id"], format="metadata",
                        metadataHeaders=["From", "Subject", "Date"],
                    ).execute()
                    msgs = td.get("messages") or []
                    last = msgs[-1] if msgs else {}
                    headers = (last.get("payload") or {}).get("headers", [])
                    unread["threads"].append({
                        "id":      td.get("id"),
                        "from":    _get_header(headers, "From"),
                        "subject": _get_header(headers, "Subject"),
                        "date":    _get_header(headers, "Date"),
                        "snippet": td.get("snippet", ""),
                    })
                except HttpError:
                    continue
            # Best-effort total unread count in Inbox
            try:
                lbl = svc.users().labels().get(userId="me", id="INBOX").execute()
                unread["count"] = lbl.get("messagesUnread", len(unread["threads"]))
            except HttpError:
                unread["count"] = len(unread["threads"])
        except Exception:
            unread["threads"] = []

    # ── Google Calendar events for today (overlay) ─────────────────
    # Merge non-duplicate GCal events into `appointments` so the user
    # sees externally-scheduled meetings alongside app-side ones.
    # De-dupe against tasks whose `google_event_id` matches; those
    # tasks are the app's mirror of the GCal event and take priority.
    try:
        from routes.gmail import _creds_for_user
        from routes.google_calendar import _calendar_service, _event_to_json
        from googleapiclient.errors import HttpError as _HttpError  # noqa
        creds = await _creds_for_user(uid)
    except Exception:
        creds = None
    if creds:
        try:
            svc = _calendar_service(creds)
            base = datetime.now(timezone.utc) + timedelta(minutes=tz_offset_min)
            day_start_local = base.replace(hour=0, minute=0, second=0, microsecond=0)
            day_start_utc = day_start_local - timedelta(minutes=tz_offset_min)
            day_end_utc   = day_start_utc + timedelta(days=1)
            res = svc.events().list(
                calendarId="primary",
                timeMin=day_start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                timeMax=day_end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                singleEvents=True,
                orderBy="startTime",
                maxResults=50,
            ).execute()
            gcal_events = [_event_to_json(e) for e in (res.get("items") or [])
                            if (e.get("status") or "") != "cancelled"]
            mirrored_ids = {t.get("google_event_id") for t in all_today
                             if t.get("google_event_id")}
            for ev in gcal_events:
                if ev["id"] in mirrored_ids:
                    continue
                self_attendee = next(
                    (a for a in (ev.get("attendees") or []) if a.get("self")),
                    None,
                )
                if self_attendee and (self_attendee.get("response_status") == "declined"):
                    continue
                start_iso = ev.get("start") or ""
                due_time = None
                if not ev.get("all_day"):
                    dt = _parse(start_iso)
                    if dt is not None:
                        dt_local = dt + timedelta(minutes=tz_offset_min)
                        due_time = dt_local.strftime("%H:%M")
                appointments.append({
                    "id":            f"gcal:{ev['id']}",
                    "kind":          "meeting",
                    "title":         ev.get("summary") or "(no title)",
                    "due_date":      today,
                    "due_time":      due_time,
                    "status":        "open",
                    "source":        "gcal",
                    "location":      ev.get("location") or "",
                    "html_link":     ev.get("html_link"),
                    "hangout_link":  ev.get("hangout_link"),
                    "attendees":     ev.get("attendees") or [],
                    "all_day":       ev.get("all_day", False),
                })
        except Exception:
            # Silent — GCal is a nice-to-have overlay, never a hard fail.
            pass
    appointments.sort(key=lambda a: (a.get("due_time") or "99:99", a.get("title") or ""))

    return {
        "date":         today,
        "appointments": appointments,
        "tasks":        other_tasks,
        "calls":        calls,
        "overdue":      overdue,
        "follow_ups":   follow_ups,
        "unread":       unread,
        "follow_up_config": fu_cfg,
        # Completed-today buckets (parallel to the open ones) — populated
        # for the "Completed" tab on the My Day UI. Only includes tasks
        # whose due_date == today so we don't leak yesterday's cleanup.
        "completed": {
            "appointments": completed_appointments,
            "calls":        completed_calls,
            "tasks":        completed_other,
        },
        "completed_count": len(completed_today),
    }


# ── Morning Brief — Claude-generated 3-sentence summary ─────────────

BRIEF_SYSTEM_PROMPT = """You are an executive assistant summarising the
user's day for a busy sales/CRM operator. Write EXACTLY 2-3 sentences,
in a warm but efficient tone. Prioritise: (a) highest-value or
highest-risk deals, (b) time-sensitive commitments, (c) items that
will slip if ignored. Never invent facts — only reference items given
in the payload. Do not use markdown, bullets, or headers. Refer to
people by first name when available. Currencies use $ and thousands
separators. Focus on WHERE THE USER SHOULD SPEND TIME FIRST."""


def _summarise_payload(md: dict, fmt_money=lambda v: f"${v:,.0f}") -> str:
    """Deterministic fallback if the LLM is unavailable — keeps the
    Morning Brief useful even when the key is missing or over budget."""
    parts = []
    n_appt = len(md.get("appointments") or [])
    n_calls = len(md.get("calls") or [])
    n_tasks = len(md.get("tasks") or [])
    n_overdue = len(md.get("overdue") or [])
    n_fu = len(md.get("follow_ups") or [])
    unread = (md.get("unread") or {}).get("count") or 0
    if n_appt + n_calls + n_tasks + n_overdue + n_fu + unread == 0:
        return "Your slate is clear — a great morning to prospect new deals or clean up your pipeline."
    piece1 = []
    if n_appt: piece1.append(f"{n_appt} meeting{'s' if n_appt > 1 else ''}")
    if n_calls: piece1.append(f"{n_calls} call{'s' if n_calls > 1 else ''}")
    if n_tasks: piece1.append(f"{n_tasks} task{'s' if n_tasks > 1 else ''} due")
    if piece1:
        parts.append(f"You have {', '.join(piece1)} today.")
    if n_overdue:
        parts.append(f"{n_overdue} item{'s are' if n_overdue > 1 else ' is'} past due and needs to move first.")
    if n_fu:
        top = md["follow_ups"][0]
        deal_hint = f"{top.get('title','a deal')} ({top.get('days_since_activity','?')}d cold)"
        if top.get("value"):
            deal_hint += f" · {fmt_money(top['value'])}"
        parts.append(f"{n_fu} deal{'s are' if n_fu > 1 else ' is'} slipping past your follow-up threshold — starting with {deal_hint}.")
    return " ".join(parts)


@router.get("/companies/{cid}/my-day/brief")
async def morning_brief(
    cid: str,
    tz_offset_min: int = 0,
    force: bool = False,
    user: dict = Depends(get_current_user),
) -> dict:
    """Return a cached brief for today (per user + company) or generate
    a fresh one. `force=1` regenerates ignoring the cache."""
    await require_company(user, cid)
    today, _ = _today_bounds(tz_offset_min)

    cache_key = {"company_id": cid, "user_id": user["id"], "date": today}
    if not force:
        cached = await db.my_day_briefs.find_one(cache_key)
        if cached:
            return {"brief": cached.get("brief") or "", "cached": True,
                    "generated_at": cached.get("generated_at")}

    md = await my_day(cid, tz_offset_min, user)
    brief = _summarise_payload(md)

    key = os.environ.get("EMERGENT_LLM_KEY")
    if key:
        try:
            from emergentintegrations.llm.chat import LlmChat, UserMessage
            trim = {
                "date": md.get("date"),
                "appointments": [{
                    "title": t.get("title"),
                    "time":  t.get("due_time"),
                    "duration_minutes": t.get("duration_minutes"),
                } for t in (md.get("appointments") or [])[:8]],
                "calls": [{"title": t.get("title"), "time": t.get("due_time")}
                          for t in (md.get("calls") or [])[:8]],
                "tasks": [{"title": t.get("title"), "priority": t.get("priority")}
                          for t in (md.get("tasks") or [])[:8]],
                "overdue": [{"title": t.get("title"), "due_date": t.get("due_date")}
                             for t in (md.get("overdue") or [])[:5]],
                "follow_ups": [{
                    "title": f.get("title"),
                    "stage": f.get("stage"),
                    "value": f.get("value"),
                    "days_since_activity": f.get("days_since_activity"),
                    "last_activity_kind":  f.get("last_activity_kind"),
                } for f in (md.get("follow_ups") or [])[:6]],
                "unread_emails": (md.get("unread") or {}).get("count") or 0,
            }
            import json as _json
            prompt = ("Here is my day. Write a 2-3 sentence executive summary "
                      "highlighting where to focus first. Payload:\n\n"
                      + _json.dumps(trim, ensure_ascii=False))
            chat = LlmChat(
                api_key=key,
                session_id=f"my-day-brief-{uuid.uuid4()}",
                system_message=BRIEF_SYSTEM_PROMPT,
            ).with_model("anthropic", "claude-sonnet-4-6")
            reply = await chat.send_message(UserMessage(text=prompt))
            text = str(reply or "").strip()
            if text:
                brief = text
        except Exception:
            pass

    doc = {**cache_key, "brief": brief, "generated_at": now_iso()}
    await db.my_day_briefs.update_one(cache_key, {"$set": doc}, upsert=True)
    return {"brief": brief, "cached": False, "generated_at": doc["generated_at"]}

