"""QBO Class Read Sync (Feb 2026 Phase 2).

Silently captures `ClassRef` from every incoming QBO line so a company
that later enables Classes has instant historical coverage.

The pipeline is:

    1. `qbo_service._flatten_lines()` and `map_journal_entry()` preserve
       `qbo_class_id` + `qbo_class_name` on every imported line.
    2. `sync_qbo_classes(cid)` (this module):
         a. Scans every line under the company for `qbo_class_id`.
         b. Ensures an Axiom `classes` row exists per unique QBO class
            (`qbo_id` = the QBO ClassRef value; `active=True`; name
            deduped case-insensitively).
         c. Stamps `class_id` on the parent doc (txn / invoice / bill /
            payment / receipt / estimate) whose primary line references
            the class, AND on `journal_entries.lines[i].class_id` for
            per-line JE granularity.
       Idempotent — safe to re-run after every import.

The company's `features.classes_enabled` flag is NOT read here. Data
is captured whether or not the UI is showing it, so flipping the
toggle later is a pure UI change with zero migration.
"""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict

from db import db, now_iso

log = logging.getLogger("axiom.qbo_class_sync")


async def _ensure_class(cid: str, qbo_id: str, name: str,
                          cache: dict[str, str]) -> str | None:
    """Return the local Axiom class id for the given QBO class ref.

    Resolution priority:
      1. Cache hit (this-run memo).
      2. `classes.qbo_id == qbo_id` → reuse.
      3. `classes.name` case-insensitive match → adopt (stamp
         `qbo_id` for future runs; users may have manually created
         the class before enabling QBO sync).
      4. Insert a new row.

    Returns None if the QBO ref is empty / invalid.
    """
    if not qbo_id:
        return None
    qbo_id = str(qbo_id)
    if qbo_id in cache:
        return cache[qbo_id]

    # 2. qbo_id match.
    existing = await db.classes.find_one(
        {"company_id": cid, "qbo_id": qbo_id})
    if existing:
        cache[qbo_id] = existing["id"]
        return existing["id"]

    # 3. name match (case-insensitive) — adopt the row.
    if name:
        by_name = await db.classes.find_one({
            "company_id": cid,
            "name": {"$regex": f"^{name}$", "$options": "i"},
        })
        if by_name:
            await db.classes.update_one(
                {"id": by_name["id"]},
                {"$set": {"qbo_id": qbo_id, "updated_at": now_iso()}},
            )
            cache[qbo_id] = by_name["id"]
            return by_name["id"]

    # 4. Fresh insert.
    now = now_iso()
    new_id = str(uuid.uuid4())
    await db.classes.insert_one({
        "id": new_id,
        "company_id": cid,
        "name": name or f"QBO Class {qbo_id}",
        "qbo_id": qbo_id,
        "parent_class_id": None,
        "active": True,
        "source": "qbo",
        "created_at": now,
        "updated_at": now,
    })
    cache[qbo_id] = new_id
    return new_id


