"""Communications hub — dispatcher, prefs, ask-client magic-link.

Focus of these tests: prove the invariants a pro should be able to bet on
without actually calling Resend (we monkey-patch `send_email`).

Covered:
  1. Prefs default to all-on for a brand-new user.
  2. Setting `ask_client: false` blocks the send and audits it as
     `skipped_pref_off` (no Resend call).
  3. A successful ask-client attaches the question to the transaction and
     mints a valid magic-link token.
  4. The public magic-link answer endpoint pushes the answer back onto the
     transaction and marks the question `answered`.
  5. A second answer attempt on an already-answered question fails cleanly.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

import pytest
from dotenv import dotenv_values

sys.path.insert(0, "/app/backend")
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso  # noqa: E402
import email_dispatcher  # noqa: E402
import email_service  # noqa: E402


_LOOP = asyncio.new_event_loop()
def _run(coro): return _LOOP.run_until_complete(coro)


# --------------------------------------------------------------------------- #
# Monkey-patch send_email so tests never hit the real Resend API.
# --------------------------------------------------------------------------- #
_SENT: list[dict] = []


async def _fake_send_email(**kwargs):
    _SENT.append(kwargs)
    return {"id": f"fake_{uuid.uuid4().hex[:8]}"}


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    _SENT.clear()
    monkeypatch.setattr(email_service, "send_email", _fake_send_email)
    monkeypatch.setattr(email_dispatcher, "send_email", _fake_send_email)


# --------------------------------------------------------------------------- #
def test_defaults_all_on_for_new_user():
    async def _go():
        uid = f"testuser_{uuid.uuid4().hex[:8]}"
        try:
            prefs = await email_dispatcher.get_prefs(uid)
            for kind in email_dispatcher.DEFAULT_PREFS:
                assert prefs[kind] is True, kind
        finally:
            await db.comms_prefs.delete_many({"user_id": uid})
    _run(_go())


def test_pref_off_blocks_dispatch_and_audits_skipped():
    async def _go():
        uid = f"testuser_{uuid.uuid4().hex[:8]}"
        try:
            await email_dispatcher.set_prefs(uid, {"ask_client": False})
            res = await email_dispatcher.dispatch(
                kind="ask_client",
                to="michael@bigsaas.ai",
                subject="Test", html="<p>x</p>",
                initiating_user_id=uid,
            )
            assert res["status"] == "skipped_pref_off", res
            assert _SENT == [], "Resend must NOT be called when pref is off"
            log = await db.communications.find_one({"id": res["id"]})
            assert log["status"] == "skipped_pref_off"
            assert log["kind"] == "ask_client"
        finally:
            await db.comms_prefs.delete_many({"user_id": uid})
            await db.communications.delete_many({"user_id": uid})
    _run(_go())


def test_dispatch_sent_status_is_audited_with_resend_id():
    async def _go():
        uid = f"testuser_{uuid.uuid4().hex[:8]}"
        try:
            res = await email_dispatcher.dispatch(
                kind="daily_pro_digest",
                to="test@example.com",
                subject="Digest test", html="<p>x</p>",
                initiating_user_id=uid,
            )
            assert res["status"] == "sent"
            assert _SENT and _SENT[0]["to"] == "test@example.com"
            log = await db.communications.find_one({"id": res["id"]})
            assert log["status"] == "sent"
            assert log["resend_id"] and log["resend_id"].startswith("fake_")
        finally:
            await db.comms_prefs.delete_many({"user_id": uid})
            await db.communications.delete_many({"user_id": uid})
    _run(_go())


def test_ask_client_flow_end_to_end():
    """Simulates the ask-client → magic-link → answer round-trip without
    going through HTTP, exercising the route helpers directly."""
    from routes.communications import (
        AskClientIn, ask_client_about_txn, AnswerIn, public_answer_question,
        public_get_question,
    )

    async def _go():
        cid = f"testcid_{uuid.uuid4().hex[:8]}"
        uid = f"testpro_{uuid.uuid4().hex[:8]}"
        tid = f"testtxn_{uuid.uuid4().hex[:8]}"
        try:
            await db.companies.insert_one({
                "id": cid, "name": "Test Co", "contact_email": "owner@test.co",
                "contact_name": "Owner Person",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "date": "2026-07-20", "amount": -100.0,
                "description": "Test charge", "posted": True,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            user = {"id": uid, "email": "pro@test.co", "full_name": "Pro Person",
                    "role": "pro"}

            res = await ask_client_about_txn(
                cid, tid,
                AskClientIn(txn_id=tid, question="Test question?"),
                user=user,
            )
            assert res["status"] == "sent"
            token = res["question_id"]

            # Public endpoint returns the question payload for the client.
            payload = await public_get_question(token)
            assert payload["status"] == "pending"
            assert payload["question"] == "Test question?"
            assert payload["txn"]["amount"] == -100.0

            # Client submits an answer.
            done = await public_answer_question(token, AnswerIn(answer="Office supplies."))
            assert done["status"] == "answered"

            # Transaction now carries the answer + ai_comment audit trail.
            t = await db.transactions.find_one({"id": tid})
            assert t["client_answer"] == "Office supplies."
            assert t["client_answered_at"]
            assert "[Client answered" in t["ai_comment"]

            # Second answer must fail cleanly (already-answered).
            with pytest.raises(Exception) as ei:
                await public_answer_question(token, AnswerIn(answer="Second try."))
            assert "already been answered" in str(ei.value)
        finally:
            await db.companies.delete_many({"id": cid})
            await db.transactions.delete_many({"company_id": cid})
            await db.client_questions.delete_many({"company_id": cid})
            await db.communications.delete_many({"company_id": cid})
    _run(_go())
