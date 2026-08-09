"""Realtime auto-push — fire-and-forget hook called by create endpoints
after a successful insert. If Mirror is enabled for the company AND
the target entity is enabled, we schedule an async background task
that pushes the single row to QBO and stamps the returned qbo_id.

Silent no-op when Mirror is disabled, so create endpoints can safely
call `try_auto_push(...)` unconditionally without hurting perf on
companies that never turn Mirror on.

Never blocks the create response. Failures land in the mirror_log
(kind='autopush') for later inspection.
"""
from __future__ import annotations
import asyncio
import logging
from typing import Any

from db import db, now_iso
from qbo_service import get_access_token, API_BASE, QBO_MINOR_VERSION
from qbo_mirror.settings import is_enabled, append_log
from qbo_mirror.push import (
    _post, _acct_body, _contact_body, _item_body, _invoice_body,
)

logger = logging.getLogger(__name__)


# ─── Entity-specific single-row pushers ─────────────────────────────

async def _push_one_account(company_id: str, realm_id: str,
                              doc: dict) -> tuple[str | None, str | None]:
    resp = await _post(company_id, realm_id,
                        f"/company/{realm_id}/account",
                        _acct_body(doc))
    new_id = (resp.get("Account") or {}).get("Id")
    return (str(new_id) if new_id else None, None)


async def _push_one_contact(company_id: str, realm_id: str,
                              doc: dict, kind: str) -> tuple[str | None, str | None]:
    entity = "Customer" if kind == "customer" else "Vendor"
    resp = await _post(company_id, realm_id,
                        f"/company/{realm_id}/{entity.lower()}",
                        _contact_body(doc))
    new_id = (resp.get(entity) or {}).get("Id")
    return (str(new_id) if new_id else None, None)


async def _push_one_item(company_id: str, realm_id: str,
                          doc: dict) -> tuple[str | None, str | None]:
    # Resolve local `income_account_id` (a UUID) into the QBO account's
    # numeric Id so QBO's IncomeAccountRef is valid. Without this, QBO
    # rejects any Service/Inventory item with a 400 error.
    if doc.get("income_account_id") and not doc.get("income_account_qbo_id"):
        acct = await db.accounts.find_one(
            {"id": doc["income_account_id"], "company_id": company_id},
            {"qbo_id": 1, "_id": 0},
        )
        if acct and acct.get("qbo_id"):
            doc = {**doc, "income_account_qbo_id": acct["qbo_id"]}
    resp = await _post(company_id, realm_id,
                        f"/company/{realm_id}/item",
                        _item_body(doc))
    new_id = (resp.get("Item") or {}).get("Id")
    return (str(new_id) if new_id else None, None)


async def _push_one_invoice(company_id: str, realm_id: str,
                             doc: dict) -> tuple[str | None, str | None]:
    """Single-invoice push (used by autopush and manual push).
    Raises ValueError inside _invoice_body if the invoice can't be
    mapped; caller records the failure in the sync log."""
    body = await _invoice_body(company_id, doc)
    resp = await _post(company_id, realm_id,
                        f"/company/{realm_id}/invoice",
                        body)
    new_id = (resp.get("Invoice") or {}).get("Id")
    return (str(new_id) if new_id else None, None)


# ─── Update / Delete helpers ───────────────────────────────────────
# QBO requires the current SyncToken on every update/delete — a sparse
# update endpoint means "give me the FULL updated doc plus the token".
# We fetch the entity fresh right before writing to ensure the token
# is current (stale tokens 400 with "stale object" errors).

_ENTITY_META = {
    "account":  ("account",  "Account",  "accounts", None),
    "customer": ("customer", "Customer", "contacts", "customer"),
    "vendor":   ("vendor",   "Vendor",   "contacts", "vendor"),
    "item":     ("item",     "Item",     "items",    None),
    "invoice":  ("invoice",  "Invoice",  "invoices", None),
}


async def _qbo_get_sync_token(company_id: str, realm_id: str,
                                qbo_path: str, qbo_key: str,
                                qbo_id: str) -> str | None:
    """Fetch a single entity from QBO to read its current SyncToken.
    Returns None if the entity was already deleted on QBO's side."""
    from qbo_service import _get
    try:
        r = await _get(company_id, realm_id,
                       f"/company/{realm_id}/{qbo_path}/{qbo_id}",
                       params={"minorversion": QBO_MINOR_VERSION})
        return str((r.get(qbo_key) or {}).get("SyncToken", "0"))
    except Exception:  # noqa: BLE001
        return None


