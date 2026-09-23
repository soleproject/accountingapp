"""Cleanup scan + scheduler (Feb 2026).

Verifies the end-to-end cleanup workflow:
1. Historical scan surfaces txns that match the three flag criteria
2. Items are inserted into a `kind: "cleanup"` batch (dedupe safe)
3. Responsibilities endpoint returns cleanup buckets ONLY when non-empty
4. Kickoff endpoint is idempotent and gates on user auth + membership
"""
from __future__ import annotations
import sys
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import hash_password  # noqa
from tests._shared_loop import run as _run  # noqa
from cleanup_scan import run_scan_for_company  # noqa
from client_review import ITEM_MISSING_RECEIPT, ITEM_LIABILITY_SPLIT  # noqa


async def _mk_env():
    """Seed a tenant + a mix of historical, current-day, and threshold-
    edge transactions so we can verify the scan picks the right ones."""
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    liab_id = str(uuid.uuid4())

    await db.users.insert_one({
        "id": uid, "email": f"m_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
        "name": "Cleanup Owner",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Cleanup Co.", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "compliance_flags": {
            "flag_irs_docs": False,
            "flag_receipts": True, "flag_receipts_months": 12,
            "flag_split_liabilities": True, "flag_split_liabilities_months": 12,
        },
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    await db.accounts.insert_one({
        "id": liab_id, "company_id": cid, "name": "Amex Card", "type": "liability",
    })

    today_iso = datetime.now(timezone.utc).date().isoformat()
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    two_months_ago = (datetime.now(timezone.utc).date() - timedelta(days=60)).isoformat()

    # Two historical expense txns > $75 with no receipts (should match)
    await db.transactions.insert_many([
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -120.00, "date": yesterday, "description": "Office supplies"},
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -300.00, "date": two_months_ago,
         "description": "Software subscription"},
        # Historical but under threshold — should NOT match
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -50.00, "date": yesterday, "description": "Snacks"},
        # Today — strictly historical filter excludes it
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -500.00, "date": today_iso, "description": "New laptop"},
        # Has attachment — excluded
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -200.00, "date": yesterday, "description": "Legit",
         "attachments": [{"id": "a1", "url": "..."}]},
    ])
    # Two historical liability-account expenses w/o split_reviewed (should match)
    await db.transactions.insert_many([
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -1500.00, "date": yesterday,
         "category_account_id": liab_id, "description": "Amex payment"},
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -2500.00, "date": two_months_ago,
         "category_account_id": liab_id, "description": "Amex payment"},
        # Already reviewed — excluded
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "expense",
         "amount": -900.00, "date": yesterday,
         "category_account_id": liab_id, "split_reviewed": True},
    ])
    return uid, cid


async def _cleanup(uid, cid):
    for col in ("transactions", "accounts", "client_review_batches",
                "cleanup_jobs", "memberships", "agent_findings"):
        await db[col].delete_many({"company_id": cid} if col != "memberships"
                                    else {"user_id": uid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def test_scan_finds_historical_only():
    async def _t():
        uid, cid = await _mk_env()
        try:
            job = {"company_id": cid, "flags": {"receipts": True, "liabilities": True, "irs": False},
                    "months": {"receipts": 12, "liabilities": 12}}
            result = await run_scan_for_company(job)
            assert result["created"] is True
            # 2 receipt items + 2 liability items = 4
            assert result["items_total"] == 4, result

            batch = await db.client_review_batches.find_one({"company_id": cid, "kind": "cleanup"})
            assert batch is not None
            assert batch["status"] == "open"
            types = [i["item_type"] for i in batch["items"]]
            assert types.count(ITEM_MISSING_RECEIPT) == 2
            assert types.count(ITEM_LIABILITY_SPLIT) == 2

            # Dedupe on re-scan — no new items added.
            result2 = await run_scan_for_company(job)
            assert result2["created"] is False
            assert result2["items_added"] == 0
            assert result2["items_total"] == 4
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_responsibilities_returns_cleanup_bucket_only_when_populated():
    async def _t():
        uid, cid = await _mk_env()
        try:
            from routes.responsibilities import (
                _open_cleanup_items_by_bucket,
                CLEANUP_ITEM_KEYS,
            )
            # Before scan — no batch, so all cleanup buckets empty.
            b0 = await _open_cleanup_items_by_bucket(cid)
            assert all(len(v) == 0 for v in b0.values())

            # Run scan → populate.
            await run_scan_for_company({
                "company_id": cid,
                "flags": {"receipts": True, "liabilities": True, "irs": False},
                "months": {"receipts": 12, "liabilities": 12},
            })
            b1 = await _open_cleanup_items_by_bucket(cid)
            assert len(b1["cleanup_receipt_followup"]) == 2
            assert len(b1["cleanup_liability_payments"]) == 2
            assert len(b1["cleanup_irs_compliance"]) == 0

            # Sanity: the responsibility key set contains all three.
            assert CLEANUP_ITEM_KEYS == {
                "cleanup_liability_payments",
                "cleanup_receipt_followup",
                "cleanup_irs_compliance",
            }
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_kickoff_idempotent_and_schedules_in_future():
    async def _t():
        uid, cid = await _mk_env()
        try:
            from routes.cleanup import kickoff_cleanup
            # Fire twice — second call must reuse the same job doc.
            r1 = await kickoff_cleanup(cid, user={"id": uid, "role": "client"})
            r2 = await kickoff_cleanup(cid, user={"id": uid, "role": "client"})
            assert r1["queued"] is True
            assert r2["queued"] is True
            assert r2.get("reused") is True
            assert r1["job_id"] == r2["job_id"]

            job = await db.cleanup_jobs.find_one({"id": r1["job_id"]})
            assert job["status"] == "pending"
            # Scheduled between 24-48h out.
            sched = datetime.fromisoformat(job["scheduled_at"])
            now = datetime.now(timezone.utc)
            assert now + timedelta(hours=23) < sched < now + timedelta(hours=49)
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_kickoff_noops_when_no_flags_on():
    async def _t():
        uid, cid = await _mk_env()
        # Turn everything off
        await db.companies.update_one(
            {"id": cid},
            {"$set": {"compliance_flags": {
                "flag_irs_docs": False, "flag_receipts": False,
                "flag_split_liabilities": False,
            }}},
        )
        try:
            from routes.cleanup import kickoff_cleanup
            r = await kickoff_cleanup(cid, user={"id": uid, "role": "client"})
            assert r["queued"] is False
            count = await db.cleanup_jobs.count_documents({"company_id": cid})
            assert count == 0
        finally:
            await _cleanup(uid, cid)
    _run(_t())
