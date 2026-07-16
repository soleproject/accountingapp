"""One-shot repair: fix txns whose category IS the bank account (self-
cancelling JEs). Root-caused to the PFC pipeline previously gating out
`fallback_uncategorized` and letting LLM re-pick bank code 1010 for
`TRANSFER_IN/OUT_ACCOUNT_TRANSFER`. The pipeline is now fixed; this script
retroactively re-routes any pre-existing bad rows to the uncategorized bucket
for accountant review.

Idempotent — safe to re-run.

Usage: python -m tests.repair_self_cancelling_txns
"""
import asyncio
import sys
from collections import Counter
sys.path.insert(0, '/app/backend')

from db import db, now_iso
import categorizer


async def repair_company(company_id: str) -> dict:
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by_id = {a["id"]: a for a in accts}
    by_code = {a["code"]: a for a in accts}

    # A "self-cancelling" txn has category_account_id == bank_account_id
    # OR category is any 4-digit code starting "10" (cash/bank asset).
    def _is_bank_code(code):
        return code and str(code).startswith("10") and len(str(code)) == 4

    bad = []
    async for t in db.transactions.find({"company_id": company_id}):
        cat_id = t.get("category_account_id")
        bank_id = t.get("bank_account_id")
        cat = by_id.get(cat_id) if cat_id else None
        if cat and (cat_id == bank_id or _is_bank_code(cat.get("code"))):
            bad.append(t)

    if not bad:
        return {"scanned": 0, "repaired": 0}

    # Ensure uncategorized buckets exist
    uncat_exp, uncat_inc = await categorizer.ensure_uncategorized_accounts(company_id)

    repaired = 0
    for t in bad:
        # Direction: negative amount = expense side; positive = income side
        bucket = uncat_inc if t["amount"] >= 0 else uncat_exp
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {
                "category_account_id":   bucket["id"],
                "category_account_code": bucket["code"],
                "category_account_name": bucket["name"],
                "needs_review":          True,
                "ai_source":             "uncategorized",
                "ai_reasoning": (
                    "Auto-repaired: category was the bank account itself "
                    f"({(by_id.get(t.get('category_account_id')) or {}).get('code','?')}), "
                    f"which produced a self-cancelling JE. Routed to "
                    f"{bucket['code']} {bucket['name']} for accountant review. "
                    f"Prior reasoning: {t.get('ai_reasoning', '')}"
                ),
                "updated_at": now_iso(),
            }},
        )
        repaired += 1

    return {
        "scanned": len(bad), "repaired": repaired,
        "by_pfc": dict(Counter(t.get("pfc_detailed") for t in bad)),
    }


async def main():
    # Scan every company. Idempotent — no-op on already-clean orgs.
    async for c in db.companies.find({}):
        res = await repair_company(c["id"])
        if res["scanned"]:
            print(f"{c['name']:35s} → scanned={res['scanned']}  repaired={res['repaired']}  by_pfc={res.get('by_pfc')}")

if __name__ == "__main__":
    asyncio.run(main())
