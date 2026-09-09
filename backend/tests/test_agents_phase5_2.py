"""Phase 5A.2 — 10 new agent templates for Puzzle parity.

Each test exercises the detector directly with seeded data and asserts
either a finding is produced with the right severity/count or that the
detector correctly returns no findings under quiet conditions.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from tests._shared_loop import run as _run
from db import db
from routes.agents import (
    _run_txn_vendor_inconsistencies,
    _run_first_time_large_txn,
    _run_internal_transfers,
    _run_match_unpaid_bills,
    _run_match_unpaid_invoices,
    _run_missing_receipts,
    _run_variance_analysis,
    _run_profit_margin_analysis,
    _run_pdf_txn_import_watcher,
    _run_receipt_capture_watcher,
)


async def _wipe(cid: str):
    for coll in (
        "transactions", "bills", "invoices", "receipts",
        "bank_statements", "journal_entries",
    ):
        await db[coll].delete_many({"company_id": cid})


def test_vendor_inconsistencies_detects_category_drift():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            today = datetime.now(timezone.utc).date().isoformat()
            for acc in ("acc-meals", "acc-office", "acc-office"):
                await db.transactions.insert_one({
                    "id": f"t-{uuid.uuid4().hex[:6]}", "company_id": cid,
                    "vendor_id": "v1", "account_id": acc, "amount": 50.0,
                    "date": today,
                })
            f = await _run_txn_vendor_inconsistencies(cid, {}, {"lookback_days": 90})
            kinds = {x["kind"] for x in f}
            assert "txn_vendor_inconsistencies" in kinds
        finally:
            await _wipe(cid)
    _run(go())


def test_first_time_large_txn_flags_new_vendor():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            today = datetime.now(timezone.utc).date().isoformat()
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "vendor_id": "brand-new",
                "amount": 1200.0, "date": today,
            })
            f = await _run_first_time_large_txn(cid, {}, {"lookback_days": 30, "min_amount": 500.0})
            assert any(x["kind"] == "first_time_large_txn" for x in f)
        finally:
            await _wipe(cid)
    _run(go())


def test_first_time_large_txn_ignores_small_amounts():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            today = datetime.now(timezone.utc).date().isoformat()
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "vendor_id": "vx",
                "amount": 20.0, "date": today,
            })
            f = await _run_first_time_large_txn(cid, {}, {"lookback_days": 30, "min_amount": 500.0})
            assert f == []
        finally:
            await _wipe(cid)
    _run(go())


def test_internal_transfers_matches_regex():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            today = datetime.now(timezone.utc).date().isoformat()
            await db.transactions.insert_many([
                {"id": f"{cid}-t1", "company_id": cid, "description": "Zelle to self",
                 "date": today, "amount": 100},
                {"id": f"{cid}-t2", "company_id": cid, "memo": "Internal transfer",
                 "date": today, "amount": 200},
                {"id": f"{cid}-t3", "company_id": cid, "description": "STARBUCKS",
                 "date": today, "amount": 5},
            ])
            f = await _run_internal_transfers(cid, {}, {"lookback_days": 60})
            assert len(f) == 1
            assert f[0]["count"] == 2
        finally:
            await _wipe(cid)
    _run(go())


def test_match_unpaid_bills_finds_matching_payment():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            bill_date = "2026-08-01"
            await db.bills.insert_one({
                "id": f"{cid}-b1", "company_id": cid, "contact_id": "vendor-x",
                "amount": 500.0, "balance_due": 500.0,
                "status": "open", "date": bill_date,
            })
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "vendor_id": "vendor-x",
                "amount": 500.0, "date": "2026-08-05",
            })
            f = await _run_match_unpaid_bills(cid, {}, {"tolerance_days": 5, "tolerance_amount": 1.0})
            assert any(x["kind"] == "match_unpaid_bills" for x in f)
        finally:
            await _wipe(cid)
    _run(go())


def test_match_unpaid_invoices_finds_matching_deposit():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            await db.invoices.insert_one({
                "id": f"{cid}-i1", "company_id": cid, "contact_id": "customer-y",
                "total": 750.0, "balance_due": 750.0,
                "status": "sent", "issue_date": "2026-08-01",
            })
            await db.transactions.insert_one({
                "id": f"{cid}-t1", "company_id": cid, "contact_id": "customer-y",
                "amount": 750.0, "date": "2026-08-04",
            })
            f = await _run_match_unpaid_invoices(cid, {}, {"tolerance_days": 5, "tolerance_amount": 1.0})
            assert any(x["kind"] == "match_unpaid_invoices" for x in f)
        finally:
            await _wipe(cid)
    _run(go())


def test_missing_receipts_flags_large_txns_without_receipt():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            today = datetime.now(timezone.utc).date().isoformat()
            await db.transactions.insert_many([
                {"id": f"{cid}-t1", "company_id": cid, "amount": 200, "date": today},
                {"id": f"{cid}-t2", "company_id": cid, "amount": 500, "date": today, "receipt_id": "r1"},
                {"id": f"{cid}-t3", "company_id": cid, "amount": 10, "date": today},
            ])
            f = await _run_missing_receipts(cid, {}, {"min_amount": 75.0, "lookback_days": 60})
            assert len(f) == 1
            assert f[0]["count"] == 1
        finally:
            await _wipe(cid)
    _run(go())


def test_variance_analysis_flags_large_movement():
    """Uses reports.compute_income_statement, so seed journal entries."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            # Prior period P&L account: Rent Expense $1000; Current: $5000.
            rent_id = f"{cid}-rent"
            rev_id = f"{cid}-rev"
            await db.companies.insert_one({"id": cid, "name": "Test"})
            await db.accounts.insert_many([
                {"id": rent_id, "code": "6100", "company_id": cid, "name": "Rent Expense",
                 "type": "expense", "active": True},
                {"id": rev_id, "code": "4000", "company_id": cid, "name": "Service Revenue",
                 "type": "revenue", "active": True},
            ])
            await db.journal_entries.insert_many([
                {"id": f"{cid}-je1", "company_id": cid, "date": "2026-07-15", "posted": True,
                 "lines": [{"account_id": rent_id, "debit": 1000, "credit": 0},
                            {"account_id": rev_id, "debit": 0, "credit": 1000}]},
                {"id": f"{cid}-je2", "company_id": cid, "date": "2026-08-15", "posted": True,
                 "lines": [{"account_id": rent_id, "debit": 5000, "credit": 0},
                            {"account_id": rev_id, "debit": 0, "credit": 5000}]},
            ])
            f = await _run_variance_analysis(cid, {}, {
                "period": "2026-08", "pct_threshold": 5.0, "dollar_threshold": 1000.0,
            })
            assert any(x["kind"] == "variance_analysis" for x in f)
        finally:
            await db.accounts.delete_many({"company_id": cid})
            await db.companies.delete_many({"id": cid})
            await _wipe(cid)
    _run(go())


