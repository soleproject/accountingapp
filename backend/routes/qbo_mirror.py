"""QBO Mirror routes (Phase 1a — dry-run only).

Mounted under /api. New prefix `/companies/{cid}/qbo/mirror/*` — no
overlap with the existing qbo router.
"""
from __future__ import annotations
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from db import db
from auth import get_current_user
from deps import require_company
from qbo_mirror.settings import get_config, upsert_config, append_log
from qbo_mirror.engine import run_dry_run
from qbo_mirror.pull import run_pull
from qbo_mirror.push import run_push

router = APIRouter(prefix="/api")


class MirrorConfigPatch(BaseModel):
    enabled: bool | None = None
    entities: dict[str, bool] | None = None
    conflict_policy: str | None = None
    poll_interval: str | None = None


@router.get("/companies/{cid}/qbo/mirror/config")
async def mirror_get_config(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    return await get_config(cid)


@router.put("/companies/{cid}/qbo/mirror/config")
async def mirror_put_config(cid: str, patch: MirrorConfigPatch,
                            user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    old = await get_config(cid)
    new = await upsert_config(
        cid, patch.model_dump(exclude_none=True), user.get("email") or "",
    )
    await append_log(cid, "config_change",
                     f"Config updated by {user.get('email')}",
                     {"before": {k: old.get(k) for k in
                                 ("enabled", "entities", "conflict_policy",
                                  "poll_interval")},
                      "after": {k: new.get(k) for k in
                                ("enabled", "entities", "conflict_policy",
                                 "poll_interval")}})
    return new


@router.post("/companies/{cid}/qbo/mirror/dry-run")
async def mirror_dry_run(cid: str, user: dict = Depends(get_current_user)):
    """Read local + read QBO, emit diff report. Zero writes anywhere."""
    await require_company(user, cid)
    return await run_dry_run(cid, user.get("email") or "unknown")


class MirrorPullBody(BaseModel):
    entities: list[str] | None = None


@router.post("/companies/{cid}/qbo/mirror/pull")
async def mirror_pull(cid: str, body: MirrorPullBody | None = None,
                      user: dict = Depends(get_current_user)):
    """Inbound-only sync — insert missing rows + update drifted fields
    from QBO into our local DB. Ledger never touched."""
    await require_company(user, cid)
    entities = (body.entities if body else None)
    return await run_pull(cid, user.get("email") or "unknown", entities)


@router.post("/companies/{cid}/qbo/mirror/push")
async def mirror_push(cid: str, body: MirrorPullBody | None = None,
                      user: dict = Depends(get_current_user)):
    """Outbound-only sync — POST every local-only Foundation entity to
    QBO. Only entities without a `qbo_id` are pushed. Ledger never
    touched. Failures per row are surfaced in the response."""
    await require_company(user, cid)
    entities = (body.entities if body else None)
    return await run_push(cid, user.get("email") or "unknown", entities)


@router.get("/companies/{cid}/qbo/mirror/log")
async def mirror_get_log(cid: str, limit: int = 50,
                         user: dict = Depends(get_current_user)):
    """Recent audit log entries, newest first."""
    await require_company(user, cid)
    limit = max(1, min(200, int(limit)))
    docs: list[dict] = []
    async for d in db.mirror_log.find(
        {"company_id": cid},
        {"_id": 0},
    ).sort("created_at", -1).limit(limit):
        docs.append(d)
    return {"entries": docs}
