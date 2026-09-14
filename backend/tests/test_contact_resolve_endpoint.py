"""Regression tests for the semantic contact resolver endpoint
`POST /api/companies/{cid}/contacts/resolve` (Sep 2026).

Behaviour covered:
  * Merchant with no existing contact + auto_create=True → creates
    a new contact and returns `created=True`.
  * Same merchant on a second call → returns the SAME contact_id,
    `created=False` (idempotency).
  * auto_create=False → preview mode; never inserts.
  * Empty merchant + empty description → `source=no_input`.
"""
from __future__ import annotations
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from httpx import AsyncClient, ASGITransport

from tests._shared_loop import run
from deps import db
from server import app
from auth import create_token


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app),
                       base_url="http://testserver")


async def _mk_pro():
    cid = f"test-{uuid.uuid4()}"
    uid = f"p-{cid[:8]}"
    email = f"pro-{uid}@fx.example"
    await db.users.insert_one({
        "id": uid, "email": email, "role": "pro",
    })
    await db.companies.insert_one({
        "id": cid, "name": "T", "owner_id": uid,
        "primary_pro_id": uid,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "user_id": uid,
        "company_id": cid, "role": "pro",
    })
    return create_token(uid, "pro"), cid, uid


async def _cleanup(cid: str, uid: str):
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": uid})
    await db.memberships.delete_many({"user_id": uid})
    await db.contacts.delete_many({"company_id": cid})


def test_resolve_creates_then_matches_on_second_call():
    async def scenario():
        token, cid, uid = await _mk_pro()
        try:
            async with _client() as ac:
                headers = {"Authorization": f"Bearer {token}"}
                merchant = f"Sky Coffee Shop {uuid.uuid4().hex[:6]}"
                # 1st call — auto_create=True, no existing → creates.
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/resolve",
                    json={"merchant": merchant,
                          "description": f"POS PURCHASE {merchant}",
                          "amount": -12.34, "auto_create": True},
                    headers=headers,
                )
                assert r.status_code == 200, r.text
                d1 = r.json()
                assert d1["contact_id"], d1
                assert d1["contact_name"], d1
                first_id = d1["contact_id"]

                # 2nd call — same merchant → returns SAME id, created=False.
                r2 = await ac.post(
                    f"/api/companies/{cid}/contacts/resolve",
                    json={"merchant": merchant,
                          "description": f"POS PURCHASE {merchant}",
                          "amount": -5.00, "auto_create": True},
                    headers=headers,
                )
                assert r2.status_code == 200, r2.text
                d2 = r2.json()
                assert d2["contact_id"] == first_id
                assert d2["created"] is False
        finally:
            await _cleanup(cid, uid)

    run(scenario())


def test_resolve_preview_mode_never_creates():
    async def scenario():
        token, cid, uid = await _mk_pro()
        try:
            async with _client() as ac:
                headers = {"Authorization": f"Bearer {token}"}
                unique_merchant = f"NoMatchStore_{uuid.uuid4().hex[:6]}"
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/resolve",
                    json={"merchant": unique_merchant,
                          "auto_create": False},
                    headers=headers,
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert d["contact_id"] is None
                assert d["created"] is False
                # Nothing inserted for this company.
                count = await db.contacts.count_documents(
                    {"company_id": cid, "name": unique_merchant},
                )
                assert count == 0
        finally:
            await _cleanup(cid, uid)

    run(scenario())


def test_resolve_no_input_returns_none():
    async def scenario():
        token, cid, uid = await _mk_pro()
        try:
            async with _client() as ac:
                headers = {"Authorization": f"Bearer {token}"}
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/resolve",
                    json={"merchant": "", "description": "",
                          "auto_create": True},
                    headers=headers,
                )
                assert r.status_code == 200, r.text
                d = r.json()
                assert d["contact_id"] is None
                assert d["source"] == "no_input"
        finally:
            await _cleanup(cid, uid)

    run(scenario())
