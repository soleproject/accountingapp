"""Nightly contact-cleanup scan **+ auto-apply**.

Sweeps every company for already-posted transactions whose descriptor
now matches a `descriptor_aliases` entry on a DIFFERENT contact — i.e.
the CPA later taught the system who those memos really belong to but
older rows are still labeled with the old contact.

For each matched pattern `(canonical_contact_id, descriptor_key)`, we:
  1. Snapshot each affected row's previous `contact_id` / `contact_name`
     into `db.contact_cleanup_applied.previous_labels[<txn_id>]`.
  2. Bulk `update_many` the transactions to the canonical contact.
  3. Persist an "applied" record with a per-run `batch_id` so undo /
     acknowledge / save-as-rule can operate per pattern.

The `Client Cockpit`, `To Do` responsibilities card, and `Quick Check-in`
surfaces all read pending records (`status: "applied"`) from this table
and let the CPA / client undo or acknowledge in one click.

Env toggles:
  CONTACT_CLEANUP_SCHEDULER_DISABLED=1    disables the poll entirely
  CONTACT_CLEANUP_SCHEDULER_INTERVAL=NNN  poll interval in seconds
"""
from __future__ import annotations
import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db
from contact_resolver import normalize_descriptor

logger = logging.getLogger("axiom.contact_cleanup_scheduler")

# Once every 6 hours by default. `run_once` is idempotent (only rows
# still mis-labeled get touched) so re-running is safe.
SCHEDULER_INTERVAL_SECONDS = int(
    os.environ.get("CONTACT_CLEANUP_SCHEDULER_INTERVAL", str(6 * 3600))
)

_TASK: Optional[asyncio.Task] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _apply_for_company(company_id: str, batch_id: str) -> dict:
    """Sweep + auto-apply for one company. Returns
    ``{patterns: N, rows: M}`` describing what changed."""

    # Alias → canonical contact (prefer the most recently updated
    # contact when the same alias points at multiple, matching
    # resolve_contact's behavior).
    alias_to_contact: dict[str, dict] = {}
    async for c in db.contacts.find(
        {"company_id": company_id,
         "descriptor_aliases": {"$exists": True, "$ne": []}},
        {"_id": 0, "id": 1, "name": 1, "display_name": 1,
         "descriptor_aliases": 1, "updated_at": 1},
    ):
        cname = c.get("display_name") or c.get("name") or ""
        for a in (c.get("descriptor_aliases") or []):
            prev = alias_to_contact.get(a)
            if (not prev) or (c.get("updated_at") or "") > (prev.get("updated_at") or ""):
                alias_to_contact[a] = {"id": c["id"], "name": cname,
                                       "updated_at": c.get("updated_at") or ""}
    if not alias_to_contact:
        return {"patterns": 0, "rows": 0}

    # Dismissed (contact_id, descriptor_key) pairs.
    dismissed: set[tuple] = set()
    async for d in db.contact_cleanup_dismissed.find(
        {"company_id": company_id},
        {"_id": 0, "contact_id": 1, "descriptor_key": 1},
    ):
        dismissed.add((d.get("contact_id") or "", d.get("descriptor_key") or ""))

    # Group posted mis-labeled rows by (canonical_contact_id, key).
    buckets: dict[tuple, dict] = {}
    async for t in db.transactions.find(
        {"company_id": company_id,
         "$or": [{"posted": True}, {"human_reviewed": True}]},
        {"_id": 0, "id": 1, "description": 1, "original_description": 1,
         "merchant_name": 1, "contact_id": 1, "contact_name": 1},
    ):
        key = normalize_descriptor(
            t.get("original_description") or t.get("description")
            or t.get("merchant_name"))
        if not key or key not in alias_to_contact:
            continue
        canonical = alias_to_contact[key]
        if t.get("contact_id") == canonical["id"]:
            continue
        pair = (canonical["id"], key)
        if pair in dismissed:
            continue
        b = buckets.setdefault(pair, {
            "contact_id":         canonical["id"],
            "contact_name":       canonical["name"],
            "descriptor_key":     key,
            "sample_description": t.get("description") or t.get("original_description") or "",
            "txn_ids":            [],
            "previous_labels":    {},
            "before_labels":      set(),
        })
        b["txn_ids"].append(t["id"])
        b["previous_labels"][t["id"]] = {
            "contact_id":   t.get("contact_id"),
            "contact_name": t.get("contact_name"),
        }
        if t.get("contact_name"):
            b["before_labels"].add(t["contact_name"])

    if not buckets:
        return {"patterns": 0, "rows": 0}

    now = _now_iso()
    total_rows = 0
    for (canonical_id, key), b in buckets.items():
        applied_id = str(uuid.uuid4())
        # Persist the audit row BEFORE we mutate — if apply crashes
        # half-way, undo still has the previous_labels snapshot.
        await db.contact_cleanup_applied.insert_one({
            "id":                  applied_id,
            "company_id":          company_id,
            "batch_id":            batch_id,
            "contact_id":          canonical_id,
            "contact_name":        b["contact_name"],
            "descriptor_key":      key,
            "sample_description":  b["sample_description"],
            "before_labels":       sorted(b["before_labels"])[:8],
            "txn_ids":             b["txn_ids"],
            "count":               len(b["txn_ids"]),
            "previous_labels":     b["previous_labels"],
            "applied_at":          now,
            "status":              "applied",  # applied | undone | acknowledged
            "save_as_rule":        False,
        })
        await db.transactions.update_many(
            {"company_id": company_id, "id": {"$in": b["txn_ids"]}},
            {"$set": {"contact_id":   canonical_id,
                      "contact_name": b["contact_name"],
                      "updated_at":   now}},
        )
        total_rows += len(b["txn_ids"])

    return {"patterns": len(buckets), "rows": total_rows}


