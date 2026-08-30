"""Superadmin routes for Product Launch management (Round 7.21, Feb 2026)."""
from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user
from db import db, now_iso
from product_launches import (
    PRODUCT_KEYS, ensure_seeded, get_all, accessible_modules,
)

router = APIRouter(prefix="/api", tags=["product-launches"])


def _require_superadmin(user: dict) -> None:
    if (user or {}).get("role") != "superadmin":
        raise HTTPException(403, "Superadmin only.")


@router.get("/superadmin/product-launches")
async def list_product_launches(user: dict = Depends(get_current_user)):
    _require_superadmin(user)
    await ensure_seeded()
    rows = await get_all()
    # Attach allowlisted user summaries so the UI can render chips
    # without a per-user round-trip. Small N (allowlist rarely > 50).
    all_ids: set[str] = set()
    for r in rows:
        all_ids.update(r.get("allowlist_user_ids") or [])
    users_by_id: dict[str, dict] = {}
    if all_ids:
        async for u in db.users.find(
            {"id": {"$in": list(all_ids)}},
            {"_id": 0, "id": 1, "email": 1, "name": 1, "role": 1},
        ):
            users_by_id[u["id"]] = u
    out = []
    for r in rows:
        out.append({
            **r,
            "allowlist_users": [
                users_by_id[uid] for uid in (r.get("allowlist_user_ids") or [])
                if uid in users_by_id
            ],
        })
    return {"launches": out}


class ProductLaunchPatch(BaseModel):
    mode: Optional[str] = None  # "preview" | "public" | "subscription"


@router.patch("/superadmin/product-launches/{product_key}")
async def update_product_launch(
    product_key: str,
    patch: ProductLaunchPatch,
    user: dict = Depends(get_current_user),
):
    _require_superadmin(user)
    if product_key not in PRODUCT_KEYS:
        raise HTTPException(404, "Unknown product.")
    # Accounting is a core product — cannot be pulled off `public`
    # from the UI. Enforced server-side so a hand-crafted request
    # can't lock existing users out.
    if product_key == "accounting" and patch.mode and patch.mode != "public":
        raise HTTPException(
            400,
            "Accounting is a core product and cannot be gated. "
            "Only its mode='public' is supported.",
        )
    if patch.mode and patch.mode not in {"preview", "public", "subscription"}:
        raise HTTPException(400, "Invalid mode.")
    updates: dict = {"updated_at": now_iso(), "updated_by": user.get("id")}
    if patch.mode:
        updates["mode"] = patch.mode
    result = await db.product_launches.find_one_and_update(
        {"product_key": product_key},
        {"$set": updates},
        return_document=True,
        projection={"_id": 0},
    )
    if not result:
        raise HTTPException(404, "Product launch row missing — retry after seed.")
    # Best-effort audit-log entry.
    try:
        await db.audit_log.insert_one({
            "action": "product_launch.update",
            "product_key": product_key,
            "changes": {k: v for k, v in updates.items() if k not in ("updated_at",)},
            "by": user.get("id"),
            "at": now_iso(),
        })
    except Exception:  # noqa: BLE001
        pass
    return result


class AllowlistIn(BaseModel):
    user_id: str = Field(min_length=1)


@router.post("/superadmin/product-launches/{product_key}/allowlist")
async def add_allowlist_user(
    product_key: str,
    inp: AllowlistIn,
    user: dict = Depends(get_current_user),
):
    _require_superadmin(user)
    if product_key not in PRODUCT_KEYS:
        raise HTTPException(404, "Unknown product.")
    # Verify user exists — fail fast rather than storing a dangling id.
    target = await db.users.find_one({"id": inp.user_id}, {"_id": 0, "id": 1})
    if not target:
        raise HTTPException(404, "User not found.")
    await db.product_launches.update_one(
        {"product_key": product_key},
        {"$addToSet": {"allowlist_user_ids": inp.user_id},
         "$set": {"updated_at": now_iso(), "updated_by": user.get("id")}},
    )
    try:
        await db.audit_log.insert_one({
            "action": "product_launch.allowlist_add",
            "product_key": product_key,
            "target_user_id": inp.user_id,
            "by": user.get("id"),
            "at": now_iso(),
        })
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@router.delete("/superadmin/product-launches/{product_key}/allowlist/{user_id}")
async def remove_allowlist_user(
    product_key: str,
    user_id: str,
    user: dict = Depends(get_current_user),
):
    _require_superadmin(user)
    if product_key not in PRODUCT_KEYS:
        raise HTTPException(404, "Unknown product.")
    await db.product_launches.update_one(
        {"product_key": product_key},
        {"$pull": {"allowlist_user_ids": user_id},
         "$set": {"updated_at": now_iso(), "updated_by": user.get("id")}},
    )
    try:
        await db.audit_log.insert_one({
            "action": "product_launch.allowlist_remove",
            "product_key": product_key,
            "target_user_id": user_id,
            "by": user.get("id"),
            "at": now_iso(),
        })
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@router.get("/superadmin/users/search")
async def search_users(
    q: str = "",
    limit: int = 20,
    user: dict = Depends(get_current_user),
):
    """Superadmin user picker for the Product Launch allowlist. Matches
    email OR name (case-insensitive, prefix-ish via regex). Capped to
    a small page — the UI is a chip picker, not a full CRUD grid."""
    _require_superadmin(user)
    q = (q or "").strip()
    limit = max(1, min(limit, 50))
    filt: dict = {}
    if q:
        import re
        rx = re.compile(re.escape(q), re.I)
        filt = {"$or": [{"email": rx}, {"name": rx}]}
    users: list[dict] = []
    async for u in db.users.find(
        filt,
        {"_id": 0, "id": 1, "email": 1, "name": 1, "role": 1, "enterprise_id": 1},
    ).limit(limit):
        users.append(u)
    return {"users": users}
