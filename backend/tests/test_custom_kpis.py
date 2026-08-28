"""Custom KPIs — validator + executor safety (Feb 2026, Phase D-3).

Skips the actual LLM round-trip (that path is exercised end-to-end
in the UI smoke test). We focus on the security-critical pieces:
1) validator rejects disallowed collections/stages/operators
2) executor injects `company_id` even if the model forgets
"""
from __future__ import annotations
import sys, uuid
sys.path.insert(0, "/app/backend")

import pytest

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4()); cid = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"k_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "K Tester"})
    await db.companies.insert_one({"id": cid, "name": "K Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for c in ("custom_kpis", "deals", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_custom_kpi_validator_rejects_bad_specs():
    """Save endpoint must reject disallowed collections, stages, and
    operators before it ever touches the DB."""
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                base = {"name": "X", "value_kind": "number", "tone": "violet",
                        "scope": "user", "spec": {}}

                # Bad collection.
                r = await ac.post(f"/api/companies/{cid}/custom-kpis",
                    headers=_h(token),
                    json={**base, "spec": {"collection": "users",
                                              "pipeline": [{"$count": "value"}]}})
                assert r.status_code == 400, r.text
                assert "collection" in r.text.lower()

                # Empty pipeline.
                r = await ac.post(f"/api/companies/{cid}/custom-kpis",
                    headers=_h(token),
                    json={**base, "spec": {"collection": "deals",
                                              "pipeline": []}})
                assert r.status_code == 400

                # Disallowed stage ($lookup).
                r = await ac.post(f"/api/companies/{cid}/custom-kpis",
                    headers=_h(token),
                    json={**base, "spec": {"collection": "deals",
                                              "pipeline": [
                                                {"$lookup": {"from": "users"}}
                                              ]}})
                assert r.status_code == 400
                assert "$lookup" in r.text

                # Happy path.
                r = await ac.post(f"/api/companies/{cid}/custom-kpis",
                    headers=_h(token),
                    json={**base,
                          "spec": {"collection": "deals",
                                    "pipeline": [
                                        {"$match": {"stage": "won"}},
                                        {"$count": "value"},
                                    ]}})
                assert r.status_code == 200, r.text
                kpi_id = r.json()["kpi"]["id"]

                # List + delete.
                r = await ac.get(f"/api/companies/{cid}/custom-kpis",
                                  headers=_h(token))
                assert len(r.json()["kpis"]) == 1

                r = await ac.delete(
                    f"/api/companies/{cid}/custom-kpis/{kpi_id}",
                    headers=_h(token))
                assert r.status_code == 200
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_custom_kpi_executor_injects_company_filter():
    """Even if the model forgets company_id, the executor forces it
    so cross-tenant leakage is impossible."""
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            # Seed 1 deal on our company + 1 on a phantom company.
            await db.deals.insert_many([
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "title": "Ours", "stage": "won", "value": 100},
                {"id": str(uuid.uuid4()), "company_id": "phantom-co",
                 "title": "Someone else's", "stage": "won", "value": 999},
            ])
            # KPI without a company_id filter.
            from routes.custom_kpis import run_custom_kpi
            kpi = {"spec": {
                "collection": "deals",
                "pipeline": [{"$count": "value"}],
                "result_field": "value",
            }}
            value = await run_custom_kpi(cid, kpi)
            # Should count ONLY our deal (1), not both (2).
            assert value == 1, f"Cross-tenant leakage! got {value}"
        finally:
            await _cleanup(uid, cid)
    _run(_t())
