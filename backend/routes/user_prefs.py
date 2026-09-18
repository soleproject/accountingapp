"""Per-user, cross-device preferences store.

A very thin key-value blob keyed by user_id. Used for per-user UI
toggles that should follow the user across devices (browser, laptop,
tablet, etc.) rather than living in localStorage. The frontend
`useUserPref(key)` hook talks to these routes.

Schema:
    user_prefs:
        _id, user_id (unique), prefs: dict, updated_at

Contract:
    GET   /api/users/me/prefs                 → {"prefs": {...}}
    PATCH /api/users/me/prefs  {key, value}   → merges into prefs
    PATCH /api/users/me/prefs  {prefs: {...}} → shallow-merges the dict

    - `key` supports simple dot notation (`reviewMode.abc123`) — the
      key is stored verbatim under `prefs`, no nested traversal, so
      each key is fully independent.
    - `value` may be null to remove a key.
"""
from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Body, Depends

from auth import get_current_user
from db import db

router = APIRouter(prefix="/api")


def _clean(doc: dict | None) -> dict:
    if not doc: return {"prefs": {}}
    doc.pop("_id", None)
    return doc


@router.get("/users/me/prefs")
async def get_prefs(user: dict = Depends(get_current_user)):
    doc = await db.user_prefs.find_one({"user_id": user["id"]})
    return _clean(doc)


@router.patch("/users/me/prefs")
async def patch_prefs(payload: dict = Body(...),
                      user: dict = Depends(get_current_user)):
    """Merge one or more keys into the user's prefs dict.

    Accepts either:
      • {"key": "reviewMode.abc123", "value": "chat"}  (single)
      • {"prefs": {"reviewMode.abc123": "chat", ...}}  (batch)
    Passing value=null (or a null in the batch dict) removes the key.

    Keys are stored as flat strings in `prefs` (dots kept verbatim,
    NOT interpreted as nested paths) — we do a read-modify-write on
    the whole `prefs` dict so Mongo's dot-notation doesn't collide
    with our namespace scheme (e.g. `reviewMode.<companyId>`).
    """
    now = datetime.now(timezone.utc).isoformat()
    updates: dict = {}
    removals: list[str] = []
    if "key" in payload:
        k = str(payload.get("key") or "").strip()
        if k:
            v = payload.get("value")
            (removals.append(k) if v is None else updates.__setitem__(k, v))
    if isinstance(payload.get("prefs"), dict):
        for k, v in payload["prefs"].items():
            key = str(k or "").strip()
            if not key: continue
            (removals.append(key) if v is None else updates.__setitem__(key, v))
    doc = await db.user_prefs.find_one({"user_id": user["id"]}) or {}
    prefs = dict(doc.get("prefs") or {})
    prefs.update(updates)
    for k in removals:
        prefs.pop(k, None)
    if not updates and not removals:
        # Nothing to persist — return the current state.
        return _clean(doc if doc else None)
    await db.user_prefs.update_one(
        {"user_id": user["id"]},
        {"$set": {"prefs": prefs, "updated_at": now,
                  "user_id": user["id"]}},
        upsert=True,
    )
    return _clean(await db.user_prefs.find_one({"user_id": user["id"]}))
