"""Voice Action — Single-shot Planner (Round 7, Feb 2026)

Replaces the 6-stage split→classify→enrich pipeline with ONE LLM call
that returns a full structured plan (notes + appointments + tasks +
emails). Reviewed and confirmed in ONE popup.

    POST /voice/actions/plan    → build the plan
    POST /voice/actions/commit  → write everything atomically

Existing legacy endpoints (/parse, /parse-multi*, /execute, /undo) stay
for backwards-compatibility, but the frontend now targets this pair.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db, now_iso
from llm_client import LlmChat, UserMessage
from routes.voice_actions import (
    _resolve_contact, _resolve_assignee, _extract_json,
    _push_contact_activity,
)

log = logging.getLogger("axiom.voice_plan")
router = APIRouter(prefix="/api", tags=["voice-plan"])


PLANNER_SYSTEM = """You are a voice-action planner for a business CRM.

Given a user's monologue, return STRICT JSON with FIVE sections:

{
  "questions": [
    "Ask ONLY when the utterance is genuinely ambiguous. Examples worth asking: 'You said email Larry OR John — who should get the reminder?', 'Should I combine the reminder and the calendar link into one email, or send two?'. NEVER ask a question the user already answered (time, who, what). Zero is the ideal answer."
  ],

  "meeting_notes": {
    "contact_hint": "the person mentioned (name only) — or null",
    "title": "1-line summary like 'Call with Larry Brown re: 1234 Main St'",
    "notes": "THE USER'S VERBATIM WORDS about what happened — do not paraphrase, do not summarize; just extract the portion of the transcript that describes the meeting/call/conversation",
    "outcome": "connected | left_voicemail | no_answer | callback | null"
  } | null,

  "appointments": [
    {
      "title": "short imperative like 'Review prospectus'",
      "iso_datetime": "ISO 8601 WITH the user's UTC offset (e.g. 2026-08-30T12:00:00-07:00)",
      "duration_min": 30,
      "contact_hint": "person name or null (null for solo blocks)"
    }
  ],

  "tasks": [
    {
      "title": "short imperative task title",
      "due_iso": "ISO 8601 with offset — or null",
      "priority": "low | medium | high",
      "contact_hint": "person name or null",
      "is_follow_up": true|false
    }
  ],

  "emails": [
    {
      "contact_hint": "recipient name (required)",
      "kind": "custom | calendar_link | meeting_link | proposal",
      "purpose": "one-line: why we're sending this",
      "subject": "email subject",
      "body": "full email body — Hi {name},\\n\\n...\\n\\nThanks,\\n{sender}"
    }
  ]
}

