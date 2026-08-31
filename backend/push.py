"""Axiom / SmartBooks — Web Push helper (Feb 2026, PWA Phase 1).

Sends encrypted push messages to users who have installed the PWA
and granted notification permission. Uses the browser-standard Web
Push protocol via `pywebpush`, so no third-party (FCM / OneSignal)
service is in the loop — VAPID keys live in `.env` and every push
goes straight to Apple / Google / Mozilla's public push service.

Design:
  * `db.push_subscriptions` stores one row per (user_id, endpoint).
    Same user on 3 devices → 3 rows.
  * `db.push_preferences` stores per-user category mutes:
      { user_id, categories: {task_assigned: bool, ...} }
    Missing row / missing key defaults to enabled — least-surprise
    for a Phase-1 opt-in flow (user already had to grant OS permission
    to receive anything at all).
  * `send_web_push(...)` is fire-and-forget from callers — a stale
    subscription that returns 404/410 is silently pruned so the
    ledger stays clean without callers caring.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from db import db, now_iso
from pywebpush import webpush, WebPushException

log = logging.getLogger(__name__)

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_CLAIMS_SUBJECT = os.environ.get("VAPID_CLAIMS_SUBJECT", "mailto:hello@example.com")


def _vapid_claims() -> dict:
    return {"sub": VAPID_CLAIMS_SUBJECT}


async def user_has_muted(user_id: str, category: str) -> bool:
    """Category-level mute check — used by both `send_web_push` (skip
    the network hop) and the frontend preferences page. Missing
    document → all categories enabled."""
    prefs = await db.push_preferences.find_one({"user_id": user_id})
    cats = (prefs or {}).get("categories") or {}
    return cats.get(category) is False


async def send_web_push(user_id: str, *, title: str, body: str,
                        url: str = "/", category: str = "system",
                        icon: Optional[str] = None,
                        tag: Optional[str] = None) -> int:
    """Push a notification to every registered device for `user_id`.

    Returns the number of subscriptions successfully delivered to.
    Silently prunes 404/410 endpoints (user uninstalled the PWA or
    revoked permission) so the store stays honest.

    Callers should invoke this alongside their existing DB-side
    `notify()` call — the two are complementary: `notify()` puts a
    row in the in-app bell dropdown, `send_web_push()` lights up the
    phone. Both check the same category mute list so a user can turn
    off phone alerts without losing the in-app history."""
    if not VAPID_PRIVATE_KEY:
        return 0
    if await user_has_muted(user_id, category):
        return 0

    subs = await db.push_subscriptions.find(
        {"user_id": user_id}
    ).to_list(20)
    if not subs:
        return 0

    payload_dict = {
        "title": title,
        "body": body[:200] if body else "",
        "url": url or "/",
        "category": category,
    }
    if icon:
        payload_dict["icon"] = icon
    if tag:
        payload_dict["tag"] = tag         # coalesces multiple pushes into one
    payload = json.dumps(payload_dict)

    delivered = 0
    stale_endpoints: list[str] = []
    for sub in subs:
        subscription_info = {
            "endpoint": sub.get("endpoint"),
            "keys": sub.get("keys") or {},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=_vapid_claims(),
                ttl=60 * 60 * 24,          # 24h server hold
            )
            delivered += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            # 404 (gone) / 410 (gone) — endpoint dead, prune.
            if status in (404, 410):
                stale_endpoints.append(sub["endpoint"])
                log.info("push: pruning stale endpoint for user=%s", user_id)
            else:
                log.warning("push: user=%s status=%s err=%s",
                             user_id, status, e)
        except Exception as e:                       # noqa: BLE001
            log.exception("push: unexpected error for user=%s: %s", user_id, e)

    if stale_endpoints:
        await db.push_subscriptions.delete_many(
            {"user_id": user_id, "endpoint": {"$in": stale_endpoints}}
        )
    return delivered


async def save_subscription(user_id: str, endpoint: str,
                             p256dh: str, auth: str,
                             user_agent: str = "") -> str:
    """Idempotent — same (user, endpoint) upserts; each device shows
    up as one row. `user_agent` stored for the eventual "manage
    devices" UI."""
    existing = await db.push_subscriptions.find_one(
        {"user_id": user_id, "endpoint": endpoint}
    )
    if existing:
        await db.push_subscriptions.update_one(
            {"_id": existing["_id"]},
            {"$set": {"keys": {"p256dh": p256dh, "auth": auth},
                      "user_agent": user_agent,
                      "updated_at": now_iso()}},
        )
        return existing["id"]
    import uuid
    sub_id = str(uuid.uuid4())
    await db.push_subscriptions.insert_one({
        "id": sub_id,
        "user_id": user_id,
        "endpoint": endpoint,
        "keys": {"p256dh": p256dh, "auth": auth},
        "user_agent": user_agent,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    })
    return sub_id
