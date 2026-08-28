"""Gmail — Tier 3 email inbox for CRM (Feb 2026).

Native Gmail API integration behind Google OAuth 2.0 that gives every
Pro user a full inbox inside `/crm/email`. Design decisions:

- **Per-user connection** (not per-company). A single Gmail account
  can therefore be accessed while switching between multiple client
  companies without re-authing.
- Scopes: `gmail.modify` (read + label + trash), plus openid/email/
  profile for identity. This covers all v1 operations (list/read/
  send/reply/star/trash/mark-read) with a single consent screen.
- Tokens live in ``gmail_tokens`` keyed by user_id. Access token is
  auto-refreshed inside ``_creds_for_user`` before every service
  build; refresh_token is stored once (thanks to ``prompt='consent'``
  + ``access_type='offline'``) and reused indefinitely.
- Threads (not raw messages) are the display atom: users think in
  conversations, and Gmail's own UI mirrors this.

Routes (all prefixed ``/api``):

    GET  /oauth/gmail/start                → begin OAuth flow (302 to Google)
    GET  /oauth/gmail/callback             → OAuth callback (302 back to app)
    GET  /gmail/status                     → { connected, email }
    POST /gmail/disconnect                 → wipe tokens
    GET  /gmail/labels                     → user labels + counts
    GET  /gmail/threads?label=&q=&page_token=&max_results=
    GET  /gmail/threads/{thread_id}
    POST /gmail/send                       → new message
    POST /gmail/threads/{thread_id}/reply  → reply (threads correctly)
    POST /gmail/threads/{thread_id}/mark-read
    POST /gmail/threads/{thread_id}/star   → toggle star
    POST /gmail/threads/{thread_id}/trash
"""
from __future__ import annotations

import base64
import mimetypes
import os
# Relax oauthlib's scope-equality check — Google returns *all* scopes the
# user has ever granted this OAuth client (e.g. previously-approved
# calendar scopes), which is a superset of what we requested. Without
# this the token exchange raises "Scope has changed…" and the callback
# 302s to /crm/email with `gmail_error=token_exchange_failed`.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
import uuid
import warnings
from datetime import datetime, timezone, timedelta
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr

from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from auth import get_current_user
from db import db, now_iso

router = APIRouter(prefix="/api")

GOOGLE_CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]

# ── Helpers ──────────────────────────────────────────────────────────

def _base_url(request: Request) -> str:
    """Compute the public https base URL from the incoming request."""
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or ""
    ).split(":")[0].lower()
    return f"https://{host}"


def _redirect_uri(request: Request) -> str:
    return f"{_base_url(request)}/api/oauth/gmail/callback"


def _client_config() -> dict:
    if not (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET):
        raise HTTPException(500, "Gmail OAuth is not configured on the server.")
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }


def _new_flow(redirect_uri: str) -> Flow:
    return Flow.from_client_config(
        _client_config(),
        scopes=SCOPES,
        redirect_uri=redirect_uri,
    )


async def _save_token(user_id: str, creds: Credentials, email: str) -> None:
    expires_at = creds.expiry.replace(tzinfo=timezone.utc) if creds.expiry else (
        datetime.now(timezone.utc) + timedelta(minutes=55)
    )
    doc = {
        "user_id": user_id,
        "email": email,
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,  # None on re-consent → keep prior
        "expires_at": expires_at.isoformat(),
        "scopes": creds.scopes or SCOPES,
        "updated_at": now_iso(),
    }
    existing = await db.gmail_tokens.find_one({"user_id": user_id})
    if existing:
        # Preserve refresh_token if Google didn't return one (repeat consent)
        if not doc["refresh_token"]:
            doc["refresh_token"] = existing.get("refresh_token")
        await db.gmail_tokens.update_one({"user_id": user_id}, {"$set": doc})
    else:
        doc["created_at"] = now_iso()
        await db.gmail_tokens.insert_one(doc)


