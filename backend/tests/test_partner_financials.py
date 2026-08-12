"""Tests for `GET /api/partner/financials` — the real-$ Partner
Dashboard rollup.

Covers three shapes:
  1. Partner with only direct client companies + ai_usage_events.
  2. Partner with enterprises + enterprise_invoices → revenue.
  3. Combined tree (companies via enterprise_id) → usage aggregates
     across both direct + enterprise-attached companies.
"""
from __future__ import annotations

import asyncio
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


def _current_month_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _mk_partner() -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"partner_{uid[:6]}@example.com",
        "name": f"Partner {uid[:4]}", "password": hash_password("x"),
        "role": "partner", "branding": {"firm_name": "TestPartner"},
    })
    return uid


async def _mk_company(partner_id: str | None = None, enterprise_id: str | None = None) -> str:
    cid = str(uuid.uuid4())
    doc: dict = {"id": cid, "name": f"Co-{cid[:6]}"}
    if partner_id:
        doc["partner_id"] = partner_id
    if enterprise_id:
        doc["enterprise_id"] = enterprise_id
    await db.companies.insert_one(doc)
    return cid


async def _log_usage(company_id: str, service: str, cents: float, ts_month: str | None = None):
    """Insert an `ai_usage_events` row for the current month (or a
    specific YYYY-MM prefix) with the given cost."""
    ts = f"{ts_month}-15T12:00:00+00:00" if ts_month else _now_iso()
    await db.ai_usage_events.insert_one({
        "id": str(uuid.uuid4()),
        "feature": "test", "service": service, "provider": "test",
        "model": "gpt-test", "input_tokens": 0, "output_tokens": 0,
        "total_tokens": 0, "quantity": 0, "unit": "token",
        "cost_cents": float(cents),
        "user_id": None, "company_id": company_id, "ts": ts,
    })


async def _wipe(uids: list[str], cids: list[str], eids: list[str]):
    for uid in uids:
        await db.users.delete_one({"id": uid})
    for cid in cids:
        await db.companies.delete_one({"id": cid})
        await db.ai_usage_events.delete_many({"company_id": cid})
    for eid in eids:
        await db.enterprises.delete_one({"id": eid})
        await db.enterprise_invoices.delete_many({"enterprise_id": eid})