async def _run_auto_delete(company_id: str, entity: str, qbo_id: str,
                             entity_name: str = "") -> None:
    """Background delete task — inactivates the entity on QBO.

    QBO doesn't allow true delete for master-data (Customer, Vendor,
    Account) — those endpoints reject `?operation=delete` with a
    `ValidationFault: Unsupported Operation`. The correct pattern is a
    sparse update with `Active: false`, which is what "Make inactive"
    does in the QBO UI.

    Items DO accept `?operation=delete` (soft-delete), so we keep the
    delete op for items only. Everything else goes through the sparse-
    update path.
    """
    meta = _ENTITY_META.get(entity)
    if not meta:
        return
    qbo_path, qbo_key, _coll, _kind = meta
    try:
        conn = await db.qbo_connections.find_one(
            {"company_id": company_id, "status": "connected"},
            {"realm_id": 1, "_id": 0},
        )
        if not conn:
            return
        realm_id = conn["realm_id"]
        token = await _qbo_get_sync_token(company_id, realm_id,
                                            qbo_path, qbo_key, qbo_id)
        if token is None:
            await append_log(company_id, "autodelete",
                              f"Auto-delete {entity} {qbo_id}: already absent on QBO",
                              {"entity": entity, "qbo_id": qbo_id})
            return

        if entity == "item":
            # Items support the real ?operation=delete (soft).
            await _post(company_id, realm_id,
                         f"/company/{realm_id}/{qbo_path}",
                         {"Id": qbo_id, "SyncToken": token},
                         operation="delete")
        elif entity == "invoice":
            # Invoice supports hard delete via ?operation=delete.
            await _post(company_id, realm_id,
                         f"/company/{realm_id}/{qbo_path}",
                         {"Id": qbo_id, "SyncToken": token},
                         operation="delete")
        else:
            # Customer / Vendor / Account: sparse-update Active=false.
            await _post(company_id, realm_id,
                         f"/company/{realm_id}/{qbo_path}",
                         {"Id": qbo_id, "SyncToken": token,
                          "Active": False, "sparse": True})
        await append_log(company_id, "autodelete",
                          f"Auto-{'delete' if entity in ('item', 'invoice') else 'inactivate'} "
                          f"{entity} {qbo_id}"
                          + (f" ({entity_name})" if entity_name else ""),
                          {"entity": entity, "qbo_id": qbo_id,
                           "name": entity_name})
    except Exception as e:  # noqa: BLE001
        err = str(e)[:400]
        logger.warning("autodelete failed cid=%s entity=%s qbo_id=%s: %s",
                        company_id, entity, qbo_id, err)
        await append_log(company_id, "autodelete",
                          f"Auto-delete failed {entity} {qbo_id}: {err}",
                          {"entity": entity, "qbo_id": qbo_id, "error": err})


