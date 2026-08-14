"""Tests for /qbo/status persistence (Feb 2026 rollout — "keep the
Migration complete card visible on page revisit" per user feedback).

Coverage:
  1. /qbo/preview caches `preview_counts` on the connection row.
  2. /qbo/status echoes back the cached preview + the most recent
     terminal job so the frontend can rehydrate the UI on revisit.
  3. In-flight (queued / running) jobs are NOT returned as last_job —
     they'd wipe the "Migration complete" card and confuse the user.
  4. Stale-marked jobs are excluded (future-proofing for re-connect
     to a different realm).
"""
from __future__ import annotations

import sys
import uuid
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_setup():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
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
    return uid, cid


async def _wipe(uid, cid):
    await db.qbo_jobs.delete_many({"company_id": cid})
    await db.qbo_connections.delete_many({"company_id": cid})
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})


def test_preview_endpoint_caches_counts_on_connection_row():
    async def _t():
        uid, cid = await _mk_setup()
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "1", "env": "sandbox",
            "environment": "sandbox", "status": "connected",
            "access_token_enc": b"x", "refresh_token_enc": b"x",
            "access_expires_at": "2099-01-01T00:00:00+00:00",
            "refresh_expires_at": "2099-01-01T00:00:00+00:00",
        })
        try:
            tok = create_token(uid, "pro")
            fake_counts = {"Account": 98, "Customer": 33, "Vendor": 86}
            with patch("qbo_service.preview_counts",
                        new_callable=AsyncMock) as mock_pc:
                mock_pc.return_value = fake_counts
                async with await _client() as c:
                    r = await c.get(
                        f"/api/companies/{cid}/qbo/preview",
                        headers={"Authorization": f"Bearer {tok}"},
                    )
                    assert r.status_code == 200, r.text
                    assert r.json()["total"] == 217  # 98 + 33 + 86

            conn = await db.qbo_connections.find_one({"company_id": cid})
            assert conn.get("preview_counts") == fake_counts
            assert conn.get("preview_total") == 217
            assert conn.get("preview_at") is not None
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_status_returns_cached_preview_and_last_terminal_job():
    async def _t():
        uid, cid = await _mk_setup()
        # Simulate a company that already ran preview + a done migration.
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "9341457676905998",
            "env": "sandbox", "environment": "sandbox",
            "status": "connected",
            "access_token_enc": b"x", "refresh_token_enc": b"x",
            "access_expires_at": "2099-01-01T00:00:00+00:00",
            "refresh_expires_at": "2099-01-01T00:00:00+00:00",
            "preview_counts": {"Account": 98, "Customer": 33},
            "preview_total": 131,
            "preview_at": "2026-08-11T04:00:00+00:00",
        })
        old_job = str(uuid.uuid4())
        new_job = str(uuid.uuid4())
        # An older done job — should NOT be the winner.
        await db.qbo_jobs.insert_one({
            "job_id": old_job, "company_id": cid, "status": "done",
            "transactions_posted": 1,
            "created_at": "2026-08-01T00:00:00+00:00",
        })
        # The winner — newest terminal job.
        await db.qbo_jobs.insert_one({
            "job_id": new_job, "company_id": cid, "status": "done",
            "transactions_posted": 368, "opening_inventory_value": 346.25,
            "created_at": "2026-08-11T04:07:00+00:00",
        })
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/qbo/status",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                j = r.json()
                assert j["connected"] is True
                # Cached preview echoed back.
                assert j["preview"] is not None
                assert j["preview"]["counts"] == {"Account": 98, "Customer": 33}
                assert j["preview"]["total"] == 131
                # Most-recent terminal job returned — old one ignored.
                assert j["last_job"]["job_id"] == new_job
                assert j["last_job"]["transactions_posted"] == 368
                assert j["last_job"]["opening_inventory_value"] == 346.25
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_status_excludes_in_flight_jobs_from_last_job():
    """A queued or running job must NOT appear as `last_job` — that
    would wipe the "Migration complete" card during an active poll."""
    async def _t():
        uid, cid = await _mk_setup()
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "1", "env": "sandbox",
            "environment": "sandbox", "status": "connected",
            "access_token_enc": b"x", "refresh_token_enc": b"x",
            "access_expires_at": "2099-01-01T00:00:00+00:00",
            "refresh_expires_at": "2099-01-01T00:00:00+00:00",
        })
        old_done = str(uuid.uuid4())
        running = str(uuid.uuid4())
        await db.qbo_jobs.insert_one({
            "job_id": old_done, "company_id": cid, "status": "done",
            "transactions_posted": 100,
            "created_at": "2026-08-01T00:00:00+00:00",
        })
        await db.qbo_jobs.insert_one({
            "job_id": running, "company_id": cid, "status": "running",
            "created_at": "2026-08-15T00:00:00+00:00",  # newer
        })
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/qbo/status",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                assert r.json()["last_job"]["job_id"] == old_done
        finally:
            await _wipe(uid, cid)
    _run(_t())


def test_status_excludes_stale_marked_jobs():
    """Future-proof: a `stale: true` job (e.g. from a previous realm
    on a re-connect) is not surfaced."""
    async def _t():
        uid, cid = await _mk_setup()
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "1", "env": "sandbox",
            "environment": "sandbox", "status": "connected",
            "access_token_enc": b"x", "refresh_token_enc": b"x",
            "access_expires_at": "2099-01-01T00:00:00+00:00",
            "refresh_expires_at": "2099-01-01T00:00:00+00:00",
        })
        stale_job = str(uuid.uuid4())
        await db.qbo_jobs.insert_one({
            "job_id": stale_job, "company_id": cid, "status": "done",
            "transactions_posted": 999, "stale": True,
            "created_at": "2026-08-15T00:00:00+00:00",
        })
        try:
            tok = create_token(uid, "pro")
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/qbo/status",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200
                assert r.json()["last_job"] is None
        finally:
            await _wipe(uid, cid)
    _run(_t())
