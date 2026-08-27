"""Budgets scope filters — class + project scoping (Feb 2026)."""
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


async def _mk_env(features=None):
    features = features or {
        "budgets_enabled": True,
        "classes_enabled": True,
        "projects_enabled": True,
    }
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"bs_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Budgets Scope Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "features": features,
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
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
    ]
    await db.accounts.insert_many(accts)
    # Seed a class + a customer + a project.
    class_id = str(uuid.uuid4())
    contact_id = str(uuid.uuid4())
    proj_id = str(uuid.uuid4())
    await db.classes.insert_one({
        "id": class_id, "company_id": cid,
        "name": "Marketing", "active": True,
    })
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Acme Corp", "type": "customer",
    })
    await db.projects.insert_one({
        "id": proj_id, "company_id": cid,
        "name": "Kitchen Remodel", "contact_id": contact_id,
        "contact_name": "Acme Corp", "status": "in_progress",
    })
    return uid, create_token(uid, "client"), cid, accts, class_id, proj_id


async def _cleanup(uid: str, cid: str):
    for coll in ("budgets", "budget_lines", "accounts",
                 "transactions", "journal_entries", "classes",
                 "projects", "project_phases", "contacts",
                 "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_scoped_budget_create_and_uniqueness():
    """Same name allowed at Company + Class + Project scope; dup at
    same scope rejected."""
    async def _t():
        uid, token, cid, _, class_id, proj_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Company scope.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "FY26 Plan", "fiscal_year": 2026})
                assert r.status_code == 200
                assert r.json()["budget"]["scope"] == "company"
                assert r.json()["budget"]["scope_ref_id"] is None

                # Same name at Class scope — OK.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "FY26 Plan", "fiscal_year": 2026,
                          "scope": "class", "scope_ref_id": class_id})
                assert r.status_code == 200, r.text
                assert r.json()["budget"]["scope"] == "class"
                assert r.json()["budget"]["scope_ref_name"] == "Marketing"

                # Same name at Project scope — OK.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "FY26 Plan", "fiscal_year": 2026,
                          "scope": "project", "scope_ref_id": proj_id})
                assert r.status_code == 200
                assert r.json()["budget"]["scope_ref_name"] == "Kitchen Remodel"

                # Dup within same class scope → 409.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "fy26 plan", "fiscal_year": 2026,
                          "scope": "class", "scope_ref_id": class_id})
                assert r.status_code == 409

                # class scope missing scope_ref_id → 400.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Bad", "fiscal_year": 2026, "scope": "class"})
                assert r.status_code == 400

                # scope_ref_id pointing to non-existent class → 404.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Bad", "fiscal_year": 2026,
                          "scope": "class", "scope_ref_id": "nonexistent"})
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_scoped_budget_requires_feature_flag():
    """Scoping to class fails when classes_enabled=False."""
    async def _t():
        uid, token, cid, _, class_id, proj_id = await _mk_env(features={
            "budgets_enabled": True,
            "classes_enabled": False,
            "projects_enabled": False,
        })
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "B", "fiscal_year": 2026,
                          "scope": "class", "scope_ref_id": class_id})
                assert r.status_code == 400
                assert "classes" in r.json()["detail"].lower()
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "B", "fiscal_year": 2026,
                          "scope": "project", "scope_ref_id": proj_id})
                assert r.status_code == 400
                assert "projects" in r.json()["detail"].lower()
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_scoped_variance_filters_to_scope():
    """BvA report on a class-scoped budget only counts class-tagged
    postings; non-tagged postings on the same account are excluded."""
    async def _t():
        uid, token, cid, accts, class_id, proj_id = await _mk_env()
        rev_id = accts[0]["id"]
        exp_id = accts[1]["id"]
        cash_id = accts[2]["id"]
        try:
            async with await _client() as ac:
                # Create class-scoped budget: Jan Marketing rent = 400.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Marketing FY26", "fiscal_year": 2026,
                          "scope": "class", "scope_ref_id": class_id})
                bid = r.json()["budget"]["id"]
                await ac.put(
                    f"/api/companies/{cid}/budgets/{bid}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": exp_id, "period_key": "2026-01", "amount": 400},
                    ]})

                # Post 2 rent txns: one tagged Marketing, one untagged.
                # Only the tagged one should count as actual.
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-01-10", "posted": True,
                    "amount": -300, "merchant": "Rent Co",
                    "bank_account_id": cash_id,
                    "category_account_id": exp_id,
                    "class_id": class_id,
                })
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-01-15", "posted": True,
                    "amount": -800, "merchant": "Rent Co",
                    "bank_account_id": cash_id,
                    "category_account_id": exp_id,
                    # No class_id — belongs to Company-wide bucket.
                })

                r = await ac.get(
                    f"/api/companies/{cid}/reports/budget-vs-actuals"
                    f"?budget_id={bid}", headers=_h(token))
                assert r.status_code == 200, r.text
                data = r.json()
                # Actual should be 300 (only the class-tagged txn), NOT 1100.
                exp_row = data["expenses"]["rows"][0]
                assert exp_row["total"]["actual"]   == 300.0
                assert exp_row["total"]["budget"]   == 400.0
                assert exp_row["total"]["variance"] == 100.0  # under budget

                # Compare with a Company-scoped budget on the same account
                # → actual should be 1100 (both txns).
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Full FY26", "fiscal_year": 2026})
                bid2 = r.json()["budget"]["id"]
                await ac.put(
                    f"/api/companies/{cid}/budgets/{bid2}/lines",
                    headers=_h(token),
                    json={"lines": [
                        {"account_id": exp_id, "period_key": "2026-01", "amount": 400},
                    ]})
                r = await ac.get(
                    f"/api/companies/{cid}/reports/budget-vs-actuals"
                    f"?budget_id={bid2}", headers=_h(token))
                exp_row = r.json()["expenses"]["rows"][0]
                assert exp_row["total"]["actual"] == 1100.0
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_scoped_prefill_filters_to_scope():
    """Prefill on a project-scoped budget only pulls project-tagged FY-1
    actuals."""
    async def _t():
        uid, token, cid, accts, class_id, proj_id = await _mk_env()
        rev_id = accts[0]["id"]
        cash_id = accts[2]["id"]
        try:
            async with await _client() as ac:
                # 2025 seed: $500 sales tagged to project, $2000 untagged.
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2025-03-10", "posted": True,
                    "amount": 500, "merchant": "C",
                    "bank_account_id": cash_id,
                    "category_account_id": rev_id,
                    "project_id": proj_id,
                })
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2025-03-15", "posted": True,
                    "amount": 2000, "merchant": "D",
                    "bank_account_id": cash_id,
                    "category_account_id": rev_id,
                })

                # Project-scoped FY26 budget.
                r = await ac.post(
                    f"/api/companies/{cid}/budgets", headers=_h(token),
                    json={"name": "Kitchen FY26", "fiscal_year": 2026,
                          "scope": "project", "scope_ref_id": proj_id})
                bid = r.json()["budget"]["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/budgets/{bid}/prefill",
                    headers=_h(token), json={})
                assert r.status_code == 200

                # Only the project-tagged $500 should have prefilled Mar 2026.
                r = await ac.get(
                    f"/api/companies/{cid}/budgets/{bid}",
                    headers=_h(token))
                lines = r.json()["lines"]
                mar_sales = [l for l in lines
                             if l["account_id"] == rev_id
                             and l["period_key"] == "2026-03"]
                assert len(mar_sales) == 1
                assert mar_sales[0]["amount"] == 500.0
        finally:
            await _cleanup(uid, cid)
    _run(_t())
