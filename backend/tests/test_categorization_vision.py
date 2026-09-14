"""Smoke tests for the Q1/Q2 receipt-categorization vision flow and
the client-review attachment delete endpoint.

Vision calls are mocked — regression coverage for the normalization
shape (line items → grouped suggested_categories) and the DELETE
attachment path.
"""
from __future__ import annotations
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from client_review_engine import analyze_receipt_for_categorization
from deps import db
import client_review as cr
from server import app
from httpx import AsyncClient, ASGITransport
from tests._shared_loop import run


DATA_URL = "data:image/png;base64,fakebytes"


class _FakeChoice:
    def __init__(self, content):
        self.message = type("M", (), {"content": content})
        self.finish_reason = "stop"


class _FakeResp:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]
        self.usage = type("U", (), {"prompt_tokens": 200, "completion_tokens": 300})


# ---------------------------------------------------------------------------
# Engine: analyze_receipt_for_categorization normalisation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_categorization_groups_and_totals(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    good = """{
      "narrative": "Home Depot run.",
      "line_items": [
        {"description":"4x4x8 PT POST","amount":119.88,"account_code":"5100","account_name":"Materials · Lumber"},
        {"description":"QUIKRETE","amount":69.80,"account_code":"5100","account_name":"Materials · Concrete"},
        {"description":"2x4x10 KD SPF","amount":67.76,"account_code":"5100","account_name":"Materials · Lumber"},
        {"description":"MILWAUKEE M18","amount":99.00,"account_code":"5200","account_name":"Small Tools & Equipment"},
        {"description":"ZERO","amount":0,"account_code":"5100","account_name":"Materials · Lumber"}
      ],
      "totals": {"subtotal": 356.44, "grand_total": 356.44}
    }"""
    fake_client = type("C", (), {})()
    fake_client.chat = type("Ch", (), {})()
    fake_client.chat.completions = type("Cx", (), {})()
    fake_client.chat.completions.create = AsyncMock(return_value=_FakeResp(good))
    with patch("openai.AsyncOpenAI", return_value=fake_client):
        r = await analyze_receipt_for_categorization(
            attachment_data_url=DATA_URL,
            coa=[{"code": "5100", "name": "Materials", "type": "expense"}],
            txn_amount=356.44, txn_desc="HOME DEPOT",
            company_industry="Landscaping", company_name="Acme",
        )
    assert r is not None
    # ZERO amount dropped
    assert len(r["line_items"]) == 4
    # Grouped by (code|name) — two lumber lines merge, others stand alone
    codes = sorted(g["account_code"] for g in r["suggested_categories"])
    assert codes == ["5100", "5100", "5200"]
    lumber = next(g for g in r["suggested_categories"]
                  if g["account_name"] == "Materials · Lumber")
    assert lumber["amount"] == pytest.approx(119.88 + 67.76, abs=0.01)
    assert lumber["line_indices"] == [0, 2]


@pytest.mark.asyncio
async def test_categorization_returns_none_on_empty_items(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    bad = """{"line_items": [], "totals": {"grand_total": 0}}"""
    fake_client = type("C", (), {})()
    fake_client.chat = type("Ch", (), {})()
    fake_client.chat.completions = type("Cx", (), {})()
    fake_client.chat.completions.create = AsyncMock(return_value=_FakeResp(bad))
    with patch("openai.AsyncOpenAI", return_value=fake_client):
        r = await analyze_receipt_for_categorization(
            attachment_data_url=DATA_URL, coa=None,
            txn_amount=1, txn_desc="x",
            company_industry=None, company_name=None,
        )
    assert r is None


# ---------------------------------------------------------------------------
# Route: DELETE /{token}/items/{item_id}/attachments/{aid}
# ---------------------------------------------------------------------------
# Coverage lives in tests/test_client_review.py alongside the other
# route tests to avoid mixing asyncio-marker + run() loop styles in
# one file (which crashes with "Event loop is closed").
