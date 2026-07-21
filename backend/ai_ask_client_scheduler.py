"""AI Ask Client — autonomous email loop.

Once an hour *during business hours* (6am–8pm America/New_York by default),
scans every company for recently-flagged transactions that have not yet
been asked about, then emails the client-owner a magic-link question
drafted by the AI. Respects:

* the pro's ``ai_ask_client`` preference (opt-out — defaults ON)
* a per-client-email daily cap of 3 emails / calendar day
* transactions must be < 3 days old (fresh feedback only)
* one focused transaction per email (client burnout is real — the
  magic-link chat itself will offer to chain more once the first is done)
* time-of-day window — no 4am "quick question" pings; also keeps daily-cap
  slots reserved for hours the client is actually awake

Runs as an in-process asyncio background task registered by
``server.py`` at startup. The same body is exposed via HTTP
(:py:func:`routes.communications.run_ai_ask_client`) so pros can trigger
a run on demand (bypasses the time-of-day window) and superadmins can
smoke-test the flow.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from db import db, now_iso
from email_dispatcher import dispatch, get_prefs, public_base_url
import email_templates as tmpl

logger = logging.getLogger(__name__)

# --- Tuning knobs (kept in-code so they can't drift from tests). -----------
LOOKBACK_DAYS = 3
DAILY_CAP_PER_CLIENT = 3
SCHEDULER_INTERVAL_SECONDS = int(os.environ.get("AI_ASK_CLIENT_INTERVAL_SEC", "3600"))
# Business-hour window (inclusive start, exclusive end). Ticks outside
# this window skip the scan entirely — Plaid still pulls txns overnight
# and the next in-window tick will pick them up.
SEND_TZ = os.environ.get("AI_ASK_CLIENT_TZ", "America/New_York")
SEND_START_HOUR = int(os.environ.get("AI_ASK_CLIENT_START_HOUR", "6"))
SEND_END_HOUR = int(os.environ.get("AI_ASK_CLIENT_END_HOUR", "20"))
KIND = "ai_ask_client"


def _in_send_window(now: Optional[datetime] = None) -> bool:
    """True when the current wall-clock hour in ``SEND_TZ`` is within the
    configured [START, END) window."""
    try:
        tz = ZoneInfo(SEND_TZ)
    except Exception:  # noqa: BLE001 — bad tz string → default to always-on
        return True
    now = now or datetime.now(tz)
    hour = now.astimezone(tz).hour
    return SEND_START_HOUR <= hour < SEND_END_HOUR


async def _resolve_client_email(cid: str) -> tuple[Optional[str], str]:
    """Same resolution rule as routes.communications._resolve_client_email —
    duplicated (not imported) to keep the scheduler independent of the
    HTTP router module's circular-import surface."""
    m = await db.memberships.find_one({"company_id": cid, "role": "owner"})
    if m:
        u = await db.users.find_one({"id": m["user_id"]})
        if u:
            return u.get("email"), (u.get("full_name") or u.get("email") or "there")
    c = await db.companies.find_one({"id": cid})
    if c and c.get("contact_email"):
        return c["contact_email"], (c.get("contact_name") or c.get("name") or "there")
    return None, "there"


async def _pro_for_company(cid: str) -> Optional[dict]:
    """Return one pro user with membership on this company (role=pro).
    That pro's ``ai_ask_client`` preference gates the send, and the
    magic-link email is signed with their name."""
    m = await db.memberships.find_one({"company_id": cid, "role": "pro"})
    if not m:
        return None
    return await db.users.find_one({"id": m["user_id"]})


async def _sent_today_to(client_email: str) -> int:
    """How many ai_ask_client emails have gone to this client_email so far
    today (UTC). Only ``sent`` rows count — skipped/failed do not, so a
    misconfigured domain can't spuriously exhaust the cap."""
    today = datetime.now(timezone.utc).date().isoformat()  # YYYY-MM-DD
    return await db.communications.count_documents({
        "kind": KIND, "to": client_email, "status": "sent",
        "sent_at": {"$gte": today},
    })


async def _candidate_txns(cid: str) -> list[dict]:
    """Return recently-flagged transactions that have never been asked
    about, sorted so the most recent is first — we only send ONE per run
    so the most recent flagged charge wins."""
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    txns = await db.transactions.find({
        "company_id": cid,
        "needs_review": True,
        "human_reviewed": {"$ne": True},
        "client_question_id": {"$in": [None, ""]},
        "date": {"$gte": cutoff},
    }).sort("date", -1).to_list(50)
    # Exclude any txn already covered by a pending question in case the
    # ``client_question_id`` write races with a concurrent Pro flow.
    pending = await db.client_questions.find({
        "company_id": cid, "status": "pending",
    }, {"txn_ids": 1, "txn_id": 1}).to_list(500)
    covered: set[str] = set()
    for q in pending:
        for x in (q.get("txn_ids") or []):
            covered.add(x)
        if q.get("txn_id"):
            covered.add(q["txn_id"])
    return [t for t in txns if t["id"] not in covered]


async def _draft_question(txn: dict, company_name: str) -> str:
    """AI-draft the question for a single txn. On error falls back to a
    deterministic template so the loop is never blocked by a Claude blip."""
    try:
        from ai_service import draft_ask_client_question
        counterparty = (
            txn.get("contact_name")
            or (txn.get("merchant") or txn.get("description") or "").split(" ")[0].upper()[:40]
            or "this charge"
        )
        return await draft_ask_client_question(
            counterparty=counterparty, txns=[txn], company_name=company_name,
        )
    except Exception:  # noqa: BLE001
        amt = abs(float(txn.get("amount") or 0))
        return (
            f"What was the ${amt:,.2f} charge from "
            f"{txn.get('description') or 'this vendor'} on {txn.get('date','')} for?"
        )


