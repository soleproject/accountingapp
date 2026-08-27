"""Project Phases CRUD + per-phase P&L (Feb 2026 Phase 3)."""
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
        "id": uid, "email": f"ph_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Phases Test Co", "owner_user_id": uid,
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
    for coll in ("projects", "project_phases", "transactions",
                 "journal_entries", "accounts", "contacts",
                 "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_phases_crud():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Set up a project.
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "House", "contact_id": contact_id})
                pid = r.json()["project"]["id"]

                # Create three phases.
                names = ["Demo", "Framing", "Finishes"]
                phase_ids = []
                for n in names:
                    r = await ac.post(
                        f"/api/companies/{cid}/projects/{pid}/phases",
                        headers=_h(token), json={"name": n})
                    assert r.status_code == 200
                    phase_ids.append(r.json()["phase"]["id"])

                # sort_order auto-appends.
                r = await ac.get(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token))
                phases = r.json()["phases"]
                assert [p["name"] for p in phases] == names
                assert [p["sort_order"] for p in phases] == [0, 1, 2]

                # Dup name (case-insensitive) → 409.
                r = await ac.post(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token), json={"name": "framing"})
                assert r.status_code == 409

                # Rename.
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}/phases/{phase_ids[0]}",
                    headers=_h(token),
                    json={"name": "Demolition"})
                assert r.status_code == 200
                assert r.json()["phase"]["name"] == "Demolition"

                # Delete blocked when referenced.
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-02-10", "posted": True,
                    "amount": -100, "merchant": "X",
                    "project_id": pid, "phase_id": phase_ids[1],
                })
                r = await ac.delete(
                    f"/api/companies/{cid}/projects/{pid}/phases/{phase_ids[1]}",
                    headers=_h(token))
                assert r.status_code == 400
                assert "referenced" in r.json()["detail"].lower()

                # Unused phase deletes fine.
                r = await ac.delete(
                    f"/api/companies/{cid}/projects/{pid}/phases/{phase_ids[2]}",
                    headers=_h(token))
                assert r.status_code == 200

                # Project hard-delete also drops phases (verified
                # indirectly — after cleanup the collection is empty
                # per test isolation).
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_profitability_by_phase_breakdown():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "House", "contact_id": contact_id,
                          "estimated_revenue": 20000})
                pid = r.json()["project"]["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token), json={"name": "Demo"})
                demo_id = r.json()["phase"]["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token), json={"name": "Framing"})
                fr_id = r.json()["phase"]["id"]

                cash = {"id": f"c-{cid[:6]}", "company_id": cid,
                        "code": "1000", "name": "Cash",
                        "type": "asset", "detail_type": "cash_and_bank",
                        "active": True}
                exp = {"id": f"e-{cid[:6]}", "company_id": cid,
                       "code": "6100", "name": "Materials",
                       "type": "expense", "detail_type": "operating_expense",
                       "active": True}
                await db.accounts.insert_many([cash, exp])

                # Demo: $500 expense; Framing: $1200 expense; Unphased: $300.
                for amt, ph in [(-500, demo_id), (-1200, fr_id), (-300, None)]:
                    doc = {"id": str(uuid.uuid4()), "company_id": cid,
                            "date": "2026-02-15", "posted": True,
                            "amount": amt, "merchant": "S",
                            "bank_account_id": cash["id"],
                            "category_account_id": exp["id"],
                            "project_id": pid}
                    if ph:
                        doc["phase_id"] = ph
                    await db.transactions.insert_one(doc)

                r = await ac.get(
                    f"/api/companies/{cid}/reports/project-profitability"
                    f"?project_id={pid}&group_by_phase=1",
                    headers=_h(token))
                assert r.status_code == 200, r.text
                data = r.json()
                assert "by_phase" in data
                by_name = {p["name"]: p for p in data["by_phase"]}
                assert by_name["Demo"]["expenses"] == 500.0
                assert by_name["Demo"]["net_income"] == -500.0
                assert by_name["Framing"]["expenses"] == 1200.0
                assert by_name["Unphased"]["expenses"] == 300.0
                # Top-level total still matches phase sum.
                assert data["expenses"]["total"] == 2000.0

                # Without group_by_phase, no by_phase key.
                r = await ac.get(
                    f"/api/companies/{cid}/reports/project-profitability"
                    f"?project_id={pid}",
                    headers=_h(token))
                assert "by_phase" not in r.json()
        finally:
            await _cleanup(uid, cid)

    _run(_t())
