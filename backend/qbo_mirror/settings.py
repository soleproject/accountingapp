"""Per-company Mirror configuration.

A `mirror_config` doc exists ONLY after the user explicitly opts in on
the settings page. If missing, every entry point in this module treats
it as "mirror disabled" and returns a no-op — this guarantees zero
side-effects on companies that never turn Mirror on.
"""
from __future__ import annotations
from typing import Any

from db import db, now_iso

# Global master kill-switch. Set in Railway env for emergency shutdown.
import os
MASTER_DISABLED = os.environ.get("QBO_MIRROR_MASTER_DISABLE", "").lower() in ("1", "true", "yes")


DEFAULTS = {
    # OFF by default. User must explicitly toggle to enable.
    "enabled": False,
    # Locked to True in Phase 1a — every user starts in preview mode.
    # Backend enforces this: PUT /config ignores dry_run=false until
    # Phase 1b flips the guard off in code (deliberate, not a runtime
    # flag).
    "dry_run": True,
    # Entity scopes — user can uncheck any to skip. Phase 1a only
    # supports the four Foundation entities; other flags are stored for
    # forward-compat but ignored by the engine until later phases.
    "entities": {
        "accounts": True,
        "customers": True,
        "vendors": True,
        "items": True,
        "invoices": False,
        "bills": False,
        "purchases": False,
        "deposits": False,
        "transfers": False,
        "payments": False,
        "bill_payments": False,
        "journal_entries": False,
    },
    # Conflict policy default. Only "qbo_wins" is implemented in
    # Phase 1; other values silently fall back.
    "conflict_policy": "qbo_wins",
    # Poll interval for background CDC reconciler. `manual` means the
    # background job is disabled and user runs preview by hand.
    "poll_interval": "manual",  # manual | 15min | 1hour
}


async def get_config(company_id: str) -> dict[str, Any]:
    """Return the current config, filling in defaults for any missing
    keys. Never creates a doc — a caller only receives a real record
    once they explicitly PUT one."""
    cfg = await db.mirror_config.find_one({"company_id": company_id})
    if not cfg:
        return {"company_id": company_id, "exists": False, **DEFAULTS}
    return {"company_id": company_id, "exists": True,
            "enabled": bool(cfg.get("enabled", False)),
            # Phase 1a hard-lock: even if a stale record says
            # dry_run=false, force it True. Removed in Phase 1b.
            "dry_run": True,
            "entities": {**DEFAULTS["entities"], **(cfg.get("entities") or {})},
            "conflict_policy": cfg.get("conflict_policy") or DEFAULTS["conflict_policy"],
            "poll_interval": cfg.get("poll_interval") or DEFAULTS["poll_interval"],
            "updated_at": cfg.get("updated_at"),
            "updated_by": cfg.get("updated_by"),
            "master_disabled": MASTER_DISABLED}


async def upsert_config(company_id: str, patch: dict, user_email: str) -> dict:
    """Merge `patch` into the config, creating the doc if it doesn't
    exist. Never trusts a client-supplied `dry_run: false` in Phase 1a
    (the engine will refuse to write to QBO regardless, but we also
    scrub the flag here defensively)."""
    patch = dict(patch or {})
    # Whitelist — anything not here is dropped so a malicious client
    # can't inject arbitrary fields.
    allowed = {"enabled", "entities", "conflict_policy", "poll_interval"}
    patch = {k: v for k, v in patch.items() if k in allowed}
    patch["dry_run"] = True  # hard-lock Phase 1a
    patch["updated_at"] = now_iso()
    patch["updated_by"] = user_email
    await db.mirror_config.update_one(
        {"company_id": company_id},
        {"$set": patch, "$setOnInsert": {"created_at": now_iso()}},
        upsert=True,
    )
    return await get_config(company_id)


async def is_enabled(company_id: str) -> bool:
    """Fast guard used by every engine entry point. Returns False for
    companies without a config, master-disabled envs, or explicitly
    paused mirrors."""
    if MASTER_DISABLED:
        return False
    cfg = await db.mirror_config.find_one(
        {"company_id": company_id},
        {"enabled": 1, "_id": 0},
    )
    return bool(cfg and cfg.get("enabled"))


async def append_log(company_id: str, kind: str, message: str,
                     details: dict | None = None) -> None:
    """Append-only audit log. `kind` values:
       - `dry_run` — preview action
       - `config_change` — user toggled setting
       - `warning`, `error` — future phases
    """
    await db.mirror_log.insert_one({
        "company_id": company_id,
        "kind": kind,
        "message": message,
        "details": details or {},
        "created_at": now_iso(),
    })
