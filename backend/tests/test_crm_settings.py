"""CRM settings + industry presets (Feb 2026, Phase C polish)."""
from __future__ import annotations
import sys, uuid
sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import create_token, hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4()); cid = str(uuid.uuid4())
    con = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "email": f"cp_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "Preset Tester"})
    await db.companies.insert_one({"id": cid, "name": "Preset Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    await db.contacts.insert_one({"id": con, "company_id": cid,
                                    "name": "Acme Corp", "type": "customer"})
    return uid, create_token(uid, "client"), cid, con


async def _cleanup(uid, cid):
    for c in ("crm_settings", "deals", "contacts", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_presets_catalogue_and_defaults():
    async def _t():
        uid, token, cid, _ = await _mk_env()
        try:
            async with await _client() as ac:
                # Catalogue: 3 presets.
                r = await ac.get("/api/crm/presets", headers=_h(token))
                assert r.status_code == 200
                ids = [p["id"] for p in r.json()["presets"]]
                assert set(ids) == {"field_service", "agency", "cpa_firm"}

                # Default settings for a company with no doc — generic B2B.
                r = await ac.get(f"/api/companies/{cid}/crm-settings",
                                  headers=_h(token))
                assert r.status_code == 200
                s = r.json()
                assert s["preset"] is None
                assert s["stage_labels"]["lead"] == "Lead"
                assert s["stage_labels"]["won"] == "Won"
                assert "Referral" in s["lead_sources"]
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_apply_preset_and_custom_activity_kind_accepted():
    async def _t():
        uid, token, cid, con = await _mk_env()
        try:
            async with await _client() as ac:
                # Bad preset id → 400.
                r = await ac.post(
                    f"/api/companies/{cid}/crm-settings/apply-preset",
                    headers=_h(token), json={"preset": "not_a_preset"})
                assert r.status_code == 400

                # Apply field_service.
                r = await ac.post(
                    f"/api/companies/{cid}/crm-settings/apply-preset",
                    headers=_h(token), json={"preset": "field_service"})
                assert r.status_code == 200
                s = r.json()["settings"]
                assert s["preset"] == "field_service"
                assert s["stage_labels"]["lead"] == "Estimate Requested"
                assert s["stage_labels"]["won"] == "Invoiced & Paid"
                assert "site_visit" in s["activity_kinds"]
                assert "Google Ads" in s["lead_sources"]

                # A custom activity kind ("site_visit") should now be
                # accepted by BOTH deal-activity + contact-activity
                # endpoints without touching their code.
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "Fix furnace", "contact_id": con,
                          "value": 400})
                did = r.json()["deal"]["id"]
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{did}/activities",
                    headers=_h(token),
                    json={"kind": "site_visit", "body": "Rolled truck at 10am"})
                assert r.status_code == 200
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/{con}/activities",
                    headers=_h(token),
                    json={"kind": "site_visit", "body": "Followup visit scheduled"})
                assert r.status_code == 200

                # A kind that's NOT in the merged set (still nothing on
                # any preset) → 400.
                r = await ac.post(
                    f"/api/companies/{cid}/deals/{did}/activities",
                    headers=_h(token),
                    json={"kind": "carrier_pigeon", "body": "…"})
                assert r.status_code == 400

                # Apply agency → activity_kinds fully replace.
                r = await ac.post(
                    f"/api/companies/{cid}/crm-settings/apply-preset",
                    headers=_h(token), json={"preset": "agency"})
                s2 = r.json()["settings"]
                assert "site_visit" not in s2["activity_kinds"]
                assert "kickoff" in s2["activity_kinds"]
                assert s2["stage_labels"]["won"] == "Retainer Signed"

                # PATCH partial: add a custom lead source.
                r = await ac.patch(
                    f"/api/companies/{cid}/crm-settings",
                    headers=_h(token),
                    json={"lead_sources": ["Referral", "Custom source X",
                                             "Referral"]})   # dedupe
                assert r.status_code == 200
                assert r.json()["lead_sources"] == ["Referral", "Custom source X"]
                # PATCH invalid stage_labels type → 400.
                r = await ac.patch(
                    f"/api/companies/{cid}/crm-settings",
                    headers=_h(token),
                    json={"stage_labels": "not-an-object"})
                assert r.status_code == 400
                # Unknown stage key silently ignored.
                r = await ac.patch(
                    f"/api/companies/{cid}/crm-settings",
                    headers=_h(token),
                    json={"stage_labels": {"lead": "Discovery Call",
                                              "made_up_key": "Ignored"}})
                assert r.status_code == 200
                assert r.json()["stage_labels"]["lead"] == "Discovery Call"
                assert "made_up_key" not in r.json()["stage_labels"]
        finally:
            await _cleanup(uid, cid)
    _run(_t())
