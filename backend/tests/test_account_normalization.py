"""Regression: no account write path can produce an invisible-on-CoA row.

Covers the bug where renaming "Business Savings" clobbered its
`detail_type` from `cash_and_bank` to legacy `current_asset` and the
row silently disappeared from the Chart of Accounts renderer.
"""
import os
import pytest
import requests

BACKEND_URL = os.environ.get(
    "BACKEND_URL",
    open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[-1].strip().split("\n")[0],
)
API = f"{BACKEND_URL}/api"


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{API}/auth/login", json={
        "email": "pro@axiom.ai", "password": "pro123",
    }, timeout=15)
    r.raise_for_status()
    tok = r.json()["token"]
    hdr = {"Authorization": f"Bearer {tok}"}
    # Find Test 519 LLC
    r = requests.get(f"{API}/companies?scope=me", headers=hdr, timeout=15)
    cid = next(c["id"] for c in r.json()["companies"] if "Test 519" in c["name"])
    return hdr, cid


def test_normalize_helper_unit():
    from account_normalize import normalize_account_fields, KNOWN_DETAIL_TYPES
    # The Business Savings bug — dt legacy AND name inferrable
    st, dt = normalize_account_fields("asset", "Business Savings",
                                        "current_asset", "current_asset")
    assert dt == "cash_and_bank", dt
    assert st == "cash_and_bank", st
    # QBO-vocab leak from canonical_semantic_accounts
    st, dt = normalize_account_fields("expense", "Meals & Entertainment",
                                        "entertainment_meals", "entertainment_meals")
    assert dt == "operating_expense", dt
    # Missing detail_type on a fixed asset
    st, dt = normalize_account_fields("asset", "Fixed Assets", "fixed_asset", None)
    assert dt == "property_plant_equipment", dt
    # Every returned value must be in the canonical allow-list
    for t in ("asset", "liability", "equity", "revenue", "cogs", "expense"):
        st, dt = normalize_account_fields(t, "Whatever", "garbage", "garbage")
        assert dt in KNOWN_DETAIL_TYPES[t], f"{t}: {dt}"


def test_no_bad_detail_types_exist_after_healer(auth):
    """Every account on Test 519 LLC has a canonical detail_type after
    the startup healer runs. Regression against future writers that
    forget to normalize."""
    from account_normalize import KNOWN_DETAIL_TYPES
    hdr, cid = auth
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15)
    r.raise_for_status()
    bad = []
    for a in r.json()["accounts"]:
        t = (a.get("type") or "expense").lower()
        if t == "income":
            t = "revenue"
        dt = (a.get("detail_type") or "").strip().lower()
        if dt not in KNOWN_DETAIL_TYPES.get(t, set()):
            bad.append((a.get("code"), a.get("name"), t, dt))
    assert not bad, f"non-canonical detail_types survived: {bad[:5]}"


def test_patch_rename_only_preserves_detail_type(auth):
    """The exact bug the user hit: rename should not touch
    `detail_type`. Reproduces via the PATCH endpoint and verifies
    the value stays put."""
    hdr, cid = auth
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15)
    savings = next(a for a in r.json()["accounts"] if a["code"] == "1020")
    aid = savings["id"]
    original_dt = savings["detail_type"]
    original_name = savings["name"]
    assert original_dt == "cash_and_bank", original_dt

    # Rename without touching subtype/detail_type
    new_name = original_name + " (rename-only)"
    r = requests.patch(
        f"{API}/companies/{cid}/accounts/{aid}",
        headers=hdr,
        json={"code": savings["code"], "name": new_name,
              "type": savings["type"],
              "parent_account_id": savings.get("parent_account_id")},
        timeout=15,
    )
    r.raise_for_status()

    # Re-read and verify detail_type unchanged
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15)
    after = next(a for a in r.json()["accounts"] if a["id"] == aid)
    try:
        assert after["detail_type"] == "cash_and_bank", (
            f"detail_type drifted on rename: {after['detail_type']}")
        assert after["name"] == new_name
    finally:
        # Restore original name so subsequent runs stay clean
        requests.patch(
            f"{API}/companies/{cid}/accounts/{aid}",
            headers=hdr,
            json={"code": savings["code"], "name": original_name,
                  "type": savings["type"]},
            timeout=15,
        )


