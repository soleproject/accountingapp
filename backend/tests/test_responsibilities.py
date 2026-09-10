"""Tests for the Monthly Responsibilities feature."""
from __future__ import annotations

import asyncio
import uuid

import pytest
from datetime import datetime, timezone

from db import db


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _seed_company(cid: str):
    await db.companies.insert_one({
        "id": cid, "name": "RespTestCo", "created_at": _now(),
    })


async def _cleanup(cid: str):
    for coll in ("companies", "company_task_completions", "transactions", "bills", "invoices"):
        await db[coll].delete_many({"company_id": cid})


def test_save_and_get_responsibilities(monkeypatch):
    async def go():
        from routes.responsibilities import (
            save_responsibilities, get_responsibilities, SaveResponsibilitiesIn,
        )
        from routes import responsibilities as resp_mod

        cid = str(uuid.uuid4())

        async def fake_require(user, target_cid):
            return None
        monkeypatch.setattr(resp_mod, "require_company", fake_require)

        try:
            await _seed_company(cid)
            fake_user = {"email": "pro@axiom.ai", "id": "u1"}
            payload = SaveResponsibilitiesIn(
                assignments={
                    "monitoring_cashflow": "accountant",
                    "reviewing_transactions": "both",
                    "paying_bills": "client",
                    "issuing_payroll": "accountant",
                    "reconciling_accounts": "accountant",
                },
                payroll_frequency="biweekly",
            )
            r = await save_responsibilities(cid, payload, user=fake_user)
            assert r["ok"] is True

            got = await get_responsibilities(cid, user=fake_user)
            assert got["assignments"]["monitoring_cashflow"] == "accountant"
            assert got["assignments"]["reviewing_transactions"] == "both"
            assert got["assignments"]["paying_bills"] == "client"
            assert got["payroll_frequency"] == "biweekly"
            # Unassigned items come back None so the UI can render blank radios.
            assert got["assignments"]["budget_vs_actual"] is None
            # Catalog echoes 11 items in the fixed order.
            assert len(got["catalog"]) == 11
            keys = [c["key"] for c in got["catalog"]]
            assert keys[0] == "monitoring_cashflow"
            assert keys[-1] == "eom_closing"
        finally:
            await _cleanup(cid)
    _run(go())


def test_status_scope_filters_and_manual_complete_toggle(monkeypatch):
    """Scope=client returns only client + both items. Marking a manual
    item complete flips its status to done; unmark returns it to
    not_started."""
    async def go():
        from routes.responsibilities import (
            save_responsibilities, responsibilities_status, complete_item,
            SaveResponsibilitiesIn, CompleteItemIn,
        )
        from routes import responsibilities as resp_mod

        cid = str(uuid.uuid4())

        async def fake_require(user, target_cid):
            return None
        monkeypatch.setattr(resp_mod, "require_company", fake_require)

        try:
            await _seed_company(cid)
            fake_user = {"email": "pro@axiom.ai", "id": "u1"}
            await save_responsibilities(cid, SaveResponsibilitiesIn(
                assignments={
                    "monitoring_cashflow": "client",          # client-only
                    "reviewing_transactions": "both",         # both
                    "paying_bills": "accountant",             # accountant-only
                    "monitoring_inventory": "client",
                    "eom_closing": "accountant",
                },
            ), user=fake_user)

            # scope=client → only 3 items (2 client + 1 both).
            client_view = await responsibilities_status(
                cid, period="2026-09", scope="client", user=fake_user,
            )
            client_keys = [i["key"] for i in client_view["items"]]
            assert set(client_keys) == {"monitoring_cashflow", "reviewing_transactions", "monitoring_inventory"}

            # scope=accountant → 3 items (2 accountant + 1 both).
            acct_view = await responsibilities_status(
                cid, period="2026-09", scope="accountant", user=fake_user,
            )
            acct_keys = [i["key"] for i in acct_view["items"]]
            assert set(acct_keys) == {"reviewing_transactions", "paying_bills", "eom_closing"}

            # Mark a manual item complete → status flips to done.
            await complete_item(cid, CompleteItemIn(
                item_key="monitoring_cashflow", period="2026-09", completed=True,
            ), user=fake_user)
            v = await responsibilities_status(cid, period="2026-09", scope="client", user=fake_user)
            cash = next(i for i in v["items"] if i["key"] == "monitoring_cashflow")
            assert cash["status"] == "done"
            assert cash["manual_complete"] is True

            # A different period should still show it as not_started.
            v_prev = await responsibilities_status(cid, period="2026-08", scope="client", user=fake_user)
            cash_prev = next(i for i in v_prev["items"] if i["key"] == "monitoring_cashflow")
            assert cash_prev["status"] == "not_started"

            # Uncheck it — status returns to not_started for current.
            await complete_item(cid, CompleteItemIn(
                item_key="monitoring_cashflow", period="2026-09", completed=False,
            ), user=fake_user)
            v2 = await responsibilities_status(cid, period="2026-09", scope="client", user=fake_user)
            cash2 = next(i for i in v2["items"] if i["key"] == "monitoring_cashflow")
            assert cash2["status"] == "not_started"
        finally:
            await _cleanup(cid)
    _run(go())


