"""Chart of Accounts sub-type unification (Feb 2026).

Regression tests for the "changed the sub-type but the account didn't
move" bug. The Chart of Accounts UI groups accounts by `detail_type`,
NOT by `subtype`, so a PATCH that only sends `subtype` used to no-op
visually.

These tests exercise the safety net we added in `update_account` that
mirrors `subtype -> detail_type` when the caller didn't provide one.
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env(role: str = "client"):
    """Create a user and a company owned by them. Returns (user_id, token, cid)."""
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"coa_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": role,
    })
    await db.companies.insert_one({
        "id": cid, "name": "CoA Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
    })
    # Membership required by require_company
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    return uid, create_token(uid, role), cid


async def _cleanup(uid: str, cid: str):
    await db.accounts.delete_many({"company_id": cid})
    await db.memberships.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def test_subtype_patch_mirrors_to_detail_type():
    """A PATCH sending only `subtype` (legacy client) must also flip
    `detail_type` on the row — otherwise the account wouldn't visually
    move to the new section."""
    async def _t():
        uid, tok, cid = await _mk_env()
        try:
            # Seed an expense account currently living in the COGS
            # section (this mirrors the user's real bug: they moved an
            # expense into COGS by mistake and need to move it back).
            aid = str(uuid.uuid4())
            await db.accounts.insert_one({
                "id": aid, "company_id": cid, "code": "5100",
                "name": "Client Meals", "type": "expense",
                "subtype": "cost_of_sales",
                "detail_type": "cost_of_goods_sold",
            })
            async with await _client() as c:
                # Legacy-client PATCH: only sends subtype, no detail_type
                r = await c.patch(
                    f"/api/companies/{cid}/accounts/{aid}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "code": "5100", "name": "Client Meals",
                        "type": "expense", "subtype": "other_expense",
                    },
                )
                assert r.status_code == 200, r.text
            fresh = await db.accounts.find_one({"id": aid})
            assert fresh["subtype"] == "other_expense"
            # The safety net copied subtype -> detail_type so the CoA
            # renderer now puts the account in the "Other Expense"
            # section instead of leaving it stuck in COGS.
            assert fresh["detail_type"] == "other_expense"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_explicit_detail_type_wins():
    """When the modern client sends BOTH subtype and detail_type, we
    respect what they sent — no clobbering."""
    async def _t():
        uid, tok, cid = await _mk_env()
        try:
            aid = str(uuid.uuid4())
            await db.accounts.insert_one({
                "id": aid, "company_id": cid, "code": "5100",
                "name": "Bank Fees", "type": "expense",
                "subtype": "operating_expense",
                "detail_type": "operating_expense",
            })
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{cid}/accounts/{aid}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "code": "5100", "name": "Bank Fees",
                        "type": "expense",
                        "subtype": "payment_processing_fee",
                        "detail_type": "payment_processing_fee",
                    },
                )
                assert r.status_code == 200
            fresh = await db.accounts.find_one({"id": aid})
            assert fresh["subtype"] == "payment_processing_fee"
            assert fresh["detail_type"] == "payment_processing_fee"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_edit_without_subtype_leaves_detail_type_intact():
    """A PATCH that doesn't touch subtype at all must NOT clobber the
    existing detail_type — e.g. renaming an account or changing its
    code shouldn't reset which section it lives in."""
    async def _t():
        uid, tok, cid = await _mk_env()
        try:
            aid = str(uuid.uuid4())
            await db.accounts.insert_one({
                "id": aid, "company_id": cid, "code": "1000",
                "name": "AmEx Gold", "type": "asset",
                "subtype": "current_asset",
                "detail_type": "cash_and_bank",
            })
            async with await _client() as c:
                r = await c.patch(
                    f"/api/companies/{cid}/accounts/{aid}",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"name": "AmEx Gold Card (1009)"},
                )
                assert r.status_code == 200
            fresh = await db.accounts.find_one({"id": aid})
            assert fresh["name"] == "AmEx Gold Card (1009)"
            # No subtype in payload → detail_type stays put
            assert fresh["detail_type"] == "cash_and_bank"
            assert fresh["subtype"] == "current_asset"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_subtype_audit_reports_drift_and_canonical_states():
    """The audit endpoint should count canonical / drifted / legacy
    rows correctly and surface a bounded sample of drift examples."""
    async def _t():
        uid, tok, cid = await _mk_env()
        try:
            # Seed a mix: canonical, drifted (both canonical but disagree),
            # legacy-only-subtype, missing detail_type
            await db.accounts.insert_many([
                {"id": "a1", "company_id": cid, "name": "Ops",
                 "type": "expense", "subtype": "operating_expense",
                 "detail_type": "operating_expense", "active": True},
                # Both keys are canonical, but they disagree → true drift
                {"id": "a2", "company_id": cid, "name": "Drifted",
                 "type": "expense", "subtype": "operating_expense",
                 "detail_type": "other_expense", "active": True},
                # Legacy subtype ("Bank"), detail_type already canonical
                {"id": "a3", "company_id": cid, "name": "AmEx",
                 "type": "asset", "subtype": "Bank",
                 "detail_type": "cash_and_bank", "active": True},
                {"id": "a4", "company_id": cid, "name": "No DT",
                 "type": "asset", "subtype": "cash_and_bank",
                 "detail_type": "", "active": True},
            ])
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/accounts/subtype-audit",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
            body = r.json()
            assert body["total"] == 4
            assert body["canonical"] == 1        # a1
            assert body["drifted"] == 1          # a2
            assert body["legacy_only_subtype"] == 1  # a3
            assert body["missing_detail_type"] == 1  # a4
            assert len(body["sample_drift"]) == 1
            assert body["sample_drift"][0]["id"] == "a2"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_admin_coa_drift_summary_batch():
    """Superadmin batch endpoint should return per-company drift +
    severity, omitting clean companies to keep the payload small."""
    async def _t():
        # Superadmin caller
        sup_uid, sup_tok, sup_cid = await _mk_env(role="superadmin")
        # Two extra companies to test the batch aggregation
        uid_a, _, cid_a = await _mk_env()
        uid_b, _, cid_b = await _mk_env()
        try:
            # cid_sup → clean (should be omitted)
            await db.accounts.insert_one({
                "id": "s1", "company_id": sup_cid, "name": "Cash",
                "type": "asset", "subtype": "cash_and_bank",
                "detail_type": "cash_and_bank", "active": True,
            })
            # cid_a → 2 drifted → severity=red
            await db.accounts.insert_many([
                {"id": "aa1", "company_id": cid_a, "name": "D1",
                 "type": "expense", "subtype": "operating_expense",
                 "detail_type": "other_expense", "active": True},
                {"id": "aa2", "company_id": cid_a, "name": "D2",
                 "type": "expense", "subtype": "payroll_expense",
                 "detail_type": "operating_expense", "active": True},
            ])
            # cid_b → 3 missing detail_type → severity=amber
            await db.accounts.insert_many([
                {"id": "bb1", "company_id": cid_b, "name": "M1",
                 "type": "asset", "subtype": "cash", "detail_type": "",
                 "active": True},
                {"id": "bb2", "company_id": cid_b, "name": "M2",
                 "type": "asset", "subtype": "cash", "detail_type": "",
                 "active": True},
                {"id": "bb3", "company_id": cid_b, "name": "M3",
                 "type": "expense", "subtype": "expense", "detail_type": "",
                 "active": True},
            ])
            async with await _client() as c:
                r = await c.get(
                    "/api/admin/coa-drift-summary",
                    headers={"Authorization": f"Bearer {sup_tok}"},
                )
                assert r.status_code == 200, r.text
            summary = r.json()["summary"]
            # Clean company omitted
            assert sup_cid not in summary
            # Red beats amber when drifted > 0
            assert summary[cid_a]["severity"] == "red"
            assert summary[cid_a]["drifted"] == 2
            # Amber when only missing_detail_type
            assert summary[cid_b]["severity"] == "amber"
            assert summary[cid_b]["missing_detail_type"] == 3
        finally:
            await _cleanup(uid_a, cid_a)
            await _cleanup(uid_b, cid_b)
            await _cleanup(sup_uid, sup_cid)
    _run(_t())


