"""Product Launch — per-product access control (Round 7.21, Feb 2026).

Four products (`crm`, `projects`, `team`, `accounting`) each have a
mode + an allowlist of user ids. Accounting is a core product and
starts (and stays) `public`; the other three start `preview`
(allowlist-only) until the founder tests them, and eventually flip to
`subscription` mode when the per-product add-on is wired.

Resolution rule (mirrors the discussion in the last session):

    can_see(user, product):
      if user.role == "superadmin":         return True
      doc = product_launches[product]
      if doc.mode == "public":              return True
      if user.id in doc.allowlist_user_ids: return True
      if doc.mode == "subscription" and user_has_active_addon(...):
          return True   # Phase 2 hook — always False today
      return False

Home is NOT stored here. Whether the sidebar shows Home is derived
from `len(accessible_modules) >= 2`.
"""
from __future__ import annotations

from typing import Iterable, Optional

from db import db
from db import now_iso

# The four gate-able products. Order also drives sidebar-rail order.
PRODUCT_KEYS: tuple[str, ...] = ("crm", "projects", "team", "accounting")

# Default state a fresh install ships with. Accounting is `public` so
# every existing user retains access without needing an allowlist
# entry; the rest start `preview` (invisible until the superadmin
# allowlists a tester).
_DEFAULT_MODE: dict[str, str] = {
    "crm":        "preview",
    "projects":   "preview",
    "team":       "preview",
    "accounting": "public",
}


async def ensure_seeded() -> None:
    """Idempotent seed — called from the FastAPI lifespan hook. Adds
    any missing rows without touching existing ones so a superadmin's
    prior edits are preserved across restarts."""
    for pk in PRODUCT_KEYS:
        await db.product_launches.update_one(
            {"product_key": pk},
            {"$setOnInsert": {
                "product_key": pk,
                "mode": _DEFAULT_MODE[pk],
                "allowlist_user_ids": [],
                "created_at": now_iso(),
                "updated_at": now_iso(),
                "updated_by": None,
            }},
            upsert=True,
        )


async def get_all() -> list[dict]:
    """Every launch doc, sorted by our canonical rail order. Missing
    rows are auto-seeded on the fly (defensive — should never fire
    after `ensure_seeded()` at startup, but shields tests + fresh
    installs)."""
    rows = {r["product_key"]: r async for r in db.product_launches.find(
        {}, {"_id": 0}
    )}
    if len(rows) != len(PRODUCT_KEYS):
        await ensure_seeded()
        rows = {r["product_key"]: r async for r in db.product_launches.find(
            {}, {"_id": 0}
        )}
    return [rows[pk] for pk in PRODUCT_KEYS if pk in rows]


def _mode_for(doc: dict) -> str:
    return (doc or {}).get("mode") or "preview"


def _allowlist_for(doc: dict) -> list[str]:
    return list((doc or {}).get("allowlist_user_ids") or [])


async def accessible_modules(user: dict) -> list[str]:
    """Which of the four modules `user` can see. Superadmins → all.
    Order preserves `PRODUCT_KEYS`."""
    if (user or {}).get("role") == "superadmin":
        return list(PRODUCT_KEYS)
    docs = {d["product_key"]: d for d in await get_all()}
    uid = (user or {}).get("id")
    out: list[str] = []
    for pk in PRODUCT_KEYS:
        d = docs.get(pk) or {}
        if _mode_for(d) == "public":
            out.append(pk); continue
        if uid and uid in _allowlist_for(d):
            out.append(pk); continue
        # `subscription` mode falls through to False until Phase 2
        # wires the per-product add-on check.
    return out


async def user_access_summary(user: dict) -> dict:
    """Payload for the `me` response — modules the user can see plus
    the derived Home / landing hints so the frontend has zero
    additional round-trips to make routing decisions."""
    mods = await accessible_modules(user)
    show_home = len(mods) >= 2
    # Landing route — Accounting is the canonical anchor; fall back
    # to the first available module for the (rare) case where a
    # superadmin has flipped Accounting to preview + not allowlisted
    # this user. Home is never the landing target when < 2 modules.
    if "accounting" in mods:
        default_landing = "/dashboard"
    elif "crm" in mods:
        default_landing = "/crm"
    elif mods:
        # Projects → /accounting/projects; Team → /team
        default_landing = "/accounting/projects" if mods[0] == "projects" else f"/{mods[0]}"
    else:
        default_landing = "/dashboard"
    return {
        "enabled_products": mods,
        "show_home": show_home,
        "default_landing": ("/home" if show_home else default_landing),
    }


async def can_see_product(user: dict, product_key: str) -> bool:
    if product_key == "home":
        # Home is not gated directly; the "≥2 products" rule is enforced
        # at the sidebar/router level.
        return True
    return product_key in await accessible_modules(user)
