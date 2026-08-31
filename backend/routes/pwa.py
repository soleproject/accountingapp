"""PWA endpoints (Feb 2026, Phase 1).

Serves the web-app manifest (per-tenant branded), the VAPID public
key, the push-subscription lifecycle, and a dynamic branded icon
generator. Everything under `/api/pwa/*` + `/api/manifest.json`.

The manifest endpoint reads the incoming `Host` header, resolves
partner branding (via the existing `/branding/by-host` cascade), and
returns a manifest whose `name`, `short_name`, `theme_color`, and
`icons` reflect that partner. A user visiting from
`axiom.smartbookssoftware.ai` on their phone taps "Install" and
gets an Axiom-branded PWA. Same user on `cypherpro.smartbookssoftware.ai`
gets CypherPro. One codebase, unlimited installable brands.
"""
from __future__ import annotations

import io
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from push import (
    save_subscription, send_web_push,
    VAPID_PUBLIC_KEY,
)

try:
    from PIL import Image, ImageDraw, ImageFont
    _PIL_OK = True
except Exception:                                    # noqa: BLE001
    _PIL_OK = False


router = APIRouter(prefix="/api")


# --- Theme preset colors (mirrors frontend theme_preset cascade). --------
_THEME_PRESETS = {
    "default":  {"primary": "#0891b2", "bg": "#0f172a"},   # cyan / slate
    "midnight": {"primary": "#6366f1", "bg": "#020617"},   # indigo / near-black
    "forest":   {"primary": "#059669", "bg": "#022c22"},   # emerald / deep-forest
    "violet":   {"primary": "#8b5cf6", "bg": "#1e1b4b"},   # violet / indigo-950
}


async def _brand_for_host(host: str) -> dict:
    """Resolve the tenant brand for a given host. Falls back to
    platform (SmartBooks) if nothing matches. Same cascade as
    `pro.branding_by_host` — kept in sync manually to avoid a
    circular import at module load."""
    try:
        from subdomain_util import (PRIMARY_HOST, PRIVATE_LABEL_ROOT,
                                     subdomain_from_host)
    except Exception:                                    # noqa: BLE001
        PRIMARY_HOST = ""
        PRIVATE_LABEL_ROOT = ""
        def subdomain_from_host(_): return None
    h = (host or "").split(":", 1)[0].strip().lower()
    label = subdomain_from_host(h)
    if label:
        owner = await db.users.find_one({"branding.signin_subdomain": label})
        if owner:
            b = owner.get("branding") or {}
            preset = b.get("theme_preset") or "default"
            custom = b.get("theme_custom") or {}
            preset_colors = _THEME_PRESETS.get(preset, _THEME_PRESETS["default"])
            return {
                "name": b.get("firm_name") or owner.get("name") or label.title(),
                "short_name": (b.get("firm_name") or label.title())[:12],
                "theme_color": custom.get("primary") or preset_colors["primary"],
                "background_color": custom.get("sidebar_bg") or preset_colors["bg"],
                "logo_data_url": (b.get("logos") or {}).get("logo_light") if isinstance(b.get("logos"), dict) else None,
                "brand_key": label,
                "initial": (b.get("firm_name") or label)[:1].upper(),
            }
    # Platform default (SmartBooks / CypherPro house brand).
    return {
        "name": "SmartBooks",
        "short_name": "SmartBooks",
        "theme_color": "#0891b2",
        "background_color": "#0f172a",
        "logo_data_url": None,
        "brand_key": "platform",
        "initial": "S",
    }