def test_patch_with_legacy_subtype_normalizes(auth):
    """If a caller sends legacy `subtype='current_asset'` (as the old
    frontend used to), backend must normalize BOTH fields to a
    canonical Wave key using name-based inference."""
    hdr, cid = auth
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15)
    savings = next(a for a in r.json()["accounts"] if a["code"] == "1020")
    aid = savings["id"]
    original_st = savings["subtype"]
    original_dt = savings["detail_type"]

    # Fake old-frontend PATCH — legacy subtype, empty detail_type
    r = requests.patch(
        f"{API}/companies/{cid}/accounts/{aid}",
        headers=hdr,
        json={"code": savings["code"], "name": savings["name"],
              "type": savings["type"],
              "subtype": "current_asset", "detail_type": "current_asset"},
        timeout=15,
    )
    r.raise_for_status()
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15)
    after = next(a for a in r.json()["accounts"] if a["id"] == aid)
    try:
        # Name is "Business Savings Test" → inference should snap to cash_and_bank
        assert after["detail_type"] == "cash_and_bank", after["detail_type"]
        assert after["subtype"] == "cash_and_bank", after["subtype"]
    finally:
        # Restore
        requests.patch(
            f"{API}/companies/{cid}/accounts/{aid}",
            headers=hdr,
            json={"code": savings["code"], "name": savings["name"],
                  "type": savings["type"],
                  "subtype": original_st, "detail_type": original_dt},
            timeout=15,
        )


@pytest.mark.asyncio
async def test_driver_level_choke_point_normalizes_raw_insert():
    """The class-level Motor wrapper must normalize any account
    doc inserted via `db.accounts.insert_one` — even from backend
    modules that never call the REST API. This is the "no future
    writer can produce an invisible row" guarantee."""
    import uuid
    from db import db as _db
    from account_normalize import KNOWN_DETAIL_TYPES

    aid = f"__probe_{uuid.uuid4().hex[:12]}"
    try:
        # Insert a doc that mimics the canonical_semantic_accounts
        # QBO-vocab bug: `detail_type="entertainment_meals"`.
        await _db.accounts.insert_one({
            "id": aid, "company_id": "__probe_test",
            "type": "expense", "name": "Meals & Entertainment (probe)",
            "subtype": "entertainment_meals",
            "detail_type": "entertainment_meals",
        })
        doc = await _db.accounts.find_one({"id": aid})
        # Driver-level wrapper must have snapped both to canonical.
        assert doc["detail_type"] in KNOWN_DETAIL_TYPES["expense"], doc["detail_type"]
        assert doc["subtype"] in KNOWN_DETAIL_TYPES["expense"], doc["subtype"]
        # And update_one with $set touching subtype must also normalize.
        await _db.accounts.update_one(
            {"id": aid},
            {"$set": {"subtype": "current_asset"}},
        )
        doc2 = await _db.accounts.find_one({"id": aid})
        assert doc2["detail_type"] in KNOWN_DETAIL_TYPES["expense"], doc2["detail_type"]
    finally:
        await _db.accounts.delete_one({"id": aid})


def test_backfill_endpoint_heals_non_canonical(auth):
    """The Backfill button on the CoA banner must heal both missing
    AND non-canonical detail_types in a single click."""
    from account_normalize import KNOWN_DETAIL_TYPES
    hdr, cid = auth
    r = requests.post(
        f"{API}/companies/{cid}/accounts/backfill-detail-type",
        headers=hdr, timeout=30,
    )
    r.raise_for_status()
    # Regardless of what it healed, the post-state must be clean.
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15)
    bad = []
    for a in r.json()["accounts"]:
        t = (a.get("type") or "expense").lower()
        if t == "income":
            t = "revenue"
        dt = (a.get("detail_type") or "").strip().lower()
        if dt not in KNOWN_DETAIL_TYPES.get(t, set()):
            bad.append((a["code"], a["name"], t, dt))
    assert not bad, f"non-canonical rows survived backfill: {bad[:5]}"