async def _creds_for_user(user_id: str) -> Credentials:
    tok = await db.gmail_tokens.find_one({"user_id": user_id})
    if not tok or not tok.get("refresh_token"):
        raise HTTPException(401, "Gmail is not connected. Please reconnect.")

    creds = Credentials(
        token=tok.get("access_token"),
        refresh_token=tok["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        scopes=tok.get("scopes") or SCOPES,
    )

    # Refresh if expired (or within 60s of expiring)
    exp_raw = tok.get("expires_at")
    try:
        exp = datetime.fromisoformat(exp_raw) if isinstance(exp_raw, str) else exp_raw
    except Exception:
        exp = None
    if not exp or exp.tzinfo is None:
        exp = (exp or datetime.now(timezone.utc)).replace(tzinfo=timezone.utc) if exp else datetime.now(timezone.utc)

    if datetime.now(timezone.utc) >= (exp - timedelta(seconds=60)):
        try:
            creds.refresh(GoogleRequest())
        except Exception as e:
            raise HTTPException(401, f"Gmail token refresh failed: {e}") from e
        await db.gmail_tokens.update_one(
            {"user_id": user_id},
            {"$set": {
                "access_token": creds.token,
                "expires_at": (creds.expiry.replace(tzinfo=timezone.utc)
                               if creds.expiry else
                               datetime.now(timezone.utc) + timedelta(minutes=55)
                               ).isoformat(),
                "updated_at": now_iso(),
            }},
        )
    return creds


def _gmail_service(creds: Credentials):
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


# ── Message parsing ──────────────────────────────────────────────────

def _decode_b64url(data: str) -> bytes:
    pad = 4 - (len(data) % 4)
    if pad != 4:
        data += "=" * pad
    return base64.urlsafe_b64decode(data.encode("utf-8"))


def _get_header(headers: list, name: str) -> str:
    for h in headers or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _walk_parts(payload: dict, out: dict) -> None:
    """Recursively walk a message payload; populate ``out`` with the
    first text/plain body, first text/html body, and any attachments."""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {}) or {}
    parts = payload.get("parts") or []
    filename = payload.get("filename")

    if filename and body.get("attachmentId"):
        out["attachments"].append({
            "filename": filename,
            "mime_type": mime,
            "size": body.get("size", 0),
            "attachment_id": body["attachmentId"],
            "part_id": payload.get("partId"),
        })
    elif mime == "text/plain" and body.get("data") and not out.get("text"):
        try:
            out["text"] = _decode_b64url(body["data"]).decode("utf-8", errors="replace")
        except Exception:
            pass
    elif mime == "text/html" and body.get("data") and not out.get("html"):
        try:
            out["html"] = _decode_b64url(body["data"]).decode("utf-8", errors="replace")
        except Exception:
            pass

    for p in parts:
        _walk_parts(p, out)


def _parse_message(msg: dict) -> dict:
    payload  = msg.get("payload", {}) or {}
    headers  = payload.get("headers", []) or []
    parsed   = {"text": "", "html": "", "attachments": []}
    _walk_parts(payload, parsed)
    return {
        "id":          msg.get("id"),
        "thread_id":   msg.get("threadId"),
        "label_ids":   msg.get("labelIds") or [],
        "snippet":     msg.get("snippet", ""),
        "internal_date": msg.get("internalDate"),
        "from":        _get_header(headers, "From"),
        "to":          _get_header(headers, "To"),
        "cc":          _get_header(headers, "Cc"),
        "bcc":         _get_header(headers, "Bcc"),
        "subject":     _get_header(headers, "Subject"),
        "date":        _get_header(headers, "Date"),
        "message_id":  _get_header(headers, "Message-ID"),
        "references":  _get_header(headers, "References"),
        "in_reply_to": _get_header(headers, "In-Reply-To"),
        "text":        parsed["text"],
        "html":        parsed["html"],
        "attachments": parsed["attachments"],
    }


# ── OAuth routes ─────────────────────────────────────────────────────

@router.get("/oauth/gmail/start")
async def gmail_oauth_start(
    request: Request,
    return_to: str = "/crm/email",
    user: dict = Depends(get_current_user),
):
    """Kick off Google OAuth. State stores user_id + return path."""
    redirect_uri = _redirect_uri(request)
    flow = _new_flow(redirect_uri)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        auth_url, state = flow.authorization_url(
            access_type="offline",
            prompt="consent",
        )

    await db.gmail_oauth_states.insert_one({
        "state":       state,
        "user_id":     user["id"],
        "return_to":   return_to,
        "redirect_uri": redirect_uri,
        # PKCE: persist the code_verifier so the callback's fresh Flow
        # can pass it to Google during token exchange.
        "code_verifier": getattr(flow, "code_verifier", None),
        "created_at":  now_iso(),
    })
    return {"auth_url": auth_url, "state": state}


