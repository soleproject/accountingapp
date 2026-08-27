"""Classes CRUD + features PATCH — Phase 2 backend surface (Feb 2026)."""
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
        "id": uid, "email": f"cls_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Classes Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "features": {"classes_enabled": False,
                     "projects_enabled": False,
                     "budgets_enabled": False},
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid: str, cid: str):
    for coll in ("classes", "transactions", "journal_entries",
                 "accounts", "memberships"):
        await db[coll].delete_many({"company_id": cid}
                                    if coll != "memberships"
                                    else {"user_id": uid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_features_patch_and_flag_default_off():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Default: all-False.
                company = await db.companies.find_one({"id": cid})
                assert company["features"]["classes_enabled"] is False

                # Flip Classes ON.
                r = await ac.patch(
                    f"/api/companies/{cid}/features",
                    headers=_h(token),
                    json={"classes_enabled": True})
                assert r.status_code == 200
                assert r.json()["features"]["classes_enabled"] is True
                assert r.json()["features"]["projects_enabled"] is False

                # Unknown flags → 400.
                r = await ac.patch(
                    f"/api/companies/{cid}/features",
                    headers=_h(token), json={"foobar": True})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_classes_crud_happy_path():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Create.
                r = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token), json={"name": "Sales"})
                assert r.status_code == 200
                cls_id = r.json()["class"]["id"]

                # Duplicate name → 409 (case-insensitive).
                r = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token), json={"name": "sales"})
                assert r.status_code == 409

                # List.
                r = await ac.get(
                    f"/api/companies/{cid}/classes", headers=_h(token))
                assert r.status_code == 200
                assert len(r.json()["classes"]) == 1

                # Rename.
                r = await ac.patch(
                    f"/api/companies/{cid}/classes/{cls_id}",
                    headers=_h(token), json={"name": "Sales & Ops"})
                assert r.status_code == 200
                assert r.json()["class"]["name"] == "Sales & Ops"

                # Archive (soft delete).
                r = await ac.delete(
                    f"/api/companies/{cid}/classes/{cls_id}",
                    headers=_h(token))
                assert r.status_code == 200

                # Archived rows hidden by default …
                r = await ac.get(
                    f"/api/companies/{cid}/classes", headers=_h(token))
                assert len(r.json()["classes"]) == 0
                # … but visible with the escape hatch.
                r = await ac.get(
                    f"/api/companies/{cid}/classes?include_inactive=1",
                    headers=_h(token))
                assert len(r.json()["classes"]) == 1
                assert r.json()["classes"][0]["active"] is False

                # Hard delete when NOT in use → OK.
                r = await ac.delete(
                    f"/api/companies/{cid}/classes/{cls_id}?hard=1",
                    headers=_h(token))
                assert r.status_code == 200
                assert r.json()["hard"] is True
                r = await ac.get(
                    f"/api/companies/{cid}/classes?include_inactive=1",
                    headers=_h(token))
                assert len(r.json()["classes"]) == 0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_class_in_use_blocks_hard_delete():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token), json={"name": "Ops"})
                cls_id = r.json()["class"]["id"]

                # Reference the class from a JE line.
                await db.journal_entries.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-02-15",
                    "lines": [{"account_id": "any", "debit": 10.0,
                               "credit": 0.0, "class_id": cls_id}],
                })

                # Hard delete blocked.
                r = await ac.delete(
                    f"/api/companies/{cid}/classes/{cls_id}?hard=1",
                    headers=_h(token))
                assert r.status_code == 400
                assert "referenced" in r.json()["detail"].lower()

                # Soft delete still works.
                r = await ac.delete(
                    f"/api/companies/{cid}/classes/{cls_id}",
                    headers=_h(token))
                assert r.status_code == 200
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_txn_patch_accepts_class_id_and_clears_via_empty_string():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Set up a class.
                r = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token), json={"name": "West"})
                cls_id = r.json()["class"]["id"]

                # Set up a manual txn (no accounts required — the FK
                # lands on the top-level txn field).
                tid = str(uuid.uuid4())
                await db.transactions.insert_one({
                    "id": tid, "company_id": cid,
                    "date": "2026-02-10", "posted": True,
                    "amount": -50.0, "merchant": "Anywhere",
                })

                # Assign class.
                r = await ac.patch(
                    f"/api/companies/{cid}/transactions/{tid}",
                    headers=_h(token), json={"class_id": cls_id})
                assert r.status_code == 200
                t = await db.transactions.find_one({"id": tid})
                assert t["class_id"] == cls_id

                # Clear via empty string.
                r = await ac.patch(
                    f"/api/companies/{cid}/transactions/{tid}",
                    headers=_h(token), json={"class_id": ""})
                assert r.status_code == 200
                t = await db.transactions.find_one({"id": tid})
                assert t.get("class_id") is None
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_parent_nesting_capped_at_one_level():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                r1 = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token), json={"name": "Parent"})
                parent_id = r1.json()["class"]["id"]
                r2 = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token),
                    json={"name": "Child", "parent_class_id": parent_id})
                assert r2.status_code == 200
                child_id = r2.json()["class"]["id"]

                # Nesting under a child → 400.
                r3 = await ac.post(
                    f"/api/companies/{cid}/classes",
                    headers=_h(token),
                    json={"name": "Grand", "parent_class_id": child_id})
                assert r3.status_code == 400
        finally:
            await _cleanup(uid, cid)

    _run(_t())
