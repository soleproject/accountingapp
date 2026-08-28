"""AI note-taker integrations — pluggable adapter framework (Feb 2026).

Any AI meeting note-taker with a public API can plug in here by
implementing the ``NoteTakerProvider`` interface. This module also
provides the shared plumbing (connection storage, webhook receiver,
match-and-log helpers) so each provider only writes ~50 lines of
provider-specific code.

Providers on day one:
  * fireflies  — free tier includes API + webhooks (reference impl)
Future (same shape):
  * tldv       — free tier includes API
  * readai     — free tier includes API
"""
from __future__ import annotations

import os
import uuid
import httpx
import logging
from abc import ABC, abstractmethod
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db, now_iso
from routes.contact_sync import find_contacts_by_emails, extract_emails

log = logging.getLogger("axiom.notetaker")
router = APIRouter(prefix="/api")


# ── normalized payload ─────────────────────────────────────────────

class NormalizedMeeting(BaseModel):
    provider: str                     # "fireflies" / "tldv" / …
    external_id: str                  # provider's meeting id
    title: str = ""
    started_at: Optional[str] = None  # ISO8601
    ended_at:   Optional[str] = None
    participants: list[str] = []      # email addresses
    summary: str = ""                 # markdown/plain — main gist
    action_items: list[str] = []      # one per task
    transcript_url: Optional[str] = None
    meeting_url:    Optional[str] = None


# ── provider base class ────────────────────────────────────────────

class NoteTakerProvider(ABC):
    key: str            # short id used in routes / DB
    display_name: str

    @abstractmethod
    async def verify_credentials(self, api_key: str) -> dict:
        """Returns {ok: bool, user_email?: str, error?: str}."""
        ...

    @abstractmethod
    def webhook_setup_instructions(self, callback_url: str) -> str:
        """Human-readable one-time setup a user does in the provider's
        dashboard. If a provider supports API-driven webhook registration
        we can override with a `register_webhook()` method later."""
        ...

    @abstractmethod
    async def parse_webhook(self, request: Request, api_key: str) -> Optional[NormalizedMeeting]:
        """Take an incoming webhook request, use the connected API key
        to pull the full meeting details, return a normalized meeting
        or None if the event should be ignored."""
        ...


# ── Fireflies.ai reference implementation ──────────────────────────

class FirefliesProvider(NoteTakerProvider):
    key = "fireflies"
    display_name = "Fireflies.ai"
    GQL_URL = "https://api.fireflies.ai/graphql"

    async def _gql(self, api_key: str, query: str, variables: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=15) as ac:
            r = await ac.post(
                self.GQL_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={"query": query, "variables": variables or {}},
            )
            r.raise_for_status()
            data = r.json()
            if data.get("errors"):
                raise RuntimeError(str(data["errors"]))
            return data.get("data") or {}

    async def verify_credentials(self, api_key: str) -> dict:
        try:
            d = await self._gql(api_key, "query { user { email name } }")
            u = d.get("user") or {}
            return {"ok": True, "user_email": u.get("email"), "user_name": u.get("name")}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def webhook_setup_instructions(self, callback_url: str) -> str:
        return (
            "1. Sign in to Fireflies.ai → **Integrations → Webhooks**.\n"
            f"2. Add a webhook with URL: `{callback_url}`\n"
            "3. Subscribe to the **meeting.summarized** event.\n"
            "4. Save. Every meeting Fireflies summarises will auto-flow into your CRM."
        )

    async def parse_webhook(self, request: Request, api_key: str) -> Optional[NormalizedMeeting]:
        try:
            body = await request.json()
        except Exception:
            return None
        event_type = (body.get("eventType") or body.get("event") or "").lower()
        meeting_id = body.get("meetingId") or body.get("id") or body.get("meeting_id")
        if not meeting_id or "summar" not in event_type:
            return None

        # Fetch full transcript + summary + action items
        query = """
        query Transcript($id: String!) {
          transcript(id: $id) {
            id title date duration
            meeting_link
            participants
            summary { overview action_items short_summary }
          }
        }"""
        try:
            d = await self._gql(api_key, query, {"id": meeting_id})
        except Exception as e:
            log.warning("Fireflies GraphQL fetch failed: %s", e)
            return None
        t = d.get("transcript") or {}
        if not t:
            return None
        summary = t.get("summary") or {}
        # Fireflies returns action_items as a newline-separated string
        raw_items = (summary.get("action_items") or "").strip()
        items = [ln.strip("-• ").strip()
                  for ln in raw_items.splitlines() if ln.strip()]
        return NormalizedMeeting(
            provider=self.key,
            external_id=str(t.get("id") or meeting_id),
            title=t.get("title") or "Meeting",
            started_at=t.get("date"),
            participants=list(t.get("participants") or []),
            summary=summary.get("overview") or summary.get("short_summary") or "",
            action_items=items,
            meeting_url=t.get("meeting_link"),
            transcript_url=f"https://app.fireflies.ai/view/{t.get('id')}"
                            if t.get("id") else None,
        )


PROVIDERS: dict[str, NoteTakerProvider] = {
    FirefliesProvider.key: FirefliesProvider(),
}


# ── connection storage ────────────────────────────────────────────

@router.get("/companies/{cid}/note-takers")
async def list_connections(cid: str, user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, cid)
    rows_cur = db.note_taker_connections.find({"company_id": cid, "user_id": user["id"]})
    rows = []
    async for r in rows_cur:
        r.pop("_id", None); r.pop("api_key", None)   # never leak the key
        rows.append(r)
    return {
        "connections": rows,
        "providers": [{"key": p.key, "display_name": p.display_name}
                       for p in PROVIDERS.values()],
    }


