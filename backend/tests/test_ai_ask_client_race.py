"""Race test: N concurrent process_company() calls for the same company
must produce exactly ONE Quick one (one client_questions row, one
dispatch) — the atomic txn claim must stop the others."""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from unittest.mock import patch


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import ai_ask_client_scheduler as sched  # noqa: E402
from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


def test_concurrent_runners_send_once():
    _run(_concurrent_runners_send_once())


def test_sweep_lock_single_holder():
    _run(_sweep_lock_single_holder())


async def _concurrent_runners_send_once():
    cid = f"race-co-{uuid.uuid4().hex[:8]}"
    pro_id = f"race-pro-{uuid.uuid4().hex[:8]}"
    txn_id = f"race-txn-{uuid.uuid4().hex[:8]}"
    await db.companies.insert_one({"id": cid, "name": "Race Co", "pro_user_id": pro_id})
    await db.users.insert_one({"id": pro_id, "email": f"{pro_id}@race.test", "role": "pro", "full_name": "Race Pro"})
    await db.memberships.insert_one({"user_id": pro_id, "company_id": cid, "role": "pro"})
    await db.transactions.insert_one({
        "id": txn_id, "company_id": cid, "date": datetime.now(timezone.utc).date().isoformat(), "amount": -100.0,
        "description": "Zelle Transfer CONF# RACE; PHOENIX BUSINESS", "category_id": None,
        "client_question_id": None, "needs_review": True,
    })
    sent = []

    async def fake_dispatch(**kw):
        await asyncio.sleep(0.01)
        sent.append(kw)
        return {"status": "sent", "id": uuid.uuid4().hex}

    async def fake_draft(txn, company_name=""):
        await asyncio.sleep(0.05)  # yield so runners interleave like a real LLM call
        return f"Draft {uuid.uuid4().hex[:4]}"

    async def fake_email(cid_):
        return (f"client-{cid}@race.test", "Client")

    try:
        with patch.object(sched, "dispatch", fake_dispatch), \
             patch.object(sched, "_draft_question", fake_draft), \
             patch.object(sched, "_resolve_client_email", fake_email), \
             patch.object(sched, "get_prefs", lambda uid: asyncio.sleep(0, result={sched.KIND: True})):
            results = await asyncio.gather(*[sched.process_company(cid) for _ in range(3)])
        statuses = sorted(r["status"] for r in results)
        assert statuses.count("sent") == 1, statuses
        assert len(sent) == 1
        qs = await db.client_questions.count_documents({"company_id": cid})
        assert qs == 1
        tx = await db.transactions.find_one({"id": txn_id})
        assert tx["client_question_id"]
        # Second pass after the send: nothing left to ask.
        with patch.object(sched, "dispatch", fake_dispatch), \
             patch.object(sched, "_draft_question", fake_draft), \
             patch.object(sched, "_resolve_client_email", fake_email), \
             patch.object(sched, "get_prefs", lambda uid: asyncio.sleep(0, result={sched.KIND: True})):
            again = await sched.process_company(cid)
        assert again["status"] != "sent"
    finally:
        await db.companies.delete_one({"id": cid})
        await db.users.delete_one({"id": pro_id})
        await db.memberships.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        await db.client_questions.delete_many({"company_id": cid})


async def _sweep_lock_single_holder():
    name = f"test-lock-{uuid.uuid4().hex[:6]}"
    try:
        assert await sched.acquire_sweep_lock(name) is True
        assert await sched.acquire_sweep_lock(name) is False
        await sched.release_sweep_lock(name)
        assert await sched.acquire_sweep_lock(name) is True
    finally:
        await db.scheduler_locks.delete_one({"_id": name})
