"""Batch client review — Phase 3, Milestone A.

Aggregates unresolved items across the nine question categories into a
single `client_review_batches` doc that the client answers in one
conversational session, on their own time.

Cadence: fire when ≥3 items are ready AND ≥5 days have passed since the
last batch email for this client. Streams-first — the per-txn
`ai_ask_client` scheduler still handles fresh uncategorized rows; batches
only pick up aged (>7d), post-initial-download stragglers plus everything
else.

Item catalog:
    1. Uncategorized transaction (>7d, non-initial-download)
    2. Vendor/memo confirmation (agent_findings: contact_mismatch,
       contact_duplicate)
    3. Missing receipt (agent_findings: missing_receipt)
    4. 1099 W-9 collection (agent_findings: w9_needed)
    5. Ambiguous P2P transfer (agent_findings: ambiguous_transfer)
    6. New recurring charge classification (agent_findings:
       new_recurring_charge)
    7. Setup detail missing (agent_findings: setup_missing)
    8. Split-transaction suggestion (agent_findings: split_suggested)
    9. Liability payment split (agent_findings: liability_split_needed)

Kinds 3–9 are consumed via `agent_findings.kind` — the source detectors
mint findings under those keys. Detectors 6, 7, 8 don't exist yet; the
aggregator returns empty for those kinds until they do. When a detector
lands, no aggregator change is needed.
"""

from __future__ import annotations
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

from deps import db


ITEM_UNCATEGORIZED         = 1
ITEM_VENDOR_MEMO           = 2
ITEM_MISSING_RECEIPT       = 3
ITEM_W9_NEEDED             = 4
ITEM_AMBIGUOUS_TRANSFER    = 5
ITEM_RECURRING             = 6
ITEM_SETUP                 = 7
ITEM_SPLIT                 = 8
ITEM_LIABILITY_SPLIT       = 9

# Map an item type → the `agent_findings.kind` values it consumes.
# Item 1 is special-cased (queries transactions directly).
_KIND_MAP: dict[int, list[str]] = {
    ITEM_VENDOR_MEMO:         ["contact_mismatch", "contact_duplicate"],
    ITEM_MISSING_RECEIPT:     ["missing_receipt"],
    ITEM_W9_NEEDED:           ["w9_needed"],
    ITEM_AMBIGUOUS_TRANSFER:  ["ambiguous_transfer"],
    ITEM_RECURRING:           ["new_recurring_charge"],
    ITEM_SETUP:               ["setup_missing"],
    ITEM_SPLIT:               ["split_suggested"],
    ITEM_LIABILITY_SPLIT:     ["liability_split_needed"],
}

BATCH_MIN_ITEMS         = 3
BATCH_MIN_DAYS_BETWEEN  = 5
BATCH_EXPIRY_DAYS       = 14
AGED_UNCATEGORIZED_DAYS = 7
INITIAL_DOWNLOAD_HOURS  = 24   # skip anything ingested < 24h post company create


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _hours_after(iso: str | datetime, hours: int) -> str:
    """Return `iso + hours` as ISO string, robust to str or datetime input."""
    if isinstance(iso, str):
        # Strip trailing Z if present, parse.
        cleaned = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
    else:
        dt = iso
    return (dt + timedelta(hours=hours)).isoformat()


# --------------------------------------------------------------------------
# Item collection — one small async fn per item type keeps testing surgical.
# --------------------------------------------------------------------------

async def _collect_aged_uncategorized(company_id: str) -> list[dict]:
    """Item 1. Aged uncategorized transactions.

    Rules:
      * `needs_review == True`
      * `human_reviewed != True` — CPA hasn't touched it
      * `created_at < now - 7d` — the per-txn asker had first crack
      * `created_at > company.created_at + 24h` — never anything from the
        initial Plaid backfill
      * `client_question_id` empty — no per-txn ask pending or answered
        for this row (the streaming scheduler owns those)
      * Not already in any open/scheduled batch (dedupe below)
    """
    company = await db.companies.find_one({"id": company_id}, {"created_at": 1})
    if not company:
        return []
    initial_download_end = _hours_after(
        company["created_at"], INITIAL_DOWNLOAD_HOURS,
    )
    cutoff_aged = _days_ago(AGED_UNCATEGORIZED_DAYS)
    query = {
        "company_id":         company_id,
        "needs_review":       True,
        "human_reviewed":     {"$ne": True},
        "created_at":         {"$lt": cutoff_aged, "$gt": initial_download_end},
        "client_question_id": {"$in": [None, ""]},
    }
    items: list[dict] = []
    async for t in db.transactions.find(query).sort("date", -1).limit(20):
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         ITEM_UNCATEGORIZED,
            "source_id":         t["id"],
            "source_collection": "transactions",
            "prompt":            _prompt_for_uncategorized(t),
            "context": {
                "date":        t.get("date"),
                "amount":      t.get("amount"),
                "description": t.get("description"),
                "merchant":    t.get("merchant"),
                "account":     t.get("bank_account_name"),
            },
            "answered_at": None,
            "answer":      None,
            "deferred":    False,
            "action_taken": None,
        })
    return items


