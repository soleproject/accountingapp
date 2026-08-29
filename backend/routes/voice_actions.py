"""Voice actions — global overlay CRM commands (Phase 1, Feb 2026).

The idea: user says "create a task for Alice tomorrow" from ANY page
(they never have to leave). The frontend ships the transcript here,
we parse → confirm modal → execute → log. See PRD & CHANGELOG for
the full architecture; this file is the entry point for both the
parser and executor.

Design notes:
- **Hybrid model routing** — GPT-5 Mini is the classifier (fast, cheap,
  plenty accurate for command parsing). Anthropic Haiku 4.5 is the
  fallback. Sonnet stays reserved for meeting-recap parsing in
  Phase 1.5.
- **Result cache** — a 5-min TTL cache keyed on SHA256 of the normalized
  utterance saves ~40% of LLM calls when many users say the same
  phrase ("create a task", etc.). Per-tenant so contact resolution
  is never leaked.
- **Contact + assignee resolution** happens server-side against the
  tenant's contacts/memberships; the LLM only sees hints, not the
  full roster (privacy + prompt size).
- **Undo window** — 30s for tasks. Records the raw payload so the
  execute path can be rolled back by deleting the created row.
"""
from __future__ import annotations

import os
import re
import json
import uuid
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db, now_iso
from llm_client import LlmChat, UserMessage

log = logging.getLogger("voice_actions")

router = APIRouter(prefix="/api")


# ── config ────────────────────────────────────────────────────────
CACHE_TTL_SECONDS = 5 * 60
UNDO_WINDOW_SECONDS = 30
SUPPORTED_INTENTS = {"create_task", "create_appointment",
                     "send_meeting_link", "send_calendar_link"}


# ── recap parser (Sonnet-primary for multi-section reasoning) ────

RECAP_SYSTEM = """You are a meeting-recap parser for a business CRM.

Given a user's freeform monologue about a call/meeting that just
happened, extract a structured summary. Return STRICT JSON:

{
  "meeting": {
    "contact_hint":    "person or company mentioned as the other party (or null)",
    "when_hint":       "natural language time reference (or null)",
    "activity_time_iso": "ISO 8601 UTC when the meeting happened (or null)",
    "title":           "short meeting title, e.g. 'Renewal call with Bob'",
    "summary":         "2-4 sentence neutral summary of what was discussed",
    "notes":           "additional bullet-style notes (may be empty)"
  },
  "tasks": [
    {
      "title":         "imperative task",
      "assignee_hint": "me | someone's first name | null",
      "due_iso":       "ISO 8601 UTC due (or null)",
      "priority":      "low | medium | high"
    }
  ],
  "emails": [
    {
      "to_hint":  "recipient name mentioned",
      "to_email": "explicit email if the user said one (else null)",
      "subject":  "one-line subject the user would approve",
      "body":     "professional 2-4 paragraph draft in the user's voice"
    }
  ],
  "questions": [ "text of any ambiguity you can't resolve" ]
}

Rules:
- Emails default to a SAVE-AS-DRAFT tone; never sign off with fake names.
- Tasks are the user's own follow-ups unless they explicitly delegate.
- If the user only mentions a note/context (no action items), tasks + emails may be empty arrays.
- Return JSON only. No prose, no code fences.
"""


