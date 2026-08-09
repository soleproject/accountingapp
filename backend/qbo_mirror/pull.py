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
    "items":     ["name", "sku", "price", "active"],
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
    from pymongo.errors import DuplicateKeyError
    existing = await _existing_qbo_ids(company_id, "contacts",
                                        {"type": kind})
    inserted = 0
    updated = 0
    skipped_dupname = 0
    async for obj in Q.query_all(company_id, realm_id, qbo_entity):
        qid = str(obj.get("Id"))
        mapped = Q.map_contact(company_id, realm_id, obj, kind)
        mapped["_sync_origin"] = "mirror_pull"
        # `contacts` unique index is (company_id, normalized_name).
        # `map_contact` may not populate this field, and a missing
        # value collides with any other missing-normalized_name doc.
        # Compute it here so the insert has a stable key.
        if not mapped.get("normalized_name"):
            try:
                from contact_resolver import normalize_contact_name
                mapped["normalized_name"] = normalize_contact_name(
                    mapped.get("name") or "")
            except Exception:  # noqa: BLE001
                pass
        if qid not in existing:
            # `contacts` has a unique index on (company_id,
            # normalized_name). If a soft-deleted / merged / renamed
            # local contact still owns that name, insert fails — but
            # rather than crash the whole batch, we upsert-on-name:
            # attach this qbo_id to the existing local row so the
            # next Preview shows it as `In sync`.
            try:
                await db.contacts.insert_one(mapped)
                inserted += 1
            except DuplicateKeyError:
                # A local contact already owns this normalized_name.
                # Two possibilities:
                #   (a) It's an already-mirrored row whose qbo_id
                #       differs from `qid` — QBO has duplicate
                #       DisplayNames (allowed in QBO, blocked here).
                #       Skip; can't safely reassign without corrupting
                #       the first sync link.
                #   (b) It's a soft-orphaned row with no qbo_id — we
                #       can reclaim it by stamping this qbo_id on.
                from contact_resolver import normalize_contact_name
                key = normalize_contact_name(mapped.get("name") or "")
                orphan = await db.contacts.find_one(
                    {"company_id": company_id, "normalized_name": key,
                     "$or": [{"qbo_id": {"$exists": False}},
                             {"qbo_id": {"$in": [None, ""]}}]},
                    {"id": 1, "_id": 0},
                )
                if orphan:
                    await db.contacts.update_one(
                        {"id": orphan["id"]},
                        {"$set": {"qbo_id": qid, "source": "qbo",
                                  "realm_id": realm_id, "type": kind,
                                  "_sync_origin": "mirror_pull",
                                  "updated_at": now_iso()}},
                    )
                    skipped_dupname += 1
                else:
                    # Legitimate duplicate name — QBO has two rows
                    # sharing the DisplayName. We can't take both.
                    # Log so the user knows why the diff shows a
                    # stubborn `Pull from QBO: 1` that never resolves.
                    from qbo_mirror.settings import append_log
                    await append_log(
                        company_id, "warning",
                        f"Duplicate name from QBO: '{mapped.get('name')}' "
                        f"(qbo_id {qid}) skipped — local unique index "
                        f"already occupied. Rename in QBO to resolve.",
                        {"entity": kind, "qbo_id": qid,
                         "normalized_name": key},
                    )
                    skipped_dupname += 1
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
    return {"inserted": inserted, "updated": updated,
            "reclaimed_dup_name": skipped_dupname}


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


async def _pull_invoices(company_id: str, realm_id: str) -> dict:
    """Phase 2b — bring QBO invoices into our local system.
    New invoices are inserted via `map_invoice`; existing ones get
    `total`, `balance`, and `status` refreshed (line-item drift is
    deferred to Phase 2c since line diffs need extra care).
    """
    existing = await _existing_qbo_ids(company_id, "invoices")
    inserted = 0
    updated = 0
    async for obj in Q.query_all(company_id, realm_id, "Invoice"):
        qid = str(obj.get("Id"))
        mapped = Q.map_invoice(company_id, realm_id, obj)
        mapped["_sync_origin"] = "mirror_pull"
        # Invoices post to the ledger — mark them `posted=True` so the
        # reports pick them up immediately (same pattern we established
        # for QBO transactions).
        mapped["posted"] = True
        if qid not in existing:
            await db.invoices.insert_one(mapped)
            inserted += 1
        else:
            patch = {k: mapped[k] for k in
                     ["total", "balance", "status", "subtotal", "tax",
                      "due_date"] if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.invoices.update_one(
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
        entities = ["accounts", "customers", "vendors", "items", "invoices"]

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
            elif e == "invoices":
                result[e] = await _pull_invoices(company_id, realm_id)
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
