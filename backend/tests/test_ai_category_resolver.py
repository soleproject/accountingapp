"""Regression: 'this was a painter' on a money-out txn must never land on
Food Cost (COGS). Live LLM test against Michael Co 2 + a mocked unit test
for the dedupe guard that caused the original bug."""
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

OK_FOR_PAINTER = {"legal & professional fees", "repairs & maintenance", "supplies & materials", "contract labor"}


def test_painter_never_food_cost_live():
    _run(_painter_live())


async def _painter_live():
    co = await db.companies.find_one({"name": {"$regex": "^Michael Co 2"}}, {"_id": 0, "id": 1})
    assert co, "Michael Co 2 demo company missing"
    txn = await db.transactions.find_one({"company_id": co["id"], "description": {"$regex": "Phoenix Business"}, "amount": {"$lt": 0}}, {"_id": 0, "id": 1})
    assert txn
    out = await acr.resolve_category(co["id"], "this was a painter", txn["id"])
    rec = out["recommendation"]
    assert rec and rec["account"], out
    name = rec["account"]["name"].lower()
    assert "food" not in name, out
    assert rec["kind"] == "new" or name in OK_FOR_PAINTER, out


def test_dedupe_is_not_bucket_based():
    _run(_dedupe_mocked())


async def _dedupe_mocked():
    accounts = [
        {"id": "a1", "code": "5000", "name": "Food Cost (COGS)", "type": "expense", "subtype": "operating_expense", "detail_type": "operating_expense"},
        {"id": "a2", "code": "6500", "name": "Legal & Professional Fees", "type": "expense", "subtype": "operating_expense", "detail_type": "operating_expense"},
    ]
    proposal = {"name": "Contract Labor", "type": "expense", "subtype": "operating_expense", "detail_type": "operating_expense"}
    with patch.object(acr, "_chat_json", return_value={"same_as": None}):
        assert await acr._llm_dedupe(proposal, accounts, "money_out", "painter") is None
    with patch.object(acr, "_chat_json", return_value={"same_as": "a2"}):
        assert (await acr._llm_dedupe(proposal, accounts, "money_out", "painter"))["id"] == "a2"
    # exact-name identity still short-circuits without the model
    with patch.object(acr, "_chat_json", side_effect=AssertionError("should not call LLM")):
        same = await acr._llm_dedupe({"name": "Legal and Professional Fees", "type": "expense"}, accounts, "money_out", "")
        assert same["id"] == "a2"


def test_counterparty_subaccount_reuse_or_propose():
    parent = {"id": "p", "code": "2500", "name": "Loans Payable", "type": "liability", "subtype": "loan", "detail_type": "loan"}
    kids = [{"id": "k1", "code": "2530", "name": "SoFi", "type": "liability", "parent_account_id": "p"}]
    accounts = [parent, *kids]
    assert acr._counterparty_subaccount(parent, accounts, "SoFi")["account"]["id"] == "k1"
    new = acr._counterparty_subaccount(parent, accounts, "Larry D Brown")
    assert new["kind"] == "new" and new["account"]["name"] == "Larry D Brown" and new["account"]["parent_account_id"] == "p" and new["account"]["code"] == "2501"
    assert acr._counterparty_subaccount(kids[0], accounts, "X") is None  # never nest under a child
    assert acr._counterparty_subaccount({**parent, "type": "expense"}, accounts, "X") is None
    assert acr._counterparty_subaccount(parent, accounts, None) is None


def test_create_parent_and_child_proposal():
    _run(_parent_child())


async def _parent_child():
    cid = f"sub-co-{uuid.uuid4().hex[:8]}"
    await db.companies.insert_one({"id": cid, "name": "Sub Test", "industry_template": "generic"})
    try:
        parent = acr._proposal_from_spec("loans_receivable", [], "generic")
        child = {"name": "Kevin Petersen", "code": "", "type": "asset", "subtype": parent["subtype"], "detail_type": parent["detail_type"],
                 "parent_account_id": None, "parent_proposal": parent, "semantic": None}
        a1 = await acr.create_account_from_proposal(cid, child)
        p = await db.accounts.find_one({"company_id": cid, "name": "Loans Receivable"}, {"_id": 0})
        assert p and a1["parent_account_id"] == p["id"] and a1["code"] == str(int(p["code"]) + 1) and a1["type"] == "asset"
        a2 = await acr.create_account_from_proposal(cid, child)
        assert a2["id"] == a1["id"]
        assert await db.accounts.count_documents({"company_id": cid}) == 2
    finally:
        await db.accounts.delete_many({"company_id": cid})
        await db.companies.delete_one({"id": cid})
