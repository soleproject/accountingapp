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
            # 0.87 is below the auto-apply threshold (0.9) so it stays a
            # pending proposal for the CPA.
            assert r["proposal"]["applied"] is False

            # Txn now has the proposal + client_answer stamp.
            txn = await db.transactions.find_one({"id": f"tx-{token[:8]}"}) or (
                await db.transactions.find_one({"company_id": cid})
            )
            assert txn is not None
            prop = txn.get("ai_proposal_from_answer") or {}
            assert prop.get("account_code") == "6100"
            assert prop.get("source") == "portal_answer"
            assert not prop.get("auto_applied")
            # Category was NOT applied since confidence < 0.9.
            assert not txn.get("category_account_id")
            assert not txn.get("human_reviewed")
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



def test_portal_answer_auto_applies_high_confidence(monkeypatch):
    """When the AI is confident (>= 0.9) and the account is real, the
    portal answer skips the CPA review step and posts the txn directly.
    The client sees "Posted — your books are up to date." instead of
    "I've suggested categorizing this as…". Audit trail preserved via
    ai_proposal_from_answer.auto_applied + ai_comment breadcrumb +
    human_reviewed_by=client_portal_auto."""
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        import ai_service

        async def fake_interpret(*, answer, txns, coa):
            return {
                "account_code": "6300",
                "confidence": 0.95,
                "reasoning": "Client explicitly said rent",
                "applies_to_all": True,
                "requires_split": False,
            }
        monkeypatch.setattr(ai_service, "interpret_client_answer", fake_interpret)

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            await db.accounts.insert_one({
                "id": f"acct-{cid}-6300", "company_id": cid,
                "code": "6300", "name": "Rent Expense", "type": "expense",
            })
            qid = f"q-0-{token}"
            r = await portal_answer(token, qid, PortalAnswerIn(answer="Yes, it was rent"))
            assert r["status"] == "answered"
            assert r["proposal"] is not None
            assert r["proposal"]["applied"] is True

            # Txn was auto-posted.
            txn = await db.transactions.find_one({"company_id": cid})
            assert txn is not None
            assert txn.get("category_account_id") == f"acct-{cid}-6300"
            assert txn.get("category_account_code") == "6300"
            assert txn.get("category_account_name") == "Rent Expense"
            assert txn.get("needs_review") is False
            assert txn.get("human_reviewed") is True
            assert txn.get("human_reviewed_by") == "client_portal_auto"
            assert "Auto-applied" in (txn.get("ai_comment") or "")

            # Proposal doc records the auto-apply for audit.
            prop = txn.get("ai_proposal_from_answer") or {}
            assert prop.get("auto_applied") is True
            assert prop.get("applied_at")
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())


def test_portal_answer_does_not_overwrite_reviewed_txn(monkeypatch):
    """Auto-apply must never stomp over a CPA's earlier manual decision.
    If human_reviewed=True is already set on the txn, we still stamp the
    proposal (audit trail) but leave the category untouched."""
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        import ai_service

        async def fake_interpret(*, answer, txns, coa):
            return {
                "account_code": "6300",
                "confidence": 0.95,
                "reasoning": "…",
                "applies_to_all": True,
                "requires_split": False,
            }
        monkeypatch.setattr(ai_service, "interpret_client_answer", fake_interpret)

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            await db.accounts.insert_one({
                "id": f"acct-{cid}-6300", "company_id": cid,
                "code": "6300", "name": "Rent Expense", "type": "expense",
            })
            # Mark the seeded txn as already reviewed by a CPA with a
            # different category.
            await db.transactions.update_many(
                {"company_id": cid},
                {"$set": {
                    "category_account_id": "prior-acct",
                    "category_account_code": "6100",
                    "category_account_name": "Meals",
                    "human_reviewed": True,
                    "human_reviewed_by": "pro@test",
                }},
            )
            qid = f"q-0-{token}"
            r = await portal_answer(token, qid, PortalAnswerIn(answer="Yes, it was rent"))
            # Proposal echoed back but the applied flag should be False —
            # the txn was already reviewed so we did not overwrite it.
            assert r["proposal"] is not None
            assert r["proposal"]["applied"] is False

            txn = await db.transactions.find_one({"company_id": cid})
            # Category unchanged.
            assert txn.get("category_account_id") == "prior-acct"
            assert txn.get("category_account_code") == "6100"
            assert txn.get("human_reviewed_by") == "pro@test"
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())