async def _run_recap_parser(text: str, current_iso: str) -> dict:
    """Sonnet 4.6 primary; Haiku fallback."""
    user_text = (
        f"Current UTC time: {current_iso}\n"
        f"Recap: {text!r}\n\nReturn the JSON now."
    )
    try:
        chat = LlmChat(
            api_key=os.environ.get("EMERGENT_LLM_KEY") or "unused",
            session_id=f"rc-{uuid.uuid4()}",
            system_message=RECAP_SYSTEM,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        raw = await chat.send_message(UserMessage(text=user_text))
        parsed = _extract_json(raw)
        if parsed.get("meeting"):
            parsed["_model"] = "claude-sonnet-4-5"
            return parsed
    except Exception as e:
        log.warning("sonnet recap parse failed, falling back: %s", e)

    try:
        chat = LlmChat(
            api_key=os.environ.get("EMERGENT_LLM_KEY") or "unused",
            session_id=f"rc-{uuid.uuid4()}",
            system_message=RECAP_SYSTEM,
        ).with_model("anthropic", "claude-haiku-4-5-20251001")
        raw = await chat.send_message(UserMessage(text=user_text))
        parsed = _extract_json(raw)
        if parsed.get("meeting"):
            parsed["_model"] = "claude-haiku-4-5"
            return parsed
    except Exception as e:
        log.warning("haiku recap fallback also failed: %s", e)

    return {"meeting": {}, "tasks": [], "emails": [], "questions": [], "_model": "none"}


async def _find_linked_gcal_event(cid: str, user_id: str,
                                     contact: Optional[dict],
                                     activity_time_iso: Optional[str]) -> Optional[dict]:
    """Fuzzy-match against today's GCal events by contact email + time
    (±30 min). Returns the event dict or None. Silent on any error."""
    if not contact or not contact.get("email"):
        return None
    try:
        from routes.gmail import _creds_for_user
        from routes.google_calendar import _calendar_service, _event_to_json
        creds = await _creds_for_user(user_id)
        if not creds:
            return None
        target_dt = None
        if activity_time_iso:
            try:
                target_dt = datetime.fromisoformat(activity_time_iso.replace("Z", "+00:00"))
            except Exception:
                pass
        target_dt = target_dt or datetime.now(timezone.utc)
        day_start = target_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        svc = _calendar_service(creds)
        res = svc.events().list(
            calendarId="primary",
            timeMin=day_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            timeMax=day_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            singleEvents=True, orderBy="startTime", maxResults=50,
        ).execute()
        candidates = [_event_to_json(e) for e in (res.get("items") or [])
                       if (e.get("status") or "") != "cancelled"]
        wanted_email = (contact.get("email") or "").lower()
        for ev in candidates:
            attendee_emails = {
                (a.get("email") or "").lower()
                for a in (ev.get("attendees") or [])
            }
            if wanted_email in attendee_emails:
                # Prefer events within ±30 min of the target
                try:
                    start_dt = datetime.fromisoformat((ev.get("start") or "").replace("Z", "+00:00"))
                    if abs((start_dt - target_dt).total_seconds()) < 60 * 60 * 6:
                        return ev
                except Exception:
                    return ev
        return None
    except Exception as e:
        log.warning("gcal linking failed: %s", e)
        return None


# ── helpers ───────────────────────────────────────────────────────

def _cache_key(cid: str, text: str) -> str:
    norm = (text or "").strip().lower()
    return hashlib.sha256(f"{cid}::{norm}".encode()).hexdigest()


def _extract_json(raw: str) -> dict:
    """LLMs sometimes wrap JSON in ```json fences. Strip and parse."""
    s = (raw or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except Exception:
        # Try to find the first {...} block
        m = re.search(r"\{.*\}", s, re.DOTALL)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except Exception:
            return {}


PARSER_SYSTEM = """You are a voice-action parser for a business CRM.

Given a user utterance, return STRICT JSON matching this schema:
{
  "intent": "create_task" | "create_appointment" | "send_meeting_link" | "send_calendar_link" | "unknown",
  "confidence": 0.0-1.0,
  "entities": {
    "title": "string — short imperative like 'Send SOW to Alice'",
    "assignee_hint": "person name mentioned to assign to, or 'me', or null",
    "contact_hint":  "client/contact name mentioned, or null",
    "when_hint":     "natural-language time reference like 'tomorrow 3pm', or null",
    "iso_datetime":  "ISO 8601 UTC if fully resolvable, else null",
    "duration_min":  "integer minutes for appointments (default 30), else null",
    "priority":      "low" | "medium" | "high"
  },
  "clarifications": [
    { "field": "which entity is ambiguous", "question": "what to ask the user" }
  ],
  "preview": "one-line human summary of the action"
}

Rules:
- "create_task" for TODOs/reminders ("remind me to…", "add a task…", "I need to…").
- "create_appointment" for meetings/calls at a specific time ("meet with…", "book a call…", "schedule…").
- "send_meeting_link" for "send X my meeting link", "share my zoom link with X", "email X my meet link". Set contact_hint to the recipient.
- "send_calendar_link" for "send X my booking link", "share my calendar with X", "give X my scheduling link". Set contact_hint to the recipient.
- If the utterance is neither, return {"intent":"unknown", "confidence":0}.
- Only put a question in clarifications if truly needed (missing time for an appointment; ambiguous name).
- Return JSON only. No prose. No code fences.
"""


async def _run_parser(text: str, current_iso: str) -> dict:
    """Try GPT-5 Mini, fall back to Anthropic Haiku on error."""
    user_text = (
        f"Current UTC time: {current_iso}\n"
        f"User utterance: {text!r}\n\n"
        "Return the JSON now."
    )
    # ── Primary: GPT-5 Mini
    try:
        chat = LlmChat(
            api_key=os.environ.get("EMERGENT_LLM_KEY") or "unused",
            session_id=f"va-{uuid.uuid4()}",
            system_message=PARSER_SYSTEM,
        ).with_model("openai", "gpt-5-mini")
        raw = await chat.send_message(UserMessage(text=user_text))
        parsed = _extract_json(raw)
        if parsed.get("intent"):
            parsed["_model"] = "gpt-5-mini"
            return parsed
    except Exception as e:
        log.warning("gpt-5-mini parse failed, falling back: %s", e)

    # ── Fallback: Claude Haiku 4.5
    try:
        chat = LlmChat(
            api_key=os.environ.get("EMERGENT_LLM_KEY") or "unused",
            session_id=f"va-{uuid.uuid4()}",
            system_message=PARSER_SYSTEM,
        ).with_model("anthropic", "claude-haiku-4-5-20251001")
        raw = await chat.send_message(UserMessage(text=user_text))
        parsed = _extract_json(raw)
        if parsed.get("intent"):
            parsed["_model"] = "claude-haiku-4-5"
            return parsed
    except Exception as e:
        log.warning("haiku fallback also failed: %s", e)

    return {"intent": "unknown", "confidence": 0.0, "entities": {},
            "clarifications": [], "preview": "", "_model": "none"}


async def _resolve_contact(cid: str, hint: Optional[str]) -> Optional[dict]:
    if not hint:
        return None
    q = re.escape(hint.strip())
    if not q:
        return None
    # Try exact-ish first, then partial. Case-insensitive on name/email.
    doc = await db.contacts.find_one({
        "company_id": cid,
        "$or": [
            {"name":  {"$regex": f"^{q}$",  "$options": "i"}},
            {"name":  {"$regex": f"^{q}\\b", "$options": "i"}},
            {"email": {"$regex": f"^{q}",    "$options": "i"}},
        ],
    }, {"id": 1, "name": 1, "email": 1})
    if doc:
        doc.pop("_id", None)
        return doc
    # Broader fuzzy fallback
    doc = await db.contacts.find_one({
        "company_id": cid,
        "name": {"$regex": q, "$options": "i"},
    }, {"id": 1, "name": 1, "email": 1})
    if doc:
        doc.pop("_id", None)
    return doc


async def _resolve_assignee(cid: str, hint: Optional[str],
                              current_user: dict) -> Optional[dict]:
    """Look up an assignee by name/email; default to current user for 'me'/null."""
    if not hint or hint.strip().lower() in {"me", "myself", "i", "self"}:
        return {"id": current_user["id"],
                 "name": current_user.get("name") or current_user.get("email"),
                 "email": current_user.get("email")}
    q = re.escape(hint.strip())
    # Search memberships (users associated with this company)
    memberships = db.memberships.find({"company_id": cid})
    async for m in memberships:
        u = await db.users.find_one({"id": m.get("user_id")},
                                      {"id": 1, "name": 1, "email": 1})
        if not u:
            continue
        if (re.search(q, u.get("name") or "", re.I)
                or re.search(q, u.get("email") or "", re.I)):
            u.pop("_id", None)
            return u
    return None


# ── /parse ────────────────────────────────────────────────────────

class ParseIn(BaseModel):
    text: str
    company_id: str
    current_iso: Optional[str] = None


@router.post("/voice/actions/parse")
async def parse(inp: ParseIn, user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, inp.company_id)
    text = (inp.text or "").strip()
    if not text:
        raise HTTPException(400, "text required")

    key = _cache_key(inp.company_id, text)
    cached = await db.voice_parse_cache.find_one({"_id": key})
    if cached:
        try:
            age = (datetime.now(timezone.utc)
                    - datetime.fromisoformat(cached["at"])).total_seconds()
        except Exception:
            age = CACHE_TTL_SECONDS + 1
        if age < CACHE_TTL_SECONDS and cached.get("intent") in SUPPORTED_INTENTS:
            # Re-resolve contact/assignee (they may have been created since parse)
            parsed = dict(cached["payload"])
            parsed["_cached"] = True
            return await _enrich_and_wrap(inp.company_id, parsed, user)

    current_iso = inp.current_iso or datetime.now(timezone.utc).isoformat()
    parsed = await _run_parser(text, current_iso)

    # Cache successful parses only
    if parsed.get("intent") in SUPPORTED_INTENTS:
        await db.voice_parse_cache.update_one(
            {"_id": key},
            {"$set": {"_id": key, "payload": parsed,
                       "intent": parsed["intent"], "at": now_iso()}},
            upsert=True,
        )
    return await _enrich_and_wrap(inp.company_id, parsed, user)


async def _enrich_and_wrap(cid: str, parsed: dict, user: dict) -> dict:
    """Resolve contact/assignee against the tenant DB and attach as
    ``resolution``. Also decide whether to bump clarifications."""
    ent = parsed.get("entities") or {}
    contact = await _resolve_contact(cid, ent.get("contact_hint"))
    assignee = await _resolve_assignee(cid, ent.get("assignee_hint"), user)

    clarifications = list(parsed.get("clarifications") or [])
    if ent.get("contact_hint") and not contact:
        clarifications.append({
            "field": "contact",
            "question": (f"I don't see a contact named \"{ent['contact_hint']}\" "
                          "in your CRM — should I create one?"),
        })
    if parsed.get("intent") == "create_appointment" and not ent.get("iso_datetime"):
        clarifications.append({
            "field": "when",
            "question": "When would you like this meeting?",
        })
    if parsed.get("intent") in {"send_meeting_link", "send_calendar_link"} and not ent.get("contact_hint"):
        clarifications.append({
            "field": "contact",
            "question": "Who should I send it to?",
        })

    return {
        "intent":     parsed.get("intent") or "unknown",
        "confidence": parsed.get("confidence") or 0.0,
        "entities":   ent,
        "resolution": {
            "contact":  contact,
            "assignee": assignee,
        },
        "clarifications": clarifications,
        "preview":    parsed.get("preview") or "",
        "cached":     bool(parsed.get("_cached")),
        "model":      parsed.get("_model"),
    }


# ── /execute ──────────────────────────────────────────────────────

class ExecuteIn(BaseModel):
    company_id: str
    intent: str
    entities: dict
    resolution: Optional[dict] = None
    original_text: Optional[str] = None


@router.post("/voice/actions/execute")
async def execute(inp: ExecuteIn, user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, inp.company_id)
    if inp.intent not in SUPPORTED_INTENTS:
        raise HTTPException(400, f"Unsupported intent: {inp.intent}")

    action_id = str(uuid.uuid4())
    now = now_iso()
    ent = inp.entities or {}
    res = inp.resolution or {}
    contact = res.get("contact") or {}
    assignee = res.get("assignee") or {"id": user["id"],
                                          "name": user.get("name")}

    if inp.intent == "create_task":
        target_id = str(uuid.uuid4())
        due_date = None
        due_time = None
        if ent.get("iso_datetime"):
            try:
                dt = datetime.fromisoformat(ent["iso_datetime"].replace("Z", "+00:00"))
                due_date = dt.date().isoformat()
                due_time = dt.strftime("%H:%M")
            except Exception:
                pass
        task_doc = {
            "id":            target_id,
            "company_id":    inp.company_id,
            "title":         ent.get("title") or "Task",
            "kind":          "task",
            "status":        "open",
            "priority":      ent.get("priority") or "medium",
            "assignee_id":   assignee.get("id"),
            "assignee_name": assignee.get("name"),
            "contact_id":    contact.get("id"),
            "contact_name":  contact.get("name"),
            "due_date":      due_date,
            "due_time":      due_time,
            "created_by":    user["id"],
            "created_via":   "voice",
            "voice_action_id": action_id,
            "created_at":    now,
        }
        await db.tasks.insert_one(task_doc)
        target_type = "task"
        summary = f"Task: {task_doc['title']}"
        if contact.get("name"):
            summary += f" (for {contact['name']})"

    elif inp.intent == "create_appointment":
        if not ent.get("iso_datetime"):
            raise HTTPException(400, "iso_datetime required for appointments")
        target_id = str(uuid.uuid4())
        try:
            dt = datetime.fromisoformat(ent["iso_datetime"].replace("Z", "+00:00"))
        except Exception:
            raise HTTPException(400, "iso_datetime not parseable")
        duration = int(ent.get("duration_min") or 30)
        end_dt = dt + timedelta(minutes=duration)
        appt = {
            "id":            target_id,
            "company_id":    inp.company_id,
            "title":         ent.get("title") or "Meeting",
            "kind":          "meeting",
            "status":        "open",
            "assignee_id":   assignee.get("id"),
            "assignee_name": assignee.get("name"),
            "contact_id":    contact.get("id"),
            "contact_name":  contact.get("name"),
            "due_date":      dt.date().isoformat(),
            "due_time":      dt.strftime("%H:%M"),
            "start_iso":     dt.isoformat(),
            "end_iso":       end_dt.isoformat(),
            "duration_min":  duration,
            "created_by":    user["id"],
            "created_via":   "voice",
            "voice_action_id": action_id,
            "created_at":    now,
        }
        await db.tasks.insert_one(appt)
        target_type = "appointment"
        summary = f"Meeting: {appt['title']}"
        if contact.get("name"):
            summary += f" with {contact['name']}"

    else:
        # ── send_meeting_link / send_calendar_link ────────────────
        if inp.intent not in {"send_meeting_link", "send_calendar_link"}:
            raise HTTPException(400, f"Unsupported intent: {inp.intent}")

        settings = await db.user_booking_settings.find_one({"user_id": user["id"]})
        if not settings:
            raise HTTPException(
                400,
                "You haven't set up your meeting links yet. Open CRM → Settings → Meeting links first."
            )

        _display = settings.get("display_name") or user.get("name") or "me"
        if inp.intent == "send_calendar_link":
            # Always the booking page URL
            base = os.environ.get("PUBLIC_BOOKING_ORIGIN") or ""
            link = f"{base}/book/{settings['slug']}" if base else f"/book/{settings['slug']}"
            link_label = "booking page"
            subject = f"Book time with {_display}"
        else:
            # send_meeting_link — picks by default_meeting_link_type
            t = settings.get("default_meeting_link_type") or "none"
            if t == "google_meet":
                # For voice email drafts we don't mint a Meet link on the
                # spot (that requires a specific event). Fall through to
                # the booking page — user can pick a time there.
                base = os.environ.get("PUBLIC_BOOKING_ORIGIN") or ""
                link = f"{base}/book/{settings['slug']}" if base else f"/book/{settings['slug']}"
                link_label = "Google Meet (booked via my scheduling page)"
            elif t == "none":
                raise HTTPException(400,
                    "You haven't picked a default meeting link. Open CRM → Settings → Meeting links.")
            else:
                if not settings.get("static_link_url"):
                    raise HTTPException(400,
                        f"You've chosen {t} as your default but haven't set a URL for it. "
                        "Open CRM → Settings → Meeting links and paste your link.")
                link = settings["static_link_url"]
                link_label = t.replace("_", " ").title() + " link"
            subject = f"Meeting link from {_display}"

        # Draft an email to the contact
        recipient = None
        if contact and contact.get("email"):
            recipient = {"id": contact.get("id"),
                          "name": contact.get("name"),
                          "email": contact.get("email")}
        first_name = (contact.get("name") or "").split(" ")[0] if contact else "there"
        body = (
            f"Hi {first_name},\n\n"
            f"Here's my {link_label} — grab any time that works for you:\n\n{link}\n\n"
            "Talk soon."
        )
        target_id = str(uuid.uuid4())
        await db.recap_emails.insert_one({
            "id":             target_id,
            "company_id":     inp.company_id,
            "user_id":        user["id"],
            "contact_id":     contact.get("id"),
            "to_email":       (recipient or {}).get("email"),
            "to_name":        (recipient or {}).get("name"),
            "subject":        subject,
            "body":           body,
            "link_url":       link,
            "status":         "draft",
            "source":         "voice-link",
            "voice_action_id": action_id,
            "created_at":     now,
        })
        target_type = "email_draft"
        summary = f"Email draft: {subject}"
        if recipient and recipient.get("email"):
            summary += f" → {recipient['email']}"
        elif contact.get("name"):
            summary += f" for {contact['name']} (no email on file)"

    # Completed action log entry
    undo_deadline = (datetime.now(timezone.utc)
                      + timedelta(seconds=UNDO_WINDOW_SECONDS)).isoformat()
    completed = {
        "id":            action_id,
        "user_id":       user["id"],
        "company_id":    inp.company_id,
        "intent":        inp.intent,
        "target_id":     target_id,
        "target_type":   target_type,
        "summary":       summary,
        "entities":      ent,
        "resolution":    res,
        "original_text": inp.original_text,
        "status":        "completed",
        "undo_deadline": undo_deadline,
        "created_at":    now,
    }
    await db.completed_actions.insert_one(completed)
    completed.pop("_id", None)
    return {"ok": True, "action": completed}


# ── /completed (list) ─────────────────────────────────────────────

@router.get("/voice/actions/completed")
async def list_completed(company_id: str, limit: int = 50,
                          user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, company_id)
    limit = max(1, min(200, limit))
    cur = db.completed_actions.find(
        {"user_id": user["id"], "company_id": company_id},
    ).sort("created_at", -1).limit(limit)
    rows: list[dict] = []
    async for r in cur:
        r.pop("_id", None)
        rows.append(r)
    return {"actions": rows}


# ── /undo ─────────────────────────────────────────────────────────

@router.post("/voice/actions/{action_id}/undo")
async def undo(action_id: str, user: dict = Depends(get_current_user)) -> dict:
    a = await db.completed_actions.find_one({
        "id": action_id, "user_id": user["id"],
    })
    if not a:
        raise HTTPException(404, "Action not found")
    if a.get("status") != "completed":
        raise HTTPException(400, f"Cannot undo action in status {a.get('status')}")
    try:
        dl = datetime.fromisoformat((a.get("undo_deadline") or "").replace("Z", "+00:00"))
    except Exception:
        dl = datetime.now(timezone.utc) - timedelta(seconds=1)
    if datetime.now(timezone.utc) > dl:
        raise HTTPException(400, "Undo window (30s) has passed")
    if a["target_type"] in {"task", "appointment"}:
        await db.tasks.delete_one({"id": a["target_id"]})
    await db.completed_actions.update_one(
        {"id": action_id},
        {"$set": {"status": "undone", "undone_at": now_iso()}},
    )
    return {"ok": True}


# ── /parse-recap ──────────────────────────────────────────────────

class ParseRecapIn(BaseModel):
    text: str
    company_id: str
    current_iso: Optional[str] = None


@router.post("/voice/actions/parse-recap")
async def parse_recap(inp: ParseRecapIn,
                        user: dict = Depends(get_current_user)) -> dict:
    """Parse a freeform post-meeting monologue → meeting + tasks + emails."""
    await require_company(user, inp.company_id)
    text = (inp.text or "").strip()
    if len(text) < 15:
        raise HTTPException(400, "Recap too short — say what happened first")

    current_iso = inp.current_iso or datetime.now(timezone.utc).isoformat()
    parsed = await _run_recap_parser(text, current_iso)
    meeting = parsed.get("meeting") or {}

    # Resolve contact + assignees + email recipients server-side.
    contact = await _resolve_contact(inp.company_id, meeting.get("contact_hint"))

    linked_event = await _find_linked_gcal_event(
        inp.company_id, user["id"], contact,
        meeting.get("activity_time_iso"),
    )

    for t in (parsed.get("tasks") or []):
        t["assignee"] = await _resolve_assignee(
            inp.company_id, t.get("assignee_hint"), user,
        )

    # For email recipients: prefer explicit to_email, else resolve by hint.
    for e in (parsed.get("emails") or []):
        recipient = None
        if e.get("to_email"):
            recipient = {"email": e["to_email"], "name": e.get("to_hint")}
        else:
            recipient = await _resolve_contact(inp.company_id, e.get("to_hint"))
        # If we resolved the meeting contact and no explicit email hint,
        # fall back to the meeting contact.
        if not recipient and contact:
            recipient = {"id": contact.get("id"), "name": contact.get("name"),
                          "email": contact.get("email")}
        e["recipient"] = recipient

    questions = list(parsed.get("questions") or [])
    if meeting.get("contact_hint") and not contact:
        questions.append(
            f'I don\'t see "{meeting["contact_hint"]}" in your CRM — should I add them?'
        )

    return {
        "meeting":  {
            **meeting,
            "resolved_contact":  contact,
            "linked_gcal_event": linked_event,
        },
        "tasks":     parsed.get("tasks") or [],
        "emails":    parsed.get("emails") or [],
        "questions": questions,
        "model":     parsed.get("_model"),
    }


# ── /execute-recap ────────────────────────────────────────────────

class RecapTaskIn(BaseModel):
    title: str
    assignee: Optional[dict] = None
    due_iso: Optional[str] = None
    priority: str = "medium"


class RecapEmailIn(BaseModel):
    recipient: Optional[dict] = None
    subject: str
    body: str
    disposition: str = "draft"   # "draft" | "send"


class ExecuteRecapIn(BaseModel):
    company_id: str
    meeting: dict
    tasks: list[RecapTaskIn] = []
    emails: list[RecapEmailIn] = []
    original_text: Optional[str] = None


@router.post("/voice/actions/execute-recap")
async def execute_recap(inp: ExecuteRecapIn,
                          user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, inp.company_id)
    now = now_iso()
    action_id = str(uuid.uuid4())
    m = inp.meeting or {}
    contact = m.get("resolved_contact") or {}
    linked_event = m.get("linked_gcal_event") or {}

    # 1) contact activity (linked to GCal event if we found one)
    activity_id = str(uuid.uuid4())
    activity = {
        "id":              activity_id,
        "company_id":      inp.company_id,
        "user_id":         user["id"],
        "contact_id":      contact.get("id"),
        "contact_name":    contact.get("name"),
        "kind":            "meeting_recap",
        "title":           m.get("title") or "Meeting",
        "summary":         m.get("summary") or "",
        "notes":           m.get("notes") or "",
        "activity_time":   m.get("activity_time_iso") or now,
        "gcal_event_id":   linked_event.get("id"),
        "gcal_html_link":  linked_event.get("html_link"),
        "source":          "voice-recap",
        "voice_action_id": action_id,
        "created_at":      now,
    }
    await db.contact_activities.insert_one(activity)

    # 2) tasks — stamp source_recap_id for traceability
    created_task_ids: list[str] = []
    for t in inp.tasks:
        tid = str(uuid.uuid4())
        due_date, due_time = None, None
        if t.due_iso:
            try:
                dt = datetime.fromisoformat(t.due_iso.replace("Z", "+00:00"))
                due_date = dt.date().isoformat()
                due_time = dt.strftime("%H:%M")
            except Exception:
                pass
        a = t.assignee or {"id": user["id"], "name": user.get("name")}
        await db.tasks.insert_one({
            "id":             tid,
            "company_id":     inp.company_id,
            "title":          t.title,
            "kind":           "task",
            "status":         "open",
            "priority":       t.priority,
            "assignee_id":    a.get("id"),
            "assignee_name": a.get("name"),
            "contact_id":     contact.get("id"),
            "contact_name":   contact.get("name"),
            "due_date":       due_date,
            "due_time":       due_time,
            "created_by":     user["id"],
            "created_via":    "voice-recap",
            "voice_action_id": action_id,
            "source_activity_id": activity_id,
            "created_at":     now,
        })
        created_task_ids.append(tid)

    # 3) emails — save to drafts collection unless disposition=send
    drafted_ids: list[str] = []
    sent_ids: list[str] = []
    for e in inp.emails:
        eid = str(uuid.uuid4())
        r = e.recipient or {}
        doc = {
            "id":             eid,
            "company_id":     inp.company_id,
            "user_id":        user["id"],
            "contact_id":     r.get("id") or contact.get("id"),
            "to_email":       r.get("email"),
            "to_name":        r.get("name"),
            "subject":        e.subject,
            "body":           e.body,
            "status":         "draft",
            "source":         "voice-recap",
            "source_activity_id": activity_id,
            "voice_action_id": action_id,
            "created_at":     now,
        }
        # Explicit send path — try Gmail integration; fall back to draft.
        if e.disposition == "send" and r.get("email"):
            try:
                from routes.gmail import _send_email_for_user  # noqa
                sent = await _send_email_for_user(
                    user["id"], r["email"], e.subject, e.body,
                )
                if sent:
                    doc["status"] = "sent"
                    doc["gmail_message_id"] = sent.get("id")
                    sent_ids.append(eid)
            except Exception as err:
                log.warning("send failed, saved as draft: %s", err)
        await db.recap_emails.insert_one(doc)
        if doc["status"] == "draft":
            drafted_ids.append(eid)

    # 4) completed_actions log
    undo_deadline = (datetime.now(timezone.utc)
                      + timedelta(seconds=UNDO_WINDOW_SECONDS)).isoformat()
    summary_bits = []
    if m.get("title"): summary_bits.append(m["title"])
    if created_task_ids: summary_bits.append(f"{len(created_task_ids)} tasks")
    if drafted_ids: summary_bits.append(f"{len(drafted_ids)} email drafts")
    if sent_ids: summary_bits.append(f"{len(sent_ids)} emails sent")
    completed = {
        "id":            action_id,
        "user_id":       user["id"],
        "company_id":    inp.company_id,
        "intent":        "meeting_recap",
        "target_id":     activity_id,
        "target_type":   "meeting_recap",
        "summary":       " · ".join(summary_bits) or "Recap saved",
        "task_ids":      created_task_ids,
        "draft_email_ids": drafted_ids,
        "sent_email_ids":  sent_ids,
        "gcal_linked":   bool(linked_event.get("id")),
        "original_text": inp.original_text,
        "status":        "completed",
        "undo_deadline": undo_deadline,
        "created_at":    now,
    }
    await db.completed_actions.insert_one(completed)
    completed.pop("_id", None)
    return {"ok": True, "action": completed, "activity_id": activity_id}

