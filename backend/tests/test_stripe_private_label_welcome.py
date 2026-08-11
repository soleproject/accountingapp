"""Tests for private-label brand routing on Stripe signups.

Covers:
  - `resolve_brand` accepts `brand` / `label` / `private_label` keys
  - Unknown / missing brand falls back to `smartbooks`
  - `stripe_welcome` template swaps product name + drops flagship
    footer when a private-label brand is passed
  - Webhook outcome dict carries `brand` + `magic_link_host` so ops can
    see which label each event was attributed to
  - Bailed-no-email events STILL report the resolved brand
  - User doc gets stamped with `private_label_brand` on the paid signup
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
import private_labels as pl  # noqa: E402
import email_templates as et  # noqa: E402


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
# Unit — brand resolution
# --------------------------------------------------------------------------

def test_resolve_brand_reads_brand_key():
    b = pl.resolve_brand({"brand": "cypherpro"})
    assert b["key"] == "cypherpro"
    assert b["display_name"] == "CypherPro"


def test_resolve_brand_accepts_label_alias():
    # Operators sometimes use `label` instead of `brand` — accept both.
    b = pl.resolve_brand({"label": "cypherpro"})
    assert b["key"] == "cypherpro"


def test_resolve_brand_accepts_private_label_alias():
    b = pl.resolve_brand({"private_label": "cypherpro"})
    assert b["key"] == "cypherpro"


def test_resolve_brand_is_case_insensitive():
    b = pl.resolve_brand({"brand": "CypherPro"})
    assert b["key"] == "cypherpro"


def test_resolve_brand_falls_back_on_unknown_key():
    # A typo or a brand-new label not yet registered → safe default.
    b = pl.resolve_brand({"brand": "acmebooks"})
    assert b["key"] == "smartbooks"


def test_resolve_brand_falls_back_on_missing_metadata():
    assert pl.resolve_brand(None)["key"] == "smartbooks"
    assert pl.resolve_brand({})["key"] == "smartbooks"


def test_get_brand_falls_back_on_typo():
    assert pl.get_brand("nope")["key"] == "smartbooks"
    assert pl.get_brand("")["key"] == "smartbooks"


# --------------------------------------------------------------------------
# Unit — email template branding
# --------------------------------------------------------------------------

def test_stripe_welcome_uses_brand_product_name_in_subject():
    subj, html = et.stripe_welcome(
        name="Alice",
        magic_url="https://app.cypherpro.accountingapp.ai/set-password/tok",
        brand=pl.get_brand("cypherpro"),
    )
    assert subj == "Welcome to CypherPro — set your password"
    assert "CypherPro" in html
    assert "your business, decoded" in html
    # Flagship footer reference is stripped for private labels.
    assert "smartbookssoftware.ai" not in html


def test_stripe_welcome_flagship_keeps_smartbooks_footer():
    subj, html = et.stripe_welcome(
        name="Bob",
        magic_url="https://app.smartbookssoftware.ai/set-password/tok",
        brand=pl.get_brand("smartbooks"),
    )
    assert subj == "Welcome to SmartBooks — set your password"
    assert "SmartBooks" in html
    # Flagship keeps the domain ref in the footer.
    assert "smartbookssoftware.ai" in html


def test_stripe_welcome_defaults_to_smartbooks_when_no_brand():
    subj, html = et.stripe_welcome(name="Carol", magic_url="https://x/y")
    assert "SmartBooks" in subj


def test_stripe_welcome_escapes_hostile_name_input():
    """A payer could theoretically pass a name with HTML — never let it
    render as markup."""
    subj, html = et.stripe_welcome(
        name="<script>alert(1)</script>",
        magic_url="https://x/y",
        brand=pl.get_brand("cypherpro"),
    )
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


# --------------------------------------------------------------------------
# Integration — webhook outcome carries brand
# --------------------------------------------------------------------------

def test_webhook_outcome_carries_cypherpro_brand():
    """CypherPro Payment Link fires the webhook with metadata.brand set.
    Outcome must reflect the brand + magic-link host so ops can see
    the private-label routing worked."""
    async def _t():
        fresh_email = f"cypherpro_{uuid.uuid4().hex[:8]}@example.com"
        eid = f"evt_cyph_{uuid.uuid4().hex[:8]}"
        await db.users.delete_one({"email": fresh_email})

        evt = {
            "id": eid,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_cyph_ok",
                "customer": "cus_cyph_1",
                "customer_details": {"email": fresh_email, "name": "Cyph Payer"},
                "subscription": "sub_cyph_1",
                "mode": "subscription",
                "metadata": {"brand": "cypherpro"},
            }},
        }
        code, body = await _post_event(evt)
        assert code == 200
        outcome = body["outcome"]
        assert outcome["status"] == "user_created"
        assert outcome["brand"] == "cypherpro"
        assert outcome["magic_link_host"] == "https://app.cypherpro.accountingapp.ai"

        # User doc gets the brand stamped so future re-sends route
        # correctly without re-parsing the Stripe metadata.
        user = await db.users.find_one({"email": fresh_email})
        assert user is not None
        assert user.get("private_label_brand") == "cypherpro"

        # cleanup
        await db.users.delete_one({"id": user["id"]})
        await db.password_set_tokens.delete_many({"user_id": user["id"]})
        await db.communications.delete_many({"user_id": user["id"]})
        await db.stripe_webhook_events.delete_one({"id": eid})
    _run(_t())


def test_webhook_outcome_defaults_to_smartbooks_when_metadata_missing():
    """SmartBooks flagship payment links (which predate the brand
    registry) MUST keep routing to smartbooks — no regression."""
    async def _t():
        fresh_email = f"flagship_{uuid.uuid4().hex[:8]}@example.com"
        eid = f"evt_flag_{uuid.uuid4().hex[:8]}"
        await db.users.delete_one({"email": fresh_email})

        evt = {
            "id": eid,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_flag_ok",
                "customer": "cus_flag_1",
                "customer_details": {"email": fresh_email, "name": "Flag Payer"},
                "subscription": "sub_flag_1",
                "mode": "subscription",
                # No metadata.brand at all — historical Payment Links.
            }},
        }
        code, body = await _post_event(evt)
        assert code == 200
        outcome = body["outcome"]
        assert outcome["brand"] == "smartbooks"
        assert outcome["magic_link_host"] == "https://app.smartbookssoftware.ai"

        # cleanup
        user = await db.users.find_one({"email": fresh_email})
        if user:
            await db.users.delete_one({"id": user["id"]})
            await db.password_set_tokens.delete_many({"user_id": user["id"]})
            await db.communications.delete_many({"user_id": user["id"]})
        await db.stripe_webhook_events.delete_one({"id": eid})
    _run(_t())


def test_bailed_no_email_still_reports_brand():
    """Even when we bail because the Payment Link forgot the email
    toggle, the outcome must report which brand's link it was — so ops
    can tell which private label is misconfigured."""
    async def _t():
        eid = f"evt_bail_{uuid.uuid4().hex[:8]}"
        evt = {
            "id": eid,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_bail_cyph",
                "customer": None,
                "subscription": None,
                "mode": "subscription",
                "metadata": {"brand": "cypherpro"},
            }},
        }
        code, body = await _post_event(evt)
        assert code == 200
        outcome = body["outcome"]
        assert outcome["status"] == "bailed_no_email"
        assert outcome["brand"] == "cypherpro"
        await db.stripe_webhook_events.delete_one({"id": eid})
    _run(_t())
