"""Tests for the QBO migration completion email (Feb 2026).

Coverage:
  1. Template renders successfully with realistic stats + brand.
  2. Template gracefully drops rows for missing / zero stats.
  3. Failed template surfaces the raw error string (truncated).
  4. `_notify_migration_result` is a no-op when the job has no
     `initiating_user_id` (older jobs pre-feature) — never raises.
  5. `_notify_migration_result` dispatches with the initiating user's
     branding cascaded to the email footer (via dispatcher).
  6. POST /qbo/migrations stamps `initiating_user_id` on the job doc
     so the background task can find the recipient later.
"""
from __future__ import annotations

import sys
import uuid
from unittest.mock import patch, AsyncMock

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ─── Template tests (pure) ────────────────────────────────────────────

def test_qbo_migration_complete_template_renders_stats_and_brand():
    from email_templates import qbo_migration_complete
    subject, html = qbo_migration_complete(
        name="Michael",
        company_name="Skyward Sparks, LLC",
        dashboard_url="https://cypher.accountingapp.ai/connections/qbo",
        stats={
            "transactions_posted": 292,
            "transactions_categorized": 280,
            "payments_linked": 42,
            "opening_inventory_value": 12345.6789,
        },
        brand_name="CypherPro",
    )
    assert "Skyward Sparks" in subject
    assert "QuickBooks migration complete" in subject
    # Every non-zero stat surfaced.
    assert "292" in html
    assert "280" in html
    assert "42" in html
    assert "12,345.68" in html  # formatted with thousands sep + 2dp
    # Brand cascades into the footer via _wrap.
    assert "CypherPro" in html
    # SmartBooks footer is dropped when brand is set (per _wrap).
    assert "smartbookssoftware.ai" not in html


def test_qbo_migration_complete_drops_zero_and_missing_rows():
    from email_templates import qbo_migration_complete
    _, html = qbo_migration_complete(
        name="A", company_name="B", dashboard_url="http://x",
        stats={"transactions_posted": 5, "payments_linked": 0,
                "mirror_estimates_pulled": None},
        brand_name=None,
    )
    # 5 is present, but the 0 and None rows should NOT appear as
    # empty rows in the table.
    assert "5" in html
    # No "0" cell next to any label — a rough proxy: the labels for
    # zero-value stats must NOT be rendered.
    assert "Payments linked" not in html
    assert "Estimates pulled" not in html


def test_qbo_migration_failed_template_shows_error():
    from email_templates import qbo_migration_failed
    subject, html = qbo_migration_failed(
        name="Michael", company_name="Skyward",
        error="QBO 429: rate limit exceeded",
        dashboard_url="https://x",
        brand_name="CypherPro",
    )
    assert "needs attention" in subject.lower()
    assert "rate limit" in html
    assert "CypherPro" in html


def test_qbo_migration_failed_truncates_long_errors():
    from email_templates import qbo_migration_failed
    _, html = qbo_migration_failed(
        name="A", company_name="B",
        error="x" * 1000, dashboard_url="http://x", brand_name=None,
    )
    # Should be capped at 400 chars per the template.
    assert "x" * 400 in html
    assert "x" * 500 not in html


# ─── Dispatch integration ─────────────────────────────────────────────

def test_notify_migration_result_noops_without_initiating_user():
    """Legacy jobs (pre-feature) have no `initiating_user_id`. The
    notifier must silently no-op — never raise, never dispatch."""
    async def _t():
        job_id = str(uuid.uuid4())
        cid = str(uuid.uuid4())
        await db.qbo_jobs.insert_one({
            "job_id": job_id, "company_id": cid,
            "status": "done",
            # NO initiating_user_id — legacy row.
        })
        try:
            with patch("email_dispatcher.dispatch",
                        new_callable=AsyncMock) as dispatch_mock:
                from qbo_service import _notify_migration_result
                # Should not raise, should not dispatch.
                await _notify_migration_result(job_id, cid, ok=True)
                assert dispatch_mock.await_count == 0
        finally:
            await db.qbo_jobs.delete_one({"job_id": job_id})
    _run(_t())


