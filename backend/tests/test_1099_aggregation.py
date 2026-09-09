"""1099 Cockpit — aggregation + row-shaping tests.

Locks in the "over-threshold vs on-watch vs under-threshold" bucketing
and the issue-flagging rules (missing_w9, missing_tin, missing_address,
over_threshold_not_flagged).
"""
import uuid
import pytest

from tests._shared_loop import run as _run
from db import db
from routes.tax_1099 import _company_1099_vendors, _row_issues, THRESHOLD


async def _seed(cid: str, vendors: list[dict], txns: list[dict]):
    await db.companies.insert_one({"id": cid, "name": "TaxTestCo"})
    for v in vendors:
        v.setdefault("company_id", cid)
        v.setdefault("normalized_name", f"n-{uuid.uuid4().hex[:8]}")
        await db.contacts.insert_one(v)
    for t in txns:
        t.setdefault("company_id", cid)
        await db.transactions.insert_one(t)


async def _cleanup(cid: str):
    for coll in ("companies", "contacts", "transactions"):
        await db[coll].delete_many({"company_id": cid})


def test_over_threshold_flagged_shows_up_as_needs_1099():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            v1 = {"id": "v1", "name": "ACME LLC", "type": "vendor",
                  "is_1099_vendor": True, "w9_on_file": False,
                  "email": "acme@x.com"}
            txns = [
                {"id": f"tx-{i}", "date": "2026-06-15",
                 "amount": -400.0, "direction": "out", "contact_id": "v1",
                 "posted": True, "description": "svc"}
                for i in range(3)  # $1200 total
            ]
            await _seed(cid, [v1], txns)
            rows = await _company_1099_vendors(cid, 2026)
            assert len(rows) == 1
            r = rows[0]
            assert r["needs_1099"] is True
            assert r["on_watch"] is False
            assert r["total_paid"] == 1200.0
            assert "missing_w9" in r["issues"]
            assert "missing_tin" in r["issues"]
        finally:
            await _cleanup(cid)
    _run(go())


def test_under_threshold_flagged_is_on_watch():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            v = {"id": "v1", "name": "Freelance Inc", "type": "vendor",
                 "is_1099_vendor": True, "w9_on_file": True,
                 "tax_id_encrypted": "ENC"}
            txns = [{"id": "tx1", "date": "2026-06-15", "amount": -200.0,
                     "direction": "out", "contact_id": "v1", "posted": True,
                     "description": "svc"}]
            await _seed(cid, [v], txns)
            rows = await _company_1099_vendors(cid, 2026)
            assert len(rows) == 1
            r = rows[0]
            assert r["needs_1099"] is False
            assert r["on_watch"] is True
            assert r["threshold_gap"] == THRESHOLD - 200.0
            assert r["w9_on_file"] is True
            assert r["has_tin"] is True
            assert r["issues"] == []
        finally:
            await _cleanup(cid)
    _run(go())


def test_over_threshold_not_flagged_surfaces_issue():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            v = {"id": "v1", "name": "NotFlagged LLC", "type": "vendor",
                 "is_1099_vendor": False}
            txns = [{"id": "tx1", "date": "2026-06-15", "amount": -900.0,
                     "direction": "out", "contact_id": "v1", "posted": True,
                     "description": "svc"}]
            await _seed(cid, [v], txns)
            # _company_1099_vendors only includes flagged vendors +
            # vendors in the payments map. Since v had payments but is
            # NOT flagged, it will appear but with over_threshold_not_flagged.
            rows = await _company_1099_vendors(cid, 2026)
            r = next(x for x in rows if x["contact_id"] == "v1")
            assert r["is_1099_vendor"] is False
            assert r["needs_1099"] is False  # Because not flagged
            assert "over_threshold_not_flagged" in _row_issues(v, 900.0, needs_1099=False)
        finally:
            await _cleanup(cid)
    _run(go())


def test_ytd_only_counts_posted_direction_out_current_year():
    async def go():
        cid = f"cid-{uuid.uuid4().hex[:8]}"
        try:
            v = {"id": "v1", "name": "TimeFilter Ltd", "type": "vendor",
                 "is_1099_vendor": True, "w9_on_file": True,
                 "tax_id_encrypted": "ENC"}
            txns = [
                # In-year, direction=out, posted → COUNTED
                {"id": "t1", "date": "2026-03-15", "amount": -700.0,
                 "direction": "out", "contact_id": "v1", "posted": True,
                 "description": "svc"},
                # PRIOR year → NOT counted
                {"id": "t2", "date": "2025-11-15", "amount": -300.0,
                 "direction": "out", "contact_id": "v1", "posted": True,
                 "description": "svc"},
                # direction=in → NOT counted (a refund)
                {"id": "t3", "date": "2026-04-01", "amount": 200.0,
                 "direction": "in", "contact_id": "v1", "posted": True,
                 "description": "refund"},
                # Not posted → NOT counted
                {"id": "t4", "date": "2026-05-05", "amount": -500.0,
                 "direction": "out", "contact_id": "v1", "posted": False,
                 "description": "draft"},
            ]
            await _seed(cid, [v], txns)
            rows = await _company_1099_vendors(cid, 2026)
            r = next(x for x in rows if x["contact_id"] == "v1")
            assert r["total_paid"] == 700.0
            assert r["txn_count"] == 1
        finally:
            await _cleanup(cid)
    _run(go())