def test_status_wires_live_counts_for_tracked_items(monkeypatch):
    """reviewing_transactions + paying_bills + following_up_invoices
    surface live counts from the underlying collections. Current-month
    view = all-open total; prior-month view = filtered by date."""
    async def go():
        from routes.responsibilities import (
            save_responsibilities, responsibilities_status, SaveResponsibilitiesIn,
        )
        from routes import responsibilities as resp_mod

        cid = str(uuid.uuid4())

        async def fake_require(user, target_cid):
            return None
        monkeypatch.setattr(resp_mod, "require_company", fake_require)

        try:
            await _seed_company(cid)
            # 2 flagged txns dated in Aug + 3 in Sep = 5 total live.
            for date in ("2026-08-01", "2026-08-15"):
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": date, "amount": -50, "needs_review": True,
                })
            for date in ("2026-09-01", "2026-09-10", "2026-09-20"):
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": date, "amount": -100, "needs_review": True,
                })

            fake_user = {"email": "pro@axiom.ai", "id": "u1"}
            await save_responsibilities(cid, SaveResponsibilitiesIn(
                assignments={"reviewing_transactions": "both"},
            ), user=fake_user)

            # Current period (whatever it is) → shows total of 5.
            from routes.responsibilities import _current_period
            cur = await responsibilities_status(
                cid, period=_current_period(), scope="both", user=fake_user,
            )
            rev = next(i for i in cur["items"] if i["key"] == "reviewing_transactions")
            if cur["is_current"]:
                assert rev["count"] == 5
            # Prior-month view (Aug) filters to date-in-Aug = 2.
            aug = await responsibilities_status(
                cid, period="2026-08", scope="both", user=fake_user,
            )
            rev_aug = next(i for i in aug["items"] if i["key"] == "reviewing_transactions")
            # If current period happens to be 2026-08, this equals 2 by
            # date filter; if it's a later period, still 2 by date filter.
            assert rev_aug["count"] == 2
        finally:
            await _cleanup(cid)
    _run(go())


def test_save_rejects_bad_values(monkeypatch):
    async def go():
        from routes.responsibilities import save_responsibilities, SaveResponsibilitiesIn
        from routes import responsibilities as resp_mod
        from fastapi import HTTPException

        cid = str(uuid.uuid4())

        async def fake_require(user, target_cid):
            return None
        monkeypatch.setattr(resp_mod, "require_company", fake_require)

        try:
            await _seed_company(cid)
            fake_user = {"email": "pro@axiom.ai", "id": "u1"}
            # Bad assignment value.
            with pytest.raises(HTTPException):
                await save_responsibilities(cid, SaveResponsibilitiesIn(
                    assignments={"paying_bills": "nobody"},
                ), user=fake_user)
            # Bad frequency.
            with pytest.raises(HTTPException):
                await save_responsibilities(cid, SaveResponsibilitiesIn(
                    assignments={"issuing_payroll": "accountant"},
                    payroll_frequency="hourly",
                ), user=fake_user)
            # Unknown key silently ignored (forward-compat).
            r = await save_responsibilities(cid, SaveResponsibilitiesIn(
                assignments={"nonexistent_item": "client"},
            ), user=fake_user)
            assert r["ok"] is True
        finally:
            await _cleanup(cid)
    _run(go())
