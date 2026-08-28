"""AI note-taker integrations — Fireflies reference (Feb 2026)."""
from __future__ import annotations
import sys, uuid
from unittest.mock import patch, AsyncMock

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _env():
    uid, cid = str(uuid.uuid4()), str(uuid.uuid4())
    contact_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "NT User",
    })
    await db.companies.insert_one({
        "id": cid, "name": "NTCo", "created_at": "2026-01-01T00:00:00Z",
    })
    await db.memberships.insert_one({"user_id": uid, "company_id": cid, "role": "owner"})
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Alice", "email": "alice@example.com", "type": "customer",
        "activities": [],
    })
    return uid, cid, contact_id, create_token(uid, "client")


async def _cleanup(uid, cid, contact_id):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})
    await db.contacts.delete_one({"id": contact_id})
    await db.tasks.delete_many({"company_id": cid})
    await db.note_taker_connections.delete_many({"company_id": cid})


def test_connect_verifies_and_stores():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch("routes.note_takers.FirefliesProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": True, "user_email": "me@x.com",
                                                    "user_name": "Me"})):
                client = await _client()
                r = await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "fireflies", "api_key": "ff_test"},
                )
                assert r.status_code == 200, r.text
                d = r.json()["connection"]
                assert d["provider"] == "fireflies"
                assert d["user_email"] == "me@x.com"
                assert d["webhook_url"].startswith("https://")
                assert "api_key" not in d
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_connect_rejects_bad_credentials():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch("routes.note_takers.FirefliesProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": False, "error": "unauthorized"})):
                client = await _client()
                r = await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "fireflies", "api_key": "bad"},
                )
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_webhook_logs_contact_and_creates_tasks():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            # Seed a connection
            with patch("routes.note_takers.FirefliesProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": True, "user_email": "me@x.com",
                                                    "user_name": "Me"})):
                client = await _client()
                await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "fireflies", "api_key": "ff_test"},
                )
            # Mock parse_webhook to return a normalized meeting w/ two action items
            from routes.note_takers import NormalizedMeeting
            normalized = NormalizedMeeting(
                provider="fireflies", external_id="FFMEET1",
                title="Kickoff w/ Acme",
                started_at="2026-03-01T10:00:00Z",
                participants=["alice@example.com", "me@x.com"],
                summary="Discussed pricing; Alice wants a demo of the reporting module.",
                action_items=["Send pricing PDF to Alice",
                               "Book demo of reporting module"],
                transcript_url="https://app.fireflies.ai/view/FFMEET1",
            )
            with patch("routes.note_takers.FirefliesProvider.parse_webhook",
                       new=AsyncMock(return_value=normalized)):
                r = await client.post(
                    f"/api/webhooks/notetaker/fireflies?company_id={cid}&user_id={uid}",
                    json={"eventType": "meeting.summarized", "meetingId": "FFMEET1"},
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert d["contacts_matched"] == 1
                assert d["activities_logged"] == 1
                assert d["tasks_created"] == 2
                # Re-post: idempotent
                r2 = await client.post(
                    f"/api/webhooks/notetaker/fireflies?company_id={cid}&user_id={uid}",
                    json={"eventType": "meeting.summarized", "meetingId": "FFMEET1"},
                )
                d2 = r2.json()
                assert d2["activities_logged"] == 0
                assert d2["tasks_created"] == 0
            # Verify activity actually landed
            c = await db.contacts.find_one({"id": contact_id})
            acts = c.get("activities") or []
            assert len(acts) == 1
            a = acts[0]
            assert a["kind"] == "meeting"
            assert "Kickoff w/ Acme" in a["body"]
            assert a["meta"]["source"] == "notetaker"
            assert a["meta"]["external_id"] == "fireflies:FFMEET1"
            # Verify tasks landed
            tasks = [t async for t in db.tasks.find({"company_id": cid})]
            assert len(tasks) == 2
            titles = {t["title"] for t in tasks}
            assert "Send pricing PDF to Alice" in titles
            assert "Book demo of reporting module" in titles
            # Each task links back to the contact
            for t in tasks:
                assert contact_id in (t.get("contact_ids") or [])
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_disconnect_removes_connection():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch("routes.note_takers.FirefliesProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": True, "user_email": "me@x.com"})):
                client = await _client()
                await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "fireflies", "api_key": "ff_test"},
                )
                r = await client.delete(
                    f"/api/companies/{cid}/note-takers/fireflies",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200
                assert r.json()["deleted"] is True
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())



