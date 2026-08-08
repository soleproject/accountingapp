"""Phase 1b — Pull-only executor.

Inbound sync only. For each Foundation entity we:
  1. Query QBO for every row.
  2. For missing rows (no matching local doc by qbo_id), INSERT via
     the existing `qbo_service.map_*` functions — reuses the exact
     shape the initial migration produces so downstream code sees no
     schema difference.
  3. For drifted rows (matched by qbo_id, values differ), UPDATE the
     drifted fields — `QBO Wins` policy: whatever QBO has is truth.

Every insert/update carries `_sync_origin: "mirror_pull"` so Phase 2
outbound writes ignore it and no ping-pong loop forms.

Never touches the ledger (transactions / invoices / bills / payments).
Only Foundation entities: accounts, customers, vendors, items.
"""
from __future__ import annotations
from typing import Any

from db import db, now_iso
import qbo_service as Q
from qbo_mirror.settings import append_log


# ─── Which fields we consider "syncable" for drift updates ─────────
# Fewer fields than the diff detector — we only overwrite the columns
# QBO is authoritative for. Structural fields (parent_account_id,
# qbo_type, source, etc.) are set at insert time and never changed.
_UPDATE_FIELDS = {
    "accounts":  ["name", "type", "subtype", "active"],
    "customers": ["name", "email", "phone", "active", "address"],
    "vendors":   ["name", "email", "phone", "active", "address"],
    "items":     ["name", "sku", "unit_price", "active"],
}


async def _existing_qbo_ids(company_id: str, coll: str,
                             extra: dict | None = None) -> set[str]:
    q = {"company_id": company_id, "source": "qbo"}
    if extra:
        q.update(extra)
    ids: set[str] = set()
    async for d in db[coll].find(q, {"qbo_id": 1, "_id": 0}):
        if d.get("qbo_id"):
            ids.add(str(d["qbo_id"]))
    return ids


async def _pull_accounts(company_id: str, realm_id: str) -> dict:
    existing = await _existing_qbo_ids(company_id, "accounts")
    inserted = 0
    updated = 0
    async for obj in Q.query_all(company_id, realm_id, "Account"):
        qid = str(obj.get("Id"))
        mapped = Q.map_account(company_id, realm_id, obj)
        mapped["_sync_origin"] = "mirror_pull"
        if qid not in existing:
            await db.accounts.insert_one(mapped)
            inserted += 1
        else:
            # Drift update — only rewrite the syncable fields.
            patch = {k: mapped[k] for k in _UPDATE_FIELDS["accounts"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.accounts.update_one(
                {"company_id": company_id, "source": "qbo", "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
    return {"inserted": inserted, "updated": updated}


async def _pull_contacts(company_id: str, realm_id: str,
                          kind: str, qbo_entity: str) -> dict:
    existing = await _existing_qbo_ids(company_id, "contacts",
                                        {"type": kind})
    inserted = 0
    updated = 0
    async for obj in Q.query_all(company_id, realm_id, qbo_entity):
        qid = str(obj.get("Id"))
        mapped = Q.map_contact(company_id, realm_id, obj, kind)
        mapped["_sync_origin"] = "mirror_pull"
        if qid not in existing:
            await db.contacts.insert_one(mapped)
            inserted += 1
        else:
            patch = {k: mapped[k] for k in _UPDATE_FIELDS[f"{kind}s"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.contacts.update_one(
                {"company_id": company_id, "source": "qbo",
                 "type": kind, "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
    return {"inserted": inserted, "updated": updated}


async def _pull_items(company_id: str, realm_id: str) -> dict:
    existing = await _existing_qbo_ids(company_id, "items")
    inserted = 0
    updated = 0
    async for obj in Q.query_all(company_id, realm_id, "Item"):
        qid = str(obj.get("Id"))
        mapped = Q.map_item(company_id, realm_id, obj)
        mapped["_sync_origin"] = "mirror_pull"
        if qid not in existing:
            await db.items.insert_one(mapped)
            inserted += 1
        else:
            patch = {k: mapped[k] for k in _UPDATE_FIELDS["items"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.items.update_one(
                {"company_id": company_id, "source": "qbo", "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
    return {"inserted": inserted, "updated": updated}


async def run_pull(company_id: str, user_email: str,
                    entities: list[str] | None = None) -> dict:
    """Execute a Pull for each Foundation entity in `entities`
    (default: all four). Never touches the ledger."""
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
                result[e] = await _pull_accounts(company_id, realm_id)
            elif e == "customers":
                result[e] = await _pull_contacts(company_id, realm_id,
                                                  "customer", "Customer")
            elif e == "vendors":
                result[e] = await _pull_contacts(company_id, realm_id,
                                                  "vendor", "Vendor")
            elif e == "items":
                result[e] = await _pull_items(company_id, realm_id)
        except Exception as err:  # noqa: BLE001
            result[e] = {"error": str(err)}

    totals = {
        "inserted": sum(v.get("inserted", 0) for v in result.values()
                        if isinstance(v, dict)),
        "updated":  sum(v.get("updated", 0)  for v in result.values()
                        if isinstance(v, dict)),
    }
    await append_log(company_id, "mirror_pull",
                     f"Pull by {user_email}: {totals}",
                     {"totals": totals, "per_entity": result,
                      "realm_id": realm_id})
    return {"totals": totals, "per_entity": result, "realm_id": realm_id}
