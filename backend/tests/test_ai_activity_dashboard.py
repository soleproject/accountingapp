"""Regression test for the "Dashboard AI Activity only shows Transactions
Categorized" bug.

Before: `_sync_and_import` only emitted a `categorize` counter into
`db.ai_activity`. The Dashboard's AI Activity widget therefore rendered a
single row for real Plaid syncs while Skyward-Sparks demo data had 5 rows.

After: `plaid_connect.categorize_and_insert_plaid_txns` now emits
`post_je` + `flag_review` counters, and `GET /ai/activity` also derives
counters from live `transactions` / `rules` / `veryfi_uploads` counts so
existing customers whose txns were imported before the emission hooks
existed still see full history on the widget.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

from db import db  # noqa: E402
from ai_activity import log_ai_event  # noqa: E402


async def _cleanup(cid: str):
    await db.transactions.delete_many({"company_id": cid})
    await db.ai_activity.delete_many({"company_id": cid})
    await db.rules.delete_many({"company_id": cid})
    await db.veryfi_uploads.delete_many({"company_id": cid})


async def _seed_txns(cid: str, n_posted: int, n_flagged: int) -> None:
    """Seed txns as if they came through the Plaid pipeline."""
    docs = []
    for _ in range(n_posted):
        docs.append({
            "id": str(uuid.uuid4()), "company_id": cid, "amount": 1.0,
            "date": "2026-01-01", "description": "x", "merchant": "x",
            "posted": True, "needs_review": False, "source": "plaid",
        })
    for _ in range(n_flagged):
        docs.append({
            "id": str(uuid.uuid4()), "company_id": cid, "amount": 1.0,
            "date": "2026-01-01", "description": "y", "merchant": "y",
            "posted": True, "needs_review": True, "source": "plaid",
        })
    if docs:
        await db.transactions.insert_many(docs)


# ---------- 1. log_ai_event upserts + increments ----------

async def _run_log_event_upsert():
    cid = f"ai-act-{uuid.uuid4()}"
    try:
        await log_ai_event(cid, "post_je", 5)
        await log_ai_event(cid, "post_je", 3)
        await log_ai_event(cid, "flag_review", 2)
        docs = await db.ai_activity.find({"company_id": cid}).to_list(None)
        by_type = {d["type"]: d["count"] for d in docs}
        assert by_type == {"post_je": 8, "flag_review": 2}, by_type
    finally:
        await _cleanup(cid)


# ---------- 2. ai_activity endpoint derives from live truth ----------

async def _run_endpoint_derives_counts():
    """No ai_activity docs exist, but 10 posted + 3 flagged txns are present.
    The endpoint MUST synthesize both counters from the transactions collection.
    """
    from server import ai_activity as ai_activity_endpoint  # noqa: E402
    from infra import get_cache  # noqa: E402

    cid = f"ai-act-{uuid.uuid4()}"
    try:
        await _seed_txns(cid, n_posted=10, n_flagged=3)
        # Bypass company-access check by seeding minimal company + user
        await db.companies.insert_one({
            "id": cid, "name": "AI Act Test", "created_by": "test-user",
        })
        get_cache().invalidate(cid)  # clean-slate cache
        # Call the inner compute() by simulating a superadmin
        user = {"id": "test-user", "email": "t@t.t", "role": "superadmin"}
        res = await ai_activity_endpoint(cid, user=user)
        activity = res["activity"]
        by_kind = {a["type"]: a["count"] for a in activity}
        # 13 total posted (10 auto-posted + 3 flagged-but-still-posted=True)
        # so:
        #   categorize   = 13 (total txns)
        #   post_je      = 13 (posted=True)
        #   flag_review  = 3  (needs_review=True)
        assert by_kind.get("categorize")  == 13, by_kind
        assert by_kind.get("post_je")     == 13, by_kind
        assert by_kind.get("flag_review") == 3,  by_kind
        # Zero-count kinds must NOT be included
        assert "rule_created" not in by_kind
        assert "veryfi_ocr" not in by_kind
        # Totals block must match
        totals = res["totals"]
        assert totals["transactions"] == 13
        assert totals["posted"]       == 13
        assert totals["flagged"]      == 3
    finally:
        await db.companies.delete_one({"id": cid})
        await _cleanup(cid)


# ---------- 3. Preserves non-derived kinds (e.g. webhook_sync) ----------

async def _run_preserves_non_derived_kinds():
    from server import ai_activity as ai_activity_endpoint
    from infra import get_cache

    cid = f"ai-act-{uuid.uuid4()}"
    try:
        await log_ai_event(cid, "webhook_sync", 42)
        await log_ai_event(cid, "coa_generated", 7)
        await db.companies.insert_one({
            "id": cid, "name": "AI Act Test 3", "created_by": "test-user",
        })
        get_cache().invalidate(cid)
        user = {"id": "test-user", "email": "t@t.t", "role": "superadmin"}
        res = await ai_activity_endpoint(cid, user=user)
        by_kind = {a["type"]: a["count"] for a in res["activity"]}
        assert by_kind.get("webhook_sync")  == 42, by_kind
        assert by_kind.get("coa_generated") ==  7, by_kind
    finally:
        await db.companies.delete_one({"id": cid})
        await _cleanup(cid)


if __name__ == "__main__":
    async def _all():
        await _run_log_event_upsert()
        await _run_endpoint_derives_counts()
        await _run_preserves_non_derived_kinds()
    asyncio.run(_all())
    print("All 3 AI-activity tests passed.")
