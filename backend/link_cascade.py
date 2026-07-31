"""Cascade helpers for deleting invoices, bills, and transactions.

Keeps the auto-payment / link graph consistent when one node is deleted:

- **Invoice / bill delete** → any auto-payments pointing at that doc
  are removed, and any transaction that was linked TO those payments
  gets its `linked_payment_id` + doc-side link cleared (no balance
  reversal needed — the doc is gone).

- **Transaction delete** → if the txn owns an auto-payment
  (linked_payment_id points at it), we reverse that payment's balance
  impact on the doc and delete the payment. The doc's balance and
  status flip back so reports stay honest.
"""
from __future__ import annotations
from db import db, now_iso


async def _reverse_payment_impact(cid: str, payment: dict) -> None:
    """Add the payment amount back to the linked doc's balance_due
    and flip status to reflect the new balance. Used when deleting a
    txn that owns an auto-payment. Does not touch the payment row
    itself — the caller handles that.
    """
    amt = float(payment.get("amount") or 0)
    inv_id = payment.get("linked_invoice_id")
    bill_id = payment.get("linked_bill_id")
    if inv_id:
        inv = await db.invoices.find_one({"id": inv_id, "company_id": cid})
        if inv:
            bal = round(float(inv.get("balance_due") or 0) + amt, 2)
            total = float(inv.get("total") or 0)
            st = "sent" if bal >= total - 0.01 else "partial"
            await db.invoices.update_one({"id": inv_id},
                {"$set": {"balance_due": bal, "status": st, "updated_at": now_iso()}})
    if bill_id:
        bill = await db.bills.find_one({"id": bill_id, "company_id": cid})
        if bill:
            bal = round(float(bill.get("balance_due") or 0) + amt, 2)
            total = float(bill.get("total") or 0)
            st = "open" if bal >= total - 0.01 else "partial"
            await db.bills.update_one({"id": bill_id},
                {"$set": {"balance_due": bal, "status": st, "updated_at": now_iso()}})


async def cascade_on_doc_delete(cid: str, kind: str, doc_id: str) -> dict:
    """Delete any payments linked to this invoice/bill and clean up any
    transaction back-refs. Returns counts for logging/testing.
    """
    field = "linked_invoice_id" if kind == "invoice" else "linked_bill_id"
    payments = await db.payments.find({"company_id": cid, field: doc_id}).to_list(2000)
    if not payments:
        return {"payments_deleted": 0, "transactions_cleared": 0}
    pids = [p["id"] for p in payments]
    # Clear back-references on any txn that owns one of these payments.
    txn_field_clear = {"linked_payment_id": None, field: None, "updated_at": now_iso()}
    txn_res = await db.transactions.update_many(
        {"company_id": cid, "linked_payment_id": {"$in": pids}},
        {"$set": txn_field_clear},
    )
    await db.payments.delete_many({"company_id": cid, "id": {"$in": pids}})
    return {"payments_deleted": len(pids), "transactions_cleared": txn_res.modified_count}


async def cascade_on_transaction_delete(cid: str, txn: dict) -> dict:
    """If the transaction owns an auto-payment, reverse the payment's
    doc-balance impact and delete the payment. Returns counts.
    """
    pid = txn.get("linked_payment_id")
    if not pid:
        return {"payments_deleted": 0}
    payment = await db.payments.find_one({"id": pid, "company_id": cid})
    if not payment:
        return {"payments_deleted": 0}
    await _reverse_payment_impact(cid, payment)
    await db.payments.delete_one({"id": pid, "company_id": cid})
    return {"payments_deleted": 1}
