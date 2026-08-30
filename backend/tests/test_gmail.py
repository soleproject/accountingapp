"""Gmail — OAuth + inbox routes (Feb 2026)."""
from __future__ import annotations
import sys, uuid, os
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
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"gmail_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client", "name": "Gmail Tester",
    })
    return uid, create_token(uid, "client")


async def _cleanup(uid):
    await db.users.delete_one({"id": uid})
    await db.gmail_tokens.delete_many({"user_id": uid})
    await db.gmail_oauth_states.delete_many({"user_id": uid})


# ── status: not connected ────────────────────────────────────────────
def test_status_returns_disconnected_when_no_token():
    async def _t():
        uid, tok = await _mk_env()
        try:
            client = await _client()
            r = await client.get("/api/gmail/status",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            data = r.json()
            assert data["connected"] is False
            assert data["email"] is None
        finally:
            await _cleanup(uid)
    _run(_t())


# ── status: connected ────────────────────────────────────────────────
def test_status_returns_connected_when_token_exists():
    async def _t():
        uid, tok = await _mk_env()
        await db.gmail_tokens.insert_one({
            "user_id": uid,
            "email": "user@gmail.com",
            "access_token": "at",
            "refresh_token": "rt",
            "expires_at": datetime.now(timezone.utc).isoformat(),
            "scopes": [],
        })
        try:
            client = await _client()
            r = await client.get("/api/gmail/status",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            d = r.json()
            assert d["connected"] is True
            assert d["email"] == "user@gmail.com"
        finally:
            await _cleanup(uid)
    _run(_t())


# ── disconnect wipes tokens ──────────────────────────────────────────
def test_disconnect_wipes_tokens():
    async def _t():
        uid, tok = await _mk_env()
        await db.gmail_tokens.insert_one({
            "user_id": uid, "email": "u@gmail.com",
            "access_token": "at", "refresh_token": "rt",
            "expires_at": datetime.now(timezone.utc).isoformat(),
        })
        try:
            client = await _client()
            r = await client.post("/api/gmail/disconnect",
                                    headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            assert r.json()["ok"] is True
            n = await db.gmail_tokens.count_documents({"user_id": uid})
            assert n == 0
        finally:
            await _cleanup(uid)
    _run(_t())


# ── protected route rejects unauthed ─────────────────────────────────
def test_status_requires_auth():
    async def _t():
        client = await _client()
        r = await client.get("/api/gmail/status")
        assert r.status_code in (401, 403)
    _run(_t())


# ── list threads: 401 when disconnected ──────────────────────────────
def test_list_threads_requires_connection():
    async def _t():
        uid, tok = await _mk_env()
        try:
            client = await _client()
            r = await client.get("/api/gmail/threads",
                                  headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 401
            assert "connect" in r.json().get("detail", "").lower()
        finally:
            await _cleanup(uid)
    _run(_t())


# ── oauth_start requires configured creds ────────────────────────────
def test_oauth_start_returns_auth_url():
    async def _t():
        uid, tok = await _mk_env()
        try:
            client = await _client()
            r = await client.get("/api/oauth/gmail/start?return_to=/crm/email",
                                  headers={"Authorization": f"Bearer {tok}",
                                            "Host": "aifinance-hub-6.preview.emergentagent.com"})
            # Only assert 200 shape if OAuth creds are configured (they should be)
            if os.environ.get("GOOGLE_CLIENT_ID"):
                assert r.status_code == 200
                d = r.json()
                assert d["auth_url"].startswith("https://accounts.google.com/")
                assert d["state"]
                # State was persisted
                got = await db.gmail_oauth_states.find_one({"state": d["state"]})
                assert got is not None
                assert got["user_id"] == uid
        finally:
            await db.gmail_oauth_states.delete_many({"user_id": uid})
            await _cleanup(uid)
    _run(_t())


# ── oauth_callback with missing state redirects with error ───────────
def test_oauth_callback_missing_state_redirects_error():
    async def _t():
        client = await _client()
        r = await client.get(
            "/api/oauth/gmail/callback?code=abc&state=doesnotexist",
            follow_redirects=False,
        )
        assert r.status_code == 302
        assert "gmail_error=state_expired" in r.headers.get("location", "")
    _run(_t())


# ── send email requires connection ───────────────────────────────────
def test_send_email_requires_connection():
    async def _t():
        uid, tok = await _mk_env()
        try:
            client = await _client()
            r = await client.post(
                "/api/gmail/send",
                headers={"Authorization": f"Bearer {tok}"},
                data={"to": "someone@example.com", "subject": "hi", "body_text": "hey"},
            )
            assert r.status_code == 401
        finally:
            await _cleanup(uid)
    _run(_t())


# ── list threads: mock Gmail API and validate response shape ─────────
def test_list_threads_returns_parsed_shape_with_mock():
    async def _t():
        uid, tok = await _mk_env()
        # Seed token far in the future so no refresh happens
        await db.gmail_tokens.insert_one({
            "user_id": uid, "email": "u@gmail.com",
            "access_token": "at", "refresh_token": "rt",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "scopes": [],
        })
        try:
            # Mock googleapiclient chain
            mock_service = MagicMock()
            list_call = MagicMock()
            list_call.execute.return_value = {
                "threads": [{"id": "T1"}],
                "nextPageToken": None,
                "resultSizeEstimate": 1,
            }
            get_call = MagicMock()
            get_call.execute.return_value = {
                "id": "T1", "historyId": "1", "snippet": "hi there",
                "messages": [{
                    "id": "M1", "labelIds": ["INBOX", "UNREAD"],
                    "payload": {"headers": [
                        {"name": "From", "value": "Alice <alice@example.com>"},
                        {"name": "Subject", "value": "Hello"},
                        {"name": "Date", "value": "Fri, 3 Jan 2026 10:00:00 +0000"},
                    ]}
                }],
            }
            mock_service.users().threads().list.return_value = list_call
            mock_service.users().threads().get.return_value = get_call

            with patch("routes.gmail._gmail_service", return_value=mock_service):
                client = await _client()
                r = await client.get(
                    "/api/gmail/threads?label=INBOX&max_results=10",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert len(d["threads"]) == 1
                t = d["threads"][0]
                assert t["id"] == "T1"
                assert t["unread"] is True
                assert t["from"].startswith("Alice")
                assert t["subject"] == "Hello"
                assert "INBOX" in t["label_ids"]
        finally:
            await _cleanup(uid)
    _run(_t())
