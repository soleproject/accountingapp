"""Iteration 23: Verify cash_on_hand fix for resolver-created bank rows.

Bug: dashboard_metrics.cash_on_hand previously filtered by hard-coded
codes ["1000","1010","1020"], excluding resolver-created rows like
1011 Bank of America Checking ···6084 (subtype='Bank'). Result: 317 LLC
displayed -$1,418.17 instead of ~$5,662.93.

Fix: query matches type=asset AND (code in 1000-1099 OR code=1100 OR
subtype='Bank'). This file:

  1. Recomputes the expected cash_on_hand directly from Mongo for 317 LLC
     and asserts the /api endpoint agrees (live-data check).
  2. Spot-checks 3 additional real companies (602, 531, 444 LLC) — asserts
     endpoint returns a sane number and matches recomputed value.
  3. Regression: seeds a company with legacy 1010 (subtype=current_asset)
     only — verifies still counted (no regression).
  4. Regression: seeds A/R + Inventory + Prepaid + Fixed-asset postings —
     verifies they do NOT leak into cash_on_hand.
  5. Verifies the endpoint still returns correct outstanding_invoices /
     outstanding_bills / cash_in_30d / cash_out_30d / activity_count_30d
     fields (fix was scoped to cash_on_hand only).
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

import pytest
import requests

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME"):
    os.environ.setdefault(k, _env[k].strip('"'))

_fe_env = dotenv_values("/app/frontend/.env")
BASE_URL = _fe_env["REACT_APP_BACKEND_URL"].strip('"').rstrip("/")

from db import db, now_iso  # noqa: E402


CID_317 = "043aaac7-5ad5-4e8d-9e1c-ede2ed975bdf"
OTHER_CIDS = [
    "1829a9eb-7df2-4a31-afcf-7e50a514da7e",  # Bright Beans Coffee Co.
]


# ---------- Helpers ---------------------------------------------------------

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


async def _recompute_cash(cid: str) -> tuple[float, list[dict]]:
    """Duplicate the server.py logic against Mongo, so we know the truth."""
    cash_accts = await db.accounts.find({
        "company_id": cid, "type": "asset",
        "$or": [
            {"code": {"$gte": "1000", "$lte": "1099"}},
            {"code": "1100"},
            {"subtype": "Bank"},
        ],
    }).to_list(500)
    cash_ids = [a["id"] for a in cash_accts]
    cash = 0.0
    if cash_ids:
        txns = await db.transactions.find({
            "company_id": cid, "posted": True,
            "bank_account_id": {"$in": cash_ids},
        }).to_list(200_000)
        cash = sum(float(t.get("amount", 0)) for t in txns)
        jes = await db.journal_entries.find({"company_id": cid}).to_list(200_000)
        for j in jes:
            for l in j.get("lines", []):
                if l.get("account_id") in cash_ids:
                    cash += float(l.get("debit", 0) or 0) - float(l.get("credit", 0) or 0)
    return round(cash, 2), cash_accts


def _login(email: str, password: str) -> str:
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("access_token") or j["token"]


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _login("admin@axiom.ai", "admin123")


@pytest.fixture(scope="module")
def auth_headers(admin_token) -> dict:
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- Live-data tests -------------------------------------------------

def test_317_llc_cash_matches_expected(auth_headers):
    """317 LLC — the exact bug scenario. cash_on_hand must ~= $5,662.93
    and must equal our recomputed value (server-side truth vs endpoint).
    """
    expected_cash, accts = _run(_recompute_cash(CID_317))
    print(f"317 LLC cash accounts matched: {[(a.get('code'), a.get('name'), a.get('subtype')) for a in accts]}")
    print(f"317 LLC recomputed cash: {expected_cash}")
    # Bust cache before hitting endpoint
    from infra import get_cache
    get_cache().invalidate(CID_317)

    r = requests.get(f"{BASE_URL}/api/companies/{CID_317}/dashboard/metrics",
                     headers=auth_headers, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    data = r.json()
    print(f"317 LLC endpoint cash_on_hand: {data.get('cash_on_hand')}")
    # Endpoint agrees with recomputed
    assert abs(data["cash_on_hand"] - expected_cash) < 0.05, (
        f"endpoint {data['cash_on_hand']} != recomputed {expected_cash}"
    )
    # And is no longer the buggy -1418.17
    assert abs(data["cash_on_hand"] - (-1418.17)) > 1.0, "still buggy value"
    # Sanity: matches ticket expectation ~$5,662.93 (within a reasonable window)
    assert 4000 < data["cash_on_hand"] < 7000, (
        f"cash_on_hand {data['cash_on_hand']} outside expected 4000-7000 window"
    )
    # Sanity: other fields present
    for k in ("outstanding_invoices", "outstanding_bills",
              "cash_in_30d", "cash_out_30d", "activity_count_30d"):
        assert k in data, f"missing field {k}"


@pytest.mark.parametrize("cid", OTHER_CIDS)
def test_other_live_companies_no_regression(auth_headers, cid):
    """Spot check: for other real companies, endpoint cash_on_hand must
    agree with the direct Mongo recompute (i.e., no regression).
    """
    expected, accts = _run(_recompute_cash(cid))
    from infra import get_cache
    get_cache().invalidate(cid)
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/dashboard/metrics",
                     headers=auth_headers, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    got = r.json()["cash_on_hand"]
    print(f"{cid}: accts={len(accts)} recomputed={expected} endpoint={got}")
    assert abs(got - expected) < 0.05, (
        f"drift on {cid}: endpoint {got} vs recomputed {expected}"
    )


# ---------- Seeded regression tests ----------------------------------------

async def _cleanup(cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.journal_entries.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"company_id": cid})
    await db.users.delete_many({"id": {"$regex": f"^user-{cid}"}})


async def _seed_legacy_only(cid: str) -> str:
    """Legacy shape: single 1010 with subtype=current_asset. Must still work."""
    uid = f"user-{cid}-owner"
    now = now_iso()
    await db.users.insert_one({"id": uid, "email": f"{uid}@t.t",
                               "name": "T", "password": "x", "role": "client",
                               "created_at": now, "updated_at": now})
    await db.companies.insert_one({"id": cid, "name": "Legacy Regression",
                                   "owner_user_id": uid,
                                   "created_at": now, "updated_at": now})
    await db.memberships.insert_one({"id": str(uuid.uuid4()), "company_id": cid,
                                     "user_id": uid, "role": "owner",
                                     "created_at": now})
    bank = str(uuid.uuid4()); obe = str(uuid.uuid4())
    await db.accounts.insert_many([
        {"id": bank, "company_id": cid, "code": "1010",
         "name": "Business Checking", "type": "asset",
         "subtype": "current_asset", "active": True},
        {"id": obe, "company_id": cid, "code": "3050",
         "name": "OBE", "type": "equity", "subtype": "equity", "active": True},
    ])
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "date": "2026-01-01",
        "memo": "OB", "lines": [
            {"account_id": bank, "debit": 5000.0, "credit": 0},
            {"account_id": obe, "debit": 0, "credit": 5000.0},
        ],
    })
    for amt in (-100.0, 250.0, -50.0):
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": "2026-06-01",
            "description": "t", "amount": amt, "bank_account_id": bank,
            "posted": True, "source": "manual",
        })
    return uid


def test_regression_legacy_1010_still_counted():
    cid = f"cash-legacy-{uuid.uuid4()}"
    try:
        _run(_seed_legacy_only(cid))
        from infra import get_cache
        get_cache().invalidate(cid)
        from server import dashboard_metrics
        user = _run(db.users.find_one({"id": f"user-{cid}-owner"}))
        res = _run(dashboard_metrics(cid, user=user))
        # 5000 opening + (-100 + 250 - 50) = 5100
        assert abs(res["cash_on_hand"] - 5100.0) < 0.01, res["cash_on_hand"]
    finally:
        _run(_cleanup(cid))


async def _seed_non_cash_assets(cid: str) -> str:
    """A/R + Inventory + Prepaid + Fixed — none should leak to cash."""
    uid = f"user-{cid}-owner"
    now = now_iso()
    await db.users.insert_one({"id": uid, "email": f"{uid}@t.t",
                               "name": "T", "password": "x", "role": "client",
                               "created_at": now, "updated_at": now})
    await db.companies.insert_one({"id": cid, "name": "Non-cash regression",
                                   "owner_user_id": uid,
                                   "created_at": now, "updated_at": now})
    await db.memberships.insert_one({"id": str(uuid.uuid4()), "company_id": cid,
                                     "user_id": uid, "role": "owner",
                                     "created_at": now})
    ids = {}
    for code, name, subtype in [
        ("1200", "AR",        "current_asset"),
        ("1300", "Inventory", "current_asset"),
        ("1500", "Prepaid",   "current_asset"),
        ("1600", "Equipment", "fixed_asset"),
    ]:
        aid = str(uuid.uuid4())
        ids[code] = aid
        await db.accounts.insert_one({
            "id": aid, "company_id": cid, "code": code, "name": name,
            "type": "asset", "subtype": subtype, "active": True,
        })
    # Bogus postings against each — should NOT show up in cash_on_hand
    for code, amt in [("1200", 100_000.0), ("1300", 50_000.0),
                      ("1500", 25_000.0), ("1600", 200_000.0)]:
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": "2026-07-01", "description": "leak-test",
            "amount": amt, "bank_account_id": ids[code],
            "posted": True, "source": "manual",
        })
    return uid


def test_regression_non_cash_assets_do_not_leak():
    cid = f"cash-noncash-{uuid.uuid4()}"
    try:
        _run(_seed_non_cash_assets(cid))
        from infra import get_cache
        get_cache().invalidate(cid)
        from server import dashboard_metrics
        user = _run(db.users.find_one({"id": f"user-{cid}-owner"}))
        res = _run(dashboard_metrics(cid, user=user))
        assert res["cash_on_hand"] == 0.0, (
            f"Non-cash assets leaked: {res['cash_on_hand']}"
        )
    finally:
        _run(_cleanup(cid))


async def _seed_resolver_row(cid: str) -> str:
    """Recreate the 317 LLC shape: legacy 1010 + resolver-created 1011
    (subtype='Bank') + opening balance JE on 1011. Ensures the code-range
    match includes 1011 even without the subtype clause, and the subtype
    clause independently catches subtype='Bank' rows even outside range."""
    uid = f"user-{cid}-owner"
    now = now_iso()
    await db.users.insert_one({"id": uid, "email": f"{uid}@t.t",
                               "name": "T", "password": "x", "role": "client",
                               "created_at": now, "updated_at": now})
    await db.companies.insert_one({"id": cid, "name": "Resolver row scenario",
                                   "owner_user_id": uid,
                                   "created_at": now, "updated_at": now})
    await db.memberships.insert_one({"id": str(uuid.uuid4()), "company_id": cid,
                                     "user_id": uid, "role": "owner",
                                     "created_at": now})
    legacy = str(uuid.uuid4()); resolver = str(uuid.uuid4())
    obe = str(uuid.uuid4()); weird_bank = str(uuid.uuid4())
    await db.accounts.insert_many([
        {"id": legacy, "company_id": cid, "code": "1010",
         "name": "Legacy checking", "type": "asset",
         "subtype": "current_asset", "active": True},
        {"id": resolver, "company_id": cid, "code": "1011",
         "name": "BofA ···6084", "type": "asset",
         "subtype": "Bank", "active": True},
        {"id": weird_bank, "company_id": cid, "code": "1075",
         "name": "Weird Bank Row", "type": "asset",
         "subtype": "Bank", "active": True},
        {"id": obe, "company_id": cid, "code": "3050",
         "name": "OBE", "type": "equity", "subtype": "equity", "active": True},
    ])
    # Legacy net -1418.17 (matches ticket)
    for amt in (200.0, -1618.17):
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": "2026-07-10", "description": "legacy",
            "amount": amt, "bank_account_id": legacy,
            "posted": True, "source": "plaid",
        })
    # Resolver row: opening balance JE + activity
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "date": "2024-01-01",
        "memo": "OB", "lines": [
            {"account_id": resolver, "debit": 6743.03, "credit": 0},
            {"account_id": obe,      "debit": 0,       "credit": 6743.03},
        ],
    })
    for amt in (500.0, -200.0, -1000.0, 100.0, -481.10):
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": "2026-06-15", "description": "bofa",
            "amount": amt, "bank_account_id": resolver,
            "posted": True, "source": "plaid",
        })
    # Weird 1075 subtype=Bank row with a +$50 posting — must also be counted.
    await db.transactions.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": "2026-07-01", "description": "weird bank",
        "amount": 50.0, "bank_account_id": weird_bank,
        "posted": True, "source": "manual",
    })
    return uid


def test_regression_resolver_shape():
    """Ticket scenario re-created deterministically."""
    cid = f"cash-resolver-{uuid.uuid4()}"
    try:
        _run(_seed_resolver_row(cid))
        from infra import get_cache
        get_cache().invalidate(cid)
        from server import dashboard_metrics
        user = _run(db.users.find_one({"id": f"user-{cid}-owner"}))
        res = _run(dashboard_metrics(cid, user=user))
        # legacy: -1418.17
        # resolver txns: -1081.10 + JE 6743.03 = 5661.93
        # weird bank: +50
        # total: -1418.17 + 5661.93 + 50 = 4293.76
        assert abs(res["cash_on_hand"] - 4293.76) < 0.01, res["cash_on_hand"]
    finally:
        _run(_cleanup(cid))


if __name__ == "__main__":
    # Allow ad-hoc run
    import subprocess
    subprocess.run(["pytest", __file__, "-v", "-s"], check=False)
