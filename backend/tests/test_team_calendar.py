"""Team calendar aggregator (Feb 2026, Phase B-3 follow-up)."""
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
    eid = str(uuid.uuid4()); pid = str(uuid.uuid4())
    ph_in = str(uuid.uuid4()); ph_out = str(uuid.uuid4())
    tid_in = str(uuid.uuid4()); tid_out = str(uuid.uuid4())
    te_in = str(uuid.uuid4()); te_out = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"tc_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "Cal Tester"})
    await db.companies.insert_one({"id": cid, "name": "Cal Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    await db.employees.insert_one({
        "id": eid, "company_id": cid, "user_id": uid,
        "name": "Alice Field", "role": "field_employee",
        "hourly_cost_rate": 60.0, "active": True})
    await db.projects.insert_one({
        "id": pid, "company_id": cid, "name": "Warehouse Build", "active": True})
    # Phase overlapping the window Feb 15-22 → span Feb 20-Mar 5.
    await db.phases.insert_one({
        "id": ph_in, "company_id": cid, "project_id": pid, "name": "Framing",
        "start_date": "2026-02-20", "end_date": "2026-03-05"})
    # Phase entirely outside the window: Jan 1-15.
    await db.phases.insert_one({
        "id": ph_out, "company_id": cid, "project_id": pid, "name": "Prep",
        "start_date": "2026-01-01", "end_date": "2026-01-15"})
    # Task with due_date inside window.
    await db.tasks.insert_one({
        "id": tid_in, "company_id": cid, "title": "Order lumber",
        "due_date": "2026-02-18", "status": "open", "priority": "high",
        "assignee_user_id": uid})
    # Task outside window.
    await db.tasks.insert_one({
        "id": tid_out, "company_id": cid, "title": "Old task",
        "due_date": "2025-12-01", "status": "open", "priority": "low",
        "assignee_user_id": uid})
    # Time entry inside window.
    await db.time_entries.insert_one({
        "id": te_in, "company_id": cid, "employee_id": eid,
        "employee_name": "Alice Field", "project_id": pid, "project_name": "Warehouse Build",
        "phase_id": ph_in, "phase_name": "Framing", "date": "2026-02-21",
        "hours": 6.0, "cost_rate_snapshot": 60.0, "billable": True,
        "notes": "Wall framing", "created_by_user_id": uid})
    # Time entry outside window.
    await db.time_entries.insert_one({
        "id": te_out, "company_id": cid, "employee_id": eid,
        "employee_name": "Alice Field", "project_id": pid, "project_name": "Warehouse Build",
        "phase_id": None, "phase_name": None, "date": "2025-11-01",
        "hours": 8.0, "cost_rate_snapshot": 60.0, "billable": True,
        "notes": "old", "created_by_user_id": uid})
    return uid, create_token(uid, "client"), cid, eid, pid


async def _cleanup(uid, cid):
    for c in ("tasks", "phases", "time_entries", "employees", "projects", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_team_calendar_window_and_filter():
    async def _t():
        uid, token, cid, eid, pid = await _mk_env()
        try:
            async with await _client() as ac:
                # Window Feb 15 - Feb 22.
                r = await ac.get(
                    f"/api/companies/{cid}/team-calendar"
                    f"?date_from=2026-02-15&date_to=2026-02-22",
                    headers=_h(token))
                assert r.status_code == 200
                d = r.json()
                # Tasks: 1 inside window
                assert d["counts"]["tasks"] == 1
                assert d["tasks"][0]["title"] == "Order lumber"
                # Phases: 1 overlaps (Feb 20-Mar 5)
                assert d["counts"]["phases"] == 1
                assert d["phases"][0]["name"] == "Framing"
                assert d["phases"][0]["project_name"] == "Warehouse Build"
                # Time entries: 1 in window
                assert d["counts"]["time_entries"] == 1
                assert d["time_entries"][0]["hours"] == 6.0
                # Employees roster returned in full
                assert len(d["employees"]) == 1

                # Bad date -> 400
                r = await ac.get(
                    f"/api/companies/{cid}/team-calendar"
                    f"?date_from=BAD&date_to=2026-02-22",
                    headers=_h(token))
                assert r.status_code == 400

                # Reversed range -> 400
                r = await ac.get(
                    f"/api/companies/{cid}/team-calendar"
                    f"?date_from=2026-03-01&date_to=2026-02-01",
                    headers=_h(token))
                assert r.status_code == 400

                # Filter by employee_id: tasks assigned to this employee's
                # user_id + this employee's time entries only.
                r = await ac.get(
                    f"/api/companies/{cid}/team-calendar"
                    f"?date_from=2026-02-15&date_to=2026-02-22"
                    f"&employee_id={eid}",
                    headers=_h(token))
                d = r.json()
                assert d["counts"]["tasks"] == 1
                assert d["counts"]["time_entries"] == 1
                # Phases are project-scoped, still returned.
                assert d["counts"]["phases"] == 1

                # Filter by an unknown employee_id: no tasks (unresolved
                # user_id) and no time entries. Phases still returned.
                r = await ac.get(
                    f"/api/companies/{cid}/team-calendar"
                    f"?date_from=2026-02-15&date_to=2026-02-22"
                    f"&employee_id=does-not-exist",
                    headers=_h(token))
                d = r.json()
                assert d["counts"]["tasks"] == 0
                assert d["counts"]["time_entries"] == 0
                assert d["counts"]["phases"] == 1

                # Wider window includes the outside items too.
                r = await ac.get(
                    f"/api/companies/{cid}/team-calendar"
                    f"?date_from=2025-01-01&date_to=2026-12-31",
                    headers=_h(token))
                d = r.json()
                assert d["counts"]["tasks"] == 2
                assert d["counts"]["phases"] == 2
                assert d["counts"]["time_entries"] == 2
        finally:
            await _cleanup(uid, cid)
    _run(_t())
