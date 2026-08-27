"""Classes CRUD + features-flag mutations (Phase 2 — Feb 2026).

Ships the minimum backend surface Phase 2 needs:

    PATCH  /api/companies/{cid}/features       — flip any subset of the
        3 advanced-features flags.
    GET    /api/companies/{cid}/classes        — list active classes
        (with an ?include_inactive=1 escape hatch for admin UIs).
    POST   /api/companies/{cid}/classes        — create.
    PATCH  /api/companies/{cid}/classes/{id}   — rename / archive /
        change parent.
    DELETE /api/companies/{cid}/classes/{id}   — soft delete (sets
        `active=false`). Hard delete only when the class has zero
        referencing txns/JE lines/invoices/bills.

Design notes:
    * Every route enforces membership via `require_company`.
    * Feature flags default OFF. Turning `classes_enabled=false` never
      deletes existing class rows — the UI just hides them.
    * Names are case-insensitive-unique per company (matches QBO).
    * Parent nesting is one level deep max (mirrors QBO Plus).
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from deps import require_company
from db import db, now_iso

router = APIRouter(prefix="/api")


# --- helpers ---------------------------------------------------------
def _clean(doc: dict) -> dict:
    """Strip Mongo `_id` before JSON return."""
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


async def _name_conflicts(cid: str, name: str, exclude_id: str | None = None) -> bool:
    q: dict[str, Any] = {
        "company_id": cid,
        "name": {"$regex": f"^{name}$", "$options": "i"},
    }
    if exclude_id:
        q["id"] = {"$ne": exclude_id}
    return bool(await db.classes.find_one(q))


async def _class_in_use(cid: str, class_id: str) -> bool:
    """True if any txn / JE line / doc references this class id."""
    if await db.transactions.count_documents(
        {"company_id": cid, "class_id": class_id}, limit=1,
    ):
        return True
    if await db.journal_entries.count_documents(
        {"company_id": cid, "lines.class_id": class_id}, limit=1,
    ):
        return True
    for coll in ("invoices", "bills", "payments", "receipts", "estimates"):
        if await db[coll].count_documents(
            {"company_id": cid, "class_id": class_id}, limit=1,
        ):
            return True
    return False


# --- features flag mutation ------------------------------------------
@router.patch("/companies/{cid}/features")
async def patch_features(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    """Flip any subset of the 3 advanced-features flags. Unknown keys
    are ignored (keeps the surface stable if we add flags later)."""
    await require_company(user, cid)
    allowed = {"classes_enabled", "projects_enabled", "budgets_enabled"}
    update = {f"features.{k}": bool(v)
              for k, v in (payload or {}).items() if k in allowed}
    if not update:
        raise HTTPException(400, "No recognized feature flags in payload")
    update["updated_at"] = now_iso()
    await db.companies.update_one({"id": cid}, {"$set": update})
    from advanced_features import get_features
    return {"ok": True, "features": await get_features(cid)}


# --- Classes CRUD ----------------------------------------------------
@router.get("/companies/{cid}/classes")
async def list_classes(
    cid: str,
    include_inactive: int = Query(0, description="Include archived rows"),
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    q: dict[str, Any] = {"company_id": cid}
    if not include_inactive:
        q["active"] = {"$ne": False}
    rows = await db.classes.find(q).sort("name", 1).to_list(2000)
    return {"classes": [_clean(r) for r in rows]}


@router.post("/companies/{cid}/classes")
async def create_class(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Class name is required")
    parent_id = payload.get("parent_class_id") or None
    # Guard: max 1 level of nesting.
    if parent_id:
        parent = await db.classes.find_one(
            {"company_id": cid, "id": parent_id})
        if not parent:
            raise HTTPException(400, "Parent class not found")
        if parent.get("parent_class_id"):
            raise HTTPException(400, "Parent class is itself nested — nesting is capped at 1 level")
    if await _name_conflicts(cid, name):
        raise HTTPException(409, f'A class named "{name}" already exists')
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": name,
        "parent_class_id": parent_id,
        "active": True,
        "created_at": now,
        "updated_at": now,
    }
    await db.classes.insert_one(doc)
    return {"ok": True, "class": _clean(dict(doc))}


@router.patch("/companies/{cid}/classes/{cls_id}")
async def update_class(
    cid: str, cls_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.classes.find_one({"company_id": cid, "id": cls_id})
    if not doc:
        raise HTTPException(404, "Class not found")

    update: dict = {}
    if "name" in payload:
        new_name = (payload["name"] or "").strip()
        if not new_name:
            raise HTTPException(400, "Name cannot be empty")
        if await _name_conflicts(cid, new_name, exclude_id=cls_id):
            raise HTTPException(409, f'A class named "{new_name}" already exists')
        update["name"] = new_name
    if "active" in payload:
        update["active"] = bool(payload["active"])
    if "parent_class_id" in payload:
        pid = payload["parent_class_id"] or None
        if pid == cls_id:
            raise HTTPException(400, "A class cannot be its own parent")
        if pid:
            parent = await db.classes.find_one(
                {"company_id": cid, "id": pid})
            if not parent:
                raise HTTPException(400, "Parent class not found")
            if parent.get("parent_class_id"):
                raise HTTPException(400, "Parent class is itself nested — nesting is capped at 1 level")
            # Guard: if this class already has children, it can't be
            # given a parent (would create > 1 level of nesting).
            has_children = await db.classes.count_documents(
                {"company_id": cid, "parent_class_id": cls_id}, limit=1)
            if has_children:
                raise HTTPException(400, "This class has children — cannot nest it under another class")
        update["parent_class_id"] = pid
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.classes.update_one(
        {"company_id": cid, "id": cls_id}, {"$set": update})
    fresh = await db.classes.find_one({"company_id": cid, "id": cls_id})
    return {"ok": True, "class": _clean(fresh)}


@router.delete("/companies/{cid}/classes/{cls_id}")
async def delete_class(
    cid: str, cls_id: str,
    hard: int = Query(0, description="Hard-delete when unused"),
    user: dict = Depends(get_current_user),
) -> dict:
    """Soft-delete by default (sets active=false). `hard=1` removes
    the row entirely — only permitted when nothing references it."""
    await require_company(user, cid)
    doc = await db.classes.find_one({"company_id": cid, "id": cls_id})
    if not doc:
        raise HTTPException(404, "Class not found")
    # A parent with children can't be deleted (soft or hard) — the
    # user must archive children first, matching QBO's behavior.
    has_children = await db.classes.count_documents(
        {"company_id": cid, "parent_class_id": cls_id, "active": {"$ne": False}},
        limit=1)
    if has_children:
        raise HTTPException(400, "This class has active child classes — archive them first")
    if hard:
        if await _class_in_use(cid, cls_id):
            raise HTTPException(
                400,
                "Class is referenced by transactions or journal entries — archive instead of deleting")
        await db.classes.delete_one({"company_id": cid, "id": cls_id})
        return {"ok": True, "deleted": True, "hard": True}
    await db.classes.update_one(
        {"company_id": cid, "id": cls_id},
        {"$set": {"active": False, "updated_at": now_iso()}},
    )
    return {"ok": True, "deleted": True, "hard": False}