async def _run_auto_update(company_id: str, entity: str,
                             doc_id: str) -> None:
    """Background update task — sync a local edit to QBO."""
    meta = _ENTITY_META.get(entity)
    if not meta:
        return
    qbo_path, qbo_key, coll, kind = meta
    try:
        doc = await db[coll].find_one({"id": doc_id, "company_id": company_id})
        if not doc:
            return
        # Invoice-specific: draft → sent transitions have no qbo_id yet.
        # Route through the fresh-push path so the doc lands on QBO for
        # the first time on the status flip.
        if entity == "invoice" and not doc.get("qbo_id"):
            status = (doc.get("status") or "").lower()
            if status not in ("draft", "void", "voided") and \
               not doc.get("voided"):
                await _run_one(company_id, "invoice", doc_id)
            return
        if not doc.get("qbo_id"):
            return  # never pushed → nothing on QBO to update
        # Anti-loop: if the update itself came from a Mirror pull,
        # don't reflect it back to QBO.
        if doc.get("_sync_origin") in ("mirror_pull",):
            return
        conn = await db.qbo_connections.find_one(
            {"company_id": company_id, "status": "connected"},
            {"realm_id": 1, "_id": 0},
        )
        if not conn:
            return
        realm_id = conn["realm_id"]
        qbo_id = str(doc["qbo_id"])
        token = await _qbo_get_sync_token(company_id, realm_id,
                                            qbo_path, qbo_key, qbo_id)
        if token is None:
            return

        # Build the update body — QBO update is "full replace",
        # so include the existing Id + SyncToken plus all mapped
        # fields. Reuse the same body builders as insert.
        if entity == "account":
            body = _acct_body(doc)
        elif entity in ("customer", "vendor"):
            body = _contact_body(doc)
        elif entity == "item":
            # Same account-id resolution as insert.
            if doc.get("income_account_id") and not doc.get("income_account_qbo_id"):
                acct = await db.accounts.find_one(
                    {"id": doc["income_account_id"], "company_id": company_id},
                    {"qbo_id": 1, "_id": 0},
                )
                if acct and acct.get("qbo_id"):
                    doc = {**doc, "income_account_qbo_id": acct["qbo_id"]}
            body = _item_body(doc)
        elif entity == "invoice":
            # Invoice sparse update is doc-level only (dates, memos,
            # customer). Line-level drift is deferred — QBO requires
            # matching Line.Id/Detail to preserve payment linkage and
            # our local line model doesn't yet carry QBO's per-line
            # Id. Full-line rewrite lands in Phase 3.
            body = {}
            if doc.get("issue_date"):
                body["TxnDate"] = doc["issue_date"]
            if doc.get("due_date"):
                body["DueDate"] = doc["due_date"]
            if doc.get("notes"):
                body["CustomerMemo"] = {
                    "value": str(doc["notes"])[:1000]}
            if doc.get("internal_notes"):
                body["PrivateNote"] = str(doc["internal_notes"])[:4000]
            if not body:
                # Nothing at the doc level actually changed that we
                # can safely mirror. Skip.
                return
        else:
            return
        body["Id"] = qbo_id
        body["SyncToken"] = token
        # `sparse=true` lets us send only what we're actually
        # touching — QBO keeps everything else. Safer than a
        # true full-replace when we may not have all fields.
        body["sparse"] = True

        await _post(company_id, realm_id,
                     f"/company/{realm_id}/{qbo_path}",
                     body)
        # Stamp origin so echoes don't loop.
        await db[coll].update_one(
            {"id": doc_id},
            {"$set": {"_sync_origin": "mirror_push",
                      "_sync_status": "synced",
                      "_sync_finished_at": now_iso()}},
        )
        await append_log(company_id, "autoupdate",
                          f"Auto-update {entity} {doc_id} (qbo_id {qbo_id})"
                          + (f" Active={body.get('Active')}"
                             if 'Active' in body else ""),
                          {"entity": entity, "doc_id": doc_id,
                           "qbo_id": qbo_id,
                           "sent_body": {k: v for k, v in body.items()
                                          if k != "SyncToken"},
                           "local_active": doc.get("active")})
    except Exception as e:  # noqa: BLE001
        err = str(e)[:400]
        logger.warning("autoupdate failed cid=%s entity=%s id=%s: %s",
                        company_id, entity, doc_id, err)
        await append_log(company_id, "autoupdate",
                          f"Auto-update failed {entity} {doc_id}: {err}",
                          {"entity": entity, "doc_id": doc_id, "error": err})


def try_auto_delete(company_id: str, entity: str, qbo_id: str | None,
                     entity_name: str = "") -> None:
    """Fire-and-forget delete hook. `qbo_id` must be captured BEFORE
    the local delete removes the doc. Silent no-op if Mirror is off
    or qbo_id is missing."""
    if not qbo_id or entity not in _ENTITY_META:
        return

    async def _guarded() -> None:
        try:
            if not await is_enabled(company_id):
                return
            cfg = await db.mirror_config.find_one(
                {"company_id": company_id}, {"entities": 1, "_id": 0},
            )
            if cfg:
                cfg_key = _ENTITY_TO_CFG_KEY.get(entity)
                if cfg_key and (cfg.get("entities") or {}).get(cfg_key) is False:
                    return
            await _run_auto_delete(company_id, entity, str(qbo_id), entity_name)
        except Exception as e:  # noqa: BLE001
            logger.warning("autodelete guard: %s", e)

    try:
        asyncio.create_task(_guarded())
    except RuntimeError:
        pass


