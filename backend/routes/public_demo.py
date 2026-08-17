"""Public "Live UK demo" endpoint.

Anyone hitting `POST /api/public/demo/uk` (no auth) gets a short-lived
JWT for a shared demo user who has **viewer** membership on
"Northgate Advisory Ltd". The RoleWriteGuardMiddleware already blocks
every /api/companies/{cid}/... write for viewers → any visitor can
click around every screen but cannot corrupt the demo data.

Rate-limited to 30/minute per IP so a crawler can't churn tokens; the
token itself is 30-minute so a slow reader has time but a leaked
token expires quickly.

Idempotent: if the demo user or Northgate company already exist, we
reuse them. If Northgate doesn't exist yet, we seed it on-demand
using the same `uk_demo_seed` module the superadmin card uses, so
Ops never has to remember to pre-seed anything before flipping the
landing page live.
"""
from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, Request
from slowapi.errors import RateLimitExceeded

from db import db, now_iso
from auth import create_token, hash_password
from infra import limiter

router = APIRouter(prefix="/api/public", tags=["public-demo"])


_DEMO_EMAIL = "demo-uk@smartbooks.ai"
_DEMO_NAME = "UK Demo Visitor"
# 30-minute token — long enough for a proper tour, short enough that
# a leaked token can't be used for a persistent unauthorised session.
_TOKEN_TTL_SECONDS = 30 * 60


async def _ensure_demo_user() -> dict:
    """Return the shared demo user, creating it if missing. The user
    has top-level role `client` (harmless) — the read-only guarantee
    comes from their MEMBERSHIP role on Northgate being `viewer`."""
    u = await db.users.find_one({"email": _DEMO_EMAIL})
    if u:
        return u
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "email": _DEMO_EMAIL,
        "name": _DEMO_NAME,
        # Random unrecoverable password — this account is only ever
        # authenticated via the public demo token flow, never by a
        # human logging in. Blocks anyone who guesses the email.
        "hashed_password": hash_password(uuid.uuid4().hex + uuid.uuid4().hex),
        "role": "client",
        "is_demo_visitor": True,
        "created_at": now, "updated_at": now,
    }
    await db.users.insert_one(doc)
    return doc


async def _ensure_demo_company(demo_user_id: str) -> str:
    """Return the demo company_id, seeding a fresh Northgate Advisory
    on first call. The demo company is owned by a superadmin (or
    whoever spun it up first via the admin card); we don't re-own it
    — we just make sure the demo user has a viewer-role membership
    on it so RBAC works."""
    # Prefer the newest `is_uk_demo` company on the platform, whoever
    # owns it. This lets a superadmin refresh the demo via the admin
    # card and every future visitor automatically switches to the
    # fresh copy.
    doc = await db.companies.find_one(
        {"is_uk_demo": True},
        sort=[("created_at", -1)],
    )
    if not doc:
        # No demo exists → seed one owned by the demo user itself.
        # (In production the superadmin usually seeds first via the
        # dashboard card; this branch is the cold-start safety net so
        # a fresh deploy's landing page never 500s.)
        from uk_demo_seed import seed_uk_demo
        cid = await seed_uk_demo(demo_user_id)
        return cid
    cid = doc["id"]
    # Ensure the demo user has a viewer membership. Idempotent —
    # $setOnInsert only touches new rows.
    now = now_iso()
    await db.memberships.update_one(
        {"user_id": demo_user_id, "company_id": cid},
        {
            "$setOnInsert": {
                "id": str(uuid.uuid4()),
                "user_id": demo_user_id,
                "company_id": cid,
                "role": "viewer",
                "created_at": now,
            },
        },
        upsert=True,
    )
    return cid


@router.post("/demo/uk")
@limiter.limit("30/minute")
async def public_uk_demo_login(request: Request):
    """Public — no auth required. Mints a 30-min viewer JWT for the
    shared demo user on Northgate Advisory Ltd."""
    user = await _ensure_demo_user()
    cid = await _ensure_demo_company(user["id"])
    token = create_token(
        user["id"], user["role"], ttl_seconds=_TOKEN_TTL_SECONDS,
    )
    return {
        "token": token,
        "user": {
            "id": user["id"], "email": user["email"],
            "name": user["name"], "role": user["role"],
            "is_demo_visitor": True,
        },
        "company_id": cid,
        "company_name": "Northgate Advisory Ltd",
        "expires_in_seconds": _TOKEN_TTL_SECONDS,
        "banner": (
            "You're exploring a live read-only demo of a UK Ltd company on "
            "SmartBooks — every screen is real, powered by real data. Sign "
            "up to run your own books with full edit access."
        ),
    }
