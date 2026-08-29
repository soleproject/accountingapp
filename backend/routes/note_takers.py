"""AI note-taker integrations — pluggable adapter framework (Feb 2026).

Any AI meeting note-taker with a public API can plug in here by
implementing the ``NoteTakerProvider`` interface. This module also
provides the shared plumbing (connection storage, webhook receiver,
match-and-log helpers) so each provider only writes ~50 lines of
provider-specific code.

Providers on day one:
  * fireflies  — free tier includes API + webhooks   (api_key auth)
  * tldv       — free tier includes API + webhooks   (api_key auth)
  * readai     — OAuth 2.1 (dynamic client reg), per-partner branded
Future (same shape):
  * grain      — OAuth 2.0
"""
from __future__ import annotations

import os
import uuid
import hmac
import base64
import hashlib
import secrets
import httpx
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
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
    auth_type: str = "api_key"   # "api_key" | "oauth"

    @abstractmethod
    async def verify_credentials(self, **credentials) -> dict:
        """Returns {ok: bool, user_email?: str, error?: str}.
        Kwargs allow future OAuth flows to pass tokens instead of a
        raw API key without changing this signature."""
        ...

    @abstractmethod
    def webhook_setup_instructions(self, callback_url: str) -> str:
        ...

    @abstractmethod
    async def parse_webhook(self, request: Request, connection: dict) -> Optional[NormalizedMeeting]:
        """Parse an incoming provider webhook. Receives the full stored
        connection dict so OAuth providers can access ``access_token`` /
        ``signing_key`` and refresh tokens as needed. API-key providers
        just read ``connection["api_key"]``."""
        ...

    # ── OAuth-only hooks (default: raise for api_key providers) ──
    async def oauth_authorize_url(
        self, *, state: str, redirect_uri: str, partner_id: Optional[str],
    ) -> str:
        raise NotImplementedError(f"{self.key} does not support OAuth")

    async def oauth_exchange_code(
        self, *, code: str, redirect_uri: str, partner_id: Optional[str],
    ) -> dict:
        """Returns {access_token, refresh_token, expires_at (iso), user_email?, user_name?}."""
        raise NotImplementedError(f"{self.key} does not support OAuth")

    def webhook_deep_link(self, *, webhook_url: str) -> Optional[str]:
        """Optional: URL that deep-links the user to the provider's
        webhook-configuration page with our URL pre-filled."""
        return None


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

    async def verify_credentials(self, **credentials) -> dict:
        api_key = credentials.get("api_key")
        if not api_key:
            return {"ok": False, "error": "api_key required"}
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

    async def parse_webhook(self, request: Request, connection: dict) -> Optional[NormalizedMeeting]:
        api_key = connection.get("api_key") or ""
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


# ── tl;dv implementation ───────────────────────────────────────────

