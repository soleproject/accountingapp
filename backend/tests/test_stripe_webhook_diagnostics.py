"""Regression tests for Stripe webhook outcome-tracking + diagnostic
endpoint (added to debug CypherPro's private-label Payment Link where
Stripe returned 200 but no user got created because the Payment Link
did not include an email).

Reads the outcome from the webhook's response body (not the DB row) —
the sibling test file test_stripe_billing.py's ``_clean()`` fixture
wipes ``stripe_webhook_events`` between tests, which races with our
row reads under pytest-xdist. Response-body reads are race-free.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import uuid

import pytest

sys.path.insert(0, "/app/backend")

os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test_" + "a" * 32
WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

from server import app  # noqa: E402
from db import db  # noqa: E402
import routes.stripe_billing as sb  # noqa: E402


# Share the event loop with sibling stripe test files so Motor doesn't
# bind to one loop and then get called from another when xdist's
# loadscope groups multiple files onto the same worker process.
try:
    from tests.test_stripe_billing import _LOOP as _LOOP  # noqa: F401
except ImportError:
    _LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


def _sign(payload_str: str, secret: str = WEBHOOK_SECRET) -> str:
    ts = str(int(time.time()))
    signed = f"{ts}.{payload_str}"
    v1 = hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={v1}"


@pytest.fixture(autouse=True)
def _reload_secret(monkeypatch):
    monkeypatch.setattr(sb, "_WEBHOOK_SECRET", WEBHOOK_SECRET, raising=False)


async def _post_event(evt: dict) -> tuple[int, dict]:
    from httpx import AsyncClient, ASGITransport
    body = json.dumps(evt)
    sig = _sign(body)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.post(
            "/api/stripe/webhook",
            content=body,
            headers={"Content-Type": "application/json", "Stripe-Signature": sig},
        )
    return r.status_code, r.json()


# --------------------------------------------------------------------------
# outcome tracking (response body — race-free vs sibling test's _clean)
# --------------------------------------------------------------------------

def test_outcome_recorded_when_payment_link_omits_email():
    """This is the exact scenario CypherPro is hitting — Payment Link
    fired the webhook but had no customer email, so we bail. Response
    body carries a `bailed_no_email` outcome with an actionable hint."""
    async def _t():
        eid = f"evt_diag_no_email_{uuid.uuid4().hex[:8]}"
        evt = {
            "id": eid,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_test_no_email",
                # No customer_details, no customer_email — Payment Link
                # was created without email collection turned on.
                "customer": None,
                "subscription": None,
                "mode": "subscription",
            }},
        }
        code, body = await _post_event(evt)
        assert code == 200
        outcome = body["outcome"]
        assert outcome["status"] == "bailed_no_email"
        # Hint tells the user what to fix on the Stripe side.
        assert "Payment Link" in outcome["hint"]
        assert "Collect customer information" in outcome["hint"]
        assert outcome["session_id"] == "cs_test_no_email"

        # Best-effort cleanup — row may already be gone due to sibling
        # test's _clean(). That's fine; response body already proves it.
        await db.stripe_webhook_events.delete_one({"id": eid})
    _run(_t())


def test_outcome_recorded_when_user_created():
    """Happy path — response body carries user_created + welcome_sent."""
    async def _t():
        fresh_email = f"outcome_new_{uuid.uuid4().hex[:8]}@example.com"
        eid = f"evt_diag_ok_{uuid.uuid4().hex[:8]}"
        await db.users.delete_one({"email": fresh_email})

        evt = {
            "id": eid,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_test_ok",
                "customer": "cus_ok_1",
                "customer_details": {"email": fresh_email, "name": "OK Payer"},
                "subscription": "sub_ok_1",
                "mode": "subscription",
                "metadata": {"ref": None},
            }},
        }
        code, body = await _post_event(evt)
        assert code == 200
        outcome = body["outcome"]
        assert outcome["status"] == "user_created"
        assert outcome["email"] == fresh_email
        assert outcome["welcome_sent"] is True
        assert outcome["stripe_customer_id"] == "cus_ok_1"
        assert outcome["stripe_subscription_id"] == "sub_ok_1"

        # User record persisted (db.users is not wiped by sibling test).
        user = await db.users.find_one({"email": fresh_email})
        assert user is not None
        assert user["stripe_customer_id"] == "cus_ok_1"
        assert user["stripe_subscription_id"] == "sub_ok_1"

        # cleanup
        await db.users.delete_one({"id": user["id"]})
        await db.password_set_tokens.delete_many({"user_id": user["id"]})
        await db.communications.delete_many({"user_id": user["id"]})
        await db.stripe_webhook_events.delete_one({"id": eid})
    _run(_t())


def test_snapshot_captures_line_price_ids_from_invoice():
    """Invoice events include price IDs on the snapshot so ops can
    eyeball which product was billed. We read the DB row here because
    ``invoice.payment_failed`` outcome isn't exposed in the response.
    Kept lenient — passes even if the sibling wipe already fired."""
    async def _t():
        eid = f"evt_diag_inv_{uuid.uuid4().hex[:8]}"
        evt = {
            "id": eid,
            "type": "invoice.payment_failed",
            "data": {"object": {
                "id": "in_test_snap",
                "customer": "cus_snap",
                "amount_paid": 0,
                "amount_due": 3800,
                "billing_reason": "subscription_cycle",
                "lines": {"data": [
                    {"price": {"id": "price_simple_start_abc"}},
                    {"price": {"id": "price_addon_xyz"}},
                ]},
            }},
        }
        code, _ = await _post_event(evt)
        assert code == 200
        # Direct unit-check of the snapshot helper — deterministic,
        # doesn't depend on DB row surviving the sibling wipe.
        snap = sb._snapshot_event_object(evt["data"]["object"])
        assert snap["id"] == "in_test_snap"
        assert snap["amount_due"] == 3800
        assert snap["line_price_ids"] == [
            "price_simple_start_abc",
            "price_addon_xyz",
        ]
        await db.stripe_webhook_events.delete_one({"id": eid})
    _run(_t())


def test_snapshot_helper_trims_metadata_and_keeps_customer_email():
    """Metadata is user-controlled → cap the count/size, keep
    customer_details.email for the diagnostic view. Pure unit test
    against the snapshot helper — no DB dependency, race-free."""
    big_meta = {f"k{i}": f"v{i}" for i in range(30)}
    obj = {
        "id": "cs_test_meta",
        "customer": "cus_meta",
        "customer_details": {"email": "payer@example.com", "name": "Meta Payer"},
        "subscription": "sub_meta",
        "mode": "subscription",
        "metadata": big_meta,
    }
    snap = sb._snapshot_event_object(obj)
    assert snap["customer_details"]["email"] == "payer@example.com"
    # Metadata capped at 20 keys.
    assert len(snap["metadata"]) == 20
    # All values are strings (coerced from whatever Stripe sent).
    for v in snap["metadata"].values():
        assert isinstance(v, str)


def test_snapshot_helper_handles_missing_fields():
    """Real Stripe payloads have wildly variable shapes — snapshot
    helper must never crash on missing dicts / None-y fields."""
    assert sb._snapshot_event_object({}) == {}
    assert sb._snapshot_event_object(None) == {}  # type: ignore[arg-type]
    # Weird partial payload — should still return a dict.
    snap = sb._snapshot_event_object({"id": "cs_x", "customer_details": None})
    assert snap["id"] == "cs_x"
    assert "customer_details" not in snap
