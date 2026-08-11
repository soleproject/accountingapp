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
    # Items — QBO Wins on everything except our editable `usage` flag.
    # Inventory fields must be in this list so a re-pull picks up
    # `qty_on_hand`, `cost`, `track_qty_on_hand`, and the linked
    # accounts on rows that migrated *before* the Feb 21 2026
    # inventory-fields patch shipped.
    "items":     ["name", "sku", "price", "active", "cost",
                   "type", "item_type", "description",
                   "income_account_qbo_id", "expense_account_qbo_id",
                   "asset_account_qbo_id",
                   "track_qty_on_hand", "qty_on_hand",
                   "quantity_on_hand",
                   "reorder_point", "inv_start_date"],
}


async def _existing_qbo_ids(company_id: str, coll: str,
                             extra: dict | None = None,
                             any_source: bool = False) -> set[str]:
    """Return the set of qbo_ids already known locally. By default
    limits to `source: "qbo"` (rows brought in by a prior Pull), but
    `any_source=True` also includes local-origin rows that were pushed
    to QBO and now carry a qbo_id — needed for invoices/bills where
    the row is authored locally but still has a QBO twin."""
    q: dict = {"company_id": company_id}
    if not any_source:
        q["source"] = "qbo"
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
        # Resolve QBO account refs → local account IDs so the local
        # inventory system (`inventory_service.py`) can find them.
        # Feb 21 2026: previously we stored only the QBO ids, which
        # meant JE builders (apply_adjustment / cogs) had no local
        # id to post against and the Inventory page's `track_inventory`
        # filter never matched. Also flip on `track_inventory` (the
        # internal app flag — separate from QBO's `TrackQtyOnHand`)
        # for real inventory items so they light up the Inventory
        # Management screen.
        if mapped.get("asset_account_qbo_id"):
            inv_acct = await db.accounts.find_one({
                "company_id": company_id, "source": "qbo",
                "qbo_id": mapped["asset_account_qbo_id"],
            })
            if inv_acct:
                mapped["inventory_account_id"] = inv_acct["id"]
                mapped["inventory_account_name"] = inv_acct.get("name")
        if mapped.get("expense_account_qbo_id"):
            cogs_acct = await db.accounts.find_one({
                "company_id": company_id, "source": "qbo",
                "qbo_id": mapped["expense_account_qbo_id"],
            })
            if cogs_acct:
                mapped["cogs_account_id"] = cogs_acct["id"]
                mapped["expense_account_id"] = cogs_acct["id"]
        if mapped.get("income_account_qbo_id"):
            inc_acct = await db.accounts.find_one({
                "company_id": company_id, "source": "qbo",
                "qbo_id": mapped["income_account_qbo_id"],
            })
            if inc_acct:
                mapped["income_account_id"] = inc_acct["id"]
        # Internal `track_inventory` flag — powers the Inventory page's
        # visibility filter. Enabled when QBO tagged this as an
        # Inventory-typed item (QtyOnHand tracking on).
        mapped["track_inventory"] = (
            (mapped.get("item_type") or "").lower() == "inventory"
            or bool(mapped.get("track_qty_on_hand")))
        if qid not in existing:
            await db.items.insert_one(mapped)
            inserted += 1
        else:
            patch = {k: mapped[k] for k in _UPDATE_FIELDS["items"]
                     if k in mapped}
            # Also flow the resolved local ids on updates so re-pulls
            # heal items that migrated before this patch shipped.
            for k in ("inventory_account_id", "inventory_account_name",
                       "cogs_account_id", "expense_account_id",
                       "income_account_id", "track_inventory"):
                if k in mapped:
                    patch[k] = mapped[k]
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.items.update_one(
                {"company_id": company_id, "source": "qbo", "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
    return {"inserted": inserted, "updated": updated}


async def _pull_invoices(company_id: str, realm_id: str) -> dict:
    """Phase 2b/c — bring QBO invoices into our local system.
    New invoices are inserted via `map_invoice`; existing ones get
    `total`, `balance`, `status`, and `line_items` refreshed
    (QBO Wins policy). Matches by qbo_id across BOTH source='qbo'
    and locally-pushed rows so drift on an invoice we ourselves
    originated flows back correctly. If no qbo_id match is found,
    falls back to natural key (DocNumber) so a locally-created row
    sharing the same number gets linked (and patched) rather than
    duplicated.
    """
    existing = await _existing_qbo_ids(company_id, "invoices",
                                        any_source=True)
    inserted = 0
    updated = 0
    reclaimed = 0
    async for obj in Q.query_all(company_id, realm_id, "Invoice"):
        qid = str(obj.get("Id"))
        mapped = Q.map_invoice(company_id, realm_id, obj)
        mapped["_sync_origin"] = "mirror_pull"
        # Invoices post to the ledger — mark them `posted=True` so the
        # reports pick them up immediately (same pattern we established
        # for QBO transactions).
        mapped["posted"] = True

        # ── QBO Wins patch (used by both drift-by-qbo_id and
        # drift-by-natural-key branches).
        patch = {k: mapped[k] for k in
                 ["total", "balance", "status", "subtotal", "tax",
                  "due_date", "issue_date", "line_items"]
                 if k in mapped}
        if "balance" in mapped:
            patch["balance_due"] = mapped["balance"]
        patch["_sync_origin"] = "mirror_pull"
        patch["updated_at"] = now_iso()

        if qid in existing:
            # Direct qbo_id linkage — update the local twin.
            await db.invoices.update_one(
                {"company_id": company_id, "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
            continue

        # No qbo_id linkage yet — try to reclaim a locally-authored
        # row whose DocNumber matches this QBO invoice's number.
        number = (mapped.get("number") or "").strip()
        orphan = None
        if number:
            orphan = await db.invoices.find_one(
                {"company_id": company_id, "number": number,
                 "$or": [{"qbo_id": {"$exists": False}},
                         {"qbo_id": {"$in": [None, ""]}}]},
                {"id": 1, "_id": 0},
            )
        if orphan:
            # Reclaim: attach the qbo_id + apply drift patch. Preserve
            # the local `id` so payment links / attachments survive.
            reclaim_patch = {**patch,
                             "qbo_id": qid, "realm_id": realm_id}
            await db.invoices.update_one(
                {"id": orphan["id"]},
                {"$set": reclaim_patch},
            )
            reclaimed += 1
        else:
            await db.invoices.insert_one(mapped)
            inserted += 1

    return {"inserted": inserted, "updated": updated,
            "reclaimed": reclaimed}


async def _pull_bills(company_id: str, realm_id: str) -> dict:
    """Phase 2d — bring QBO bills into our local system. Mirror of
    `_pull_invoices` — matches by qbo_id first, then by DocNumber
    (reclaim), else insert. QBO Wins overwrite of totals + lines."""
    existing = await _existing_qbo_ids(company_id, "bills",
                                        any_source=True)
    inserted = 0
    updated = 0
    reclaimed = 0
    async for obj in Q.query_all(company_id, realm_id, "Bill"):
        qid = str(obj.get("Id"))
        mapped = Q.map_bill(company_id, realm_id, obj)
        mapped["_sync_origin"] = "mirror_pull"
        mapped["posted"] = True

        patch = {k: mapped[k] for k in
                 ["total", "balance", "status", "due_date",
                  "issue_date", "line_items"]
                 if k in mapped}
        if "balance" in mapped:
            patch["balance_due"] = mapped["balance"]
        patch["_sync_origin"] = "mirror_pull"
        patch["updated_at"] = now_iso()

        if qid in existing:
            await db.bills.update_one(
                {"company_id": company_id, "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
            continue

        number = (mapped.get("number") or "").strip()
        orphan = None
        if number:
            orphan = await db.bills.find_one(
                {"company_id": company_id, "number": number,
                 "$or": [{"qbo_id": {"$exists": False}},
                         {"qbo_id": {"$in": [None, ""]}}]},
                {"id": 1, "_id": 0},
            )
        if orphan:
            reclaim_patch = {**patch,
                             "qbo_id": qid, "realm_id": realm_id}
            await db.bills.update_one(
                {"id": orphan["id"]},
                {"$set": reclaim_patch},
            )
            reclaimed += 1
        else:
            await db.bills.insert_one(mapped)
            inserted += 1

    return {"inserted": inserted, "updated": updated,
            "reclaimed": reclaimed}


async def _pull_payments(company_id: str, realm_id: str,
                          direction: str, qbo_entity: str) -> dict:
    """Pull Payment (in) or BillPayment (out) rows from QBO into
    the local `payments` collection. Matches by qbo_id + direction
    (we can have same numeric Id across the two QBO endpoints)."""
    existing_key = f"{qbo_entity}::"
    existing: set[str] = set()
    async for d in db.payments.find(
        {"company_id": company_id, "direction": direction,
         "qbo_id": {"$nin": [None, ""]}},
        {"qbo_id": 1, "_id": 0},
    ):
        existing.add(str(d["qbo_id"]))

    inserted = 0
    updated = 0
    async for obj in Q.query_all(company_id, realm_id, qbo_entity):
        qid = str(obj.get("Id"))
        mapped = Q.map_payment(company_id, realm_id, obj, direction)
        mapped["_sync_origin"] = "mirror_pull"
        # Link `applied_to` (QBO's LinkedTxn) to our local
        # invoice/bill ids so the balance-heal in list endpoints
        # can find these payments. Resolves TxnId → local id via
        # invoices.qbo_id / bills.qbo_id lookup.
        applied = mapped.get("applied_to") or []
        for ap in applied:
            tx_type = ap.get("txn_type")
            tx_qbo_id = ap.get("txn_qbo_id")
            if not tx_qbo_id:
                continue
            if tx_type == "Invoice":
                inv = await db.invoices.find_one(
                    {"company_id": company_id, "qbo_id": str(tx_qbo_id)},
                    {"id": 1, "_id": 0},
                )
                if inv and not mapped.get("linked_invoice_id"):
                    mapped["linked_invoice_id"] = inv["id"]
            elif tx_type == "Bill":
                b = await db.bills.find_one(
                    {"company_id": company_id, "qbo_id": str(tx_qbo_id)},
                    {"id": 1, "_id": 0},
                )
                if b and not mapped.get("linked_bill_id"):
                    mapped["linked_bill_id"] = b["id"]

        if qid in existing:
            patch = {k: mapped[k] for k in
                     ["amount", "date", "method", "contact_name",
                      "linked_invoice_id", "linked_bill_id",
                      "applied_to"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.payments.update_one(
                {"company_id": company_id, "direction": direction,
                 "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
        else:
            await db.payments.insert_one(mapped)
            inserted += 1
    return {"inserted": inserted, "updated": updated}


async def _pull_inventory_adjustments(
    company_id: str, realm_id: str,
) -> dict:
    """Pull QBO `InventoryAdjustment` transactions and materialize
    them as `journal_entries` rows priced against the local items
    collection's cost basis.

    Why store as JEs? Two reasons:
      1. Existing Balance Sheet / P&L reports scan `journal_entries`
         already, so the audit trail rolls up for free.
      2. The mirror push story for outbound adjustments (Phase 6+)
         can shape the same doc back into a QBO InventoryAdjustment
         payload — one storage shape, two directions of flow.

    Missing item cost → line skipped and logged; we don't want to
    post a $0 leg that would silently zero out the JE total.
    """
    existing = await _existing_qbo_ids(
        company_id, "journal_entries",
        extra={"source": "qbo_inv_adj"})
    # Load 1300 Inventory Asset up front — every adjustment posts
    # against it, no point re-fetching per row.
    inv_asset = await db.accounts.find_one(
        {"company_id": company_id, "code": "1300"})
    if not inv_asset:
        return {"error": "No 1300 Inventory Asset account seeded",
                "inserted": 0, "updated": 0}
    inserted = 0
    updated = 0
    skipped = 0
    skip_reasons: dict[str, int] = {}
    seen = 0
    async for obj in Q.query_all(
        company_id, realm_id, "InventoryAdjustment",
    ):
        seen += 1
        qid = str(obj.get("Id"))
        mapped = Q.map_inventory_adjustment(company_id, realm_id, obj)
        # Resolve contra account (AdjustAccountRef → local account).
        contra = None
        if mapped["adjust_account_qbo_id"]:
            contra = await db.accounts.find_one({
                "company_id": company_id, "source": "qbo",
                "qbo_id": mapped["adjust_account_qbo_id"],
            })
        # Price each line at the local item's cost — the value
        # signed by QtyDiff sign gives us the debit/credit split.
        # Fallback chain: local item.cost → QBO line.Amount (rare
        # but populated when QBO computed a value at save time).
        priced_lines = []
        net_dollars = 0.0
        raw_lines = obj.get("Line") or []
        for i, ln in enumerate(mapped["inventory_adjustment_lines"]):
            item = None
            if ln["item_qbo_id"]:
                item = await db.items.find_one({
                    "company_id": company_id, "source": "qbo",
                    "qbo_id": ln["item_qbo_id"],
                })
            cost = float((item or {}).get("cost") or 0)
            qty = float(ln["qty_diff"] or 0)
            # QBO occasionally populates `Amount` on the line itself
            # — usually only for pre-QBO-Online adjustments migrated
            # from Desktop. Use it as a last-resort fallback.
            if cost <= 0 and i < len(raw_lines):
                amt_fallback = float(raw_lines[i].get("Amount") or 0)
                if amt_fallback and qty:
                    cost = round(abs(amt_fallback / qty), 4)
            if cost <= 0 or qty == 0:
                continue
            value = round(abs(qty) * cost, 2)
            priced_lines.append({
                "item_id": (item or {}).get("id"),
                "item_qbo_id": ln["item_qbo_id"],
                "item_name": ln["item_name"],
                "qty_diff": qty, "cost": cost,
                "value": value if qty > 0 else -value,
            })
            net_dollars += value if qty > 0 else -value
        # Build a balanced two-legged JE only if there's real value
        # to record. `net_dollars > 0` means inventory grew (write-
        # up); `< 0` means it shrunk (writedown).
        if net_dollars == 0 or not priced_lines:
            skipped += 1
            reason = ("no_priced_lines" if not priced_lines
                       else "zero_net_dollars")
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
            # Diagnostic log — helps production debugging when the
            # migration banner shows "Inv adjustments: 0" despite
            # QBO showing a non-zero preview count.
            import logging
            logging.getLogger(__name__).info(
                "InventoryAdjustment %s skipped (%s): "
                "raw_lines=%d priced=%d net=$%.2f contra=%s",
                qid, reason, len(raw_lines), len(priced_lines),
                net_dollars, mapped["adjust_account_name"] or "?")
            continue
        abs_val = abs(round(net_dollars, 2))
        if net_dollars > 0:  # inventory INCREASED
            debit_leg = {"account_id": inv_asset["id"],
                          "account_code": inv_asset.get("code"),
                          "account_name": inv_asset.get("name"),
                          "debit": abs_val, "credit": 0}
            credit_leg = {"account_id": (contra or {}).get("id"),
                           "account_code": (contra or {}).get("code"),
                           "account_name": (contra or {}).get("name")
                            or mapped["adjust_account_name"],
                           "debit": 0, "credit": abs_val}
        else:                # inventory DECREASED
            credit_leg = {"account_id": inv_asset["id"],
                           "account_code": inv_asset.get("code"),
                           "account_name": inv_asset.get("name"),
                           "debit": 0, "credit": abs_val}
            debit_leg = {"account_id": (contra or {}).get("id"),
                          "account_code": (contra or {}).get("code"),
                          "account_name": (contra or {}).get("name")
                           or mapped["adjust_account_name"],
                          "debit": abs_val, "credit": 0}
        mapped["lines"] = [debit_leg, credit_leg]
        mapped["total_debit"] = abs_val
        mapped["total_credit"] = abs_val
        mapped["posted"] = True
        mapped["human_reviewed"] = True
        mapped["_sync_origin"] = "mirror_pull"
        mapped["inventory_adjustment_priced_lines"] = priced_lines
        if qid not in existing:
            try:
                await db.journal_entries.insert_one(mapped)
                inserted += 1
            except Exception:  # noqa: BLE001
                # DuplicateKey under race — treat as an update instead.
                await db.journal_entries.update_one(
                    {"company_id": company_id, "source": "qbo_inv_adj",
                      "qbo_id": qid},
                    {"$set": mapped},
                )
                updated += 1
        else:
            await db.journal_entries.update_one(
                {"company_id": company_id, "source": "qbo_inv_adj",
                  "qbo_id": qid},
                {"$set": {**mapped,
                            "updated_at": now_iso()}},
            )
            updated += 1
    return {"inserted": inserted, "updated": updated,
             "skipped": skipped, "seen": seen,
             "skip_reasons": skip_reasons}



async def _pull_journal_entries(company_id: str, realm_id: str) -> dict:
    """Phase 2f — bring QBO Journal Entries into local. Matches
    by qbo_id. Resolves each line's QBO AccountRef back to the
    local account_id so downstream reports can group by our
    account UUIDs without a name-based join."""
    existing = await _existing_qbo_ids(company_id, "journal_entries",
                                        any_source=True)
    inserted = 0
    updated = 0
    async for obj in Q.query_all(company_id, realm_id, "JournalEntry"):
        qid = str(obj.get("Id"))
        mapped = Q.map_journal_entry(company_id, realm_id, obj)
        mapped["_sync_origin"] = "mirror_pull"
        # Resolve each line's account_qbo_id → local account_id so
        # our reports don't have to join on name.
        for ln in mapped.get("lines") or []:
            aq = ln.get("account_qbo_id")
            if not aq:
                continue
            a = await db.accounts.find_one(
                {"company_id": company_id, "qbo_id": str(aq)},
                {"id": 1, "_id": 0},
            )
            if a:
                ln["account_id"] = a["id"]
        if qid in existing:
            patch = {k: mapped[k] for k in
                     ["date", "memo", "lines", "total_debit",
                      "total_credit", "number"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.journal_entries.update_one(
                {"company_id": company_id, "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
        else:
            await db.journal_entries.insert_one(mapped)
            inserted += 1
    return {"inserted": inserted, "updated": updated}


async def _pull_estimates(company_id: str, realm_id: str) -> dict:
    """Phase 3 — bring QBO Estimates local. QBO Wins on drift.

    Defensive against unique-key collisions: QBO permits duplicate
    DocNumbers on estimates (four rows can all say "1001"), so if a
    legacy local unique index ever blocks the insert we log + skip
    rather than crashing the batch. Orphan rows without a qbo_id
    that happen to own the same natural key get adopted so a future
    dry-run reports `In sync` for them."""
    from pymongo.errors import DuplicateKeyError
    existing = await _existing_qbo_ids(company_id, "estimates",
                                        any_source=True)
    inserted = 0
    updated = 0
    skipped_dupkey = 0
    async for obj in Q.query_all(company_id, realm_id, "Estimate"):
        qid = str(obj.get("Id"))
        # QBO Estimate → local shape (structured similar to invoice
        # but with expiration_date instead of due_date).
        mapped = {
            "id": f"qbo-{company_id[:8]}-estimate-{qid}",
            "company_id": company_id,
            "qbo_id": qid, "realm_id": realm_id, "source": "qbo",
            "number": (obj.get("DocNumber") or "").strip()
                       or f"EST-{qid}",
            "contact_id": None,
            "contact_name": ((obj.get("CustomerRef") or {})
                              .get("name") or ""),
            "contact_qbo_id": ((obj.get("CustomerRef") or {})
                                .get("value")),
            "issue_date": obj.get("TxnDate") or "",
            "expiration_date": obj.get("ExpirationDate") or "",
            "total": round(float(obj.get("TotalAmt") or 0), 2),
            "status": {
                "Pending": "sent", "Accepted": "accepted",
                "Rejected": "rejected", "Closed": "closed",
            }.get(obj.get("TxnStatus") or "", "sent"),
            "notes": ((obj.get("CustomerMemo") or {}).get("value")
                       or ""),
            "internal_notes": obj.get("PrivateNote") or "",
            "line_items": [
                {"description": ln.get("Description") or "",
                  "amount": float(ln.get("Amount") or 0),
                  "quantity": float(((ln.get("SalesItemLineDetail")
                                        or {}).get("Qty")) or 1),
                  "rate": float(((ln.get("SalesItemLineDetail")
                                    or {}).get("UnitPrice")) or 0),
                  "item_qbo_id": ((ln.get("SalesItemLineDetail")
                                     or {}).get("ItemRef") or {})
                                  .get("value")}
                for ln in (obj.get("Line") or [])
                if ln.get("DetailType") == "SalesItemLineDetail"
            ],
            "_sync_origin": "mirror_pull",
            "created_at": now_iso(), "updated_at": now_iso(),
        }
        # Resolve contact_qbo_id → local contact_id.
        c = await db.contacts.find_one(
            {"company_id": company_id,
             "qbo_id": mapped["contact_qbo_id"]},
            {"id": 1, "_id": 0},
        )
        if c:
            mapped["contact_id"] = c["id"]
        if qid in existing:
            patch = {k: mapped[k] for k in
                     ["total", "status", "expiration_date",
                      "issue_date", "line_items", "contact_id"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.estimates.update_one(
                {"company_id": company_id, "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
        else:
            try:
                await db.estimates.insert_one(mapped)
                inserted += 1
            except DuplicateKeyError:
                # A local estimate already owns a key (e.g. legacy
                # unique on (company_id, number)). QBO permits
                # duplicate DocNumbers on estimates — try to adopt
                # an existing orphan (no qbo_id) or skip with a
                # loud log entry the user can act on.
                orphan = await db.estimates.find_one(
                    {"company_id": company_id,
                      "number": mapped.get("number"),
                      "$or": [{"qbo_id": {"$exists": False}},
                              {"qbo_id": {"$in": [None, ""]}}]},
                    {"id": 1, "_id": 0},
                )
                if orphan:
                    await db.estimates.update_one(
                        {"id": orphan["id"]},
                        {"$set": {"qbo_id": qid, "source": "qbo",
                                  "realm_id": realm_id,
                                  "_sync_origin": "mirror_pull",
                                  "updated_at": now_iso()}},
                    )
                    skipped_dupkey += 1
                else:
                    from qbo_mirror.settings import append_log
                    await append_log(
                        company_id, "warning",
                        f"Duplicate estimate number from QBO: "
                        f"'{mapped.get('number')}' (qbo_id {qid}) "
                        "skipped — local unique index already "
                        "occupied. Drop the estimates(number) "
                        "unique index to allow duplicates.",
                        {"entity": "estimate", "qbo_id": qid,
                         "number": mapped.get("number")},
                    )
                    skipped_dupkey += 1
    return {"inserted": inserted, "updated": updated,
             "skipped_dupkey": skipped_dupkey}


async def _pull_purchase_orders(company_id: str, realm_id: str) -> dict:
    """Phase 3 — bring QBO Purchase Orders local. QBO Wins on drift.

    Same duplicate-key resilience as `_pull_estimates` — QBO permits
    duplicate DocNumbers so we adopt orphans by (company_id, number)
    when possible and skip-with-log otherwise."""
    from pymongo.errors import DuplicateKeyError
    existing = await _existing_qbo_ids(company_id, "purchase_orders",
                                        any_source=True)
    inserted = 0
    updated = 0
    skipped_dupkey = 0
    async for obj in Q.query_all(company_id, realm_id, "PurchaseOrder"):
        qid = str(obj.get("Id"))
        mapped = {
            "id": f"qbo-{company_id[:8]}-po-{qid}",
            "company_id": company_id,
            "qbo_id": qid, "realm_id": realm_id, "source": "qbo",
            "number": (obj.get("DocNumber") or "").strip()
                       or f"PO-{qid}",
            "contact_id": None,
            "contact_name": ((obj.get("VendorRef") or {})
                              .get("name") or ""),
            "contact_qbo_id": ((obj.get("VendorRef") or {})
                                .get("value")),
            "issue_date": obj.get("TxnDate") or "",
            "due_date": obj.get("DueDate") or "",
            "total": round(float(obj.get("TotalAmt") or 0), 2),
            "status": {"Open": "open", "Closed": "closed"}.get(
                obj.get("POStatus") or "", "open"),
            "notes": obj.get("Memo") or "",
            "internal_notes": obj.get("PrivateNote") or "",
            "line_items": [
                {"description": ln.get("Description") or "",
                  "amount": float(ln.get("Amount") or 0),
                  "account_qbo_id": ((ln.get(
                      "AccountBasedExpenseLineDetail") or {})
                      .get("AccountRef") or {}).get("value")}
                for ln in (obj.get("Line") or [])
                if ln.get("DetailType")
                    == "AccountBasedExpenseLineDetail"
            ],
            "_sync_origin": "mirror_pull",
            "created_at": now_iso(), "updated_at": now_iso(),
        }
        # Resolve contact_qbo_id → local contact_id + line account_id.
        c = await db.contacts.find_one(
            {"company_id": company_id,
             "qbo_id": mapped["contact_qbo_id"]},
            {"id": 1, "_id": 0},
        )
        if c:
            mapped["contact_id"] = c["id"]
        for ln in mapped["line_items"]:
            if ln.get("account_qbo_id"):
                a = await db.accounts.find_one(
                    {"company_id": company_id,
                     "qbo_id": ln["account_qbo_id"]},
                    {"id": 1, "_id": 0},
                )
                if a:
                    ln["expense_account_id"] = a["id"]
        if qid in existing:
            patch = {k: mapped[k] for k in
                     ["total", "status", "due_date", "issue_date",
                      "line_items", "contact_id"]
                     if k in mapped}
            patch["_sync_origin"] = "mirror_pull"
            patch["updated_at"] = now_iso()
            await db.purchase_orders.update_one(
                {"company_id": company_id, "qbo_id": qid},
                {"$set": patch},
            )
            updated += 1
        else:
            try:
                await db.purchase_orders.insert_one(mapped)
                inserted += 1
            except DuplicateKeyError:
                orphan = await db.purchase_orders.find_one(
                    {"company_id": company_id,
                      "number": mapped.get("number"),
                      "$or": [{"qbo_id": {"$exists": False}},
                              {"qbo_id": {"$in": [None, ""]}}]},
                    {"id": 1, "_id": 0},
                )
                if orphan:
                    await db.purchase_orders.update_one(
                        {"id": orphan["id"]},
                        {"$set": {"qbo_id": qid, "source": "qbo",
                                  "realm_id": realm_id,
                                  "_sync_origin": "mirror_pull",
                                  "updated_at": now_iso()}},
                    )
                    skipped_dupkey += 1
                else:
                    from qbo_mirror.settings import append_log
                    await append_log(
                        company_id, "warning",
                        f"Duplicate PO number from QBO: "
                        f"'{mapped.get('number')}' (qbo_id {qid}) "
                        "skipped — local unique index already "
                        "occupied. Drop the purchase_orders(number) "
                        "unique index to allow duplicates.",
                        {"entity": "purchase_order", "qbo_id": qid,
                         "number": mapped.get("number")},
                    )
                    skipped_dupkey += 1
    return {"inserted": inserted, "updated": updated,
             "skipped_dupkey": skipped_dupkey}


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
        entities = ["accounts", "customers", "vendors", "items",
                     "invoices", "bills", "payments", "bill_payments",
                     "journal_entries", "estimates", "purchase_orders",
                     "inventory_adjustments"]

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
            elif e == "bills":
                result[e] = await _pull_bills(company_id, realm_id)
            elif e == "payments":
                result[e] = await _pull_payments(
                    company_id, realm_id, "in", "Payment")
            elif e == "bill_payments":
                result[e] = await _pull_payments(
                    company_id, realm_id, "out", "BillPayment")
            elif e == "journal_entries":
                result[e] = await _pull_journal_entries(company_id, realm_id)
            elif e == "estimates":
                result[e] = await _pull_estimates(company_id, realm_id)
            elif e == "purchase_orders":
                result[e] = await _pull_purchase_orders(company_id, realm_id)
            elif e == "inventory_adjustments":
                result[e] = await _pull_inventory_adjustments(
                    company_id, realm_id)
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
