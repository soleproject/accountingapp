"""Budgets — extra validation coverage for Phase 4 review."""
from __future__ import annotations
import sys, uuid
sys.path.insert(0, "/app/backend")

from db import db
from auth import create_token, hash_password
from tests._shared_loop import run as _run


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk():
    uid = str(uuid.uuid4()); cid = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"bv_{uid[:6]}@e.com",
                               "password": hash_password("x"), "role": "client"})
    await db.companies.insert_one({"id": cid, "name": "Val Co",
                                   "owner_user_id": uid,
                                   "reporting_basis": "accrual",
                                   "features": {"budgets_enabled": True}})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    await db.accounts.insert_one({"id": f"rev-{cid[:6]}", "company_id": cid,
                                  "code": "4000", "name": "Sales",
                                  "type": "revenue", "active": True})
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for c in ("budgets", "budget_lines", "accounts", "memberships"):
        await db[c].delete_many({"company_id": cid} if c != "memberships" else {"user_id": uid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_create_validation_errors():
    async def _t():
        uid, tok, cid = await _mk()
        try:
            async with await _client() as ac:
                # Missing name
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok), json={"fiscal_year": 2026})
                assert r.status_code == 400
                # Missing/invalid fiscal_year
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok), json={"name": "X", "fiscal_year": "abc"})
                assert r.status_code == 400
                # Out-of-range
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok), json={"name": "X", "fiscal_year": 1800})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_list_sorted_and_404():
    async def _t():
        uid, tok, cid = await _mk()
        try:
            async with await _client() as ac:
                for fy in (2024, 2026, 2025):
                    r = await ac.post(f"/api/companies/{cid}/budgets",
                                      headers=_h(tok),
                                      json={"name": f"B{fy}", "fiscal_year": fy})
                    assert r.status_code == 200
                r = await ac.get(f"/api/companies/{cid}/budgets", headers=_h(tok))
                assert r.status_code == 200
                fys = [b["fiscal_year"] for b in r.json()["budgets"]]
                assert fys == sorted(fys, reverse=True)
                # 404 unknown
                r = await ac.get(f"/api/companies/{cid}/budgets/does-not-exist",
                                 headers=_h(tok))
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_patch_invalid_status():
    async def _t():
        uid, tok, cid = await _mk()
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok),
                                  json={"name": "S", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]
                r = await ac.patch(f"/api/companies/{cid}/budgets/{bid}",
                                   headers=_h(tok), json={"status": "bogus"})
                assert r.status_code == 400
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_delete_cascades_lines():
    async def _t():
        uid, tok, cid = await _mk()
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok),
                                  json={"name": "C", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]
                accts = await db.accounts.find({"company_id": cid}).to_list(10)
                rev_id = accts[0]["id"]
                await ac.put(f"/api/companies/{cid}/budgets/{bid}/lines",
                             headers=_h(tok),
                             json={"lines": [{"account_id": rev_id,
                                              "period_key": "2026-01",
                                              "amount": 100}]})
                assert await db.budget_lines.count_documents(
                    {"budget_id": bid}) == 1
                r = await ac.delete(f"/api/companies/{cid}/budgets/{bid}",
                                    headers=_h(tok))
                assert r.status_code == 200
                assert await db.budget_lines.count_documents(
                    {"budget_id": bid}) == 0
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_variance_cash_basis_works():
    async def _t():
        uid, tok, cid = await _mk()
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok),
                                  json={"name": "P", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]
                r = await ac.get(f"/api/companies/{cid}/reports/budget-vs-actuals"
                                 f"?budget_id={bid}&basis=cash",
                                 headers=_h(tok))
                assert r.status_code == 200
                data = r.json()
                assert data["basis"] == "cash"
                assert len(data["months"]) == 12
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_unknown_account_silently_skipped():
    async def _t():
        uid, tok, cid = await _mk()
        try:
            async with await _client() as ac:
                r = await ac.post(f"/api/companies/{cid}/budgets",
                                  headers=_h(tok),
                                  json={"name": "U", "fiscal_year": 2026})
                bid = r.json()["budget"]["id"]
                r = await ac.put(f"/api/companies/{cid}/budgets/{bid}/lines",
                                 headers=_h(tok),
                                 json={"lines": [{"account_id": "ghost",
                                                  "period_key": "2026-01",
                                                  "amount": 500}]})
                assert r.status_code == 200
                assert r.json()["upserted"] == 0
        finally:
            await _cleanup(uid, cid)
    _run(_t())
