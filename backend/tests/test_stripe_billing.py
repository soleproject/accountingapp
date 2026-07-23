"""Tests for Stripe billing webhook + affiliate revenue-share logic.

Uses the sync-test + shared-loop pattern (see test_ai_ask_client.py)
to avoid pytest-asyncio's event-loop-per-test lifecycle which breaks
Motor's connection state across tests.
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

# Set fake webhook secret BEFORE importing the app — the router captures
# STRIPE_WEBHOOK_SECRET at module import time.
os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test_" + "a" * 32
WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

from server import app  # noqa: E402
from db import db  # noqa: E402
import routes.stripe_billing as sb  # noqa: E402

_LOOP = asyncio.new_event_loop()
def _run(coro):
    return _LOOP.run_until_complete(coro)


def _sign(payload_str: str, secret: str = WEBHOOK_SECRET) -> str:
    """Reproduce Stripe's signature header algorithm."""
    ts = str(int(time.time()))
    signed = f"{ts}.{payload_str}"
    v1 = hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={v1}"


@pytest.fixture(autouse=True)
def _reload_secret(monkeypatch):
    monkeypatch.setattr(sb, "_WEBHOOK_SECRET", WEBHOOK_SECRET, raising=False)


async def _clean():
    await db.stripe_webhook_events.delete_many({})
    await db.platform_payments.delete_many({})
    await db.referral_earnings.delete_many({})


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
# Signature verification
# --------------------------------------------------------------------------

def test_webhook_rejects_bad_signature():
    async def _t():
        from httpx import AsyncClient, ASGITransport
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.post(
                "/api/stripe/webhook",
                content=b'{"type":"foo"}',
                headers={"Stripe-Signature": "t=0,v1=deadbeef"},
            )
        assert r.status_code == 400
    _run(_t())


def test_webhook_dedupes_by_event_id():
    async def _t():
        await _clean()
        evt = {
            "id": f"evt_test_dedup_{uuid.uuid4().hex[:8]}",
            "type": "customer.subscription.updated",
            "data": {"object": {"id": "sub_x", "customer": "cus_x", "status": "active"}},
        }
        c1, _ = await _post_event(evt)
        c2, body2 = await _post_event(evt)
        assert c1 == 200 and c2 == 200
        assert body2.get("status") == "duplicate"
    _run(_t())


# --------------------------------------------------------------------------
# checkout.session.completed
# --------------------------------------------------------------------------

def test_checkout_completed_creates_new_user():
    async def _t():
        await _clean()
        fresh_email = f"stripe_new_{uuid.uuid4().hex[:8]}@example.com"
        await db.users.delete_one({"email": fresh_email})

        evt = {
            "id": f"evt_test_new_{uuid.uuid4().hex[:8]}",
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_test_new",
                "customer": "cus_new_1",
                "customer_details": {"email": fresh_email, "name": "New Payer"},
                "subscription": "sub_new_1",
            }},
        }
        code, _ = await _post_event(evt)
        assert code == 200

        user = await db.users.find_one({"email": fresh_email})
        assert user is not None
        assert user["stripe_customer_id"] == "cus_new_1"
        assert user["stripe_subscription_id"] == "sub_new_1"
        assert user["role"] == "client"

        # cleanup
        await db.users.delete_one({"id": user["id"]})
        await db.password_set_tokens.delete_many({"user_id": user["id"]})
        await db.communications.delete_many({"user_id": user["id"]})
    _run(_t())


def test_checkout_completed_credits_referral_slug():
    async def _t():
        await _clean()
        from referral_util import mint_slug_for_user

        referrer_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": referrer_id,
            "email": f"ref_{referrer_id[:6]}@example.com", "name": "Ref Rer",
            "password": "x", "role": "pro",
            "created_at": "2026-01-01", "updated_at": "2026-01-01",
        })
        slug = await mint_slug_for_user(referrer_id)

        fresh_email = f"referred_{uuid.uuid4().hex[:8]}@example.com"
        evt = {
            "id": f"evt_test_ref_{uuid.uuid4().hex[:8]}",
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_test_ref", "customer": "cus_ref_1",
                "customer_details": {"email": fresh_email, "name": "Referred"},
                "subscription": "sub_ref_1",
                "client_reference_id": slug,
            }},
        }
        code, _ = await _post_event(evt)
        assert code == 200

        referred = await db.users.find_one({"email": fresh_email})
        assert referred is not None
        assert referred.get("referred_by_user_id") == referrer_id

        # cleanup
        await db.users.delete_one({"id": referrer_id})
        await db.users.delete_one({"id": referred["id"]})
    _run(_t())


# --------------------------------------------------------------------------
# invoice.paid — payment logged + 20% credited to referrer
# --------------------------------------------------------------------------

