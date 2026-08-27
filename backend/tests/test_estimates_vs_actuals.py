"""Estimates vs Actuals report (Feb 2026 Phase 3)."""
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
        "id": uid, "email": f"eva_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "EVA Test Co", "owner_user_id": uid,
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
    for coll in ("projects", "invoices", "bills", "contacts",
                 "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_estimates_vs_actuals_rolls_up_by_project():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Two projects.
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "Kitchen", "contact_id": contact_id,
                          "estimated_revenue": 10000})
                p1 = r.json()["project"]["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "Bath", "contact_id": contact_id,
                          "estimated_revenue": 5000})
                p2 = r.json()["project"]["id"]

                # Project 1 — $6000 invoiced, $2000 outstanding.
                await db.invoices.insert_many([
                    {"id": str(uuid.uuid4()), "company_id": cid,
                     "project_id": p1, "total": 4000, "balance_due": 0,
                     "issue_date": "2026-02-01", "line_items": []},
                    {"id": str(uuid.uuid4()), "company_id": cid,
                     "project_id": p1, "total": 2000, "balance_due": 2000,
                     "issue_date": "2026-02-15", "line_items": []},
                ])
                # Project 1 — $1500 committed on bills, $500 unpaid.
                await db.bills.insert_many([
                    {"id": str(uuid.uuid4()), "company_id": cid,
                     "project_id": p1, "total": 1000, "balance_due": 0,
                     "issue_date": "2026-02-05", "line_items": []},
                    {"id": str(uuid.uuid4()), "company_id": cid,
                     "project_id": p1, "total": 500, "balance_due": 500,
                     "issue_date": "2026-02-10", "line_items": []},
                ])
                # Project 2 — one $3000 invoice fully paid, no bills.
                await db.invoices.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                     "project_id": p2, "total": 3000, "balance_due": 0,
                     "issue_date": "2026-02-01", "line_items": [],
                })

                # Fetch report.
                r = await ac.get(
                    f"/api/companies/{cid}/reports/estimates-vs-actuals",
                    headers=_h(token))
                assert r.status_code == 200, r.text
                data = r.json()
                assert data["project_count"] == 2
                # Rows keyed by project id for stable lookup.
                by = {row["id"]: row for row in data["projects"]}

                # Project 1 rollup.
                r1 = by[p1]
                assert r1["estimated"] == 10000.0
                assert r1["invoiced"] == 6000.0
                assert r1["ar_outstanding"] == 2000.0
                assert r1["received"] == 4000.0
                assert r1["remaining_est"] == 4000.0   # 10000 - 6000
                assert r1["committed"] == 1500.0
                assert r1["ap_outstanding"] == 500.0
                assert r1["paid_to_vendors"] == 1000.0
                assert r1["net_cash"] == 3000.0        # 4000 - 1000
                assert r1["invoice_count"] == 2
                assert r1["bill_count"] == 2
                assert r1["pct_billed"] == 60.0
                assert r1["pct_collected"] == round(4000/6000*100, 1)

                # Project 2 rollup.
                r2 = by[p2]
                assert r2["invoiced"] == 3000.0
                assert r2["received"] == 3000.0
                assert r2["remaining_est"] == 2000.0
                assert r2["committed"] == 0.0
                assert r2["bill_count"] == 0

                # Totals.
                t = data["totals"]
                assert t["estimated"] == 15000.0
                assert t["invoiced"] == 9000.0
                assert t["received"] == 7000.0
                assert t["committed"] == 1500.0
                assert t["paid_to_vendors"] == 1000.0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_include_completed_filter():
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # In progress + completed + cancelled.
                for name, status in [("Live", "in_progress"),
                                      ("Done", "completed"),
                                      ("Nope", "cancelled")]:
                    await ac.post(
                        f"/api/companies/{cid}/projects", headers=_h(token),
                        json={"name": name, "contact_id": contact_id,
                              "status": status})

                # Include completed (default) — cancelled always hidden.
                r = await ac.get(
                    f"/api/companies/{cid}/reports/estimates-vs-actuals",
                    headers=_h(token))
                assert r.status_code == 200
                names = {p["name"] for p in r.json()["projects"]}
                assert names == {"Live", "Done"}

                # Exclude completed → only Live.
                r = await ac.get(
                    f"/api/companies/{cid}/reports/estimates-vs-actuals"
                    "?include_completed=0",
                    headers=_h(token))
                names = {p["name"] for p in r.json()["projects"]}
                assert names == {"Live"}
        finally:
            await _cleanup(uid, cid)

    _run(_t())
