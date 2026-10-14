"""Add a Wells Fargo mortgage liability-split check-in item ($2,145.67)
to Michael Co 2, LLC's open Quick Check-in batch for a demo.

Mirrors the attached WF statement: principal 812.45 + interest 1,104.22
+ escrow 210.00 + fees 19.00. Re-runnable: wipes prior rows tagged
`demo_wf_mortgage_v1` (finding, transaction, batch item) first.

    cd /app/backend && PYTHONPATH=/app/backend python scripts/seed_wf_mortgage_item.py
"""
from __future__ import annotations
import asyncio, os, uuid
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient

db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
CID = "aae4ab61-5b14-4529-a38c-fef8b747fdec"  # Michael Co 2, LLC
TAG = "demo_wf_mortgage_v1"
AMOUNT = -2145.67


async def main():
    now = datetime.now(timezone.utc)
    when = now - timedelta(days=4)
    date = when.date().isoformat()

    await db.agent_findings.delete_many({"company_id": CID, "demo_tag": TAG})
    await db.transactions.delete_many({"company_id": CID, "demo_tag": TAG})
    await db.client_review_batches.update_many(
        {"company_id": CID}, {"$pull": {"items": {"demo_tag": TAG}}})

    bank = await db.accounts.find_one({"company_id": CID, "code": "1010"}, {"id": 1, "name": 1}) \
        or await db.accounts.find_one({"company_id": CID, "type": "asset"}, {"id": 1, "name": 1}) or {}
    tid = f"demo-wf-{uuid.uuid4()}"
    await db.transactions.insert_one({
        "id": tid, "company_id": CID, "date": date, "amount": AMOUNT,
        "merchant": "Wells Fargo Home Mortgage", "description": "WELLS FARGO HOME MTG PMT 0421-889302",
        "bank_account_id": bank.get("id"), "bank_account_name": bank.get("name") or "Business Checking",
        "category_account_id": None, "needs_review": True, "human_reviewed": False, "posted": True,
        "client_question_id": None, "created_at": when.isoformat(), "updated_at": when.isoformat(),
        "demo_tag": TAG,
    })

    meta = {"txn_id": tid, "txn_amount": AMOUNT, "txn_desc": "WELLS FARGO HOME MTG PMT",
            "txn_date": date, "liability_kind": "mortgage",
            "principal": 812.45, "interest": 1104.22, "escrow": 210.00, "fees": 19.00,
            "loan_number": "0421-889302", "statement_date": "2026-09-01",
            "lender": "Wells Fargo Home Mortgage"}
    fid = f"demo-finding-{uuid.uuid4()}"
    title = "Split the $2,145.67 mortgage payment"
    detail = (f"Your mortgage payment on {date} typically splits across principal, "
              "interest, escrow and fees. Upload the statement and I'll do the math.")
    await db.agent_findings.insert_one({
        "id": fid, "company_id": CID, "kind": "liability_split_needed", "title": title,
        "detail": detail, "severity": "amber", "meta": meta, "contact_id": None,
        "action_label": "Upload statement", "status": "open",
        "created_at": when.isoformat(), "updated_at": when.isoformat(), "demo_tag": TAG,
    })

    batch = await db.client_review_batches.find_one(
        {"company_id": CID, "status": "open"}, sort=[("created_at", -1)])
    if not batch:
        print("no open batch for Michael Co 2"); return 2
    item = {
        "item_id": str(uuid.uuid4()), "item_type": 9, "source_id": fid,
        "source_collection": "agent_findings", "prompt": detail,
        "context": {"kind": "liability_split_needed", "title": title, "severity": "amber", "meta": meta},
        "answered_at": None, "answer": None, "deferred": False, "action_taken": None,
        "tier": "current", "age_days": 4, "attachments": [], "client_messages": [], "messages": [],
        "demo_tag": TAG,
    }
    # Insert right after the first type-9 item so the three liability items sit together.
    items = batch["items"]
    idx = next((i for i, it in enumerate(items) if it.get("item_type") == 9), len(items))
    items.insert(idx, item)
    await db.client_review_batches.update_one(
        {"id": batch["id"]}, {"$set": {"items": items, "updated_at": now.isoformat()}})
    print(f"added WF mortgage item to batch {batch['id']} ({len(items)} items) · txn {tid}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
