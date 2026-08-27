"""Budgets — Phase 4 CRUD + variance report (Feb 2026)."""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"bg_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Budgets Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "features": {"budgets_enabled": True},
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    # Seed a minimal CoA with one revenue + one expense account.
    accts = [
        {"id": f"rev-{cid[:6]}", "company_id": cid, "code": "4000",
         "name": "Sales", "type": "revenue",
         "detail_type": "sales_income", "active": True},
        {"id": f"exp-{cid[:6]}", "company_id": cid, "code": "6100",
         "name": "Rent", "type": "expense",
         "detail_type": "operating_expense", "active": True},
        {"id": f"cash-{cid[:6]}", "company_id": cid, "code": "1000",
         "name": "Cash", "type": "asset",
         "detail_type": "cash_and_bank", "active": True},
        # A liability to prove the P&L guard rejects it.
        {"id": f"ap-{cid[:6]}", "company_id": cid, "code": "2000",
         "name": "A/P", "type": "liability",
         "detail_type": "accounts_payable", "active": True},
    ]
    await db.accounts.insert_many(accts)
    return uid, create_token(uid, "client"), cid, accts


async def _cleanup(uid: str, cid: str):
    for coll in ("budgets", "budget_lines", "accounts",
                 "transactions", "journal_entries", "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_budgets_crud():
    async def _t():
        uid, token, cid, _ = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "FY26 Plan", "fiscal_year": 2026})
                assert r.status_code == 200, r.text
                bid = r.json()["budget"]["id"]

                # Dup name in same FY → 409.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "fy26 plan", "fiscal_year": 2026})
                assert r.status_code == 409

                # Different FY, same name → OK.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "FY26 Plan", "fiscal_year": 2027})
                assert r.status_code == 200

                # Rename.
                r = await ac.patch(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token), json={"name": "FY26 Ops"})
                assert r.status_code == 200
                assert r.json()["budget"]["name"] == "FY26 Ops"

                # Status.
                r = await ac.patch(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token), json={"status": "active"})
                assert r.json()["budget"]["status"] == "active"

                # Delete.
                r = await ac.delete(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token))
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token))
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_bulk_upsert_lines_pl_guard_and_clear():
    async def _t():
        uid, token, cid, accts = await _mk_env()
        rev_id = accts[0]["id"]
        exp_id = accts[1]["id"]
        ap_id  = accts[3]["id"]  # liability
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Plan", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]

                # Upsert 2 cells across 2 accounts.
                r = await ac.put(
                    f"/api/companies/{cid}/budgets/{bid}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": rev_id, "period_key": "2026-01", "amount": 5000},
                        {"account_id": exp_id, "period_key": "2026-01", "amount": 1200},
                    ]})
                assert r.status_code == 200
                assert r.json()["upserted"] == 2

                # Round-trip: GET budget returns 2 lines.
                r = await ac.get(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token))
                assert len(r.json()["lines"]) == 2

                # Clear by upserting amount=0.
                r = await ac.put(
                    f"/api/companies/{cid}/budgets/{bid}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": rev_id, "period_key": "2026-01", "amount": 0},
                    ]})
                assert r.json()["cleared"] == 1
                r = await ac.get(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token))
                assert len(r.json()["lines"]) == 1

                # P&L guard — liability rejected.
                r = await ac.put(
                    f"/api/companies/{cid}/budgets/{bid}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": ap_id, "period_key": "2026-02", "amount": 100},
                    ]})
                assert r.status_code == 400
                assert "p&l" in r.json()["detail"].lower()

                # Out-of-year period rejected.
                r = await ac.put(
                    f"/api/companies/{cid}/budgets/{bid}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": rev_id, "period_key": "2027-01", "amount": 500},
                    ]})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_budget_vs_actuals_variance():
    """Report signs variance so 'positive is good' for both sides."""
    async def _t():
        uid, token, cid, accts = await _mk_env()
        rev_id = accts[0]["id"]
        exp_id = accts[1]["id"]
        cash_id = accts[2]["id"]
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Plan", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]
                # Budget Jan sales = 5000, Jan rent = 1000.
                await ac.put(
                    f"/api/companies/{cid}/budgets/{bid}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": rev_id, "period_key": "2026-01", "amount": 5000},
                        {"account_id": exp_id, "period_key": "2026-01", "amount": 1000},
                    ]})

                # Post actuals: $6000 sales (beat), $1200 rent (over).
                # Sales: DR cash / CR sales → txn with amount=+6000, category=sales.
                # For _signed_balances, positive amount + income category
                # (credit-normal) → bank +6000, category -6000 (credit).
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-01-15", "posted": True,
                    "amount": 6000, "merchant": "Cust",
                    "bank_account_id": cash_id,
                    "category_account_id": rev_id,
                })
                # Rent: negative amount, expense category.
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-01-20", "posted": True,
                    "amount": -1200, "merchant": "Landlord",
                    "bank_account_id": cash_id,
                    "category_account_id": exp_id,
                })

                r = await ac.get(
                    f"/api/companies/{cid}/reports/budget-vs-actuals"
                    f"?budget_id={bid}", headers=_h(token))
                assert r.status_code == 200, r.text
                data = r.json()
                # Revenue row: budget 5000 / actual 6000 / variance +1000.
                rev_row = data["revenue"]["rows"][0]
                assert rev_row["total"]["budget"]  == 5000.0
                assert rev_row["total"]["actual"]  == 6000.0
                assert rev_row["total"]["variance"] == 1000.0  # positive = beat

                # Expense row: budget 1000 / actual 1200 / variance -200
                # (budget - actual = -200, "over budget" is bad).
                exp_row = data["expenses"]["rows"][0]
                assert exp_row["total"]["budget"]   == 1000.0
                assert exp_row["total"]["actual"]   == 1200.0
                assert exp_row["total"]["variance"] == -200.0

                # Net income: budget = 5000 - 1000 = 4000; actual = 6000 - 1200 = 4800.
                # Variance = actual - budget = +800.
                assert data["net_income"]["budget"] == 4000.0
                assert data["net_income"]["actual"] == 4800.0
                assert data["net_income"]["variance"] == 800.0

                # Jan cell has values; Feb should be all zeros for both.
                jan = [m for m in rev_row["months"] if m["period_key"] == "2026-01"][0]
                feb = [m for m in rev_row["months"] if m["period_key"] == "2026-02"][0]
                assert jan["actual"] == 6000.0
                assert feb["actual"] == 0
                assert feb["budget"] == 0
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_prefill_from_prior_year():
    """Prefill copies prior-year actuals into budget cells."""
    async def _t():
        uid, token, cid, accts = await _mk_env()
        rev_id = accts[0]["id"]
        exp_id = accts[1]["id"]
        cash_id = accts[2]["id"]
        try:
            async with await _client() as ac:
                # Seed some FY2025 actuals — Jan sales 2000, Feb rent 500.
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2025-01-15", "posted": True,
                    "amount": 2000, "merchant": "X",
                    "bank_account_id": cash_id,
                    "category_account_id": rev_id,
                })
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2025-02-10", "posted": True,
                    "amount": -500, "merchant": "Rent Co",
                    "bank_account_id": cash_id,
                    "category_account_id": exp_id,
                })

                # Empty FY26 budget.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Plan", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]

                # Prefill w/ 10% growth uplift.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets/{bid}/prefill",
                    headers=_h(token), json={"growth_pct": 10})
                assert r.status_code == 200
                assert r.json()["prior_year"] == 2025
                assert r.json()["seeded"] >= 2

                # Cells populated: Jan sales = 2000*1.10=2200; Feb rent=500*1.10=550.
                r = await ac.get(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token))
                lines = r.json()["lines"]
                by_key = {(l["account_id"], l["period_key"]): l["amount"] for l in lines}
                assert by_key.get((rev_id, "2026-01")) == 2200.0
                assert by_key.get((exp_id, "2026-02")) == 550.0
        finally:
            await _cleanup(uid, cid)
    _run(_t())
