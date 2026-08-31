"""Notifications feed — cross-product bell (Feb 2026, Phase D-4).

Schema:
    notifications:
        id, company_id, user_id (recipient), kind, title, body,
        link (frontend route), read (bool), created_at, read_at,
        source: {kind, id}  # optional, dedup key

Kinds (extendable):
    - task_assigned      — someone assigned you a task
    - timesheet_approval — a report is pending your approval
    - stale_deal         — an open deal you own hasn't moved in N days
    - mention            — you were @mentioned in a note

Routes:
    GET  /api/notifications?unread_only=1&limit=20     — for-current-user
    POST /api/notifications/{id}/read
    POST /api/notifications/mark-all-read
    GET  /api/notifications/summary                     — counts by kind

We also expose a `notify()` helper other route modules import to
enqueue a notification. Stale-deal notifications are computed live
against the `deals` collection whenever the feed is fetched so we
don't need a background scheduler for the MVP.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_KINDS = {"task_assigned", "timesheet_approval",
           "stale_deal", "mention", "bill_due", "anomaly", "system"}


def _clean(doc: dict | None) -> dict | None:
    if doc: doc.pop("_id", None)
    return doc


async def notify(
    company_id: str, user_id: str, kind: str, title: str,
    body: str = "", link: str = "", source: Optional[dict] = None,
) -> None:
    """Insert a notification. Silent-fail on bad kind so callers
    can fire-and-forget."""
    if kind not in _KINDS: return
    if not user_id or not company_id: return
    # Dedup key: same source can only enqueue once per hour to
    # prevent spam from repeated triggers (e.g. someone editing a
    # task 5 times in a minute).
    if source and source.get("id"):
        recent_cutoff = (datetime.now(timezone.utc)
                          - timedelta(hours=1)).isoformat()
        dupe = await db.notifications.find_one({
            "company_id": company_id, "user_id": user_id,
            "kind": kind, "source.id": source["id"],
            "created_at": {"$gte": recent_cutoff},
        })
        if dupe: return
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()),
        "company_id": company_id, "user_id": user_id,
        "kind": kind, "title": title, "body": body, "link": link,
        "read": False, "created_at": now_iso(), "read_at": None,
        "source": source or None,
    })
    # Fan out to Web Push so the user's phone lights up too. Kept
    # fire-and-forget so a push failure never blocks the in-app row.
    try:
        from push import send_web_push
        await send_web_push(
            user_id, title=title, body=body or "",
            url=link or "/", category=kind,
            tag=(source or {}).get("id") if source else None,
        )
    except Exception:                                    # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception(
            "notify: push fanout failed for user=%s kind=%s", user_id, kind,
        )


async def _compute_stale_deals(cid: str, user_id: str,
                                stale_days: int = 14) -> list[dict]:
    """Live query — open deals owned by the user that haven't been
    updated in `stale_days`. Emitted as virtual notifications with a
    negative id prefix so mark-as-read is a no-op (they auto-refresh
    once the user updates the deal)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    rows = await db.deals.find({
        "company_id": cid,
        "owner_user_id": user_id,
        "stage": {"$in": ["lead", "qualified", "proposal", "negotiation"]},
        "updated_at": {"$lt": cutoff},
    }).sort([("updated_at", 1)]).to_list(50)
    out = []
    for d in rows:
        out.append({
            "id": f"stale-{d['id']}",
            "company_id": cid, "user_id": user_id,
            "kind": "stale_deal",
            "title": f"Deal “{d.get('title')}” has gone quiet",
            "body": f"{d.get('contact_name') or 'No contact'} · "
                     f"${float(d.get('value') or 0):,.0f} · "
                     f"no activity in {stale_days}+ days",
            "link": f"/crm/deals?product=crm&deal={d['id']}",
            "read": False,
            "created_at": d.get("updated_at") or now_iso(),
            "virtual": True,
        })
    return out


@router.get("/notifications")
async def list_notifications(
    unread_only: int = Query(0),
    limit: int = Query(30, le=200),
    user: dict = Depends(get_current_user),
) -> dict:
    """Aggregate notifications across every company the caller is
    a member of. Bell is user-scoped, not company-scoped, so a Pro
    who manages 8 books gets one unified feed."""
    memberships = await db.memberships.find({
        "user_id": user["id"]}).to_list(200)
    cids = [m["company_id"] for m in memberships]
    if not cids:
        return {"notifications": [], "unread_count": 0}

    q: dict = {"user_id": user["id"], "company_id": {"$in": cids}}
    if unread_only:
        q["read"] = False
    rows = await db.notifications.find(q).sort(
        [("created_at", -1)]).to_list(limit)

    # Live stale-deal notifications on top (one company at a time).
    virtual: list[dict] = []
    for cid in cids:
        virtual.extend(await _compute_stale_deals(cid, user["id"]))

    combined = [_clean(r) for r in rows] + virtual
    combined.sort(key=lambda n: n.get("created_at") or "", reverse=True)
    combined = combined[:limit]

    unread_count = await db.notifications.count_documents({
        "user_id": user["id"], "company_id": {"$in": cids},
        "read": False,
    })
    unread_count += len(virtual)
    return {"notifications": combined, "unread_count": unread_count}


@router.post("/notifications/{nid}/read")
async def mark_read(
    nid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    if nid.startswith("stale-"):
        # Virtual — auto-clears when the underlying deal is touched.
        return {"ok": True, "virtual": True}
    r = await db.notifications.update_one(
        {"id": nid, "user_id": user["id"]},
        {"$set": {"read": True, "read_at": now_iso()}})
    if r.matched_count == 0:
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.post("/notifications/mark-all-read")
async def mark_all_read(
    user: dict = Depends(get_current_user),
) -> dict:
    r = await db.notifications.update_many(
        {"user_id": user["id"], "read": False},
        {"$set": {"read": True, "read_at": now_iso()}})
    return {"ok": True, "count": r.modified_count}
