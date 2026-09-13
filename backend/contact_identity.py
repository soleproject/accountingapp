"""Contact-identity hardening — Feb 2026 rewrite.

Adds three primitives the older contacts pipeline lacked:

1. **Entry-door provenance** (`entry_source`) — which door did this contact
   walk through? `plaid` | `invoice` | `bill` | `manual` | `directory`
   | `p2p_enriched` | `veryfi` | `migrated` | `unknown`. Used to rank
   cross-source duplicate proposals highest (a Plaid contact + an AP
   vendor with matching name is almost certainly the same real entity;
   two Plaid contacts with matching name is a weaker signal because
   they came through the same door).

2. **Pseudo-contact flag** (`is_pseudo_contact`) — bank-fee placeholder
   rows carry the BANK's name as their contact (`Wells Fargo`, `Chase`,
   `Bank of America`, `Zelle`, `Venmo`) so reports don't crash on
   `contact_id: null`. These aren't real counterparties and must NEVER
   be included in merge / split / cross-source-dedup proposals.

3. **Audit log + undo** (`contact_identity_events` collection) — every
   merge, split, rename, and entity-ID stamp writes an append-only
   event that carries all the state needed to reverse it. Merges are
   irreversible-at-scale operations; without this, a bad auto-merge
   would be unrecoverable.

Sibling module: `contact_resolver.py` for the runtime resolution path.
This module owns the durable identity metadata + audit trail.
"""
from __future__ import annotations
import re
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

from deps import db


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Pseudo-contact detection
# ---------------------------------------------------------------------------
# Contacts stamped with these normalized names are placeholders — the
# transaction was a bank fee / interest / transfer / P2P memo where the
# real counterparty isn't identifiable, and we labelled it with the
# bank/rail as a fall-back so the ledger stays balanced.
#
# Detection is case-insensitive and normalized-name-based. Anything
# matched here is EXCLUDED from merge proposals, split proposals, the
# Contact Pairing Auditor, and cross-source AR/AP matching.
_PSEUDO_CONTACT_KEYS = frozenset({
    # Banks (bank-fee / interest rows)
    "wells fargo", "wells fargo bank", "chase", "chase bank", "bank of america",
    "bofa", "us bank", "citibank", "capital one bank", "pnc bank", "truist",
    "regions bank", "fifth third", "huntington bank", "keybank", "td bank",
    "hsbc", "santander", "usaa bank",
    # P2P / rails (memo-only rows where we couldn't extract the recipient)
    "zelle", "venmo", "paypal", "cash app", "cashapp", "apple pay", "apple cash",
    "google pay", "wise", "revolut", "chime", "sendwave", "remitly", "xoom",
    "western union", "moneygram",
    # Card / wire generic
    "ach", "wire transfer", "checkcard", "check", "atm",
})


def is_pseudo_contact_name(name: str | None) -> bool:
    """True when a normalized-name matches the pseudo-contact set.
    Callers use this at write time to stamp `is_pseudo_contact: True`
    on the contact document so downstream identity work can skip it."""
    if not name:
        return False
    from contact_resolver import normalize_contact_name  # local import — cycle
    key = normalize_contact_name(name)
    return key in _PSEUDO_CONTACT_KEYS


# ---------------------------------------------------------------------------
# Entry-source classifier
# ---------------------------------------------------------------------------

# Legacy `source` field on contacts records the RESOLUTION PATH (how the
# contact resolver got here — merchant_name, ai_new, global_directory,
# etc.). `entry_source` records the ENTRY DOOR (which top-level product
# created the contact — Plaid ingest, an invoice, an AP bill, manual
# creation, a data migration). Kept as two separate fields because they
# answer different questions and both are useful.

_RESOLUTION_SOURCE_TO_ENTRY = {
    "merchant_name":      "plaid",
    "ai_new":             "plaid",
    "ai_match":           "plaid",
    "global_directory":   "plaid",
    "p2p_enriched":       "plaid",
    "user_rule":          "manual",
    "veryfi":             "veryfi",
    "veryfi_bank_fee":    "veryfi",
    "manual":             "manual",
    "auto":               "unknown",
}


def entry_source_from_resolution_source(source: str | None) -> str:
    """Derive an entry-door label from the legacy resolution-path `source`
    field. Used by the backfill so we don't have to re-ingest every
    historical contact."""
    if not source:
        return "unknown"
    return _RESOLUTION_SOURCE_TO_ENTRY.get(source, "unknown")


