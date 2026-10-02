"""Receipt line items → accounts via the AI-first resolver (mocked LLM)."""
import os
import sys
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import ai_category_resolver as acr  # noqa: E402
from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


def test_receipt_lines_exact_pick_llm_code_and_fallback():
    _run(_flow())


async def _flow():
    cid = f"rcpt-co-{uuid.uuid4().hex[:8]}"
    await db.companies.insert_one({"id": cid, "name": "Rcpt Test", "industry_template": "generic"})
    accts = [
        {"id": f"{cid}-a1", "company_id": cid, "code": "6300", "name": "Office Supplies", "type": "expense", "active": True},
        {"id": f"{cid}-a2", "company_id": cid, "code": "6001", "name": "Taxes & Licenses", "type": "expense", "active": True},
        {"id": f"{cid}-a3", "company_id": cid, "code": "4000", "name": "Sales", "type": "revenue", "active": True},
        {"id": f"{cid}-a4", "company_id": cid, "code": "6999", "name": "Uncategorized Expense", "type": "expense", "active": True},
    ]
    await db.accounts.insert_many(accts)
    try:
        lines = [
            {"description": "Paper towels", "amount": 8.49, "account_code": "6300", "account_name": "Office Supplies"},
            {"description": "SALES TAX", "amount": 3.14, "category_hint": "sales tax"},
            {"description": "Mystery", "amount": 1.00, "category_hint": "???"},
            {"description": "Bogus pick", "amount": 2.00, "account_code": "4000", "account_name": "Sales"},
        ]
        fake = {"lines": [
            {"idx": 1, "existing_account_code": "6001", "confidence": 1.0},
            {"idx": 2, "existing_account_code": None, "semantic": None, "new_account": None, "confidence": 0.0},
            {"idx": 3, "existing_account_code": "6300", "confidence": 0.8},
        ]}
        with patch.object(acr, "_chat_json", return_value=fake) as spy:
            out = await acr.categorize_receipt_lines(cid, lines, vendor="Store")
        assert spy.call_count == 1  # one batched call for all unresolved lines
        assert out[0]["code"] == "6300"          # exact CoA pick trusted, no LLM
        assert out[1]["code"] == "6001"          # LLM picked by code
        assert out[2]["code"] == "6999"          # nothing → Uncategorized Expense
        assert out[3]["code"] == "6300"          # revenue pick rejected (money out) → re-resolved
    finally:
        await db.accounts.delete_many({"company_id": cid})
        await db.companies.delete_one({"id": cid})


def test_receipt_lines_semantic_creates_once():
    _run(_semantic())


async def _semantic():
    cid = f"rcpt-co-{uuid.uuid4().hex[:8]}"
    await db.companies.insert_one({"id": cid, "name": "Rcpt Test", "industry_template": "generic"})
    await db.accounts.insert_one({"id": f"{cid}-a1", "company_id": cid, "code": "6300", "name": "Office Supplies", "type": "expense", "active": True})
    try:
        lines = [{"description": "Zoom", "amount": 15.0, "category_hint": "software"}, {"description": "Slack", "amount": 8.0, "category_hint": "software"}]
        responses = [{"lines": [{"idx": 0, "semantic": "software_saas", "confidence": 0.9}, {"idx": 1, "semantic": "software_saas", "confidence": 0.9}]},
                     {"same_as": None}]
        with patch.object(acr, "_chat_json", side_effect=responses) as spy:
            out = await acr.categorize_receipt_lines(cid, lines)
        assert spy.call_count == 2  # one resolve + one dedupe for the single distinct proposal
        assert out[0]["id"] == out[1]["id"]
        assert "software" in out[0]["name"].lower()
        assert await db.accounts.count_documents({"company_id": cid}) == 2
    finally:
        await db.accounts.delete_many({"company_id": cid})
        await db.companies.delete_one({"id": cid})
