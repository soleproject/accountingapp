"""Backfill script — March 2026 GAAP cash-basis fix.

For every production company, fix the two data classes affected by the
Feb-2026 bank-txn ↔ invoice/bill link bug:

  A. Bank transactions with `linked_invoice_id` where category still
     points to Revenue/etc — override to Accounts Receivable, set
     posted=True, preserve prior category on `_pre_link_category_id`.
     Symmetrical for `linked_bill_id` → Accounts Payable.

  B. Auto-created payments (`source_transaction_id` set) that lack
     an explicit `direction` field — fill in `in` for invoice-linked,
     `out` for bill-linked.

Usage:
    # Dry-run: preview per-company impact.
    python -m scripts.backfill_linked_txn_gl_parity

    # Apply.
    python -m scripts.backfill_linked_txn_gl_parity --apply
"""
import asyncio
import sys
from collections import defaultdict

from db import db


async def _resolve_canonical(company_id: str, kind: str) -> dict | None:
    typ = "asset" if kind == "invoice" else "liability"
    regex = (r"^accounts\s*receivable\b|^a/?r\b" if kind == "invoice"
              else r"^accounts\s*payable\b|^a/?p\b")
    return await db.accounts.find_one({
        "company_id": company_id, "type": typ,
        "name": {"$regex": regex, "$options": "i"},
    })


async def _companies():
    return [c async for c in db.companies.find({}, {"id": 1, "name": 1})]


async def _scan(apply: bool):
    stats = defaultdict(lambda: {"txn_fixed": 0, "pay_fixed": 0, "skipped": 0})
    grand_txn = grand_pay = 0

    for c in await _companies():
        cid, cname = c["id"], c.get("name") or "(unnamed)"
        ar = await _resolve_canonical(cid, "invoice")
        ap = await _resolve_canonical(cid, "bill")

        # ── A. Bank txns pointing at the wrong category ────────────
        for kind, target_acct, id_field in (
            ("invoice", ar, "linked_invoice_id"),
            ("bill",    ap, "linked_bill_id"),
        ):
            if not target_acct:
                continue
            async for t in db.transactions.find({
                "company_id": cid,
                id_field: {"$nin": [None, ""]},
                # Only fix txns whose category is NOT already the
                # canonical A/R (invoice) or A/P (bill). Idempotent.
                "category_account_id": {"$ne": target_acct["id"]},
            }):
                grand_txn += 1
                stats[cname]["txn_fixed"] += 1
                if apply:
                    upd = {
                        "category_account_id": target_acct["id"],
                        "category_account_code": target_acct.get("code") or "",
                        "category_account_name": target_acct.get("name") or "",
                        "posted": True,
                        "direction": "in" if kind == "invoice" else "out",
                    }
                    # Preserve pre-link category only on first migration.
                    if t.get("category_account_id") and not t.get("_pre_link_category_id"):
                        upd["_pre_link_category_id"]   = t.get("category_account_id")
                        upd["_pre_link_category_code"] = t.get("category_account_code")
                        upd["_pre_link_category_name"] = t.get("category_account_name")
                        upd["_pre_link_posted"]        = t.get("posted")
                    await db.transactions.update_one(
                        {"id": t["id"], "company_id": cid}, {"$set": upd})

        # ── B. Auto-payments missing direction ─────────────────────
        for id_field, direction in (
            ("linked_invoice_id", "in"),
            ("linked_bill_id",    "out"),
        ):
            r = await db.payments.count_documents({
                "company_id": cid,
                "direction": {"$exists": False},
                id_field: {"$nin": [None, ""]},
            })
            grand_pay += r
            stats[cname]["pay_fixed"] += r
            if apply and r:
                await db.payments.update_many(
                    {"company_id": cid,
                     "direction": {"$exists": False},
                     id_field: {"$nin": [None, ""]}},
                    {"$set": {"direction": direction}})

    return stats, grand_txn, grand_pay


async def main():
    apply = "--apply" in sys.argv
    mode = "APPLY" if apply else "DRY-RUN"
    print(f"═══ {mode} · GAAP cash-basis fix backfill ═══\n")
    stats, gt, gp = await _scan(apply)
    for name, s in sorted(stats.items(), key=lambda kv: -kv[1]["txn_fixed"] - kv[1]["pay_fixed"]):
        if s["txn_fixed"] or s["pay_fixed"]:
            print(f"  {name:60}  txns={s['txn_fixed']:3}  pays={s['pay_fixed']:3}")
    print(f"\nTOTAL — {gt} transactions, {gp} payments across "
           f"{sum(1 for v in stats.values() if v['txn_fixed'] or v['pay_fixed'])} companies.")
    if not apply:
        print("\nDry-run only. Re-run with `--apply` to commit.")


if __name__ == "__main__":
    asyncio.run(main())
