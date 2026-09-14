"""Milestone E test — authenticated `/pending/{cid}` endpoint.

Exercises: no-batch → has_pending:false, email match → has_pending:true,
scheduled vs open status pass-through, wrong-email isolation.
"""
import sys, os, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport

from tests._shared_loop import run
from deps import db
import client_review as cr
from server import app
from auth import create_token


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app),
                       base_url="http://testserver")


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


async def _mk_user_and_company(cid: str, email: str) -> tuple[dict, str]:
    """Create a fresh user + company and return (user_doc, jwt)."""
    uid = f"u-{cid[:8]}"
    user = {"id": uid, "email": email, "role": "client",
            "created_at": _iso_days_ago(1)}
    await db.users.insert_one(user)
    await db.companies.insert_one({
        "id": cid, "name": f"Co-{cid[:6]}",
        "owner_id": uid, "client_email": email,
        "primary_pro_id": f"pro-{cid[:8]}",
        "created_at": _iso_days_ago(60),
    })
    token = create_token(uid, "client")
    return user, token


async def _seed_findings(cid: str) -> None:
    for kind in ("missing_receipt", "w9_needed", "contact_mismatch"):
        await db.agent_findings.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "kind": kind,
            "status": "open", "batch_id": None,
            "title": kind, "detail": f"{kind} detail",
            "meta": {}, "severity": "amber",
            "created_at": _iso_days_ago(0),
        })


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": f"u-{cid[:8]}"})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


async def _e2e_pending_no_batch():
    cid = f"test-{uuid.uuid4()}"
    _, jwt = await _mk_user_and_company(cid, "owner@fx.example")
    async with _client() as c:
        r = await c.get(f"/api/client-review/pending/{cid}",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        assert r.json() == {"has_pending": False}
    await _cleanup(cid)


def test_pending_no_batch():
    run(_e2e_pending_no_batch())


async def _e2e_pending_open_batch():
    cid = f"test-{uuid.uuid4()}"
    _, jwt = await _mk_user_and_company(cid, "owner@fx.example")
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)

    async with _client() as c:
        r = await c.get(f"/api/client-review/pending/{cid}",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["has_pending"] is True
        assert j["batch_id"] == batch["id"]
        assert j["status"] == "open"
        assert j["item_count"] == 3
        assert j["total_count"] == 3
        # Token is never exposed via this endpoint.
        assert "client_token" not in j
        assert "token" not in j
    await _cleanup(cid)


def test_pending_open_batch():
    run(_e2e_pending_open_batch())


async def _e2e_pending_scheduled_batch_shows_time():
    cid = f"test-{uuid.uuid4()}"
    _, jwt = await _mk_user_and_company(cid, "owner@fx.example")
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    future = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    await cr.schedule_batch(batch, future)

    async with _client() as c:
        r = await c.get(f"/api/client-review/pending/{cid}",
                        headers={"Authorization": f"Bearer {jwt}"})
        j = r.json()
        assert j["has_pending"] is True
        assert j["status"] == "scheduled"
        assert j["scheduled_for"] == future
    await _cleanup(cid)


def test_pending_scheduled_batch_shows_time():
    run(_e2e_pending_scheduled_batch_shows_time())


async def _e2e_pending_isolated_by_email():
    """A batch keyed to owner-A's email must NOT surface to owner-B on
    the same company."""
    cid = f"test-{uuid.uuid4()}"
    _, jwt_a = await _mk_user_and_company(cid, "ownerA@fx.example")
    # Second user in same company, different email
    other_uid = f"u2-{cid[:8]}"
    await db.users.insert_one({
        "id": other_uid, "email": "ownerB@fx.example",
        "role": "client", "created_at": _iso_days_ago(1),
    })
    jwt_b = create_token(other_uid, "client")

    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    await cr.create_batch(cid, "ownerA@fx.example", items)

    async with _client() as c:
        # Owner A sees it
        r = await c.get(f"/api/client-review/pending/{cid}",
                        headers={"Authorization": f"Bearer {jwt_a}"})
        assert r.json()["has_pending"] is True

        # Owner B does not — same company, different email
        r = await c.get(f"/api/client-review/pending/{cid}",
                        headers={"Authorization": f"Bearer {jwt_b}"})
        assert r.json()["has_pending"] is False

    await db.users.delete_many({"id": other_uid})
    await _cleanup(cid)


def test_pending_isolated_by_email():
    run(_e2e_pending_isolated_by_email())


async def _e2e_open_endpoint_redirects_to_review():
    cid = f"test-{uuid.uuid4()}"
    _, jwt = await _mk_user_and_company(cid, "owner@fx.example")
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)

    async with _client() as c:
        # Don't follow redirects — assert the 302 target
        r = await c.get(f"/api/client-review/pending/{cid}/open",
                        headers={"Authorization": f"Bearer {jwt}"},
                        follow_redirects=False)
        assert r.status_code == 302, r.text
        assert r.headers["location"] == f"/client-review/{batch['client_token']}"

        # No pending → 404
        await db.client_review_batches.delete_many({"id": batch["id"]})
        r = await c.get(f"/api/client-review/pending/{cid}/open",
                        headers={"Authorization": f"Bearer {jwt}"},
                        follow_redirects=False)
        assert r.status_code == 404

    await _cleanup(cid)


def test_open_endpoint_redirects_to_review():
    run(_e2e_open_endpoint_redirects_to_review())


if __name__ == "__main__":
    tests = [
        ("test_pending_no_batch",                 test_pending_no_batch),
        ("test_pending_open_batch",               test_pending_open_batch),
        ("test_pending_scheduled_batch_shows_time", test_pending_scheduled_batch_shows_time),
        ("test_pending_isolated_by_email",        test_pending_isolated_by_email),
        ("test_open_endpoint_redirects_to_review", test_open_endpoint_redirects_to_review),
    ]
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
            passed += 1
        except Exception as e:
            print(f"FAIL {name}: {type(e).__name__}: {e}")
            failed += 1
    print()
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
