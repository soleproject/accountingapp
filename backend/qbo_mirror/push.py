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
        entities = ["accounts", "customers", "vendors", "items"]

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
