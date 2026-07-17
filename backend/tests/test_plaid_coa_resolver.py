"""Plaid-side CoA resolver regression tests — ensures the Rocketsuite-style
per-account resolution (previously Veryfi-only) now applies to Plaid links
too. Confirms:
  • First-time link creates a dedicated `1011 Chase Checking ···6084` row
    instead of collapsing onto the shared `1010 Business Checking`.
  • Credit cards land in the liability range (2101+).
  • Re-linking the same Plaid account is idempotent (no duplicate rows).
  • Multiple accounts on the same institution get separate rows.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso
import plaid_connect


def _fresh_cid() -> str:
    return f"plaid-coa-{uuid.uuid4()}"


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})


# ---------- 1. Fresh Plaid link creates dedicated per-account row ----------

async def _run_fresh_link_creates_dedicated_row():
    cid = _fresh_cid()
    try:
        # Seed the onboarding-default 1010 row so we can verify the resolver
        # doesn't collapse onto it.
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": "1010",
            "name": "Business Checking", "type": "asset",
            "subtype": "current_asset", "active": True,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        plaid_acct = {
            "account_id": "plaid_1",
            "name": "Business Checking",
            "official_name": "Business Advantage Checking",
            "subtype": "checking",
            "type": "depository",
            "mask": "6084",
        }
        a = await plaid_connect.get_ledger_for_plaid_account(
            cid, plaid_acct, institution_name="Bank of America",
        )
        assert a["type"] == "asset"
        assert "6084" in a["name"], a["name"]
        assert "Bank of America" in a["name"]
        assert a["code"] != "1010", "should NOT collapse onto shared 1010 row"
        assert a.get("source") == "plaid_link"
    finally:
        await _cleanup(cid)


# ---------- 2. Second Plaid account on same institution → separate row ----------

async def _run_multi_accounts_same_bank():
    cid = _fresh_cid()
    try:
        a1 = await plaid_connect.get_ledger_for_plaid_account(cid, {
            "account_id": "plaid_ck", "name": "Checking", "subtype": "checking",
            "type": "depository", "mask": "6084",
        }, institution_name="Chase")
        a2 = await plaid_connect.get_ledger_for_plaid_account(cid, {
            "account_id": "plaid_sv", "name": "Savings", "subtype": "savings",
            "type": "depository", "mask": "1234",
        }, institution_name="Chase")
        assert a1["id"] != a2["id"], "Different accounts must get different CoA rows"
        assert "6084" in a1["name"]
        assert "1234" in a2["name"]
        assert "Checking" in a1["name"]
        assert "Savings" in a2["name"]
    finally:
        await _cleanup(cid)


# ---------- 3. Credit card → liability 2100-range ----------

async def _run_credit_card_creates_liability():
    cid = _fresh_cid()
    try:
        a = await plaid_connect.get_ledger_for_plaid_account(cid, {
            "account_id": "plaid_cc", "name": "Platinum Card",
            "subtype": "credit card", "type": "credit", "mask": "1005",
        }, institution_name="American Express")
        assert a["type"] == "liability"
        assert int(a["code"]) >= 2100
        assert "Credit Card" in a["name"]
        assert "1005" in a["name"]
    finally:
        await _cleanup(cid)


# ---------- 4. Re-linking same Plaid account is idempotent ----------

async def _run_relink_idempotent():
    cid = _fresh_cid()
    try:
        plaid_acct = {
            "account_id": "plaid_1", "name": "Checking",
            "subtype": "checking", "type": "depository", "mask": "6084",
        }
        a1 = await plaid_connect.get_ledger_for_plaid_account(cid, plaid_acct, "Chase")
        a2 = await plaid_connect.get_ledger_for_plaid_account(cid, plaid_acct, "Chase")
        assert a1["id"] == a2["id"], "Re-link created a duplicate row"
        # Only one Chase Checking row should exist
        rows = await db.accounts.find({
            "company_id": cid, "type": "asset",
        }).to_list(None)
        assert len(rows) == 1, f"expected 1 asset row, got {len(rows)}: {[r['name'] for r in rows]}"
    finally:
        await _cleanup(cid)


# ---------- 5. No mask + no institution → falls back to legacy shared row ----------

async def _run_synthetic_falls_back():
    """Plaid sandbox rows sometimes have no mask + no institution name.
    In that case the resolver should NOT create thousands of ···None rows —
    it must fall back to the shared subtype-mapped row.
    """
    cid = _fresh_cid()
    try:
        plaid_acct = {
            "account_id": "plaid_sandbox", "name": "Plaid Checking",
            "subtype": "checking", "type": "depository", "mask": None,
        }
        a = await plaid_connect.get_ledger_for_plaid_account(cid, plaid_acct, None)
        assert a["code"] == "1010", "fallback should use legacy 1010 row"
        assert a["name"] == "Business Checking"
    finally:
        await _cleanup(cid)


if __name__ == "__main__":
    async def _all():
        await _run_fresh_link_creates_dedicated_row()
        await _run_multi_accounts_same_bank()
        await _run_credit_card_creates_liability()
        await _run_relink_idempotent()
        await _run_synthetic_falls_back()
    asyncio.run(_all())
    print("All 5 Plaid-CoA-resolver tests passed.")
