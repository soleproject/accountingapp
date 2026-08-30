"""Contact CRM summary + activity endpoint (Feb 2026, Phase C polish)."""
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
    await db.users.insert_one({"id": uid, "email": f"cu_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "CRM Contact Tester"})
    await db.companies.insert_one({"id": cid, "name": "Uni Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    await db.contacts.insert_one({"id": con, "company_id": cid,
                                    "name": "ACME Corp", "type": "customer",
                                    "email": "buyer@acme.com"})
    return uid, create_token(uid, "client"), cid, con


async def _cleanup(uid, cid):
    for c in ("deals", "contacts", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_contact_activities_and_crm_summary():
    async def _t():
        uid, token, cid, con = await _mk_env()
        try:
            async with await _client() as ac:
                # -- Log a contact-level activity --
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/{con}/activities",
                    headers=_h(token),
                    json={"kind": "call", "body": "Rang the front desk, left VM"})
                assert r.status_code == 200
                assert r.json()["activity"]["kind"] == "call"

                # Validation: bad kind → 400.
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/{con}/activities",
                    headers=_h(token),
                    json={"kind": "carrier_pigeon", "body": "hi"})
                assert r.status_code == 400
                # Empty body → 400.
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/{con}/activities",
                    headers=_h(token), json={"kind": "note", "body": "   "})
                assert r.status_code == 400
                # Missing contact → 404.
                r = await ac.post(
                    f"/api/companies/{cid}/contacts/does-not-exist/activities",
                    headers=_h(token), json={"kind": "note", "body": "x"})
                assert r.status_code == 404

                # -- Stamp stage + lead_source via the existing PATCH endpoint --
                r = await ac.patch(f"/api/companies/{cid}/contacts/{con}",
                    headers=_h(token),
                    json={"stage": "active_customer", "lead_source": "Referral"})
                assert r.status_code == 200

                # -- Create 3 deals linked to this contact (won, open, lost) --
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "Onboarding", "contact_id": con,
                          "value": 8000, "stage": "won"})
                d1 = r.json()["deal"]
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "Renewal", "contact_id": con,
                          "value": 12000, "stage": "proposal"})
                d2 = r.json()["deal"]
                r = await ac.post(f"/api/companies/{cid}/deals",
                    headers=_h(token),
                    json={"title": "Cross-sell", "contact_id": con,
                          "value": 3000, "stage": "lost"})
                d3 = r.json()["deal"]

                # Add an activity to one deal so the unified feed
                # merges both sources.
                await ac.post(
                    f"/api/companies/{cid}/deals/{d2['id']}/activities",
                    headers=_h(token),
                    json={"kind": "meeting", "body": "Scoping call - Feb 26"})

                # -- CRM summary --
                r = await ac.get(
                    f"/api/companies/{cid}/contacts/{con}/crm-summary",
                    headers=_h(token))
                assert r.status_code == 200
                s = r.json()
                assert s["contact"]["stage"] == "active_customer"
                assert s["contact"]["lead_source"] == "Referral"
                assert len(s["deals"]) == 3
                st = s["stats"]
                assert st["open_count"] == 1 and st["open_value"] == 12000.0
                assert st["won_count"] == 1  and st["won_value"] == 8000.0
                assert st["lost_count"] == 1 and st["lost_value"] == 3000.0
                # Activity feed union: 1 contact activity + 4 deal activities
                # (3 auto-'Deal created' + 1 explicit meeting log).
                assert len(s["activity_feed"]) == 5
                # Sorted newest first.
                ts = [a["at"] for a in s["activity_feed"]]
                assert ts == sorted(ts, reverse=True)
                # Each deal-sourced activity carries deal_id + deal_title.
                for a in s["activity_feed"]:
                    if a["source"] == "deal":
                        assert a["deal_id"] and a["deal_title"]

                # Missing contact → 404.
                r = await ac.get(
                    f"/api/companies/{cid}/contacts/nope/crm-summary",
                    headers=_h(token))
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())



def test_contact_patch_whitelist_and_stage_validation():
    """PATCH should ignore unknown fields and reject invalid stage."""
    async def _t():
        uid, token, cid, con = await _mk_env()
        try:
            async with await _client() as ac:
                # Bad stage → 400.
                r = await ac.patch(f"/api/companies/{cid}/contacts/{con}",
                    headers=_h(token), json={"stage": "pineapple"})
                assert r.status_code == 400

                # Junk keys silently dropped (not persisted).
                r = await ac.patch(f"/api/companies/{cid}/contacts/{con}",
                    headers=_h(token),
                    json={"name": "ACME Updated",
                          "company_id": "hijack",
                          "id": "hijack",
                          "random_evil_key": "yes"})
                assert r.status_code == 200
                doc = await db.contacts.find_one(
                    {"company_id": cid, "id": con})
                assert doc["company_id"] == cid       # not mutated
                assert doc["id"] == con                # not mutated
                assert doc.get("random_evil_key") is None
                assert doc["name"] == "ACME Updated"
        finally:
            await _cleanup(uid, cid)
    _run(_t())
