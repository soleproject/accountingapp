"""Integration tests for pfc_resolver.resolve_pfc_coa — writes real docs to
Mongo (test DB isolated via TEST_ prefix), then verifies each resolution path.

Uses asyncio.run() because pytest-asyncio isn't wired up in pytest.ini.
"""
import asyncio
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from db import db
import pfc_resolver
import pfc_mapping


# Motor's AsyncIOMotorClient binds to the loop at import time — reuse one loop.
_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


async def _seed_company_with_default_coa() -> str:
    cid = f"pfc-test-{uuid.uuid4()}"
    # Seed the minimum COA we need for the resolver to have targets.
    accts = [
        # cash & equivalents
        ("1010", "Business Checking",           "asset",     "current_asset"),
        ("1020", "Business Savings",            "asset",     "current_asset"),
        ("1100", "Undeposited Funds",           "asset",     "current_asset"),
        # equity
        ("3300", "Owner's Draw",                "equity",    "equity"),
        ("3400", "Owner's Contribution",        "equity",    "equity"),
        # revenue
        ("4000", "Service Revenue",             "revenue",   "operating_revenue"),
        ("4200", "Interest Income",             "revenue",   "other_revenue"),
        ("4999", "Uncategorized Income",        "revenue",   "operating_revenue"),
        # liabilities
        ("2100", "Credit Card Payable",         "liability", "current_liability"),
        ("2500", "Loans Payable",               "liability", "long_term_liability"),
        # expenses
        ("6000", "Meals",                       "expense",   "operating_expense"),
        ("6120", "Transportation",              "expense",   "operating_expense"),
        ("6600", "Utilities",                   "expense",   "operating_expense"),
        ("7000", "Bank Fees",                   "expense",   "operating_expense"),
        ("6999", "Uncategorized Expense",       "expense",   "operating_expense"),
    ]
    docs = []
    for code, name, atype, subtype in accts:
        docs.append({
            "id": str(uuid.uuid4()), "company_id": cid, "code": code,
            "name": name, "type": atype, "subtype": subtype,
            "is_active": True,
        })
    await db.accounts.insert_many(docs)
    return cid


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.pfc_org_overrides.delete_many({"company_id": cid})


# ---------------------------------------------------------------------------
# Step 2: primary slot resolution
# ---------------------------------------------------------------------------

def test_primary_slot_resolves_food_and_drink_restaurant():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            r = await pfc_resolver.resolve_pfc_coa(
                cid, "FOOD_AND_DRINK_RESTAURANT", bank_account_id="fake-bank",
            )
            assert r is not None
            assert r["source"] == "primary"
            assert r["category_account_code"] == "6000"
            assert r["category_account_name"] == "Meals"
            assert r["reviewed_by_default"] is True  # business_expense auto-clears
            assert r["classification"] == "business_expense"
        finally:
            await _cleanup(cid)
    _run(run())


def test_bank_fee_hits_7000():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            r = await pfc_resolver.resolve_pfc_coa(cid, "BANK_FEES_OVERDRAFT_FEES")
            assert r["source"] == "primary"
            assert r["category_account_code"] == "7000"
        finally:
            await _cleanup(cid)
    _run(run())


