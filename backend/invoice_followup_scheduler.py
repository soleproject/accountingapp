"""
Invoice Follow-up Scheduler
===========================

Polls `db.invoices` every N seconds for schedules with unsent due steps
and fires the AI chase-email pipeline. Mirrors `ai_ask_client_scheduler`
so the same operational primitives (send window, idempotency, leader
election skipped) apply.

Wired from `server.py` startup — see `start_scheduler()` at the bottom.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone

from db import db

logger = logging.getLogger(__name__)

# Poll every 5 minutes — bursty enough to fire same-day steps promptly
# without hammering Mongo. Steps store an absolute `run_at` so we don't
# need per-second precision.
SCHEDULER_INTERVAL_SECONDS = int(os.environ.get("INVOICE_FOLLOWUP_INTERVAL_SECONDS", "300"))

# Business-hours guard. Avoid sending chase emails at 3am — clients hate
# that. Same defaults as the ask-client scheduler.
SEND_TZ = os.environ.get("INVOICE_FOLLOWUP_SEND_TZ", "America/New_York")
SEND_START_HOUR = int(os.environ.get("INVOICE_FOLLOWUP_SEND_START_HOUR", "9"))
SEND_END_HOUR = int(os.environ.get("INVOICE_FOLLOWUP_SEND_END_HOUR", "17"))

_TASK: asyncio.Task | None = None


def _in_send_window() -> bool:
    """Only send between 9am–5pm local time, Mon–Fri."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo(SEND_TZ))
    except Exception:  # noqa: BLE001
        now = datetime.now(timezone.utc)
    if now.weekday() >= 5:  # Sat / Sun
        return False
    return SEND_START_HOUR <= now.hour < SEND_END_HOUR


async def _send_one_step(inv: dict, step_idx: int) -> tuple[bool, str]:
    """Fire the AI chase email for one due step. Returns (ok, status)."""
    cid = inv.get("company_id")
    iid = inv.get("id")

    # Resolve recipient — must have an email on file.
    contact = None
    if inv.get("contact_id"):
        contact = await db.contacts.find_one({"id": inv["contact_id"], "company_id": cid})
    recipient = ((contact or {}).get("email") or "").strip()
    if not recipient or "@" not in recipient:
        return False, "no_email"

    # Draft a fresh chase email — one-shot LLM call for THIS invoice.
    # Fallback to a static template if the LLM is unavailable so the
    # scheduler is robust to key hiccups.
    company = await db.companies.find_one({"id": cid}) or {}
    firm = company.get("name") or "your accountant"
    number = inv.get("number") or ""
    balance = float(inv.get("balance_due") or inv.get("total") or 0.0)
    due_date = inv.get("due_date") or ""
    days_late = 0
    try:
        due_d = datetime.strptime(due_date, "%Y-%m-%d").date()
        days_late = max(0, (datetime.now(timezone.utc).date() - due_d).days)
    except Exception:  # noqa: BLE001
        pass
    subject = f"Friendly reminder — invoice {number} past due"
    body = (
        f"Hi {(contact or {}).get('name') or 'there'},\n\n"
        f"This is a quick reminder that invoice {number} for ${balance:,.2f} "
        f"was due on {due_date}"
        + (f" ({days_late} days ago)" if days_late else "")
        + ".\n\n"
        "Could you let us know when we can expect payment, or reach out "
        "if anything is holding it up?\n\n"
        f"Thank you,\n{firm}"
    )
    try:
        # Try to enrich with the AI drafter if available. Non-fatal.
        from llm_client import LlmChat, UserMessage
        chat = LlmChat(system_prompt=(
            "You are a courteous but firm AR follow-up drafter for a CPA firm. "
            "Write a 3-sentence chase email that references the invoice number, "
            "amount, and how many days it's late. Sign off as the firm name."
        ))
        prompt = (
            f"Firm: {firm}\nCustomer: {(contact or {}).get('name') or 'Customer'}\n"
            f"Invoice: {number} · Amount: ${balance:,.2f} · Due: {due_date} · "
            f"{days_late} days late.\n\nDraft the email body only (no subject)."
        )
        drafted = await chat.send_message(UserMessage(text=prompt))
        if drafted and drafted.strip():
            body = drafted.strip()
    except Exception:  # noqa: BLE001
        pass  # keep the static fallback

    from email_dispatcher import dispatch
    safe = body.replace("\n", "<br>")
    html = (
        "<html><body style='font-family:-apple-system,Segoe UI,Roboto,sans-serif;"
        "font-size:14px;line-height:1.55;color:#0f172a;padding:16px'>"
        f"{safe}</body></html>"
    )

    result = await dispatch(
        kind="customer_statement",
        to=recipient,
        subject=subject,
        html=html,
        initiating_user_id=(inv.get("followup_schedule") or {}).get("updated_by") or "scheduler",
        company_id=cid,
        contact_id=inv.get("contact_id"),
        related={"invoice_id": iid, "invoice_number": number, "origin": "auto"},
    )
    ok = result.get("status") == "sent"
    now_iso = datetime.now(timezone.utc).isoformat()
    # Stamp the step + append to followup_history + last_followup_at.
    await db.invoices.update_one(
        {"id": iid, "company_id": cid},
        {
            "$set": {
                f"followup_schedule.steps.{step_idx}.sent_at": now_iso,
                f"followup_schedule.steps.{step_idx}.sent_status": result.get("status"),
                f"followup_schedule.steps.{step_idx}.email_log_id": result.get("id"),
                "last_followup_at": now_iso,
            },
            "$push": {
                "followup_history": {
                    "sent_at": now_iso,
                    "origin": "auto",
                    "to_email": recipient,
                    "subject": subject,
                    "body": body,
                    "status": result.get("status"),
                    "email_log_id": result.get("id"),
                }
            },
        },
    )
    return ok, str(result.get("status") or "unknown")


