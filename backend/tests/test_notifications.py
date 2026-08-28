"""Notifications feed (Feb 2026, Phase D-4)."""
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
    await db.users.insert_one({"id": uid, "email": f"n_{uid[:6]}@example.com",
                                "password": hash_password("x"), "role": "client",
                                "name": "N Tester"})
    await db.companies.insert_one({"id": cid, "name": "N Co",
                                     "owner_user_id": uid, "reporting_basis": "accrual"})
    await db.memberships.insert_one({"company_id": cid, "user_id": uid, "role": "owner"})
    return uid, create_token(uid, "client"), cid


async def _cleanup(uid, cid):
    for c in ("notifications", "tasks", "deals", "memberships"):
        if c == "memberships": await db[c].delete_many({"user_id": uid})
        else: await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def _h(t): return {"Authorization": f"Bearer {t}"}


def test_notification_lifecycle_and_dedup():
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            from routes.notifications import notify
            # Enqueue 3 different-kind notifications.
            await notify(cid, uid, "task_assigned", "Task 1", "", "/tasks")
            await notify(cid, uid, "timesheet_approval", "TS 1", "", "/team/approvals")
            await notify(cid, uid, "mention", "Mention 1", "", "/crm")
            # Dedup: same source-id inside 1h → skipped.
            await notify(cid, uid, "task_assigned", "dupe", "", "/tasks",
                          source={"kind": "task", "id": "t1"})
            await notify(cid, uid, "task_assigned", "dupe again", "", "/tasks",
                          source={"kind": "task", "id": "t1"})
            # Bad kind silently dropped.
            await notify(cid, uid, "not_a_kind", "should not appear", "", "")

            async with await _client() as ac:
                r = await ac.get("/api/notifications", headers=_h(token))
                assert r.status_code == 200
                data = r.json()
                # 3 explicit kinds + 1 source-dedup entry = 4
                # (stale-deal virtuals are 0 because no deals seeded).
                assert data["unread_count"] == 4, data
                kinds = [n["kind"] for n in data["notifications"]]
                assert "not_a_kind" not in kinds
                assert kinds.count("task_assigned") == 2  # 1 original + 1 dedup key
                # Latest first ordering.
                assert data["notifications"][0]["created_at"] \
                       >= data["notifications"][-1]["created_at"]

                # Mark one read.
                first_id = data["notifications"][0]["id"]
                r = await ac.post(f"/api/notifications/{first_id}/read",
                                    headers=_h(token))
                assert r.status_code == 200

                # Unread count drops.
                r = await ac.get("/api/notifications?unread_only=1",
                                  headers=_h(token))
                assert r.json()["unread_count"] == 3

                # Mark all read → 0.
                r = await ac.post("/api/notifications/mark-all-read",
                                    headers=_h(token))
                assert r.json()["count"] >= 3
                r = await ac.get("/api/notifications?unread_only=1",
                                  headers=_h(token))
                assert r.json()["unread_count"] == 0
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_stale_deal_virtual_notifications():
    """Deals not updated in >14 days emit virtual notifications."""
    async def _t():
        uid, token, cid = await _mk_env()
        try:
            from datetime import datetime, timezone, timedelta
            old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
            fresh = datetime.now(timezone.utc).isoformat()
            await db.deals.insert_many([
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "title": "Stale deal", "stage": "proposal", "value": 5000,
                 "owner_user_id": uid, "updated_at": old},
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "title": "Fresh deal", "stage": "lead", "value": 100,
                 "owner_user_id": uid, "updated_at": fresh},
                {"id": str(uuid.uuid4()), "company_id": cid,
                 "title": "Someone else's", "stage": "lead", "value": 999,
                 "owner_user_id": "other-uid", "updated_at": old},
            ])
            async with await _client() as ac:
                r = await ac.get("/api/notifications", headers=_h(token))
                stale = [n for n in r.json()["notifications"]
                          if n["kind"] == "stale_deal"]
                # Only OUR stale deal — not the fresh one, not the
                # other-user's stale one.
                assert len(stale) == 1, stale
                assert stale[0]["title"].startswith("Deal ")
                # Virtual notifications can't be marked read.
                r = await ac.post(f"/api/notifications/{stale[0]['id']}/read",
                                    headers=_h(token))
                assert r.json().get("virtual") is True
        finally:
            await _cleanup(uid, cid)
    _run(_t())
