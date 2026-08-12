"""Tests for `GET /partner/usage` — partner-scoped mirror of
`/admin/usage`. Returns the same shape but restricts events to the
partner's tree of companies.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_partner() -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"p_{uid[:6]}@example.com",
        "name": "P", "password": hash_password("x"),
        "role": "partner",
    })
    return uid


async def _mk_company(partner_id=None, enterprise_id=None) -> str:
    cid = str(uuid.uuid4())
    doc = {"id": cid, "name": f"Co-{cid[:6]}"}
    if partner_id:
        doc["partner_id"] = partner_id
    if enterprise_id:
        doc["enterprise_id"] = enterprise_id
    await db.companies.insert_one(doc)
    return cid


async def _emit(company_id, service, cents):
    await db.ai_usage_events.insert_one({
        "id": str(uuid.uuid4()),
        "feature": "test", "service": service, "provider": "test",
        "model": "n/a", "input_tokens": 0, "output_tokens": 0,
        "total_tokens": 0, "quantity": 0, "unit": "token",
        "cost_cents": float(cents),
        "user_id": None, "company_id": company_id,
        "ts": datetime.now(timezone.utc).isoformat(),
    })


async def _wipe(uids, cids, eids):
    for u in uids:
        await db.users.delete_one({"id": u})
    for c in cids:
        await db.companies.delete_one({"id": c})
        await db.ai_usage_events.delete_many({"company_id": c})
    for e in eids:
        await db.enterprises.delete_one({"id": e})


def test_partner_usage_only_counts_events_from_partner_tree():
    async def _t():
        pid = await _mk_partner()
        # Two companies IN tree
        c_in_1 = await _mk_company(partner_id=pid)
        c_in_2 = await _mk_company(partner_id=pid)
        # One company OUTSIDE tree (some other partner / superadmin's)
        c_out = await _mk_company()

        await _emit(c_in_1, "openai_llm", 1000)  # $10
        await _emit(c_in_2, "veryfi_ocr", 500)   # $5
        await _emit(c_out, "openai_llm", 99999)  # ignored

        try:
            tok = create_token(pid, "partner")
            async with await _client() as cl:
                r = await cl.get("/api/partner/usage?range=month",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["totals"]["cost_cents"] == 1500
            assert d["totals"]["events"] == 2
            services = {row["service"] for row in d["by_service"]}
            assert "openai_llm" in services
            assert "veryfi_ocr" in services
            assert d["tree_summary"]["company_count"] == 2
        finally:
            await _wipe([pid], [c_in_1, c_in_2, c_out], [])
    _run(_t())


def test_partner_usage_includes_enterprise_attached_companies():
    """Companies attached to a partner's enterprise via `enterprise_id`
    (with no direct `partner_id`) still count."""
    async def _t():
        pid = await _mk_partner()
        eid = str(uuid.uuid4())
        await db.enterprises.insert_one({
            "id": eid, "name": "Ent", "slug": f"e-{uuid.uuid4().hex[:6]}",
            "partner_id": pid,
        })
        c = await _mk_company(enterprise_id=eid)  # NO partner_id.
        await _emit(c, "openai_llm", 250)
        try:
            tok = create_token(pid, "partner")
            async with await _client() as cl:
                r = await cl.get("/api/partner/usage?range=month",
                                 headers={"Authorization": f"Bearer {tok}"})
            d = r.json()
            assert d["totals"]["cost_cents"] == 250
        finally:
            await _wipe([pid], [c], [eid])
    _run(_t())


def test_partner_usage_returns_zeros_when_no_tree():
    async def _t():
        pid = await _mk_partner()
        try:
            tok = create_token(pid, "partner")
            async with await _client() as cl:
                r = await cl.get("/api/partner/usage?range=month",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            d = r.json()
            assert d["totals"]["cost_cents"] == 0
            assert d["by_service"] == []
            assert d["tree_summary"]["company_count"] == 0
        finally:
            await _wipe([pid], [], [])
    _run(_t())


def test_partner_usage_role_gate_denies_non_partner():
    async def _t():
        # Non-partner Pro should be 403.
        uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": f"pro-{uid[:6]}@example.com",
            "name": "Pro", "password": hash_password("x"),
            "role": "pro",
        })
        try:
            tok = create_token(uid, "pro")
            async with await _client() as cl:
                r = await cl.get("/api/partner/usage",
                                 headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 403
        finally:
            await _wipe([uid], [], [])
    _run(_t())
