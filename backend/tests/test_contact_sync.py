"""Contact activity sync — email + calendar → contact timeline (Feb 2026)."""
from __future__ import annotations
import sys, uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    """User + company + Gmail token + a contact."""
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    contact_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"user_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "Sync Tester",
    })
    await db.companies.insert_one({
        "id": cid, "name": "SyncCo", "created_at": "2026-01-01T00:00:00Z",
    })
    await db.memberships.insert_one({
        "user_id": uid, "company_id": cid, "role": "owner",
    })
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Client Alice", "email": "alice@example.com",
        "type": "customer",
        "activities": [],
    })
    await db.gmail_tokens.insert_one({
        "user_id": uid, "email": "me@bigsaas.ai",
        "access_token": "at", "refresh_token": "rt",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "scopes": [],
    })
    return uid, cid, contact_id, create_token(uid, "client")


async def _cleanup(uid, cid, contact_id):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})
    await db.contacts.delete_one({"id": contact_id})
    await db.gmail_tokens.delete_many({"user_id": uid})


# ── send email logs to matching contact ─────────────────────────────
def test_send_email_logs_to_matching_contact():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            svc = MagicMock()
            send_call = MagicMock()
            send_call.execute.return_value = {"id": "MSG-1", "threadId": "T-1"}
            svc.users().messages().send.return_value = send_call

            with patch("routes.gmail._gmail_service", return_value=svc):
                client = await _client()
                r = await client.post(
                    "/api/gmail/send",
                    headers={"Authorization": f"Bearer {tok}"},
                    data={
                        "to": "alice@example.com",
                        "subject": "Hello Alice",
                        "body_text": "hey",
                        "company_id": cid,
                    },
                )
                assert r.status_code == 200, r.text

            contact = await db.contacts.find_one({"id": contact_id})
            acts = contact.get("activities") or []
            assert len(acts) == 1
            a = acts[0]
            assert a["kind"] == "email"
            assert "Hello Alice" in a["body"]
            assert a["meta"]["direction"] == "sent"
            assert a["meta"]["external_id"] == "MSG-1"
            assert a["meta"]["source"] == "gmail"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── idempotency: same message-id doesn't duplicate ──────────────────
def test_send_is_idempotent_by_message_id():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            svc = MagicMock()
            send_call = MagicMock()
            send_call.execute.return_value = {"id": "MSG-2", "threadId": "T-2"}
            svc.users().messages().send.return_value = send_call

            with patch("routes.gmail._gmail_service", return_value=svc):
                client = await _client()
                for _ in range(3):
                    r = await client.post(
                        "/api/gmail/send",
                        headers={"Authorization": f"Bearer {tok}"},
                        data={"to": "alice@example.com", "subject": "Hi",
                              "body_text": "x", "company_id": cid},
                    )
                    assert r.status_code == 200

            contact = await db.contacts.find_one({"id": contact_id})
            assert len(contact.get("activities") or []) == 1
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── send without company_id skips sync ──────────────────────────────
def test_send_without_company_id_does_not_log():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            svc = MagicMock()
            send_call = MagicMock()
            send_call.execute.return_value = {"id": "MSG-3", "threadId": "T-3"}
            svc.users().messages().send.return_value = send_call

            with patch("routes.gmail._gmail_service", return_value=svc):
                client = await _client()
                r = await client.post(
                    "/api/gmail/send",
                    headers={"Authorization": f"Bearer {tok}"},
                    data={"to": "alice@example.com", "subject": "S",
                          "body_text": "b"},   # no company_id
                )
                assert r.status_code == 200

            contact = await db.contacts.find_one({"id": contact_id})
            assert len(contact.get("activities") or []) == 0
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── thread-view logs received messages ──────────────────────────────
def test_thread_view_logs_received():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            svc = MagicMock()
            get_call = MagicMock()
            # One received message from alice + one message we sent
            get_call.execute.return_value = {
                "id": "T-5", "historyId": "1",
                "messages": [
                    {
                        "id": "IN1", "threadId": "T-5",
                        "snippet": "quick question",
                        "labelIds": ["INBOX"],
                        "payload": {"headers": [
                            {"name": "Message-ID", "value": "<incoming@x.com>"},
                            {"name": "From", "value": "Alice <alice@example.com>"},
                            {"name": "To",   "value": "me@bigsaas.ai"},
                            {"name": "Subject", "value": "Question"},
                        ]},
                    },
                ],
            }
            svc.users().threads().get.return_value = get_call

            with patch("routes.gmail._gmail_service", return_value=svc):
                client = await _client()
                r = await client.get(
                    f"/api/gmail/threads/T-5?company_id={cid}",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text

            contact = await db.contacts.find_one({"id": contact_id})
            acts = contact.get("activities") or []
            assert len(acts) == 1
            assert acts[0]["meta"]["direction"] == "received"
            assert acts[0]["meta"]["external_id"] == "<incoming@x.com>"
            assert "Question" in acts[0]["body"]
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── calendar create logs to attendee contact ────────────────────────
def test_calendar_event_logs_to_attendee_contact():
    async def _t():
        uid, cid, contact_id, tok = await _mk_env()
        try:
            svc = MagicMock()
            insert_call = MagicMock()
            insert_call.execute.return_value = {
                "id": "EV-1", "summary": "Kickoff",
                "start": {"dateTime": "2026-03-05T14:00:00-05:00"},
                "end":   {"dateTime": "2026-03-05T15:00:00-05:00"},
                "attendees": [{"email": "alice@example.com"}],
            }
            svc.events().insert.return_value = insert_call

            with patch("routes.google_calendar._calendar_service", return_value=svc):
                client = await _client()
                r = await client.post(
                    "/api/google/calendar/events",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "summary": "Kickoff",
                        "start": "2026-03-05T14:00:00-05:00",
                        "end":   "2026-03-05T15:00:00-05:00",
                        "attendees": [{"email": "alice@example.com"}],
                        "company_id": cid,
                    },
                )
                assert r.status_code == 200, r.text

            contact = await db.contacts.find_one({"id": contact_id})
            acts = contact.get("activities") or []
            assert len(acts) == 1
            a = acts[0]
            assert a["kind"] == "meeting"
            assert "Kickoff" in a["body"]
            assert a["meta"]["source"] == "google_calendar"
            assert a["meta"]["external_id"] == "EV-1"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── extract_emails handles messy headers ────────────────────────────
def test_extract_emails_handles_realistic_headers():
    from routes.contact_sync import extract_emails
    emails = extract_emails(
        '"Alice" <alice@example.com>, bob@example.com',
        "cc@example.com, \"Charlie\" <charlie@x.io>",
    )
    assert set(emails) == {
        "alice@example.com", "bob@example.com",
        "cc@example.com", "charlie@x.io",
    }
