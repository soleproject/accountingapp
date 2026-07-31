"""Recurring invoice / bill templates + scheduler.

A single `recurring_templates` collection stores memorized invoices and
bills. Each template holds a cloned copy of the source document's line
items + tax + contact + notes, a frequency (`weekly` | `monthly` |
`quarterly` | `annual`), a start / optional end date, and a
`next_run_date` that the scheduler advances after each generation.

The scheduler wakes hourly (idempotent — same day re-runs are guarded
by `next_run_date`). For every template whose `next_run_date <= today`
and `!paused` and `(end_date is null OR end_date >= today)`, we clone
the template into a real invoice / bill (status = `draft` by default),
then bump `next_run_date` forward by the frequency.

Kept intentionally in one module — the frontend talks to `routes/recurring.py`
and this file owns the domain logic + scheduler task.
"""
from __future__ import annotations
import asyncio
import calendar
import logging
import os
import random
import uuid
from datetime import date, datetime, timezone, timedelta
from typing import Optional

from db import db, now_iso, coerce

log = logging.getLogger(__name__)

FREQUENCIES = ("weekly", "monthly", "quarterly", "annual")
KINDS = ("invoice", "bill")


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _fmt(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def _add_months(d: date, months: int) -> date:
    """Add N months, capping to the last day of the target month.

    Example: 2026-01-31 + 1 month → 2026-02-28 (or -29 in a leap year).
    Anchors monthly / quarterly / annual runs to the start-date's day.
    """
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    last = calendar.monthrange(y, m)[1]
    return date(y, m, min(d.day, last))


def next_run_after(current: date, frequency: str) -> date:
    if frequency == "weekly":
        return current + timedelta(days=7)
    if frequency == "monthly":
        return _add_months(current, 1)
    if frequency == "quarterly":
        return _add_months(current, 3)
    if frequency == "annual":
        return _add_months(current, 12)
    raise ValueError(f"unknown frequency: {frequency}")


def _sum_lines(lines: list, tax: float = 0.0) -> tuple[float, float, float]:
    subtotal = sum(float(li.get("amount", 0)) for li in lines)
    total = subtotal + float(tax or 0)
    return round(subtotal, 2), round(float(tax or 0), 2), round(total, 2)


async def ensure_indexes():
    await db.recurring_templates.create_index([("company_id", 1), ("kind", 1)])
    await db.recurring_templates.create_index([("next_run_date", 1), ("paused", 1)])


def _validate_template_payload(inp: dict) -> dict:
    kind = inp.get("kind")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    freq = inp.get("frequency")
    if freq not in FREQUENCIES:
        raise ValueError(f"frequency must be one of {FREQUENCIES}")
    if not inp.get("start_date"):
        raise ValueError("start_date is required")
    lines = inp.get("line_items") or []
    if not lines:
        raise ValueError("at least one line item is required")
    return {
        "kind": kind,
        "frequency": freq,
        "start_date": inp["start_date"],
        "end_date": inp.get("end_date") or None,
        "contact_id": inp.get("contact_id"),
        "contact_name": inp.get("contact_name") or "",
        "line_items": lines,
        "tax": float(inp.get("tax") or 0),
        "notes": inp.get("notes") or "",
        "memo": inp.get("memo") or "",
        "net_days": int(inp.get("net_days") or 30),
        "status_on_generate": inp.get("status_on_generate") or "draft",
        "created_from_id": inp.get("created_from_id"),
        "name": (inp.get("name") or "").strip() or None,
    }


async def create_template(cid: str, user_id: str, inp: dict) -> dict:
    clean = _validate_template_payload(inp)
    start = _parse_date(clean["start_date"])
    tid = str(uuid.uuid4())
    now = now_iso()
    doc = {
        "id": tid,
        "company_id": cid,
        "created_by_user_id": user_id,
        **clean,
        "next_run_date": clean["start_date"],
        "paused": bool(inp.get("paused", False)),
        "runs_count": 0,
        "last_run_at": None,
        "last_generated_id": None,
        "created_at": now,
        "updated_at": now,
    }
    await db.recurring_templates.insert_one(doc)
    return coerce(doc)


async def update_template(cid: str, tid: str, patch: dict) -> dict:
    allowed = {
        "frequency", "start_date", "end_date", "paused", "line_items",
        "tax", "notes", "memo", "net_days", "status_on_generate",
        "contact_id", "contact_name", "name",
    }
    upd = {k: v for k, v in patch.items() if k in allowed}
    if "frequency" in upd and upd["frequency"] not in FREQUENCIES:
        raise ValueError(f"frequency must be one of {FREQUENCIES}")
    if upd:
        upd["updated_at"] = now_iso()
        await db.recurring_templates.update_one(
            {"id": tid, "company_id": cid}, {"$set": upd}
        )
    doc = await db.recurring_templates.find_one({"id": tid, "company_id": cid})
    return coerce(doc) if doc else {}


async def generate_from_template(template: dict, run_date: Optional[date] = None) -> Optional[str]:
    """Clone the template into a real invoice/bill row. Returns new doc id.

    If `run_date` is omitted, uses today. The generated document's
    `issue_date` = run_date and `due_date` = run_date + net_days.
    Advances `next_run_date` on the template and increments counters.
    """
    run_date = run_date or date.today()
    kind = template["kind"]
    cid = template["company_id"]
    net_days = int(template.get("net_days") or 30)
    issue = _fmt(run_date)
    due = _fmt(run_date + timedelta(days=net_days))
    lines = [dict(li) for li in template["line_items"]]
    tax = float(template.get("tax") or 0)
    subtotal, tax_r, total = _sum_lines(lines, tax)
    doc_id = str(uuid.uuid4())
    now = now_iso()
    status = template.get("status_on_generate") or "draft"
    coll = db.invoices if kind == "invoice" else db.bills
    prefix = "INV" if kind == "invoice" else "BILL"
    doc = {
        "id": doc_id,
        "company_id": cid,
        "number": f"{prefix}-{random.randint(1000, 9999)}",
        "contact_id": template.get("contact_id"),
        "contact_name": template.get("contact_name") or "",
        "issue_date": issue,
        "due_date": due,
        "status": status,
        "line_items": lines,
        "subtotal": subtotal,
        "tax": tax_r,
        "total": total,
        "balance_due": total,
        "notes": template.get("notes") or "",
        "created_at": now,
        "updated_at": now,
        "recurring_template_id": template["id"],
    }
    await coll.insert_one(doc)
    # Advance the template
    try:
        new_next = next_run_after(run_date, template["frequency"])
    except ValueError:
        new_next = run_date + timedelta(days=30)
    await db.recurring_templates.update_one(
        {"id": template["id"]},
        {
            "$set": {
                "next_run_date": _fmt(new_next),
                "last_run_at": now,
                "last_generated_id": doc_id,
                "updated_at": now,
            },
            "$inc": {"runs_count": 1},
        },
    )
    return doc_id


async def run_due(today: Optional[date] = None) -> dict:
    """Generate any templates whose next_run_date <= today.

    Idempotent — templates already advanced past today are skipped.
    Returns a small summary dict for logging.
    """
    today = today or date.today()
    today_s = _fmt(today)
    cursor = db.recurring_templates.find({
        "paused": {"$ne": True},
        "next_run_date": {"$lte": today_s},
    })
    generated = 0
    skipped = 0
    async for t in cursor:
        end = t.get("end_date")
        if end and end < today_s:
            skipped += 1
            continue
        # Catch up any missed runs (e.g. app was down for a week).
        # Cap the catch-up at 12 iterations to avoid runaway loops on
        # bad data.
        run_date_s = t["next_run_date"]
        for _ in range(12):
            if run_date_s > today_s:
                break
            end = t.get("end_date")
            if end and run_date_s > end:
                break
            run_date = _parse_date(run_date_s)
            await generate_from_template(t, run_date=run_date)
            generated += 1
            # Reload for next iteration
            t = await db.recurring_templates.find_one({"id": t["id"]})
            if not t:
                break
            run_date_s = t["next_run_date"]
    return {"generated": generated, "skipped": skipped, "date": today_s}


_scheduler_task: Optional[asyncio.Task] = None


async def _loop():
    """Wake every hour and process any due templates."""
    while True:
        try:
            summary = await run_due()
            if summary["generated"]:
                log.info(f"[recurring] {summary}")
        except Exception:
            log.exception("[recurring] scheduler tick failed")
        await asyncio.sleep(60 * 60)  # 1 hour


def start_scheduler():
    global _scheduler_task
    if os.environ.get("DISABLE_RECURRING_SCHEDULER") == "1":
        log.info("[recurring] scheduler disabled via env")
        return
    if _scheduler_task and not _scheduler_task.done():
        return
    _scheduler_task = asyncio.create_task(_loop())
