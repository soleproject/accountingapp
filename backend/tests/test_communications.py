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


def test_ask_client_batch_answer_applies_to_all_txns():
    """One batched question / one answer → all txns in the batch get the
    same `client_answer` and their own ai_comment audit entry."""
    from routes.communications import (
        AskClientBatchIn, ask_client_batch, AnswerIn, public_answer_question,
        public_get_question,
    )

    async def _go():
        cid = f"testcid_{uuid.uuid4().hex[:8]}"
        uid = f"testpro_{uuid.uuid4().hex[:8]}"
        tids = [f"testtxn_{uuid.uuid4().hex[:8]}" for _ in range(3)]
        try:
            await db.companies.insert_one({
                "id": cid, "name": "Test Co", "contact_email": "owner@test.co",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            for tid in tids:
                await db.transactions.insert_one({
                    "id": tid, "company_id": cid,
                    "date": "2026-07-20", "amount": -25.0,
                    "description": "Amazon charge", "posted": True,
                    "created_at": now_iso(), "updated_at": now_iso(),
                })
            user = {"id": uid, "email": "pro@test.co", "full_name": "Pro",
                    "role": "pro"}
            res = await ask_client_batch(
                cid,
                AskClientBatchIn(
                    txn_ids=tids,
                    question="What were these 3 Amazon charges for?",
                    counterparty_label="Amazon",
                ),
                user=user,
            )
            assert res["status"] == "sent"
            assert res["txn_count"] == 3
            token = res["question_id"]

            # Magic-link payload includes all 3 txns.
            payload = await public_get_question(token)
            assert payload["batched"] is True
            assert len(payload["txns"]) == 3

            # Client answers ONCE.
            done = await public_answer_question(
                token, AnswerIn(answer="Books for the office."),
            )
            assert done["txn_count"] == 3

            # Every txn in the batch now carries the same answer.
            for tid in tids:
                t = await db.transactions.find_one({"id": tid})
                assert t["client_answer"] == "Books for the office."
                assert "[Client answered" in t["ai_comment"]
                assert t["client_question_id"] == token
        finally:
            await db.companies.delete_many({"id": cid})
            await db.transactions.delete_many({"company_id": cid})
            await db.client_questions.delete_many({"company_id": cid})
            await db.communications.delete_many({"company_id": cid})
    _run(_go())


def test_suggest_batches_groups_by_counterparty_and_dedupes_asked():
    """The suggest endpoint clusters flagged txns by contact/merchant and
    excludes any txn already covered by a pending client_question."""
    from routes.communications import SuggestBatchIn, suggest_ask_client_batches

    async def _go():
        cid = f"testcid_{uuid.uuid4().hex[:8]}"
        uid = f"testpro_{uuid.uuid4().hex[:8]}"
        try:
            await db.companies.insert_one({
                "id": cid, "name": "Test Co",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            # 3 flagged Amazon txns + 2 flagged Costco + 1 already-asked
            already_asked_id = f"testtxn_{uuid.uuid4().hex[:8]}"
            for i in range(3):
                await db.transactions.insert_one({
                    "id": f"testtxn_{uuid.uuid4().hex[:8]}", "company_id": cid,
                    "date": f"2026-07-{i+1:02d}", "amount": -20.0 - i,
                    "description": "AMAZON MKTP", "contact_name": "Amazon",
                    "needs_review": True, "posted": True,
                    "created_at": now_iso(), "updated_at": now_iso(),
                })
            for i in range(2):
                await db.transactions.insert_one({
                    "id": f"testtxn_{uuid.uuid4().hex[:8]}", "company_id": cid,
                    "date": f"2026-07-{i+10:02d}", "amount": -412.55,
                    "description": "COSTCO", "contact_name": "Costco",
                    "needs_review": True, "posted": True,
                    "created_at": now_iso(), "updated_at": now_iso(),
                })
            # One already-asked txn that must NOT reappear in suggestions.
            await db.transactions.insert_one({
                "id": already_asked_id, "company_id": cid,
                "date": "2026-07-20", "amount": -50.0,
                "description": "AMAZON MKTP", "contact_name": "Amazon",
                "needs_review": True, "posted": True,
                "client_question_id": "some_existing_token",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            await db.client_questions.insert_one({
                "id": "some_existing_token", "company_id": cid,
                "txn_id": already_asked_id, "txn_ids": [already_asked_id],
                "status": "pending", "question": "...", "sent_at": now_iso(),
            })

            res = await suggest_ask_client_batches(
                cid, SuggestBatchIn(max_groups=10, min_group_size=1),
                user={"id": uid, "role": "pro"},
            )
            counterparties = {s["counterparty"] for s in res["suggestions"]}
            assert "Amazon" in counterparties
            assert "Costco" in counterparties
            amazon = next(s for s in res["suggestions"] if s["counterparty"] == "Amazon")
            # 3 in the group — NOT 4 (the already-asked one is excluded).
            assert amazon["count"] == 3
            assert already_asked_id not in amazon["txn_ids"]
            assert res["already_asked_total"] >= 1
        finally:
            await db.companies.delete_many({"id": cid})
            await db.transactions.delete_many({"company_id": cid})
            await db.client_questions.delete_many({"company_id": cid})
            await db.communications.delete_many({"company_id": cid})
    _run(_go())



def test_closed_loop_interpret_and_accept(monkeypatch):
    """Client answers → AI stamps a proposal → pro accepts → txn is
    categorized, human-reviewed, needs_review cleared, proposal removed."""
    from routes.communications import (
        AskClientBatchIn, ask_client_batch, AnswerIn, public_answer_question,
        AcceptAllIn, accept_proposal_batch,
    )
    import ai_service

    # Patch the interpreter so the test doesn't call the real LLM.
    async def _fake_interp(*, answer, txns, coa):
        return {
            "account_code": "7200", "confidence": 0.95,
            "reasoning": "Client said payroll → Payroll account.",
            "applies_to_all": True, "requires_split": False,
        }
    monkeypatch.setattr(ai_service, "interpret_client_answer", _fake_interp)
    # The dispatcher module re-imports; ensure the route sees the fake.
    import routes.communications as rc
    # public_answer_question does `from ai_service import interpret_client_answer`
    # inside the function body, so patching ai_service module attr is sufficient.

    async def _go():
        cid = f"testcid_{uuid.uuid4().hex[:8]}"
        uid = f"testpro_{uuid.uuid4().hex[:8]}"
        tids = [f"testtxn_{uuid.uuid4().hex[:8]}" for _ in range(2)]
        try:
            await db.companies.insert_one({
                "id": cid, "name": "Test Co", "contact_email": "owner@test.co",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            await db.accounts.insert_one({
                "id": "acct_payroll", "company_id": cid,
                "code": "7200", "name": "Payroll", "type": "expense",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            for tid in tids:
                await db.transactions.insert_one({
                    "id": tid, "company_id": cid,
                    "date": "2026-07-20", "amount": -1200.0,
                    "description": "Zelle to Roberto", "posted": True,
                    "needs_review": True,
                    "created_at": now_iso(), "updated_at": now_iso(),
                })
            user = {"id": uid, "email": "pro@test.co", "full_name": "Pro",
                    "role": "pro"}

            # Ask the batch.
            res = await ask_client_batch(
                cid,
                AskClientBatchIn(
                    txn_ids=tids,
                    question="What were these Zelle payments for?",
                    counterparty_label="Zelle",
                ),
                user=user,
            )
            token = res["question_id"]

            # Client answers → interpreter stamps a proposal on every txn.
            await public_answer_question(
                token, AnswerIn(answer="Payroll advances to Roberto."),
            )
            for tid in tids:
                t = await db.transactions.find_one({"id": tid})
                assert t.get("ai_proposal_from_answer") is not None
                p = t["ai_proposal_from_answer"]
                assert p["account_code"] == "7200"
                assert p["confidence"] == 0.95
                assert p["account_id"] == "acct_payroll"

            # Pro accepts the batch — one call applies to all txns.
            acc = await accept_proposal_batch(
                cid, AcceptAllIn(question_id=token),
                user={"id": uid, "email": "pro@test.co", "role": "pro"},
            )
            assert acc["accepted"] == 2

            for tid in tids:
                t = await db.transactions.find_one({"id": tid})
                assert t["category_account_id"] == "acct_payroll"
                assert t["category_account_code"] == "7200"
                assert t["human_reviewed"] is True
                assert t["needs_review"] is False
                assert "ai_proposal_from_answer" not in t
                assert "[Accepted client-answer proposal" in t["ai_comment"]
        finally:
            await db.companies.delete_many({"id": cid})
            await db.accounts.delete_many({"company_id": cid})
            await db.transactions.delete_many({"company_id": cid})
            await db.client_questions.delete_many({"company_id": cid})
            await db.communications.delete_many({"company_id": cid})
    _run(_go())

