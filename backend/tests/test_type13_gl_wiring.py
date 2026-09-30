"""End-to-end test for Type 13 (Checks-w/out-Payee) GL wiring.

Flow verified:
  1. Seed a check txn + a bill for a company.
  2. Build a synthetic Type-13 batch item pointing at that check.
  3. Call apply_check_assign with a bill_id → verify:
     - txn.posted == True
     - db.payments doc exists with source="client_review_check_assign"
     - bill.balance_due decremented + status flipped
     - item.action_taken == "check_assigned"
  4. Call reopen_review_item → verify:
     - db.payments doc deleted
     - bill.balance_due restored
     - txn state restored to pre-assign snapshot
     - item.resolved_txn_ids cleared
"""
import asyncio, sys, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")


async def main():
    import routes.client_review as cr
    from routes.client_review import db
    import client_review as cr_root  # ITEM_CHECK_NO_CONTACT constant lives here

    NS = f"type13-test-{uuid.uuid4().hex[:6]}"
    cid = f"co-{NS}"
    now = cr._now_iso()

    # --- Seed
    txn_id  = f"txn-{NS}"
    bill_id = f"bill-{NS}"
    vend_id = f"vend-{NS}"

    await db.transactions.insert_one({
        "id": txn_id, "company_id": cid,
        "date": "2026-05-15", "amount": -500.00,
        "description": "CHECK #1234",
        "bank_txn_type": "check",
        "bank_account_id": "bank-x", "check_number": "1234",
        "posted": False, "needs_review": True, "human_reviewed": False,
        "contact_id": None, "contact_name": None,
        "category_account_id": None, "splits": None,
    })
    await db.contacts.insert_one({
        "id": vend_id, "company_id": cid,
        "name": "Test Vendor", "type": "vendor",
        "created_at": now, "updated_at": now,
    })
    await db.bills.insert_one({
        "id": bill_id, "company_id": cid,
        "contact_id": vend_id, "total": 500.00,
        "balance_due": 500.00, "status": "open",
        "bill_number": "B-1", "date": "2026-05-01",
        "applied_check_txn_ids": [],
    })

    batch = {
        "id": f"batch-{NS}", "company_id": cid,
        "items": [{
            "item_id":   f"item-{NS}",
            "item_type": cr_root.ITEM_CHECK_NO_CONTACT,
            "context":   {"checks": [{"id": txn_id, "amount": 500.00,
                                       "date": "2026-05-15",
                                       "description": "CHECK #1234"}]},
        }],
        "client_token": "test-token",
    }
    await db.client_review_batches.insert_one(batch)
    item = batch["items"][0]

    print("[+] Seeded — txn/bill/contact/batch/item all inserted")

    # --- Step 1: assign
    body = cr.CheckAssignBody(
        txn_id=txn_id,
        contact_id=vend_id,
        create_contact_name=None,
        line_items=[cr.CheckAssignLine(
            category_account_id=None,
            bill_id=bill_id,
            amount=500.00,
            description="rent for May",
        )],
    )
    res = await cr.apply_check_assign(batch, item, body)
    print(f"[+] apply_check_assign returned: {res}")

    # --- Verify GL
    t  = await db.transactions.find_one({"id": txn_id})
    b  = await db.bills.find_one({"id": bill_id})
    it_batch = await db.client_review_batches.find_one({"id": batch["id"]})
    it = it_batch["items"][0]
    payments = await db.payments.find({"source_transaction_id": txn_id}).to_list(10)

    checks = [
        ("txn.posted == True",                    t.get("posted") is True),
        ("txn.human_reviewed == True",            t.get("human_reviewed") is True),
        ("txn.contact_id set",                    t.get("contact_id") == vend_id),
        ("txn.splits has 1 line",                 len(t.get("splits") or []) == 1),
        ("txn.linked_payment_ids has 1 entry",    len(t.get("linked_payment_ids") or []) == 1),
        ("txn._pre_check_assign_posted stored",   t.get("_pre_check_assign_posted") is False),
        ("bill.balance_due == 0",                 (b.get("balance_due") is not None and abs(float(b.get("balance_due"))) < 0.005)),
        ("bill.status == 'paid'",                 b.get("status") == "paid"),
        ("bill.applied_check_txn_ids includes txn", txn_id in (b.get("applied_check_txn_ids") or [])),
        ("db.payments doc created",               len(payments) == 1),
        ("payment.linked_bill_id matches",        payments and payments[0].get("linked_bill_id") == bill_id),
        ("payment.source is client_review_check_assign",
                                                  payments and payments[0].get("source") == "client_review_check_assign"),
        ("item.action_taken == 'check_assigned'", it.get("action_taken") == "check_assigned"),
        ("item.resolved_txn_ids includes txn",    txn_id in (it.get("resolved_txn_ids") or [])),
        ("item.answered_at set (all done)",       bool(it.get("answered_at"))),
    ]
    fails = [n for (n, ok) in checks if not ok]
    for n, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
    assert not fails, f"Assign-phase failures: {fails}"

    # --- Step 2: reopen — replicate reset_quick_checkins pattern
    async def _fake_resolve(_tok):
        return await db.client_review_batches.find_one({"id": batch["id"]})
    original = cr._resolve_batch
    cr._resolve_batch = _fake_resolve
    try:
        reo = await cr.reopen_review_item(batch["client_token"], item["item_id"])
        print(f"[+] reopen returned: {reo}")
    finally:
        cr._resolve_batch = original

    # --- Verify reversal
    t2 = await db.transactions.find_one({"id": txn_id})
    b2 = await db.bills.find_one({"id": bill_id})
    it_batch2 = await db.client_review_batches.find_one({"id": batch["id"]})
    it2 = it_batch2["items"][0]
    payments2 = await db.payments.find({"source_transaction_id": txn_id}).to_list(10)

    reversal_checks = [
        ("txn.posted restored to False",          t2.get("posted") is False),
        ("txn.human_reviewed restored to False",  t2.get("human_reviewed") is False),
        ("txn.contact_id cleared",                t2.get("contact_id") is None),
        ("txn.splits cleared",                    (t2.get("splits") or None) is None),
        ("txn.linked_payment_ids unset",          "linked_payment_ids" not in t2),
        ("txn.assigned_via unset",                "assigned_via" not in t2),
        ("txn snapshot fields unset",             "_pre_check_assign_posted" not in t2),
        ("bill.balance_due restored to 500",      abs(float(b2.get("balance_due") or 0) - 500.0) < 0.005),
        ("bill.status back to 'open'",            b2.get("status") == "open"),
        ("bill.applied_check_txn_ids emptied",    txn_id not in (b2.get("applied_check_txn_ids") or [])),
        ("db.payments doc deleted",               len(payments2) == 0),
        ("item.resolved_txn_ids cleared",         not it2.get("resolved_txn_ids")),
        ("item.answered_at cleared",              not it2.get("answered_at")),
        ("item.action_taken cleared",             not it2.get("action_taken")),
    ]
    fails2 = [n for (n, ok) in reversal_checks if not ok]
    for n, ok in reversal_checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
    assert not fails2, f"Reversal-phase failures: {fails2}"

    print("\n[✓] All Type 13 GL + reopen assertions passed")

    # --- Cleanup
    await db.transactions.delete_one({"id": txn_id})
    await db.contacts.delete_one({"id": vend_id})
    await db.bills.delete_one({"id": bill_id})
    await db.client_review_batches.delete_one({"id": batch["id"]})
    await db.payments.delete_many({"source_transaction_id": txn_id})


if __name__ == "__main__":
    asyncio.run(main())