def test_portal_answer_skips_auto_apply_when_requires_split(monkeypatch):
    """Even at 0.98 confidence, a proposal flagged `requires_split` must
    NOT auto-apply — the txn genuinely needs multiple lines and only the
    CPA can decide the amounts."""
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        import ai_service

        async def fake_interpret(*, answer, txns, coa):
            return {
                "account_code": "6300",
                "confidence": 0.98,
                "reasoning": "Two purposes — split needed",
                "applies_to_all": True,
                "requires_split": True,
            }
        monkeypatch.setattr(ai_service, "interpret_client_answer", fake_interpret)

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"
        try:
            token = await _seed_portal(cid, email)
            await db.accounts.insert_one({
                "id": f"acct-{cid}-6300", "company_id": cid,
                "code": "6300", "name": "Rent Expense", "type": "expense",
            })
            qid = f"q-0-{token}"
            r = await portal_answer(token, qid, PortalAnswerIn(answer="rent plus office supplies"))
            assert r["proposal"] is not None
            assert r["proposal"]["applied"] is False

            txn = await db.transactions.find_one({"company_id": cid})
            assert not txn.get("category_account_id")
            assert not txn.get("human_reviewed")
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())


def test_today_surfaces_answered_questions_and_acknowledge_clears_them(monkeypatch):
    """After a client answers via the portal, the underlying question
    remains in the Cockpit Today queue as a "Client answered — ready to
    review" card until the CPA calls the acknowledge endpoint. Once
    acknowledged (cpa_reviewed_at set), the card drops."""
    async def go():
        from routes.client_portal import portal_answer, PortalAnswerIn
        from routes.cockpit import _today_items_for_company, cockpit_acknowledge
        from routes import cockpit as cockpit_mod
        import ai_service

        async def fake_interpret(*, answer, txns, coa):
            return {
                "account_code": "6300",
                "confidence": 0.95,
                "reasoning": "rent",
                "applies_to_all": True,
                "requires_split": False,
            }
        monkeypatch.setattr(ai_service, "interpret_client_answer", fake_interpret)

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"

        # Fake the access check so the acknowledge endpoint sees our cid.
        async def fake_require(user):
            return [cid]
        monkeypatch.setattr(cockpit_mod, "require_firm_or_pro", fake_require)

        try:
            token = await _seed_portal(cid, email)
            await db.accounts.insert_one({
                "id": f"acct-{cid}-6300", "company_id": cid,
                "code": "6300", "name": "Rent Expense", "type": "expense",
            })
            qid = f"q-0-{token}"
            await portal_answer(token, qid, PortalAnswerIn(answer="Yes, rent"))

            # Today feed for THIS company should now include an
            # answered-ready-to-review card.
            items = await _today_items_for_company(cid, "PortalTestCo", 2026, 3)
            answered_cards = [i for i in items if i["id"] == f"answered-{qid}"]
            assert len(answered_cards) == 1
            card = answered_cards[0]
            assert card["urgency"] == "blue"
            assert "Yes, rent" in card["subtitle"]
            # Auto-post note appears because confidence >= 0.9.
            assert "Auto-posted" in card["subtitle"]
            assert card["action_label"] == "Review answer"

            # Acknowledge as a firm user — must drop the card.
            fake_user = {"email": "pro@axiom.ai", "id": "u1", "role": "pro"}
            r = await cockpit_acknowledge(qid, user=fake_user)
            assert r["ok"] is True
            assert r["cpa_reviewed_at"]

            items2 = await _today_items_for_company(cid, "PortalTestCo", 2026, 3)
            answered_after = [i for i in items2 if i["id"] == f"answered-{qid}"]
            assert answered_after == []
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())


def test_acknowledge_rejects_non_answered_question(monkeypatch):
    """You can't acknowledge a still-pending question."""
    async def go():
        from routes.cockpit import cockpit_acknowledge
        from routes import cockpit as cockpit_mod
        from fastapi import HTTPException
        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"

        async def fake_require(user):
            return [cid]
        monkeypatch.setattr(cockpit_mod, "require_firm_or_pro", fake_require)

        try:
            token = await _seed_portal(cid, email)
            qid = f"q-0-{token}"  # status=pending from _seed_portal
            fake_user = {"email": "pro@axiom.ai", "id": "u1", "role": "pro"}
            with pytest.raises(HTTPException) as exc:
                await cockpit_acknowledge(qid, user=fake_user)
            assert exc.value.status_code == 400
        finally:
            await _cleanup(cid)
    _run(go())




