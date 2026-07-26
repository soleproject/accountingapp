"""Pro-side alert inbox.

Small, purpose-built notification stream that a Pro (or Enterprise Owner)
can pull to see time-sensitive things happening to their portfolio —
right now: client payment failures. Designed to be trivially extensible
(add a new ``kind`` string + a new emitter, done).

Stored in the ``pro_alerts`` MongoDB collection:

  {
    id: uuid4(),
    pro_user_id: <user.id>,      # who this alert is FOR
    kind: "payment_failed",
    company_id: <cid>,           # optional context
    message: "Skyward Sparks — $38 declined",
    unread: true,
    created_at: iso8601,
    meta: {...},                 # anything the UI wants (amount, invoice id, etc.)
  }
"""
from __future__ import annotations

import uuid
from typing import Optional

from db import db, now_iso


async def emit_alert(
    *,
    pro_user_id: str,
    kind: str,
    message: str,
    company_id: Optional[str] = None,
    meta: Optional[dict] = None,
) -> str:
    """Insert a fresh alert row and return its id.

    Idempotency is intentionally NOT enforced at this layer — callers
    that want dedupe pass a stable ``meta.stripe_invoice_id`` and check
    for an existing unread row before calling. For MVP we accept the
    (rare) duplicate over lost visibility.
    """
    doc = {
        "id": str(uuid.uuid4()),
        "pro_user_id": pro_user_id,
        "kind": kind,
        "message": message,
        "company_id": company_id,
        "unread": True,
        "created_at": now_iso(),
        "meta": meta or {},
    }
    await db.pro_alerts.insert_one(doc)
    return doc["id"]


async def list_alerts(pro_user_id: str, *, limit: int = 50) -> list[dict]:
    cursor = (
        db.pro_alerts.find({"pro_user_id": pro_user_id})
        .sort("created_at", -1)
        .limit(limit)
    )
    out = []
    async for a in cursor:
        a.pop("_id", None)
        out.append(a)
    return out


async def unread_count(pro_user_id: str) -> int:
    return await db.pro_alerts.count_documents(
        {"pro_user_id": pro_user_id, "unread": True}
    )


async def mark_read(alert_id: str, pro_user_id: str) -> bool:
    r = await db.pro_alerts.update_one(
        {"id": alert_id, "pro_user_id": pro_user_id},
        {"$set": {"unread": False, "read_at": now_iso()}},
    )
    return r.modified_count > 0


async def mark_all_read(pro_user_id: str) -> int:
    r = await db.pro_alerts.update_many(
        {"pro_user_id": pro_user_id, "unread": True},
        {"$set": {"unread": False, "read_at": now_iso()}},
    )
    return r.modified_count
