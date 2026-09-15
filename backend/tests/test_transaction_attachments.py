"""Regression tests for the transaction attachments endpoints
(add / get / delete) added Feb 2026.
"""
from __future__ import annotations
import base64
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


async def _mk_pro_and_txn():
    """Seed pro + company + one transaction. Returns (jwt, cid, tid)."""
    cid = f"test-{uuid.uuid4()}"
    tid = f"txn-{uuid.uuid4()}"
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
    await db.transactions.insert_one({
        "id": tid, "company_id": cid,
        "date": "2026-09-06", "amount": -483.29,
        "merchant": "The Home Depot",
        "description": "HOME DEPOT #6234 RENO NV",
    })
    return create_token(uid, "pro"), cid, tid


async def _cleanup(cid: str):
    uid = f"p-{cid[:8]}"
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": uid})
    await db.memberships.delete_many({"user_id": uid})
    await db.transactions.delete_many({"company_id": cid})


def _tiny_png_data_url() -> str:
    # 1×1 red pixel PNG
    return ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABC"
            "AYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


async def _e2e_add_get_delete_attachment():
    jwt, cid, tid = await _mk_pro_and_txn()
    hdrs = {"Authorization": f"Bearer {jwt}"}
    async with _client() as c:
        # POST
        r = await c.post(
            f"/api/companies/{cid}/transactions/{tid}/attachments",
            headers=hdrs,
            json={"data_url": _tiny_png_data_url(),
                  "filename": "receipt.png",
                  "mime":     "image/png"},
        )
        assert r.status_code == 200, r.text
        att = r.json()["attachment"]
        aid = att["id"]
        # Response MUST NOT echo the base64 blob back
        assert "data_url" not in att
        assert att["filename"] == "receipt.png"
        assert att["mime"] == "image/png"
        assert att["source"] == "manual"

        # Persisted on the transaction doc
        doc = await db.transactions.find_one({"id": tid, "company_id": cid})
        atts = doc.get("attachments") or []
        assert len(atts) == 1
        assert atts[0]["id"] == aid
        assert atts[0]["data_url"].startswith("data:image/png;base64,")

        # GET returns the full data_url
        r = await c.get(
            f"/api/companies/{cid}/transactions/{tid}/attachments/{aid}",
            headers=hdrs,
        )
        assert r.status_code == 200, r.text
        assert r.json()["attachment"]["data_url"].startswith("data:image/png")

        # DELETE
        r = await c.delete(
            f"/api/companies/{cid}/transactions/{tid}/attachments/{aid}",
            headers=hdrs,
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}
        doc = await db.transactions.find_one({"id": tid, "company_id": cid})
        assert (doc.get("attachments") or []) == []
    await _cleanup(cid)


def test_add_get_delete_attachment():
    run(_e2e_add_get_delete_attachment())


async def _e2e_get_attachment_404():
    jwt, cid, tid = await _mk_pro_and_txn()
    hdrs = {"Authorization": f"Bearer {jwt}"}
    async with _client() as c:
        r = await c.get(
            f"/api/companies/{cid}/transactions/{tid}/attachments/does-not-exist",
            headers=hdrs,
        )
        assert r.status_code == 404, r.text
    await _cleanup(cid)


def test_get_attachment_404():
    run(_e2e_get_attachment_404())


async def _e2e_txn_not_found_404():
    jwt, cid, _ = await _mk_pro_and_txn()
    hdrs = {"Authorization": f"Bearer {jwt}"}
    async with _client() as c:
        r = await c.post(
            f"/api/companies/{cid}/transactions/no-such-txn/attachments",
            headers=hdrs,
            json={"data_url": _tiny_png_data_url(), "filename": "x.png"},
        )
        assert r.status_code == 404, r.text
    await _cleanup(cid)


def test_txn_not_found_404():
    run(_e2e_txn_not_found_404())


async def _e2e_cross_tenant_forbidden():
    jwt, cid, tid = await _mk_pro_and_txn()
    other_jwt, other_cid, _ = await _mk_pro_and_txn()
    hdrs = {"Authorization": f"Bearer {other_jwt}"}
    async with _client() as c:
        r = await c.post(
            f"/api/companies/{cid}/transactions/{tid}/attachments",
            headers=hdrs,
            json={"data_url": _tiny_png_data_url(), "filename": "x.png"},
        )
        assert r.status_code in (403, 404), r.text
    await _cleanup(cid); await _cleanup(other_cid)


def test_cross_tenant_forbidden():
    run(_e2e_cross_tenant_forbidden())