def test_acknowledge_all_bulk_clears_backlog(monkeypatch):
    """The bulk acknowledge endpoint should flip every answered-but-
    unreviewed question in the caller's accessible companies to
    reviewed in one shot. Pending questions must NOT be affected."""
    async def go():
        from routes.cockpit import cockpit_acknowledge_all
        from routes import cockpit as cockpit_mod

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"

        async def fake_require(user):
            return [cid]
        monkeypatch.setattr(cockpit_mod, "require_firm_or_pro", fake_require)

        try:
            token = await _seed_portal(cid, email)
            # Flip both seeded questions to answered but not reviewed.
            await db.client_questions.update_many(
                {"company_id": cid, "id": {"$regex": f"^q-.*-{token}$"}},
                {"$set": {"status": "answered", "answered_at": _now()}},
            )
            # Add one that's already reviewed (should not double-stamp).
            await db.client_questions.insert_one({
                "id": f"q-already-{token}", "company_id": cid,
                "question": "old one",
                "status": "answered", "to_email": email,
                "sent_at": _now(), "answered_at": _now(),
                "cpa_reviewed_at": _now(),
            })
            # Add one that's still pending (should NOT be touched).
            await db.client_questions.insert_one({
                "id": f"q-pending-{token}", "company_id": cid,
                "question": "still open",
                "status": "pending", "to_email": email,
                "sent_at": _now(),
            })

            fake_user = {"email": "pro@axiom.ai", "id": "u1", "role": "pro"}
            r = await cockpit_acknowledge_all(company_ids=None, user=fake_user)
            assert r["ok"] is True
            assert r["count"] == 2  # only the two answered-not-reviewed

            # All previously answered docs now have cpa_reviewed_at set.
            done_count = await db.client_questions.count_documents({
                "company_id": cid,
                "status": "answered",
                "cpa_reviewed_at": {"$ne": None},
            })
            assert done_count == 3  # 2 just marked + 1 pre-existing
            # The pending one is still pending.
            still_pending = await db.client_questions.find_one({"id": f"q-pending-{token}"})
            assert still_pending["status"] == "pending"
            assert not still_pending.get("cpa_reviewed_at")

            # Second sweep is a no-op (idempotent).
            r2 = await cockpit_acknowledge_all(company_ids=None, user=fake_user)
            assert r2["count"] == 0
        finally:
            await _cleanup(cid)
    _run(go())



def test_rules_bulk_toggle_flips_matching_source_only(monkeypatch):
    """POST /companies/{cid}/rules/bulk-toggle should flip `enabled` on
    every rule whose `source` matches — leaving rules from other
    sources untouched. Idempotent when re-run with same target state."""
    async def go():
        from routes.rules import rules_bulk_toggle, RulesBulkToggleIn
        from routes import rules as rules_mod

        cid = str(uuid.uuid4())

        async def fake_require(user, target_cid):
            assert target_cid == cid
            return None
        monkeypatch.setattr(rules_mod, "require_company", fake_require)

        try:
            # Seed 3 cpa_from_answer rules (all enabled) + 1 ai_miner + 1 human.
            now = _now()
            for pattern in ("ALPHA", "BETA", "GAMMA"):
                await db.rules.insert_one({
                    "id": f"r-{pattern}", "company_id": cid,
                    "match_type": "description_contains",
                    "match_value": pattern, "account_code": "6300",
                    "source": "cpa_from_answer", "enabled": True,
                    "created_at": now, "updated_at": now,
                })
            await db.rules.insert_one({
                "id": "r-miner", "company_id": cid,
                "match_value": "MINER", "account_code": "6100",
                "source": "ai_miner", "created_by": "ai_miner",
                "enabled": True, "created_at": now, "updated_at": now,
            })
            await db.rules.insert_one({
                "id": "r-human", "company_id": cid,
                "match_value": "HUMAN", "account_code": "6100",
                "created_by": "human", "enabled": True,
                "created_at": now, "updated_at": now,
            })

            fake_user = {"email": "pro@axiom.ai", "id": "u1", "role": "pro"}

            # Disable all cpa_from_answer.
            r = await rules_bulk_toggle(
                cid, RulesBulkToggleIn(source="cpa_from_answer", enabled=False),
                user=fake_user,
            )
            assert r["ok"] is True
            assert r["modified"] == 3

            disabled = await db.rules.count_documents({
                "company_id": cid, "source": "cpa_from_answer", "enabled": False,
            })
            assert disabled == 3
            # ai_miner and human rules untouched.
            miner = await db.rules.find_one({"id": "r-miner"})
            assert miner["enabled"] is True
            human = await db.rules.find_one({"id": "r-human"})
            assert human["enabled"] is True

            # Idempotent — second call returns modified=0.
            r2 = await rules_bulk_toggle(
                cid, RulesBulkToggleIn(source="cpa_from_answer", enabled=False),
                user=fake_user,
            )
            assert r2["modified"] == 0

            # Re-enable them all — modified should be 3 again.
            r3 = await rules_bulk_toggle(
                cid, RulesBulkToggleIn(source="cpa_from_answer", enabled=True),
                user=fake_user,
            )
            assert r3["modified"] == 3
        finally:
            await db.rules.delete_many({"company_id": cid})
    _run(go())



