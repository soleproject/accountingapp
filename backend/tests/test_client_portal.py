"""Client Portal — end-to-end contract tests.

Locks in the auto-unblock loop: a portal answer flips the underlying
client_questions doc to `answered`, which drops it from the Cockpit
`requests?status=open` view AND from `close-board.portal_pending`.
Uploads linked to a question auto-answer it.
"""
import uuid
import pytest
from datetime import datetime, timezone, timedelta

from tests._shared_loop import run as _run
from db import db


def _now(): return datetime.now(timezone.utc).isoformat()


async def _seed_portal(cid: str, client_email: str) -> str:
    """Insert one company + one portal + two open client_questions."""
    await db.companies.insert_one({"id": cid, "name": "PortalTestCo", "created_at": _now()})
    token = f"tok-{uuid.uuid4().hex}"
    await db.client_portals.insert_one({
        "id": token, "company_id": cid,
        "client_email": client_email, "client_name": "Test Client",
        "brand_snapshot": {"company_name": "PortalTestCo", "primary_color": "#123456"},
        "created_by": "pro@test", "created_at": _now(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "revoked_at": None,
    })
    txid = f"tx-{uuid.uuid4().hex[:8]}"
    await db.transactions.insert_one({
        "id": txid, "company_id": cid, "date": "2026-03-05",
        "amount": -110.0, "description": "AWS charge", "posted": True,
    })
    for i, q in enumerate([
        "Was the $110 AWS charge a business expense?",
        "Please send a receipt for the client dinner.",
    ]):
        await db.client_questions.insert_one({
            "id": f"q-{i}-{token}", "company_id": cid,
            "question": q, "status": "pending", "to_email": client_email,
            "sent_at": _now(), "txn_ids": [txid] if i == 0 else [],
            "txn_id": txid if i == 0 else None,
        })
    return token


async def _cleanup(cid: str):
    for coll in ("companies", "client_portals", "client_questions",
                 "transactions", "portal_uploads"):
        await db[coll].delete_many({"company_id": cid})


def test_portal_home_returns_open_questions():
    async def go():
        from routes.client_portal import portal_home
        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            r = await portal_home(token)
            assert r["brand"]["company_name"] == "PortalTestCo"
            assert r["open_count"] == 2
            assert len(r["open_questions"]) == 2
            assert r["allow_upload"] is True
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_answer_auto_unblocks_cockpit():
    """Answering via portal → client_questions.status=answered → drops
    off `cockpit/requests?status=open` view."""
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            qid = f"q-0-{token}"
            r = await portal_answer(token, qid, PortalAnswerIn(answer="Yes, business expense."))
            assert r["status"] == "answered"

            # Verify the doc flipped.
            q = await db.client_questions.find_one({"id": qid})
            assert q["status"] == "answered"
            assert q["answer"] == "Yes, business expense."
            assert q.get("answered_at")
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_upload_linked_to_question_auto_answers_it():
    async def go():
        from routes.client_portal import portal_upload
        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            qid = f"q-1-{token}"  # The receipt-request one

            # Simulate an UploadFile.
            class _Up:
                def __init__(self, name, ct, data):
                    self.filename = name
                    self.content_type = ct
                    self._data = data
                async def read(self): return self._data
            up = _Up("dinner.jpg", "image/jpeg", b"fake-jpg-bytes")

            r = await portal_upload(token, file=up, question_id=qid, note="Client dinner")
            assert r["status"] == "uploaded"
            assert r["linked_txn_count"] == 0  # This question had no txn_ids seeded

            # Verify the question auto-answered.
            q = await db.client_questions.find_one({"id": qid})
            assert q["status"] == "answered"
            assert "dinner.jpg" in q["answer"]

            # Verify the upload stored.
            up_doc = await db.portal_uploads.find_one({"id": r["upload_id"]})
            assert up_doc["filename"] == "dinner.jpg"
            assert up_doc["note"] == "Client dinner"
        finally:
            await _cleanup(cid)
    _run(go())


def test_portal_matches_email_case_insensitively():
    """Regression: ask-client write paths may store 'Client@Example.com'
    while client_portals.client_email is lowercase-normalized. Portal
    must still surface + accept answers for those questions."""
    async def go():
        from routes.client_portal import portal_home, portal_answer, PortalAnswerIn
        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            # Add a THIRD question with mixed-case to_email.
            mixed = email.replace("tester", "TESTER").upper()[:len(email)]
            # Just capitalize a letter deterministically.
            mixed = email[:5].upper() + email[5:]
            qid_mixed = f"q-mixed-{token}"
            await db.client_questions.insert_one({
                "id": qid_mixed, "company_id": cid,
                "question": "Mixed-case email question.",
                "status": "pending", "to_email": mixed,
                "sent_at": _now(),
            })

            # portal_home should include the mixed-case one.
            r = await portal_home(token)
            ids = [q["id"] for q in r["open_questions"]]
            assert qid_mixed in ids

            # portal_answer should accept it.
            ans = await portal_answer(token, qid_mixed, PortalAnswerIn(answer="Ok"))
            assert ans["status"] == "answered"
        finally:
            await _cleanup(cid)
    _run(go())


def test_revoked_portal_rejects():
    async def go():
        from routes.client_portal import portal_home
        from fastapi import HTTPException
        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            await db.client_portals.update_one({"id": token}, {"$set": {"revoked_at": _now()}})
            with pytest.raises(HTTPException) as exc:
                await portal_home(token)
            assert exc.value.status_code == 410
        finally:
            await _cleanup(cid)
    _run(go())



def test_portal_answer_stamps_ai_proposal_on_linked_txn(monkeypatch):
    """A portal answer for a txn-linked question should now run
    interpret_client_answer and stamp an ai_proposal_from_answer on
    every affected transaction (parity with the /q/{token}/answer flow).

    The proposal is also echoed back on the response when the account
    code is real (not the 9999 fallback) and confidence is >= 0.5, so
    the client sees a friendly "here's what I did" confirmation.
    """
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        import ai_service

        # Mock the LLM interpreter to return a deterministic proposal.
        async def fake_interpret(*, answer, txns, coa):
            return {
                "account_code": "6100",
                "confidence": 0.87,
                "reasoning": "Client said business dinner",
                "applies_to_all": True,
                "requires_split": False,
            }
        monkeypatch.setattr(ai_service, "interpret_client_answer", fake_interpret)

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            # Add a matching CoA entry so the acct name/id resolve.
            await db.accounts.insert_one({
                "id": f"acct-{cid}", "company_id": cid,
                "code": "6100", "name": "Meals & Entertainment",
                "type": "expense",
            })
            qid = f"q-0-{token}"
            r = await portal_answer(token, qid, PortalAnswerIn(answer="Client dinner"))
            assert r["status"] == "answered"
            assert r["proposal"] is not None
            assert r["proposal"]["account_code"] == "6100"
            assert r["proposal"]["account_name"] == "Meals & Entertainment"
            assert r["proposal"]["confidence"] >= 0.5

            # Txn now has the proposal + client_answer stamp.
            txn = await db.transactions.find_one({"id": f"tx-{token[:8]}"}) or (
                await db.transactions.find_one({"company_id": cid})
            )
            assert txn is not None
            prop = txn.get("ai_proposal_from_answer") or {}
            assert prop.get("account_code") == "6100"
            assert prop.get("source") == "portal_answer"
            assert txn.get("client_answer") == "Client dinner"
            assert txn.get("client_answered_at")

            # Question doc also carries the proposal for the review UI.
            q = await db.client_questions.find_one({"id": qid})
            assert (q.get("ai_proposal") or {}).get("account_code") == "6100"
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())


def test_portal_answer_hides_fallback_proposal_from_client(monkeypatch):
    """When the interpreter returns the 9999 "Ask My Accountant" fallback
    or low confidence, we still stamp it internally for the CPA — but we
    do NOT surface it back to the client on the response (we don't want
    to promise "I posted this" when we really haven't decided)."""
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        import ai_service

        async def fake_interpret(*, answer, txns, coa):
            return {
                "account_code": "9999",
                "confidence": 0.2,
                "reasoning": "unclear",
                "applies_to_all": True,
                "requires_split": False,
            }
        monkeypatch.setattr(ai_service, "interpret_client_answer", fake_interpret)

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            await db.accounts.insert_one({
                "id": f"acct-{cid}", "company_id": cid,
                "code": "9999", "name": "Ask My Accountant", "type": "expense",
            })
            qid = f"q-0-{token}"
            r = await portal_answer(token, qid, PortalAnswerIn(answer="idk"))
            assert r["status"] == "answered"
            # Not surfaced to the client.
            assert r["proposal"] is None
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())