def test_cc_paydown_hits_2100_liability():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            r = await pfc_resolver.resolve_pfc_coa(cid, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT")
            assert r["category_account_code"] == "2100"
            assert r["classification"] == "liability_paydown"
            assert r["reviewed_by_default"] is True
        finally:
            await _cleanup(cid)
    _run(run())


# ---------------------------------------------------------------------------
# Guard: never resolve to the bank account being categorized
# ---------------------------------------------------------------------------

def test_transfer_in_account_transfer_never_resolves_to_bank():
    """TRANSFER_IN_ACCOUNT_TRANSFER maps to 1010 (Checking) but the resolver's
    bank-account guard forces it to fall through to uncategorized.
    """
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            r = await pfc_resolver.resolve_pfc_coa(cid, "TRANSFER_IN_ACCOUNT_TRANSFER")
            assert r["source"] == "fallback_uncategorized"
            assert r["category_account_code"] == "4999"  # income side of fallback
            assert r["reviewed_by_default"] is False
            assert r["classification"] == "asset_movement"
        finally:
            await _cleanup(cid)
    _run(run())


def test_bank_account_being_categorized_skipped_in_override():
    """Even a user-set override to the being-categorized bank is silently
    ignored (would create a self-cancelling JE)."""
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            checking = await db.accounts.find_one(
                {"company_id": cid, "code": "1010"})
            await pfc_resolver.set_pfc_override(
                cid, "FOOD_AND_DRINK_RESTAURANT", checking["id"],
                source="user",
            )
            # The override points at Checking (1010). Passing that account_id as
            # bank_account_id must force the resolver to skip the override AND
            # skip the primary slot (which is Meals=6000, not a bank account) —
            # wait, actually the primary slot is Meals which isn't a bank.
            # So it should fall through override → primary Meals.
            r = await pfc_resolver.resolve_pfc_coa(
                cid, "FOOD_AND_DRINK_RESTAURANT",
                bank_account_id=checking["id"],
            )
            assert r["source"] == "primary"
            assert r["category_account_code"] == "6000"
        finally:
            await _cleanup(cid)
    _run(run())


# ---------------------------------------------------------------------------
# Step 1: per-org override wins over primary
# ---------------------------------------------------------------------------

def test_override_beats_primary_slot():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            # Override FOOD_AND_DRINK_RESTAURANT → Utilities (weird pin, but
            # proves the override wins over the mapping table).
            utilities = await db.accounts.find_one(
                {"company_id": cid, "code": "6600"})
            await pfc_resolver.set_pfc_override(
                cid, "FOOD_AND_DRINK_RESTAURANT", utilities["id"],
                source="ai", confidence=0.87, reasoning="QB has 'Utilities'",
                ai_model="gpt-4o",
            )
            r = await pfc_resolver.resolve_pfc_coa(
                cid, "FOOD_AND_DRINK_RESTAURANT",
            )
            assert r["source"] == "override"
            assert r["category_account_code"] == "6600"  # override winning
        finally:
            await _cleanup(cid)
    _run(run())


def test_override_upsert_is_idempotent():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            meals = await db.accounts.find_one({"company_id": cid, "code": "6000"})
            await pfc_resolver.set_pfc_override(
                cid, "FOOD_AND_DRINK_COFFEE", meals["id"], source="user",
            )
            await pfc_resolver.set_pfc_override(
                cid, "FOOD_AND_DRINK_COFFEE", meals["id"], source="user",
            )
            count = await db.pfc_org_overrides.count_documents({
                "company_id": cid, "pfc_detailed": "FOOD_AND_DRINK_COFFEE",
            })
            assert count == 1
        finally:
            await _cleanup(cid)
    _run(run())


# ---------------------------------------------------------------------------
# Step 3: fallback direction-aware
# ---------------------------------------------------------------------------

def test_transfer_in_from_apps_falls_back_to_uncat_income():
    """TRANSFER_IN_TRANSFER_IN_FROM_APPS maps directly to 4999 (Uncategorized
    Income). Rocketbooks returns source='primary' but reviewed=false — the
    uncategorized-account guard forces review regardless of classification.
    """
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            r = await pfc_resolver.resolve_pfc_coa(cid, "TRANSFER_IN_TRANSFER_IN_FROM_APPS")
            assert r["source"] == "primary"
            assert r["category_account_code"] == "4999"
            assert r["reviewed_by_default"] is False  # forced by uncategorized guard
            assert r["classification"] == "transfer_review"
        finally:
            await _cleanup(cid)
    _run(run())


def test_transfer_out_wire_falls_back_to_uncat_expense():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            r = await pfc_resolver.resolve_pfc_coa(cid, "TRANSFER_OUT_WIRE")
            assert r["source"] == "primary"
            assert r["category_account_code"] == "6999"
            assert r["reviewed_by_default"] is False
        finally:
            await _cleanup(cid)
    _run(run())


# ---------------------------------------------------------------------------
# Unknown / null PFC → None
# ---------------------------------------------------------------------------

def test_unknown_pfc_returns_none():
    async def run():
        cid = await _seed_company_with_default_coa()
        try:
            assert await pfc_resolver.resolve_pfc_coa(cid, None) is None
            assert await pfc_resolver.resolve_pfc_coa(cid, "") is None
            assert await pfc_resolver.resolve_pfc_coa(cid, "TOTALLY_UNKNOWN_CODE") is None
        finally:
            await _cleanup(cid)
    _run(run())