def test_acknowledge_with_save_rule_spawns_rules_doc(monkeypatch):
    """When the CPA acknowledges with save_rule=True and the question
    has a real ai_proposal + a linked txn description, a `rules` doc
    is inserted. The question is stamped with rule_id for audit and
    the response echoes back what was created."""
    async def go():
        from routes.cockpit import cockpit_acknowledge, AcknowledgeIn, cockpit_rule_preview
        from routes import cockpit as cockpit_mod

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"

        async def fake_require(user):
            return [cid]
        monkeypatch.setattr(cockpit_mod, "require_firm_or_pro", fake_require)

        try:
            token = await _seed_portal(cid, email)
            qid = f"q-0-{token}"
            # Give the txn a stable-ish description we can pattern on.
            await db.transactions.update_many(
                {"company_id": cid},
                {"$set": {"description": "ZELLE PAYMENT FROM ROMEO UGALI 09/04"}},
            )
            # Flip to answered + attach a proposal + real acct row.
            await db.accounts.insert_one({
                "id": f"acct-{cid}-6300", "company_id": cid,
                "code": "6300", "name": "Rent Expense", "type": "expense",
            })
            await db.client_questions.update_one(
                {"id": qid},
                {"$set": {
                    "status": "answered",
                    "answer": "That was rent to Romeo.",
                    "answered_at": _now(),
                    "ai_proposal": {
                        "account_code": "6300",
                        "account_id": f"acct-{cid}-6300",
                        "account_name": "Rent Expense",
                        "confidence": 0.95,
                    },
                }},
            )

            fake_user = {"email": "pro@axiom.ai", "id": "u1", "role": "pro"}

            # Preview first — should be eligible.
            preview = await cockpit_rule_preview(qid, user=fake_user)
            assert preview["eligible"] is True
            assert "ROMEO" in preview["pattern"]
            assert preview["account_code"] == "6300"
            assert preview["already_exists"] is False

            # Acknowledge with save_rule=True → rule row appears.
            r = await cockpit_acknowledge(
                qid, inp=AcknowledgeIn(save_rule=True), user=fake_user,
            )
            assert r["ok"] is True
            assert r["rule_created"] is not None
            assert r["rule_created"]["account_code"] == "6300"
            assert "ROMEO" in r["rule_created"]["pattern"]

            # rules collection has one matching doc.
            rule = await db.rules.find_one({"company_id": cid, "source": "cpa_from_answer"})
            assert rule is not None
            assert rule["account_code"] == "6300"
            assert rule["source_question_id"] == qid

            # Second acknowledge is idempotent — the pattern already
            # exists, so no duplicate rule.
            r2 = await cockpit_acknowledge(
                qid, inp=AcknowledgeIn(save_rule=True), user=fake_user,
            )
            rules_count = await db.rules.count_documents(
                {"company_id": cid, "source": "cpa_from_answer"}
            )
            assert rules_count == 1

            # Preview now reports already_exists=True.
            preview2 = await cockpit_rule_preview(qid, user=fake_user)
            assert preview2["already_exists"] is True
        finally:
            await db.rules.delete_many({"company_id": cid})
            await db.accounts.delete_many({"company_id": cid})
            await _cleanup(cid)
    _run(go())


def test_acknowledge_without_save_rule_never_creates_rule(monkeypatch):
    """Default acknowledge (save_rule omitted or False) never creates
    a rule, even when the proposal is real. This is the safety default."""
    async def go():
        from routes.cockpit import cockpit_acknowledge, AcknowledgeIn
        from routes import cockpit as cockpit_mod

        cid = str(uuid.uuid4())
        email = f"tester-{uuid.uuid4().hex[:6]}@example.com"

        async def fake_require(user):
            return [cid]
        monkeypatch.setattr(cockpit_mod, "require_firm_or_pro", fake_require)

        try:
            token = await _seed_portal(cid, email)
            qid = f"q-0-{token}"
            await db.client_questions.update_one(
                {"id": qid},
                {"$set": {
                    "status": "answered",
                    "answer": "rent",
                    "answered_at": _now(),
                    "ai_proposal": {
                        "account_code": "6300",
                        "account_id": "some-acct",
                        "account_name": "Rent Expense",
                        "confidence": 0.95,
                    },
                }},
            )
            fake_user = {"email": "pro@axiom.ai", "id": "u1", "role": "pro"}
            r = await cockpit_acknowledge(qid, inp=None, user=fake_user)
            assert r["ok"] is True
            assert r["rule_created"] is None
            count = await db.rules.count_documents({"company_id": cid})
            assert count == 0
        finally:
            await _cleanup(cid)
    _run(go())
