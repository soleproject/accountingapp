"""Communications — auditable transcript archive of every client↔firm
interaction the platform generated.

MVP scope (Sep 2026):
  * Backed by the existing `client_review_batches` collection — no new
    source-of-truth store. Each batch is a "thread"; the batch's items
    are the sub-conversations inside it.
  * List endpoint returns threads scoped to the caller — pros see all
    threads on companies they're members of; single-book owners see
    only threads for their own company.
  * Detail endpoint returns the full batch (with items, attachments,
    messages, client_messages) for the read-only playback view. Same
    tenant guard.

Not to be confused with the pre-existing `routes/communications.py`
which is the email-preferences / audit-log surface for outbound
transactional mail. Different concern — this one is the *inbox* of
past reviews, that one is *plumbing* for outbound email.

Follow-ups (not in MVP):
  * Fold Ask-Client threads under the same union view.
  * `communication_threads` denormalized index for cross-firm search.
  * Per-user unread state.
"""
from __future__ import annotations
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query

from deps import db, company_ids_for_user
from auth import get_current_user

router = APIRouter(prefix="/api/comms", tags=["communications-threads"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _thread_row(batch: dict, company_name: str) -> dict:
    """Shape a batch into a thread-row dict for the list view."""
    items = batch.get("items") or []
    total = len(items)
    answered = sum(1 for i in items if i.get("answered_at"))
    deferred = sum(1 for i in items if i.get("deferred"))
    unresolved = total - answered - deferred
    # Snippet — last user or assistant line across all items, so the
    # list preview shows recent activity instead of just the seed
    # prompt.
    snippet = ""
    latest_at = batch.get("updated_at") or batch.get("created_at") or ""
    for it in items:
        for m in (it.get("client_messages") or []) + (it.get("messages") or []):
            content = (m.get("content") or "").strip()
            if content and not content.startswith("📎"):
                snippet = content[:160]
    status = batch.get("status") or "open"
    if status == "open" and answered + deferred == total and total:
        status = "completed"
    return {
        "thread_id":       batch["id"],
        "kind":            "batch_review",
        "company_id":      batch.get("company_id"),
        "company_name":    company_name,
        "subject":         f"Batch review · {total} question{'s' if total != 1 else ''}",
        "client_email":    batch.get("client_email"),
        "status":          status,
        "total_items":     total,
        "answered_count":  answered,
        "deferred_count":  deferred,
        "unresolved_count": unresolved,
        "created_at":      batch.get("created_at"),
        "updated_at":      latest_at,
        "completed_at":    batch.get("completed_at"),
        "expires_at":      batch.get("expires_at"),
        "client_token":    batch.get("client_token"),
        "snippet":         snippet,
    }


@router.get("/threads")
async def list_threads(
    company_id: str | None = Query(default=None),
    status:     str | None = Query(default=None,
                                     description="open | completed | expired | any"),
    limit:      int  = Query(default=50, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    """List communication threads visible to the caller.

    * `company_id` optional — when provided, filters to just that
      company (still guarded by membership).
    * `status` optional — `open` (still awaiting client), `completed`
      (every item resolved), `expired`, or `any` (default: any).
    """
    allowed_cids = await company_ids_for_user(user)
    if not allowed_cids:
        return {"threads": []}
    if company_id:
        if company_id not in allowed_cids:
            raise HTTPException(403, "No access to this company")
        cids = [company_id]
    else:
        cids = allowed_cids

    q: dict = {"company_id": {"$in": cids}}
    if status and status != "any":
        q["status"] = status
    cursor = db.client_review_batches.find(q).sort("updated_at", -1).limit(limit)
    batches = await cursor.to_list(limit)

    comps = await db.companies.find(
        {"id": {"$in": list({b.get("company_id") for b in batches})}},
        {"id": 1, "name": 1},
    ).to_list(200)
    name_by_id = {c["id"]: c.get("name") or "Untitled Company" for c in comps}

    return {
        "threads": [_thread_row(b, name_by_id.get(b.get("company_id"), ""))
                    for b in batches],
    }


@router.get("/threads/{thread_id}")
async def get_thread(thread_id: str, user: dict = Depends(get_current_user)):
    """Full read-only detail for a thread — shape mirrors the client
    magic-link session so the frontend can render the same components
    in playback mode."""
    batch = await db.client_review_batches.find_one({"id": thread_id})
    if not batch:
        raise HTTPException(404, "Thread not found")
    allowed_cids = await company_ids_for_user(user)
    if batch.get("company_id") not in allowed_cids:
        raise HTTPException(403, "No access to this thread")
    company = await db.companies.find_one(
        {"id": batch["company_id"]}, {"name": 1},
    ) or {}
    return {
        "batch_id":         batch["id"],
        "status":           batch.get("status"),
        "items":            batch.get("items") or [],
        "answer_count":     batch.get("answer_count", 0),
        "defer_count":      batch.get("defer_count", 0),
        "scheduled_for":    batch.get("scheduled_for"),
        "expires_at":       batch.get("expires_at"),
        "completed_at":     batch.get("completed_at"),
        "created_at":       batch.get("created_at"),
        "updated_at":       batch.get("updated_at"),
        "client_email":     batch.get("client_email"),
        "client_token":     batch.get("client_token"),
        "company_id":       batch.get("company_id"),
        "company_name":     company.get("name") or "",
        "readonly":         True,
    }