# ---------------------------------------------------------------------------
# Audit log (contact_identity_events)
# ---------------------------------------------------------------------------
# Shape (all fields required unless noted optional):
#   id:                   uuid
#   company_id:           uuid
#   kind:                 "merge" | "split" | "rename" | "stamp_entity_id"
#                       | "flag_pseudo"
#   created_at:           iso timestamp
#   actor:                email or "system"
#   keeper_id:            surviving contact id (for merge/rename)
#   loser_ids:            list of contact ids being merged away (for merge)
#   split_child_ids:      list of new contact ids created (for split)
#   affected_txn_ids:     list of transaction ids reassigned
#   affected_docs:        {invoices: [...], bills: [...], payments: [...], receipts: [...]}
#   before:               {contacts: [full doc, ...]} — restored on undo
#   evidence:             freeform dict — normalized_name match, entity_id
#                         mismatch, AR/AP amount+date match, etc.
#   undone_at:            iso timestamp | null
#   undone_by:            email | null

async def record_identity_event(
    *,
    company_id: str,
    kind: str,
    actor: str,
    keeper_id: str | None = None,
    loser_ids: list[str] | None = None,
    split_child_ids: list[str] | None = None,
    affected_txn_ids: list[str] | None = None,
    affected_docs: dict | None = None,
    before: dict | None = None,
    evidence: dict | None = None,
) -> dict:
    """Append an event to `contact_identity_events`. Never fails silently
    — callers rely on the returned event id for undo linkage."""
    doc = {
        "id":                str(uuid.uuid4()),
        "company_id":        company_id,
        "kind":              kind,
        "created_at":        now_iso(),
        "actor":             actor,
        "keeper_id":         keeper_id,
        "loser_ids":         loser_ids or [],
        "split_child_ids":   split_child_ids or [],
        "affected_txn_ids":  affected_txn_ids or [],
        "affected_docs":     affected_docs or {},
        "before":            before or {},
        "evidence":          evidence or {},
        "undone_at":         None,
        "undone_by":         None,
    }
    await db.contact_identity_events.insert_one(doc)
    return doc


async def undo_identity_event(event_id: str, *, actor: str) -> dict:
    """Reverse a previously-recorded identity event. Only supports
    `merge` today — split-undo (rejoin split children back into one
    contact) is out of scope until we implement splits.

    For a merge:
      * Restore the loser contact rows from `before.contacts`.
      * Reassign every transaction/invoice/bill/payment/receipt back to
        its `original_contact_id` (which we preserved at merge time —
        the whole point of preserving it).
      * Recompute contact learning implicitly (our learning is derived
        on read, not cached — no cache to bust).
      * Stamp the event as `undone`.
    """
    event = await db.contact_identity_events.find_one({"id": event_id})
    if not event:
        raise ValueError(f"identity event not found: {event_id}")
    if event.get("undone_at"):
        raise ValueError(f"identity event already undone: {event_id}")
    if event["kind"] != "merge":
        raise ValueError(f"undo not implemented for event kind {event['kind']!r}")

    cid = event["company_id"]
    before_contacts = (event.get("before") or {}).get("contacts") or []

    # Restore loser contact rows (they were deleted at merge time).
    if before_contacts:
        try:
            await db.contacts.insert_many(before_contacts, ordered=False)
        except Exception:  # noqa: BLE001 — some may already exist from a partial undo
            for c in before_contacts:
                await db.contacts.update_one(
                    {"id": c["id"], "company_id": cid},
                    {"$setOnInsert": c},
                    upsert=True,
                )

    # Reassign every affected doc back to its `original_contact_id`.
    reassigned = {}
    for coll in ("transactions", "invoices", "bills", "payments", "receipts"):
        rows = await db[coll].find(
            {"company_id": cid, "id": {"$in": (event.get("affected_docs") or {}).get(coll, [])}}
        ).to_list(20000)
        n = 0
        for r in rows:
            orig = r.get("original_contact_id")
            if not orig or orig == r.get("contact_id"):
                continue
            # Restore the loser's name too so the row reads correctly
            loser = next((c for c in before_contacts if c["id"] == orig), None)
            await db[coll].update_one(
                {"id": r["id"], "company_id": cid},
                {"$set": {
                    "contact_id":   orig,
                    "contact_name": (loser or {}).get("name") or r.get("contact_name"),
                    "updated_at":   now_iso(),
                }},
            )
            n += 1
        reassigned[coll] = n

    # Learning cache — same pattern
    lc = await db.contact_learning_cache.find(
        {"company_id": cid, "contact_id": event["keeper_id"]}
    ).to_list(2000)
    lc_moved = 0
    for row in lc:
        orig = row.get("original_contact_id")
        if orig and orig != row["contact_id"]:
            await db.contact_learning_cache.update_one(
                {"id": row["id"]}, {"$set": {"contact_id": orig}},
            )
            lc_moved += 1

    # Cache invalidation
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    await db.contact_identity_events.update_one(
        {"id": event_id},
        {"$set": {"undone_at": now_iso(), "undone_by": actor,
                  "undo_reassigned": reassigned, "undo_lc_moved": lc_moved}},
    )
    return {"ok": True, "event_id": event_id, "reassigned": reassigned,
            "learning_cache_reassigned": lc_moved,
            "restored_contacts": len(before_contacts)}


