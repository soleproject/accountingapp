"""Industry template switch + safe CoA cleanup (Feb 2026).

Covers the onboarding flow where a user picks an industry template,
then changes their mind. The endpoint must:

  1. Stamp `seeded_by_industry` on every newly-inserted account.
  2. Backfill the stamp on existing template-code accounts on first
     save (so a legacy company that never had provenance can still
     benefit from cleanup on later switches).
  3. Preview mode (`dry_run=true`) returns `would_add` +
     `would_remove` + `blocked_remove` without writing anything.
  4. Confirmed switch removes ONLY accounts that are (a) stamped for
     the old industry, (b) not in the new template, (c) not
     referenced by any transaction / JE line / rule.
  5. Manually-added accounts are never removed even if they share a
     code with an old industry account.
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


async def _mk_env():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"ind_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Industry Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    token = create_token(uid, "client")
    return uid, token, cid


async def _cleanup(uid: str, cid: str):
    await db.transactions.delete_many({"company_id": cid})
    await db.journal_entries.delete_many({"company_id": cid})
    await db.rules.delete_many({"company_id": cid})
    await db.accounts.delete_many({"company_id": cid})
    await db.memberships.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# -----------------------------------------------------------
# Test 1 — first template pick seeds with provenance stamp
# -----------------------------------------------------------
def test_first_pick_stamps_provenance():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "restaurant"},
                )
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["template"] == "restaurant"
                assert body["seeded_accounts"] > 0
                assert body["removed_accounts"] == 0

                # Every seeded account carries the provenance stamp.
                seeded = await db.accounts.find(
                    {"company_id": cid, "seeded_by_industry": "restaurant"},
                ).to_list(1000)
                assert len(seeded) == body["seeded_accounts"]

                # Company doc got the timestamp.
                company = await db.companies.find_one({"id": cid})
                assert company["industry_template"] == "restaurant"
                assert company.get("industry_selected_at")

                # Every seeded row lands with a Wave-style detail_type
                # AND a matching subtype so the CoA drift audit doesn't
                # flag them. Spot-check a few known accounts:
                cash = await db.accounts.find_one(
                    {"company_id": cid, "code": "1000"})
                assert cash["detail_type"] == "cash_and_bank"
                assert cash["subtype"] == "cash_and_bank"

                cc = await db.accounts.find_one(
                    {"company_id": cid, "code": "2100"})
                assert cc["detail_type"] == "credit_card"

                wages = await db.accounts.find_one(
                    {"company_id": cid, "code": "6100"})
                # "Wages - Kitchen Staff" hits the payroll_expense
                # keyword list in `_infer_detail_type`.
                assert wages["detail_type"] == "payroll_expense"

                # Revenue accounts use `type: "income"` (legacy alias) —
                # the inference now treats income == revenue so they
                # land in "income", not "other_short_term_asset".
                food_sales = await db.accounts.find_one(
                    {"company_id": cid, "code": "4000"})
                assert food_sales["detail_type"] == "income", food_sales

                # No seeded row has an empty detail_type.
                empty = await db.accounts.count_documents({
                    "company_id": cid,
                    "seeded_by_industry": "restaurant",
                    "$or": [{"detail_type": ""}, {"detail_type": None}],
                })
                assert empty == 0
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# -----------------------------------------------------------
# Test 2 — switching template with no txns removes only
# industry-specific old accounts
# -----------------------------------------------------------
def test_switch_removes_industry_specific_only():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Seed restaurant.
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "restaurant"},
                )
                assert r.status_code == 200

                # Restaurant-only codes that DON'T exist in
                # professional_services. Computed once from the
                # templates to keep this test stable if the account
                # lists get tweaked over time.
                from industry_templates import industry_only_codes, template_codes
                restaurant_only_expected = (
                    industry_only_codes("restaurant") - template_codes("professional_services")
                )
                assert restaurant_only_expected, "Test setup: expected set should be non-empty"

                # Preview switch to professional_services.
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "professional_services", "dry_run": True},
                )
                assert r.status_code == 200, r.text
                preview = r.json()
                would_remove_codes = {a["code"] for a in preview["would_remove"]}
                assert would_remove_codes == restaurant_only_expected, \
                    f"Expected {restaurant_only_expected} == {would_remove_codes}"
                assert preview["dry_run"] is True

                # Nothing was actually written yet.
                still_restaurant = await db.accounts.count_documents(
                    {"company_id": cid, "code": {"$in": list(restaurant_only_expected)}},
                )
                assert still_restaurant == len(restaurant_only_expected)

                # Commit the switch with cleanup.
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "professional_services",
                          "confirm_cleanup": True},
                )
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["template"] == "professional_services"
                assert body["removed_accounts"] >= len(restaurant_only_expected)

                # Restaurant-only accounts are gone.
                still_restaurant = await db.accounts.count_documents(
                    {"company_id": cid, "code": {"$in": list(restaurant_only_expected)}},
                )
                assert still_restaurant == 0

                # Baseline "generic" codes (e.g. 1000 Cash, 2000 A/P)
                # survived — they exist in every template.
                cash = await db.accounts.find_one(
                    {"company_id": cid, "code": "1000"},
                )
                assert cash is not None
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# -----------------------------------------------------------
# Test 3 — accounts referenced by transactions/JEs/rules are
# blocked from removal even if the user confirms cleanup
# -----------------------------------------------------------
def test_in_use_accounts_never_removed():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Seed restaurant.
                await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "restaurant"},
                )

                # Reference restaurant-only account 1310 (Beverage
                # Inventory) via a JE line to lock it in place.
                bev = await db.accounts.find_one(
                    {"company_id": cid, "code": "1310"},
                )
                assert bev is not None
                await db.journal_entries.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-01-15",
                    "lines": [{"account_id": bev["id"], "debit": 100.0, "credit": 0.0}],
                })

                # Reference 5100 (Beverage COGS) via a rule.
                cogs = await db.accounts.find_one(
                    {"company_id": cid, "code": "5100"},
                )
                await db.rules.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "match_type": "merchant_contains",
                    "match_value": "TEST WINE CO",
                    "account_code": cogs["code"],
                    "account_name": cogs["name"],
                })

                # Reference 5200 (Kitchen Supplies COGS) via a transaction.
                await db.transactions.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "date": "2026-01-20", "amount": -50.0,
                    "merchant": "TEST",
                    "category_account_id": (
                        await db.accounts.find_one(
                            {"company_id": cid, "code": "5200"})
                    )["id"],
                })

                # Switch with confirm_cleanup — the three referenced
                # accounts should be blocked, not removed.
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "professional_services",
                          "confirm_cleanup": True},
                )
                assert r.status_code == 200, r.text
                body = r.json()
                blocked_codes = {a["code"] for a in body["blocked_remove"]}
                # All three referenced codes are blocked.
                assert {"1310", "5100", "5200"}.issubset(blocked_codes), \
                    f"Expected 1310/5100/5200 blocked, got {blocked_codes}"

                # They still exist in the CoA.
                assert await db.accounts.find_one(
                    {"company_id": cid, "code": "1310"}) is not None
                assert await db.accounts.find_one(
                    {"company_id": cid, "code": "5100"}) is not None
                assert await db.accounts.find_one(
                    {"company_id": cid, "code": "5200"}) is not None
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# -----------------------------------------------------------
# Test 4 — manually-added account with an old-industry code but
# no provenance stamp is left alone
# -----------------------------------------------------------
def test_manual_accounts_never_touched():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Seed restaurant WITHOUT going through the endpoint
                # first — simulate a legacy company where accounts
                # exist but have no `seeded_by_industry` stamp.
                # We'll do it by planting a stray manual account with
                # a restaurant-only code but no provenance, alongside
                # restaurant seeding.
                await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "restaurant"},
                )
                # Overwrite the stamp on code 5200 to look manual.
                await db.accounts.update_one(
                    {"company_id": cid, "code": "5200"},
                    {"$unset": {"seeded_by_industry": ""}},
                )

                # Switch — code 5200 should NOT be in would_remove.
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "professional_services",
                          "dry_run": True},
                )
                assert r.status_code == 200, r.text
                would_remove_codes = {a["code"] for a in r.json()["would_remove"]}
                assert "5200" not in would_remove_codes, \
                    f"5200 (manual) leaked into cleanup: {would_remove_codes}"

                # Confirm switch — 5200 still lives.
                await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "professional_services",
                          "confirm_cleanup": True},
                )
                assert await db.accounts.find_one(
                    {"company_id": cid, "code": "5200"}) is not None
        finally:
            await _cleanup(uid, cid)

    _run(_t())


# -----------------------------------------------------------
# Test 5 — shared-code accounts are renamed on switch so the
# CoA reflects the new industry's terminology
# -----------------------------------------------------------
def test_shared_codes_renamed_on_switch():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            async with await _client() as ac:
                # Seed construction first.
                await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "construction"},
                )
                # Code 1300 exists in both construction ("Materials
                # Inventory") and restaurant ("Food Inventory"). After
                # a Construction seed, it lives with the construction
                # name AND a construction stamp — perfect setup for
                # the rename case.
                mat = await db.accounts.find_one(
                    {"company_id": cid, "code": "1300"})
                assert mat["name"] == "Materials Inventory"
                assert mat["seeded_by_industry"] == "construction"

                # Preview switch → would_rename must include 1300.
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "restaurant", "dry_run": True},
                )
                assert r.status_code == 200, r.text
                would_rename = r.json().get("would_rename", [])
                codes = {rc["code"]: rc for rc in would_rename}
                assert "1300" in codes, would_rename
                assert codes["1300"]["old_name"] == "Materials Inventory"
                assert codes["1300"]["new_name"] == "Food Inventory"

                # Preview alone must not have written anything.
                still_mat = await db.accounts.find_one(
                    {"company_id": cid, "code": "1300"})
                assert still_mat["name"] == "Materials Inventory"

                # Confirm switch → the account is renamed in place,
                # its ID is preserved, and its stamp flips to
                # restaurant.
                orig_id = mat["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/industry-template",
                    headers=_headers(token),
                    json={"template": "restaurant",
                          "confirm_cleanup": True},
                )
                assert r.status_code == 200, r.text
                assert r.json().get("renamed_accounts", 0) >= 1
                food = await db.accounts.find_one(
                    {"company_id": cid, "code": "1300"})
                assert food["id"] == orig_id
                assert food["name"] == "Food Inventory"
                assert food["seeded_by_industry"] == "restaurant"
        finally:
            await _cleanup(uid, cid)

    _run(_t())
