"""Nightly contact-cleanup scan.

Sweeps every company for already-posted transactions whose descriptor
now matches a `descriptor_aliases` entry on a DIFFERENT contact — i.e.
the CPA later taught the system who those memos really belong to but
older rows are still labeled with the old contact. Results are exposed
via the live `/reviewv2/cleanup-proposals` endpoint; this scheduler
just LOGS the pending count so ops can monitor the self-heal pipeline
without every user having to open the queue.

Mirrors the existing `invoice_followup_scheduler` and
`ai_ask_client_scheduler` patterns (env-toggle, idempotent start,
graceful failure per company).
"""
from __future__ import annotations
import asyncio
import logging
import os
from typing import Optional

from db import db
from contact_resolver import normalize_descriptor

logger = logging.getLogger("axiom.contact_cleanup_scheduler")

# Once every 6 hours. Not urgent — the live endpoint always reflects
# the current truth, this task is purely for observability.
SCHEDULER_INTERVAL_SECONDS = int(
    os.environ.get("CONTACT_CLEANUP_SCHEDULER_INTERVAL", str(6 * 3600))
)

_TASK: Optional[asyncio.Task] = None


async def _count_proposals(company_id: str) -> int:
    """Cheap recount of pending cleanup proposals for one company."""
    # Alias → canonical contact.
    alias_to_contact: dict[str, str] = {}
    async for c in db.contacts.find(
        {"company_id": company_id,
         "descriptor_aliases": {"$exists": True, "$ne": []}},
        {"_id": 0, "id": 1, "descriptor_aliases": 1},
    ):
        for a in (c.get("descriptor_aliases") or []):
            alias_to_contact[a] = c["id"]
    if not alias_to_contact:
        return 0

    dismissed = set()
    async for d in db.contact_cleanup_dismissed.find(
        {"company_id": company_id},
        {"_id": 0, "contact_id": 1, "descriptor_key": 1},
    ):
        dismissed.add((d.get("contact_id") or "", d.get("descriptor_key") or ""))

    total = 0
    async for t in db.transactions.find(
        {"company_id": company_id,
         "$or": [{"posted": True}, {"human_reviewed": True}]},
        {"_id": 0, "description": 1, "original_description": 1,
         "merchant_name": 1, "contact_id": 1},
    ):
        key = normalize_descriptor(
            t.get("original_description") or t.get("description")
            or t.get("merchant_name"))
        if not key:
            continue
        canonical = alias_to_contact.get(key)
        if not canonical or canonical == t.get("contact_id"):
            continue
        if (canonical, key) in dismissed:
            continue
        total += 1
    return total


async def run_once() -> dict:
    """One sweep across all companies. Idempotent — read-only."""
    scanned = 0
    with_proposals = 0
    total_rows = 0
    async for company in db.companies.find(
        {}, {"_id": 0, "id": 1, "name": 1},
    ):
        scanned += 1
        try:
            n = await _count_proposals(company["id"])
        except Exception:  # noqa: BLE001
            logger.exception("cleanup scan failed for company=%s", company.get("id"))
            continue
        if n:
            with_proposals += 1
            total_rows += n
            logger.info("company=%s (%s) has %d pending cleanup rows",
                        company.get("id"), company.get("name"), n)
    return {"scanned": scanned,
            "companies_with_proposals": with_proposals,
            "total_rows": total_rows}


async def _loop() -> None:
    logger.info("Contact cleanup scheduler started (interval=%ss)",
                SCHEDULER_INTERVAL_SECONDS)
    while True:
        try:
            summary = await run_once()
            if summary["total_rows"]:
                logger.info("Contact cleanup scan: %s", summary)
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