@router.get("/oauth/gmail/callback")
async def gmail_oauth_callback(request: Request):
    """Handle Google's callback. Exchanges code for tokens and
    persists them keyed to the initiating user."""
    q = dict(request.query_params)
    state = q.get("state")
    code  = q.get("code")
    err   = q.get("error")

    frontend_base = _base_url(request)  # same host serves react app

    if err:
        return RedirectResponse(
            f"{frontend_base}/crm/email?gmail_error={err}", status_code=302,
        )
    if not (state and code):
        return RedirectResponse(
            f"{frontend_base}/crm/email?gmail_error=missing_params", status_code=302,
        )

    rec = await db.gmail_oauth_states.find_one({"state": state})
    if not rec:
        return RedirectResponse(
            f"{frontend_base}/crm/email?gmail_error=state_expired", status_code=302,
        )

    # 10-minute TTL guard
    try:
        created = datetime.fromisoformat(rec["created_at"])
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - created > timedelta(minutes=10):
            await db.gmail_oauth_states.delete_one({"state": state})
            return RedirectResponse(
                f"{frontend_base}/crm/email?gmail_error=state_expired", status_code=302,
            )
    except Exception:
        pass

    user_id      = rec["user_id"]
    return_to    = rec.get("return_to") or "/crm/email"
    redirect_uri = rec.get("redirect_uri") or _redirect_uri(request)
    code_verifier = rec.get("code_verifier")

    flow = _new_flow(redirect_uri)
    # Restore the PKCE code_verifier that was used at authorization time.
    if code_verifier:
        flow.code_verifier = code_verifier
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            flow.fetch_token(code=code)
    except Exception as e:
        import logging
        logging.getLogger("axiom.gmail").exception(
            "gmail token exchange failed for user_id=%s: %s", user_id, e,
        )
        await db.gmail_oauth_states.delete_one({"state": state})
        return RedirectResponse(
            f"{frontend_base}{return_to}?gmail_error=token_exchange_failed",
            status_code=302,
        )

    creds = flow.credentials
    # Pull user email
    try:
        prof = _gmail_service(creds).users().getProfile(userId="me").execute()
        email = prof.get("emailAddress", "")
    except Exception:
        email = ""

    await _save_token(user_id, creds, email)
    await db.gmail_oauth_states.delete_one({"state": state})

    sep = "&" if "?" in return_to else "?"
    return RedirectResponse(
        f"{frontend_base}{return_to}{sep}gmail_connected=1", status_code=302,
    )


@router.get("/gmail/status")
async def gmail_status(user: dict = Depends(get_current_user)):
    tok = await db.gmail_tokens.find_one({"user_id": user["id"]})
    if not tok:
        return {"connected": False, "email": None}
    return {
        "connected": bool(tok.get("refresh_token")),
        "email": tok.get("email") or "",
    }


@router.post("/gmail/disconnect")
async def gmail_disconnect(user: dict = Depends(get_current_user)):
    await db.gmail_tokens.delete_many({"user_id": user["id"]})
    return {"ok": True}


# ── Labels / folders ─────────────────────────────────────────────────

# What we surface in v1 (order matters for UI)
V1_LABELS = ["INBOX", "STARRED", "SENT", "DRAFT", "TRASH", "SPAM"]

@router.get("/gmail/labels")
async def gmail_labels(user: dict = Depends(get_current_user)):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    try:
        res = svc.users().labels().list(userId="me").execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    labels = res.get("labels", [])
    # Attach unread counts for the ones we surface
    surfaced = []
    system_ids = set(V1_LABELS) | {"CATEGORY_PERSONAL"}
    for lbl in labels:
        if lbl.get("type") == "system" and lbl["id"] in system_ids:
            try:
                detail = svc.users().labels().get(
                    userId="me", id=lbl["id"]
                ).execute()
                lbl["messages_unread"] = detail.get("messagesUnread", 0)
                lbl["messages_total"]  = detail.get("messagesTotal", 0)
            except HttpError:
                pass
            surfaced.append(lbl)
    return {"labels": surfaced, "all": labels}


# ── Threads ──────────────────────────────────────────────────────────

