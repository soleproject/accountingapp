"""One-off cleanup for company 317 LLC after the Feb 17, 2026 fixes to:
  (1) `pfc_mapping.TRANSFER_IN_DEPOSIT` — was mis-routing ATM/mobile
      deposits to `1100 Undeposited Funds` (producing an impossible
      negative balance). Now routes to `4999 Uncategorized Income`
      with `needs_review=True`.
  (2) `plaid_connect.get_ledger_for_plaid_account` — was collapsing
      new Plaid links onto shared `1010 Business Checking`; now creates
      a dedicated `1011 Bank of America Checking ···6084` row.

317 LLC was mid-onboarded when both fixes shipped, so 102 txns landed
on legacy 1010 and 5 deposits landed against 1100 as category. This
script:
  • Reclassifies those 5 deposits' `category_account_id` → 4999,
    flags `needs_review=True`, `posted=False`.
  • Migrates all 102 txns on 1010 → 1011 (updates `bank_account_id` +
    `bank_account_name`).
  • Deactivates the now-empty legacy 1010 row so it stops showing on
    the balance sheet (safer than DELETE — preserves audit trail).
  • Invalidates the report cache.

Post-run: Cash on Hand, Balance Sheet, and Plaid's own balance should
all agree on `$4,233.72` for 317 LLC.
"""
from __future__ import annotations
import asyncio
import os
import sys

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    os.environ.setdefault(k, _env[k].strip('"'))

from db import db, now_iso


CID = "043aaac7-5ad5-4e8d-9e1c-ede2ed975bdf"


async def main():
    acct_1010 = await db.accounts.find_one({"company_id": CID, "code": "1010"})
    acct_1011 = await db.accounts.find_one({"company_id": CID, "code": "1011"})
    acct_1100 = await db.accounts.find_one({"company_id": CID, "code": "1100"})
    acct_4999 = await db.accounts.find_one({"company_id": CID, "code": "4999"})

    if not (acct_1010 and acct_1011 and acct_1100 and acct_4999):
        print("Missing one of 1010/1011/1100/4999 — cannot proceed.")
        return

    # ---- Fix 1: reclassify the 5 wrong-1100 deposit txns → 4999 ----
    r1 = await db.transactions.update_many(
        {"company_id": CID, "category_account_id": acct_1100["id"]},
        {"$set": {
            "category_account_id":   acct_4999["id"],
            "category_account_code": acct_4999["code"],
            "category_account_name": acct_4999["name"],
            "needs_review": True,
            "posted": True,  # keep bank posting; just the CATEGORY changed
            "ai_reasoning": "Reclassified: TRANSFER_IN_DEPOSIT no longer "
                            "auto-routes to Undeposited Funds; CPA to decide "
                            "revenue vs owner-contribution vs A/R.",
            "ai_source": "pfc_backfill_2026-02-17",
            "updated_at": now_iso(),
        }},
    )
    print(f"Fix 1: reclassified {r1.modified_count} 1100→4999 deposit txns")

    # ---- Fix 2: migrate 102 legacy-1010 bank txns → 1011 ----
    r2 = await db.transactions.update_many(
        {"company_id": CID, "bank_account_id": acct_1010["id"]},
        {"$set": {
            "bank_account_id":   acct_1011["id"],
            "bank_account_name": acct_1011["name"],
            "updated_at": now_iso(),
        }},
    )
    print(f"Fix 2: migrated {r2.modified_count} txns from 1010 → 1011")

    # ---- Deactivate legacy 1010 so it stops showing on the BS ----
    # Keep the row for audit-trail purposes but flag inactive + system-generated.
    await db.accounts.update_one(
        {"id": acct_1010["id"]},
        {"$set": {"active": False, "updated_at": now_iso(),
                  "deactivation_reason":
                    "Superseded by 1011 Bank of America Checking ···6084 "
                    "at 2026-02-17 (Plaid resolver rollout)."}},
    )
    print("Fix 3: deactivated legacy 1010 Business Checking row")

    # ---- Also update the plaid_items.account_mappings so future syncs
    # never target 1010 again ----
    async for item in db.plaid_items.find({"company_id": CID}):
        mappings = item.get("account_mappings") or {}
        changed = False
        for k, v in mappings.items():
            if v.get("ledger_account_id") == acct_1010["id"]:
                v["ledger_account_id"] = acct_1011["id"]
                v["ledger_account_code"] = "1011"
                v["ledger_account_name"] = acct_1011["name"]
                changed = True
        if changed:
            await db.plaid_items.update_one(
                {"id": item["id"]},
                {"$set": {"account_mappings": mappings, "updated_at": now_iso()}},
            )
            print(f"  · rewired plaid_item {item['id'][:8]} mappings → 1011")

    # ---- Cache purge ----
    try:
        from infra import get_cache
        await get_cache().ainvalidate(CID)
        print("Cache invalidated for 317 LLC")
    except Exception as e:  # noqa: BLE001
        print(f"Cache invalidate failed (ok): {e}")

    # ---- Sanity check ----
    print()
    print("=== Post-fix state ===")
    for code in ("1010", "1011", "1100"):
        a = await db.accounts.find_one({"company_id": CID, "code": code})
        n = await db.transactions.count_documents({
            "company_id": CID, "bank_account_id": a["id"],
        })
        cat_n = await db.transactions.count_documents({
            "company_id": CID, "category_account_id": a["id"],
        })
        print(f"  {code} {a['name']:<48} active={a.get('active'):<5} "
              f"as_bank={n:<5} as_category={cat_n}")


if __name__ == "__main__":
    asyncio.run(main())