# ---------------------------------------------------------------------------
# Retroactive false-merge detection — the section 1d "backfill" pass
# ---------------------------------------------------------------------------

async def detect_false_merges(cid: str, limit: int = 200) -> list[dict]:
    """Scan the company's contacts for the false-merge signature: one
    contact whose transaction history carries MULTIPLE distinct
    `merchant_entity_id` values. Each such contact is a candidate split
    — two real vendors got collapsed into one at contact-resolver time.

    Returns a list of proposals. Never auto-applies — CPA confirms via
    the Contact Pairing Auditor UI (or a dedicated split-proposal
    surface, TBD).

    A proposal:
      {
        contact_id, contact_name, entry_source,
        entities: [
          {entity_id, txn_count, min_date, max_date, sample_descriptions[], amount_min, amount_max},
          ...
        ],
      }
    """
    pipeline = [
        {"$match": {
            "company_id":  cid,
            "merchant_entity_id": {"$exists": True, "$nin": [None, ""]},
            "contact_id":  {"$exists": True, "$ne": None},
        }},
        {"$group": {
            "_id": {"contact_id": "$contact_id", "entity_id": "$merchant_entity_id"},
            "n":         {"$sum": 1},
            "min_date":  {"$min": "$date"},
            "max_date":  {"$max": "$date"},
            "min_amt":   {"$min": "$amount"},
            "max_amt":   {"$max": "$amount"},
            "sample":    {"$push": "$description"},
        }},
        {"$group": {
            "_id": "$_id.contact_id",
            "entities": {"$push": {
                "entity_id": "$_id.entity_id",
                "n":         "$n",
                "min_date":  "$min_date",
                "max_date":  "$max_date",
                "min_amt":   "$min_amt",
                "max_amt":   "$max_amt",
                "sample":    {"$slice": ["$sample", 3]},
            }},
        }},
        # Only contacts with >= 2 distinct entity IDs are false-merge candidates
        {"$match": {"entities.1": {"$exists": True}}},
        {"$limit": limit},
    ]
    proposals: list[dict] = []
    async for row in db.transactions.aggregate(pipeline):
        c = await db.contacts.find_one(
            {"id": row["_id"], "company_id": cid},
            {"name": 1, "entry_source": 1, "is_pseudo_contact": 1},
        )
        if not c or c.get("is_pseudo_contact"):
            continue  # never propose splitting pseudo-contacts
        proposals.append({
            "contact_id":   row["_id"],
            "contact_name": c.get("name") or "",
            "entry_source": c.get("entry_source") or "unknown",
            "entities":     row["entities"],
        })
    return proposals


# ---------------------------------------------------------------------------
# Index helpers
# ---------------------------------------------------------------------------

async def ensure_identity_indexes() -> None:
    """Idempotent index creation. Sparse unique on
    `(company_id, merchant_entity_id)` — sparse because most contacts
    don't have an entity_id (P2P recipients, manually-created vendors,
    pseudo-contacts). Sparse means the index only enforces uniqueness
    on documents that DO carry the field, which is the intended
    semantic: two contacts CAN share entity_id=null, but must NOT
    share the same non-null entity_id within a company."""
    try:
        await db.contacts.create_index(
            [("company_id", 1), ("merchant_entity_id", 1)],
            unique=True,
            sparse=True,
            name="contacts_company_entity_unique",
        )
    except Exception:  # noqa: BLE001 — index may already exist under a different name
        pass
    # Audit log indexes — company + created_at desc for recent-events
    # listing, and by kind for filters.
    try:
        await db.contact_identity_events.create_index(
            [("company_id", 1), ("created_at", -1)],
            name="cie_company_created",
        )
        await db.contact_identity_events.create_index(
            [("company_id", 1), ("kind", 1), ("undone_at", 1)],
            name="cie_company_kind_undone",
        )
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "is_pseudo_contact_name",
    "entry_source_from_resolution_source",
    "record_identity_event",
    "undo_identity_event",
    "detect_false_merges",
    "ensure_identity_indexes",
]
