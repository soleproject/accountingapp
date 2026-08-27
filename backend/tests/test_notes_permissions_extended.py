"""Extended B-2 regression: cross-company Notes isolation, entity-bleed
guard, and permission_overrides validation (Feb 2026, iteration 77)."""
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


async def _mk_user_company(prefix="ext"):
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"{prefix}_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": f"{prefix} Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for coll in ("notes", "employees", "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def test_notes_cross_company_blocked():
    async def _t():
        u1, t1, c1 = await _mk_user_company("A")
        u2, t2, c2 = await _mk_user_company("B")
        try:
            async with await _client() as ac:
                # Create note on company A
                r = await ac.post(f"/api/companies/{c1}/notes", headers=_h(t1),
                                  json={"body": "secret A", "entity_type": "project",
                                        "entity_id": "px"})
                assert r.status_code == 200
                nid = r.json()["note"]["id"]

                # User B cannot list company A notes
                r = await ac.get(
                    f"/api/companies/{c1}/notes?entity_type=project&entity_id=px",
                    headers=_h(t2))
                assert r.status_code in (403, 404)

                # User B cannot patch company A note
                r = await ac.patch(f"/api/companies/{c1}/notes/{nid}",
                                    headers=_h(t2), json={"body": "hacked"})
                assert r.status_code in (403, 404)

                # User B cannot delete company A note
                r = await ac.delete(f"/api/companies/{c1}/notes/{nid}",
                                     headers=_h(t2))
                assert r.status_code in (403, 404)
        finally:
            await _cleanup(u1, c1)
            await _cleanup(u2, c2)
    _run(_t())


def test_notes_missing_entity_fields_returns_400():
    async def _t():
        uid, token, cid = await _mk_user_company("miss")
        try:
            async with await _client() as ac:
                # missing entity_type
                r = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                                  json={"body": "hi", "entity_id": "x"})
                assert r.status_code == 400
                # missing entity_id
                r = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                                  json={"body": "hi", "entity_type": "project"})
                assert r.status_code == 400
                # both blank
                r = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                                  json={"body": "hi", "entity_type": "  ",
                                        "entity_id": "  "})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_notes_no_bleed_across_entity_types():
    async def _t():
        uid, token, cid = await _mk_user_company("bleed")
        try:
            async with await _client() as ac:
                # Create notes on 3 different entity types with same-ish IDs
                for et, eid, body in [
                    ("employee", "e1", "note-e1"),
                    ("project", "e1", "note-p1"),  # same eid, different type
                    ("invoice", "inv-1", "note-inv"),
                ]:
                    r = await ac.post(f"/api/companies/{cid}/notes",
                        headers=_h(token),
                        json={"body": body, "entity_type": et, "entity_id": eid})
                    assert r.status_code == 200

                r = await ac.get(
                    f"/api/companies/{cid}/notes?entity_type=employee&entity_id=e1",
                    headers=_h(token))
                assert r.json()["count"] == 1
                assert r.json()["notes"][0]["body"] == "note-e1"

                r = await ac.get(
                    f"/api/companies/{cid}/notes?entity_type=project&entity_id=e1",
                    headers=_h(token))
                assert r.json()["count"] == 1
                assert r.json()["notes"][0]["body"] == "note-p1"

                r = await ac.get(
                    f"/api/companies/{cid}/notes?entity_type=invoice&entity_id=inv-1",
                    headers=_h(token))
                assert r.json()["count"] == 1
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_notes_pinned_ordering_two_notes():
    async def _t():
        uid, token, cid = await _mk_user_company("ord")
        try:
            async with await _client() as ac:
                r1 = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                    json={"body": "first", "entity_type": "project", "entity_id": "p1"})
                r2 = await ac.post(f"/api/companies/{cid}/notes", headers=_h(token),
                    json={"body": "second", "entity_type": "project", "entity_id": "p1"})
                nid2 = r2.json()["note"]["id"]

                # Pin the second
                r = await ac.patch(f"/api/companies/{cid}/notes/{nid2}",
                                   headers=_h(token), json={"pinned": True})
                assert r.json()["note"]["pinned"] is True

                r = await ac.get(
                    f"/api/companies/{cid}/notes?entity_type=project&entity_id=p1",
                    headers=_h(token))
                notes = r.json()["notes"]
                assert len(notes) == 2
                assert notes[0]["body"] == "second"
                assert notes[0]["pinned"] is True
                assert notes[1]["body"] == "first"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_employee_permission_overrides_non_dict_rejected():
    async def _t():
        uid, token, cid = await _mk_user_company("po")
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/employees", headers=_h(token),
                    json={"name": "PO Test", "role": "field_employee"})
                eid = r.json()["employee"]["id"]

                # Non-dict payload → 400
                for bad in [["accounting"], "yes", 42, True]:
                    r = await ac.patch(f"/api/companies/{cid}/employees/{eid}",
                        headers=_h(token),
                        json={"permission_overrides": bad})
                    assert r.status_code == 400, f"bad={bad!r} got {r.status_code}"

                # Valid dict → 200 and effective flips
                r = await ac.patch(f"/api/companies/{cid}/employees/{eid}",
                    headers=_h(token),
                    json={"permission_overrides": {"accounting": True}})
                assert r.status_code == 200
                r = await ac.get(
                    f"/api/companies/{cid}/employees/{eid}/permissions",
                    headers=_h(token))
                p = r.json()
                assert p["effective"]["accounting"] is True
                assert p["role_defaults"]["accounting"] is False
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_employees_duplicate_email_case_insensitive():
    async def _t():
        uid, token, cid = await _mk_user_company("dup")
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/employees", headers=_h(token),
                    json={"name": "A", "email": "same@example.com"})
                assert r.status_code == 200
                r = await ac.post(f"/api/companies/{cid}/employees", headers=_h(token),
                    json={"name": "B", "email": "SAME@example.com"})
                assert r.status_code == 409
        finally:
            await _cleanup(uid, cid)
    _run(_t())