async def process_company(cid: str) -> dict:
    """One iteration for a single company. Returns a small summary dict.

    Idempotency: skips silently when the pro opted out, the daily cap is
    exhausted, the client has no email on file, or nothing needs asking.
    Only actually sends if all guards clear.
    """
    company = await db.companies.find_one({"id": cid})
    if not company:
        return {"cid": cid, "status": "no_company"}

    pro = await _pro_for_company(cid)
    if not pro:
        return {"cid": cid, "status": "no_pro"}

    prefs = await get_prefs(pro["id"])
    if not prefs.get(KIND, True):
        return {"cid": cid, "status": "pref_off"}

    client_email, client_name = await _resolve_client_email(cid)
    if not client_email:
        return {"cid": cid, "status": "no_client_email"}

    used = await _sent_today_to(client_email)
    if used >= DAILY_CAP_PER_CLIENT:
        return {"cid": cid, "status": "daily_cap_reached", "used": used}

    candidates = await _candidate_txns(cid)
    if not candidates:
        return {"cid": cid, "status": "no_candidates"}

    txn = candidates[0]
    question = await _draft_question(txn, company_name=company.get("name") or "")

    # Materialize the client_question record BEFORE dispatching the email
    # so a webhook/answer arriving before the write finishes still resolves.
    token = secrets.token_urlsafe(24)
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    q_doc = {
        "id": token,
        "company_id": cid,
        "txn_id": txn["id"],
        "txn_ids": [txn["id"]],
        "flow_type": KIND,
        "asked_by_user_id": pro["id"],
        "asked_by_name": (pro.get("full_name") or pro.get("email") or "Your accountant") + " (AI)",
        "question": question,
        "status": "pending",
        "answer": None,
        "sent_at": now_iso(),
        "expires_at": expires,
        "to_email": client_email,
        "counterparty_label": txn.get("contact_name") or "",
    }
    await db.client_questions.insert_one(q_doc)

    await db.transactions.update_one(
        {"id": txn["id"], "company_id": cid},
        {"$set": {
            "needs_review": True,
            "ai_comment": (txn.get("ai_comment") or "")
                          + f"\n\n[AI asked client on {now_iso()[:10]}]: {question}",
            "client_question_id": token,
            "updated_at": now_iso(),
        }},
    )

    magic_url = f"{public_base_url()}/q/{token}"
    subject, html = tmpl.ai_ask_client(
        pro_name=pro.get("full_name") or pro.get("email") or "Your accountant",
        company_name=company.get("name") or "",
        txn=txn,
        question=question,
        magic_url=magic_url,
    )
    result = await dispatch(
        kind=KIND,
        to=client_email,
        subject=subject, html=html,
        initiating_user_id=pro["id"],
        company_id=cid,
        related={"txn_id": txn["id"], "question_id": token, "auto": True},
    )
    return {
        "cid": cid,
        "status": result["status"],
        "question_id": token,
        "communication_id": result.get("id"),
        "txn_id": txn["id"],
    }


async def run_once() -> dict:
    """Iterate every company and process it. Called by the scheduler tick
    and by the manual-run HTTP endpoint. Never raises — per-company
    failures are captured in the summary so one bad tenant can't block the
    rest of the run."""
    companies = await db.companies.find({}, {"id": 1}).to_list(5000)
    summaries: list[dict] = []
    for c in companies:
        try:
            summaries.append(await process_company(c["id"]))
        except Exception as e:  # noqa: BLE001
            logger.exception("AI ask-client failed for cid=%s", c["id"])
            summaries.append({"cid": c["id"], "status": "error", "error": str(e)})
    sent = sum(1 for s in summaries if s.get("status") == "sent")
    return {"companies": len(summaries), "sent": sent, "details": summaries}


# ---------------------------------------------------------------------------
# Background loop registration
# ---------------------------------------------------------------------------
_TASK: Optional[asyncio.Task] = None


async def _loop() -> None:
    # Small warm-up so we don't spam on process restart loops.
    await asyncio.sleep(30)
    while True:
        try:
            if _in_send_window():
                summary = await run_once()
                if summary["sent"]:
                    logger.info("AI ask-client: sent=%s companies=%s",
                                summary["sent"], summary["companies"])
            else:
                logger.debug(
                    "AI ask-client tick outside %s window (%02d:00–%02d:00 %s) — skipping scan",
                    SEND_TZ, SEND_START_HOUR, SEND_END_HOUR, SEND_TZ,
                )
        except Exception:  # noqa: BLE001
            logger.exception("AI ask-client run failed — will retry next tick")
        await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)


def start_scheduler() -> None:
    """Launch the hourly loop. Idempotent — safe to call more than once."""
    global _TASK
    if _TASK and not _TASK.done():
        return
    if os.environ.get("AI_ASK_CLIENT_SCHEDULER_DISABLED") == "1":
        logger.info("AI ask-client scheduler disabled by env")
        return
    loop = asyncio.get_event_loop()
    _TASK = loop.create_task(_loop(), name="ai_ask_client_scheduler")
    logger.info(
        "AI ask-client scheduler started (interval=%ss window=%02d:00–%02d:00 %s)",
        SCHEDULER_INTERVAL_SECONDS, SEND_START_HOUR, SEND_END_HOUR, SEND_TZ,
    )


def stop_scheduler() -> None:
    global _TASK
    if _TASK and not _TASK.done():
        _TASK.cancel()
    _TASK = None
