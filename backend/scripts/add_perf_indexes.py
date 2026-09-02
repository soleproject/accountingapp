"""One-shot performance-index migration (Feb 2026).

Backs off the MongoDB Atlas Query-Targeting alert (ratio ~1,144) by
adding indexes that back the hot-path queries that were previously
doing collection scans:

  * `rules`          — none beyond `_id`. Every /rules endpoint scanned.
  * `transactions.contact_id`  — no index. Contact-learning, /rules/related
                                 distinct(merchant), reports all scanned.
  * `transactions.merchant`    — no index. /rules/needs-review scanned.
  * `transactions.category_account_code` — no index. Account Detail scanned.
  * `rule_candidates` — none beyond `_id`. Rule-miner + suggest-from-txns scanned.

Safe to re-run (all indexes use `background=True` / `create_index` which
is idempotent — repeat calls are no-ops when the index already exists).

Run with:
    cd /app/backend && python -m scripts.add_perf_indexes
"""
from __future__ import annotations
import asyncio
import sys
sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402


async def main():
    # ── rules ──
    print("Creating rule indexes...")
    await db.rules.create_index(
        [("company_id", 1), ("enabled", 1), ("priority", -1)],
        name="rules_company_enabled_priority",
        background=True,
    )
    await db.rules.create_index(
        [("company_id", 1), ("match_field", 1), ("match_value", 1)],
        name="rules_company_matchfield_matchvalue",
        background=True,
    )
    await db.rules.create_index(
        [("company_id", 1), ("hits", 1)],
        name="rules_company_hits",
        background=True,
    )
    await db.rules.create_index(
        [("id", 1)],
        name="rules_id_uniq",
        unique=True,
        background=True,
    )

    # ── transactions ──
    print("Creating transaction indexes...")
    # Powers contact_learning.get_learned_category (hottest new query).
    await db.transactions.create_index(
        [("company_id", 1), ("contact_id", 1), ("human_reviewed", 1),
         ("posted", 1), ("date", -1)],
        name="txn_learning_hotpath",
        background=True,
    )
    # Powers /rules/needs-review + /rules/related distinct(merchant).
    await db.transactions.create_index(
        [("company_id", 1), ("merchant", 1), ("updated_at", -1)],
        name="txn_company_merchant_updated",
        background=True,
    )
    # Powers Account Detail (/reports/account-detail) and category
    # roll-ups.
    await db.transactions.create_index(
        [("company_id", 1), ("category_account_code", 1), ("date", -1)],
        name="txn_company_category_date",
        background=True,
    )
    # Powers CleanupCopilot needs_review + ai_source filters.
    await db.transactions.create_index(
        [("company_id", 1), ("ai_source", 1)],
        name="txn_company_ai_source",
        background=True,
        sparse=True,
    )

    # ── rule_candidates ──
    print("Creating rule_candidates indexes...")
    await db.rule_candidates.create_index(
        [("company_id", 1), ("merchant", 1), ("account_code", 1)],
        name="candidates_company_merchant_account",
        background=True,
    )
    await db.rule_candidates.create_index(
        [("company_id", 1), ("approvals", -1)],
        name="candidates_company_approvals",
        background=True,
    )

    print("\nDone. Current indexes:")
    for coll in ["rules", "transactions", "rule_candidates"]:
        idx = await db[coll].index_information()
        print(f"\n  {coll}:")
        for name in idx:
            print(f"    · {name}")


if __name__ == "__main__":
    asyncio.run(main())
