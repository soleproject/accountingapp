"""Regression: background Plaid syncs stamp company_id on ai_usage ContextVar.

Feb 2026 — previously any LLM / Veryfi / Resend event raised inside a
`sync_jobs` task (Plaid webhook or manual sync) landed in ai_usage_events
with company_id=None because the FastAPI auth dependency that normally
sets the ContextVar was skipped in background context. Fix stamps the
context in two spots (belt + suspenders):

  1. `job_queue._run_wrapped` — every registered background task.
  2. `deps.sync_and_import` — direct callers that bypass the queue.
"""
from __future__ import annotations
import asyncio
import os
import sys

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

import ai_usage  # noqa: E402
import job_queue  # noqa: E402


def _ctx_company_from_task():
    """Capture whatever ai_usage sees at the moment the task body runs."""
    return ai_usage._ctx_company_id()


def test_job_wrapper_stamps_company_id():
    """_run_wrapped must set ai_usage ContextVar before invoking the task."""
    async def _go():
        captured = {}

        async def fake_task(job_id: str, company_id: str, **kw):
            captured["company_id"] = ai_usage._ctx_company_id()
            captured["user_id"] = ai_usage._ctx_user_id()

        # Insert a matching sync_jobs row so _run_wrapped can read user_id.
        from db import db, now_iso
        job_id = "test-job-attribution-1"
        await db.sync_jobs.delete_many({"id": job_id})
        await db.sync_jobs.insert_one({
            "id": job_id, "company_id": "cid-abc", "user_id": "uid-xyz",
            "kind": "test", "status": "queued", "kwargs": {},
            "created_at": now_iso(), "updated_at": now_iso(),
        })

        # Run inside a fresh task so the ContextVar snapshot is isolated
        # (mirrors what asyncio.create_task does in enqueue_job).
        await asyncio.create_task(
            job_queue._run_wrapped(fake_task, job_id, "cid-abc", {}),
        )
        await db.sync_jobs.delete_one({"id": job_id})

        assert captured.get("company_id") == "cid-abc", captured
        assert captured.get("user_id") == "uid-xyz", captured

    asyncio.run(_go())


def test_sync_and_import_stamps_company_id():
    """deps.sync_and_import stamps company_id even when no plaid item resolves."""
    async def _go():
        # Fresh context — nothing pre-stamped.
        ai_usage._current_company_id.set(None)
        ai_usage._current_user_id.set(None)

        # Feed a fake plaid_item — sync_and_import will fail early inside
        # plaid_service.sync_transactions with an invalid access_token,
        # returning 0. That's fine — we only care that the stamp runs BEFORE
        # the sync call, so it survives the early-return branch.
        from deps import sync_and_import
        await sync_and_import("cid-def", {"id": "x", "access_token": "invalid",
                                          "cursor": None})
        assert ai_usage._ctx_company_id() == "cid-def"

    asyncio.run(_go())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK: {name}")
    print("\nAll background-sync attribution tests passed.")
