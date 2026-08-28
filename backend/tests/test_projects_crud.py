"""Projects CRUD + profitability report (Feb 2026 Phase 3)."""
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
    contact_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"proj_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Projects Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "features": {"classes_enabled": False,
                     "projects_enabled": True,
                     "budgets_enabled": False},
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Acme Corp", "type": "customer",
    })
    return uid, create_token(uid, "client"), cid, contact_id


async def _cleanup(uid: str, cid: str):
    for coll in ("projects", "transactions", "journal_entries",
                 "contacts", "accounts", "memberships",
                 "project_settings"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_projects_crud_happy_path():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Create.
                r = await ac.post(
                    f"/api/companies/{cid}/projects",
                    headers=_h(token),
                    json={"name": "Kitchen Remodel #23",
                          "contact_id": contact_id,
                          "estimated_revenue": 25000})
                assert r.status_code == 200, r.text
                pid = r.json()["project"]["id"]
                assert r.json()["project"]["contact_name"] == "Acme Corp"
                assert r.json()["project"]["status"] == "in_progress"

                # Dup on same customer → 409.
                r = await ac.post(
                    f"/api/companies/{cid}/projects",
                    headers=_h(token),
                    json={"name": "kitchen remodel #23",
                          "contact_id": contact_id})
                assert r.status_code == 409

                # Contact required.
                r = await ac.post(
                    f"/api/companies/{cid}/projects",
                    headers=_h(token), json={"name": "Orphan"})
                assert r.status_code == 400

                # Rename + set status.
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}",
                    headers=_h(token),
                    json={"name": "Kitchen Reno v2",
                          "status": "on_hold"})
                assert r.status_code == 200
                assert r.json()["project"]["status"] == "on_hold"

                # List (default hides cancelled).
                r = await ac.get(
                    f"/api/companies/{cid}/projects", headers=_h(token))
                assert len(r.json()["projects"]) == 1

                # Soft-delete via delete → status=cancelled.
                r = await ac.delete(
                    f"/api/companies/{cid}/projects/{pid}",
                    headers=_h(token))
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/projects", headers=_h(token))
                assert len(r.json()["projects"]) == 0
                r = await ac.get(
                    f"/api/companies/{cid}/projects?include_inactive=1",
                    headers=_h(token))
                assert len(r.json()["projects"]) == 1

                # Hard-delete allowed when unused.
                r = await ac.delete(
                    f"/api/companies/{cid}/projects/{pid}?hard=1",
                    headers=_h(token))
                assert r.status_code == 200
                assert r.json()["hard"] is True
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_project_in_use_blocks_hard_delete():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects",
                    headers=_h(token),
                    json={"name": "P1", "contact_id": contact_id})
                pid = r.json()["project"]["id"]
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-02-10", "posted": True,
                    "amount": -100, "merchant": "X",
                    "project_id": pid,
                })
                r = await ac.delete(
                    f"/api/companies/{cid}/projects/{pid}?hard=1",
                    headers=_h(token))
                assert r.status_code == 400
                assert "referenced" in r.json()["detail"].lower()
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_project_profitability_report_rolls_up_correctly():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Set up a project with a $10k estimate.
                r = await ac.post(
                    f"/api/companies/{cid}/projects",
                    headers=_h(token),
                    json={"name": "K3", "contact_id": contact_id,
                          "estimated_revenue": 10000})
                pid = r.json()["project"]["id"]

                # Revenue + expense accounts.
                rev = {"id": f"rev-{cid[:6]}", "company_id": cid,
                       "code": "4000", "name": "Sales",
                       "type": "revenue", "detail_type": "income",
                       "active": True}
                exp = {"id": f"exp-{cid[:6]}", "company_id": cid,
                       "code": "6100", "name": "Materials",
                       "type": "expense", "detail_type": "operating_expense",
                       "active": True}
                cash = {"id": f"cash-{cid[:6]}", "company_id": cid,
                        "code": "1000", "name": "Cash",
                        "type": "asset", "detail_type": "cash_and_bank",
                        "active": True}
                await db.accounts.insert_many([rev, exp, cash])

                # $6k revenue via JE, $2k expense via txn — both scoped
                # to the project.
                await db.journal_entries.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-02-15",
                    "lines": [
                        {"account_id": cash["id"], "debit": 6000,
                         "credit": 0, "project_id": pid},
                        {"account_id": rev["id"],  "debit": 0,
                         "credit": 6000, "project_id": pid},
                    ],
                })
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-02-20", "posted": True,
                    "amount": -2000, "merchant": "Supplier",
                    "bank_account_id": cash["id"],
                    "category_account_id": exp["id"],
                    "project_id": pid,
                })

                # Fetch profitability.
                r = await ac.get(
                    f"/api/companies/{cid}/reports/project-profitability"
                    f"?project_id={pid}",
                    headers=_h(token))
                assert r.status_code == 200, r.text
                d = r.json()
                assert d["revenue"]["total"] == 6000.0
                assert d["expenses"]["total"] == 2000.0
                assert d["net_income"] == 4000.0
                assert d["estimated_revenue"] == 10000.0
                assert d["pct_of_estimate"] == 60.0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_project_types_settings_and_project_type_field():
    """User can save custom types, they're returned in the dropdown,
    and creating a project with a new type auto-adds it to the list."""
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Default state → only "General".
                r = await ac.get(f"/api/companies/{cid}/project-types",
                                  headers=_h(token))
                assert r.json()["types"] == ["General"]

                # Add two types.
                r = await ac.post(f"/api/companies/{cid}/project-types",
                                    headers=_h(token),
                                    json={"name": "Construction"})
                assert r.json()["types"] == ["General", "Construction"]
                r = await ac.post(f"/api/companies/{cid}/project-types",
                                    headers=_h(token),
                                    json={"name": "Marketing"})
                assert r.json()["types"] == [
                    "General", "Construction", "Marketing"]

                # Creating a project with a brand-new type auto-adds it.
                r = await ac.post(f"/api/companies/{cid}/projects",
                                    headers=_h(token),
                                    json={"name": "Renovation A",
                                            "contact_id": contact_id,
                                            "project_type": "Renovation"})
                assert r.status_code == 200, r.text
                pid = r.json()["project"]["id"]
                assert r.json()["project"]["project_type"] == "Renovation"

                r = await ac.get(f"/api/companies/{cid}/project-types",
                                  headers=_h(token))
                assert "Renovation" in r.json()["types"]

                # Creating a project without project_type defaults to General.
                r = await ac.post(f"/api/companies/{cid}/projects",
                                    headers=_h(token),
                                    json={"name": "Renovation B",
                                            "contact_id": contact_id})
                assert r.json()["project"]["project_type"] == "General"

                # Patch project type — must persist + reflect in list.
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}",
                    headers=_h(token),
                    json={"project_type": "Solar Install"})
                assert r.status_code == 200
                assert r.json()["project"]["project_type"] == "Solar Install"

                # "General" is protected from deletion.
                r = await ac.delete(
                    f"/api/companies/{cid}/project-types/General",
                    headers=_h(token))
                assert r.status_code == 400

                # Deleting a custom type doesn't nuke projects using it.
                r = await ac.delete(
                    f"/api/companies/{cid}/project-types/Construction",
                    headers=_h(token))
                assert r.status_code == 200
                assert "Construction" not in r.json()["types"]

                # Payload validation.
                r = await ac.post(f"/api/companies/{cid}/project-types",
                                    headers=_h(token), json={"name": ""})
                assert r.status_code == 400
                r = await ac.post(f"/api/companies/{cid}/project-types",
                                    headers=_h(token),
                                    json={"name": "x" * 50})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)

    _run(_t())