# ── tl;dv coverage ─────────────────────────────────────────────────

def test_tldv_provider_registered_and_listed():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/note-takers",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            keys = {p["key"] for p in r.json()["providers"]}
            assert "fireflies" in keys
            assert "tldv" in keys
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_tldv_connect_verifies_and_stores():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch("routes.note_takers.TldvProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": True})):
                client = await _client()
                r = await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "tldv", "api_key": "tldv_test"},
                )
                assert r.status_code == 200, r.text
                d = r.json()["connection"]
                assert d["provider"] == "tldv"
                assert "api_key" not in d
                assert d["webhook_url"].startswith("https://")
                assert "notetaker/tldv" in d["webhook_url"]
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_tldv_webhook_normalizes_meeting_and_creates_tasks():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch("routes.note_takers.TldvProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": True})):
                client = await _client()
                await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "tldv", "api_key": "tldv_test"},
                )
            # Mock the two REST enrich calls the parser makes.
            fake_meeting = {
                "id": "TLDV_MEET_1",
                "name": "Discovery w/ Alice",
                "happenedAt": "2026-03-05T15:00:00Z",
                "url": "https://app.tldv.io/meetings/TLDV_MEET_1",
                "invitees": [{"email": "alice@example.com"},
                              {"email": "me@x.com"}],
                "organizer": {"email": "me@x.com"},
            }
            fake_notes = {
                "markdownContent": (
                    "## Summary\nGreat call.\n\n"
                    "## Action items\n"
                    "- [ ] Send SOW to Alice\n"
                    "- [ ] Schedule follow-up next week\n"
                ),
                "topics": [
                    {"title": "Pricing", "summary": "Wants annual discount."},
                ],
            }
            async def _fake_get(self, api_key, path):
                if path.endswith("/notes"):
                    return fake_notes
                return fake_meeting
            with patch("routes.note_takers.TldvProvider._get", new=_fake_get):
                r = await client.post(
                    f"/api/webhooks/notetaker/tldv?company_id={cid}&user_id={uid}",
                    json={"event": "MeetingReady",
                           "data": {"id": "TLDV_MEET_1", "name": "Discovery"}},
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert d["contacts_matched"] == 1
                assert d["activities_logged"] == 1
                assert d["tasks_created"] == 2
                # idempotent replay
                r2 = await client.post(
                    f"/api/webhooks/notetaker/tldv?company_id={cid}&user_id={uid}",
                    json={"event": "MeetingReady",
                           "data": {"id": "TLDV_MEET_1"}},
                )
                d2 = r2.json()
                assert d2["activities_logged"] == 0
                assert d2["tasks_created"] == 0
            # Verify activity content
            c = await db.contacts.find_one({"id": contact_id})
            acts = c.get("activities") or []
            assert len(acts) == 1
            assert acts[0]["meta"]["external_id"] == "tldv:TLDV_MEET_1"
            assert acts[0]["meta"]["provider"] == "tldv"
            # Verify tasks
            titles = {t["title"] async for t in db.tasks.find({"company_id": cid})}
            assert "Send SOW to Alice" in titles
            assert "Schedule follow-up next week" in titles
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_tldv_webhook_ignores_non_ready_events():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch("routes.note_takers.TldvProvider.verify_credentials",
                       new=AsyncMock(return_value={"ok": True})):
                client = await _client()
                await client.post(
                    f"/api/companies/{cid}/note-takers",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"provider": "tldv", "api_key": "tldv_test"},
                )
            r = await client.post(
                f"/api/webhooks/notetaker/tldv?company_id={cid}&user_id={uid}",
                json={"event": "MeetingStarted", "data": {"id": "X"}},
            )
            assert r.status_code == 200
            assert r.json().get("ignored") is True
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())
