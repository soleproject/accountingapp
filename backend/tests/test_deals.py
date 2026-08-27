"""Deals — Kanban CRUD, move (DnD), activities, Deal → Project handoff
(Feb 2026, Phase C kickoff)."""
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
    con = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"d_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "Deal Tester"})
    await db.companies.insert_one({"id": cid, "name": "Deal Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    await db.contacts.insert_one({"id": con, "company_id": cid,
                                    "name": "ACME Corp", "kind": "customer",
                                    "email": "buyer@acme.com"})
    return uid, create_token(uid, "client"), cid, con


async def _cleanup(uid, cid):
    for c in ("deals", "projects", "contacts", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_deals_crud_and_board():
    async def _t():
        uid, token, cid, con = await _mk_env()
        try:
            async with await _client() as ac:
                # Missing title → 400.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token), json={"value": 100})
                assert r.status_code == 400

                # Bad stage → 400.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "X", "stage": "pizza"})
                assert r.status_code == 400

                # Happy path — 3 deals across 3 stages.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "ACME support",
                          "contact_id": con, "value": 5000,
                          "stage": "lead"})
                assert r.status_code == 200
                d1 = r.json()["deal"]
                assert d1["stage"] == "lead"
                assert d1["probability"] == 10  # default for 'lead'
                assert len(d1["activities"]) == 1  # system: created
                assert d1["contact_name"] == "ACME Corp"

                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "ACME expansion", "contact_id": con,
                          "value": 20000, "stage": "proposal"})
                d2 = r.json()["deal"]

                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "One-off audit", "value": 1500,
                          "stage": "qualified", "probability": 40})
                d3 = r.json()["deal"]
                assert d3["probability"] == 40  # user override
                assert d3["contact_id"] is None  # optional

                # Board grouping + totals.
                r = await ac.get(f"/api/companies/{cid}/deals/board",
                                  headers=_h(token))
                assert r.status_code == 200
                b = r.json()
                by = {c["stage"]: c for c in b["columns"]}
                assert by["lead"]["count"] == 1
                assert by["qualified"]["count"] == 1
                assert by["proposal"]["count"] == 1
                assert by["won"]["count"] == 0
                # Weighted: 5000*0.10 + 1500*0.40 + 20000*0.50 = 500+600+10000 = 11100.
                assert b["totals"]["weighted"] == 11100.0
                assert b["totals"]["open_count"] == 3
                assert b["totals"]["open_value"] == 26500.0

                # PATCH — update value.
                r = await ac.patch(f"/api/companies/{cid}/deals/{d1['id']}",
                    headers=_h(token), json={"value": 6000})
                assert r.status_code == 200
                assert r.json()["deal"]["value"] == 6000.0
                # Bad probability → 400.
                r = await ac.patch(f"/api/companies/{cid}/deals/{d1['id']}",
                    headers=_h(token), json={"probability": 250})
                assert r.status_code == 400

                # Move — DnD from 'lead' to 'proposal', appending.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{d1['id']}/move",
                    headers=_h(token), json={"stage": "proposal"})
                assert r.status_code == 200
                moved = r.json()["deal"]
                assert moved["stage"] == "proposal"
                # Stage-change activity appended.
                assert any(a["kind"] == "stage_change" for a in moved["activities"])
                # Board reshuffle.
                r = await ac.get(f"/api/companies/{cid}/deals/board",
                                  headers=_h(token))
                by = {c["stage"]: c for c in r.json()["columns"]}
                assert by["lead"]["count"] == 0
                assert by["proposal"]["count"] == 2

                # Insert d1 above d2 in proposal column via before_id=d2.id.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{d1['id']}/move",
                    headers=_h(token),
                    json={"stage": "proposal", "before_id": d2["id"]})
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/deals?stage=proposal",
                    headers=_h(token))
                order = [x["id"] for x in r.json()["deals"]]
                assert order[0] == d1["id"] and order[1] == d2["id"]

                # Move d1 → won: probability auto-flips to 100.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{d1['id']}/move",
                    headers=_h(token), json={"stage": "won"})
                assert r.json()["deal"]["probability"] == 100

                # Activity append + validation.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{d2['id']}/activities",
                    headers=_h(token),
                    json={"kind": "call", "body": "Called Bob, deck v2 next week"})
                assert r.status_code == 200
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{d2['id']}/activities",
                    headers=_h(token), json={"kind": "yolo", "body": "hi"})
                assert r.status_code == 400
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{d2['id']}/activities",
                    headers=_h(token), json={"kind": "note", "body": ""})
                assert r.status_code == 400

                # DELETE.
                r = await ac.delete(f"/api/companies/{cid}/deals/{d3['id']}",
                                     headers=_h(token))
                assert r.status_code == 200
                r = await ac.delete(f"/api/companies/{cid}/deals/does-not-exist",
                                     headers=_h(token))
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_deal_to_project_conversion():
    async def _t():
        uid, token, cid, con = await _mk_env()
        try:
            async with await _client() as ac:
                # A deal without a contact CANNOT convert.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "Orphan", "value": 1000})
                orphan = r.json()["deal"]
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{orphan['id']}/convert-to-project",
                    headers=_h(token))
                assert r.status_code == 400
                assert "contact" in r.json()["detail"].lower()

                # Deal with a contact converts cleanly.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "ACME 3-month",
                          "contact_id": con, "value": 15000,
                          "stage": "negotiation",
                          "expected_close_date": "2026-06-01",
                          "notes": "1 QBO onboarding + 3mo support"})
                deal = r.json()["deal"]
                assert deal["project_id"] is None

                r = await ac.post(
                    f"/api/companies/{cid}/deals/{deal['id']}/convert-to-project",
                    headers=_h(token))
                assert r.status_code == 200
                out = r.json()
                assert out["already_converted"] is False
                proj = out["project"]
                assert proj["name"] == "ACME 3-month"
                assert proj["contact_id"] == con
                assert proj["contact_name"] == "ACME Corp"
                assert proj["estimated_revenue"] == 15000
                assert proj["notes"] == "1 QBO onboarding + 3mo support"
                assert proj["end_date"] == "2026-06-01"

                # Deal now shows project_id + stage='won' + probability=100
                # + stage_change + system activities.
                deal_after = out["deal"]
                assert deal_after["project_id"] == proj["id"]
                assert deal_after["stage"] == "won"
                assert deal_after["probability"] == 100
                kinds = [a["kind"] for a in deal_after["activities"]]
                assert "stage_change" in kinds and "system" in kinds

                # Repeat conversion → idempotent, no dup project.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{deal['id']}/convert-to-project",
                    headers=_h(token))
                assert r.status_code == 200
                assert r.json()["already_converted"] is True
                assert r.json()["project"]["id"] == proj["id"]

                # Duplicate name on the SAME contact → 409.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "ACME 3-month",     # same title
                          "contact_id": con, "value": 8000,
                          "stage": "proposal"})
                deal2 = r.json()["deal"]
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{deal2['id']}/convert-to-project",
                    headers=_h(token))
                assert r.status_code == 409

                # An explicit override name lets it through.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{deal2['id']}/convert-to-project",
                    headers=_h(token),
                    json={"name": "ACME 3-month (v2)"})
                assert r.status_code == 200
                assert r.json()["project"]["name"] == "ACME 3-month (v2)"
        finally:
            await _cleanup(uid, cid)
    _run(_t())
