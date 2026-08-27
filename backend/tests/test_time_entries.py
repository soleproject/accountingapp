"""Time entries — CRUD, rollup, my-week (Feb 2026, Phase B-3)."""
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
    ph1 = str(uuid.uuid4()); ph2 = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"t_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "Tester"})
    await db.companies.insert_one({"id": cid, "name": "Time Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    # An employee linked to this user with a $50/hr cost rate.
    await db.employees.insert_one({
        "id": eid, "company_id": cid, "user_id": uid,
        "name": "Field Tester", "email": "field@x.com",
        "role": "field_employee", "hourly_cost_rate": 50.0, "active": True})
    await db.projects.insert_one({
        "id": pid, "company_id": cid, "name": "Warehouse Build", "active": True})
    await db.phases.insert_one({
        "id": ph1, "company_id": cid, "project_id": pid, "name": "Foundation"})
    await db.phases.insert_one({
        "id": ph2, "company_id": cid, "project_id": pid, "name": "Framing"})
    return uid, create_token(uid, "client"), cid, eid, pid, ph1, ph2


async def _cleanup(uid, cid):
    for c in ("time_entries", "employees", "phases", "projects",
              "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_time_entries_crud_rollup_myweek():
    async def _t():
        uid, token, cid, eid, pid, ph1, ph2 = await _mk_env()
        try:
            async with await _client() as ac:
                # -- Validation errors --
                # Missing employee_id
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"project_id": pid, "date": "2026-02-24", "hours": 4})
                assert r.status_code == 400
                # Bad date format
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "date": "02/24/2026", "hours": 4})
                assert r.status_code == 400
                # Hours out of range
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "date": "2026-02-24", "hours": 25})
                assert r.status_code == 400
                # Bad project
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": "does-not-exist",
                          "date": "2026-02-24", "hours": 4})
                assert r.status_code == 400

                # -- Happy path: 3 entries across 2 phases + 1 unassigned --
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "phase_id": ph1, "date": "2026-02-23", "hours": 8,
                          "notes": "Poured slab"})
                assert r.status_code == 200
                t1 = r.json()["time_entry"]
                # Snapshot must equal the employee's rate at write time.
                assert t1["cost_rate_snapshot"] == 50.0
                assert t1["billable"] is True

                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "phase_id": ph2, "date": "2026-02-24", "hours": 6.5,
                          "billable": False})
                assert r.status_code == 200
                t2 = r.json()["time_entry"]

                # Unassigned phase (still valid).
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "date": "2026-02-24", "hours": 1.5})
                assert r.status_code == 200
                t3 = r.json()["time_entry"]
                assert t3["phase_id"] is None

                # -- List by project --
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries?project_id={pid}",
                    headers=_h(token))
                assert r.status_code == 200
                data = r.json()
                assert data["count"] == 3
                assert data["total_hours"] == 16.0     # 8 + 6.5 + 1.5
                assert data["total_cost"] == 800.0     # 16 * 50

                # -- Filter: billable only --
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries?project_id={pid}&billable=true",
                    headers=_h(token))
                assert r.json()["count"] == 2   # excludes t2

                # -- Date range filter --
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries?project_id={pid}"
                    f"&date_from=2026-02-24&date_to=2026-02-24",
                    headers=_h(token))
                assert r.json()["count"] == 2   # excludes t1 (Feb 23)

                # -- Rollup --
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries/rollup?project_id={pid}",
                    headers=_h(token))
                assert r.status_code == 200
                roll = r.json()
                assert roll["totals"]["hours"] == 16.0
                assert roll["totals"]["cost"] == 800.0
                assert roll["totals"]["billable_hours"] == 9.5   # 8 + 1.5
                assert roll["totals"]["billable_cost"] == 475.0
                # Three phase buckets: Foundation, Framing, Unassigned.
                assert len(roll["by_phase"]) == 3
                foundation = next(p for p in roll["by_phase"] if p["phase_name"] == "Foundation")
                assert foundation["hours"] == 8.0
                assert foundation["cost"] == 400.0
                framing = next(p for p in roll["by_phase"] if p["phase_name"] == "Framing")
                assert framing["billable_hours"] == 0.0
                # By employee list has this single employee.
                assert len(roll["by_employee"]) == 1
                assert roll["by_employee"][0]["hours"] == 16.0

                # -- Patch: move t3 to phase 1 --
                r = await ac.patch(
                    f"/api/companies/{cid}/time-entries/{t3['id']}",
                    headers=_h(token),
                    json={"phase_id": ph1, "hours": 2})
                assert r.status_code == 200
                assert r.json()["time_entry"]["phase_name"] == "Foundation"
                assert r.json()["time_entry"]["hours"] == 2.0

                # Rollup reflects the change.
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries/rollup?project_id={pid}",
                    headers=_h(token))
                foundation = next(p for p in r.json()["by_phase"] if p["phase_name"] == "Foundation")
                assert foundation["hours"] == 10.0   # 8 + 2

                # -- my-week: t2 (Feb 24) & t3 (Feb 24 now 2h) fall in a
                # Monday-anchored week that also contains Feb 23. --
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries/my-week?anchor=2026-02-24",
                    headers=_h(token))
                assert r.status_code == 200
                mw = r.json()
                assert mw["monday"] == "2026-02-23"
                assert mw["sunday"] == "2026-03-01"
                assert mw["total_hours"] == 16.5    # 8 + 6.5 + 2
                # Feb 23 day totals 8h.
                d23 = next(d for d in mw["days"] if d["date"] == "2026-02-23")
                assert d23["hours"] == 8.0

                # -- Delete t2 --
                r = await ac.delete(
                    f"/api/companies/{cid}/time-entries/{t2['id']}",
                    headers=_h(token))
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries?project_id={pid}",
                    headers=_h(token))
                assert r.json()["count"] == 2

                # -- Deleting a non-existent entry → 404 --
                r = await ac.delete(
                    f"/api/companies/{cid}/time-entries/does-not-exist",
                    headers=_h(token))
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_time_entry_rate_snapshot_isolated_from_future_rate_change():
    """Changing employee.hourly_cost_rate after logging must not
    retroactively rewrite historical time_entry.cost_rate_snapshot."""
    async def _t():
        uid, token, cid, eid, pid, ph1, ph2 = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "phase_id": ph1, "date": "2026-02-01", "hours": 5})
                tid = r.json()["time_entry"]["id"]
                assert r.json()["time_entry"]["cost_rate_snapshot"] == 50.0

                # Raise the employee's rate to $80/hr going forward.
                await db.employees.update_one(
                    {"id": eid}, {"$set": {"hourly_cost_rate": 80.0}})

                # Historical row's snapshot must NOT change.
                r = await ac.get(
                    f"/api/companies/{cid}/time-entries?project_id={pid}",
                    headers=_h(token))
                only = r.json()["time_entries"][0]
                assert only["cost_rate_snapshot"] == 50.0
                assert r.json()["total_cost"] == 250.0

                # A brand-new entry picks up the new rate.
                r = await ac.post(f"/api/companies/{cid}/time-entries",
                    headers=_h(token),
                    json={"employee_id": eid, "project_id": pid,
                          "date": "2026-02-05", "hours": 4})
                assert r.json()["time_entry"]["cost_rate_snapshot"] == 80.0
        finally:
            await _cleanup(uid, cid)
    _run(_t())
