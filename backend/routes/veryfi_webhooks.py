"""Veryfi webhook receiver — async bank-statement splitter callback.

Veryfi's ``bank-statements-set`` endpoint (used for multi-statement PDF
uploads) processes asynchronously and calls back here when the split
finishes. Payload shape (per Veryfi docs):

    { "event": "bank_statement_set.created",
      "data":  { "parent_id": 42000,
                 "id":        [690001, 690003, 690004],
                 "created":   "2026-08-20 20:15:05" } }

    Failure:
    { "event": "bank_statement_set.failed",
      "data":  { "parent_id": 42000, "id": [], "created": "..." } }

This route:
  1. Verifies the ``x-veryfi-signature`` HMAC.
  2. Finds the parent :class:`statement_imports` row by
     ``veryfi_document_set_id == data.parent_id``.
  3. For each child ``document_id``, GETs the parsed statement JSON
     from Veryfi and runs it through the shared
     :func:`statements._process_veryfi_result` pipeline.
  4. Flips the parent row status to ``completed`` / ``partial`` /
     ``failed`` based on child outcomes.

Public route (no auth) — signature verification is the auth mechanism.
"""
from __future__ import annotations
import os
import uuid
import logging
import asyncio
from typing import Any

from fastapi import APIRouter, Request, HTTPException, Header

from db import db, now_iso
import veryfi_service
from ai_service import categorize_transaction
from deps import is_period_closed


router = APIRouter(prefix="/api")
log = logging.getLogger(__name__)


# --- Webhook URL validation probes ---------------------------------------
# Veryfi (and most webhook platforms) validate a webhook URL by hitting it
# with an unauthenticated GET or HEAD before letting the user save it. If
# we only accept POST, the probe gets 405 → the dashboard shows "URL is
# invalid or unreachable" and the user can't register their webhook.
# Returning a plain 200 satisfies the reachability check without exposing
# anything sensitive.

@router.get("/webhooks/veryfi/bank-statement-set")
@router.head("/webhooks/veryfi/bank-statement-set")
async def bank_statement_set_probe() -> dict:
    """Reachability probe used by the Veryfi dashboard when the user saves
    a new webhook URL. Not called at runtime by Veryfi's async pipeline —
    that hits the POST handler below with a signed body.
    """
    return {"ok": True, "service": "axiom-veryfi-webhook"}


@router.post("/webhooks/veryfi/bank-statement-set")
async def bank_statement_set(
    request: Request,
    x_veryfi_signature: str | None = Header(None, alias="x-veryfi-signature"),
) -> dict:
    """Receive Veryfi's async ``bank_statement_set.created`` webhook.

    Signature verification uses HMAC-SHA256 of ``str(data)`` keyed by
    ``VERYFI_CLIENT_SECRET`` (base64). In dev environments where the
    secret isn't wired we accept when ``VERYFI_WEBHOOK_INSECURE=1``
    to unblock local testing without ever accepting unsigned prod
    traffic silently.
    """
    body = await request.body()
    # Empty body → treat as a validation probe (some webhook platforms
    # POST an empty body during URL registration). Return 200 so the
    # dashboard save succeeds without exposing anything.
    if not body:
        return {"ok": True, "probe": "empty_post"}
    try:
        import json
        payload = json.loads(body)
    except Exception:
        raise HTTPException(400, "webhook body must be JSON")
    if not isinstance(payload, dict):
        raise HTTPException(400, "webhook body must be JSON object")
    event = payload.get("event") or ""
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise HTTPException(400, "webhook body.data must be object")

    # ---- Signature verification ----
    insecure_ok = os.environ.get("VERYFI_WEBHOOK_INSECURE") == "1"
    ok = veryfi_service.verify_webhook_signature(data, x_veryfi_signature or "")
    if not ok and not insecure_ok:
        log.warning(
            "Veryfi webhook rejected: bad signature (event=%s parent_id=%s)",
            event, data.get("parent_id"),
        )
        raise HTTPException(401, "invalid webhook signature")

    parent_doc_set_id = data.get("parent_id")
    child_ids = data.get("id") or []
    if parent_doc_set_id is None:
        raise HTTPException(400, "missing data.parent_id")

    parent = await db.statement_imports.find_one(
        {"veryfi_document_set_id": parent_doc_set_id},
    )
    if not parent:
        # Common in dev when webhook fires from a different environment
        # than the one that initiated the upload. Log + 200 so Veryfi
        # doesn't retry indefinitely.
        log.info(
            "Veryfi webhook: no parent import for document_set_id=%s (event=%s)",
            parent_doc_set_id, event,
        )
        return {"ok": True, "matched_parent": False}

    if event == "bank_statement_set.failed":
        await db.statement_imports.update_one(
            {"id": parent["id"]},
            {"$set": {"status": "failed",
                      "error": "Veryfi splitter failed",
                      "updated_at": now_iso()}},
        )
        return {"ok": True, "matched_parent": True, "status": "failed"}

    if event != "bank_statement_set.created":
        return {"ok": True, "ignored_event": event}

    # Kick off the per-child processing in the background so the webhook
    # returns fast (Veryfi retries if we take >30s). Errors are stashed
    # on the parent row via `_process_children`.
    asyncio.create_task(_process_children(parent, child_ids))

    await db.statement_imports.update_one(
        {"id": parent["id"]},
        {"$set": {"child_document_ids": list(child_ids),
                  "updated_at": now_iso()}},
    )
    return {
        "ok": True,
        "matched_parent": True,
        "children_queued": len(child_ids),
    }


