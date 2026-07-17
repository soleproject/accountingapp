"""Statement CoA resolver tests — verify the Rocketsuite-inspired match/create
heuristics work as intended.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

from db import db, now_iso
import statement_account_resolver as sar


def _fresh_cid() -> str:
    return f"stmt-resolver-{uuid.uuid4()}"


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})


async def _seed_asset(cid: str, code: str, name: str) -> dict:
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid, "code": code, "name": name,
        "type": "asset", "active": True, "created_at": now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


# ---------- 1. Last-4 match wins ----------

async def _run_last4_match():
    cid = _fresh_cid()
    try:
        seed = await _seed_asset(cid, "1012", "Bank of America Adv Relationship Banking ···6084")
        veryfi_doc = {
            "bank_name": "Bank of America",
            "account_number": "5010 1627 6084",
            "accounts": [{"account_type": "checking"}],
        }
        r = await sar.resolve_statement_account(cid, veryfi_doc)
        assert r["matched"] is True
        assert r["account_id"] == seed["id"]
        assert r["last4"] == "6084"
    finally:
        await _cleanup(cid)


# ---------- 2. Fuzzy bank-name match when only one candidate ----------

async def _run_fuzzy_bank_match():
    cid = _fresh_cid()
    try:
        seed = await _seed_asset(cid, "1010", "Chase Business Checking")
        # No last-4 in DB name; only one bank-flavored candidate
        veryfi_doc = {
            "bank_name": "Chase",
            "account_number": "1234567890",  # not present in seed name
        }
        r = await sar.resolve_statement_account(cid, veryfi_doc)
        assert r["matched"] is True
        assert r["account_id"] == seed["id"]
    finally:
        await _cleanup(cid)


# ---------- 3. Multiple bank-flavored candidates → no fuzzy match → create ----------

async def _run_ambiguous_creates_new():
    cid = _fresh_cid()
    try:
        await _seed_asset(cid, "1010", "Wells Fargo Business Checking")
        await _seed_asset(cid, "1011", "Wells Fargo Savings")
        veryfi_doc = {
            "bank_name": "Wells Fargo",
            "account_number": "4444333322225555",  # no last-4 collision
            "accounts": [{"account_type": "checking"}],
        }
        r = await sar.resolve_statement_account(cid, veryfi_doc)
        assert r["matched"] is False, "expected new account when ambiguous"
        # Name should include institution + type + last4
        assert "Wells Fargo" in r["account_name"]
        assert "5555" in r["account_name"]
        # Verify actually inserted with next free code
        acct = await db.accounts.find_one({"id": r["account_id"]})
        assert acct["type"] == "asset"
        assert acct["source"] == "veryfi_statement"
        assert acct["code"] not in ("1010", "1011")
    finally:
        await _cleanup(cid)


# ---------- 4. Create new when nothing exists ----------

async def _run_create_from_scratch():
    cid = _fresh_cid()
    try:
        veryfi_doc = {
            "bank_name": "Truist",
            "account_number": "9999888877776666",
            "accounts": [{"account_type": "savings", "starting_balance": 5000.0}],
        }
        r = await sar.resolve_statement_account(cid, veryfi_doc)
        assert r["matched"] is False
        assert "Truist" in r["account_name"]
        assert "Savings" in r["account_name"]
        assert "6666" in r["account_name"]
        assert r["starting_balance"] == 5000.0
    finally:
        await _cleanup(cid)


# ---------- 5. Credit-card statement → creates a "Credit Card" account ----------

async def _run_credit_card_naming():
    cid = _fresh_cid()
    try:
        veryfi_doc = {
            "bank_name": "American Express",
            "account_number": "3782 822463 10005",
            "accounts": [{"account_type": "credit card"}],
        }
        r = await sar.resolve_statement_account(cid, veryfi_doc)
        assert r["matched"] is False
        assert "Credit Card" in r["account_name"], r["account_name"]
        # last-4 of digits-only "378282246310005" = "0005"
        assert "0005" in r["account_name"]
    finally:
        await _cleanup(cid)


if __name__ == "__main__":
    async def _all():
        await _run_last4_match()
        await _run_fuzzy_bank_match()
        await _run_ambiguous_creates_new()
        await _run_create_from_scratch()
        await _run_credit_card_naming()
    asyncio.run(_all())
    print("All 5 statement-CoA resolver tests passed.")