def test_pdf_txn_import_watcher_flags_stale_uploads():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            old = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
            await db.bank_statements.insert_many([
                {"id": f"{cid}-s1", "company_id": cid, "status": "processing", "created_at": old},
                {"id": f"{cid}-s2", "company_id": cid, "status": "processed", "created_at": old},
            ])
            f = await _run_pdf_txn_import_watcher(cid, {}, {"stale_hours": 24})
            assert len(f) == 1
            assert f[0]["count"] == 1
        finally:
            await _wipe(cid)
    _run(go())


def test_receipt_capture_watcher_flags_unmatched_receipts():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            old = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
            await db.receipts.insert_many([
                {"id": f"{cid}-r1", "company_id": cid, "created_at": old},
                {"id": f"{cid}-r2", "company_id": cid, "transaction_id": "t1", "created_at": old},
            ])
            f = await _run_receipt_capture_watcher(cid, {}, {"stale_hours": 24})
            assert len(f) == 1
            assert f[0]["count"] == 1
        finally:
            await _wipe(cid)
    _run(go())


def test_profit_margin_analysis_needs_multi_class_data():
    """Baseline: with no class data at all, template returns empty (not a crash)."""
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            f = await _run_profit_margin_analysis(cid, {}, {})
            assert f == []
        finally:
            await _wipe(cid)
    _run(go())
