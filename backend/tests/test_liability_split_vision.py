"""Smoke tests for the Q9 liability-payment vision flow (mortgage /
credit-card / auto-loan statement extraction).

Vision calls are mocked — we don't want CI to hit the OpenAI API on
every run. The tests exercise the normalization and route wiring so
regressions in shape / error handling get caught locally.
"""
from __future__ import annotations
import base64
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from client_review_engine import analyze_liability_statement_for_split


DATA_URL = "data:image/png;base64," + base64.b64encode(b"fake").decode()


class _FakeChoice:
    def __init__(self, content):
        self.message = type("M", (), {"content": content})
        self.finish_reason = "stop"


class _FakeResp:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]
        self.usage = type("U", (), {"prompt_tokens": 200, "completion_tokens": 300})


@pytest.mark.asyncio
async def test_mortgage_shape_normalises_and_totals_reflow(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    good = """{
      "statement_type": "mortgage",
      "lender_name": "Wells Fargo Home Mortgage",
      "narrative": "Test",
      "payment_amount": 2145.67,
      "buckets": [
        {"label": "Principal", "amount": 812.45, "account_name": "Mortgage Payable"},
        {"label": "Interest", "amount": 1104.22, "account_name": "Mortgage Interest Expense"},
        {"label": "Escrow", "amount": 210.0, "account_name": "Escrow (Prepaid)"},
        {"label": "Fees", "amount": 19.0, "account_name": "Bank Fees"},
        {"label": "ZeroPad", "amount": 0.0, "account_name": "N/A"}
      ]
    }"""
    fake_client = type("C", (), {})()
    fake_client.chat = type("Ch", (), {})()
    fake_client.chat.completions = type("Cx", (), {})()
    fake_client.chat.completions.create = AsyncMock(return_value=_FakeResp(good))

    with patch("openai.AsyncOpenAI", return_value=fake_client):
        result = await analyze_liability_statement_for_split(
            attachment_data_url=DATA_URL, coa=None,
            txn_amount=2145.67, txn_desc="mtg",
            company_industry="Landscaping", company_name="Acme",
        )
    assert result is not None
    assert result["statement_type"] == "mortgage"
    # Zero-value bucket is dropped by the normaliser.
    labels = [b["label"] for b in result["buckets"]]
    assert "ZeroPad" not in labels
    assert set(labels) == {"Principal", "Interest", "Escrow", "Fees"}
    assert result["totals"]["grand_total"] == pytest.approx(2145.67, abs=0.01)


@pytest.mark.asyncio
async def test_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    r = await analyze_liability_statement_for_split(
        attachment_data_url=DATA_URL, coa=None,
        txn_amount=1, txn_desc="x",
        company_industry=None, company_name=None,
    )
    assert r is None


@pytest.mark.asyncio
async def test_returns_none_on_empty_data_url():
    r = await analyze_liability_statement_for_split(
        attachment_data_url="", coa=None,
        txn_amount=None, txn_desc=None,
        company_industry=None, company_name=None,
    )
    assert r is None


@pytest.mark.asyncio
async def test_returns_none_on_empty_buckets(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    bad = """{"statement_type": "mortgage", "buckets": []}"""
    fake_client = type("C", (), {})()
    fake_client.chat = type("Ch", (), {})()
    fake_client.chat.completions = type("Cx", (), {})()
    fake_client.chat.completions.create = AsyncMock(return_value=_FakeResp(bad))
    with patch("openai.AsyncOpenAI", return_value=fake_client):
        r = await analyze_liability_statement_for_split(
            attachment_data_url=DATA_URL, coa=None,
            txn_amount=1, txn_desc="x",
            company_industry=None, company_name=None,
        )
    assert r is None