async def _process_children(parent: dict, child_document_ids: list[int]) -> None:
    """Fetch + finalize each split child. Runs off the request thread."""
    import statements  # local import — avoids server startup circular
    cid = parent["company_id"]
    parent_id = parent["id"]
    account_kind_hint = parent.get("account_kind_hint")
    child_import_ids: list[str] = []
    successes = 0
    failures = 0

    for doc_id in child_document_ids:
        child_import_id = str(uuid.uuid4())
        try:
            veryfi_data = await veryfi_service.fetch_bank_statement(doc_id)
        except Exception as e:  # noqa: BLE001
            log.warning(
                "Veryfi split child fetch failed doc_id=%s parent=%s: %s",
                doc_id, parent_id, e,
            )
            failures += 1
            continue

        # Create the child row up front in "processing" state so it
        # appears in the imports table immediately.
        now = now_iso()
        await db.statement_imports.insert_one({
            "id": child_import_id,
            "company_id": cid,
            "parent_import_id": parent_id,
            "filename": f"{parent.get('filename', 'statement.pdf')} [split #{child_document_ids.index(doc_id) + 1}]",
            "size": None,
            "method": "veryfi_split_child",
            "status": "processing",
            "transaction_count": None,
            "period_start": None,
            "period_end": None,
            "account_id": None,
            "account_name": None,
            "veryfi_document_id": str(doc_id),
            "created_at": now,
            "updated_at": now,
        })
        child_import_ids.append(child_import_id)

        try:
            await statements._process_veryfi_result(
                cid, child_import_id, veryfi_data,
                account_id=None,
                categorize_fn=categorize_transaction,
                is_period_closed_fn=is_period_closed,
                account_kind_hint=account_kind_hint,
            )
            successes += 1
        except Exception as e:  # noqa: BLE001
            log.exception(
                "Veryfi split child pipeline failed import=%s doc_id=%s: %s",
                child_import_id, doc_id, e,
            )
            failures += 1
            await db.statement_imports.update_one(
                {"id": child_import_id},
                {"$set": {"status": "failed",
                          "error": f"pipeline: {e}",
                          "updated_at": now_iso()}},
            )

    # Roll parent status up.
    if failures == 0 and successes > 0:
        final_status = "completed"
    elif successes == 0:
        final_status = "failed"
    else:
        final_status = "partial"
    await db.statement_imports.update_one(
        {"id": parent_id},
        {"$set": {
            "status": final_status,
            "child_import_ids": child_import_ids,
            "transaction_count": successes,  # # of successfully split statements
            "children_success": successes,
            "children_failed": failures,
            "updated_at": now_iso(),
        }},
    )