def try_auto_update(company_id: str, entity: str, doc_id: str) -> None:
    """Fire-and-forget update hook. Skips if the doc has no qbo_id yet
    (fresh local row) — the create-path already handled that via
    try_auto_push."""
    if entity not in _ENTITY_META:
        return

    async def _guarded() -> None:
        try:
            if not await is_enabled(company_id):
                return
            cfg = await db.mirror_config.find_one(
                {"company_id": company_id}, {"entities": 1, "_id": 0},
            )
            if cfg:
                cfg_key = _ENTITY_TO_CFG_KEY.get(entity)
                if cfg_key and (cfg.get("entities") or {}).get(cfg_key) is False:
                    return
            await _run_auto_update(company_id, entity, doc_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("autoupdate guard: %s", e)

    try:
        asyncio.create_task(_guarded())
    except RuntimeError:
        pass


# Registry so the hook stays tiny at each call site.
_HANDLERS = {
    "account":  ("accounts", _push_one_account, None),
    "customer": ("contacts", _push_one_contact, "customer"),
    "vendor":   ("contacts", _push_one_contact, "vendor"),
    "item":     ("items",    _push_one_item,    None),
    "invoice":  ("invoices", _push_one_invoice, None),
}


# ─── Entity → mirror_config key ────────────────────────────────────
# Auto-push respects the per-entity toggles in the Mirror settings —
# if the user unchecked "Customers", we don't autopush new customers.
_ENTITY_TO_CFG_KEY = {
    "account":  "accounts",
    "customer": "customers",
    "vendor":   "vendors",
    "item":     "items",
    "invoice":  "invoices",
}


async def _run_one(company_id: str, entity: str, doc_id: str) -> None:
    """Background task body. Never raises — logs failure instead."""
    coll, handler, kind = _HANDLERS[entity]
    try:
        # Re-fetch to get the latest values in case the doc was
        # patched after the create returned.
        doc = await db[coll].find_one({"id": doc_id, "company_id": company_id})
        if not doc:
            return
        # Anti-loop safety: if the row was itself imported/pulled from
        # QBO, don't push it back. `source == 'qbo'` covers migration
        # imports; `_sync_origin in {'mirror_pull','mirror_push'}`
        # covers earlier Mirror writes.
        if doc.get("source") == "qbo":
            return
        if doc.get("_sync_origin") in ("mirror_pull", "mirror_push"):
            return
        if doc.get("qbo_id"):
            return  # already synced
        # Entity-specific pre-push filters — invoice drafts and voids
        # don't belong on QBO. They become push-eligible when the user
        # flips the status to 'sent' (see _run_auto_update).
        if entity == "invoice":
            status = (doc.get("status") or "").lower()
            if status in ("draft", "void", "voided"):
                return
            if doc.get("voided"):
                return
        # Connection check — no realm → nothing to do.
        conn = await db.qbo_connections.find_one(
            {"company_id": company_id, "status": "connected"},
            {"realm_id": 1, "_id": 0},
        )
        if not conn:
            return
        realm_id = conn["realm_id"]

        # Stamp a "syncing" marker so the UI can render a badge while
        # the QBO round-trip is in flight.
        await db[coll].update_one(
            {"id": doc_id},
            {"$set": {"_sync_status": "syncing",
                      "_sync_started_at": now_iso()}},
        )

        if kind:
            qbo_id, _ = await handler(company_id, realm_id, doc, kind)
        else:
            qbo_id, _ = await handler(company_id, realm_id, doc)

        if not qbo_id:
            await db[coll].update_one(
                {"id": doc_id},
                {"$set": {"_sync_status": "failed",
                          "_sync_error": "No Id in QBO response",
                          "_sync_finished_at": now_iso()}},
            )
            await append_log(company_id, "autopush",
                              f"Auto-push {entity} {doc_id}: no Id in QBO response",
                              {"entity": entity, "doc_id": doc_id})
            return

        await db[coll].update_one(
            {"id": doc_id},
            {"$set": {"qbo_id": qbo_id, "realm_id": realm_id,
                      "_sync_origin": "mirror_push",
                      "_sync_status": "synced",
                      "_sync_finished_at": now_iso(),
                      "updated_at": now_iso()},
             "$unset": {"_sync_error": ""}},
        )
        await append_log(company_id, "autopush",
                          f"Auto-push {entity} {doc_id} → qbo_id {qbo_id}",
                          {"entity": entity, "doc_id": doc_id,
                           "qbo_id": qbo_id})
    except Exception as e:  # noqa: BLE001
        err = str(e)[:400]
        logger.warning("autopush failed cid=%s entity=%s id=%s: %s",
                        company_id, entity, doc_id, err)
        try:
            await db[coll].update_one(
                {"id": doc_id},
                {"$set": {"_sync_status": "failed",
                          "_sync_error": err,
                          "_sync_finished_at": now_iso()}},
            )
        except Exception:  # noqa: BLE001
            pass
        await append_log(company_id, "autopush",
                          f"Auto-push failed {entity} {doc_id}: {err}",
                          {"entity": entity, "doc_id": doc_id, "error": err})


def try_auto_push(company_id: str, entity: str, doc_id: str) -> None:
    """Fire-and-forget entry point. Safe to call unconditionally at
    the tail of a create endpoint. Never raises. Returns immediately —
    the actual push happens in an asyncio.Task."""
    if entity not in _HANDLERS:
        return

    async def _guarded() -> None:
        try:
            # Config gate — Mirror off or entity unchecked → no-op.
            if not await is_enabled(company_id):
                return
            cfg = await db.mirror_config.find_one(
                {"company_id": company_id},
                {"entities": 1, "_id": 0},
            )
            if cfg:
                cfg_key = _ENTITY_TO_CFG_KEY.get(entity)
                if cfg_key and (cfg.get("entities") or {}).get(cfg_key) is False:
                    return
            await _run_one(company_id, entity, doc_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("autopush guard failed: %s", e)

    try:
        asyncio.create_task(_guarded())
    except RuntimeError:
        # No running loop (e.g. called from a sync context). Skip.
        pass