class TldvProvider(NoteTakerProvider):
    """tl;dv (https://tldv.io) — v1alpha1 API.

    Auth:      ``x-api-key`` header (Business/Enterprise plan required).
    Base URL:  ``https://pasta.tldv.io``.
    Webhooks:  ``MeetingReady`` and ``TranscriptReady`` — payload of form
               ``{event, executedAt, data:{id,name,url,...}}``.
    """
    key = "tldv"
    display_name = "tl;dv"
    BASE = "https://pasta.tldv.io/v1alpha1"

    async def _get(self, api_key: str, path: str) -> dict:
        async with httpx.AsyncClient(timeout=15) as ac:
            r = await ac.get(
                f"{self.BASE}{path}",
                headers={"x-api-key": api_key, "Accept": "application/json"},
            )
            r.raise_for_status()
            return r.json() or {}

    async def verify_credentials(self, **credentials) -> dict:
        api_key = credentials.get("api_key")
        if not api_key:
            return {"ok": False, "error": "api_key required"}
        # tl;dv doesn't expose a /me endpoint on v1alpha1; probe the meetings
        # list — a 200 (even with empty results) validates the key.
        try:
            await self._get(api_key, "/meetings?limit=1")
            return {"ok": True}
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            if code in (401, 403):
                return {"ok": False, "error": "unauthorized (check API key & plan)"}
            return {"ok": False, "error": f"HTTP {code}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def webhook_setup_instructions(self, callback_url: str) -> str:
        return (
            "1. In tl;dv, open **Settings → Webhooks** (Business/Enterprise).\n"
            f"2. Add an HTTPS endpoint: `{callback_url}`\n"
            "3. Subscribe to the **MeetingReady** event (also **TranscriptReady** if you want richer summaries).\n"
            "4. Save. Every meeting tl;dv finishes processing will auto-flow into your CRM."
        )

    async def parse_webhook(self, request: Request, connection: dict) -> Optional[NormalizedMeeting]:
        api_key = connection.get("api_key") or ""
        try:
            body = await request.json()
        except Exception:
            return None
        event = (body.get("event") or body.get("eventType") or "").lower()
        data = body.get("data") or {}
        meeting_id = data.get("id") or body.get("id") or body.get("meetingId")
        if not meeting_id or "ready" not in event:
            return None

        # Enrich via REST. Notes give us the summary; meeting gives participants + times.
        meeting: dict = {}
        notes: dict = {}
        try:
            meeting = await self._get(api_key, f"/meetings/{meeting_id}")
        except Exception as e:
            log.warning("tl;dv meeting fetch failed: %s", e)
        try:
            notes = await self._get(api_key, f"/meetings/{meeting_id}/notes")
        except Exception as e:
            log.warning("tl;dv notes fetch failed: %s", e)

        title = meeting.get("name") or data.get("name") or "Meeting"
        started_at = (
            meeting.get("happenedAt")
            or meeting.get("startTime")
            or body.get("executedAt")
        )
        # Participants: tl;dv exposes a list of invitees/organizers
        participants: list[str] = []
        for k in ("invitees", "participants", "attendees"):
            for p in meeting.get(k) or []:
                em = (p.get("email") if isinstance(p, dict) else p) or ""
                if em and em not in participants:
                    participants.append(em)
        organizer = (meeting.get("organizer") or {}).get("email")
        if organizer and organizer not in participants:
            participants.append(organizer)

        # Summary: prefer the joined topic summaries; fall back to markdownContent.
        summary_parts: list[str] = []
        for tp in notes.get("topics") or []:
            s = (tp.get("summary") or "").strip()
            if s:
                summary_parts.append(f"• {tp.get('title') or 'Topic'}: {s}")
        summary = "\n".join(summary_parts) or (notes.get("markdownContent") or "").strip()

        # Action items: tl;dv notes include either a dedicated field or lines
        # like "- [ ] …" inside markdownContent. Handle both.
        items: list[str] = []
        for it in notes.get("actionItems") or notes.get("action_items") or []:
            txt = (it.get("text") if isinstance(it, dict) else it) or ""
            txt = txt.strip("-•[] ").strip()
            if txt:
                items.append(txt)
        if not items and notes.get("markdownContent"):
            for ln in (notes["markdownContent"] or "").splitlines():
                s = ln.strip()
                if s.lower().startswith(("- [ ]", "* [ ]", "[ ]")):
                    items.append(s.split("]", 1)[-1].strip("-•[] ").strip())

        return NormalizedMeeting(
            provider=self.key,
            external_id=str(meeting_id),
            title=title,
            started_at=started_at,
            participants=participants,
            summary=summary,
            action_items=items,
            meeting_url=meeting.get("url") or data.get("url"),
            transcript_url=f"https://app.tldv.io/meetings/{meeting_id}",
        )


PROVIDERS[TldvProvider.key] = TldvProvider()


# ── Read.ai (OAuth 2.1) ────────────────────────────────────────────

# Read.ai endpoints — https://support.read.ai/hc/en-us/articles/49380809380371
_READAI_REG_URL   = "https://api.read.ai/oauth/register"
_READAI_AUTH_UI   = "https://api.read.ai/oauth/ui"
_READAI_TOKEN_URL = "https://authn.read.ai/oauth2/token"
_READAI_API_BASE  = "https://api.read.ai"
_READAI_SCOPES    = "openid email offline_access profile meeting:read"


async def _get_or_create_readai_client(
    *, redirect_uri: str, partner_id: Optional[str],
    partner_display_name: Optional[str] = None,
    partner_logo_uri: Optional[str] = None,
) -> tuple[str, str]:
    """Return (client_id, client_secret) for the given partner brand.

    On first use for a partner we auto-register a new OAuth app on
    Read.ai with the partner's ``client_name`` + ``logo_uri`` so end
    users see the partner brand on the consent screen. Cached in
    ``readai_oauth_clients`` keyed by ``partner_id`` (or ``None`` for
    the platform default)."""
    q = {"partner_id": partner_id or None, "redirect_uri": redirect_uri}
    existing = await db.readai_oauth_clients.find_one(q)
    if existing and existing.get("client_id") and existing.get("client_secret"):
        return existing["client_id"], existing["client_secret"]

    name = partner_display_name or os.environ.get("READAI_DEFAULT_APP_NAME") or "SmartBooks CRM"
    payload = {
        "client_name": name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_method": "client_secret_basic",
        "scope": _READAI_SCOPES,
    }
    if partner_logo_uri:
        payload["logo_uri"] = partner_logo_uri
    async with httpx.AsyncClient(timeout=15) as ac:
        r = await ac.post(_READAI_REG_URL, json=payload,
                           headers={"Content-Type": "application/json"})
        r.raise_for_status()
        data = r.json() or {}
    client_id = data.get("client_id")
    client_secret = data.get("client_secret")
    if not (client_id and client_secret):
        raise RuntimeError(f"Read.ai registration returned no credentials: {data}")
    await db.readai_oauth_clients.update_one(
        q,
        {"$set": {
            "partner_id":   partner_id or None,
            "redirect_uri": redirect_uri,
            "client_id":    client_id,
            "client_secret": client_secret,
            "client_name":  name,
            "registered_at": now_iso(),
        }},
        upsert=True,
    )
    return client_id, client_secret


async def _partner_id_for_company(cid: str) -> Optional[str]:
    c = await db.companies.find_one({"id": cid}, {"partner_id": 1})
    return (c or {}).get("partner_id")


async def _partner_branding(partner_id: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    if not partner_id:
        return None, None
    p = await db.users.find_one({"id": partner_id, "role": "partner"},
                                  {"branding": 1})
    br = (p or {}).get("branding") or {}
    return br.get("firm_name"), br.get("logo_uri") or br.get("logo_url")


class ReadAiProvider(NoteTakerProvider):
    key = "readai"
    display_name = "Read.ai"
    auth_type = "oauth"

    async def _client_creds(self, redirect_uri: str, partner_id: Optional[str]) -> tuple[str, str]:
        name, logo = await _partner_branding(partner_id)
        return await _get_or_create_readai_client(
            redirect_uri=redirect_uri,
            partner_id=partner_id,
            partner_display_name=name,
            partner_logo_uri=logo,
        )

    async def verify_credentials(self, **credentials) -> dict:
        """OAuth version of "verify" — pings /v1/meetings with the
        stored access token; refreshes first if expired."""
        conn = credentials.get("connection") or {}
        access = conn.get("access_token")
        if not access:
            return {"ok": False, "error": "no access token"}
        try:
            async with httpx.AsyncClient(timeout=10) as ac:
                r = await ac.get(f"{_READAI_API_BASE}/v1/meetings?limit=1",
                                  headers={"Authorization": f"Bearer {access}"})
                r.raise_for_status()
            return {"ok": True, "user_email": conn.get("user_email")}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def webhook_setup_instructions(self, callback_url: str) -> str:
        return (
            "1. Open Read.ai → **Integrations → Webhooks** (Pro / Enterprise).\n"
            f"2. Paste the URL: `{callback_url}`\n"
            "3. Choose the **User** or **Workspace** webhook type and enable **meeting_end**.\n"
            "4. Save. Read.ai will POST every finished meeting to us.\n"
            "5. (Optional, recommended) Copy the signing key Read.ai generated and paste it back in SmartBooks — we'll verify every webhook."
        )

    def webhook_deep_link(self, *, webhook_url: str) -> Optional[str]:
        # Deep-link to Read.ai integrations settings.
        return "https://app.read.ai/settings/integrations"

    async def oauth_authorize_url(self, *, state: str, redirect_uri: str,
                                   partner_id: Optional[str]) -> str:
        client_id, _ = await self._client_creds(redirect_uri, partner_id)
        qs = urlencode({
            "response_type": "code",
            "client_id":     client_id,
            "redirect_uri":  redirect_uri,
            "state":         state,
            "scope":         _READAI_SCOPES,
        })
        return f"{_READAI_AUTH_UI}?{qs}"

    async def oauth_exchange_code(self, *, code: str, redirect_uri: str,
                                    partner_id: Optional[str]) -> dict:
        client_id, client_secret = await self._client_creds(redirect_uri, partner_id)
        async with httpx.AsyncClient(timeout=15) as ac:
            r = await ac.post(
                _READAI_TOKEN_URL,
                data={
                    "grant_type":    "authorization_code",
                    "code":          code,
                    "redirect_uri":  redirect_uri,
                },
                auth=(client_id, client_secret),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            r.raise_for_status()
            tok = r.json()
        access  = tok.get("access_token")
        refresh = tok.get("refresh_token")
        expires_in = int(tok.get("expires_in") or 600)
        expires_at = (datetime.now(timezone.utc)
                      + timedelta(seconds=max(60, expires_in - 30))).isoformat()

        # Best-effort: pull the user's email from Read.ai
        email, name = None, None
        try:
            async with httpx.AsyncClient(timeout=10) as ac:
                r = await ac.get(f"{_READAI_API_BASE}/v1/users/me",
                                  headers={"Authorization": f"Bearer {access}"})
                if r.status_code == 200:
                    me = r.json() or {}
                    email = me.get("email")
                    name = me.get("name") or me.get("full_name")
        except Exception:
            pass

        return {
            "access_token":  access,
            "refresh_token": refresh,
            "expires_at":    expires_at,
            "user_email":    email,
            "user_name":     name,
            "partner_id":    partner_id,
        }

    async def _refresh_if_needed(self, conn: dict) -> str:
        """Return a valid access_token, refreshing if past expiry."""
        try:
            exp = datetime.fromisoformat(conn.get("expires_at") or "")
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
        except Exception:
            exp = datetime.now(timezone.utc) - timedelta(seconds=1)
        if exp > datetime.now(timezone.utc) and conn.get("access_token"):
            return conn["access_token"]

        redirect_uri = conn.get("redirect_uri")
        partner_id = conn.get("partner_id")
        if not (redirect_uri and conn.get("refresh_token")):
            raise RuntimeError("No refresh_token / redirect_uri on Read.ai connection")
        client_id, client_secret = await self._client_creds(redirect_uri, partner_id)
        async with httpx.AsyncClient(timeout=15) as ac:
            r = await ac.post(
                _READAI_TOKEN_URL,
                data={"grant_type": "refresh_token",
                       "refresh_token": conn["refresh_token"]},
                auth=(client_id, client_secret),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            r.raise_for_status()
            tok = r.json()
        new_access  = tok["access_token"]
        new_refresh = tok.get("refresh_token") or conn["refresh_token"]
        expires_in  = int(tok.get("expires_in") or 600)
        new_exp = (datetime.now(timezone.utc)
                    + timedelta(seconds=max(60, expires_in - 30))).isoformat()
        await db.note_taker_connections.update_one(
            {"_id": conn["_id"]},
            {"$set": {
                "access_token":  new_access,
                "refresh_token": new_refresh,
                "expires_at":    new_exp,
                "updated_at":    now_iso(),
            }},
        )
        return new_access

    async def parse_webhook(self, request: Request, connection: dict) -> Optional[NormalizedMeeting]:
        try:
            body = await request.json()
        except Exception:
            return None
        # Read.ai payload shape: { trigger, session_id, session, ... }
        # (docs: meeting_end includes full summary + action_items + transcript)
        trigger = (body.get("trigger") or body.get("event") or "").lower()
        if trigger and "end" not in trigger:
            return None

        sess = body.get("session") or body.get("data") or body
        meeting_id = (
            sess.get("id") or sess.get("session_id")
            or body.get("session_id") or body.get("id")
        )
        if not meeting_id:
            return None

        title = sess.get("title") or sess.get("subject") or "Meeting"
        started_at = (
            sess.get("start_time") or sess.get("started_at")
            or body.get("start_time")
        )
        ended_at = (
            sess.get("end_time") or sess.get("ended_at")
            or body.get("end_time")
        )
        # participants
        participants: list[str] = []
        for p in sess.get("participants") or body.get("participants") or []:
            em = (p.get("email") if isinstance(p, dict) else p) or ""
            em = em.strip().lower()
            if em and em not in participants:
                participants.append(em)
        owner = (sess.get("owner") or {}).get("email")
        if owner and owner.lower() not in participants:
            participants.append(owner.lower())

        # Summary (Read.ai `summary` is a rich object; fall back to text fields)
        smry = sess.get("summary") or body.get("summary") or {}
        if isinstance(smry, str):
            summary_text = smry
        else:
            summary_text = (
                smry.get("summary") or smry.get("short_summary")
                or smry.get("text") or ""
            )

        # Action items — Read.ai returns list of {text|title, ...}
        raw_items = (sess.get("action_items") or body.get("action_items")
                      or (smry.get("action_items") if isinstance(smry, dict) else None)
                      or [])
        items: list[str] = []
        for it in raw_items:
            if isinstance(it, dict):
                t = it.get("text") or it.get("title") or it.get("action") or ""
            else:
                t = str(it or "")
            t = t.strip("-•[] ").strip()
            if t:
                items.append(t)

        return NormalizedMeeting(
            provider=self.key,
            external_id=str(meeting_id),
            title=title,
            started_at=started_at,
            ended_at=ended_at,
            participants=participants,
            summary=summary_text,
            action_items=items,
            meeting_url=sess.get("meeting_url") or sess.get("report_url"),
            transcript_url=sess.get("report_url")
                            or f"https://app.read.ai/meetings/{meeting_id}",
        )


PROVIDERS[ReadAiProvider.key] = ReadAiProvider()



# ── connection storage ────────────────────────────────────────────

_SENSITIVE = ("api_key", "access_token", "refresh_token", "signing_key",
              "client_secret")


def _scrub(doc: dict) -> dict:
    d = {**doc}
    d.pop("_id", None)
    for k in _SENSITIVE:
        d.pop(k, None)
    return d


def _webhook_url_for(host: str, provider_key: str, cid: str, user_id: str) -> str:
    return (f"https://{host}/api/webhooks/notetaker/{provider_key}"
            f"?company_id={cid}&user_id={user_id}")


@router.get("/companies/{cid}/note-takers")
async def list_connections(cid: str, user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, cid)
    rows_cur = db.note_taker_connections.find({"company_id": cid, "user_id": user["id"]})
    rows = []
    async for r in rows_cur:
        r["pending_webhook"] = (r.get("meetings_ingested") or 0) == 0
        rows.append(_scrub(r))
    return {
        "connections": rows,
        "providers": [{"key": p.key, "display_name": p.display_name,
                        "auth_type": p.auth_type}
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
    if provider.auth_type != "api_key":
        raise HTTPException(400,
            f"{provider.display_name} uses OAuth — call /api/oauth/{provider.key}/start instead")
    v = await provider.verify_credentials(api_key=inp.api_key)
    if not v.get("ok"):
        raise HTTPException(400, f"Credentials failed: {v.get('error') or 'invalid API key'}")

    # Compose the webhook URL the user will paste into the provider's UI
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host") or ""
    ).split(":")[0].lower()
    webhook_url = _webhook_url_for(host, provider.key, cid, user["id"])

    doc = {
        "id":           str(uuid.uuid4()),
        "provider":     provider.key,
        "auth_type":    provider.auth_type,
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
    out = _scrub(doc)
    out["pending_webhook"] = True
    return {"ok": True, "connection": out}


# Signing-key paste-back (Read.ai HMAC-SHA256 verification opt-in)
class SigningKeyIn(BaseModel):
    signing_key: str


@router.post("/companies/{cid}/note-takers/{provider_key}/signing-key")
async def set_signing_key(cid: str, provider_key: str, inp: SigningKeyIn,
                           user: dict = Depends(get_current_user)) -> dict:
    await require_company(user, cid)
    r = await db.note_taker_connections.update_one(
        {"company_id": cid, "user_id": user["id"], "provider": provider_key},
        {"$set": {"signing_key": inp.signing_key.strip(),
                   "updated_at": now_iso()}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "No connection to attach signing key to")
    return {"ok": True}


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

    # Optional HMAC signature verification (Read.ai; opt-in for others).
    signing_key = conn.get("signing_key")
    if signing_key:
        raw = await request.body()
        sig_header = (
            request.headers.get("x-read-signature")
            or request.headers.get("X-Read-Signature")
            or request.headers.get("x-webhook-signature")
            or ""
        )
        try:
            key_bytes = base64.b64decode(signing_key)
        except Exception:
            key_bytes = signing_key.encode()
        expected = hmac.new(key_bytes, raw, hashlib.sha256).hexdigest()
        # Read.ai sends signature as raw hex or "sha256=<hex>"
        candidate = sig_header.split("=", 1)[-1].strip().lower()
        if not hmac.compare_digest(expected.lower(), candidate):
            log.warning("Rejected %s webhook — bad signature", provider_key)
            raise HTTPException(401, "Bad signature")
        # Re-inject the body so parse_webhook can await request.json()
        async def _receive() -> dict:
            return {"type": "http.request", "body": raw, "more_body": False}
        request._receive = _receive  # type: ignore

    normalized = await provider.parse_webhook(request, conn)
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



# ── OAuth flow (Read.ai) ─────────────────────────────────────────

def _base_url(request: Request) -> str:
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host") or ""
    ).split(":")[0].lower()
    return f"https://{host}"


def _readai_redirect_uri(request: Request) -> str:
    return f"{_base_url(request)}/api/oauth/readai/callback"


@router.get("/oauth/readai/start")
async def readai_oauth_start(
    request: Request,
    company_id: str,
    return_to: str = "/crm/settings?readai=connected",
    user: dict = Depends(get_current_user),
) -> dict:
    """Kick off Read.ai OAuth 2.1. Resolves the partner brand from the
    company, auto-registers a Read.ai OAuth client for that partner
    (once), then returns the branded auth_url."""
    await require_company(user, company_id)
    provider = PROVIDERS.get("readai")
    if not provider:
        raise HTTPException(500, "Read.ai provider not registered")

    partner_id = await _partner_id_for_company(company_id)
    redirect_uri = _readai_redirect_uri(request)
    state = secrets.token_urlsafe(24)

    try:
        auth_url = await provider.oauth_authorize_url(
            state=state, redirect_uri=redirect_uri, partner_id=partner_id,
        )
    except Exception as e:
        log.exception("Read.ai OAuth start failed: %s", e)
        raise HTTPException(500, f"Failed to start Read.ai OAuth: {e}")

    await db.readai_oauth_states.insert_one({
        "state":        state,
        "user_id":      user["id"],
        "company_id":   company_id,
        "partner_id":   partner_id,
        "redirect_uri": redirect_uri,
        "return_to":    return_to,
        "created_at":   now_iso(),
    })
    return {"auth_url": auth_url, "state": state}


@router.get("/oauth/readai/callback")
async def readai_oauth_callback(request: Request):
    q = dict(request.query_params)
    state = q.get("state")
    code  = q.get("code")
    err   = q.get("error")
    frontend_base = _base_url(request)

    def _fail(reason: str) -> RedirectResponse:
        return RedirectResponse(
            f"{frontend_base}/crm/settings?readai_error={reason}", status_code=302,
        )

    if err:                    return _fail(err)
    if not (state and code):   return _fail("missing_params")

    rec = await db.readai_oauth_states.find_one({"state": state})
    if not rec:                return _fail("state_expired")

    try:
        created = datetime.fromisoformat(rec["created_at"])
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - created > timedelta(minutes=10):
            await db.readai_oauth_states.delete_one({"state": state})
            return _fail("state_expired")
    except Exception:
        pass

    provider = PROVIDERS.get("readai")
    if not provider:
        return _fail("provider_missing")

    redirect_uri = rec["redirect_uri"]
    partner_id   = rec.get("partner_id")
    user_id      = rec["user_id"]
    company_id   = rec["company_id"]
    return_to    = rec.get("return_to") or "/crm/settings?readai=connected"

    try:
        tok = await provider.oauth_exchange_code(
            code=code, redirect_uri=redirect_uri, partner_id=partner_id,
        )
    except Exception as e:
        log.exception("Read.ai token exchange failed: %s", e)
        await db.readai_oauth_states.delete_one({"state": state})
        return _fail("token_exchange_failed")

    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host") or ""
    ).split(":")[0].lower()
    webhook_url = _webhook_url_for(host, "readai", company_id, user_id)

    doc = {
        "id":            str(uuid.uuid4()),
        "provider":      "readai",
        "auth_type":     "oauth",
        "company_id":    company_id,
        "user_id":       user_id,
        "partner_id":    partner_id,
        "access_token":  tok["access_token"],
        "refresh_token": tok["refresh_token"],
        "expires_at":    tok["expires_at"],
        "user_email":    tok.get("user_email"),
        "user_name":     tok.get("user_name"),
        "redirect_uri":  redirect_uri,
        "webhook_url":   webhook_url,
        "webhook_deep_link": provider.webhook_deep_link(webhook_url=webhook_url),
        "instructions":  provider.webhook_setup_instructions(webhook_url),
        "created_at":    now_iso(),
        "updated_at":    now_iso(),
        "meetings_ingested": 0,
    }
    await db.note_taker_connections.update_one(
        {"provider": "readai", "company_id": company_id, "user_id": user_id},
        {"$set": doc}, upsert=True,
    )
    await db.readai_oauth_states.delete_one({"state": state})
    return RedirectResponse(f"{frontend_base}{return_to}", status_code=302)