def test_financials_sums_usage_for_direct_client_companies():
    async def _t():
        pid = await _mk_partner()
        c1 = await _mk_company(partner_id=pid)
        c2 = await _mk_company(partner_id=pid)
        # Also a non-partner company — should NOT be counted.
        c3 = await _mk_company()

        await _log_usage(c1, "openai_llm", 1234)  # $12.34
        await _log_usage(c2, "veryfi_ocr", 500)   # $5.00
        await _log_usage(c3, "openai_llm", 9999)  # ignored

        tok = create_token(pid, "partner")
        async with await _client() as c:
            r = await c.get("/api/partner/financials",
                            headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        d = r.json()
        assert d["usage_cents_current"] == 1734  # 1234 + 500
        assert d["current_month_key"] == _current_month_key()
        # Two services in the breakdown, biggest first.
        services = {row["service"]: row["cents"] for row in d["by_service_current"]}
        assert services == {"openai_llm": 1234, "veryfi_ocr": 500}
        assert d["by_service_current"][0]["service"] == "openai_llm"

        await _wipe([pid], [c1, c2, c3], [])
    _run(_t())


def test_financials_sums_enterprise_invoice_revenue():
    async def _t():
        pid = await _mk_partner()
        # Three enterprises — the `(enterprise_id, month_key)` unique
        # index means we need a distinct enterprise per invoice row.
        eids: list[str] = []
        for _ in range(3):
            eid = str(uuid.uuid4())
            await db.enterprises.insert_one({
                "id": eid, "name": f"Ent-{eid[:6]}",
                "slug": f"ent-{uuid.uuid4().hex[:6]}",
                "partner_id": pid, "owner_user_id": None,
            })
            eids.append(eid)

        mk = _current_month_key()
        # Two finalized/paid invoices + one 'failed' (should be ignored).
        for eid, (status, cents) in zip(eids, [
            ("finalized", 4900), ("paid", 9800), ("failed", 500_000),
        ]):
            await db.enterprise_invoices.insert_one({
                "id": str(uuid.uuid4()),
                "enterprise_id": eid,
                "month_key": mk,
                "status": status,
                "amount_due_cents": cents,
                "created_at": _now_iso(),
            })

        tok = create_token(pid, "partner")
        async with await _client() as c:
            r = await c.get("/api/partner/financials",
                            headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        d = r.json()
        assert d["revenue_cents_current"] == 14700  # 4900 + 9800

        await _wipe([pid], [], eids)
    _run(_t())


def test_financials_pulls_usage_from_enterprise_attached_companies():
    """Companies attached to a partner's enterprise via `enterprise_id`
    (but without an explicit `partner_id`) still count toward usage."""
    async def _t():
        pid = await _mk_partner()
        eid = str(uuid.uuid4())
        await db.enterprises.insert_one({
            "id": eid, "name": "Ent", "slug": f"ent-{uuid.uuid4().hex[:6]}",
            "partner_id": pid,
        })
        # Company under the enterprise, NOT stamped with partner_id.
        c = await _mk_company(enterprise_id=eid)
        await _log_usage(c, "openai_llm", 250)

        tok = create_token(pid, "partner")
        async with await _client() as cc:
            r = await cc.get("/api/partner/financials",
                             headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        assert r.json()["usage_cents_current"] == 250

        await _wipe([pid], [c], [eid])
    _run(_t())


def test_financials_trend_returns_requested_month_window():
    async def _t():
        pid = await _mk_partner()
        c = await _mk_company(partner_id=pid)
        # Log usage in the current month AND the prior month.
        mk_current = _current_month_key()
        y, m = int(mk_current[:4]), int(mk_current[5:])
        m_prev = m - 1
        y_prev = y
        if m_prev == 0:
            m_prev = 12
            y_prev -= 1
        mk_prev = f"{y_prev:04d}-{m_prev:02d}"
        await _log_usage(c, "openai_llm", 100, ts_month=mk_current)
        await _log_usage(c, "openai_llm", 200, ts_month=mk_prev)

        tok = create_token(pid, "partner")
        async with await _client() as cc:
            r = await cc.get("/api/partner/financials?months=3",
                             headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        d = r.json()
        assert len(d["trend"]) == 3
        # Order: oldest → newest.
        by_month = {t["month_key"]: t for t in d["trend"]}
        assert by_month[mk_current]["usage_cents"] == 100
        assert by_month[mk_prev]["usage_cents"] == 200
        # Any older bucket should be zero.
        oldest = d["trend"][0]["month_key"]
        if oldest not in (mk_current, mk_prev):
            assert d["trend"][0]["usage_cents"] == 0

        await _wipe([pid], [c], [])
    _run(_t())


def test_financials_isolation_partner_cannot_see_other_partner_data():
    async def _t():
        p_a = await _mk_partner()
        p_b = await _mk_partner()
        c_a = await _mk_company(partner_id=p_a)
        c_b = await _mk_company(partner_id=p_b)
        await _log_usage(c_a, "openai_llm", 100)
        await _log_usage(c_b, "openai_llm", 999)

        tok_a = create_token(p_a, "partner")
        async with await _client() as c:
            r = await c.get("/api/partner/financials",
                            headers={"Authorization": f"Bearer {tok_a}"})
        d = r.json()
        # Partner A only sees $1.00, never Partner B's $9.99.
        assert d["usage_cents_current"] == 100

        await _wipe([p_a, p_b], [c_a, c_b], [])
    _run(_t())