def test_notify_migration_result_dispatches_branded_complete_email():
    """Happy-path: `_notify_migration_result` looks up the user, picks
    the branded template, and calls `email_dispatcher.dispatch` with
    the right kind + recipient."""
    async def _t():
        uid = str(uuid.uuid4())
        cid = str(uuid.uuid4())
        job_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": "m@example.com", "name": "Michael",
            "password": hash_password("x"), "role": "pro",
            "branding": {"firm_name": "CypherPro", "subdomain": "cypher"},
        })
        await db.companies.insert_one({
            "id": cid, "name": "Skyward Sparks, LLC",
        })
        await db.qbo_jobs.insert_one({
            "job_id": job_id, "company_id": cid, "status": "done",
            "initiating_user_id": uid,
            "transactions_posted": 100, "payments_linked": 5,
        })
        try:
            with patch("email_dispatcher.dispatch",
                        new_callable=AsyncMock) as dispatch_mock:
                dispatch_mock.return_value = {"status": "sent", "id": "x"}
                from qbo_service import _notify_migration_result
                await _notify_migration_result(job_id, cid, ok=True)
                assert dispatch_mock.await_count == 1
                kwargs = dispatch_mock.await_args.kwargs
                assert kwargs["kind"] == "qbo_migration_complete"
                assert kwargs["to"] == "m@example.com"
                assert "Skyward Sparks" in kwargs["subject"]
                # Branding cascade — verified via the HTML body carrying
                # the firm name (dispatcher itself picks the From by
                # reading initiating_user_id's branding).
                assert "CypherPro" in kwargs["html"]
                assert kwargs["initiating_user_id"] == uid
                assert kwargs["company_id"] == cid
        finally:
            await db.users.delete_one({"id": uid})
            await db.companies.delete_one({"id": cid})
            await db.qbo_jobs.delete_one({"job_id": job_id})
    _run(_t())


def test_notify_migration_result_dispatches_failed_email_with_error():
    async def _t():
        uid = str(uuid.uuid4())
        cid = str(uuid.uuid4())
        job_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": "m@example.com", "name": "Michael",
            "password": hash_password("x"), "role": "pro",
        })
        await db.companies.insert_one({"id": cid, "name": "Skyward"})
        await db.qbo_jobs.insert_one({
            "job_id": job_id, "company_id": cid, "status": "failed",
            "initiating_user_id": uid,
        })
        try:
            with patch("email_dispatcher.dispatch",
                        new_callable=AsyncMock) as dispatch_mock:
                dispatch_mock.return_value = {"status": "sent", "id": "x"}
                from qbo_service import _notify_migration_result
                await _notify_migration_result(
                    job_id, cid, ok=False, error="QBO 500: internal",
                )
                assert dispatch_mock.await_count == 1
                kwargs = dispatch_mock.await_args.kwargs
                assert kwargs["kind"] == "qbo_migration_failed"
                assert "QBO 500: internal" in kwargs["html"]
        finally:
            await db.users.delete_one({"id": uid})
            await db.companies.delete_one({"id": cid})
            await db.qbo_jobs.delete_one({"job_id": job_id})
    _run(_t())


# ─── Route integration ────────────────────────────────────────────────

def test_start_migration_stamps_initiating_user_id_on_job():
    """The `initiating_user_id` field is critical — it's how
    `run_migration` (running AFTER the HTTP request ends) finds who
    to email. Test the POST /qbo/migrations route stamps it."""
    async def _t():
        uid = str(uuid.uuid4())
        cid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": "u@example.com", "name": "Pro",
            "password": hash_password("x"), "role": "pro",
        })
        await db.companies.insert_one({
            "id": cid, "name": "Test", "owner_user_id": uid,
            "business_type": "professional-services",
            "reporting_basis": "accrual", "accounting_mode": "advanced",
        })
        await db.memberships.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": uid, "company_id": cid, "role": "owner",
        })
        # Fake an active QBO connection so the route lets us in.
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "12345",
            "env": "sandbox", "environment": "sandbox",
            "status": "connected",
            "access_token_enc": b"fake",
            "refresh_token_enc": b"fake",
            "access_expires_at": "2099-01-01T00:00:00+00:00",
            "refresh_expires_at": "2099-01-01T00:00:00+00:00",
        })
        try:
            tok = create_token(uid, "pro")
            # Mock the background task so it doesn't actually run.
            with patch("qbo_service.run_migration",
                        new_callable=AsyncMock):
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/qbo/migrations",
                        headers={"Authorization": f"Bearer {tok}"},
                    )
                    assert r.status_code == 200, r.text
                    job_id = r.json()["job_id"]

            job = await db.qbo_jobs.find_one({"job_id": job_id})
            assert job is not None
            assert job.get("initiating_user_id") == uid
        finally:
            await db.qbo_jobs.delete_many({"company_id": cid})
            await db.qbo_connections.delete_many({"company_id": cid})
            await db.users.delete_one({"id": uid})
            await db.companies.delete_one({"id": cid})
            await db.memberships.delete_many({"user_id": uid})
    _run(_t())