class ConnectIn(BaseModel):
    provider: str
    api_key: str


@router.post("/companies/{cid}/note-takers")
async def connect(cid: str, inp: ConnectIn, request: Request,
                   user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, cid)
    provider = PROVIDERS.get(inp.provider)
    if not provider:
        raise HTTPException(400, f"Unsupported provider: {inp.provider}")
    v = await provider.verify_credentials(inp.api_key)
    if not v.get("ok"):
        raise HTTPException(400, f"Credentials failed: {v.get('error') or 'invalid API key'}")

    # Compose the webhook URL the user will paste into the provider's UI
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host") or ""
    ).split(":")[0].lower()
    webhook_url = f"https://{host}/api/webhooks/notetaker/{provider.key}?company_id={cid}&user_id={user['id']}"

    doc = {
        "id":           str(uuid.uuid4()),
        "provider":     provider.key,
        "company_id":   cid,
        "user_id":      user["id"],
        "api_key":      inp.api_key,
        "user_email":   v.get("user_email"),
        "user_name":    v.get("user_name"),
        "webhook_url":  webhook_url,
        "instructions": provider.webhook_setup_instructions(webhook_url),
        "created_at":   now_iso(),
        "updated_at":   now_iso(),
        "meetings_ingested": 0,
    }
    # Upsert on (provider, company_id, user_id)
    await db.note_taker_connections.update_one(
        {"provider": provider.key, "company_id": cid, "user_id": user["id"]},
        {"$set": doc}, upsert=True,
    )
    out = {**doc}; out.pop("api_key", None)
    return {"ok": True, "connection": out}


@router.delete("/companies/{cid}/note-takers/{provider_key}")
async def disconnect(cid: str, provider_key: str,
                      user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, cid)
    r = await db.note_taker_connections.delete_one({
        "company_id": cid, "user_id": user["id"], "provider": provider_key,
    })
    return {"ok": True, "deleted": r.deleted_count > 0}


# ── webhook receiver ──────────────────────────────────────────────

@router.post("/webhooks/notetaker/{provider_key}")
async def webhook_receiver(
    provider_key: str,
    request: Request,
    company_id: str,
    user_id: str,
) -> dict:
    provider = PROVIDERS.get(provider_key)
    if not provider:
        raise HTTPException(404, "Unknown provider")
    conn = await db.note_taker_connections.find_one({
        "provider": provider_key, "company_id": company_id, "user_id": user_id,
    })
    if not conn:
        raise HTTPException(404, "No matching connection")

    normalized = await provider.parse_webhook(request, conn["api_key"])
    if not normalized:
        return {"ok": True, "ignored": True}

    # Match participants → contacts
    contacts = await find_contacts_by_emails(
        company_id, normalized.participants,
        exclude_self_emails=[conn.get("user_email") or ""],
    )

    # 1) Log meeting to each matched contact (idempotent)
    ext_key = f"{normalized.provider}:{normalized.external_id}"
    body = f"Meeting notes: {normalized.title}"
    if normalized.summary:
        preview = normalized.summary[:280].strip()
        body += f"\n\n{preview}" + ("…" if len(normalized.summary) > 280 else "")
    activity = {
        "kind": "meeting",
        "body": body,
        "by_user_id": user_id,
        "by_name":    conn.get("user_name") or "",
    }
    logged = 0
    for c in contacts:
        already = any(
            (a.get("meta") or {}).get("external_id") == ext_key
            for a in (c.get("activities") or [])
        )
        if already:
            continue
        await db.contacts.update_one(
            {"company_id": company_id, "id": c["id"]},
            {"$push": {"activities": {
                **activity,
                "id": str(uuid.uuid4()),
                "at": normalized.started_at or now_iso(),
                "meta": {
                    "source":         "notetaker",
                    "provider":       normalized.provider,
                    "external_id":    ext_key,
                    "meeting_title":  normalized.title,
                    "transcript_url": normalized.transcript_url,
                    "counterparty_email": (c.get("email") or "").lower(),
                },
            }},
             "$set": {"updated_at": now_iso()}},
        )
        logged += 1

    # 2) Turn each action item into a task (idempotent per external_id + text)
    contact_ids = [c["id"] for c in contacts]
    tasks_created = 0
    for item in normalized.action_items:
        item_key = f"{ext_key}:{hash(item) & 0xFFFFFFFF}"
        existing = await db.tasks.find_one({
            "company_id": company_id,
            "meta.external_id": item_key,
        })
        if existing:
            continue
        await db.tasks.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id,
            "title":  item[:200],
            "kind":   "task",
            "status": "open", "priority": "medium",
            "created_by_user_id": user_id,
            "assignee_user_ids":  [user_id],
            "contact_ids":        contact_ids,
            "meta": {
                "source": "notetaker",
                "provider": normalized.provider,
                "external_id": item_key,
                "meeting_external_id": ext_key,
                "transcript_url": normalized.transcript_url,
            },
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        tasks_created += 1

    # Bookkeeping
    await db.note_taker_connections.update_one(
        {"_id": conn["_id"]},
        {"$inc": {"meetings_ingested": 1},
         "$set": {"last_meeting_at": now_iso()}},
    )
    return {
        "ok": True,
        "contacts_matched": len(contacts),
        "activities_logged": logged,
        "tasks_created":    tasks_created,
    }
