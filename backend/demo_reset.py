"""Demo reset helpers — re-mint the Wells Fargo mortgage liability-split
check-in item for a company so the split flow can be demoed repeatedly."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone, timedelta

from db import db

WF_TAG = "demo_wf_mortgage_v1"
WF_AMOUNT = -2145.67


async def reset_wf_mortgage_item(cid: str) -> dict:
    now = datetime.now(timezone.utc)
    when = now - timedelta(days=4)
    date = when.date().isoformat()

    await db.agent_findings.delete_many({"company_id": cid, "demo_tag": WF_TAG})
    await db.transactions.delete_many({"company_id": cid, "demo_tag": WF_TAG})
    await db.client_review_batches.update_many(
        {"company_id": cid}, {"$pull": {"items": {"demo_tag": WF_TAG}}})

    bank = await db.accounts.find_one({"company_id": cid, "code": "1010"}, {"id": 1, "name": 1}) \
        or await db.accounts.find_one({"company_id": cid, "type": "asset"}, {"id": 1, "name": 1}) or {}
    tid = f"demo-wf-{uuid.uuid4()}"
    await db.transactions.insert_one({
        "id": tid, "company_id": cid, "date": date, "amount": WF_AMOUNT,
        "merchant": "Wells Fargo Home Mortgage", "description": "WELLS FARGO HOME MTG PMT 0421-889302",
        "bank_account_id": bank.get("id"), "bank_account_name": bank.get("name") or "Business Checking",
        "category_account_id": None, "needs_review": True, "human_reviewed": False, "posted": True,
        "client_question_id": None, "created_at": when.isoformat(), "updated_at": when.isoformat(),
        "demo_tag": WF_TAG,
    })

    meta = {"txn_id": tid, "txn_amount": WF_AMOUNT, "txn_desc": "WELLS FARGO HOME MTG PMT",
            "txn_date": date, "liability_kind": "mortgage",
            "principal": 812.45, "interest": 1104.22, "escrow": 210.00, "fees": 19.00,
            "loan_number": "0421-889302", "statement_date": "2026-09-01",
            "lender": "Wells Fargo Home Mortgage"}
    fid = f"demo-finding-{uuid.uuid4()}"
    title = "Split the $2,145.67 mortgage payment"
    detail = (f"Your mortgage payment on {date} typically splits across principal, "
              "interest, escrow and fees. Upload the statement and I'll do the math.")
    await db.agent_findings.insert_one({
        "id": fid, "company_id": cid, "kind": "liability_split_needed", "title": title,
        "detail": detail, "severity": "amber", "meta": meta, "contact_id": None,
        "action_label": "Upload statement", "status": "open",
        "created_at": when.isoformat(), "updated_at": when.isoformat(), "demo_tag": WF_TAG,
    })

    batch = await db.client_review_batches.find_one(
        {"company_id": cid, "status": "open"}, sort=[("created_at", -1)])
    item = {
        "item_id": str(uuid.uuid4()), "item_type": 9, "source_id": fid,
        "source_collection": "agent_findings", "prompt": detail,
        "context": {"kind": "liability_split_needed", "title": title, "severity": "amber", "meta": meta},
        "answered_at": None, "answer": None, "deferred": False, "action_taken": None,
        "tier": "current", "age_days": 4, "attachments": [], "client_messages": [], "messages": [],
        "demo_tag": WF_TAG,
    }
    if batch:
        items = batch["items"]
        idx = next((i for i, it in enumerate(items) if it.get("item_type") == 9), len(items))
        items.insert(idx, item)
        await db.client_review_batches.update_one(
            {"id": batch["id"]}, {"$set": {"items": items, "updated_at": now.isoformat()}})
        batch_id = batch["id"]
    else:
        company = await db.companies.find_one({"id": cid}, {"client_email": 1}) or {}
        batch_id = f"demo-wf-batch-{uuid.uuid4()}"
        await db.client_review_batches.insert_one({
            "id": batch_id, "company_id": cid,
            "client_email": company.get("client_email") or "client@example.test",
            "client_token": uuid.uuid4().hex, "status": "open", "items": [item],
            "answer_count": 0, "created_at": now.isoformat(), "updated_at": now.isoformat(),
            "demo_tag": WF_TAG,
        })
    return {"batch_id": batch_id, "item_id": item["item_id"], "transaction_id": tid}
