"""Tests for the Partner Books duplicate-prevention (Feb 2026).

Mirrors `test_firm_books_dedupe.py`. Two guardrails:
  1. `dedupe_partner_books_companies()` — startup housekeeping that
     collapses N duplicate Partner Books rows for the same Partner
     down to one (the oldest kept).
  2. Partial-unique index on `companies.(partner_id, is_partner_books)`
     — rejects future duplicates at the DB layer with
     DuplicateKeyError. `ensure_partner_books_company_for_partner`
     catches the error and returns the winning row so callers stay
     idempotent even under concurrent races.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from auth import hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _mk_partner() -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"pt_{uid[:6]}@example.com",
        "name": "Partner", "password": hash_password("x"),
        "role": "partner",
        "branding": {"firm_name": "Test Partner"},
    })
    return uid


async def _now_iso(offset_seconds: int = 0) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) +
            timedelta(seconds=offset_seconds)).isoformat()


def test_dedupe_collapses_duplicate_partner_books_rows():
    async def _t():
        uid = await _mk_partner()
        try:
            await db.companies.drop_index("partner_books_uniq_per_partner")
        except Exception:  # noqa: BLE001
            pass
        ids = []
        for i in range(3):
            cid = str(uuid.uuid4())
            await db.companies.insert_one({
                "id": cid, "name": f"Dupe-{i} — Partner Books",
                "owner_user_id": uid, "partner_id": uid,
                "is_partner_books": True,
                "created_at": await _now_iso(i * 10),  # older first
            })
            ids.append(cid)
        try:
            from partners import dedupe_partner_books_companies
            n = await dedupe_partner_books_companies()
            assert n == 2, f"expected 2 dupes removed, got {n}"
            remaining = [
                c async for c in db.companies.find(
                    {"partner_id": uid, "is_partner_books": True},
                )
            ]
            assert len(remaining) == 1
            assert remaining[0]["id"] == ids[0]
        finally:
            await db.users.delete_one({"id": uid})
            await db.companies.delete_many({"owner_user_id": uid})
            try:
                await db.companies.create_index(
                    [("partner_id", 1), ("is_partner_books", 1)],
                    unique=True,
                    partialFilterExpression={"is_partner_books": True},
                    name="partner_books_uniq_per_partner",
                )
            except Exception:  # noqa: BLE001
                pass
    _run(_t())


def test_ensure_partner_books_swallows_duplicate_key_error():
    """Even under a concurrent-boot race, the helper stays idempotent
    — the losing insert catches DuplicateKeyError and returns the
    winner's row."""
    async def _t():
        uid = await _mk_partner()
        winner_id = str(uuid.uuid4())
        await db.companies.insert_one({
            "id": winner_id, "name": "Winner — Partner Books",
            "owner_user_id": uid, "partner_id": uid,
            "is_partner_books": True,
            "onboarding_complete": True,
            "created_at": await _now_iso(),
        })
        try:
            from partners import ensure_partner_books_company_for_partner
            result = await ensure_partner_books_company_for_partner(uid)
            assert result is not None
            assert result["id"] == winner_id
            count = await db.companies.count_documents(
                {"partner_id": uid, "is_partner_books": True},
            )
            assert count == 1
        finally:
            await db.users.delete_one({"id": uid})
            await db.companies.delete_many({"owner_user_id": uid})
    _run(_t())


def test_partner_books_dedupe_is_noop_when_no_duplicates_exist():
    async def _t():
        from partners import dedupe_partner_books_companies
        n1 = await dedupe_partner_books_companies()
        n2 = await dedupe_partner_books_companies()
        assert n2 == 0
    _run(_t())