async def run_once() -> dict:
    """Scan every invoice with an active schedule and fire due steps."""
    now_iso = datetime.now(timezone.utc).isoformat()
    cursor = db.invoices.find({
        "followup_schedule.enabled": True,
        "status": {"$nin": ["paid", "void", "voided"]},
        # If cockpit-snoozed, respect that too.
        "$or": [
            {"cockpit_snooze_until": {"$exists": False}},
            {"cockpit_snooze_until": None},
            {"cockpit_snooze_until": {"$lte": datetime.now(timezone.utc).date().isoformat()}},
        ],
    })
    sent = 0
    skipped = 0
    scanned = 0
    async for inv in cursor:
        scanned += 1
        steps = list((inv.get("followup_schedule") or {}).get("steps") or [])
        # Find the earliest unsent step that's due.
        due_idx = None
        for i, s in enumerate(steps):
            if s.get("sent_at"):
                continue
            run_at = s.get("run_at") or ""
            if run_at and run_at <= now_iso:
                due_idx = i
                break
        if due_idx is None:
            continue
        try:
            ok, status = await _send_one_step(inv, due_idx)
            if ok:
                sent += 1
                logger.info("Follow-up scheduler: sent invoice=%s step=%s", inv.get("id"), due_idx)
            else:
                skipped += 1
                logger.info("Follow-up scheduler: skipped invoice=%s step=%s reason=%s",
                            inv.get("id"), due_idx, status)
        except Exception:  # noqa: BLE001
            logger.exception("Follow-up scheduler: send failed for invoice=%s step=%s",
                             inv.get("id"), due_idx)
    return {"scanned": scanned, "sent": sent, "skipped": skipped}


async def _loop() -> None:
    logger.info("Invoice follow-up scheduler started (interval=%ss window=%02d:00–%02d:00 %s)",
                SCHEDULER_INTERVAL_SECONDS, SEND_START_HOUR, SEND_END_HOUR, SEND_TZ)
    while True:
        try:
            if _in_send_window():
                summary = await run_once()
                if summary["sent"]:
                    logger.info("Invoice follow-up scheduler: %s", summary)
            else:
                logger.debug("Invoice follow-up tick outside %s window — skipping",
                             SEND_TZ)
        except Exception:  # noqa: BLE001
            logger.exception("Invoice follow-up run failed — will retry next tick")
        await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)


def start_scheduler() -> None:
    """Launch the poll loop. Idempotent — safe to call more than once."""
    global _TASK
    if _TASK and not _TASK.done():
        return
    if os.environ.get("INVOICE_FOLLOWUP_SCHEDULER_DISABLED") == "1":
        logger.info("Invoice follow-up scheduler disabled by env")
        return
    loop = asyncio.get_event_loop()
    _TASK = loop.create_task(_loop(), name="invoice_followup_scheduler")
