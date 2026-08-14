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
    get_access_token, _api_base_for_company, QBO_MINOR_VERSION,
)
from qbo_mirror.settings import append_log


_gate = asyncio.Semaphore(4)  # more conservative than reads


async def _post(company_id: str, realm_id: str, path: str,
                 body: dict, operation: str | None = None) -> dict:
    """POST helper with 401-refresh + 429/5xx exponential backoff.
    Mirrors qbo_service._get behavior."""
    tok = await get_access_token(company_id)
    base = await _api_base_for_company(company_id)
    params = {"minorversion": QBO_MINOR_VERSION}
    if operation:
        params["operation"] = operation
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(6):
            async with _gate:
                r = await client.post(
                    f"{base}{path}",
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
    # Three-way status: matches _norm_invoice_qbo so preview stays
    # in sync after an autopush that changed balance.
    if balance == 0:
        status = "paid"
    elif balance < total:
        status = "partial"
    else:
        status = "sent"
    patch: dict[str, Any] = {
        "total": round(total, 2),
        "subtotal": round(total - tax, 2),
        "tax": round(tax, 2),
        "balance": round(balance, 2),
        "balance_due": round(balance, 2),
        "status": status,
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
    if balance == 0:
        status = "paid"
    elif balance < total:
        status = "partial"
    else:
        status = "open"
    patch: dict[str, Any] = {
        "total": round(total, 2),
        "subtotal": round(total, 2),
        "balance": round(balance, 2),
        "balance_due": round(balance, 2),
        "status": status,
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


# ─── Payment push (Phase 2e) ───────────────────────────────────────
# Two QBO entities: Payment (customer→us, "in") and BillPayment
# (us→vendor, "out"). Direction is inferred from local's
# `linked_invoice_id` / `linked_bill_id`. Unlinked payments cannot
# be pushed — they'd be a bare deposit/withdrawal in QBO and lose
# their business meaning.

async def _resolve_account_qbo_id(company_id: str,
                                    account_id: str | None) -> str | None:
    if not account_id:
        return None
    a = await db.accounts.find_one(
        {"id": account_id, "company_id": company_id},
        {"qbo_id": 1, "_id": 0},
    )
    return str(a["qbo_id"]) if a and a.get("qbo_id") else None


async def _default_bank_account_qbo(company_id: str) -> str | None:
    """Best-effort fallback for a payment that doesn't specify a
    bank account. Prefers active accounts named "Checking" (the
    default seed), then any active QBO account with type=bank."""
    for name_like in ("Checking", "Cash", "Bank"):
        a = await db.accounts.find_one(
            {"company_id": company_id, "source": "qbo",
             "active": {"$ne": False}, "name": name_like},
            {"qbo_id": 1, "_id": 0},
        )
        if a and a.get("qbo_id"):
            return str(a["qbo_id"])
    a = await db.accounts.find_one(
        {"company_id": company_id, "source": "qbo",
         "active": {"$ne": False}, "type": "bank"},
        {"qbo_id": 1, "_id": 0},
        sort=[("name", 1)],
    )
    return str(a["qbo_id"]) if a and a.get("qbo_id") else None


async def _payment_body_in(company_id: str, pay: dict) -> dict:
    """Customer Payment body (money in). Requires:
      - contact_id → CustomerRef (fallback: linked invoice's contact_id)
      - linked_invoice_id → Line[].LinkedTxn (Invoice, invoice.qbo_id)
      - bank_account_id → DepositToAccountRef (optional; QBO uses
        Undeposited Funds if omitted).
    """
    inv_id = pay.get("linked_invoice_id")
    if not inv_id:
        raise ValueError("Payment has no linked invoice.")
    inv = await db.invoices.find_one(
        {"id": inv_id, "company_id": company_id},
        {"qbo_id": 1, "contact_id": 1, "_id": 0},
    )
    if not inv or not inv.get("qbo_id"):
        raise ValueError(
            "Linked invoice not synced to QBO. Sync the invoice first.")
    # Fallback: if the payment row has no contact_id (common when
    # the user records "Pay this invoice" from the invoice screen —
    # the customer is implicit), reuse the invoice's contact_id.
    contact_id = pay.get("contact_id") or inv.get("contact_id")
    cust = await _resolve_customer_ref(company_id, contact_id)
    if not cust:
        raise ValueError(
            "Customer missing or not synced to QBO. Sync customers first.")
    amount = round(float(pay.get("amount") or 0), 2)
    body: dict[str, Any] = {
        "CustomerRef": {"value": cust[0], "name": cust[1]},
        "TotalAmt": amount,
        "Line": [{
            "Amount": amount,
            "LinkedTxn": [{"TxnType": "Invoice",
                             "TxnId": str(inv["qbo_id"])}],
        }],
    }
    bank_qbo = await _resolve_account_qbo_id(
        company_id, pay.get("bank_account_id"))
    if bank_qbo:
        body["DepositToAccountRef"] = {"value": bank_qbo}
    if pay.get("date"):
        body["TxnDate"] = pay["date"]
    if pay.get("memo"):
        body["PrivateNote"] = str(pay["memo"])[:4000]
    return body


async def _payment_body_out(company_id: str, pay: dict) -> dict:
    """BillPayment body (money out). Requires:
      - contact_id → VendorRef (fallback: linked bill's contact_id)
      - linked_bill_id → Line[].LinkedTxn (Bill, bill.qbo_id)
      - bank_account_id → CheckPayment.BankAccountRef.

    `PayType: Check` is the safest default — CreditCard requires a
    QBO credit-card account that we don't reliably know locally.
    """
    bill_id = pay.get("linked_bill_id")
    if not bill_id:
        raise ValueError("Bill payment has no linked bill.")
    bill = await db.bills.find_one(
        {"id": bill_id, "company_id": company_id},
        {"qbo_id": 1, "contact_id": 1, "_id": 0},
    )
    if not bill or not bill.get("qbo_id"):
        raise ValueError(
            "Linked bill not synced to QBO. Sync the bill first.")
    contact_id = pay.get("contact_id") or bill.get("contact_id")
    vend = await _resolve_vendor_ref(company_id, contact_id)
    if not vend:
        raise ValueError(
            "Vendor missing or not synced to QBO. Sync vendors first.")
    amount = round(float(pay.get("amount") or 0), 2)
    bank_qbo = await _resolve_account_qbo_id(
        company_id, pay.get("bank_account_id"))
    if not bank_qbo:
        # Fall back to the company's default bank account (Checking
        # / Cash / any type=bank). Bill payments require an account
        # ref, and QBO's UX for it is a plain dropdown — if the user
        # missed the field locally, silently defaulting is more
        # forgiving than blocking the push.
        bank_qbo = await _default_bank_account_qbo(company_id)
    if not bank_qbo:
        # No mapped QBO bank account at all — genuinely can't push.
        raise ValueError(
            "Bill payment has no bank account and no default "
            "QBO bank account is available. Sync accounts first.")
    body: dict[str, Any] = {
        "VendorRef": {"value": vend[0], "name": vend[1]},
        "PayType": "Check",
        "TotalAmt": amount,
        "Line": [{
            "Amount": amount,
            "LinkedTxn": [{"TxnType": "Bill",
                             "TxnId": str(bill["qbo_id"])}],
        }],
        "CheckPayment": {"BankAccountRef": {"value": bank_qbo}},
    }
    if pay.get("date"):
        body["TxnDate"] = pay["date"]
    if pay.get("memo"):
        body["PrivateNote"] = str(pay["memo"])[:4000]
    return body


def _local_patch_from_qbo_payment(twin: dict) -> dict:
    """Stamp QBO's authoritative fields back onto local payment."""
    amount = float(twin.get("TotalAmt") or 0)
    patch: dict[str, Any] = {
        "amount": round(amount, 2),
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    return patch


async def _push_payments_in(company_id: str, realm_id: str) -> dict:
    """Push local customer payments (linked_invoice_id set, no qbo_id)."""
    inserted = 0
    failed: list[dict] = []
    skipped: list[dict] = []
    async for p in db.payments.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "linked_invoice_id": {"$nin": [None, ""]},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _payment_body_in(company_id, p)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/payment", body,
            )
            twin = resp.get("Payment") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": p["id"],
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_payment(twin)
            await db.payments.update_one(
                {"id": p["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "direction": "in",
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": p["id"], "error": str(e)[:400]})
    return {"inserted": inserted, "failed": failed, "skipped": skipped}


async def _push_payments_out(company_id: str, realm_id: str) -> dict:
    """Push local bill payments (linked_bill_id set, no qbo_id)."""
    inserted = 0
    failed: list[dict] = []
    skipped: list[dict] = []
    async for p in db.payments.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "linked_bill_id": {"$nin": [None, ""]},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _payment_body_out(company_id, p)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/billpayment", body,
            )
            twin = resp.get("BillPayment") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": p["id"],
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_payment(twin)
            await db.payments.update_one(
                {"id": p["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "direction": "out",
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": p["id"], "error": str(e)[:400]})
    return {"inserted": inserted, "failed": failed, "skipped": skipped}


# ─── Journal Entry push (Phase 2f) ─────────────────────────────────
# Every JournalEntryLine must have PostingType: Debit|Credit plus
# an AccountRef. Local lines carry `account_id` (UUID) OR
# `account_name` (loose match). We prefer the UUID; fall back to
# name lookup as a resilience mechanism for legacy imports.

async def _resolve_account_ref_by_id_or_name(
    company_id: str, account_id: str | None, account_name: str | None,
) -> tuple[str, str] | None:
    if account_id:
        a = await db.accounts.find_one(
            {"id": account_id, "company_id": company_id},
            {"qbo_id": 1, "name": 1, "_id": 0},
        )
        if a and a.get("qbo_id"):
            return (str(a["qbo_id"]), a.get("name") or "")
    if account_name:
        a = await db.accounts.find_one(
            {"company_id": company_id, "name": account_name.strip(),
             "active": {"$ne": False}},
            {"qbo_id": 1, "name": 1, "_id": 0},
        )
        if a and a.get("qbo_id"):
            return (str(a["qbo_id"]), a.get("name") or account_name)
    return None


async def _journal_entry_body(company_id: str, je: dict) -> dict:
    """Build a QBO JournalEntry create body from a local JE. Each
    local line becomes two potential JE lines (one debit OR one
    credit — never both on the same row). Raises ValueError on any
    unmapped account or unbalanced entry."""
    lines_out: list[dict] = []
    total_debit = 0.0
    total_credit = 0.0
    for idx, li in enumerate(je.get("lines") or [], start=1):
        debit = round(float(li.get("debit") or 0), 2)
        credit = round(float(li.get("credit") or 0), 2)
        if debit and credit:
            raise ValueError(
                f"Line {idx} has both a debit and a credit — "
                "each line must be one or the other.")
        if debit == 0 and credit == 0:
            continue  # skip empty rows
        acct = await _resolve_account_ref_by_id_or_name(
            company_id,
            li.get("account_id"),
            li.get("account_name"),
        )
        if not acct:
            raise ValueError(
                f"Line {idx} account not synced to QBO "
                "(account_id or account_name missing/unmapped).")
        posting_type = "Debit" if debit else "Credit"
        amount = debit or credit
        lines_out.append({
            "DetailType": "JournalEntryLineDetail",
            "Amount": amount,
            "Description": (li.get("description") or "").strip(),
            "JournalEntryLineDetail": {
                "PostingType": posting_type,
                "AccountRef": {"value": acct[0], "name": acct[1]},
            },
        })
        if debit:
            total_debit += debit
        else:
            total_credit += credit
    if not lines_out:
        raise ValueError("Journal entry has no lines.")
    if abs(total_debit - total_credit) > 0.01:
        raise ValueError(
            f"JE unbalanced: debits {total_debit} ≠ credits {total_credit}")

    body: dict[str, Any] = {"Line": lines_out}
    if je.get("date"):
        body["TxnDate"] = je["date"]
    if je.get("number"):
        body["DocNumber"] = str(je["number"])[:21]
    if je.get("memo"):
        body["PrivateNote"] = str(je["memo"])[:4000]
    return body


def _local_patch_from_qbo_je(twin: dict) -> dict:
    """Twin patch after a successful JE push."""
    patch: dict[str, Any] = {}
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    if twin.get("PrivateNote"):
        patch["memo"] = twin["PrivateNote"]
    return patch


async def _push_journal_entries(company_id: str, realm_id: str) -> dict:
    """Local JEs without qbo_id → POST to QBO. JE updates are NOT
    mirrored — a JE that changed lines needs QBO's Line.Id chain
    to preserve balance-affecting audit trail, and our local JE
    doesn't yet carry those Ids. Users should delete + recreate."""
    inserted = 0
    failed: list[dict] = []
    skipped: list[dict] = []
    async for je in db.journal_entries.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _journal_entry_body(company_id, je)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/journalentry",
                body,
            )
            twin = resp.get("JournalEntry") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": je["id"],
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_je(twin)
            await db.journal_entries.update_one(
                {"id": je["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"id": je["id"], "error": str(e)[:400]})
    return {"inserted": inserted, "failed": failed, "skipped": skipped}





# ─── Estimate push (Phase 3) ───────────────────────────────────────
# Estimates share Invoice's SalesItemLineDetail structure. Main
# differences: `ExpirationDate` instead of `DueDate`, plus a
# `TxnStatus` field ("Pending" | "Accepted" | "Closed" |
# "Rejected") mapped from our local status vocabulary.

_EST_STATUS_TO_QBO = {
    "draft":     "Pending",
    "sent":      "Pending",
    "accepted":  "Accepted",
    "rejected":  "Rejected",
    "closed":    "Closed",
    "converted": "Closed",  # QBO's terminal state
}


async def _estimate_body(company_id: str, est: dict) -> dict:
    """QBO Estimate payload. Same line shape as invoices."""
    customer = await _resolve_customer_ref(company_id, est.get("contact_id"))
    if not customer:
        raise ValueError(
            "Customer missing or not synced to QBO. Sync customers first.")
    lines_out: list[dict] = []
    fallback: tuple[str, str] | None = None
    for idx, li in enumerate(est.get("line_items") or [], start=1):
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
                    f"Line {idx} has no item and no fallback QBO "
                    "Service item exists. Sync items first.")
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
        raise ValueError("Estimate has no line items.")

    body: dict[str, Any] = {
        "CustomerRef": {"value": customer[0], "name": customer[1]},
        "Line": lines_out,
    }
    if est.get("issue_date"):
        body["TxnDate"] = est["issue_date"]
    if est.get("expiration_date"):
        body["ExpirationDate"] = est["expiration_date"]
    if est.get("number"):
        body["DocNumber"] = str(est["number"])[:21]
    if est.get("notes"):
        body["CustomerMemo"] = {"value": str(est["notes"])[:1000]}
    if est.get("internal_notes"):
        body["PrivateNote"] = str(est["internal_notes"])[:4000]
    qbo_status = _EST_STATUS_TO_QBO.get((est.get("status") or "").lower())
    if qbo_status:
        body["TxnStatus"] = qbo_status
    # If this estimate was converted to an invoice locally, link the two
    # in QBO so the estimate shows its resulting invoice (matches QBO's
    # native "Convert to invoice" behaviour).
    conv_iid = est.get("converted_invoice_id")
    if conv_iid:
        inv = await db.invoices.find_one(
            {"id": conv_iid, "company_id": company_id},
            {"qbo_id": 1, "_id": 0},
        )
        if inv and inv.get("qbo_id"):
            body["LinkedTxn"] = [{"TxnType": "Invoice",
                                    "TxnId": str(inv["qbo_id"])}]
    return body


def _local_patch_from_qbo_estimate(twin: dict) -> dict:
    total = float(twin.get("TotalAmt") or 0)
    patch: dict[str, Any] = {
        "total": round(total, 2),
    }
    if twin.get("TxnDate"):
        patch["issue_date"] = twin["TxnDate"]
    if twin.get("ExpirationDate"):
        patch["expiration_date"] = twin["ExpirationDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _push_estimates(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for e in db.estimates.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _estimate_body(company_id, e)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/estimate", body,
            )
            twin = resp.get("Estimate") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": e["id"], "number": e.get("number"),
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_estimate(twin)
            await db.estimates.update_one(
                {"id": e["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": e["id"], "number": e.get("number"),
                            "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Purchase Order push (Phase 3) ─────────────────────────────────
# POs share Bill's AccountBasedExpenseLineDetail structure. Key
# differences: `APAccountRef` isn't required (QBO defaults), and
# there's a `POStatus` field.

_PO_STATUS_TO_QBO = {
    "open":      "Open",
    "closed":    "Closed",
    "converted": "Closed",
}


async def _po_body(company_id: str, po: dict) -> dict:
    """QBO PurchaseOrder payload. Same line shape as bills."""
    vendor = await _resolve_vendor_ref(company_id, po.get("contact_id"))
    if not vendor:
        raise ValueError(
            "Vendor missing or not synced to QBO. Sync vendors first.")
    lines_out: list[dict] = []
    fallback: tuple[str, str] | None = None
    for idx, li in enumerate(po.get("line_items") or [], start=1):
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
                    "fallback QBO expense account exists.")
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
        raise ValueError("Purchase order has no line items.")

    body: dict[str, Any] = {
        "VendorRef": {"value": vendor[0], "name": vendor[1]},
        "Line": lines_out,
    }
    if po.get("issue_date"):
        body["TxnDate"] = po["issue_date"]
    if po.get("due_date"):
        body["DueDate"] = po["due_date"]
    if po.get("number"):
        body["DocNumber"] = str(po["number"])[:21]
    if po.get("internal_notes"):
        body["PrivateNote"] = str(po["internal_notes"])[:4000]
    if po.get("notes"):
        body["Memo"] = str(po["notes"])[:1000]
    qbo_status = _PO_STATUS_TO_QBO.get((po.get("status") or "").lower())
    if qbo_status:
        body["POStatus"] = qbo_status
    # If this PO was converted to a bill locally, link the two in QBO
    # so the PO shows its resulting bill (matches QBO's native
    # "Convert to bill" behaviour).
    conv_bid = po.get("converted_bill_id")
    if conv_bid:
        bill = await db.bills.find_one(
            {"id": conv_bid, "company_id": company_id},
            {"qbo_id": 1, "_id": 0},
        )
        if bill and bill.get("qbo_id"):
            body["LinkedTxn"] = [{"TxnType": "Bill",
                                    "TxnId": str(bill["qbo_id"])}]
    return body


def _local_patch_from_qbo_po(twin: dict) -> dict:
    total = float(twin.get("TotalAmt") or 0)
    patch: dict[str, Any] = {
        "total": round(total, 2),
    }
    if twin.get("TxnDate"):
        patch["issue_date"] = twin["TxnDate"]
    if twin.get("DueDate"):
        patch["due_date"] = twin["DueDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _push_purchase_orders(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for p in db.purchase_orders.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _po_body(company_id, p)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/purchaseorder", body,
            )
            twin = resp.get("PurchaseOrder") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": p["id"], "number": p.get("number"),
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_po(twin)
            await db.purchase_orders.update_one(
                {"id": p["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": p["id"], "number": p.get("number"),
                            "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Purchase push (Phase 4) ───────────────────────────────────────
# QBO "Purchase" covers cash / check / credit-card spending that
# bypasses the AP workflow (no Bill created). Common examples: coffee
# on a business card, SaaS subscription auto-charged. Local Purchases
# live in the shared `db.transactions` collection with
# `txn_type: "Purchase"`. QBO uses `PaymentType` (Cash|Check|CreditCard)
# and `AccountRef` for the source bank/CC account.

_PURCHASE_PAYMENT_TYPES = {"cash", "check", "creditcard"}


async def _purchase_body(company_id: str, txn: dict) -> dict:
    """QBO Purchase payload. Requires:
      - `bank_account_id` → source bank/CC/asset account (AccountRef)
      - `contact_id` (optional) → vendor entity (EntityRef)
      - `line_items[]` with `expense_account_id` + `amount` each
    """
    src_acct = await _resolve_account_ref(
        company_id, txn.get("bank_account_id"))
    if not src_acct:
        raise ValueError(
            "Source account (bank/credit-card) missing or not synced "
            "to QBO. Set `bank_account_id` before pushing.")

    lines_out: list[dict] = []
    fallback: tuple[str, str] | None = None
    for idx, li in enumerate(txn.get("line_items") or [], start=1):
        amount = float(li.get("amount") or 0)
        description = (li.get("description") or "").strip()
        acct = await _resolve_account_ref(
            company_id, li.get("expense_account_id")
            or li.get("category_account_id"))
        if not acct:
            if fallback is None:
                fallback = await _default_expense_account_qbo(company_id)
            if not fallback:
                raise ValueError(
                    f"Line {idx} has no expense account and no "
                    "fallback QBO expense account exists.")
            acct = fallback
        lines_out.append({
            "DetailType": "AccountBasedExpenseLineDetail",
            "Amount": round(abs(amount), 2),
            "Description": description,
            "AccountBasedExpenseLineDetail": {
                "AccountRef": {"value": acct[0], "name": acct[1]},
            },
        })
    if not lines_out:
        raise ValueError("Purchase has no line items.")

    payment_type = (txn.get("payment_type") or "Cash").strip()
    if payment_type.lower() not in _PURCHASE_PAYMENT_TYPES:
        payment_type = "Cash"
    # Normalize casing (QBO expects PascalCase).
    payment_type = {"cash": "Cash", "check": "Check",
                     "creditcard": "CreditCard"}[payment_type.lower()]

    body: dict[str, Any] = {
        "AccountRef": {"value": src_acct[0], "name": src_acct[1]},
        "PaymentType": payment_type,
        "Line": lines_out,
    }
    # Optional vendor entity.
    if txn.get("contact_id"):
        vend = await _resolve_vendor_ref(company_id, txn["contact_id"])
        if vend:
            body["EntityRef"] = {"value": vend[0], "name": vend[1],
                                  "type": "Vendor"}
    if txn.get("date"):
        body["TxnDate"] = txn["date"]
    if txn.get("number"):
        body["DocNumber"] = str(txn["number"])[:21]
    if txn.get("memo") or txn.get("notes"):
        body["PrivateNote"] = str(txn.get("memo")
                                    or txn.get("notes"))[:4000]
    # Refund vs charge: `direction: "in"` means money coming back
    # (vendor refund). QBO exposes this via `Credit=true`.
    if txn.get("direction") == "in" or txn.get("credit"):
        body["Credit"] = True
    return body


def _local_patch_from_qbo_purchase(twin: dict) -> dict:
    """Fields QBO stamps back on a Purchase we just pushed. Preserves
    the local `amount` sign convention (negative for outflows)."""
    total = float(twin.get("TotalAmt") or 0)
    is_credit = bool(twin.get("Credit"))
    signed = abs(total) if is_credit else -abs(total)
    patch: dict[str, Any] = {
        "amount": round(signed, 2),
        "direction": "in" if is_credit else "out",
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    if twin.get("PaymentType"):
        patch["payment_type"] = twin["PaymentType"]
    return patch


async def _push_purchases(company_id: str, realm_id: str) -> dict:
    """Push local-only purchases (transactions with
    txn_type='Purchase' and no qbo_id) to QBO."""
    inserted = 0
    failed: list[dict] = []
    async for t in db.transactions.find(
        {"company_id": company_id, "txn_type": "Purchase",
          "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _purchase_body(company_id, t)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/purchase", body,
            )
            twin = resp.get("Purchase") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": t["id"], "number": t.get("number"),
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_purchase(twin)
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": t["id"], "number": t.get("number"),
                            "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Customer-ref resolver (for SalesReceipt) ─────────────────────
# (Note: `_resolve_vendor_ref` above is contact-agnostic — same lookup
# works for customers because our contacts collection stores both
# with a `kind` field. We alias here for readability at call sites.)
_resolve_customer_ref = _resolve_vendor_ref


async def _default_income_item_qbo(company_id: str,
                                     category_account_id: str | None = None
                                     ) -> tuple[str, str] | None:
    """QBO SalesReceipt lines require an ItemRef. Manual transactions
    only carry a `category_account_id` (income account), so we need
    to find an Item that maps revenue to that account. Falls back to
    the first available active service item if none matches."""
    if category_account_id:
        it = await db.items.find_one(
            {"company_id": company_id,
              "income_account_id": category_account_id,
              "qbo_id": {"$exists": True, "$ne": None},
              "active": {"$ne": False}},
            {"qbo_id": 1, "name": 1, "_id": 0},
        )
        if it and it.get("qbo_id"):
            return (str(it["qbo_id"]), it.get("name") or "")
    it = await db.items.find_one(
        {"company_id": company_id,
          "qbo_id": {"$exists": True, "$ne": None},
          "active": {"$ne": False}},
        {"qbo_id": 1, "name": 1, "_id": 0},
        sort=[("name", 1)],
    )
    if it and it.get("qbo_id"):
        return (str(it["qbo_id"]), it.get("name") or "Item")
    return None


# ─── SalesReceipt push (Phase 4b) ──────────────────────────────────
# Customer paid same-day, no invoice. QBO shape:
#   CustomerRef (required), DepositToAccountRef (required),
#   Line[] each with SalesItemLineDetail → ItemRef.

async def _sales_receipt_body(company_id: str, txn: dict) -> dict:
    """QBO SalesReceipt payload from a local transactions doc."""
    if not txn.get("contact_id"):
        raise ValueError(
            "SalesReceipt requires a customer. Set `contact_id` on the "
            "transaction, or use a Deposit if there's no customer.")
    cust = await _resolve_customer_ref(company_id, txn.get("contact_id"))
    if not cust:
        raise ValueError(
            "Customer not synced to QBO. Sync customers first.")
    dep_acct = await _resolve_account_ref(
        company_id, txn.get("bank_account_id"))
    if not dep_acct:
        raise ValueError(
            "Deposit-to account (bank) missing or not synced to QBO.")

    lines_out: list[dict] = []
    item_cache: tuple[str, str] | None = None
    src_lines = (txn.get("line_items") or [{
        "amount": abs(float(txn.get("amount") or 0)),
        "description": txn.get("description") or "",
        "category_account_id": txn.get("category_account_id"),
    }])
    for idx, li in enumerate(src_lines, start=1):
        amount = abs(float(li.get("amount") or 0))
        description = (li.get("description") or "").strip()
        # Prefer an explicit item on the line, then look up an item
        # by the local income category, then fall back to any item.
        item_ref: tuple[str, str] | None = None
        if li.get("item_id"):
            it = await db.items.find_one(
                {"id": li["item_id"], "company_id": company_id},
                {"qbo_id": 1, "name": 1, "_id": 0},
            )
            if it and it.get("qbo_id"):
                item_ref = (str(it["qbo_id"]), it.get("name") or "")
        if not item_ref:
            if item_cache is None:
                item_cache = await _default_income_item_qbo(
                    company_id, li.get("category_account_id")
                    or txn.get("category_account_id"))
            item_ref = item_cache
        if not item_ref:
            raise ValueError(
                f"Line {idx}: no QBO-synced service/product item is "
                "available to book this receipt against. Create at "
                "least one Item first.")
        lines_out.append({
            "DetailType": "SalesItemLineDetail",
            "Amount": round(amount, 2),
            "Description": description,
            "SalesItemLineDetail": {
                "ItemRef": {"value": item_ref[0], "name": item_ref[1]},
                "Qty": 1,
                "UnitPrice": round(amount, 2),
            },
        })
    body: dict[str, Any] = {
        "CustomerRef": {"value": cust[0], "name": cust[1]},
        "DepositToAccountRef": {"value": dep_acct[0], "name": dep_acct[1]},
        "Line": lines_out,
    }
    if txn.get("date"):
        body["TxnDate"] = txn["date"]
    if txn.get("number"):
        body["DocNumber"] = str(txn["number"])[:21]
    if txn.get("memo") or txn.get("notes"):
        body["PrivateNote"] = str(txn.get("memo")
                                    or txn.get("notes"))[:4000]
    if txn.get("payment_method_qbo_id"):
        body["PaymentMethodRef"] = {"value": str(txn["payment_method_qbo_id"])}
    return body


def _local_patch_from_qbo_sales_receipt(twin: dict) -> dict:
    """Fields QBO stamps back on a SalesReceipt we just pushed."""
    patch: dict[str, Any] = {
        "amount": round(float(twin.get("TotalAmt") or 0), 2),
        "direction": "in",
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _push_sales_receipts(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for t in db.transactions.find(
        {"company_id": company_id, "txn_type": "SalesReceipt",
          "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _sales_receipt_body(company_id, t)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/salesreceipt", body,
            )
            twin = resp.get("SalesReceipt") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": t["id"], "number": t.get("number"),
                                "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_sales_receipt(twin)
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": t["id"], "number": t.get("number"),
                            "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Deposit push (Phase 4b) ───────────────────────────────────────
# Bank inflows WITHOUT a customer: owner contributions, interest,
# tax refunds, transfers in. QBO shape:
#   DepositToAccountRef (required),
#   Line[] each with DepositLineDetail → AccountRef (source income/other).

async def _deposit_body(company_id: str, txn: dict) -> dict:
    dep_acct = await _resolve_account_ref(
        company_id, txn.get("bank_account_id"))
    if not dep_acct:
        raise ValueError(
            "Deposit-to account (bank) missing or not synced to QBO.")

    lines_out: list[dict] = []
    src_lines = (txn.get("line_items") or [{
        "amount": abs(float(txn.get("amount") or 0)),
        "description": txn.get("description") or "",
        "category_account_id": txn.get("category_account_id"),
    }])
    for idx, li in enumerate(src_lines, start=1):
        amount = abs(float(li.get("amount") or 0))
        description = (li.get("description") or "").strip()
        acct = await _resolve_account_ref(
            company_id, li.get("category_account_id")
            or li.get("expense_account_id"))
        if not acct:
            raise ValueError(
                f"Line {idx}: source account (income or other) not "
                "set or not synced to QBO.")
        # QBO also needs an EntityRef for the source vendor/customer
        # if one is known; optional.
        line_body: dict[str, Any] = {
            "DetailType": "DepositLineDetail",
            "Amount": round(amount, 2),
            "Description": description,
            "DepositLineDetail": {
                "AccountRef": {"value": acct[0], "name": acct[1]},
            },
        }
        if txn.get("contact_id"):
            ent = await _resolve_vendor_ref(company_id, txn["contact_id"])
            if ent:
                # Deposit's EntityRef supports Customer/Vendor/Employee.
                # We use the contact's `kind` in practice, but for the
                # generic case Customer is fine — QBO auto-picks.
                line_body["DepositLineDetail"]["Entity"] = {
                    "value": ent[0], "name": ent[1], "type": "Customer",
                }
        lines_out.append(line_body)
    body: dict[str, Any] = {
        "DepositToAccountRef": {"value": dep_acct[0], "name": dep_acct[1]},
        "Line": lines_out,
    }
    if txn.get("date"):
        body["TxnDate"] = txn["date"]
    if txn.get("memo") or txn.get("notes"):
        body["PrivateNote"] = str(txn.get("memo")
                                    or txn.get("notes"))[:4000]
    return body


def _local_patch_from_qbo_deposit(twin: dict) -> dict:
    patch: dict[str, Any] = {
        "amount": round(float(twin.get("TotalAmt") or 0), 2),
        "direction": "in",
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    return patch


async def _push_deposits(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for t in db.transactions.find(
        {"company_id": company_id, "txn_type": "Deposit",
          "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _deposit_body(company_id, t)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/deposit", body,
            )
            twin = resp.get("Deposit") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": t["id"], "error": "no Id in QBO response"})
                continue
            twin_patch = _local_patch_from_qbo_deposit(twin)
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": t["id"], "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── CreditMemo push (Phase 4c) ────────────────────────────────────
# Customer credit that reduces future invoice balance. No cash side.
# QBO shape: CustomerRef, Line[] with SalesItemLineDetail.ItemRef.

async def _credit_memo_body(company_id: str, txn: dict) -> dict:
    if not txn.get("contact_id"):
        raise ValueError(
            "CreditMemo requires a customer. Set `contact_id`.")
    cust = await _resolve_customer_ref(company_id, txn.get("contact_id"))
    if not cust:
        raise ValueError("Customer not synced to QBO.")
    lines_out: list[dict] = []
    item_cache: tuple[str, str] | None = None
    src_lines = (txn.get("line_items") or [{
        "amount": abs(float(txn.get("amount") or 0)),
        "description": txn.get("description") or "",
        "category_account_id": txn.get("category_account_id"),
    }])
    for idx, li in enumerate(src_lines, start=1):
        amount = abs(float(li.get("amount") or 0))
        description = (li.get("description") or "").strip()
        item_ref: tuple[str, str] | None = None
        if li.get("item_id"):
            it = await db.items.find_one(
                {"id": li["item_id"], "company_id": company_id},
                {"qbo_id": 1, "name": 1, "_id": 0},
            )
            if it and it.get("qbo_id"):
                item_ref = (str(it["qbo_id"]), it.get("name") or "")
        if not item_ref:
            if item_cache is None:
                item_cache = await _default_income_item_qbo(
                    company_id, li.get("category_account_id")
                    or txn.get("category_account_id"))
            item_ref = item_cache
        if not item_ref:
            raise ValueError(
                f"Line {idx}: no QBO-synced item available.")
        lines_out.append({
            "DetailType": "SalesItemLineDetail",
            "Amount": round(amount, 2),
            "Description": description,
            "SalesItemLineDetail": {
                "ItemRef": {"value": item_ref[0], "name": item_ref[1]},
                "Qty": 1,
                "UnitPrice": round(amount, 2),
            },
        })
    body: dict[str, Any] = {
        "CustomerRef": {"value": cust[0], "name": cust[1]},
        "Line": lines_out,
    }
    if txn.get("date"):
        body["TxnDate"] = txn["date"]
    if txn.get("number"):
        body["DocNumber"] = str(txn["number"])[:21]
    if txn.get("memo") or txn.get("notes"):
        body["PrivateNote"] = str(txn.get("memo")
                                    or txn.get("notes"))[:4000]
    return body


def _local_patch_from_qbo_credit_memo(twin: dict) -> dict:
    patch: dict[str, Any] = {
        "amount": round(float(twin.get("TotalAmt") or 0), 2),
        "direction": "in",  # credit reduces receivable → net effect in
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _push_credit_memos(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for t in db.transactions.find(
        {"company_id": company_id, "txn_type": "CreditMemo",
          "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _credit_memo_body(company_id, t)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/creditmemo", body,
            )
            twin = resp.get("CreditMemo") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": t["id"], "error": "no Id"})
                continue
            twin_patch = _local_patch_from_qbo_credit_memo(twin)
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": t["id"], "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── RefundReceipt push (Phase 4c) ─────────────────────────────────
# Cash refund to a customer. QBO shape: CustomerRef,
# DepositToAccountRef (source of cash — inverse of SalesReceipt),
# Line[] with SalesItemLineDetail.ItemRef.

async def _refund_receipt_body(company_id: str, txn: dict) -> dict:
    if not txn.get("contact_id"):
        raise ValueError(
            "RefundReceipt requires a customer. Set `contact_id`.")
    cust = await _resolve_customer_ref(company_id, txn.get("contact_id"))
    if not cust:
        raise ValueError("Customer not synced to QBO.")
    src_acct = await _resolve_account_ref(
        company_id, txn.get("bank_account_id"))
    if not src_acct:
        raise ValueError(
            "Source account (bank) missing or not synced to QBO.")
    lines_out: list[dict] = []
    item_cache: tuple[str, str] | None = None
    src_lines = (txn.get("line_items") or [{
        "amount": abs(float(txn.get("amount") or 0)),
        "description": txn.get("description") or "",
        "category_account_id": txn.get("category_account_id"),
    }])
    for idx, li in enumerate(src_lines, start=1):
        amount = abs(float(li.get("amount") or 0))
        description = (li.get("description") or "").strip()
        item_ref: tuple[str, str] | None = None
        if li.get("item_id"):
            it = await db.items.find_one(
                {"id": li["item_id"], "company_id": company_id},
                {"qbo_id": 1, "name": 1, "_id": 0},
            )
            if it and it.get("qbo_id"):
                item_ref = (str(it["qbo_id"]), it.get("name") or "")
        if not item_ref:
            if item_cache is None:
                item_cache = await _default_income_item_qbo(
                    company_id, li.get("category_account_id")
                    or txn.get("category_account_id"))
            item_ref = item_cache
        if not item_ref:
            raise ValueError(
                f"Line {idx}: no QBO-synced item available.")
        lines_out.append({
            "DetailType": "SalesItemLineDetail",
            "Amount": round(amount, 2),
            "Description": description,
            "SalesItemLineDetail": {
                "ItemRef": {"value": item_ref[0], "name": item_ref[1]},
                "Qty": 1,
                "UnitPrice": round(amount, 2),
            },
        })
    body: dict[str, Any] = {
        "CustomerRef": {"value": cust[0], "name": cust[1]},
        "DepositToAccountRef": {"value": src_acct[0], "name": src_acct[1]},
        "Line": lines_out,
    }
    if txn.get("date"):
        body["TxnDate"] = txn["date"]
    if txn.get("number"):
        body["DocNumber"] = str(txn["number"])[:21]
    if txn.get("memo") or txn.get("notes"):
        body["PrivateNote"] = str(txn.get("memo")
                                    or txn.get("notes"))[:4000]
    return body


def _local_patch_from_qbo_refund_receipt(twin: dict) -> dict:
    # RefundReceipt is a cash outflow to a customer → negative local
    # amount, direction "out".
    total = float(twin.get("TotalAmt") or 0)
    patch: dict[str, Any] = {
        "amount": -round(abs(total), 2),
        "direction": "out",
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    return patch


async def _push_refund_receipts(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for t in db.transactions.find(
        {"company_id": company_id, "txn_type": "RefundReceipt",
          "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _refund_receipt_body(company_id, t)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/refundreceipt", body,
            )
            twin = resp.get("RefundReceipt") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": t["id"], "error": "no Id"})
                continue
            twin_patch = _local_patch_from_qbo_refund_receipt(twin)
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": t["id"], "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Transfer push (Phase 4d — last transactional entity) ──────────
# Bank-to-bank movement. QBO shape:
#   FromAccountRef, ToAccountRef, Amount, TxnDate, PrivateNote.
# No line items — a Transfer is a single credit + single debit.

async def _transfer_body(company_id: str, txn: dict) -> dict:
    from_acct = await _resolve_account_ref(
        company_id, txn.get("bank_account_id"))
    if not from_acct:
        raise ValueError(
            "Source account (from) missing or not synced to QBO.")
    to_acct = await _resolve_account_ref(
        company_id, txn.get("transfer_to_account_id"))
    if not to_acct:
        raise ValueError(
            "Destination account (to) missing or not synced to QBO.")
    amount = abs(float(txn.get("amount") or 0))
    if amount == 0:
        raise ValueError("Transfer amount must be non-zero.")
    body: dict[str, Any] = {
        "FromAccountRef": {"value": from_acct[0], "name": from_acct[1]},
        "ToAccountRef":   {"value": to_acct[0],   "name": to_acct[1]},
        "Amount": round(amount, 2),
    }
    if txn.get("date"):
        body["TxnDate"] = txn["date"]
    if txn.get("memo") or txn.get("notes") or txn.get("description"):
        body["PrivateNote"] = str(txn.get("memo") or txn.get("notes")
                                    or txn.get("description"))[:4000]
    return body


def _local_patch_from_qbo_transfer(twin: dict) -> dict:
    patch: dict[str, Any] = {
        "amount": round(abs(float(twin.get("Amount") or 0)), 2),
        "direction": "transfer",
    }
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    return patch


async def _push_transfers(company_id: str, realm_id: str) -> dict:
    inserted = 0
    failed: list[dict] = []
    async for t in db.transactions.find(
        {"company_id": company_id, "txn_type": "Transfer",
          "source": {"$ne": "qbo"},
         "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}]},
    ):
        try:
            body = await _transfer_body(company_id, t)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/transfer", body,
            )
            twin = resp.get("Transfer") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": t["id"], "error": "no Id"})
                continue
            twin_patch = _local_patch_from_qbo_transfer(twin)
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {**twin_patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": t["id"], "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}


# ─── Inventory Adjustments ────────────────────────────────────────
# Outbound push for local-only inventory adjustments — the doc lives
# in `journal_entries` with `source=SOURCE_ADJUSTMENT` (see
# `inventory_service.apply_adjustment`). QBO's `InventoryAdjustment`
# entity carries QtyDiff per item + a single AdjustAccountRef contra,
# so we invert the local `inventory_adjustment_lines` payload back
# into that shape at push time.

async def _inventory_adjustment_body(company_id: str, doc: dict) -> dict:
    """Build a QBO InventoryAdjustment payload from a local
    `journal_entries` doc created by `inventory_service.apply_adjustment`.

    Local shape stores `inventory_adjustment_lines: [{item_id, qty_diff,
    cost, value}]` (the "priced" trail) plus a `contra_account_id`
    pointing at the local Inventory Adjustments expense account. We
    reverse this into QBO's shape:
      Line: [{ItemAdjustmentLineDetail: {QtyDiff, ItemRef}}, ...]
      AdjustAccountRef: {value: <qbo id>}
    """
    # Locate the contra account's QBO id. Prefer the explicit
    # `contra_account_id` on the doc; fall back to scanning the JE's
    # lines for the non-Inventory account.
    contra_ref = None
    contra_id = doc.get("contra_account_id")
    if not contra_id:
        for ln in doc.get("lines") or []:
            aid = ln.get("account_id")
            if aid and (doc.get("inventory_account_id") is None
                          or aid != doc.get("inventory_account_id")):
                contra_id = aid
                break
    if contra_id:
        acct = await db.accounts.find_one(
            {"id": contra_id, "company_id": company_id})
        if acct and acct.get("qbo_id"):
            contra_ref = {"value": str(acct["qbo_id"]),
                          "name": acct.get("name") or ""}
    if not contra_ref:
        raise ValueError(
            "Contra account (Inventory Adjustments) not synced to QBO. "
            "Push the accounts first, then re-fire the adjustment.")
    # Prefer the priced lines (they carry item_id + qty_diff); fall
    # back to reconstructing from generic JE lines is not attempted —
    # too ambiguous.
    priced = (doc.get("inventory_adjustment_lines")
               or doc.get("inventory_adjustment_priced_lines") or [])
    if not priced:
        raise ValueError("No inventory adjustment lines on the doc.")
    lines: list[dict] = []
    for ln in priced:
        item_qbo_id = ln.get("item_qbo_id")
        if not item_qbo_id and ln.get("item_id"):
            it = await db.items.find_one(
                {"id": ln["item_id"], "company_id": company_id})
            if it and it.get("qbo_id"):
                item_qbo_id = str(it["qbo_id"])
        if not item_qbo_id:
            # Item not synced to QBO yet — the CPA must push items
            # first. Skip rather than fail the whole adjustment.
            continue
        qty = float(ln.get("qty_diff") or 0)
        if qty == 0:
            continue
        lines.append({
            "DetailType": "ItemAdjustmentLineDetail",
            "ItemAdjustmentLineDetail": {
                "ItemRef": {"value": item_qbo_id,
                              "name": ln.get("item_name") or ""},
                "QtyDiff": qty,
            },
            "Description": ln.get("description") or doc.get("memo") or "",
        })
    if not lines:
        raise ValueError(
            "Every adjustment line references an item not yet synced to QBO.")
    body: dict[str, Any] = {
        "AdjustAccountRef": contra_ref,
        "Line": lines,
    }
    if doc.get("date"):
        body["TxnDate"] = doc["date"]
    if doc.get("memo"):
        body["PrivateNote"] = str(doc["memo"])[:4000]
    if doc.get("number"):
        body["DocNumber"] = str(doc["number"])[:21]  # QBO limit
    return body


def _local_patch_from_qbo_inventory_adjustment(twin: dict) -> dict:
    """Twin patch — mirror QBO's authoritative echo back onto the
    local JE after a successful push (in case QBO renamed DocNumber,
    or adjusted TxnDate to something else)."""
    patch: dict[str, Any] = {}
    if twin.get("DocNumber"):
        patch["number"] = twin["DocNumber"]
    if twin.get("TxnDate"):
        patch["date"] = twin["TxnDate"]
    return patch


async def _push_inventory_adjustments(
    company_id: str, realm_id: str,
) -> dict:
    """Push every locally-created inventory adjustment that hasn't
    been mirrored yet. Scan is scoped by `source=SOURCE_ADJUSTMENT`
    (matches `inventory_service.SOURCE_ADJUSTMENT`)."""
    inserted = 0
    failed: list[dict] = []
    async for doc in db.journal_entries.find({
        "company_id": company_id,
        "source": "adjustment",
        "$or": [{"qbo_id": {"$exists": False}},
                 {"qbo_id": {"$in": [None, ""]}}],
    }):
        try:
            body = await _inventory_adjustment_body(company_id, doc)
            resp = await _post(
                company_id, realm_id,
                f"/company/{realm_id}/inventoryadjustment", body,
            )
            twin = resp.get("InventoryAdjustment") or {}
            new_id = twin.get("Id")
            if not new_id:
                failed.append({"id": doc["id"], "error": "no Id"})
                continue
            patch = _local_patch_from_qbo_inventory_adjustment(twin)
            await db.journal_entries.update_one(
                {"id": doc["id"], "company_id": company_id},
                {"$set": {**patch,
                          "qbo_id": str(new_id), "realm_id": realm_id,
                          "_sync_origin": "mirror_push",
                          "_sync_status": "synced",
                          "updated_at": now_iso()}},
            )
            inserted += 1
        except Exception as ex:  # noqa: BLE001
            failed.append({"id": doc["id"], "error": str(ex)[:400]})
    return {"inserted": inserted, "failed": failed}



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
                     "invoices", "bills", "payments", "bill_payments",
                     "journal_entries", "estimates", "purchase_orders",
                     "purchases", "sales_receipts", "deposits",
                     "credit_memos", "refund_receipts", "transfers",
                     "inventory_adjustments"]

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
            elif e == "payments":
                result[e] = await _push_payments_in(company_id, realm_id)
            elif e == "bill_payments":
                result[e] = await _push_payments_out(company_id, realm_id)
            elif e == "journal_entries":
                result[e] = await _push_journal_entries(company_id, realm_id)
            elif e == "estimates":
                result[e] = await _push_estimates(company_id, realm_id)
            elif e == "purchase_orders":
                result[e] = await _push_purchase_orders(company_id, realm_id)
            elif e == "purchases":
                result[e] = await _push_purchases(company_id, realm_id)
            elif e == "sales_receipts":
                result[e] = await _push_sales_receipts(company_id, realm_id)
            elif e == "deposits":
                result[e] = await _push_deposits(company_id, realm_id)
            elif e == "credit_memos":
                result[e] = await _push_credit_memos(company_id, realm_id)
            elif e == "refund_receipts":
                result[e] = await _push_refund_receipts(company_id, realm_id)
            elif e == "transfers":
                result[e] = await _push_transfers(company_id, realm_id)
            elif e == "inventory_adjustments":
                result[e] = await _push_inventory_adjustments(
                    company_id, realm_id)
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
