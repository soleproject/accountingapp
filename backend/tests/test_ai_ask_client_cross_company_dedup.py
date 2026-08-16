"""Cross-company recipient-signature cooldown for AI Ask Client.

Feb 25 2026 incident — a single real client email received 7
`[Bug] Quick one — Online Banking transfer to CHK 6278` emails for the
same $340 real-world payment because:
  1. The bookkeeper was testing multiple sandbox companies (each Plaid-
     linked to the same fake bank account with the same $340 txn),
  2. Client-owner emails on those test companies used Gmail plus-tag
     aliases (e.g. `me+co1@`, `me+co2@`) that the DAILY_CAP_PER_CLIENT
     counter treats as distinct → cap never trips,
  3. `_candidate_txns` dedup is company-scoped so each independent
     `process_company` tick fires 1 email each.

These tests lock the cross-company dedup added in `process_company`
via `_recently_asked_same_payment` + `_normalize_email`.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from ai_ask_client_scheduler import (  # noqa: E402
    _normalize_email,
    _payment_signature,
    _recently_asked_same_payment,
    process_company,
)
from tests._shared_loop import run as _run  # noqa: E402


def test_normalize_email_gmail_plus_tag_and_dots():
    """Gmail plus-tag suffixes and dots-in-localpart must both
    normalize to the same canonical address."""
    assert _normalize_email("michael+postplaid@gmail.com") == "michael@gmail.com"
    assert _normalize_email("mi.cha.el@gmail.com") == "michael@gmail.com"
    assert _normalize_email("m.i+co1@googlemail.com") == "mi@googlemail.com"
    # Non-Gmail domain — only strip plus-tag, keep dots
    assert _normalize_email("first.last+co@company.io") == "first.last@company.io"
    # Case + whitespace
    assert _normalize_email("  MI@GMAIL.COM  ") == "mi@gmail.com"
    # Empty / None safe
    assert _normalize_email(None) == ""
    assert _normalize_email("") == ""


def test_recently_asked_same_payment_finds_cross_company_ask():
    """A prior ask to the same normalized recipient within the cooldown
    window must be found — regardless of which company it was for."""
    async def _t():
        # Simulate an ask sent 1 hour ago from Company A
        now = datetime.now(timezone.utc).isoformat()
        sig = "2026-08-12|-34000|CHK 6278"
        doc_id = str(uuid.uuid4())
        await db.client_questions.insert_one({
            "id": doc_id,
            "company_id": "company-A",
            "flow_type": "ai_ask_client",
            "status": "pending",
            "to_email": "michael+companyA@gmail.com",
            "normalized_to_email": "michael@gmail.com",
            "payment_signature": sig,
            "sent_at": now,
        })
        try:
            # A different plus-tag alias on Company B tries to ask the same
            hit = await _recently_asked_same_payment(
                "michael+companyB@gmail.com", sig
            )
            assert hit is not None, "cooldown should have found the prior ask"
            assert hit["id"] == doc_id
            # Different signature — should NOT match
            miss = await _recently_asked_same_payment(
                "michael+companyC@gmail.com",
                "2026-08-12|-20000|OTHER",
            )
            assert miss is None
        finally:
            await db.client_questions.delete_one({"id": doc_id})
    _run(_t())


def test_recently_asked_ignores_asks_outside_cooldown_window():
    """Prior asks older than the cooldown window must NOT block a
    fresh ask — otherwise we'd never re-ask about a repeat charge."""
    async def _t():
        # Simulate an ask sent way outside the cooldown (30 days ago).
        old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        sig = "2026-08-12|-34000|CHK 6278"
        doc_id = str(uuid.uuid4())
        await db.client_questions.insert_one({
            "id": doc_id,
            "company_id": "company-A",
            "flow_type": "ai_ask_client",
            "status": "pending",
            "to_email": "michael+companyA@gmail.com",
            "normalized_to_email": "michael@gmail.com",
            "payment_signature": sig,
            "sent_at": old,
        })
        try:
            hit = await _recently_asked_same_payment(
                "michael+companyB@gmail.com", sig
            )
            assert hit is None, "old ask should NOT block a fresh one"
        finally:
            await db.client_questions.delete_one({"id": doc_id})
    _run(_t())


def test_process_company_skips_when_recipient_signature_already_asked():
    """End-to-end: process_company for Company B must skip (no email)
    when the same normalized recipient was recently asked about the
    same payment signature on Company A."""
    async def _t():
        # Seed a "prior ask" from Company A
        now = datetime.now(timezone.utc).isoformat()
        today = datetime.now(timezone.utc).date().isoformat()
        sig = f"{today}|-34000|CHK 6278"
        prior_id = str(uuid.uuid4())
        await db.client_questions.insert_one({
            "id": prior_id,
            "company_id": "company-A",
            "flow_type": "ai_ask_client",
            "status": "pending",
            "to_email": "michael+companyA@gmail.com",
            "normalized_to_email": "michael@gmail.com",
            "payment_signature": sig,
            "sent_at": now,
        })
        # Set up Company B with a matching flagged txn + client
        cid_b = f"co_{uuid.uuid4().hex[:8]}"
        pro_id = f"pro_{uuid.uuid4().hex[:8]}"
        owner_id = f"own_{uuid.uuid4().hex[:8]}"
        try:
            await db.companies.insert_one({"id": cid_b, "name": "Co B"})
            await db.users.insert_many([
                {"id": pro_id, "email": "pro@fbtest-real.io", "role": "pro"},
                {"id": owner_id, "email": "michael+companyB@gmail.com",
                 "role": "client"},
            ])
            await db.memberships.insert_many([
                {"user_id": pro_id, "company_id": cid_b, "role": "pro"},
                {"user_id": owner_id, "company_id": cid_b, "role": "owner"},
            ])
            await db.transactions.insert_one({
                "id": f"txn_{uuid.uuid4().hex[:8]}",
                "company_id": cid_b,
                "date": today,
                "amount": -340.0,
                "description": "Online Banking transfer to CHK 6278",
                "merchant": "CHK 6278",
                "needs_review": True, "human_reviewed": False,
                "client_question_id": None,
            })
            # Patch send_email so a leak-through would be visible
            with patch("email_service.send_email", new_callable=AsyncMock) as m:
                m.return_value = {"id": "fake-id"}
                result = await process_company(cid_b)
            assert result["status"] == "recipient_signature_dedup", (
                f"expected recipient dedup, got {result}"
            )
            assert result["prior_question_id"] == prior_id
            # And no email was fired
            assert m.call_count == 0
        finally:
            await db.client_questions.delete_one({"id": prior_id})
            await db.companies.delete_one({"id": cid_b})
            await db.users.delete_many({"id": {"$in": [pro_id, owner_id]}})
            await db.memberships.delete_many({"company_id": cid_b})
            await db.transactions.delete_many({"company_id": cid_b})
    _run(_t())
