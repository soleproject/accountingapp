"""One-shot migration — stamp every existing `companies` row with the
US region defaults so the entire ledger has a well-defined region
before Phase 1 introduces UK-specific behavior.

Idempotent: safe to run multiple times. Only touches docs that are
MISSING `region`, so re-running after Phase 0 launch is a no-op.

Usage:
    cd /app/backend
    python -m scripts.backfill_region

Prints a single JSON summary line so it's greppable in CI logs.
"""
from __future__ import annotations

import asyncio
import json

from db import db
from regions import defaults_for


async def _run() -> dict:
    defaults = defaults_for("US")  # explicit — every legacy company is US
    total = await db.companies.count_documents({})
    to_update = await db.companies.count_documents({"region": {"$exists": False}})
    result = await db.companies.update_many(
        {"region": {"$exists": False}},
        {"$set": defaults},
    )
    return {
        "total_companies": total,
        "missing_region_before": to_update,
        "modified": result.modified_count,
        "defaults_applied": defaults,
    }


if __name__ == "__main__":
    summary = asyncio.run(_run())
    print(json.dumps(summary))
