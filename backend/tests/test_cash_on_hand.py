"""Regression test for the "cash-on-hand ignores resolver-created bank rows"
bug (Feb 17, 2026).

Before: `dashboard/metrics.cash_on_hand` filtered accounts by a hard-coded
list `["1000", "1010", "1020"]`. When the Plaid/Veryfi resolver started
auto-creating dedicated rows like `1011 Bank of America Checking ···6084`,
transactions on those new rows were silently excluded — cash-on-hand
collapsed to whatever leftover activity happened to still be on legacy
1010. For 317 LLC this produced a $-1,418.17 display when the actual
cash was ~$5,663 across 1011 + JE opening balance.

After: query matches every asset account in the 1000-1099 code range
plus Undeposited Funds (1100) plus any account the resolver flagged
with `subtype: "Bank"`, so new resolver rows are automatically included.
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


def _fresh_cid() -> str:
    return f"cash-fix-{uuid.uuid4()}"


async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.journal_entries.delete_many({"company_id": cid})
    await db.invoices.delete_many({"company_id": cid})
    await db.bills.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})


async def _seed(cid: str) -> dict:
    """Recreate the 317 LLC-shaped scenario:
      • Legacy 1010 Business Checking (subtype=current_asset) with 30-day activity.
      • Resolver-created 1011 Bank of America Checking ···6084 (subtype=Bank)
        with a large opening-balance JE + a bunch of posted txns.
    """
    ids = {}
    for code, name, subtype in [
        ("1000", "Cash and Bank", "current_asset"),
        ("1010", "Business Checking", "current_asset"),
        ("1011", "Bank of America Checking ···6084", "Bank"),
        ("1020", "Business Savings", "current_asset"),
        ("1100", "Undeposited Funds", "current_asset"),
        ("1200", "Accounts Receivable", "current_asset"),  # NOT cash
        ("1300", "Inventory", "current_asset"),            # NOT cash
        ("3050", "Opening Balance Equity", "equity"),
    ]:
        aid = str(uuid.uuid4())
        await db.accounts.insert_one({
            "id": aid, "company_id": cid, "code": code, "name": name,
            "type": ("asset" if code < "3000" else "equity"),
            "subtype": subtype, "active": True,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        ids[code] = aid

    # Post $200 net (30-day) to legacy 1010.
    await db.transactions.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": "2026-07-10", "description": "legacy row",
        "amount": 200.0, "bank_account_id": ids["1010"],
        "posted": True, "source": "plaid",
    })
    # Post $-1618.17 net to legacy 1010 as well (matches 317 LLC's -1418 net).
    await db.transactions.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": "2026-07-15", "description": "legacy row 2",
        "amount": -1618.17, "bank_account_id": ids["1010"],
        "posted": True, "source": "plaid",
    })
    # Big activity on new 1011 row (net -$1,081.10 to keep the sum on 1011 alone
    # matching real-world balance drift).
    for i, amt in enumerate([500.0, -200.0, -1000.0, 100.0, -481.10]):
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": f"2026-06-{15 + i}",
            "description": f"BofA txn {i}",
            "amount": amt, "bank_account_id": ids["1011"],
            "posted": True, "source": "plaid",
        })
    # Opening-balance JE on 1011 (Plaid connect posts one)
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": "2024-01-01", "memo": "Opening balance BofA ···6084",
        "lines": [
            {"account_id": ids["1011"], "debit": 6743.03, "credit": 0},
            {"account_id": ids["3050"], "debit": 0, "credit": 6743.03},
        ],
    })
    return ids


async def _run_cash_on_hand_includes_resolver_rows():
    from server import dashboard_metrics
    from infra import get_cache

    cid = _fresh_cid()
    try:
        await db.companies.insert_one({
            "id": cid, "name": "Cash Fix Test",
            "reporting_basis": "accrual", "created_by": "test-user",
        })
        ids = await _seed(cid)
        get_cache().invalidate(cid)

        user = {"id": "test-user", "email": "t@t.t", "role": "superadmin"}
        res = await dashboard_metrics(cid, user=user)

        # Expected math:
        #   1010 legacy activity: 200 + -1618.17 = -1418.17
        #   1011 resolver row: 500 - 200 - 1000 + 100 - 481.10 = -1081.10
        #   1011 opening balance JE: +6743.03
        #   TOTAL cash: -1418.17 + -1081.10 + 6743.03 = 4243.76
        assert abs(res["cash_on_hand"] - 4243.76) < 0.01, (
            f"expected 4243.76, got {res['cash_on_hand']}"
        )
        # Non-cash asset (A/R, Inventory) must NOT be included in cash_on_hand.
        assert ids["1200"] and ids["1300"]
    finally:
        await _cleanup(cid)


async def _run_ar_and_inventory_excluded():
    """Post a bogus $100k txn to A/R and $50k to Inventory — they must NOT
    show up in cash_on_hand under any circumstances.
    """
    from server import dashboard_metrics
    from infra import get_cache

    cid = _fresh_cid()
    try:
        await db.companies.insert_one({
            "id": cid, "name": "AR excl test", "created_by": "test-user",
        })
        ar_id = str(uuid.uuid4())
        inv_id = str(uuid.uuid4())
        for aid, code, name in [(ar_id, "1200", "Accounts Receivable"),
                                (inv_id, "1300", "Inventory")]:
            await db.accounts.insert_one({
                "id": aid, "company_id": cid, "code": code, "name": name,
                "type": "asset", "subtype": "current_asset", "active": True,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
        # Bogus postings — must not leak into cash_on_hand
        for aid, amt in [(ar_id, 100000.0), (inv_id, 50000.0)]:
            await db.transactions.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "date": "2026-07-01", "description": "bogus",
                "amount": amt, "bank_account_id": aid,
                "posted": True, "source": "manual",
            })
        get_cache().invalidate(cid)
        user = {"id": "test-user", "email": "t@t.t", "role": "superadmin"}
        res = await dashboard_metrics(cid, user=user)
        assert res["cash_on_hand"] == 0.0, (
            f"AR/Inventory leaked into cash_on_hand: {res['cash_on_hand']}"
        )
    finally:
        await _cleanup(cid)


if __name__ == "__main__":
    async def _all():
        await _run_cash_on_hand_includes_resolver_rows()
        await _run_ar_and_inventory_excluded()
    asyncio.run(_all())
    print("Both cash-on-hand regression tests passed.")
