"""Regression test: parent-account drill-down includes descendant subs.

Guards the invariant that clicking a parent row on the Balance Sheet
(a "roll-up" row like ``1010 · Business Checking (+1 sub)``) surfaces
transactions from every child sub-account as well — not just those
posted directly to the parent's id. Otherwise the drill shows $0/0
txns while the BS row shows a non-zero balance, which is a real
production issue that confuses CPAs.
"""
from __future__ import annotations
import os
import sys
import uuid
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import dotenv_values
_env = dotenv_values(str(Path(__file__).resolve().parent.parent / ".env"))
for k in ("MONGO_URL", "DB_NAME", "VERYFI_CLIENT_ID", "VERYFI_USERNAME",
          "VERYFI_API_KEY", "VERYFI_CLIENT_SECRET"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

import pytest
from db import db  # noqa: E402
from reports import compute_account_detail  # noqa: E402


@pytest.mark.asyncio
async def test_parent_drilldown_includes_sub_account_txns():
    """Parent account with a sub-account that has transactions:
    drilling on the parent must return the sub's transactions."""
    cid = f"testco-{uuid.uuid4().hex[:8]}"
    parent_id = f"acct-parent-{uuid.uuid4().hex[:6]}"
    child_id = f"acct-child-{uuid.uuid4().hex[:6]}"
    other_id = f"acct-other-{uuid.uuid4().hex[:6]}"
    try:
        await db.accounts.insert_many([
            {"id": parent_id, "company_id": cid, "code": "1010",
             "name": "Business Checking", "type": "asset",
             "parent_account_id": None, "active": True},
            {"id": child_id, "company_id": cid, "code": "1010.01",
             "name": "Business Checking - ATM Card", "type": "asset",
             "parent_account_id": parent_id, "active": True},
            {"id": other_id, "company_id": cid, "code": "1020",
             "name": "Savings", "type": "asset",
             "parent_account_id": None, "active": True},
        ])
        await db.transactions.insert_many([
            # 1 posted to parent directly
            {"id": f"txn-{uuid.uuid4().hex[:6]}", "company_id": cid,
             "posted": True, "date": "2026-01-05",
             "description": "PARENT DIRECT", "amount": 500.00,
             "bank_account_id": parent_id},
            # 2 posted to the child sub-account
            {"id": f"txn-{uuid.uuid4().hex[:6]}", "company_id": cid,
             "posted": True, "date": "2026-01-06",
             "description": "CHILD ATM 1", "amount": -60.00,
             "bank_account_id": child_id},
            {"id": f"txn-{uuid.uuid4().hex[:6]}", "company_id": cid,
             "posted": True, "date": "2026-01-07",
             "description": "CHILD ATM 2", "amount": -40.00,
             "bank_account_id": child_id},
            # 1 to a completely different account (must NOT appear)
            {"id": f"txn-{uuid.uuid4().hex[:6]}", "company_id": cid,
             "posted": True, "date": "2026-01-08",
             "description": "SAVINGS", "amount": 200.00,
             "bank_account_id": other_id},
        ])

        # Drill on the PARENT → all 3 (parent's + both children's) show up
        result = await compute_account_detail(cid, parent_id)
        descriptions = sorted(r["description"] for r in result["rows"])
        assert descriptions == ["CHILD ATM 1", "CHILD ATM 2", "PARENT DIRECT"], \
            f"parent drill should include child sub-account txns; got {descriptions}"
        assert result["count"] == 3

        # Drill on the CHILD → only child's 2 rows (never leaks up to sibling)
        child_result = await compute_account_detail(cid, child_id)
        child_descs = sorted(r["description"] for r in child_result["rows"])
        assert child_descs == ["CHILD ATM 1", "CHILD ATM 2"], \
            f"child drill should be scoped to child only; got {child_descs}"

    finally:
        # Cleanup
        await db.accounts.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
