"""Tests for the Firm Books duplicate-prevention (Feb 2026).

Two guardrails:
  1. `dedupe_firm_books_companies()` — startup housekeeping that
     collapses N duplicate Firm Books rows for the same Pro down to
     one (the oldest kept).
  2. Partial-unique index on `companies.(owner_user_id, is_firm_books)`
     — rejects future duplicates at the DB layer with
     DuplicateKeyError. `ensure_firm_books_company_for_pro` catches
     the error and returns the winning row so callers stay idempotent
     even under concurrent races.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from auth import hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _mk_pro() -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"p_{uid[:6]}@example.com",
        "name": "Pro", "password": hash_password("x"),
        "role": "pro",
    })
    return uid


async def _now_iso(offset_seconds: int = 0) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) +
            timedelta(seconds=offset_seconds)).isoformat()


def test_dedupe_collapses_duplicate_firm_books_rows():
    async def _t():
        uid = await _mk_pro()
        # The partial-unique index blocks new duplicates going forward,
        # but historical dupes (created before the index landed) still
        # exist in prod. Simulate that by temporarily dropping the
        # index, seeding 3 dupes, then re-creating it.
        try:
            await db.companies.drop_index("firm_books_uniq_per_pro")
        except Exception:  # noqa: BLE001
            pass
        ids = []
        for i in range(3):
            cid = str(uuid.uuid4())
            await db.companies.insert_one({
                "id": cid, "name": f"Dupe-{i} — Firm Books",
                "owner_user_id": uid, "is_firm_books": True,
                "created_at": await _now_iso(i * 10),  # older first
            })
            ids.append(cid)
        try:
            from enterprises import dedupe_firm_books_companies
            n = await dedupe_firm_books_companies()
            assert n == 2, f"expected 2 dupes removed, got {n}"
            # Only the OLDEST row survives.
            remaining = [
                c async for c in db.companies.find(
                    {"owner_user_id": uid, "is_firm_books": True},
                )
            ]
            assert len(remaining) == 1
            assert remaining[0]["id"] == ids[0]
        finally:
            await db.users.delete_one({"id": uid})
            await db.companies.delete_many({"owner_user_id": uid})
            # Restore the index for subsequent tests.
            try:
                await db.companies.create_index(
                    [("owner_user_id", 1), ("is_firm_books", 1)],
                    unique=True,
                    partialFilterExpression={"is_firm_books": True},
                    name="firm_books_uniq_per_pro",
                )
            except Exception:  # noqa: BLE001
                pass
    _run(_t())


def test_ensure_firm_books_swallows_duplicate_key_error():
    """Even under a concurrent-boot race, the helper stays idempotent
    — the losing insert catches DuplicateKeyError and returns the
    winner's row."""
    async def _t():
        uid = await _mk_pro()
        # Pre-create the "winning" row so any subsequent insert with
        # the same (owner_user_id, is_firm_books=True) key must hit
        # the partial-unique index.
        winner_id = str(uuid.uuid4())
        await db.companies.insert_one({
            "id": winner_id, "name": "Winner — Firm Books",
            "owner_user_id": uid, "is_firm_books": True,
            "onboarding_complete": True,
            "created_at": await _now_iso(),
        })
        try:
            from enterprises import ensure_firm_books_company_for_pro
            result = await ensure_firm_books_company_for_pro(uid)
            # Should return the WINNER row, not spawn a new one.
            assert result["id"] == winner_id
            count = await db.companies.count_documents(
                {"owner_user_id": uid, "is_firm_books": True},
            )
            assert count == 1
        finally:
            await db.users.delete_one({"id": uid})
            await db.companies.delete_many({"owner_user_id": uid})
    _run(_t())


def test_dedupe_is_noop_when_no_duplicates_exist():
    async def _t():
        from enterprises import dedupe_firm_books_companies
        # Run twice back-to-back — second call is guaranteed to find
        # no dupes since the first cleaned up (or there were none).
        n1 = await dedupe_firm_books_companies()
        n2 = await dedupe_firm_books_companies()
        assert n2 == 0
    _run(_t())
