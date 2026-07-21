"""AI Ask Client — scheduler + chaining tests.

We exercise the autonomous loop end-to-end without hitting Resend or the
LLM: `send_email` is monkey-patched to a stub, and the AI drafter falls
back to its deterministic template when Claude is unavailable (or we
monkeypatch it directly here).

Coverage:
  1. process_company sends exactly ONE email covering ONE recent txn,
     ignores older txns, and stamps flow_type=ai_ask_client.
  2. Once the daily cap of 3 sends to the same client_email is reached,
     process_company returns status=daily_cap_reached.
  3. `ai_ask_client` pref OFF short-circuits the send.
  4. The /q/{token}/next chaining endpoint returns another pending
     ai_ask_client question for the same client_email and skips the
     current one.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from dotenv import dotenv_values

sys.path.insert(0, "/app/backend")
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso  # noqa: E402
import email_dispatcher  # noqa: E402
import email_service  # noqa: E402
import ai_ask_client_scheduler as sched  # noqa: E402


_LOOP = asyncio.new_event_loop()
def _run(coro): return _LOOP.run_until_complete(coro)


_SENT: list[dict] = []


async def _fake_send_email(**kwargs):
    _SENT.append(kwargs)
    return {"id": f"fake_{uuid.uuid4().hex[:8]}"}


async def _fake_drafter(*, counterparty, txns, company_name=""):
    return f"What was this ${abs(float(txns[0].get('amount') or 0)):.2f} charge from {counterparty} for?"


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    _SENT.clear()
    monkeypatch.setattr(email_service, "send_email", _fake_send_email)
    monkeypatch.setattr(email_dispatcher, "send_email", _fake_send_email)
    import ai_service
    monkeypatch.setattr(ai_service, "draft_ask_client_question", _fake_drafter)


async def _seed_scenario():
    """Create one company, one pro, one client-owner, one fresh flagged
    txn (today) and one stale flagged txn (10 days ago) so we can assert
    that only the fresh one is picked."""
    cid = f"testcid_{uuid.uuid4().hex[:8]}"
    pro_id = f"pro_{uuid.uuid4().hex[:8]}"
    owner_id = f"owner_{uuid.uuid4().hex[:8]}"
    client_email = f"owner_{uuid.uuid4().hex[:6]}@test.co"

    today = datetime.now(timezone.utc).date().isoformat()
    stale = (datetime.now(timezone.utc).date() - timedelta(days=10)).isoformat()

    await db.companies.insert_one({
        "id": cid, "name": "Test Co",
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    await db.users.insert_many([
        {"id": pro_id, "email": f"pro_{pro_id[-6:]}@test.co",
         "full_name": "Pro Person", "role": "pro",
         "created_at": now_iso()},
        {"id": owner_id, "email": client_email,
         "full_name": "Owner", "role": "client",
         "created_at": now_iso()},
    ])
    await db.memberships.insert_many([
        {"id": str(uuid.uuid4()), "user_id": pro_id, "company_id": cid,
         "role": "pro", "created_at": now_iso()},
        {"id": str(uuid.uuid4()), "user_id": owner_id, "company_id": cid,
         "role": "owner", "created_at": now_iso()},
    ])
    # Fresh flagged txn (today).
    fresh_id = f"txn_{uuid.uuid4().hex[:8]}"
    await db.transactions.insert_one({
        "id": fresh_id, "company_id": cid,
        "date": today, "amount": -100.0,
        "description": "MYSTERY VENDOR", "posted": True,
        "needs_review": True,
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    # Stale flagged txn — must be ignored by the scheduler.
    stale_id = f"txn_{uuid.uuid4().hex[:8]}"
    await db.transactions.insert_one({
        "id": stale_id, "company_id": cid,
        "date": stale, "amount": -70.0,
        "description": "OLD VENDOR", "posted": True,
        "needs_review": True,
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return cid, pro_id, owner_id, client_email, fresh_id, stale_id


async def _cleanup(cid: str, pro_id: str, owner_id: str, client_email: str):
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": {"$in": [pro_id, owner_id]}})
    await db.memberships.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.client_questions.delete_many({"company_id": cid})
    await db.communications.delete_many({"$or": [
        {"company_id": cid}, {"to": client_email},
    ]})
    await db.comms_prefs.delete_many({"user_id": pro_id})


def test_process_company_picks_one_fresh_txn_and_logs_flow_type():
    async def _go():
        cid, pro_id, owner_id, client_email, fresh_id, stale_id = await _seed_scenario()
        try:
            summary = await sched.process_company(cid)
            assert summary["status"] == "sent", summary
            assert summary["txn_id"] == fresh_id
            # Exactly one email dispatched.
            assert len(_SENT) == 1
            assert _SENT[0]["to"] == [client_email] or _SENT[0]["to"] == client_email

            # Question stamped with flow_type=ai_ask_client.
            q = await db.client_questions.find_one({"company_id": cid})
            assert q["flow_type"] == "ai_ask_client"
            assert q["txn_ids"] == [fresh_id]

            # The stale txn stays untouched (no client_question_id).
            stale = await db.transactions.find_one({"id": stale_id})
            assert not stale.get("client_question_id")

            # Communications audit log has an ai_ask_client row.
            log = await db.communications.find_one({
                "company_id": cid, "kind": "ai_ask_client",
            })
            assert log and log["status"] == "sent"
        finally:
            await _cleanup(cid, pro_id, owner_id, client_email)
    _run(_go())


def test_daily_cap_short_circuits_after_three_sends():
    async def _go():
        cid, pro_id, owner_id, client_email, fresh_id, stale_id = await _seed_scenario()
        try:
            today = datetime.now(timezone.utc).date().isoformat()
            # Pre-seed 3 sent ai_ask_client audit rows to this client email.
            for _ in range(3):
                await db.communications.insert_one({
                    "id": str(uuid.uuid4()), "kind": "ai_ask_client",
                    "to": client_email, "status": "sent",
                    "sent_at": f"{today}T12:00:00+00:00",
                    "subject": "seed", "user_id": pro_id, "company_id": cid,
                })
            summary = await sched.process_company(cid)
            assert summary["status"] == "daily_cap_reached", summary
            # Nothing sent.
            assert _SENT == []
        finally:
            await _cleanup(cid, pro_id, owner_id, client_email)
    _run(_go())


def test_pref_off_blocks_ai_ask_client():
    async def _go():
        cid, pro_id, owner_id, client_email, fresh_id, stale_id = await _seed_scenario()
        try:
            await email_dispatcher.set_prefs(pro_id, {"ai_ask_client": False})
            summary = await sched.process_company(cid)
            assert summary["status"] == "pref_off"
            assert _SENT == []
        finally:
            await _cleanup(cid, pro_id, owner_id, client_email)
    _run(_go())


def test_chain_next_returns_another_pending_ai_question_for_same_client():
    """Simulates the client finishing one AI question and asking for the
    next one — the /q/{token}/next endpoint must skip the current token
    and return another pending ai_ask_client question with the same
    to_email."""
    from routes.communications import public_next_question

    async def _go():
        cid = f"testcid_{uuid.uuid4().hex[:8]}"
        client_email = f"same_{uuid.uuid4().hex[:6]}@test.co"
        try:
            t1, t2, t3 = (secrets_urlsafe() for _ in range(3))
            await db.client_questions.insert_many([
                # The current one (already answered).
                {"id": t1, "company_id": cid, "to_email": client_email,
                 "flow_type": "ai_ask_client", "status": "answered",
                 "sent_at": "2026-07-20T10:00:00+00:00",
                 "counterparty_label": "Amazon"},
                # Another pending ai_ask_client to same email — should be returned.
                {"id": t2, "company_id": cid, "to_email": client_email,
                 "flow_type": "ai_ask_client", "status": "pending",
                 "sent_at": "2026-07-20T11:00:00+00:00",
                 "counterparty_label": "Costco",
                 "question": "What was Costco?"},
                # A pro-initiated pending — should NOT be returned.
                {"id": t3, "company_id": cid, "to_email": client_email,
                 "flow_type": "pro_ask_client", "status": "pending",
                 "sent_at": "2026-07-20T12:00:00+00:00",
                 "counterparty_label": "Manual"},
            ])
            r = await public_next_question(t1)
            assert r["next"] is not None
            assert r["next"]["token"] == t2
            assert r["next"]["counterparty_label"] == "Costco"

            # After answering t2 as well, chaining should end (no more ai).
            await db.client_questions.update_one(
                {"id": t2}, {"$set": {"status": "answered"}},
            )
            r2 = await public_next_question(t2)
            assert r2["next"] is None
        finally:
            await db.client_questions.delete_many({"company_id": cid})
    _run(_go())


def secrets_urlsafe():
    import secrets
    return secrets.token_urlsafe(16)
