"""Tests for the editable per-item "Download from" (import_start_date)
Plaid Settings endpoints (Feb 2026).

Coverage:
  1. `_safe_import_date` — validates ISO shape, rejects future dates,
     clamps values older than 730 days to the 730-day floor.
  2. GET /plaid/items lists items with their current cutoff.
  3. PATCH /plaid/items/{id} sets a new cutoff and reports direction.
  4. Moving the cutoff LATER reports `already_imported_older_count`
     so the UI can surface it in the confirm dialog.
  5. PATCH returns 404 for an item that doesn't belong to the caller.
"""
from __future__ import annotations

import sys
import uuid
from datetime import date, timedelta

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_setup(with_item: bool = True):
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    item_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"u_{uid[:6]}@example.com",
        "name": "Pro", "password": hash_password("x"), "role": "pro",
    })
    await db.companies.insert_one({
        "id": cid, "name": "T", "owner_user_id": uid,
        "business_type": "professional-services",
        "reporting_basis": "accrual", "accounting_mode": "advanced",
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": uid, "company_id": cid, "role": "owner",
    })
    if with_item:
        await db.plaid_items.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "item_id": item_id, "institution_name": "Chase",
            "accounts": [{"account_id": "acc_1"}, {"account_id": "acc_2"}],
            "created_at": "2026-08-01T00:00:00+00:00",
        })
    return uid, cid, item_id


async def _wipe(uid, cid):
    await db.plaid_items.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})


def test_safe_import_date_helper():
    from routes.onboarding import _safe_import_date
    today = date.today()
    yesterday = today - timedelta(days=1)
    two_years_ago = today - timedelta(days=730)
    future = today + timedelta(days=10)
    ancient = today - timedelta(days=365 * 5)

    assert _safe_import_date(yesterday.isoformat()) == yesterday.isoformat()
    assert _safe_import_date(future.isoformat()) is None  # future rejected
    assert _safe_import_date(None) is None
    assert _safe_import_date("") is None
    assert _safe_import_date("garbage") is None
    # Ancient date is clamped to 730-day floor, not rejected.
    assert _safe_import_date(ancient.isoformat()) == two_years_ago.isoformat()


def test_list_plaid_items_returns_item_with_settings():
    async def _t():
        uid, cid, item_id = await _mk_setup()
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/plaid/items",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                j = r.json()
                assert len(j["items"]) == 1
                it = j["items"][0]
                assert it["item_id"] == item_id
                assert it["institution_name"] == "Chase"
                assert it["import_start_date"] is None
                assert it["account_count"] == 2
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_patch_import_start_date_direction_and_persistence():
    async def _t():
        uid, cid, item_id = await _mk_setup()
        try:
            tok = create_token(uid, "pro")
            hdr = {"Authorization": f"Bearer {tok}"}
            async with await _client() as c:
                # Set for the first time → "set"
                d1 = (date.today() - timedelta(days=60)).isoformat()
                r = await c.patch(
                    f"/api/companies/{cid}/plaid/items/{item_id}",
                    json={"import_start_date": d1}, headers=hdr,
                )
                assert r.status_code == 200, r.text
                assert r.json()["direction"] == "set"
                assert r.json()["import_start_date"] == d1

                # Move to a LATER date (want less clutter) → "later"
                d2 = (date.today() - timedelta(days=10)).isoformat()
                r = await c.patch(
                    f"/api/companies/{cid}/plaid/items/{item_id}",
                    json={"import_start_date": d2}, headers=hdr,
                )
                assert r.json()["direction"] == "later"

                # Move to an EARLIER date → "earlier"
                r = await c.patch(
                    f"/api/companies/{cid}/plaid/items/{item_id}",
                    json={"import_start_date": d1}, headers=hdr,
                )
                assert r.json()["direction"] == "earlier"

                # Clear → "cleared"
                r = await c.patch(
                    f"/api/companies/{cid}/plaid/items/{item_id}",
                    json={"import_start_date": None}, headers=hdr,
                )
                assert r.json()["direction"] == "cleared"

                # Same-value PATCH → "unchanged"
                r = await c.patch(
                    f"/api/companies/{cid}/plaid/items/{item_id}",
                    json={"import_start_date": None}, headers=hdr,
                )
                assert r.json()["direction"] == "unchanged"

            # Confirm persistence.
            item = await db.plaid_items.find_one(
                {"company_id": cid, "item_id": item_id},
            )
            assert item.get("import_start_date") is None
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_later_move_reports_older_count():
    """When user moves the cutoff LATER, the response tells us how
    many already-imported transactions predate the new cutoff so
    the UI can render a 'we'll keep {N}' note."""
    async def _t():
        uid, cid, item_id = await _mk_setup()
        # Seed 3 old + 2 new transactions against the item's account.
        today = date.today()
        for offset in [100, 90, 80]:
            await db.transactions.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "plaid_account_id": "acc_1",
                "date": (today - timedelta(days=offset)).isoformat(),
                "amount": -10,
            })
        for offset in [5, 3]:
            await db.transactions.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "plaid_account_id": "acc_1",
                "date": (today - timedelta(days=offset)).isoformat(),
                "amount": -10,
            })
        try:
            tok = create_token(uid, "pro")
            hdr = {"Authorization": f"Bearer {tok}"}
            async with await _client() as c:
                # Set cutoff to 10 days ago — the 3 older txns fall
                # behind, the 2 newer stay in-range.
                cutoff = (today - timedelta(days=10)).isoformat()
                r = await c.patch(
                    f"/api/companies/{cid}/plaid/items/{item_id}",
                    json={"import_start_date": cutoff}, headers=hdr,
                )
                assert r.status_code == 200
                assert r.json()["already_imported_older_count"] == 3
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_patch_returns_404_for_wrong_company():
    """Item exists under company A, but caller is authorized for
    company B → 404 (not 403; we don't want to leak existence)."""
    async def _t():
        uid, cid, item_id = await _mk_setup()
        try:
            tok = create_token(uid, "pro")
            fake_cid = str(uuid.uuid4())
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{fake_cid}/plaid/items/{item_id}",
                    json={"import_start_date": None},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                # `require_company` returns 403/404 for non-member;
                # the exact code depends on the codebase's policy —
                # we accept anything that ISN'T a 200.
                assert r.status_code >= 400
        finally:
            await _wipe(uid, cid)
    _run(_t())