async def sync_qbo_classes(cid: str) -> dict:
    """Resolve every captured `qbo_class_id` to an Axiom class row and
    stamp `class_id` on the parent doc / JE line.

    Returns a small stats dict for observability (test + admin log).
    Never raises — worst case is a partial sync + a WARNING log.
    """
    stats: dict[str, int] = defaultdict(int)
    cache: dict[str, str] = {}

    # -----------------------------------------------------------------
    # First pass — walk every doc's line array and mint Axiom class
    # rows for every UNIQUE qbo_class_id seen anywhere. Doing this
    # up-front means downstream JE-line stamping and future reports
    # can reference the class regardless of whether it happened to
    # appear on the header line of a parent doc.
    # -----------------------------------------------------------------
    async def _harvest_from(coll: str):
        cursor = db[coll].find(
            {"company_id": cid, "source": "qbo",
             "lines.qbo_class_id": {"$exists": True, "$ne": None}},
            {"lines": 1},
        )
        async for d in cursor:
            for ln in (d.get("lines") or []):
                qid = ln.get("qbo_class_id")
                if qid:
                    await _ensure_class(cid, qid,
                                          ln.get("qbo_class_name") or "",
                                          cache)

    for coll in ("invoices", "bills", "payments", "receipts",
                 "estimates", "transactions", "journal_entries"):
        try:
            await _harvest_from(coll)
        except Exception as e:  # noqa: BLE001
            log.warning("qbo_class_sync harvest failed for %s: %s", coll, e)

    # -----------------------------------------------------------------
    # Second pass — line-carrying docs — stamp `class_id` on the parent
    # header from the FIRST line that has a QBO class ref (matches
    # QBO's own P&L-by-class rollup convention: one class per doc).
    # -----------------------------------------------------------------
    for coll in ("invoices", "bills", "payments", "receipts", "estimates"):
        cursor = db[coll].find(
            {"company_id": cid, "source": "qbo",
             "lines.qbo_class_id": {"$exists": True, "$ne": None}},
            {"id": 1, "lines": 1, "class_id": 1},
        )
        async for d in cursor:
            first_ref = None
            for ln in (d.get("lines") or []):
                if ln.get("qbo_class_id"):
                    first_ref = ln
                    break
            if not first_ref:
                continue
            local_id = await _ensure_class(
                cid, first_ref["qbo_class_id"],
                first_ref.get("qbo_class_name") or "", cache)
            if not local_id or d.get("class_id") == local_id:
                continue
            await db[coll].update_one(
                {"company_id": cid, "id": d["id"]},
                {"$set": {"class_id": local_id, "updated_at": now_iso()}},
            )
            stats[coll] += 1

    # -----------------------------------------------------------------
    # Transactions — a QBO-imported txn (bank feed row, Expense, etc.)
    # may carry a class on its top-level detail. If any line has a
    # `qbo_class_id`, adopt it (same first-hit rule).
    # -----------------------------------------------------------------
    cursor = db.transactions.find(
        {"company_id": cid, "source": "qbo",
         "lines.qbo_class_id": {"$ne": None}},
        {"id": 1, "lines": 1, "class_id": 1},
    )
    async for d in cursor:
        first_ref = next(
            (ln for ln in (d.get("lines") or [])
             if ln.get("qbo_class_id")),
            None,
        )
        if not first_ref:
            continue
        local_id = await _ensure_class(
            cid, first_ref["qbo_class_id"],
            first_ref.get("qbo_class_name") or "", cache)
        if not local_id or d.get("class_id") == local_id:
            continue
        await db.transactions.update_one(
            {"company_id": cid, "id": d["id"]},
            {"$set": {"class_id": local_id, "updated_at": now_iso()}},
        )
        stats["transactions"] += 1

    # -----------------------------------------------------------------
    # Journal entries — per-line class_id (matches Axiom's model of
    # allowing one JE to span multiple classes across its lines).
    # -----------------------------------------------------------------
    cursor = db.journal_entries.find(
        {"company_id": cid, "source": "qbo",
         "lines.qbo_class_id": {"$ne": None}},
        {"id": 1, "lines": 1},
    )
    async for d in cursor:
        changed = False
        new_lines = []
        for ln in (d.get("lines") or []):
            if ln.get("qbo_class_id") and not ln.get("class_id"):
                local_id = await _ensure_class(
                    cid, ln["qbo_class_id"],
                    ln.get("qbo_class_name") or "", cache)
                if local_id:
                    ln = {**ln, "class_id": local_id}
                    changed = True
            new_lines.append(ln)
        if changed:
            await db.journal_entries.update_one(
                {"company_id": cid, "id": d["id"]},
                {"$set": {"lines": new_lines, "updated_at": now_iso()}},
            )
            stats["journal_entries"] += 1

    stats["classes_touched"] = len(cache)
    log.info("qbo_class_sync company=%s: %s", cid, dict(stats))
    return dict(stats)
