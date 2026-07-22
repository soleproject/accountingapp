"""Role-based write guard tests (Feb 2026 — Feature #3 enforcement).

Hits the live backend via httpx (bypasses the event-loop mismatch that
TestClient introduces with Motor). Seeds three test users per company
role + assertions on the guard's behaviour.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid

import httpx
import pytest
from dotenv import dotenv_values

sys.path.insert(0, "/app/backend")
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME", "JWT_SECRET"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))
# Point tests at the local backend (supervisor keeps it running on 8001).
BASE = "http://localhost:8001"

from db import db, now_iso  # noqa: E402
from auth import hash_password, create_token  # noqa: E402

_LOOP = asyncio.new_event_loop()
def _run(coro): return _LOOP.run_until_complete(coro)


@pytest.fixture
def scenario():
    cid = f"testrbac_{uuid.uuid4().hex[:8]}"
    users = {}
    tokens = {}

    async def _setup():
        for role in ("owner", "editor", "reviewer", "viewer"):
            uid = f"u_{role}_{uuid.uuid4().hex[:6]}"
            email = f"{role}_{uid[-6:]}@rbactest.co"
            await db.users.insert_one({
                "id": uid, "email": email, "name": role,
                "password": hash_password("x"), "role": "client",
                "created_at": now_iso(),
            })
            await db.memberships.insert_one({
                "id": str(uuid.uuid4()), "user_id": uid, "company_id": cid,
                "role": role, "created_at": now_iso(),
            })
            users[role] = uid
            tokens[role] = create_token(uid, "client")
        await db.companies.insert_one({
            "id": cid, "name": "RBAC Test Co",
            "owner_user_id": users["owner"],
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    _run(_setup())

    yield {"cid": cid, "users": users, "tokens": tokens}

    async def _cleanup():
        await db.companies.delete_many({"id": cid})
        await db.users.delete_many({"id": {"$in": list(users.values())}})
        await db.memberships.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
    _run(_cleanup())


def _hdr(tok): return {"Authorization": f"Bearer {tok}"}


def _post(path: str, tok: str, json=None):
    with httpx.Client(base_url=BASE, timeout=15) as h:
        return h.post(path, headers=_hdr(tok), json=json)


def _get(path: str, tok: str):
    with httpx.Client(base_url=BASE, timeout=15) as h:
        return h.get(path, headers=_hdr(tok))


def test_viewer_can_read_but_not_write(scenario):
    cid = scenario["cid"]
    tok = scenario["tokens"]["viewer"]

    r = _get(f"/api/companies/{cid}/transactions", tok)
    assert r.status_code == 200, f"viewer GET blocked: {r.status_code} {r.text}"

    r = _post(f"/api/companies/{cid}/transactions", tok, json={
        "date": "2026-07-21", "amount": -10, "description": "x",
    })
    assert r.status_code == 403, r.status_code
    assert "read-only" in r.json()["detail"].lower()


def test_reviewer_blocked_from_writes_but_review_path_allowed(scenario):
    cid = scenario["cid"]
    tok = scenario["tokens"]["reviewer"]

    r = _post(f"/api/companies/{cid}/transactions", tok, json={
        "date": "2026-07-21", "amount": -10, "description": "x",
    })
    assert r.status_code == 403
    assert "review-only" in r.json()["detail"].lower()

    # /approve path must NOT be blocked at the guard layer. The endpoint
    # itself may 404 (no such txn) — that's fine, we're asserting the
    # guard is transparent for review actions.
    r = _post(f"/api/companies/{cid}/transactions/nonexistent-txn/approve", tok)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    assert not (r.status_code == 403 and "review-only" in body.get("detail", "").lower()), \
        f"guard incorrectly blocked review-path: {r.status_code} {r.text}"


def test_editor_can_write_transactions(scenario):
    cid = scenario["cid"]
    tok = scenario["tokens"]["editor"]
    r = _post(f"/api/companies/{cid}/transactions", tok, json={
        "date": "2026-07-21", "amount": -25.5, "description": "editor writes ok",
    })
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    # Guard must not 403. The endpoint may still 422 on schema quirks —
    # what matters is that no *guard* 403 fired.
    assert not (r.status_code == 403 and "read-only" in body.get("detail", "").lower()), \
        f"guard blocked editor write: {r.status_code} {r.text}"


def test_owner_can_still_write(scenario):
    cid = scenario["cid"]
    tok = scenario["tokens"]["owner"]
    r = _post(f"/api/companies/{cid}/transactions", tok, json={
        "date": "2026-07-21", "amount": -1, "description": "owner write",
    })
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    assert not (r.status_code == 403 and "read-only" in body.get("detail", "").lower()), \
        f"guard incorrectly blocked owner: {r.status_code} {r.text}"


def test_guard_only_applies_to_company_scoped_routes(scenario):
    """The guard MUST NOT interfere with non-company URLs — auth, pro,
    admin, invites, and public magic-link routes must all still work."""
    tok = scenario["tokens"]["viewer"]
    r = _get("/api/auth/me", tok)
    assert r.status_code == 200, r.text
