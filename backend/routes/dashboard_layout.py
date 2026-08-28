"""Per-user dashboard layout — powers the customizable /home page
(Feb 2026, Phase D-2).

The `home-summary` endpoint emits the *catalog* of every widget the
platform currently supports for a given company. This module stores
each user's personal choice of ORDER, PIN, and HIDDEN state on top of
that catalog, keyed by (user_id, company_id).

Schema:
    dashboard_layouts:
        _id, user_id, company_id,
        widgets: [{id: str, pinned: bool, hidden: bool}],
        updated_at

Routes:
    GET   /api/companies/{cid}/dashboard-layout
    PATCH /api/companies/{cid}/dashboard-layout

Contract with the frontend:
    - PATCH accepts `{widgets: [{id, pinned?, hidden?}]}` — the full
      new ordering. Fields are optional; unknown widgets are silently
      dropped so a stale client can't inject garbage.
    - GET returns the persisted layout OR an empty scaffold on first
      visit. The frontend merges this with the catalog from
      `/home-summary` — pinned first, then in-order visible widgets,
      then any brand-new catalog widgets not yet in the user's layout.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")


def _clean(doc: dict | None) -> dict | None:
    if doc: doc.pop("_id", None)
    return doc


async def _load(uid: str, cid: str) -> dict:
    doc = await db.dashboard_layouts.find_one({
        "user_id": uid, "company_id": cid})
    if not doc:
        return {"user_id": uid, "company_id": cid,
                "widgets": [], "updated_at": None}
    return _clean(doc)


@router.get("/companies/{cid}/dashboard-layout")
async def get_layout(
    cid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    return await _load(user["id"], cid)


@router.patch("/companies/{cid}/dashboard-layout")
async def save_layout(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Save the user's ordered widget layout. Payload must be
    `{widgets: [{id, pinned?, hidden?}]}`. Widgets without an `id`
    are dropped. Duplicates are collapsed to the first occurrence
    so the frontend can send raw drag output without pre-dedup."""
    await require_company(user, cid)
    widgets_in = payload.get("widgets")
    if not isinstance(widgets_in, list):
        raise HTTPException(400, "widgets must be a list")
    seen: set[str] = set()
    cleaned: list[dict] = []
    for w in widgets_in:
        if not isinstance(w, dict): continue
        wid = w.get("id")
        if not isinstance(wid, str) or not wid: continue
        if wid in seen: continue
        seen.add(wid)
        span = w.get("w")
        # Column span (1..4). If missing / invalid, fall back to None
        # so the frontend can pick a sensible default per widget kind.
        try:
            span = int(span) if span is not None else None
            if span is not None and (span < 1 or span > 4):
                span = None
        except (TypeError, ValueError):
            span = None
        cleaned.append({
            "id": wid,
            "pinned": bool(w.get("pinned")),
            "hidden": bool(w.get("hidden")),
            "w": span,
        })
    now = now_iso()
    await db.dashboard_layouts.update_one(
        {"user_id": user["id"], "company_id": cid},
        {"$set": {
            "user_id": user["id"], "company_id": cid,
            "widgets": cleaned, "updated_at": now,
        }},
        upsert=True,
    )
    return {"ok": True, "widgets": cleaned, "updated_at": now}
