"""One-shot backfill of `bank_balance_after` on every posted transaction.

Bug: `bank_balance_after` was only populated by the mock-onboarding seed
and by `plaid_mock` — the real Plaid ingest path never set it, so the
Transactions page's "Bank Balance" column showed "—" for every real row.
The pipeline is fixed forward-going in `plaid_connect._refresh_bank_
balances_for_account`. This script retroactively populates the field for
every posted txn on every company × bank account.

Idempotent — safe to re-run any time.
"""
import asyncio
import sys

sys.path.insert(0, '/app/backend')

from db import db
from plaid_connect import _refresh_bank_balances_for_account


async def main():
    async for c in db.companies.find({}):
        cid = c["id"]
        # Get every bank/cash account for this company (asset, 10xx)
        bank_ids = [
            a["id"] async for a in db.accounts.find({
                "company_id": cid, "type": "asset",
                "code": {"$in": ["1000", "1010", "1020", "1099", "1100"]},
            })
        ]
        if not bank_ids:
            continue
        for bank_id in bank_ids:
            # Skip if there are no txns on this bank
            n = await db.transactions.count_documents({
                "company_id": cid, "bank_account_id": bank_id, "posted": True,
            })
            if n == 0:
                continue
            await _refresh_bank_balances_for_account(cid, bank_id)
            print(f"  {c['name']:35s} bank={bank_id[:8]}  refreshed {n} txns")


if __name__ == "__main__":
    asyncio.run(main())
