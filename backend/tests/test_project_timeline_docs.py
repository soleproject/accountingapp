"""Phase 3.5 — Project Timeline + Doc Linking (Feb 2026)."""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    from server import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    contact_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"tl_{uid[:6]}@example.com",
        "password": hash_password("x"), "role": "client",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Timeline Test Co", "owner_user_id": uid,
        "reporting_basis": "accrual",
        "features": {"classes_enabled": False,
                     "projects_enabled": True,
                     "budgets_enabled": False},
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Acme Corp", "type": "customer",
    })
    return uid, create_token(uid, "client"), cid, contact_id


async def _cleanup(uid: str, cid: str):
    for coll in ("projects", "project_phases", "invoices", "bills",
                 "estimates", "receipts", "contacts", "memberships"):
        if coll == "memberships":
            await db[coll].delete_many({"user_id": uid})
        else:
            await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_project_and_phase_dates_roundtrip():
    """Project + Phase PATCH accepts start_date/end_date and persists."""
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                # Create project with dates.
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "House", "contact_id": contact_id,
                          "start_date": "2026-03-01",
                          "end_date": "2026-06-30"})
                assert r.status_code == 200
                proj = r.json()["project"]
                assert proj["start_date"] == "2026-03-01"
                assert proj["end_date"] == "2026-06-30"
                pid = proj["id"]

                # PATCH dates.
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}",
                    headers=_h(token),
                    json={"start_date": "2026-04-01"})
                assert r.status_code == 200
                assert r.json()["project"]["start_date"] == "2026-04-01"

                # Phase w/ dates.
                r = await ac.post(
                    f"/api/companies/{cid}/projects/{pid}/phases",
                    headers=_h(token),
                    json={"name": "Demo",
                          "start_date": "2026-04-01",
                          "end_date": "2026-04-15"})
                assert r.status_code == 200
                ph = r.json()["phase"]
                assert ph["start_date"] == "2026-04-01"

                # Update phase dates.
                r = await ac.patch(
                    f"/api/companies/{cid}/projects/{pid}/phases/{ph['id']}",
                    headers=_h(token),
                    json={"end_date": "2026-04-20"})
                assert r.status_code == 200
                assert r.json()["phase"]["end_date"] == "2026-04-20"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_invoice_bill_estimate_project_link():
    """Invoice / Bill / Estimate accept project_id on create + PATCH."""
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "Job1", "contact_id": contact_id})
                pid = r.json()["project"]["id"]

                # --- Invoice ---
                r = await ac.post(
                    f"/api/companies/{cid}/invoices", headers=_h(token),
                    json={
                        "contact_id": contact_id, "contact_name": "Acme Corp",
                        "issue_date": "2026-03-01", "due_date": "2026-03-31",
                        "line_items": [{"description": "Work",
                                          "quantity": 1, "rate": 100, "amount": 100}],
                        "project_id": pid,
                    })
                assert r.status_code == 200, r.text
                iid = r.json()["id"]
                inv = await db.invoices.find_one({"id": iid})
                assert inv["project_id"] == pid

                # PATCH clears project.
                await ac.patch(
                    f"/api/companies/{cid}/invoices/{iid}",
                    headers=_h(token), json={"project_id": None})
                inv = await db.invoices.find_one({"id": iid})
                assert inv["project_id"] is None

                # --- Bill ---
                r = await ac.post(
                    f"/api/companies/{cid}/bills", headers=_h(token),
                    json={
                        "contact_id": contact_id, "contact_name": "Acme Corp",
                        "issue_date": "2026-03-01", "due_date": "2026-03-31",
                        "line_items": [{"description": "Sub",
                                          "quantity": 1, "rate": 50, "amount": 50}],
                        "project_id": pid,
                    })
                assert r.status_code == 200, r.text
                bid = r.json()["id"]
                bill = await db.bills.find_one({"id": bid})
                assert bill["project_id"] == pid

                # --- Estimate ---
                r = await ac.post(
                    f"/api/companies/{cid}/estimates", headers=_h(token),
                    json={
                        "contact_id": contact_id, "contact_name": "Acme Corp",
                        "issue_date": "2026-03-01",
                        "line_items": [{"description": "Quote",
                                          "quantity": 1, "rate": 200, "amount": 200}],
                        "project_id": pid,
                    })
                assert r.status_code == 200, r.text
                eid = r.json()["id"]
                est = await db.estimates.find_one({"id": eid})
                assert est["project_id"] == pid
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_project_documents_endpoint():
    """`/projects/{pid}/documents` returns all linked docs across types."""
    async def _t():
        uid, token, cid, contact_id = await _mk_env()
        try:
            async with await _client() as ac:
                r = await ac.post(
                    f"/api/companies/{cid}/projects", headers=_h(token),
                    json={"name": "Job2", "contact_id": contact_id})
                pid = r.json()["project"]["id"]

                # Seed docs directly for speed (skipping full editor flow).
                for kind, coll, extras in [
                    ("estimate", "estimates",
                     {"issue_date": "2026-03-05", "total": 1000, "balance_due": 0,
                      "status": "sent"}),
                    ("invoice", "invoices",
                     {"issue_date": "2026-03-10", "total": 500, "balance_due": 500,
                      "status": "sent"}),
                    ("bill", "bills",
                     {"issue_date": "2026-03-12", "total": 200, "balance_due": 0,
                      "status": "open"}),
                ]:
                    await db[coll].insert_one({
                        "id": str(uuid.uuid4()),
                        "company_id": cid, "project_id": pid,
                        "contact_id": contact_id, "contact_name": "Acme Corp",
                        "number": f"{kind[:3].upper()}-1",
                        **extras,
                    })

                r = await ac.get(
                    f"/api/companies/{cid}/projects/{pid}/documents",
                    headers=_h(token))
                assert r.status_code == 200, r.text
                data = r.json()
                assert data["count"] == 3
                kinds = {d["kind"] for d in data["documents"]}
                assert kinds == {"estimate", "invoice", "bill"}
                # Sorted by date desc; bill (2026-03-12) should come first.
                assert data["documents"][0]["kind"] == "bill"
                # Non-existent project → 404.
                r = await ac.get(
                    f"/api/companies/{cid}/projects/does-not-exist/documents",
                    headers=_h(token))
                assert r.status_code == 404
        finally:
            await _cleanup(uid, cid)
    _run(_t())
