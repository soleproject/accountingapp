"""One-shot cleanup for QBO 27 LLC: fixes the 4 stranded transactions
where `txn_type` got flipped from SalesReceipt → Deposit but the
`qbo_id` still points at a QBO SalesReceipt.

Run once, then re-run dry-run — those 4 records should reconcile as
`sales_receipts: In sync: 4`.

Usage: python /app/backend/scripts/fix_stranded_sr_deposits.py <company_id>
"""
import asyncio
import sys
sys.path.insert(0, "/app/backend")

STRANDED_QBO_IDS = ["11", "17", "38", "47"]


async def main():
    from db import db
    if len(sys.argv) < 2:
        # Default to the QBO 27 LLC company in the sandbox.
        cid = await _find_qbo27()
        if not cid:
            print("Usage: fix_stranded_sr_deposits.py <company_id>")
            return
    else:
        cid = sys.argv[1]
    fixed = 0
    async for t in db.transactions.find(
        {"company_id": cid,
          "txn_type": "Deposit",
          "qbo_id": {"$in": STRANDED_QBO_IDS}},
    ):
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {"txn_type": "SalesReceipt",
                       "direction": "in"}},
        )
        print(f"Fixed txn {t['id']} qbo_id={t['qbo_id']} number={t.get('number')}")
        fixed += 1
    print(f"\nDone. Fixed {fixed} records.")


async def _find_qbo27():
    from db import db
    c = await db.companies.find_one({"name": {"$regex": "QBO 27"}})
    return c and c.get("id")


if __name__ == "__main__":
    asyncio.run(main())
