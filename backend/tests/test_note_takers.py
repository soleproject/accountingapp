"""AI note-taker integrations — Fireflies reference (Feb 2026)."""
from __future__ import annotations
import sys, uuid, base64, hmac, hashlib
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
    await db.readai_oauth_states.delete_many({"user_id": uid})
    await db.readai_oauth_clients.delete_many({"partner_id": None})
    await db.grain_oauth_states.delete_many({"user_id": uid})


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



# ── Read.ai (OAuth) coverage ───────────────────────────────────────

def test_readai_listed_as_oauth():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/note-takers",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200
            provs = {p["key"]: p for p in r.json()["providers"]}
            assert provs["readai"]["auth_type"] == "oauth"
            assert provs["fireflies"]["auth_type"] == "api_key"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_api_key_connect_rejected():
    """OAuth providers must not accept the /note-takers POST — it's
    api_key only. This guards against a client leaking secrets."""
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            client = await _client()
            r = await client.post(
                f"/api/companies/{cid}/note-takers",
                headers={"Authorization": f"Bearer {tok}"},
                json={"provider": "readai", "api_key": "shouldnotwork"},
            )
            assert r.status_code == 400
            assert "OAuth" in r.text or "oauth" in r.text
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_oauth_start_returns_branded_auth_url():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            # Mock dynamic client registration
            with patch("routes.note_takers._get_or_create_readai_client",
                       new=AsyncMock(return_value=("client_abc", "secret_xyz"))):
                client = await _client()
                r = await client.get(
                    f"/api/oauth/readai/start?company_id={cid}",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert "auth_url" in d and "state" in d
                assert d["auth_url"].startswith("https://authn.read.ai/oauth2/auth?")
                assert "client_id=client_abc" in d["auth_url"]
                assert f"state={d['state']}" in d["auth_url"]
                assert "meeting%3Aread" in d["auth_url"]
                # PKCE: code_challenge + S256 are present
                assert "code_challenge=" in d["auth_url"]
                assert "code_challenge_method=S256" in d["auth_url"]
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_oauth_callback_persists_tokens_and_redirects():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            # Seed a fake state row like /start would
            state = "stt_" + uuid.uuid4().hex
            from datetime import datetime, timezone
            await db.readai_oauth_states.insert_one({
                "state": state, "user_id": uid, "company_id": cid,
                "partner_id": None,
                "redirect_uri": "https://test/api/oauth/readai/callback",
                "return_to": "/crm/settings?readai=connected",
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            fake_tokens = {
                "access_token":  "ra_access_1",
                "refresh_token": "ra_refresh_1",
                "expires_at":    "2099-01-01T00:00:00+00:00",
                "user_email":    "jane@acme.com",
                "user_name":     "Jane",
            }
            with patch("routes.note_takers.ReadAiProvider.oauth_exchange_code",
                       new=AsyncMock(return_value=fake_tokens)):
                client = await _client()
                r = await client.get(
                    f"/api/oauth/readai/callback?state={state}&code=abc",
                    follow_redirects=False,
                )
                assert r.status_code == 302, r.text
                assert "/crm/settings?readai=connected" in r.headers["location"]
            # Connection persisted
            conn = await db.note_taker_connections.find_one(
                {"provider": "readai", "user_id": uid, "company_id": cid}
            )
            assert conn is not None
            assert conn["access_token"] == "ra_access_1"
            assert conn["refresh_token"] == "ra_refresh_1"
            assert conn["auth_type"] == "oauth"
            assert conn["user_email"] == "jane@acme.com"
            # State row consumed
            leftover = await db.readai_oauth_states.find_one({"state": state})
            assert leftover is None
            # List endpoint scrubs the secrets
            r2 = await client.get(
                f"/api/companies/{cid}/note-takers",
                headers={"Authorization": f"Bearer {tok}"},
            )
            connections = r2.json()["connections"]
            ra = next(c for c in connections if c["provider"] == "readai")
            assert "access_token" not in ra
            assert "refresh_token" not in ra
            assert ra["pending_webhook"] is True
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_webhook_normalizes_meeting_end_payload():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            # Seed a Read.ai OAuth connection directly (skip real OAuth)
            await db.note_taker_connections.insert_one({
                "id": str(uuid.uuid4()),
                "provider": "readai", "auth_type": "oauth",
                "company_id": cid, "user_id": uid, "partner_id": None,
                "access_token": "ra_a", "refresh_token": "ra_r",
                "expires_at": "2099-01-01T00:00:00+00:00",
                "user_email": "me@example.com",
                "created_at": "2026-02-28T00:00:00Z",
                "updated_at": "2026-02-28T00:00:00Z",
                "meetings_ingested": 0,
            })
            payload = {
                "trigger": "meeting_end",
                "session_id": "RSESS_1",
                "session": {
                    "id": "RSESS_1",
                    "title": "Renewal call w/ Alice",
                    "start_time": "2026-03-10T14:00:00Z",
                    "end_time":   "2026-03-10T14:45:00Z",
                    "participants": [{"email": "alice@example.com"},
                                      {"email": "me@example.com"}],
                    "summary": {
                        "summary": "Discussed renewal; Alice wants quarterly billing.",
                        "action_items": [
                            {"text": "Send quarterly billing quote to Alice"},
                            {"text": "Schedule renewal signing call"},
                        ],
                    },
                    "report_url": "https://app.read.ai/meetings/RSESS_1",
                },
            }
            client = await _client()
            r = await client.post(
                f"/api/webhooks/notetaker/readai?company_id={cid}&user_id={uid}",
                json=payload,
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["contacts_matched"] == 1
            assert d["activities_logged"] == 1
            assert d["tasks_created"] == 2
            # Idempotent replay
            r2 = await client.post(
                f"/api/webhooks/notetaker/readai?company_id={cid}&user_id={uid}",
                json=payload,
            )
            d2 = r2.json()
            assert d2["activities_logged"] == 0 and d2["tasks_created"] == 0

            c = await db.contacts.find_one({"id": contact_id})
            act = (c.get("activities") or [])[0]
            assert act["meta"]["provider"] == "readai"
            assert act["meta"]["external_id"] == "readai:RSESS_1"
            titles = {t["title"] async for t in db.tasks.find({"company_id": cid})}
            assert "Send quarterly billing quote to Alice" in titles
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_webhook_signature_verification_rejects_bad_sig():
    """When signing_key is set, mismatched X-Read-Signature → 401."""
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            await db.note_taker_connections.insert_one({
                "id": str(uuid.uuid4()),
                "provider": "readai", "auth_type": "oauth",
                "company_id": cid, "user_id": uid, "partner_id": None,
                "access_token": "ra_a", "refresh_token": "ra_r",
                "expires_at": "2099-01-01T00:00:00+00:00",
                "signing_key": "c2VjcmV0X2tleQ==",   # base64("secret_key")
                "created_at": "2026-02-28T00:00:00Z",
                "updated_at": "2026-02-28T00:00:00Z",
                "meetings_ingested": 0,
            })
            client = await _client()
            r = await client.post(
                f"/api/webhooks/notetaker/readai?company_id={cid}&user_id={uid}",
                json={"trigger": "meeting_end", "session_id": "X"},
                headers={"X-Read-Signature": "sha256=deadbeef"},
            )
            assert r.status_code == 401
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_webhook_signature_verification_accepts_good_sig():
    async def _t():
        import json as _json
        uid, cid, contact_id, tok = await _env()
        try:
            key_b64 = base64.b64encode(b"secret_key").decode()
            await db.note_taker_connections.insert_one({
                "id": str(uuid.uuid4()),
                "provider": "readai", "auth_type": "oauth",
                "company_id": cid, "user_id": uid, "partner_id": None,
                "access_token": "ra_a", "refresh_token": "ra_r",
                "expires_at": "2099-01-01T00:00:00+00:00",
                "signing_key": key_b64,
                "created_at": "2026-02-28T00:00:00Z",
                "updated_at": "2026-02-28T00:00:00Z",
                "meetings_ingested": 0,
            })
            body = {
                "trigger": "meeting_end",
                "session": {
                    "id": "RSESS_SIG",
                    "title": "Signed call",
                    "participants": [{"email": "alice@example.com"}],
                    "summary": {"summary": "ok", "action_items": []},
                },
            }
            raw = _json.dumps(body).encode()
            sig = hmac.new(b"secret_key", raw, hashlib.sha256).hexdigest()
            client = await _client()
            r = await client.post(
                f"/api/webhooks/notetaker/readai?company_id={cid}&user_id={uid}",
                content=raw,
                headers={
                    "Content-Type": "application/json",
                    "X-Read-Signature": f"sha256={sig}",
                },
            )
            assert r.status_code == 200, r.text
            assert r.json()["contacts_matched"] == 1
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_readai_partner_branding_uses_partner_firm_name():
    """Dynamic client registration should use the partner's firm_name
    as `client_name` on Read.ai (so end users see partner brand)."""
    async def _t():
        uid, cid, contact_id, tok = await _env()
        partner_id = "partner_" + uuid.uuid4().hex[:8]
        try:
            await db.users.insert_one({
                "id": partner_id, "email": f"{partner_id}@x.com",
                "role": "partner", "name": "Bob",
                "password": "x",
                "branding": {"firm_name": "AcmeBooks WL", "primary_color": "#000"},
            })
            await db.companies.update_one({"id": cid},
                                            {"$set": {"partner_id": partner_id}})
            captured = {}
            async def _fake_post(*args, **kwargs):
                captured["payload"] = kwargs.get("json") or {}
                class _R:
                    status_code = 200
                    def raise_for_status(self): pass
                    def json(self):
                        return {"client_id": "ci_1", "client_secret": "cs_1"}
                return _R()
            with patch("httpx.AsyncClient.post", new=_fake_post):
                client = await _client()
                r = await client.get(
                    f"/api/oauth/readai/start?company_id={cid}",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
            assert captured["payload"]["client_name"] == "AcmeBooks WL"
            # Cached per-partner
            cached = await db.readai_oauth_clients.find_one({"partner_id": partner_id})
            assert cached and cached["client_id"] == "ci_1"
        finally:
            await db.users.delete_one({"id": partner_id})
            await db.readai_oauth_clients.delete_many({"partner_id": partner_id})
            await _cleanup(uid, cid, contact_id)
    _run(_t())


# ── Grain (OAuth + auto-webhook) coverage ─────────────────────────

def test_grain_listed_as_oauth():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            client = await _client()
            r = await client.get(
                f"/api/companies/{cid}/note-takers",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200
            provs = {p["key"]: p for p in r.json()["providers"]}
            assert provs["grain"]["auth_type"] == "oauth"
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_grain_start_requires_env_credentials():
    """Grain uses static app creds (no dynamic client registration).
    If GRAIN_CLIENT_ID is unset, /start must 500 with a clear message."""
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            with patch.dict("os.environ", {}, clear=False):
                # Ensure env is unset
                import os
                os.environ.pop("GRAIN_CLIENT_ID", None)
                os.environ.pop("GRAIN_CLIENT_SECRET", None)
                client = await _client()
                r = await client.get(
                    f"/api/oauth/grain/start?company_id={cid}",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 500
                assert "GRAIN_CLIENT_ID" in r.text
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_grain_start_returns_pkce_auth_url_when_configured():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            import os
            os.environ["GRAIN_CLIENT_ID"] = "grain_cid_1"
            os.environ["GRAIN_CLIENT_SECRET"] = "grain_secret_1"
            try:
                client = await _client()
                r = await client.get(
                    f"/api/oauth/grain/start?company_id={cid}",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert d["auth_url"].startswith("https://grain.com/_/public-api/oauth2/authorize?")
                assert "client_id=grain_cid_1" in d["auth_url"]
                assert "code_challenge=" in d["auth_url"]
                assert "code_challenge_method=S256" in d["auth_url"]
                assert "scope=recordings.read" in d["auth_url"]
            finally:
                os.environ.pop("GRAIN_CLIENT_ID", None)
                os.environ.pop("GRAIN_CLIENT_SECRET", None)
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_grain_callback_auto_registers_webhook_on_grain():
    """After OAuth callback we must call Grain's hook-create endpoint
    with the user's access_token and include ai_action_items/summary/participants."""
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            import os
            os.environ["GRAIN_CLIENT_ID"] = "grain_cid_1"
            os.environ["GRAIN_CLIENT_SECRET"] = "grain_secret_1"
            state = "gs_" + uuid.uuid4().hex
            from datetime import datetime, timezone
            await db.grain_oauth_states.insert_one({
                "state": state, "user_id": uid, "company_id": cid,
                "partner_id": None,
                "redirect_uri": "https://test/api/oauth/grain/callback",
                "return_to": "/crm/settings?grain=connected",
                "code_verifier": "verifier_xyz",
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            captured = {}
            async def _fake_exchange(self, **kwargs):
                captured["exchange"] = kwargs
                return {
                    "access_token": "gr_a", "refresh_token": "gr_r",
                    "expires_at": "2099-01-01T00:00:00+00:00",
                    "user_email": "bob@acme.com", "user_name": "Bob",
                    "partner_id": None,
                }
            async def _fake_on_connected(self, *, connection, webhook_url):
                captured["hook_call"] = {
                    "access_token": connection.get("access_token"),
                    "webhook_url": webhook_url,
                }
                return {"hook_id": "grain_hook_1"}
            with patch("routes.note_takers.GrainProvider.oauth_exchange_code",
                       new=_fake_exchange), \
                 patch("routes.note_takers.GrainProvider.on_connected",
                       new=_fake_on_connected):
                client = await _client()
                r = await client.get(
                    f"/api/oauth/grain/callback?state={state}&code=abc",
                    follow_redirects=False,
                )
                assert r.status_code == 302, r.text
                assert "/crm/settings?grain=connected" in r.headers["location"]
            # PKCE verifier was forwarded
            assert captured["exchange"]["code_verifier"] == "verifier_xyz"
            # Auto webhook registered with our access token
            assert captured["hook_call"]["access_token"] == "gr_a"
            assert "webhooks/notetaker/grain" in captured["hook_call"]["webhook_url"]
            # Connection saved with hook_id (for later cleanup)
            conn = await db.note_taker_connections.find_one(
                {"provider": "grain", "user_id": uid, "company_id": cid}
            )
            assert conn is not None
            assert conn["hook_id"] == "grain_hook_1"
            assert conn["access_token"] == "gr_a"
        finally:
            import os
            os.environ.pop("GRAIN_CLIENT_ID", None)
            os.environ.pop("GRAIN_CLIENT_SECRET", None)
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_grain_webhook_normalizes_recording_added_payload():
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            await db.note_taker_connections.insert_one({
                "id": str(uuid.uuid4()),
                "provider": "grain", "auth_type": "oauth",
                "company_id": cid, "user_id": uid, "partner_id": None,
                "access_token": "gr_a", "refresh_token": "gr_r",
                "hook_id": "grain_hook_1",
                "expires_at": "2099-01-01T00:00:00+00:00",
                "user_email": "me@example.com",
                "created_at": "2026-02-28T00:00:00Z",
                "updated_at": "2026-02-28T00:00:00Z",
                "meetings_ingested": 0,
            })
            payload = {
                "hook_type": "recording_added",
                "recording": {
                    "id": "GR_REC_1",
                    "title": "Weekly sync w/ Alice",
                    "start_datetime": "2026-03-11T09:00:00Z",
                    "end_datetime":   "2026-03-11T09:30:00Z",
                    "url": "https://grain.com/app/recordings/GR_REC_1",
                    "participants": [{"email": "alice@example.com"},
                                      {"email": "me@example.com"}],
                    "ai_summary": {"text": "Weekly update; renewal pending."},
                    "ai_action_items": [
                        {"text": "Send renewal quote"},
                        {"text": "Book stakeholder review"},
                    ],
                },
            }
            client = await _client()
            r = await client.post(
                f"/api/webhooks/notetaker/grain?company_id={cid}&user_id={uid}",
                json=payload,
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["contacts_matched"] == 1
            assert d["activities_logged"] == 1
            assert d["tasks_created"] == 2
            # Idempotent replay
            r2 = await client.post(
                f"/api/webhooks/notetaker/grain?company_id={cid}&user_id={uid}",
                json=payload,
            )
            d2 = r2.json()
            assert d2["activities_logged"] == 0 and d2["tasks_created"] == 0
            # Meta correct
            c = await db.contacts.find_one({"id": contact_id})
            act = (c.get("activities") or [])[0]
            assert act["meta"]["provider"] == "grain"
            assert act["meta"]["external_id"] == "grain:GR_REC_1"
            titles = {t["title"] async for t in db.tasks.find({"company_id": cid})}
            assert "Send renewal quote" in titles
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())


def test_grain_disconnect_deletes_hook_on_grain():
    """When user disconnects, we should DELETE the Grain-side hook
    so their Grain account isn't left with a dead subscription."""
    async def _t():
        uid, cid, contact_id, tok = await _env()
        try:
            await db.note_taker_connections.insert_one({
                "id": str(uuid.uuid4()),
                "provider": "grain", "auth_type": "oauth",
                "company_id": cid, "user_id": uid,
                "access_token": "gr_a", "refresh_token": "gr_r",
                "hook_id": "grain_hook_1",
                "expires_at": "2099-01-01T00:00:00+00:00",
                "created_at": "2026-02-28T00:00:00Z",
                "updated_at": "2026-02-28T00:00:00Z",
                "meetings_ingested": 0,
            })
            deleted_hooks = []
            async def _fake_on_disconnect(self, connection):
                deleted_hooks.append(connection.get("hook_id"))
            with patch("routes.note_takers.GrainProvider.on_disconnect",
                       new=_fake_on_disconnect):
                client = await _client()
                r = await client.delete(
                    f"/api/companies/{cid}/note-takers/grain",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200
                assert r.json()["deleted"] is True
            assert deleted_hooks == ["grain_hook_1"]
            # Row gone
            gone = await db.note_taker_connections.find_one(
                {"provider": "grain", "user_id": uid}
            )
            assert gone is None
        finally:
            await _cleanup(uid, cid, contact_id)
    _run(_t())