async def run_once() -> dict:
    """One sweep across every company. Applies mislabel fixes and
    persists an audit trail so users can undo per pattern."""
    batch_id = str(uuid.uuid4())
    scanned = 0
    touched_companies = 0
    total_patterns = 0
    total_rows = 0
    async for company in db.companies.find(
        {}, {"_id": 0, "id": 1, "name": 1},
    ):
        scanned += 1
        try:
            r = await _apply_for_company(company["id"], batch_id)
        except Exception:  # noqa: BLE001
            logger.exception("cleanup apply failed for company=%s", company.get("id"))
            continue
        if r["patterns"]:
            touched_companies += 1
            total_patterns += r["patterns"]
            total_rows += r["rows"]
            logger.info(
                "company=%s (%s) auto-cleaned %d row(s) across %d pattern(s)",
                company.get("id"), company.get("name"), r["rows"], r["patterns"],
            )
    return {"scanned":                 scanned,
            "companies_with_changes":  touched_companies,
            "patterns":                total_patterns,
            "rows":                    total_rows,
            "batch_id":                batch_id}


async def _loop() -> None:
    logger.info("Contact cleanup scheduler started (interval=%ss)",
                SCHEDULER_INTERVAL_SECONDS)
    while True:
        try:
            summary = await run_once()
            if summary["rows"]:
                logger.info("Contact cleanup auto-apply: %s", summary)
        except Exception:  # noqa: BLE001
            logger.exception("Contact cleanup run failed — will retry next tick")
        await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)


async def _loop() -> None:
    logger.info("Contact cleanup scheduler started (interval=%ss)",
                SCHEDULER_INTERVAL_SECONDS)
    while True:
        try:
            summary = await run_once()
            if summary["rows"]:
                logger.info("Contact cleanup auto-apply: %s", summary)
        except Exception:  # noqa: BLE001
            logger.exception("Contact cleanup run failed — will retry next tick")
        await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)


def start_scheduler() -> None:
    """Launch the poll loop. Idempotent — safe to call more than once."""
    global _TASK
    if _TASK and not _TASK.done():
        return
    if os.environ.get("CONTACT_CLEANUP_SCHEDULER_DISABLED") == "1":
        logger.info("Contact cleanup scheduler disabled by env")
        return
    loop = asyncio.get_event_loop()
    _TASK = loop.create_task(_loop(), name="contact_cleanup_scheduler")