def test_invoice_paid_records_and_credits_20_percent():
    async def _t():
        await _clean()
        from referral_util import mint_slug_for_user

        referrer_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": referrer_id,
            "email": f"ref2_{referrer_id[:6]}@example.com", "name": "Ref",
            "password": "x", "role": "pro",
            "created_at": "2026-01-01", "updated_at": "2026-01-01",
        })
        slug = await mint_slug_for_user(referrer_id)

        referred_email = f"paid_{uuid.uuid4().hex[:8]}@example.com"
        checkout_evt = {
            "id": f"evt_ck_{uuid.uuid4().hex[:8]}",
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_paid_1", "customer": "cus_paid_1",
                "customer_details": {"email": referred_email, "name": "Payer"},
                "subscription": "sub_paid_1", "client_reference_id": slug,
            }},
        }
        await _post_event(checkout_evt)

        invoice_evt = {
            "id": f"evt_inv_{uuid.uuid4().hex[:8]}",
            "type": "invoice.paid",
            "data": {"object": {
                "id": "in_paid_1", "customer": "cus_paid_1",
                "customer_email": referred_email,
                "subscription": "sub_paid_1",
                "amount_paid": 1900, "currency": "usd",
                "hosted_invoice_url": "https://invoice.stripe.com/xyz",
                "invoice_pdf": "https://invoice.stripe.com/xyz.pdf",
                "period_start": 1700000000, "period_end": 1702600000,
            }},
        }
        code, _ = await _post_event(invoice_evt)
        assert code == 200

        payment = await db.platform_payments.find_one({"stripe_invoice_id": "in_paid_1"})
        assert payment is not None
        assert payment["amount_cents"] == 1900
        assert payment["currency"] == "usd"

        earning = await db.referral_earnings.find_one({"referrer_user_id": referrer_id})
        assert earning is not None
        assert earning["gross_cents"] == 1900
        assert earning["share_cents"] == 380  # 20% of 1900
        assert earning["share_bps"] == 2000
        assert earning["status"] == "accrued"

        await db.users.delete_one({"id": referrer_id})
        await db.users.delete_many({"email": referred_email})
    _run(_t())


def test_invoice_paid_is_idempotent():
    async def _t():
        await _clean()
        referred_email = f"idem_{uuid.uuid4().hex[:8]}@example.com"
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": referred_email, "name": "Idem", "password": "x", "role": "client",
            "stripe_customer_id": "cus_idem_1",
            "created_at": "2026-01-01", "updated_at": "2026-01-01",
        })

        def _mk_evt(evt_id: str) -> dict:
            return {
                "id": evt_id, "type": "invoice.paid",
                "data": {"object": {
                    "id": "in_idem_1", "customer": "cus_idem_1",
                    "customer_email": referred_email,
                    "subscription": "sub_idem_1",
                    "amount_paid": 3800, "currency": "usd",
                }},
            }

        code, _ = await _post_event(_mk_evt(f"evt_i1_{uuid.uuid4().hex[:6]}"))
        assert code == 200
        n1 = await db.platform_payments.count_documents({"stripe_invoice_id": "in_idem_1"})

        # Same invoice, DIFFERENT event id → still only one payment row.
        code, _ = await _post_event(_mk_evt(f"evt_i2_{uuid.uuid4().hex[:6]}"))
        assert code == 200
        n2 = await db.platform_payments.count_documents({"stripe_invoice_id": "in_idem_1"})

        assert n1 == n2 == 1
        await db.users.delete_one({"email": referred_email})
    _run(_t())


# --------------------------------------------------------------------------
# Superadmin mark-paid
# --------------------------------------------------------------------------

def test_mark_paid_flips_status():
    async def _t():
        await _clean()
        from auth import create_token
        from httpx import AsyncClient, ASGITransport
        admin = await db.users.find_one({"role": "superadmin"})
        if not admin:
            pytest.skip("no superadmin seed user")
        token = create_token(admin["id"], "superadmin")

        eid = str(uuid.uuid4())
        await db.referral_earnings.insert_one({
            "id": eid, "referrer_user_id": "r1", "referred_user_id": "r2",
            "gross_cents": 1000, "share_bps": 2000, "share_cents": 200,
            "currency": "usd", "status": "accrued", "created_at": "2026-01-01",
        })

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.post(
                "/api/billing/superadmin/mark-paid",
                json={"earning_ids": [eid]},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert r.status_code == 200
        assert r.json()["updated"] == 1

        doc = await db.referral_earnings.find_one({"id": eid})
        assert doc["status"] == "paid_out"
        assert doc.get("paid_out_at")
    _run(_t())