@router.get("/gmail/threads")
async def gmail_list_threads(
    label: str = "INBOX",
    q: str = "",
    max_results: int = 25,
    page_token: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """List threads. `label` maps to a Gmail label id ("INBOX", "SENT",
    "DRAFT", "STARRED", "TRASH", or "" for All Mail). `q` is a raw
    Gmail search query — the UI uses this for contact filtering."""
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)

    kwargs = {"userId": "me", "maxResults": max(1, min(max_results, 100))}
    if page_token:
        kwargs["pageToken"] = page_token
    # ALL_MAIL is implicit — no labelIds set
    if label and label.upper() != "ALL":
        kwargs["labelIds"] = [label.upper()]
    if q:
        kwargs["q"] = q

    try:
        res = svc.users().threads().list(**kwargs).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    threads = res.get("threads", []) or []

    # Fetch metadata for each thread's most recent message so we can
    # render the list without a second round-trip per row.
    out = []
    for t in threads:
        try:
            td = svc.users().threads().get(
                userId="me", id=t["id"], format="metadata",
                metadataHeaders=["From", "To", "Subject", "Date"],
            ).execute()
        except HttpError:
            continue
        msgs = td.get("messages", []) or []
        last = msgs[-1] if msgs else {}
        headers = (last.get("payload") or {}).get("headers", [])
        first = msgs[0] if msgs else {}
        first_headers = (first.get("payload") or {}).get("headers", [])
        # thread is unread if any message has UNREAD
        unread = any("UNREAD" in (m.get("labelIds") or []) for m in msgs)
        starred = any("STARRED" in (m.get("labelIds") or []) for m in msgs)
        out.append({
            "id":          td.get("id"),
            "history_id":  td.get("historyId"),
            "snippet":     td.get("snippet", ""),
            "message_count": len(msgs),
            "unread":      unread,
            "starred":     starred,
            "from":        _get_header(headers, "From"),
            "to":          _get_header(headers, "To"),
            "subject":     _get_header(first_headers, "Subject")
                            or _get_header(headers, "Subject"),
            "date":        _get_header(headers, "Date"),
            "internal_date": last.get("internalDate"),
            "label_ids":   list({lid for m in msgs for lid in (m.get("labelIds") or [])}),
        })
    return {
        "threads":            out,
        "next_page_token":    res.get("nextPageToken"),
        "result_size_estimate": res.get("resultSizeEstimate", len(out)),
    }