@router.get("/manifest.json")
async def manifest_json(request: Request):
    """Dynamic Web App Manifest. Read by browsers when the
    `<link rel="manifest">` tag is followed. Content varies per host
    so each white-label partner gets their own installable app.
    Icon URLs are RELATIVE so browsers resolve them against the
    origin the manifest was fetched from — this side-steps any
    internal/external hostname mismatch behind a Kubernetes ingress."""
    host = request.headers.get("host", "")
    brand = await _brand_for_host(host)

    manifest = {
        "name": brand["name"],
        "short_name": brand["short_name"],
        "description": f"{brand['name']} — books that think for you.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "portrait-primary",
        "background_color": brand["background_color"],
        "theme_color": brand["theme_color"],
        # Icons served through the dynamic branded-icon endpoint so
        # each partner's install shows their brand on the home screen.
        # Relative URLs so the browser resolves against the same
        # origin it fetched the manifest from.
        "icons": [
            {"src": "/api/pwa/icon.png?size=192",
             "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/api/pwa/icon.png?size=512",
             "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/api/pwa/icon.png?size=512&maskable=1",
             "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "categories": ["business", "finance", "productivity"],
        "shortcuts": [
            {"name": "Home", "url": "/home",
             "icons": [{"src": "/api/pwa/icon.png?size=192",
                         "sizes": "192x192"}]},
            {"name": "Transactions", "url": "/accounting/transactions",
             "icons": [{"src": "/api/pwa/icon.png?size=192",
                         "sizes": "192x192"}]},
            {"name": "Print Checks", "url": "/accounting/checks",
             "icons": [{"src": "/api/pwa/icon.png?size=192",
                         "sizes": "192x192"}]},
        ],
    }
    return JSONResponse(manifest, headers={
        "Cache-Control": "public, max-age=300",       # 5-min edge cache
        "Content-Type": "application/manifest+json",
    })


@router.get("/pwa/icon.png")
async def pwa_icon(request: Request, size: int = 192, maskable: int = 0):
    """Serve a per-tenant PWA icon. Prefers the partner's uploaded
    `logo_light` data-URL when available; otherwise falls back to a
    generated colored square with the brand's initial — same trick
    Slack and Notion use for orgs without a custom icon."""
    host = request.headers.get("host", "")
    brand = await _brand_for_host(host)
    size = max(48, min(1024, int(size)))

    # If the partner uploaded a real logo AND it's a data-URL PNG we
    # can decode, we composite that onto the brand background at the
    # requested size. Otherwise → initial-tile fallback.
    if _PIL_OK:
        img = _render_icon(brand, size, bool(maskable))
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return Response(
            content=buf.getvalue(),
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    # Very last-ditch — 1x1 transparent PNG so the browser install
    # dialog doesn't 404.
    tiny = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00"
            b"\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00"
            b"\x00\rIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
            b"\x00\x00\x00\x00IEND\xaeB`\x82")
    return Response(content=tiny, media_type="image/png")


def _render_icon(brand: dict, size: int, maskable: bool):
    """Generate a solid-tile icon with the brand's initial centered.
    For maskable icons we shrink the safe-zone to the inner 80% so
    Android's rounded/squircle masks don't clip the letter."""
    from PIL import Image, ImageDraw, ImageFont
    bg = brand.get("theme_color") or "#0891b2"
    initial = (brand.get("initial") or "S").upper()

    img = Image.new("RGB", (size, size), _hex_to_rgb(bg))
    draw = ImageDraw.Draw(img)

    # Pick the largest font size that fits within the safe zone.
    safe = size * (0.6 if maskable else 0.8)
    font_size = int(safe)
    font = None
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ):
        if os.path.exists(candidate):
            font = ImageFont.truetype(candidate, font_size)
            break
    if font is None:
        font = ImageFont.load_default()
    # Center the glyph using the actual metric-based bbox.
    try:
        bbox = draw.textbbox((0, 0), initial, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        cx = (size - tw) / 2 - bbox[0]
        cy = (size - th) / 2 - bbox[1]
    except Exception:                                    # noqa: BLE001
        cx, cy = size / 4, size / 4
    draw.text((cx, cy), initial, fill="white", font=font)
    return img


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = (h or "#000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:                                    # noqa: BLE001
        return (8, 145, 178)                              # cyan-600 fallback


# --- Push subscribe / unsubscribe / preferences. -------------------------

class SubscribeIn(BaseModel):
    endpoint: str
    p256dh: str
    auth: str
    user_agent: Optional[str] = ""


class UnsubscribeIn(BaseModel):
    endpoint: str


class PreferencesIn(BaseModel):
    categories: dict


@router.get("/pwa/vapid-public-key")
async def get_vapid_public_key():
    """Public half of the VAPID key-pair — frontend uses this when
    calling `pushManager.subscribe()`. Safe to serve unauthenticated;
    the private half never leaves the backend."""
    return {"public_key": VAPID_PUBLIC_KEY}


@router.post("/pwa/subscribe")
async def subscribe(inp: SubscribeIn, user: dict = Depends(get_current_user)):
    """Store a browser's push endpoint so the backend can push to it
    later. Idempotent — same (user, endpoint) upserts."""
    if not inp.endpoint or not inp.p256dh or not inp.auth:
        raise HTTPException(400, "Missing endpoint or keys")
    sid = await save_subscription(
        user["id"], inp.endpoint, inp.p256dh, inp.auth,
        inp.user_agent or "",
    )
    return {"ok": True, "id": sid}


@router.post("/pwa/unsubscribe")
async def unsubscribe(inp: UnsubscribeIn, user: dict = Depends(get_current_user)):
    r = await db.push_subscriptions.delete_many(
        {"user_id": user["id"], "endpoint": inp.endpoint},
    )
    return {"ok": True, "removed": r.deleted_count}


@router.get("/pwa/preferences")
async def get_preferences(user: dict = Depends(get_current_user)):
    """Category-level push mutes. Missing keys default enabled so a
    fresh account gets every category on first install (matches
    Slack / Linear default)."""
    prefs = await db.push_preferences.find_one({"user_id": user["id"]})
    cats = (prefs or {}).get("categories") or {}
    return {
        "categories": {
            "task_assigned": cats.get("task_assigned", True),
            "mention": cats.get("mention", True),
            "bill_due": cats.get("bill_due", True),
            "anomaly": cats.get("anomaly", True),
            "timesheet_approval": cats.get("timesheet_approval", True),
            "stale_deal": cats.get("stale_deal", True),
            "system": cats.get("system", True),
        },
        # Device count so the UI can show "You have 2 devices installed".
        "device_count": await db.push_subscriptions.count_documents(
            {"user_id": user["id"]}
        ),
    }


@router.patch("/pwa/preferences")
async def patch_preferences(inp: PreferencesIn,
                             user: dict = Depends(get_current_user)):
    """Merge, not replace — user toggles one category, others stay
    at their existing state."""
    allowed = {"task_assigned", "mention", "bill_due", "anomaly",
                "timesheet_approval", "stale_deal", "system"}
    updates = {}
    for k, v in (inp.categories or {}).items():
        if k in allowed:
            updates[f"categories.{k}"] = bool(v)
    if not updates:
        return {"ok": True}
    updates["updated_at"] = now_iso()
    await db.push_preferences.update_one(
        {"user_id": user["id"]},
        {"$set": updates, "$setOnInsert": {"user_id": user["id"]}},
        upsert=True,
    )
    return {"ok": True}


@router.post("/pwa/test")
async def send_test(user: dict = Depends(get_current_user)):
    """Fires a canned notification to every device the user has
    installed. Used by the notification-settings page to prove the
    plumbing works end-to-end."""
    delivered = await send_web_push(
        user["id"],
        title="🔔 Test notification",
        body="If you can see this, push is working on this device.",
        url="/settings",
        category="system",
    )
    return {"ok": True, "delivered": delivered}
