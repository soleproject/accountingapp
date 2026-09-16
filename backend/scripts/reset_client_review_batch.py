"""Reset a client-review batch so all questions become unanswered again.

Usage:
    cd /app/backend && python -m scripts.reset_client_review_batch <token>

Clears every per-item response marker (answered_at, deferred, attachments,
AI analyses, chat history, check-assignments) and resets batch-level
counters/status back to "open" so the same client link can be walked
through end-to-end again.

Read-only against every collection *except* `client_review_batches` — no
other data (transactions, contacts, receipts, etc.) is touched.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone

import os

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME   = os.environ["DB_NAME"]

# Per-item fields that get populated as the client walks through the flow.
# Clearing them returns the item to its freshly-seeded state.
ITEM_FIELDS_TO_UNSET = [
    "answered_at",
    "answer",
    "action_taken",
    "action_detail",
    "deferred",
    "deferred_at",
    "deferred_note",
    "w9_email_sent_to",
    "w9_email_resend_id",
    "attachments",
    "receipt_analysis",
    "categorization_analysis",
    "liability_analysis",
    "messages",
    "client_messages",
    "resolved_txn_ids",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def reset(token: str) -> None:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    batch = await db.client_review_batches.find_one({"client_token": token})
    if not batch:
        print(f"[reset] No batch found for token={token!r}")
        return

    items = batch.get("items") or []
    print(f"[reset] Batch id={batch.get('id')}  items={len(items)}  "
          f"answer_count={batch.get('answer_count')}  "
          f"defer_count={batch.get('defer_count')}  "
          f"status={batch.get('status')!r}")

    # Build a positional $unset for every item + every field.
    unset: dict[str, str] = {}
    for idx in range(len(items)):
        for field in ITEM_FIELDS_TO_UNSET:
            unset[f"items.{idx}.{field}"] = ""

    result = await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {
            "$unset": {
                **unset,
                "completed_at": "",
            },
            "$set": {
                "answer_count": 0,
                "defer_count":  0,
                "status":       "open",
                "updated_at":   _now_iso(),
            },
        },
    )
    print(f"[reset] Modified: {result.modified_count}")
    print(f"[reset] Done — token {token} is fresh, walk it again.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python -m scripts.reset_client_review_batch <token>")
        sys.exit(1)
    asyncio.run(reset(sys.argv[1]))