@router.get("/gmail/threads/{thread_id}")
async def gmail_get_thread(
    thread_id: str,
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    try:
        td = svc.users().threads().get(userId="me", id=thread_id, format="full").execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    msgs = [_parse_message(m) for m in (td.get("messages") or [])]
    return {"id": td.get("id"), "history_id": td.get("historyId"), "messages": msgs}


# ── Attachments ──────────────────────────────────────────────────────

@router.get("/gmail/messages/{message_id}/attachments/{attachment_id}")
async def gmail_get_attachment(
    message_id: str,
    attachment_id: str,
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    try:
        att = svc.users().messages().attachments().get(
            userId="me", messageId=message_id, id=attachment_id,
        ).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    data = att.get("data", "")
    # Return base64url as-is — the frontend decodes and offers download.
    return {"data": data, "size": att.get("size", 0)}


# ── Send / Reply ─────────────────────────────────────────────────────

class SendIn(BaseModel):
    to: str
    cc: Optional[str] = ""
    bcc: Optional[str] = ""
    subject: str = ""
    body_html: str = ""
    body_text: Optional[str] = ""
    # attachments handled via a separate multipart endpoint below


def _build_mime(
    from_email: str,
    to: str, cc: str, bcc: str,
    subject: str, body_html: str, body_text: str,
    attachments: list[tuple[str, str, bytes]] = None,
    in_reply_to: str = "", references: str = "",
) -> str:
    """Compose a MIME message and return it base64url-encoded so it's
    ready for Gmail's ``raw`` field."""
    if attachments:
        outer = MIMEMultipart("mixed")
        alt = MIMEMultipart("alternative")
        if body_text:
            alt.attach(MIMEText(body_text, "plain", "utf-8"))
        if body_html:
            alt.attach(MIMEText(body_html, "html", "utf-8"))
        outer.attach(alt)
        for filename, mime_type, data in attachments:
            maintype, _, subtype = (mime_type or "application/octet-stream").partition("/")
            part = MIMEBase(maintype or "application", subtype or "octet-stream")
            part.set_payload(data)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
            outer.attach(part)
    elif body_html:
        outer = MIMEMultipart("alternative")
        if body_text:
            outer.attach(MIMEText(body_text, "plain", "utf-8"))
        outer.attach(MIMEText(body_html, "html", "utf-8"))
    else:
        outer = MIMEText(body_text or "", "plain", "utf-8")

    outer["From"] = from_email
    outer["To"] = to
    if cc:  outer["Cc"] = cc
    if bcc: outer["Bcc"] = bcc
    outer["Subject"] = subject
    if in_reply_to: outer["In-Reply-To"] = in_reply_to
    if references:  outer["References"] = references

    raw = base64.urlsafe_b64encode(outer.as_bytes()).decode("utf-8")
    return raw


@router.post("/gmail/send")
async def gmail_send(
    to: str = Form(...),
    subject: str = Form(""),
    body_html: str = Form(""),
    body_text: str = Form(""),
    cc: str = Form(""),
    bcc: str = Form(""),
    thread_id: str = Form(""),
    in_reply_to: str = Form(""),
    references: str = Form(""),
    attachments: list[UploadFile] = File(default=[]),
    user: dict = Depends(get_current_user),
):
    """Send a new email or reply. If ``thread_id`` is provided, the
    message threads correctly (Gmail requires ``threadId`` in the
    request body **and** matching In-Reply-To / References headers)."""
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)

    tok = await db.gmail_tokens.find_one({"user_id": user["id"]})
    from_email = (tok or {}).get("email") or "me"

    files_payload = []
    for f in (attachments or []):
        if not f: continue
        contents = await f.read()
        mtype = f.content_type or mimetypes.guess_type(f.filename or "")[0] or "application/octet-stream"
        files_payload.append((f.filename or "attachment", mtype, contents))

    raw = _build_mime(
        from_email=from_email,
        to=to, cc=cc, bcc=bcc,
        subject=subject, body_html=body_html, body_text=body_text,
        attachments=files_payload,
        in_reply_to=in_reply_to, references=references,
    )
    body = {"raw": raw}
    if thread_id:
        body["threadId"] = thread_id
    try:
        sent = svc.users().messages().send(userId="me", body=body).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return {"id": sent.get("id"), "thread_id": sent.get("threadId")}


class ReplyIn(BaseModel):
    body_html: str = ""
    body_text: Optional[str] = ""


@router.post("/gmail/threads/{thread_id}/reply")
async def gmail_reply(
    thread_id: str,
    body_html: str = Form(""),
    body_text: str = Form(""),
    to_override: str = Form(""),  # override reply recipient if desired
    cc: str = Form(""),
    attachments: list[UploadFile] = File(default=[]),
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    tok = await db.gmail_tokens.find_one({"user_id": user["id"]})
    from_email = (tok or {}).get("email") or "me"

    # Grab the last message in the thread to build proper reply headers
    try:
        td = svc.users().threads().get(userId="me", id=thread_id, format="metadata",
                                        metadataHeaders=["From","To","Cc","Subject",
                                                          "Message-ID","References"]).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    msgs = td.get("messages") or []
    if not msgs:
        raise HTTPException(404, "Thread has no messages")
    last = msgs[-1]
    headers = (last.get("payload") or {}).get("headers", [])
    last_msg_id = _get_header(headers, "Message-ID")
    last_refs   = _get_header(headers, "References")
    last_from   = _get_header(headers, "From")
    last_subject = _get_header(headers, "Subject") or ""

    reply_to = to_override or last_from
    subject  = last_subject if last_subject.lower().startswith("re:") else f"Re: {last_subject}"

    references = (last_refs + " " + last_msg_id).strip() if last_msg_id else last_refs

    files_payload = []
    for f in (attachments or []):
        if not f: continue
        contents = await f.read()
        mtype = f.content_type or mimetypes.guess_type(f.filename or "")[0] or "application/octet-stream"
        files_payload.append((f.filename or "attachment", mtype, contents))

    raw = _build_mime(
        from_email=from_email,
        to=reply_to, cc=cc, bcc="",
        subject=subject, body_html=body_html, body_text=body_text,
        attachments=files_payload,
        in_reply_to=last_msg_id, references=references,
    )
    try:
        sent = svc.users().messages().send(
            userId="me", body={"raw": raw, "threadId": thread_id},
        ).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return {"id": sent.get("id"), "thread_id": sent.get("threadId")}


# ── Mutations: mark read, star, trash ────────────────────────────────

@router.post("/gmail/threads/{thread_id}/mark-read")
async def gmail_mark_read(
    thread_id: str,
    read: bool = True,
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    body = ({"removeLabelIds": ["UNREAD"]} if read else {"addLabelIds": ["UNREAD"]})
    try:
        svc.users().threads().modify(userId="me", id=thread_id, body=body).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return {"ok": True}


@router.post("/gmail/threads/{thread_id}/star")
async def gmail_toggle_star(
    thread_id: str,
    starred: bool = True,
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    body = ({"addLabelIds": ["STARRED"]} if starred else {"removeLabelIds": ["STARRED"]})
    try:
        svc.users().threads().modify(userId="me", id=thread_id, body=body).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return {"ok": True, "starred": starred}


@router.post("/gmail/threads/{thread_id}/trash")
async def gmail_trash(
    thread_id: str,
    user: dict = Depends(get_current_user),
):
    creds = await _creds_for_user(user["id"])
    svc = _gmail_service(creds)
    try:
        svc.users().threads().trash(userId="me", id=thread_id).execute()
    except HttpError as e:
        raise HTTPException(e.resp.status, e._get_reason())
    return {"ok": True}
