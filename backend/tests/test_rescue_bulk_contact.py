"""Regression — superadmin rescue-bulk-contact re-resolve mode.

Built March 2026 after a superadmin accidentally applied the wrong
contact to 25 live rows. The rescue endpoint re-derives the original
contact for each affected row by matching the untouched `merchant`
field back to `contacts.normalized_name`.

Locks in:
  1. Rows whose `merchant` matches an existing contact are restored
     to THAT contact (not the wrongly-applied one).
  2. Rows whose `merchant` has no match are cleared (contact_id → null).
  3. Preview mode (execute=false) never mutates anything but returns
     the per-row proposed restoration.
"""
from __future__ import annotations
import sys, uuid, datetime as _dt
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402


async def _seed(cid: str):
    # 2 "real" contacts + 1 wrongly-applied one.
    contacts = [
        {"id": str(uuid.uuid4()), "company_id": cid, "name": "J & A Marketing",
         "normalized_name": "j & a marketing",
         "created_at": now_iso(), "updated_at": now_iso()},
        {"id": str(uuid.uuid4()), "company_id": cid, "name": "Venmo",
         "normalized_name": "venmo",
         "created_at": now_iso(), "updated_at": now_iso()},
        {"id": str(uuid.uuid4()), "company_id": cid, "name": "all klear",
         "normalized_name": "all klear",
         "created_at": now_iso(), "updated_at": now_iso()},
    ]
    await db.contacts.insert_many(contacts)
    ja, venmo, ak = contacts

    now = _dt.datetime.now(_dt.timezone.utc)
    ts = now.isoformat()   # every row updated_at = NOW (inside window)

    # 3 rows all wrongly tagged to 'all klear'. Merchants:
    #   row 1 → "J & A Marketing"     — has matching contact
    #   row 2 → "Venmo"               — has matching contact
    #   row 3 → "OBSCURE ACH MEMO"    — no matching contact → clear
    rows = []
    for merch in ["J & A Marketing", "Venmo", "OBSCURE ACH MEMO"]:
        rows.append({
            "id": str(uuid.uuid4()), "company_id": cid,
            "merchant": merch, "description": merch,
            "amount": -25.0, "date": "2026-03-01",
            "contact_id": ak["id"], "contact_name": ak["name"],
            "posted": True, "needs_review": False, "human_reviewed": True,
            "created_at": ts, "updated_at": ts,
        })
    await db.transactions.insert_many(rows)

    # Also seed a row belonging to a DIFFERENT contact so we prove
    # the query only touches the accident rows.
    await db.transactions.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid,
        "merchant": "Costco", "description": "Costco",
        "amount": -100.0, "date": "2026-03-01",
        "contact_id": ja["id"], "contact_name": ja["name"],
        "posted": True, "needs_review": False, "human_reviewed": True,
        "created_at": ts, "updated_at": ts,
    })

    # Seed the company row so the endpoint's 404 guard passes.
    await db.companies.insert_one({"id": cid, "name": "LaBounty Test LLC"})
    return {"ja": ja, "venmo": venmo, "ak": ak,
             "row_ids": [r["id"] for r in rows]}


async def _cleanup(cid: str):
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.companies.delete_many({"id": cid})


def _stub_auth(monkeypatch):
    import routes.superadmin_diagnostics as m
    def _ok(_user): return None
    monkeypatch.setattr(m, "_require_superadmin", _ok)
    async def _noop(cid): pass
    class _C:
        async def ainvalidate(self, cid): pass
    monkeypatch.setattr(m, "get_cache", lambda: _C())


def test_rescue_preview_shows_proposed_restoration(monkeypatch):
    from routes.superadmin_diagnostics import rescue_bulk_contact
    _stub_auth(monkeypatch)

    async def go():
        cid = f"rescue-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            res = await rescue_bulk_contact(cid, {
                "contact_id":    s["ak"]["id"],
                "since_minutes": 60,
                "mode":          "re-resolve",
                "execute":       False,
            }, user={"role": "superadmin"})
            assert res["dry_run"] is True
            assert res["stats"]["matched"] == 3
            assert res["stats"]["resolved_to_contact"] == 2   # JA + Venmo
            assert res["stats"]["will_clear"] == 1            # obscure memo

            # Sample includes per-row target for the caller to eyeball.
            by_merch = {p["merchant"]: p for p in res["sample"]}
            assert by_merch["J & A Marketing"]["target_contact_id"] == s["ja"]["id"]
            assert by_merch["Venmo"]["target_contact_id"] == s["venmo"]["id"]
            assert by_merch["OBSCURE ACH MEMO"]["target_contact_id"] is None
        finally:
            await _cleanup(cid)
    run(go())


def test_rescue_execute_restores_and_clears(monkeypatch):
    from routes.superadmin_diagnostics import rescue_bulk_contact
    _stub_auth(monkeypatch)

    async def go():
        cid = f"rescue-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            res = await rescue_bulk_contact(cid, {
                "contact_id":    s["ak"]["id"],
                "since_minutes": 60,
                "mode":          "re-resolve",
                "execute":       True,
            }, user={"role": "superadmin"})
            assert res["dry_run"] is False
            assert res["restored_to_original_contact"] == 2
            assert res["cleared_no_match"] == 1

            after = await db.transactions.find(
                {"id": {"$in": s["row_ids"]}, "company_id": cid}
            ).to_list(10)
            by_merch = {t["merchant"]: t for t in after}
            assert by_merch["J & A Marketing"]["contact_id"] == s["ja"]["id"]
            assert by_merch["Venmo"]["contact_id"] == s["venmo"]["id"]
            assert by_merch["OBSCURE ACH MEMO"]["contact_id"] is None
            assert by_merch["OBSCURE ACH MEMO"]["contact_name"] is None
        finally:
            await _cleanup(cid)
    run(go())
