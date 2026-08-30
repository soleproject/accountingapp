"""Contact activity sync — auto-log Gmail/Calendar into contacts (Feb 2026).

Every send / reply / received-thread / calendar-event fans out to the
contacts whose email addresses show up as counterparties. Each activity
carries a `meta.external_id` (message-id for email, event-id for
calendar) that is used to make ingest **idempotent** — re-opening the
same thread or reloading the same event does not duplicate entries on
the contact.

Two callers:
  * `routes/gmail.py`           — send / reply / thread-fetch
  * `routes/google_calendar.py` — event create
Both pass an optional `company_id` from the frontend so we know which
tenant's contacts to index. If it's absent we no-op cleanly (the user
is likely browsing Gmail outside of a company context).
"""
from __future__ import annotations

import re
import uuid
from typing import Iterable, Optional

from db import db, now_iso

# ── email address extraction ─────────────────────────────────────────

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+", re.IGNORECASE)


def extract_emails(*sources: str) -> list[str]:
    """Return all unique lowercase email addresses across the raw
    header values (which look like ``\"Name\" <addr@x.com>, addr2@y``)."""
    out: list[str] = []
    seen: set[str] = set()
    for s in sources:
        if not s:
            continue
        for m in _EMAIL_RE.findall(s):
            e = m.strip().lower()
            if e and e not in seen:
                seen.add(e)
                out.append(e)
    return out


def domain_of(email: str) -> str:
    at = email.rfind("@")
    return email[at + 1:].lower() if at >= 0 else ""


# ── contact resolution ──────────────────────────────────────────────

async def find_contacts_by_emails(
    company_id: str, emails: Iterable[str],
    *, exclude_self_emails: Iterable[str] = (),
) -> list[dict]:
    """Return distinct contacts in ``company_id`` whose email matches
    any of the given ``emails`` (case-insensitive)."""
    emails = [e for e in {(e or "").lower() for e in emails} if e]
    for s in exclude_self_emails or ():
        se = (s or "").lower()
        if se in emails:
            emails.remove(se)
    if not emails:
        return []
    # Do a case-insensitive lookup. Contact emails are stored as-is,
    # so we match on lowercased comparison via $regex with a strict
    # anchored pattern (safe: emails have no regex specials except `.`).
    or_clauses = [{"email": {"$regex": f"^{re.escape(e)}$", "$options": "i"}}
                   for e in emails]
    docs = await db.contacts.find(
        {"company_id": company_id, "$or": or_clauses}
    ).to_list(500)
    return docs


# ── idempotent activity append ──────────────────────────────────────

async def _push_unique(contact: dict, activity: dict) -> bool:
    """Append ``activity`` to ``contact.activities`` unless another
    activity with the same ``meta.external_id`` and ``meta.direction``
    (or ``kind``) already exists. Returns True if pushed."""
    ext = (activity.get("meta") or {}).get("external_id")
    direction = (activity.get("meta") or {}).get("direction")
    for a in contact.get("activities") or []:
        m = a.get("meta") or {}
        if ext and m.get("external_id") == ext:
            if not direction or m.get("direction") == direction:
                return False
    await db.contacts.update_one(
        {"company_id": contact["company_id"], "id": contact["id"]},
        {"$push": {"activities": activity},
         "$set":  {"updated_at": now_iso()}},
    )
    return True


# ── high-level helpers ──────────────────────────────────────────────

async def log_email_to_contacts(
    *, company_id: Optional[str], user: dict,
    direction: str,                          # "sent" | "received"
    to: str = "", cc: str = "", bcc: str = "",
    from_: str = "",
    subject: str = "",
    snippet: str = "",
    message_id: str = "",                    # RFC Message-ID
    thread_id: str = "",
    self_email: str = "",
) -> int:
    """Log a single email message to any contacts whose email appears in
    the counterparty headers (excluding the user's own address). Returns
    number of contacts touched."""
    if not company_id or not message_id:
        return 0
    # Counterparty pool: everyone except the current user
    counterparties = extract_emails(to, cc, bcc, from_) if direction == "received" \
        else extract_emails(to, cc, bcc)
    contacts = await find_contacts_by_emails(
        company_id, counterparties, exclude_self_emails=[self_email] if self_email else [],
    )
    verb = "Sent" if direction == "sent" else "Received"
    body_line = f"{verb} email: {subject or '(no subject)'}"
    if snippet and direction == "received":
        body_line += f" — {snippet[:120]}"

    activity_template = {
        "kind": "email",
        "body": body_line,
        "by_user_id": user.get("id"),
        "by_name":    user.get("name") or user.get("email") or "",
    }
    n = 0
    for c in contacts:
        act = {
            **activity_template,
            "id": str(uuid.uuid4()),
            "at": now_iso(),
            "meta": {
                "source":      "gmail",
                "direction":   direction,
                "external_id": message_id,
                "thread_id":   thread_id,
                "subject":     subject,
                "counterparty_email": (c.get("email") or "").lower(),
            },
        }
        if await _push_unique(c, act):
            n += 1
    return n


async def log_meeting_to_contacts(
    *, company_id: Optional[str], user: dict,
    event_id: str,
    summary: str,
    start: str,
    location: str = "",
    hangout_link: str = "",
    attendee_emails: Iterable[str] = (),
    self_email: str = "",
) -> int:
    if not company_id or not event_id:
        return 0
    contacts = await find_contacts_by_emails(
        company_id, attendee_emails,
        exclude_self_emails=[self_email] if self_email else [],
    )
    when = start or ""
    body = f"Scheduled meeting: {summary or '(no title)'}" + (f" @ {when}" if when else "")

    n = 0
    for c in contacts:
        act = {
            "id": str(uuid.uuid4()),
            "at": now_iso(),
            "kind": "meeting",
            "body": body,
            "by_user_id": user.get("id"),
            "by_name":    user.get("name") or user.get("email") or "",
            "meta": {
                "source":      "google_calendar",
                "external_id": event_id,
                "summary":     summary,
                "start":       start,
                "location":    location,
                "hangout_link": hangout_link,
                "counterparty_email": (c.get("email") or "").lower(),
            },
        }
        if await _push_unique(c, act):
            n += 1
    return n
