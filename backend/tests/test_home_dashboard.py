"""Home Dashboard — cross-product KPI aggregator (Feb 2026, Phase D)."""
from __future__ import annotations
import sys, uuid
sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4()); cid = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"h_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "Home Tester"})
    await db.companies.insert_one({"id": cid, "name": "Home Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for c in ("deals", "projects", "contacts", "memberships",
              "tasks", "employees", "time_entries", "invoices",
              "transactions"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_home_summary_envelope_and_widgets():
    """Home dashboard aggregator emits the widget envelope with the
    right kinds, ids, and cross-product data."""
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            # Seed just enough data across all 4 slices.
            await db.deals.insert_many([
                {"id": str(uuid.uuid4()), "company_id": cid, "title": "Big deal",
                 "stage": "proposal", "value": 10000, "probability": 50,
                 "activities": [{"id": "a1", "at": "2026-02-28T10:00:00+00:00",
                                  "kind": "note", "body": "Called the CFO",
                                  "by_name": "Sam"}],
                 "updated_at": "2026-02-28T10:00:00+00:00"},
                {"id": str(uuid.uuid4()), "company_id": cid, "title": "Small lead",
                 "stage": "lead", "value": 1000, "probability": 10,
                 "activities": []},
            ])
            await db.projects.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "name": "P1", "status": "in_progress",
                "estimated_revenue": 5000})
            await db.employees.insert_many([
                {"id": str(uuid.uuid4()), "company_id": cid, "name": "Alice",
                 "role": "manager", "is_active": True},
                {"id": str(uuid.uuid4()), "company_id": cid, "name": "Bob",
                 "role": "staff", "is_active": True},
            ])
            await db.tasks.insert_many([
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "title": "Do a thing", "status": "open", "kind": "task",
                 "due_date": None},
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "title": "Done thing", "status": "done", "kind": "task",
                 "completed_at": "2026-02-28T09:00:00+00:00"},
            ])

            async with await _client() as ac:
                r = await ac.get(f"/api/companies/{cid}/home-summary",
                                  headers=_h(token))
                assert r.status_code == 200, r.text
                data = r.json()

                # Envelope shape.
                assert "widgets" in data and "meta" in data
                assert "slices" in data["meta"]

                # Widget kinds we expect on the page.
                ids = [w["id"] for w in data["widgets"]]
                assert "kpi.revenue_mtd" in ids
                assert "kpi.employees" in ids
                assert "kpi.pipeline" in ids
                assert "kpi.active_projects" in ids
                assert "team.health" in ids
                for m in ("module.sales", "module.projects",
                           "module.team", "module.finance"):
                    assert m in ids
                assert "feed.recent" in ids

                # KPI values are populated from the seeded slices.
                widgets = {w["id"]: w for w in data["widgets"]}
                assert widgets["kpi.pipeline"]["value"] == 11000  # 10k + 1k
                assert widgets["kpi.employees"]["value"] == 2
                assert widgets["kpi.active_projects"]["value"] == 1

                # Team health donut: 1 done / 2 total = 50%
                assert widgets["team.health"]["percent"] == 50.0

                # Activity feed carries the deal note.
                items = widgets["feed.recent"]["items"]
                sources = {i["source"] for i in items}
                assert "crm" in sources
                assert "team" in sources
                note = next((i for i in items
                              if i["body"] == "Called the CFO"), None)
                assert note is not None
                assert note["link_type"] == "deal"
        finally:
            await _cleanup(uid, cid)
    _run(_t())
