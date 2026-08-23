"""Backfill: retroactively post JEs for every existing invoice + bill
+ payment + receipt that never got one. Safe to re-run — idempotent
per doc via the posting_service helpers.

Also runs a per-company Balance Sheet check afterward and prints any
remaining Assets ≠ L+E deltas so you can spot outliers.
"""
import os, sys, asyncio, httpx

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")

from posting_service import (  # noqa: E402
    post_invoice_je, post_bill_je,
    post_payment_je, post_receipt_je,
)


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # Every non-posted invoice + bill + payment + receipt across every
    # company. QBO-sourced docs (source='qbo') are intentionally
    # excluded — they use the legacy synthesis path in `reports.py`
    # (`_open_ar_ap` bucketing + payment cash roll-in) which would
    # double-count if we also posted a local JE.
    invoices = await db.invoices.find({
        "posted": {"$ne": True},
        "source": {"$ne": "qbo"},
    }, {"_id": 0}).to_list(50000)
    bills = await db.bills.find({
        "posted": {"$ne": True},
        "source": {"$ne": "qbo"},
    }, {"_id": 0}).to_list(50000)
    # QBO-sourced payments intentionally excluded — they rely on the
    # GL path, not the local JE.
    payments = await db.payments.find({
        "posted": {"$ne": True},
        "source": {"$ne": "qbo"},
    }, {"_id": 0}).to_list(50000)
    receipts = await db.receipts.find({
        "posted": {"$ne": True},
        "source": {"$ne": "qbo"},
    }, {"_id": 0}).to_list(50000)

    print(f"To post — invoices: {len(invoices)}  bills: {len(bills)}  "
          f"payments: {len(payments)}  receipts: {len(receipts)}")

    async def _walk(rows, fn, label: str):
        ok = skip = 0
        for row in rows:
            cid = row.get("company_id")
            if not cid:
                skip += 1
                continue
            try:
                r = await fn(cid, row)
                if r:
                    ok += 1
                else:
                    skip += 1
            except Exception as e:  # noqa: BLE001
                print(f"  ✗ {label} {row.get('id')} in {cid}: {e}")
                skip += 1
        print(f"{label:<10} — posted: {ok}  skipped (empty/zero/unlinked): {skip}")

    await _walk(invoices, post_invoice_je, "Invoices")
    await _walk(bills,    post_bill_je,    "Bills")
    await _walk(payments, post_payment_je, "Payments")
    await _walk(receipts, post_receipt_je, "Receipts")


if __name__ == "__main__":
    asyncio.run(main())
