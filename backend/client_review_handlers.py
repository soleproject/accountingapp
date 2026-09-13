"""Per-item-type answer handlers for the batch client review flow.

Each of the 9 item types has a small handler that takes the client's
answer and applies it — closing the source finding, categorizing the
transaction, marking a W-9 as requested, etc. All handlers share a
common contract:

    async def handle(item: dict, batch: dict, *,
                     answer: str, payload: dict) -> dict

  * `item`     — the item dict from `batch.items`
  * `batch`    — the parent batch (for company_id / actor context)
  * `answer`   — the client's plain-language reply
  * `payload`  — structured data extracted by the AI (category id,
                 split percentages, uploaded doc id, etc.)

Handlers return `{"action_taken": "...", "detail": "..."}` — that
string is stamped onto the item and shown in the end-screen summary.

Deferral has a single generic handler regardless of type: mark the
item deferred, mark the source finding `status="dismissed"` with a
`client_deferred` tag, so the Today V2 "Judgment" section picks it up
with the `CLIENT DEFERRED` badge (Milestone F).
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from deps import db
import client_review as cr

logger = logging.getLogger("axiom.client_review.handlers")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _close_source_finding(item: dict, *, resolved_by: str) -> None:
    """Mark a source `agent_findings` row resolved. Idempotent — a
    finding already resolved by another actor stays resolved."""
    if item.get("source_collection") != "agent_findings":
        return
    await db.agent_findings.update_one(
        {"id": item["source_id"]},
        {"$set": {"status":       "resolved",
                  "resolved_at":  _now_iso(),
                  "resolved_by":  resolved_by,
                  "updated_at":   _now_iso()}},
    )


async def _defer_source_finding(item: dict, *, note: str | None = None) -> None:
    """Mark the source finding as `dismissed` with the `client_deferred`
    tag. The pro-side Today V2 picks these up in the Judgment section
    with a special badge (Milestone F).
    """
    if item.get("source_collection") != "agent_findings":
        return
    await db.agent_findings.update_one(
        {"id": item["source_id"]},
        {"$set": {
            "status":              "dismissed",
            "dismissed_at":        _now_iso(),
            "dismissed_by":        "client:deferred",
            "client_deferred":     True,
            "client_deferred_at":  _now_iso(),
            "client_deferred_note": note or "",
            "updated_at":          _now_iso(),
        }},
    )


# --------------------------------------------------------------------------
# Item 1 — uncategorized transaction
# --------------------------------------------------------------------------

async def _handle_uncategorized(item: dict, batch: dict, *,
                                answer: str, payload: dict) -> dict:
    """Client tells us what a transaction was for. If the AI mapped the
    answer to a concrete account_id, apply the category. Otherwise
    stash the answer as an `ai_comment` and keep `needs_review=True`
    for the pro to finalize.
    """
    txn_id = item["source_id"]
    account_id   = (payload or {}).get("account_id")
    account_name = (payload or {}).get("account_name")

    updates: dict = {
        "client_answer":       answer,
        "client_answered_at":  _now_iso(),
        "ai_comment":          f"[Client answered {_now_iso()[:10]}]: {answer}",
        "updated_at":          _now_iso(),
    }
    if account_id:
        updates.update({
            "category_account_id":   account_id,
            "category_account_name": account_name or "",
            "needs_review":          False,
            "human_reviewed":        True,
        })
    await db.transactions.update_one(
        {"id": txn_id, "company_id": batch["company_id"]}, {"$set": updates},
    )
    if account_id:
        return {"action_taken": "categorized",
                "detail": f"Categorized as {account_name or account_id}"}
    return {"action_taken": "annotated",
            "detail": "Saved your note — your bookkeeper will finalize"}


# --------------------------------------------------------------------------
# Items 2–8 — generic finding closer with a stored answer
# --------------------------------------------------------------------------

async def _handle_generic_finding(item: dict, batch: dict, *,
                                  answer: str, payload: dict) -> dict:
    """For most agent-findings-backed items, the workflow is: close the
    finding, stash the client's answer, and let the pro-side pick up
    any downstream action (creating a merchant rule, attaching a W-9
    PDF, etc.).

    Structured payload (`payload`) is stored on the finding's `meta`
    so the pro sees what was proposed alongside the raw answer.
    """
    await _close_source_finding(item, resolved_by="client:answered")
    if item.get("source_collection") == "agent_findings":
        await db.agent_findings.update_one(
            {"id": item["source_id"]},
            {"$set": {
                "client_answer":       answer,
                "client_answered_at":  _now_iso(),
                "meta.client_payload": payload or {},
            }},
        )
    return {"action_taken": "answered",
            "detail": (answer[:120] + "…") if len(answer) > 120 else answer}


# --------------------------------------------------------------------------
# Item 4 — W-9 collection
# --------------------------------------------------------------------------

async def _handle_w9_needed(item: dict, batch: dict, *,
                            answer: str, payload: dict) -> dict:
    """Three sub-flows:
      * `follow_up`: client asked us to reach out to the vendor — flag
        the contact for the Milestone G outbound flow, keep the
        finding open so the CPA sees the state.
      * `attached`: W-9 PDF was uploaded — stamp `w9_on_file=True`
        on the contact and close the finding.
      * `provided_fields`: client typed the vendor's info inline — same
        as `attached` (stamp + close).
    """
    payload   = payload or {}
    flow      = payload.get("flow")
    contact_id = ((item.get("context") or {}).get("meta") or {}).get("contact_id") \
                 or payload.get("contact_id")
    if not contact_id:
        # Fallback: look up on the source finding
        f = await db.agent_findings.find_one({"id": item["source_id"]})
        if f:
            contact_id = f.get("contact_id")

    if flow == "follow_up" and contact_id:
        await db.contacts.update_one(
            {"id": contact_id, "company_id": batch["company_id"]},
            {"$set": {
                "w9_follow_up_requested":    True,
                "w9_follow_up_requested_at": _now_iso(),
                "w9_follow_up_note":         answer,
                "updated_at":                _now_iso(),
            }},
        )
        # Do NOT close the finding — the pending state is visible until
        # the outbound follow-up completes (built in Milestone G).
        if item.get("source_collection") == "agent_findings":
            await db.agent_findings.update_one(
                {"id": item["source_id"]},
                {"$set": {
                    "meta.follow_up_requested": True,
                    "meta.follow_up_note":      answer,
                    "client_answer":            answer,
                    "client_answered_at":       _now_iso(),
                }},
            )
        return {"action_taken": "follow_up_requested",
                "detail": "We'll reach out to the vendor directly"}

    # W-9 attached OR provided inline → mark on file, close finding.
    if contact_id:
        await db.contacts.update_one(
            {"id": contact_id, "company_id": batch["company_id"]},
            {"$set": {"w9_on_file":  True,
                      "w9_added_at": _now_iso(),
                      "updated_at":  _now_iso()}},
        )
    return await _handle_generic_finding(item, batch, answer=answer,
                                         payload=payload)


# --------------------------------------------------------------------------
# Router
# --------------------------------------------------------------------------

_HANDLERS = {
    cr.ITEM_UNCATEGORIZED:      _handle_uncategorized,
    cr.ITEM_VENDOR_MEMO:        _handle_generic_finding,
    cr.ITEM_MISSING_RECEIPT:    _handle_generic_finding,
    cr.ITEM_W9_NEEDED:          _handle_w9_needed,
    cr.ITEM_AMBIGUOUS_TRANSFER: _handle_generic_finding,
    cr.ITEM_RECURRING:          _handle_generic_finding,
    cr.ITEM_SETUP:              _handle_generic_finding,
    cr.ITEM_SPLIT:              _handle_generic_finding,
    cr.ITEM_LIABILITY_SPLIT:    _handle_generic_finding,
}


async def apply_answer(item: dict, batch: dict, *,
                       answer: str, payload: dict | None = None) -> dict:
    """Route to the right handler by item type. Callers get back the
    same `{action_taken, detail}` shape regardless of item type.
    """
    handler = _HANDLERS.get(item.get("item_type"))
    if not handler:
        return {"action_taken": "noop",
                "detail": f"No handler for item_type={item.get('item_type')!r}"}
    return await handler(item, batch, answer=answer, payload=payload or {})


async def apply_deferral(item: dict, batch: dict, *,
                         note: str | None = None) -> dict:
    """Client hit 'not sure — send to my bookkeeper'. Same for every
    item type: close the source with `client_deferred` so it surfaces
    in Today V2 (Milestone F), stamp the item.
    """
    if item.get("source_collection") == "transactions":
        # Item 1 — uncategorized transaction. Leave `needs_review=True`
        # so the pro's queue keeps it; add a comment so context isn't
        # lost.
        await db.transactions.update_one(
            {"id": item["source_id"], "company_id": batch["company_id"]},
            {"$set": {
                "client_deferred":     True,
                "client_deferred_at":  _now_iso(),
                "client_deferred_note": note or "",
                "ai_comment":          "[Client deferred — needs bookkeeper]",
                "updated_at":          _now_iso(),
            }},
        )
    else:
        await _defer_source_finding(item, note=note)
    return {"action_taken": "deferred",
            "detail": "Sent to your bookkeeper for a closer look"}


__all__ = ["apply_answer", "apply_deferral"]
