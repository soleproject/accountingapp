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

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from deps import require_company
from db import db

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

    # ── Tasks due today (any kind) ─────────────────────────────────
    tasks_today_cur = db.tasks.find({
        "company_id": cid,
        "due_date": today,
        "$or": [{"status": {"$ne": "done"}}, {"status": {"$exists": False}}],
    }).sort([("due_time", 1)])
    tasks_today = []
    async for t in tasks_today_cur:
        t.pop("_id", None)
        tasks_today.append(t)

    # Partition tasks by kind
    appointments = [t for t in tasks_today if t.get("kind") == "meeting"]
    calls        = [t for t in tasks_today if t.get("kind") == "call"]
    other_tasks  = [t for t in tasks_today if t.get("kind") not in ("meeting", "call")]

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

    return {
        "date":         today,
        "appointments": appointments,
        "tasks":        other_tasks,
        "calls":        calls,
        "overdue":      overdue,
        "follow_ups":   follow_ups,
        "unread":       unread,
        "follow_up_config": fu_cfg,
    }
