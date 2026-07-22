"""Company-scoped role-based write guard middleware (Feb 2026 — Feature #3).

Enforces the 4-tier role model at the HTTP layer so we don't have to
retrofit 138+ ``require_company`` call sites individually. The trade-off
is that a small amount of URL-pattern matching lives here instead of at
each endpoint — kept in ONE place for auditability.

Role → what's allowed under ``/api/companies/{cid}/...``:
   * ``owner`` / ``pro`` / ``superadmin`` — everything (unchanged)
   * ``editor``   — everything except superadmin-only endpoints
   * ``reviewer`` — GETs, plus any path segment matching REVIEW_PATTERNS
     (approve / reject / review actions)
   * ``viewer``   — GETs only

Non-``/api/companies/*`` routes (login, /api/pro, /api/admin, /api/invites,
/api/q public magic-link, etc.) bypass this middleware entirely — those
endpoints already have their own role checks via ``require_role`` /
``require_company`` in-handler.
"""
from __future__ import annotations
import os
import re
import logging

import jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from db import db
from auth import JWT_SECRET, JWT_ALG

logger = logging.getLogger(__name__)

# Which methods count as "writes". GET / HEAD / OPTIONS always pass so
# reads and CORS pre-flight aren't blocked.
_WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}

# Regex over the URL path — matches segments like ``.../approve``,
# ``.../reject``, ``.../review``, ``.../signoff``. Reviewers are allowed
# to hit any of these; editors and above always are.
_REVIEW_PATH_RE = re.compile(
    r"/(approve|reject|review|signoff|sign-off|mega-approve)(/|$|\?)",
    re.IGNORECASE,
)

# Match ``/api/companies/{cid}/...`` and capture the company id. We
# require at least one path segment AFTER the cid so we don't scope the
# ``/api/companies`` list endpoint or ``/api/companies/{cid}`` alone.
_COMPANY_PATH_RE = re.compile(
    r"^/api/companies/([^/]+)/",
    re.IGNORECASE,
)

_WRITE_ROLES  = {"owner", "pro", "editor", "superadmin"}
_REVIEW_ROLES = {"owner", "pro", "editor", "reviewer", "superadmin"}


class RoleWriteGuardMiddleware(BaseHTTPMiddleware):
    """Blocks write operations on company-scoped URLs when the caller's
    membership role isn't sufficient. Read operations and non-company
    URLs are untouched — the goal is to be an *additional* safety net,
    not a replacement for existing in-handler auth.
    """

    async def dispatch(self, request, call_next):
        # Fast-path: only care about writes to /api/companies/{cid}/...
        if request.method not in _WRITE_METHODS:
            return await call_next(request)
        m = _COMPANY_PATH_RE.match(request.url.path)
        if not m:
            return await call_next(request)
        company_id = m.group(1)

        # Extract user_id from the bearer token without going through the
        # FastAPI dependency chain (middleware runs before deps resolve).
        # If the token is missing or bad, we let the request through and
        # the endpoint's own auth dep will 401 correctly.
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return await call_next(request)
        try:
            payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALG])
        except jwt.PyJWTError:
            return await call_next(request)
        user_id = payload.get("sub")
        user_role = payload.get("role")
        if not user_id:
            return await call_next(request)
        # Superadmin / global-pro never hit membership restrictions.
        if user_role == "superadmin":
            return await call_next(request)

        membership = await db.memberships.find_one(
            {"user_id": user_id, "company_id": company_id},
        )
        if not membership:
            # No membership at all — let the endpoint's require_company
            # dep 403. This middleware ONLY handles the role tier check.
            return await call_next(request)

        role = membership.get("role")
        is_review_action = bool(_REVIEW_PATH_RE.search(request.url.path))

        # Viewer → block every write.
        if role == "viewer":
            return _forbid(role, "read-only")

        # Reviewer → only review-path actions are permitted.
        if role == "reviewer" and not is_review_action:
            return _forbid(role, "review-only (approve / reject actions only)")

        return await call_next(request)


def _forbid(role: str, why: str) -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={
            "detail": (
                f"Your role on this company ({role}) is {why}. "
                "Ask an owner or editor to make the change."
            ),
        },
    )