def test_admin_coa_drift_summary_forbidden_for_non_superadmin():
    """Non-superadmins get 403 (or 401) from the batch endpoint."""
    async def _t():
        uid, tok, cid = await _mk_env(role="client")
        try:
            async with await _client() as c:
                r = await c.get(
                    "/api/admin/coa-drift-summary",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code in (401, 403), r.text
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_admin_coa_drift_backfill_sweeps_missing_detail_type():
    """Superadmin sweep should populate detail_type on legacy accounts
    across every company in one call, and be idempotent on re-run."""
    async def _t():
        sup_uid, sup_tok, sup_cid = await _mk_env(role="superadmin")
        uid_a, _, cid_a = await _mk_env()
        try:
            # Legacy account rows across two different companies —
            # missing detail_type entirely
            await db.accounts.insert_many([
                {"id": "sw1", "company_id": cid_a, "name": "Business Checking",
                 "type": "asset", "subtype": "current_asset",
                 "detail_type": "", "active": True},
                {"id": "sw2", "company_id": cid_a, "name": "Credit Card Payable",
                 "type": "liability", "subtype": "current_liability",
                 "detail_type": "", "active": True},
                {"id": "sw3", "company_id": sup_cid, "name": "Rent",
                 "type": "expense", "subtype": "operating_expense",
                 "detail_type": "", "active": True},
            ])
            async with await _client() as c:
                r = await c.post(
                    "/api/admin/coa-drift-backfill",
                    headers={"Authorization": f"Bearer {sup_tok}"},
                )
                assert r.status_code == 200, r.text
                body = r.json()
            # 3 legacy rows updated across 2 companies
            assert body["updated"] >= 3
            assert body["companies_touched"] >= 2

            # All three now have detail_type populated
            fresh = await db.accounts.find({"id": {"$in": ["sw1", "sw2", "sw3"]}}).to_list(3)
            assert all(a.get("detail_type") for a in fresh)
            # Bank/card get their canonical Wave keys
            by_id = {a["id"]: a for a in fresh}
            assert by_id["sw1"]["detail_type"] == "cash_and_bank"
            assert by_id["sw2"]["detail_type"] == "credit_card"

            # Re-run is a no-op — everything skipped
            async with await _client() as c:
                r = await c.post(
                    "/api/admin/coa-drift-backfill",
                    headers={"Authorization": f"Bearer {sup_tok}"},
                )
                body2 = r.json()
            assert body2["updated"] == 0
        finally:
            await _cleanup(uid_a, cid_a)
            await _cleanup(sup_uid, sup_cid)
    _run(_t())


def test_admin_coa_drift_backfill_forbidden_for_non_superadmin():
    """Sweep endpoint must be superadmin-only."""
    async def _t():
        uid, tok, cid = await _mk_env(role="pro")
        try:
            async with await _client() as c:
                r = await c.post(
                    "/api/admin/coa-drift-backfill",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code in (401, 403), r.text
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_qbo_map_account_populates_detail_type():
    """QBO Account → local shape must include a Wave-style detail_type
    inferred from account name + subtype. Regression: QBO sync used to
    leave detail_type blank, causing every synced company to land with
    the amber 'N accounts missing a sub-type' banner and flat PDFs.
    """
    from qbo_service import map_account

    checking = map_account("test-cid", "test-realm", {
        "Id": "1", "Name": "Checking", "AccountType": "Bank",
        "AccountSubType": "Checking", "Active": True,
    })
    assert checking["detail_type"] == "cash_and_bank"

    ar = map_account("test-cid", "test-realm", {
        "Id": "2", "Name": "Accounts Receivable (A/R)",
        "AccountType": "Accounts Receivable",
        "AccountSubType": "AccountsReceivable", "Active": True,
    })
    assert ar["detail_type"] == "expected_payments_from_customers"

    cc = map_account("test-cid", "test-realm", {
        "Id": "3", "Name": "Visa Credit Card",
        "AccountType": "Credit Card",
        "AccountSubType": "CreditCard", "Active": True,
    })
    # "Visa Credit Card" hits the credit-card keyword rule under
    # liability so detail_type infers to credit_card.
    assert cc["detail_type"] == "credit_card"

    truck = map_account("test-cid", "test-realm", {
        "Id": "4", "Name": "Truck", "AccountType": "Fixed Asset",
        "AccountSubType": "Vehicles", "Active": True,
    })
    assert truck["detail_type"] == "property_plant_equipment"


def test_new_company_seeds_detail_type_on_every_account():
    """The default CoA seed (DEFAULT_COA) must set `detail_type` to a
    frontend-canonical Wave key on every row so brand new companies
    don't render as amber-flagged out of the box.

    Regression for Feb 2026: legacy seed only populated `subtype`,
    leaving `detail_type` blank → the drift audit lit up every fresh
    company with "missing_detail_type" and PDFs rendered flat.
    """
    async def _t():
        # Create a fresh company via the API so we hit the same seed
        # path that `POST /companies` uses in production.
        uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": f"seedtest_{uid[:6]}@example.com",
            "password": hash_password("x"), "role": "client",
        })
        tok = create_token(uid, "client")
        cid = None
        try:
            async with await _client() as c:
                r = await c.post(
                    "/api/companies",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"name": "Seed Test Co",
                          "business_type": "SaaS",
                          "reporting_basis": "accrual"},
                )
                assert r.status_code == 200, r.text
                cid = r.json()["company_id"]
            # Every seeded account must carry a detail_type
            missing_dt = []
            async for a in db.accounts.find({"company_id": cid}):
                if not (a.get("detail_type") or "").strip():
                    missing_dt.append(a.get("name"))
            assert not missing_dt, f"Accounts still missing detail_type: {missing_dt}"

            # And the audit endpoint should agree — zero missing, zero drift
            async with await _client() as c:
                r = await c.get(
                    f"/api/companies/{cid}/accounts/subtype-audit",
                    headers={"Authorization": f"Bearer {tok}"},
                )
                body = r.json()
            assert body["missing_detail_type"] == 0
            assert body["drifted"] == 0
        finally:
            if cid:
                await _cleanup(uid, cid)
            else:
                await db.users.delete_one({"id": uid})
    _run(_t())
