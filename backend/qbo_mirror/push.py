"""Phase 1c — Outbound (Us → QBO) executor.

Push local Foundation entities that lack a `qbo_id` into QBO via the
QBO REST API, then stamp the returned QBO Id back onto the local doc
so subsequent Preview runs recognize the row as in-sync.

Anti-loop tagging: every locally-updated doc carries
`_sync_origin: "mirror_push"` so a future webhook that echoes back
the same entity is recognized and skipped.

Never touches ledger tables. Only accounts, customers, vendors, items.

Uses `qbo_service.get_access_token` for OAuth; POST logic lives in
this module (isolation — no edits to qbo_service).
"""
from __future__ import annotations
import asyncio
import random
from typing import Any

import httpx

from db import db, now_iso
from qbo_service import (
    get_access_token, API_BASE, QBO_MINOR_VERSION,
)
from qbo_mirror.settings import append_log


_gate = asyncio.Semaphore(4)  # more conservative than reads


async def _post(company_id: str, realm_id: str, path: str,
                 body: dict, operation: str | None = None) -> dict:
    """POST helper with 401-refresh + 429/5xx exponential backoff.
    Mirrors qbo_service._get behavior."""
    tok = await get_access_token(company_id)
    params = {"minorversion": QBO_MINOR_VERSION}
    if operation:
        params["operation"] = operation
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(6):
            async with _gate:
                r = await client.post(
                    f"{API_BASE}{path}",
                    params=params,
                    json=body,
                    headers={
                        "Authorization": f"Bearer {tok}",
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                )
            if r.status_code == 401 and attempt == 0:
                await db.qbo_connections.update_one(
                    {"company_id": company_id},
                    {"$set": {"access_expires_at": now_iso()}},
                )
                tok = await get_access_token(company_id)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                await asyncio.sleep(min(60, 2 ** attempt + random.random()))
                continue
            if r.status_code >= 400:
                # Surface QBO's own error payload — much more useful
                # than a bare HTTPError string.
                try:
                    detail = r.json()
                except Exception:  # noqa: BLE001
                    detail = {"raw": r.text}
                raise RuntimeError(
                    f"QBO {r.status_code}: "
                    f"{(detail.get('Fault') or detail)!s}"
                )
            return r.json()
    raise RuntimeError("QBO unavailable after retries")


# ─── Local → QBO body builders ─────────────────────────────────────
# QBO's Account/Customer/Vendor/Item schemas are strict — extra keys
# trigger a 400. Keep bodies minimal; QBO fills in the rest.

_QBO_ACCOUNT_TYPE = {
    "asset": "Other Current Asset",
    "liability": "Other Current Liability",
    "equity": "Equity",
    "revenue": "Income",
    "expense": "Expense",
    "cost_of_goods_sold": "Cost of Goods Sold",
}


def _acct_body(a: dict) -> dict:
    body: dict[str, Any] = {
        "Name": (a.get("name") or "").strip(),
        "AccountType": _QBO_ACCOUNT_TYPE.get(a.get("type"), "Expense"),
    }
    # Include `Active` explicitly — needed for "Make Inactive" flow
    # to propagate to QBO (sparse update needs the field or QBO won't
    # change the state).
    if "active" in a:
        body["Active"] = bool(a.get("active"))
    if a.get("code"):
        body["AcctNum"] = str(a["code"])
    if a.get("description"):
        body["Description"] = a["description"][:500]
    return body


def _contact_body(c: dict) -> dict:
    body: dict[str, Any] = {
        "DisplayName": (c.get("name") or "").strip(),
    }
    if "active" in c:
        body["Active"] = bool(c.get("active"))
    if c.get("email"):
        body["PrimaryEmailAddr"] = {"Address": c["email"]}
    if c.get("phone"):
        body["PrimaryPhone"] = {"FreeFormNumber": c["phone"]}
    return body


def _item_body(i: dict) -> dict:
    body: dict[str, Any] = {
        "Name": (i.get("name") or "").strip(),
        "Type": (i.get("item_type") or "Service"),
    }
    if "active" in i:
        body["Active"] = bool(i.get("active"))
    if i.get("sku"):
        body["Sku"] = i["sku"]
    if i.get("description"):
        body["Description"] = i["description"][:1000]
    if i.get("price"):
        body["UnitPrice"] = float(i["price"])
    if i.get("income_account_qbo_id"):
        body["IncomeAccountRef"] = {"value": str(i["income_account_qbo_id"])}
    return body


# ─── Push helpers per entity ───────────────────────────────────────

async def _push_accounts(company_id: str, realm_id: str) -> dict:
    """Local accounts with no qbo_id → POST to QBO. Only pushes rows
    that are active (deactivated accounts are deliberately hidden)."""
    inserted = 0
    failed: list[dict] = []
    cursor = db.accounts.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "active": {"$ne": False},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
        {"id": 1, "name": 1, "type": 1, "subtype": 1, "code": 1,
         "description": 1, "_id": 0},
    )
    async for a in cursor:
        try:
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/account",
                _acct_body(a),
            )
            new_id = (resp.get("Account") or {}).get("Id")
            if not new_id:
                failed.append({"id": a["id"], "name": a.get("name"),
                                "error": "no Id in QBO response"})
                continue
            await db.accounts.update_one(
                {"id": a["id"]},
                {"$set": {"qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": a["id"], "name": a.get("name"),
                            "error": str(e)[:400]})
    return {"inserted": inserted, "failed": failed}


async def _push_contacts(company_id: str, realm_id: str,
                          kind: str, qbo_entity: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    cursor = db.contacts.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "type": kind, "active": {"$ne": False},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
        {"id": 1, "name": 1, "email": 1, "phone": 1, "_id": 0},
    )
    async for c in cursor:
        try:
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/{qbo_entity.lower()}",
                _contact_body(c),
            )
            new_id = (resp.get(qbo_entity) or {}).get("Id")
            if not new_id:
                failed.append({"id": c["id"], "name": c.get("name"),
                                "error": "no Id in QBO response"})
                continue
            await db.contacts.update_one(
                {"id": c["id"]},
                {"$set": {"qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": c["id"], "name": c.get("name"),
                            "error": str(e)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Invoice push (Phase 2c) ───────────────────────────────────────
# Bi-directional invoice mirror. Every line on a QBO SalesItemLine
# requires an ItemRef, so we resolve local `item_id` → item.qbo_id
# and fall back to a "Services"-typed QBO item if the line lacks one.
# Doc-level tax is deliberately skipped: our local tax library isn't
# mirrored to QBO (Phase 3), so forcing TxnTaxDetail here would either
# be ignored (AST companies) or crash (non-AST with unmapped codes).

async def _resolve_customer_ref(company_id: str,
                                 contact_id: str | None
                                 ) -> tuple[str, str] | None:
    if not contact_id:
        return None
    c = await db.contacts.find_one(
        {"id": contact_id, "company_id": company_id},
        {"qbo_id": 1, "name": 1, "display_name": 1, "_id": 0},
    )
    if not c or not c.get("qbo_id"):
        return None
    return (str(c["qbo_id"]),
            c.get("display_name") or c.get("name") or "")


async def _resolve_item_ref(company_id: str,
                             item_id: str | None
                             ) -> tuple[str, str] | None:
    if not item_id:
        return None
    it = await db.items.find_one(
        {"id": item_id, "company_id": company_id},
        {"qbo_id": 1, "name": 1, "_id": 0},
    )
    if not it or not it.get("qbo_id"):
        return None
    return (str(it["qbo_id"]), it.get("name") or "")


async def _default_service_item_qbo_id(company_id: str) -> tuple[str, str] | None:
    """Best-effort fallback item — locate a QBO-sourced Service item
    (populated by a prior Mirror Pull) so lines without a mapped
    item_id can still push. Prefers items literally named 'Services'
    or 'Hours', then any active Service-typed item."""
    for name_like in ("Services", "Hours", "General"):
        it = await db.items.find_one(
            {"company_id": company_id, "source": "qbo",
             "active": {"$ne": False}, "name": name_like},
            {"qbo_id": 1, "name": 1, "_id": 0},
        )
        if it and it.get("qbo_id"):
            return (str(it["qbo_id"]), it.get("name") or "Services")
    # Any Service-typed item as last resort.
    it = await db.items.find_one(
        {"company_id": company_id, "source": "qbo",
         "active": {"$ne": False},
         "item_type": {"$regex": "^service$", "$options": "i"}},
        {"qbo_id": 1, "name": 1, "_id": 0},
        sort=[("name", 1)],
    )
    if it and it.get("qbo_id"):
        return (str(it["qbo_id"]), it.get("name") or "Services")
    return None


def _local_patch_from_qbo_invoice(twin: dict) -> dict:
    """After a successful CREATE or UPDATE against QBO's invoice
    endpoint, QBO returns the fully-hydrated Invoice — including any
    tax it auto-applied, its own DueDate normalization, computed
    Balance, etc. Stamp those authoritative values back onto the
    local row so the next dry-run doesn't spuriously flag drift.
    """
    total = float(twin.get("TotalAmt") or 0)
    tax_detail = twin.get("TxnTaxDetail") or {}
    tax = float(tax_detail.get("TotalTax") or 0)
    balance = float(twin.get("Balance") or 0)
    patch: dict[str, Any] = {
        "total": round(total, 2),
        "subtotal": round(total - tax, 2),
        "tax": round(tax, 2),
        "balance": round(balance, 2),
        "balance_due": round(balance, 2),
        "status": "paid" if balance == 0 else "sent",
    }
    if twin.get("TxnDate"):
        patch["issue_date"] = twin["TxnDate"]
    if twin.get("DueDate"):
        patch["due_date"] = twin["DueDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _invoice_body(company_id: str, inv: dict) -> dict:
    """Build a QBO Invoice create/update body from a local invoice
    doc. Raises ``ValueError`` with a human-readable reason when the
    invoice can't be pushed (missing customer, unmapped item, etc.)."""
    customer = await _resolve_customer_ref(company_id, inv.get("contact_id"))
    if not customer:
        raise ValueError(
            "Customer missing or not synced to QBO. Sync customers first."
        )

    lines_out: list[dict] = []
    fallback: tuple[str, str] | None = None
    for idx, li in enumerate(inv.get("line_items") or [], start=1):
        amount = float(li.get("amount") or 0)
        qty = float(li.get("quantity") or 1) or 1
        rate = float(li.get("rate") or (amount / qty if qty else 0))
        description = (li.get("description") or "").strip()
        ref = await _resolve_item_ref(company_id, li.get("item_id"))
        if not ref:
            if fallback is None:
                fallback = await _default_service_item_qbo_id(company_id)
            if not fallback:
                raise ValueError(
                    f"Line {idx} has no item and no fallback QBO Service "
                    "item exists. Run Mirror Pull for items first."
                )
            ref = fallback
        lines_out.append({
            "DetailType": "SalesItemLineDetail",
            "Amount": round(amount, 2),
            "Description": description or ref[1] or "",
            "SalesItemLineDetail": {
                "ItemRef": {"value": ref[0], "name": ref[1]},
                "Qty": qty,
                "UnitPrice": rate,
            },
        })
    if not lines_out:
        raise ValueError("Invoice has no line items.")

    body: dict[str, Any] = {
        "CustomerRef": {"value": customer[0], "name": customer[1]},
        "Line": lines_out,
    }
    if inv.get("issue_date"):
        body["TxnDate"] = inv["issue_date"]
    if inv.get("due_date"):
        body["DueDate"] = inv["due_date"]
    if inv.get("number"):
        # QBO DocNumber caps at 21 chars.
        body["DocNumber"] = str(inv["number"])[:21]
    if inv.get("notes"):
        body["CustomerMemo"] = {"value": str(inv["notes"])[:1000]}
    if inv.get("internal_notes"):
        body["PrivateNote"] = str(inv["internal_notes"])[:4000]
    return body


async def _push_invoices(company_id: str, realm_id: str) -> dict:
    """Local invoices with no qbo_id → POST (create) to QBO.
    Locally-authored invoices that already have a qbo_id but have
    drifted → full-replace UPDATE. Manual push respects user intent —
    a draft in the preview push queue is pushed as an open invoice
    on QBO (QBO has no draft concept). Only voided invoices are
    hard-skipped."""
    inserted = 0
    updated = 0
    failed: list[dict] = []
    skipped: list[dict] = []
    # Two-pass: creates first, then updates. Ensures customer/item
    # dependencies stay stable and log entries are cleanly ordered.

    # ── PASS 1: create rows without qbo_id ─────────────────────────
    async for inv in db.invoices.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "voided": {"$ne": True},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        status = (inv.get("status") or "").lower()
        if status in ("void", "voided"):
            skipped.append({"id": inv["id"], "number": inv.get("number"),
                             "reason": f"status={status}"})
            continue
        try:
            body = await _invoice_body(company_id, inv)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/invoice",
                body,
            )
            new_id = (resp.get("Invoice") or {}).get("Id")
            if not new_id:
                failed.append({"id": inv["id"], "number": inv.get("number"),
                                "error": "no Id in QBO response"})
                continue
            # Stamp QBO's authoritative values back onto local so the
            # next preview doesn't fire a phantom-drift (QBO may have
            # normalized dates, auto-computed tax, adjusted balance).
            twin_patch = _local_patch_from_qbo_invoice(resp.get("Invoice") or {})
            await db.invoices.update_one(
                {"id": inv["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": inv["id"], "number": inv.get("number"),
                            "error": str(e)[:400]})

    # ── PASS 2: full-replace update rows with a qbo_id that were
    # authored locally (source != 'qbo'). We compare local totals
    # against the QBO twin's TotalAmt to detect drift cheaply — if
    # the number matches within a cent we skip the round-trip.
    from qbo_service import _get
    async for inv in db.invoices.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "voided": {"$ne": True},
         "qbo_id": {"$nin": [None, ""]}},
    ):
        # Anti-loop: if the most recent write was ourselves reflecting
        # QBO's state back, don't reflect it right back to QBO.
        if inv.get("_sync_origin") == "mirror_pull":
            continue
        qbo_id = str(inv["qbo_id"])
        try:
            # Read the QBO twin to get SyncToken + current TotalAmt.
            qr = await _get(company_id, realm_id,
                             f"/company/{realm_id}/invoice/{qbo_id}",
                             params={"minorversion": QBO_MINOR_VERSION})
            twin = qr.get("Invoice") or {}
            token = str(twin.get("SyncToken", "0"))
            local_total = round(float(inv.get("total") or 0), 2)
            remote_total = round(float(twin.get("TotalAmt") or 0), 2)
            if abs(local_total - remote_total) < 0.01:
                # No meaningful drift — nothing to push.
                continue
            body = await _invoice_body(company_id, inv)
            body["Id"] = qbo_id
            body["SyncToken"] = token
            # Full replace (sparse=false is the QBO default when
            # sparse isn't set). This overwrites lines to match the
            # local state. Payment linkage on removed lines is a
            # known QBO edge case — flagged in CHANGELOG.
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/invoice",
                body,
            )
            new_id = (resp.get("Invoice") or {}).get("Id")
            if not new_id:
                failed.append({"id": inv["id"], "number": inv.get("number"),
                                "error": "update: no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_invoice(resp.get("Invoice") or {})
            await db.invoices.update_one(
                {"id": inv["id"]},
                {"$set": {**twin_patch,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            updated += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": inv["id"], "number": inv.get("number"),
                            "error": str(e)[:400]})

    return {"inserted": inserted, "updated": updated,
            "failed": failed, "skipped": skipped}


async def _push_items(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    cursor = db.items.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "active": {"$ne": False},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
        {"id": 1, "name": 1, "sku": 1, "description": 1, "price": 1,
         "item_type": 1, "income_account_qbo_id": 1, "_id": 0},
    )
    async for it in cursor:
        try:
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/item",
                _item_body(it),
            )
            new_id = (resp.get("Item") or {}).get("Id")
            if not new_id:
                failed.append({"id": it["id"], "name": it.get("name"),
                                "error": "no Id in QBO response"})
                continue
            await db.items.update_one(
                {"id": it["id"]},
                {"$set": {"qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": it["id"], "name": it.get("name"),
                            "error": str(e)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Bill push (Phase 2d) ──────────────────────────────────────────
# Bills are structurally close to invoices but use VendorRef +
# AccountBasedExpenseLineDetail. QBO does not treat the per-line
# `account_id` (expense category) as optional — every line MUST
# have an AccountRef. When a local line has no `expense_account_id`
# we fall back to the QBO-side "Uncategorized Expense" account
# (or the alphabetically first Expense-typed account) so the push
# still succeeds. Users can re-categorize afterwards.

async def _resolve_vendor_ref(company_id: str,
                                contact_id: str | None
                                ) -> tuple[str, str] | None:
    if not contact_id:
        return None
    c = await db.contacts.find_one(
        {"id": contact_id, "company_id": company_id},
        {"qbo_id": 1, "name": 1, "display_name": 1, "_id": 0},
    )
    if not c or not c.get("qbo_id"):
        return None
    return (str(c["qbo_id"]),
            c.get("display_name") or c.get("name") or "")


async def _resolve_account_ref(company_id: str,
                                 account_id: str | None
                                 ) -> tuple[str, str] | None:
    if not account_id:
        return None
    a = await db.accounts.find_one(
        {"id": account_id, "company_id": company_id},
        {"qbo_id": 1, "name": 1, "_id": 0},
    )
    if not a or not a.get("qbo_id"):
        return None
    return (str(a["qbo_id"]), a.get("name") or "")


async def _default_expense_account_qbo(company_id: str
                                         ) -> tuple[str, str] | None:
    """Best-effort fallback expense account for bill lines missing
    an expense_account_id. Prefers "Uncategorized Expense" (the
    Plaid catch-all we already seed), then any active expense-typed
    QBO account."""
    for name_like in ("Uncategorized Expense", "Miscellaneous",
                      "Other Expense"):
        a = await db.accounts.find_one(
            {"company_id": company_id, "source": "qbo",
             "name": name_like, "active": {"$ne": False}},
            {"qbo_id": 1, "name": 1, "_id": 0},
        )
        if a and a.get("qbo_id"):
            return (str(a["qbo_id"]), a["name"])
    a = await db.accounts.find_one(
        {"company_id": company_id, "source": "qbo",
         "type": "expense", "active": {"$ne": False}},
        {"qbo_id": 1, "name": 1, "_id": 0},
        sort=[("name", 1)],
    )
    if a and a.get("qbo_id"):
        return (str(a["qbo_id"]), a.get("name") or "Expense")
    return None


async def _bill_body(company_id: str, bill: dict) -> dict:
    """Build a QBO Bill create/update body from a local bill doc.
    Raises ValueError with a human-readable reason if the bill
    can't be pushed."""
    vendor = await _resolve_vendor_ref(company_id, bill.get("contact_id"))
    if not vendor:
        raise ValueError(
            "Vendor missing or not synced to QBO. Sync vendors first."
        )
    lines_out: list[dict] = []
    fallback: tuple[str, str] | None = None
    for idx, li in enumerate(bill.get("line_items") or [], start=1):
        amount = float(li.get("amount") or 0)
        description = (li.get("description") or "").strip()
        acct = await _resolve_account_ref(
            company_id, li.get("expense_account_id"))
        if not acct:
            if fallback is None:
                fallback = await _default_expense_account_qbo(company_id)
            if not fallback:
                raise ValueError(
                    f"Line {idx} has no expense account and no "
                    "fallback QBO expense account exists. Run Mirror "
                    "Pull for accounts first."
                )
            acct = fallback
        lines_out.append({
            "DetailType": "AccountBasedExpenseLineDetail",
            "Amount": round(amount, 2),
            "Description": description,
            "AccountBasedExpenseLineDetail": {
                "AccountRef": {"value": acct[0], "name": acct[1]},
            },
        })
    if not lines_out:
        raise ValueError("Bill has no line items.")

    body: dict[str, Any] = {
        "VendorRef": {"value": vendor[0], "name": vendor[1]},
        "Line": lines_out,
    }
    if bill.get("issue_date"):
        body["TxnDate"] = bill["issue_date"]
    if bill.get("due_date"):
        body["DueDate"] = bill["due_date"]
    if bill.get("number"):
        body["DocNumber"] = str(bill["number"])[:21]
    if bill.get("internal_notes"):
        body["PrivateNote"] = str(bill["internal_notes"])[:4000]
    return body


def _local_patch_from_qbo_bill(twin: dict) -> dict:
    """Twin-patch equivalent of `_local_patch_from_qbo_invoice`.
    Called after a successful CREATE or UPDATE against QBO's bill
    endpoint so we stamp QBO's authoritative view back and avoid
    phantom drift on the next preview."""
    total = float(twin.get("TotalAmt") or 0)
    balance = float(twin.get("Balance") or 0)
    patch: dict[str, Any] = {
        "total": round(total, 2),
        "subtotal": round(total, 2),
        "balance": round(balance, 2),
        "balance_due": round(balance, 2),
        "status": "paid" if balance == 0 else "open",
    }
    if twin.get("TxnDate"):
        patch["issue_date"] = twin["TxnDate"]
    if twin.get("DueDate"):
        patch["due_date"] = twin["DueDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _push_bills(company_id: str, realm_id: str) -> dict:
    """Local bills without qbo_id → POST (create). Locally-authored
    bills that already carry a qbo_id but have drifted (total
    differs) → full-replace UPDATE with SyncToken. Only voided
    bills are hard-skipped."""
    inserted = 0
    updated = 0
    failed: list[dict] = []
    skipped: list[dict] = []

    # PASS 1 — create
    async for b in db.bills.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "voided": {"$ne": True},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        status = (b.get("status") or "").lower()
        if status in ("void", "voided"):
            skipped.append({"id": b["id"], "number": b.get("number"),
                             "reason": f"status={status}"})
            continue
        try:
            body = await _bill_body(company_id, b)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/bill",
                body,
            )
            twin = resp.get("Bill") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": b["id"], "number": b.get("number"),
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_bill(twin)
            await db.bills.update_one(
                {"id": b["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": b["id"], "number": b.get("number"),
                            "error": str(e)[:400]})

    # PASS 2 — update drifted rows
    from qbo_service import _get
    async for b in db.bills.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "voided": {"$ne": True},
         "qbo_id": {"$nin": [None, ""]}},
    ):
        if b.get("_sync_origin") == "mirror_pull":
            continue
        qbo_id = str(b["qbo_id"])
        try:
            qr = await _get(company_id, realm_id,
                             f"/company/{realm_id}/bill/{qbo_id}",
                             params={"minorversion": QBO_MINOR_VERSION})
            twin = qr.get("Bill") or {}
            token = str(twin.get("SyncToken", "0"))
            local_total = round(float(b.get("total") or 0), 2)
            remote_total = round(float(twin.get("TotalAmt") or 0), 2)
            if abs(local_total - remote_total) < 0.01:
                continue
            body = await _bill_body(company_id, b)
            body["Id"] = qbo_id
            body["SyncToken"] = token
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/bill",
                body,
            )
            new_twin = resp.get("Bill") or {}
            new_id = new_twin.get("Id")
            if not new_id:
                failed.append({"id": b["id"], "number": b.get("number"),
                                "error": "update: no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_bill(new_twin)
            await db.bills.update_one(
                {"id": b["id"]},
                {"$set": {**twin_patch,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            updated += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": b["id"], "number": b.get("number"),
                            "error": str(e)[:400]})

    return {"inserted": inserted, "updated": updated,
            "failed": failed, "skipped": skipped}


async def run_push(company_id: str, user_email: str,
                    entities: list[str] | None = None) -> dict:
    """Outbound-only sync — create local-only Foundation entities on
    QBO. Never touches ledger."""
    conn = await db.qbo_connections.find_one(
        {"company_id": company_id, "status": "connected"},
        {"realm_id": 1, "_id": 0},
    )
    if not conn:
        return {"error": "QBO is not connected for this company."}
    realm_id = conn["realm_id"]

    if entities is None:
        entities = ["accounts", "customers", "vendors", "items",
                     "invoices", "bills"]

    result: dict[str, dict] = {}
    for e in entities:
        try:
            if e == "accounts":
                result[e] = await _push_accounts(company_id, realm_id)
            elif e == "customers":
                result[e] = await _push_contacts(company_id, realm_id,
                                                  "customer", "Customer")
            elif e == "vendors":
                result[e] = await _push_contacts(company_id, realm_id,
                                                  "vendor", "Vendor")
            elif e == "items":
                result[e] = await _push_items(company_id, realm_id)
            elif e == "invoices":
                result[e] = await _push_invoices(company_id, realm_id)
            elif e == "bills":
                result[e] = await _push_bills(company_id, realm_id)
        except Exception as err:  # noqa: BLE001
            result[e] = {"error": str(err)}

    totals = {
        "inserted": sum(v.get("inserted", 0) for v in result.values()
                        if isinstance(v, dict)),
        "failed":   sum(len(v.get("failed", [])) for v in result.values()
                        if isinstance(v, dict)),
    }
    await append_log(company_id, "mirror_push",
                     f"Push by {user_email}: {totals}",
                     {"totals": totals, "per_entity": result,
                      "realm_id": realm_id})
    return {"totals": totals, "per_entity": result, "realm_id": realm_id}