RULES:
- "questions": use ONLY for genuine ambiguity in the utterance (e.g. "OR" between two people, unclear whether to merge intents). NEVER ask about anything the user has already stated. Prefer smart defaults over asking. 0 questions is the target — 1 is acceptable, more than 2 is almost always wrong.
- Do NOT create a "task" that just duplicates an email or appointment already in the plan. If you already produced an `emails` entry to Larry, do NOT also create a task titled "Email Larry to remind him..." — the email row IS the task. Only create tasks for things not already represented.
- "meeting_notes" is present ONLY if the user is recounting a past meeting/call ("I had a call with…", "just spoke with…", "met with…"). Otherwise null. If present, `notes` MUST be the verbatim relevant portion of the transcript.
- Any FUTURE self-appointment ("schedule time tomorrow to review X", "block an hour to study Y") goes in `appointments` with contact_hint = null.
- Any TODO / reminder ("email X to remind them of Y", "I need to review Z", "follow up with W") goes in `tasks`. If the user says "follow up with", set `is_follow_up: true`.
- Any explicit "email/send an email to X" goes in `emails`. Draft the subject + body. Address by first name. Sign off with the sender's first name.
- "Send my calendar link to X" → emails entry with kind: "calendar_link". Body should say `Hi {first_name},\\n\\nGrab time on my calendar: {CALENDAR_LINK}\\n\\nThanks,\\n{sender_first}` — the server replaces {CALENDAR_LINK}.
- "Send my meeting link to X" → emails entry with kind: "meeting_link".
- Do NOT invent people, dates, numbers, or actions the user did not say.
- Prefer OVER-splitting: if the user mentions doing two things ("email him AND send him my calendar link"), create TWO emails entries.
- ISO datetimes MUST use the user's local UTC offset (given in context). Never return "Z".
- Return JSON only. No prose. No code fences.
"""


# ────────────────────────────────────────────────────────────────
#  I N P U T   S H A P E S
# ────────────────────────────────────────────────────────────────
class PlanIn(BaseModel):
    text: str
    company_id: str
    tz: Optional[str] = None
    now_local: Optional[str] = None
    origin: Optional[str] = None


class CommitIn(BaseModel):
    company_id: str
    original_text: str
    plan: dict          # the (possibly edited) plan from /plan
    # Which sections/items to actually commit — checkbox state from the UI.
    include: dict       # {"meeting_notes": bool, "appointments": [i,…], "tasks": [i,…], "emails": [i,…]}
    # Emails the user hit "Send now" on (indexes).
    send_now: Optional[list[int]] = None


# ────────────────────────────────────────────────────────────────
#  P L A N   (one LLM call, then enrich)
# ────────────────────────────────────────────────────────────────
async def _run_planner(text: str, tz: Optional[str], now_local: Optional[str],
                        sender_first: Optional[str] = None) -> dict:
    ctx = []
    if now_local: ctx.append(f"Current local time: {now_local}")
    if tz: ctx.append(f"User IANA timezone: {tz}")
    if sender_first: ctx.append(f"Sender's first name (sign emails with this): {sender_first}")
    ctx.append(f"User utterance: {text!r}")
    ctx.append("Return the JSON now.")
    try:
        chat = LlmChat(
            api_key=os.environ.get("EMERGENT_LLM_KEY") or "unused",
            session_id=f"plan-{uuid.uuid4()}",
            system_message=PLANNER_SYSTEM,
        ).with_model("anthropic", "claude-haiku-4-5-20250929")
        raw = await chat.send_message(UserMessage(text="\n".join(ctx)))
        return _extract_json(raw) or {}
    except Exception as e:
        log.warning("planner failed: %s", e)
        return {}


@router.post("/voice/actions/plan")
async def plan(inp: PlanIn, user: dict = Depends(get_current_user)) -> dict:
    """Return a full structured plan for the utterance. One LLM call.
    The response includes contact resolutions and pre-drafted emails
    with the actual booking URL embedded when applicable."""
    await require_company(user, inp.company_id)
    text = (inp.text or "").strip()
    if not text:
        raise HTTPException(400, "text required")

    plan = await _run_planner(text, inp.tz, inp.now_local,
                                sender_first=((user.get("name") or "").split(" ")[0]
                                                or None))

    # Booking URL (real, never a placeholder) for calendar/meeting-link emails.
    booking_url: Optional[str] = None
    s = await db.user_booking_settings.find_one({"user_id": user["id"]})
    if s and s.get("slug"):
        base = (inp.origin or os.environ.get("PUBLIC_BOOKING_ORIGIN") or "").rstrip("/")
        booking_url = (f"{base}/book/{s['slug']}" if base else f"/book/{s['slug']}")

    # ── Enrich each section ────────────────────────────────────
    async def _resolve_c(hint):
        if not hint: return None
        return await _resolve_contact(inp.company_id, hint)

    # meeting_notes
    if plan.get("meeting_notes"):
        mn = plan["meeting_notes"]
        mn["contact"] = await _resolve_c(mn.get("contact_hint"))

    # appointments
    for a in (plan.get("appointments") or []):
        a["contact"] = await _resolve_c(a.get("contact_hint"))
        a.setdefault("duration_min", 30)

    # tasks
    for t in (plan.get("tasks") or []):
        t["contact"] = await _resolve_c(t.get("contact_hint"))
        t.setdefault("priority", "medium")
        t.setdefault("is_follow_up", False)
        # Follow-up smart default: next business day 9 AM local
        if t.get("is_follow_up") and not t.get("due_iso"):
            try:
                from zoneinfo import ZoneInfo
                _tz = ZoneInfo(inp.tz or "UTC")
            except Exception:
                _tz = timezone.utc
            d = datetime.now(_tz) + timedelta(days=1)
            while d.weekday() >= 5:
                d += timedelta(days=1)
            d = d.replace(hour=9, minute=0, second=0, microsecond=0)
            t["due_iso"] = d.isoformat()

    # emails — swap {CALENDAR_LINK} for the real URL, resolve contacts
    sender_first = ((user.get("name") or "").split(" ")[0]
                     or (user.get("email") or "").split("@")[0]
                     or "me")
    for e in (plan.get("emails") or []):
        e["contact"] = await _resolve_c(e.get("contact_hint"))
        e["to_email"] = (e["contact"] or {}).get("email") if e.get("contact") else None
        body = e.get("body") or ""
        kind = e.get("kind") or "custom"
        if kind in ("calendar_link", "meeting_link"):
            if booking_url:
                body = body.replace("{CALENDAR_LINK}", booking_url) \
                            .replace("{MEETING_LINK}", booking_url)
                if booking_url not in body:
                    body = body.rstrip() + f"\n\n{booking_url}"
            else:
                e["needs_booking_setup"] = True
        # ── Any-intent URL safety net (Round 7.2, Feb 2026) ──
        # If the body MENTIONS a link/calendar/booking but the actual
        # URL is missing (LLM said "my calendar link" or "please find
        # my link" without the URL itself), append it. Applies to
        # custom + proposal emails too — not just link-kind emails.
        elif booking_url and booking_url not in body:
            link_phrase_re = re.compile(
                r"\b(?:my\s+(?:calendar|booking|scheduling|meeting)\s+link|"
                r"my\s+link\s+(?:to|below)|book\s+(?:a\s+)?time|"
                r"grab\s+(?:a\s+)?time|schedule\s+(?:a\s+)?call\s+here|"
                r"link\s+below|see\s+link)\b", re.I)
            if link_phrase_re.search(body):
                body = body.rstrip() + f"\n\n{booking_url}"
        # Haiku sometimes leaves {sender} / {name} as literal placeholders.
        first = ((e.get("contact") or {}).get("name") or e.get("contact_hint")
                  or "there").split(" ")[0]
        body = (body
                .replace("{sender}", sender_first)
                .replace("{sender_first}", sender_first)
                .replace("{name}", first)
                .replace("{first_name}", first)
                .replace("{recipient}", first))
        e["body"] = body

    # Attach the raw transcript so the review UI can show it verbatim.
    plan["original_text"] = text
    plan["sender"] = {
        "name": user.get("name") or user.get("email"),
        "email": user.get("email"),
    }
    plan["booking_url"] = booking_url
    return plan


# ────────────────────────────────────────────────────────────────
#  C O M M I T   (write everything atomically)
# ────────────────────────────────────────────────────────────────
@router.post("/voice/actions/commit")
async def commit(inp: CommitIn, user: dict = Depends(get_current_user)) -> dict:
    """Persist the (checkbox-filtered) plan. Returns a summary of
    everything created for the toast + Undo affordance."""
    await require_company(user, inp.company_id)
    plan = inp.plan or {}
    include = inp.include or {}
    send_now_indexes = set(inp.send_now or [])
    now = now_iso()
    batch_id = str(uuid.uuid4())
    cid = inp.company_id

    created: list[dict] = []      # returned to the client for toast + undo

    # ── meeting_notes → contact_activity + done-task ──────────
    if include.get("meeting_notes") and plan.get("meeting_notes"):
        mn = plan["meeting_notes"]
        contact = mn.get("contact") or {}
        title = mn.get("title") or "Phone call"
        raw_notes = mn.get("notes") or ""
        act_id = str(uuid.uuid4())
        # Full verbatim on the contact activity feed.
        await _push_contact_activity(
            cid, contact.get("id") if contact else None,
            kind="call",
            body=(f"{title}\n{raw_notes}" if raw_notes else title),
            user=user,
            extra={"target_type": "call_log", "target_id": act_id,
                    "voice_batch_id": batch_id, "outcome": mn.get("outcome")},
        )
        # Also stamp a done-task so it shows in "Completed today" bucket.
        today_str = datetime.now(timezone.utc).date().isoformat()
        await db.tasks.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "title": title, "kind": "call", "status": "done",
            "assignee_id": user["id"],
            "assignee_name": user.get("name") or user.get("email"),
            "contact_id": contact.get("id") if contact else None,
            "contact_name": contact.get("name") if contact else None,
            "due_date": today_str, "completed_at": now,
            "notes": raw_notes, "outcome": mn.get("outcome"),
            "source": "voice-planner", "voice_batch_id": batch_id,
            "created_at": now,
        })
        created.append({"type": "note", "title": title,
                          "contact_name": contact.get("name") if contact else None})

    # ── appointments → task (kind=meeting) + contact activity ─
    for i in (include.get("appointments") or []):
        a = (plan.get("appointments") or [])[i]
        contact = a.get("contact") or {}
        tid = str(uuid.uuid4())
        try:
            dt = datetime.fromisoformat((a.get("iso_datetime") or "").replace("Z", "+00:00"))
            due_date = dt.date().isoformat()
            due_time = dt.strftime("%H:%M")
        except Exception:
            due_date, due_time = None, None
        await db.tasks.insert_one({
            "id": tid, "company_id": cid, "title": a.get("title") or "Meeting",
            "kind": "meeting", "status": "open", "priority": "medium",
            "assignee_id": user["id"],
            "assignee_name": user.get("name") or user.get("email"),
            "contact_id": contact.get("id") if contact else None,
            "contact_name": contact.get("name") if contact else None,
            "due_date": due_date, "due_time": due_time,
            "duration_min": a.get("duration_min") or 30,
            "source": "voice-planner", "voice_batch_id": batch_id,
            "created_at": now,
        })
        await _push_contact_activity(
            cid, contact.get("id") if contact else None,
            kind="meeting",
            body=f"Scheduled: {a.get('title')} · {due_date} {due_time or ''}",
            user=user,
            extra={"target_type": "appointment", "target_id": tid,
                    "voice_batch_id": batch_id},
        )
        created.append({"type": "appointment", "title": a.get("title"),
                          "when": due_date, "contact_name": contact.get("name") if contact else None})

    # ── tasks → open task (or follow-up) + contact activity ──
    for i in (include.get("tasks") or []):
        t = (plan.get("tasks") or [])[i]
        contact = t.get("contact") or {}
        tid = str(uuid.uuid4())
        due_iso = t.get("due_iso")
        due_date, due_time = None, None
        if due_iso:
            try:
                dt = datetime.fromisoformat(due_iso.replace("Z", "+00:00"))
                due_date, due_time = dt.date().isoformat(), dt.strftime("%H:%M")
            except Exception:
                pass
        kind = "follow_up" if t.get("is_follow_up") else "task"
        await db.tasks.insert_one({
            "id": tid, "company_id": cid, "title": t.get("title") or "Task",
            "kind": kind, "status": "open",
            "priority": t.get("priority") or "medium",
            "assignee_id": user["id"],
            "assignee_name": user.get("name") or user.get("email"),
            "contact_id": contact.get("id") if contact else None,
            "contact_name": contact.get("name") if contact else None,
            "due_date": due_date, "due_time": due_time,
            "source": "voice-planner", "voice_batch_id": batch_id,
            "created_at": now,
        })
        await _push_contact_activity(
            cid, contact.get("id") if contact else None,
            kind="note",
            body=("Follow-up: " if kind == "follow_up" else "Task: ") + (t.get("title") or ""),
            user=user,
            extra={"target_type": kind, "target_id": tid,
                    "voice_batch_id": batch_id},
        )
        created.append({"type": kind, "title": t.get("title"),
                          "contact_name": contact.get("name") if contact else None})

    # ── emails → draft (or actually send) + task + activity ──
    for i in (include.get("emails") or []):
        e = (plan.get("emails") or [])[i]
        contact = e.get("contact") or {}
        subject = e.get("subject") or "Quick note"
        body    = e.get("body") or ""
        to_email = e.get("to_email") or (contact.get("email") if contact else None)
        do_send = i in send_now_indexes and bool(to_email)

        em_id = str(uuid.uuid4())
        send_error: Optional[str] = None
        status = "sent" if do_send else "draft"
        if do_send:
            try:
                from routes.gmail import _creds_for_user, _gmail_service, _build_mime
                creds = await _creds_for_user(user["id"])
                svc = _gmail_service(creds)
                tok = await db.gmail_tokens.find_one({"user_id": user["id"]})
                from_email = (tok or {}).get("email") or "me"
                raw = _build_mime(from_email=from_email, to=to_email,
                                     cc="", bcc="", subject=subject,
                                     body_html="", body_text=body,
                                     attachments=[],
                                     in_reply_to="", references="")
                svc.users().messages().send(userId="me", body={"raw": raw}).execute()
            except Exception as ex:
                send_error = str(ex)
                status = "draft"
        await db.recap_emails.insert_one({
            "id": em_id, "company_id": cid, "user_id": user["id"],
            "contact_id": contact.get("id") if contact else None,
            "to_email": to_email, "to_name": contact.get("name") if contact else None,
            "subject": subject, "body": body, "kind": e.get("kind") or "custom",
            "status": status, "send_error": send_error,
            "source": "voice-planner", "voice_batch_id": batch_id,
            "created_at": now,
        })
        await db.tasks.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "title": f"Email: {subject}", "kind": "email",
            "status": "done" if status == "sent" else "open",
            "priority": "medium",
            "assignee_id": user["id"],
            "assignee_name": user.get("name") or user.get("email"),
            "contact_id": contact.get("id") if contact else None,
            "contact_name": contact.get("name") if contact else None,
            "due_date": datetime.now(timezone.utc).date().isoformat(),
            "completed_at": (now if status == "sent" else None),
            "source": "voice-planner", "voice_batch_id": batch_id,
            "created_at": now,
        })
        await _push_contact_activity(
            cid, contact.get("id") if contact else None,
            kind="email",
            body=(f"Sent to {to_email}: {subject}" if status == "sent"
                    else f"Draft saved (not sent): {subject}"),
            user=user,
            extra={"target_type": ("email_sent" if status == "sent" else "email_draft"),
                    "target_id": em_id, "voice_batch_id": batch_id},
        )
        created.append({"type": "email", "subject": subject,
                          "status": status, "send_error": send_error,
                          "contact_name": contact.get("name") if contact else None,
                          "to_email": to_email})

    return {"ok": True, "batch_id": batch_id,
             "count": len(created), "created": created}


@router.post("/voice/actions/undo-batch/{batch_id}")
async def undo_batch(batch_id: str, user: dict = Depends(get_current_user)) -> dict:
    """Undo an entire commit by batch_id — deletes all rows and pulls
    the linked activities off contacts."""
    # Delete the write-side rows
    dt = await db.tasks.delete_many({"voice_batch_id": batch_id})
    de = await db.recap_emails.delete_many({"voice_batch_id": batch_id})
    # Pull the linked contact activities.
    await db.contacts.update_many(
        {"activities.voice_batch_id": batch_id},
        {"$pull": {"activities": {"voice_batch_id": batch_id}}},
    )
    return {"ok": True,
             "removed": {"tasks": dt.deleted_count, "emails": de.deleted_count}}
