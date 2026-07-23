"""Tests for the AI usage cost tracker + superadmin summary endpoint."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid

import pytest

sys.path.insert(0, "/app/backend")
from server import app  # noqa: E402
from db import db  # noqa: E402
import ai_usage  # noqa: E402

_LOOP = asyncio.new_event_loop()
def _run(coro):
    return _LOOP.run_until_complete(coro)


def test_price_llm_known_model():
    """gpt-4o-mini: 1000 in × $0.15/1M + 500 out × $0.60/1M
       = $0.00015 + $0.00030 = $0.00045 → 0.045 cents."""
    cost = ai_usage._price_llm("gpt-4o-mini", 1000, 500)
    assert round(cost, 6) == 0.045


def test_price_llm_prefix_match():
    """Dated model names like gpt-4o-mini-2024-07-18 fall through to the
    base model's pricing via prefix match."""
    cost = ai_usage._price_llm("gpt-4o-mini-2024-07-18", 1000, 500)
    assert round(cost, 6) == 0.045


def test_price_llm_unknown_model_returns_zero():
    assert ai_usage._price_llm("some-fake-model-3000", 1000, 500) == 0.0


def test_record_llm_inserts_event_and_returns_cost():
    async def _t():
        await db.ai_usage_events.delete_many({"feature": "test-feature-1"})
        cost = await ai_usage.record_llm(
            feature="test-feature-1", provider="openai", model="gpt-4o-mini",
            input_tokens=1000, output_tokens=500,
            user_id="u1", company_id="c1",
        )
        assert round(cost, 6) == 0.045
        doc = await db.ai_usage_events.find_one({"feature": "test-feature-1"})
        assert doc is not None
        assert doc["service"] == "openai_llm"
        assert doc["input_tokens"] == 1000
        assert doc["output_tokens"] == 500
        assert doc["user_id"] == "u1"
        await db.ai_usage_events.delete_many({"feature": "test-feature-1"})
    _run(_t())


def test_record_service_uses_price_table():
    async def _t():
        await db.ai_usage_events.delete_many({"feature": "test-veryfi"})
        cost = await ai_usage.record_service(
            feature="test-veryfi", service="veryfi_ocr", quantity=3,
        )
        # 3 docs × $0.16 = $0.48 = 48 cents
        assert cost == 48.0
        doc = await db.ai_usage_events.find_one({"feature": "test-veryfi"})
        assert doc["quantity"] == 3.0
        assert doc["unit_price_usd"] == 0.16
        await db.ai_usage_events.delete_many({"feature": "test-veryfi"})
    _run(_t())


def test_request_context_is_picked_up():
    """set_request_context in one call is read by the next record_llm call."""
    async def _t():
        await db.ai_usage_events.delete_many({"feature": "test-ctx"})
        ai_usage.set_request_context(user_id="ctx-user-99", company_id="ctx-co-99")
        await ai_usage.record_llm(
            feature="test-ctx", provider="openai", model="gpt-4o-mini",
            input_tokens=100, output_tokens=50,
        )
        doc = await db.ai_usage_events.find_one({"feature": "test-ctx"})
        assert doc["user_id"] == "ctx-user-99"
        assert doc["company_id"] == "ctx-co-99"
        await db.ai_usage_events.delete_many({"feature": "test-ctx"})
    _run(_t())


def test_get_summary_aggregates_by_feature_and_service():
    async def _t():
        await db.ai_usage_events.delete_many({"feature": {"$in": ["test-A", "test-B"]}})
        # Seed 2 different features, one hits LLM, one hits Veryfi.
        await ai_usage.record_llm(
            feature="test-A", provider="openai", model="gpt-4o-mini",
            input_tokens=1000, output_tokens=500, user_id="u1",
        )
        await ai_usage.record_llm(
            feature="test-A", provider="openai", model="gpt-4o-mini",
            input_tokens=1000, output_tokens=500, user_id="u2",
        )
        await ai_usage.record_service(
            feature="test-B", service="veryfi_ocr", quantity=1, user_id="u1",
        )

        s = await ai_usage.get_summary(range_key="7d")
        # Filter to only our seeds — safer than clearing everything.
        feats = {r["feature"]: r for r in s["by_feature"] if r["feature"].startswith("test-")}
        assert feats["test-A"]["events"] == 2
        assert feats["test-B"]["events"] == 1
        # Category rollup: LLM cost + Veryfi cost both present.
        cats = {r["category"]: r["cost_cents"] for r in s["by_category"]}
        assert cats.get("llm", 0) > 0
        assert cats.get("ocr", 0) > 0

        await db.ai_usage_events.delete_many({"feature": {"$in": ["test-A", "test-B"]}})
    _run(_t())


def test_admin_usage_endpoint_requires_superadmin():
    async def _t():
        from httpx import AsyncClient, ASGITransport
        from auth import create_token
        # Non-superadmin should be 403.
        client_u = await db.users.find_one({"role": "client"})
        assert client_u, "seed client required"
        client_token = create_token(client_u["id"], "client")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.get(
                "/api/admin/usage?range=month",
                headers={"Authorization": f"Bearer {client_token}"},
            )
        assert r.status_code == 403

        # Superadmin should succeed and return the expected shape.
        admin_u = await db.users.find_one({"role": "superadmin"})
        assert admin_u, "seed superadmin required"
        admin_token = create_token(admin_u["id"], "superadmin")
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.get(
                "/api/admin/usage?range=month",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
        assert r.status_code == 200
        payload = r.json()
        for key in ("totals", "by_feature", "by_service", "by_category", "expected_services"):
            assert key in payload, f"missing key: {key}"
        # expected_services must always include openai_llm even when no
        # events exist so the UI can render a placeholder row.
        services = {s["service"] for s in payload["expected_services"]}
        assert {"openai_llm", "veryfi_ocr", "resend_email", "plaid_linked_item"} <= services
    _run(_t())