async def _collect_agent_findings(company_id: str, item_type: int) -> list[dict]:
    kinds = _KIND_MAP.get(item_type)
    if not kinds:
        return []
    items: list[dict] = []
    async for f in db.agent_findings.find({
        "company_id": company_id,
        "kind":       {"$in": kinds},
        "status":     "open",
        # Not already picked up by a live batch
        "batch_id":   {"$in": [None, ""]},
    }).sort("created_at", -1).limit(20):
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         item_type,
            "source_id":         f["id"],
            "source_collection": "agent_findings",
            "prompt":            f.get("detail") or f.get("title") or "",
            "context": {
                "kind":     f.get("kind"),
                "title":    f.get("title"),
                "severity": f.get("severity"),
                "meta":     f.get("meta") or {},
            },
            "answered_at": None,
            "answer":      None,
            "deferred":    False,
            "action_taken": None,
        })
    return items


def _prompt_for_uncategorized(t: dict) -> str:
    amount = t.get("amount") or 0
    date = t.get("date") or ""
    who = t.get("merchant") or t.get("description") or "an unknown vendor"
    direction = "to" if amount < 0 else "from"
    return (f"Could you tell us what this ${abs(amount):,.2f} transaction "
            f"on {date} {direction} {who} was for?")


async def collect_batch_items(company_id: str) -> list[dict]:
    """Walk all 9 sources, return the deduped item list ready for batching.

    Deduplication has two layers:
      1. Source-level: each `_collect_*` helper already excludes rows
         with a live `batch_id` or `client_question_id`.
      2. Cross-source: within this call, items with the same
         (source_collection, source_id) pair are collapsed — a single
         finding can only surface once even if two callers race.
    """
    items: list[dict] = []
    items.extend(await _collect_aged_uncategorized(company_id))
    for item_type in (
        ITEM_VENDOR_MEMO,
        ITEM_MISSING_RECEIPT,
        ITEM_W9_NEEDED,
        ITEM_AMBIGUOUS_TRANSFER,
        ITEM_RECURRING,
        ITEM_SETUP,
        ITEM_SPLIT,
        ITEM_LIABILITY_SPLIT,
    ):
        items.extend(await _collect_agent_findings(company_id, item_type))

    seen: set[tuple[str, str]] = set()
    deduped: list[dict] = []
    for it in items:
        key = (it["source_collection"], it["source_id"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(it)
    return deduped


# --------------------------------------------------------------------------
# Cadence gate + batch mint
# --------------------------------------------------------------------------

async def last_batch_email_sent_at(
    company_id: str, client_email: str,
) -> str | None:
    """Timestamp of the most recent batch email dispatched to this
    client — from any batch state (open, expired, completed).
    """
    doc = await db.client_review_batches.find_one(
        {"company_id": company_id, "client_email": client_email,
         "email_sent_at": {"$ne": None}},
        sort=[("email_sent_at", -1)],
    )
    return doc.get("email_sent_at") if doc else None


async def has_open_batch(company_id: str, client_email: str) -> bool:
    """A client with an open/scheduled batch never gets a second one —
    they finish or expire before we send anything new.
    """
    doc = await db.client_review_batches.find_one({
        "company_id":   company_id,
        "client_email": client_email,
        "status":       {"$in": ["open", "scheduled"]},
    })
    return doc is not None


async def should_fire_batch(
    company_id: str, client_email: str,
) -> tuple[bool, str, list[dict]]:
    """Return (should_fire, reason, ready_items).

    The `reason` is diagnostic — surface it on the pro-side "why isn't
    this client getting emails" panel. Never returns a truthy first
    element while there's already an open batch — that's a hard gate.
    """
    if await has_open_batch(company_id, client_email):
        return False, "already_open_batch", []

    last_sent = await last_batch_email_sent_at(company_id, client_email)
    if last_sent:
        cutoff = _days_ago(BATCH_MIN_DAYS_BETWEEN)
        if last_sent > cutoff:
            return False, "cadence_too_soon", []

    items = await collect_batch_items(company_id)
    if len(items) < BATCH_MIN_ITEMS:
        return False, "below_min_items", items
    return True, "ready", items


async def create_batch(
    company_id: str, client_email: str, items: list[dict],
) -> dict:
    """Persist the batch and stamp source items with `batch_id` so a
    concurrent aggregator run can't re-pick them.

    The email dispatch itself lives in Milestone B — this only builds
    the doc, marks the sources, and returns it. Caller decides when to
    send.
    """
    batch_id   = str(uuid.uuid4())
    created_at = now_iso()
    expires_at = (datetime.now(timezone.utc)
                  + timedelta(days=BATCH_EXPIRY_DAYS)).isoformat()

    doc: dict[str, Any] = {
        "id":                          batch_id,
        "company_id":                  company_id,
        "client_email":                client_email,
        "items":                       items,
        "status":                      "open",
        "created_at":                  created_at,
        "expires_at":                  expires_at,
        "email_sent_at":               None,
        "scheduled_for":               None,
        "reminder_sent_at":            None,
        "nudge_sent_at":               None,
        "completed_at":                None,
        "answer_count":                0,
        "defer_count":                 0,
        # Pro-side info counter (no auto-pause — pro decides).
        "consecutive_missed_batches":  0,
    }
    await db.client_review_batches.insert_one(doc)

    # Stamp source items with batch_id so the aggregator won't re-see
    # them. Split by collection because `transactions` and
    # `agent_findings` may have different indexes.
    by_coll: dict[str, list[str]] = {}
    for it in items:
        by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
    for coll, ids in by_coll.items():
        try:
            await db[coll].update_many(
                {"id": {"$in": ids}, "company_id": company_id},
                {"$set": {"batch_id": batch_id, "updated_at": now_iso()}},
            )
        except Exception:  # noqa: BLE001 — never fail batch creation on stamp
            pass
    return doc


# --------------------------------------------------------------------------
# Expiry sweep — run from the scheduler cron
# --------------------------------------------------------------------------

async def expire_stale_batches() -> dict:
    """Mark batches as `expired` when either:
      * `expires_at < now` (14 days elapsed), OR
      * a passive-miss nudge was sent >5 days ago with zero engagement.
    Release items back to the pool by unsetting `batch_id` on sources.
    Returns a summary for the caller to log.
    """
    now = now_iso()
    nudge_cutoff = _days_ago(5)
    expired = 0
    items_released = 0

    cursor = db.client_review_batches.find({
        "status": {"$in": ["open", "scheduled"]},
        "$or": [
            {"expires_at": {"$lt": now}},
            {"$and": [
                {"nudge_sent_at": {"$ne": None, "$lt": nudge_cutoff}},
                {"answer_count": 0},
                {"defer_count": 0},
            ]},
        ],
    })
    async for batch in cursor:
        by_coll: dict[str, list[str]] = {}
        for it in batch.get("items") or []:
            if it.get("answered_at"):
                continue
            by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
        for coll, ids in by_coll.items():
            try:
                r = await db[coll].update_many(
                    {"id": {"$in": ids}, "company_id": batch["company_id"]},
                    {"$unset": {"batch_id": ""}, "$set": {"updated_at": now}},
                )
                items_released += r.modified_count
            except Exception:  # noqa: BLE001
                pass
        await db.client_review_batches.update_one(
            {"id": batch["id"]},
            {"$set": {"status": "expired", "expired_at": now}},
        )
        expired += 1
    return {"expired_batches": expired, "items_released": items_released}


__all__ = [
    "ITEM_UNCATEGORIZED", "ITEM_VENDOR_MEMO", "ITEM_MISSING_RECEIPT",
    "ITEM_W9_NEEDED", "ITEM_AMBIGUOUS_TRANSFER", "ITEM_RECURRING",
    "ITEM_SETUP", "ITEM_SPLIT", "ITEM_LIABILITY_SPLIT",
    "BATCH_MIN_ITEMS", "BATCH_MIN_DAYS_BETWEEN", "BATCH_EXPIRY_DAYS",
    "collect_batch_items", "should_fire_batch", "create_batch",
    "expire_stale_batches", "has_open_batch", "last_batch_email_sent_at",
]
