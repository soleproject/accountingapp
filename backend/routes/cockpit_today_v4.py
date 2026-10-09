"""Cockpit — Today v4 aggregate endpoint.

Manager-view dashboard: what the AI junior is doing so the CPA doesn't
have to. Composes signal from ingestion writes, learned rules, W-9
outreach, month-closes, client-review batches, and reconciliation.
Any metric we can't source cleanly today is served with `mocked: True`
so the frontend can render a subtle chip — no fake numbers.

One endpoint → one round trip → one dashboard.
"""
from __future__ import annotations
import uuid
from calendar import monthrange
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from db import db
from auth import get_current_user
from routes.cockpit import require_firm_or_pro
from routes.month_close import _maybe_auto_lock


router = APIRouter(prefix="/api/cockpit")


# Time-saved heuristic (seconds per AI-handled event) — see design doc.
SEC_PER_AUTO_POST = 30
SEC_PER_TRANSFER_MATCH = 60
SEC_PER_ALIAS = 45
SEC_PER_RULE = 300
SEC_PER_W9 = 900


def _since_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _since_date(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def _iso_ago(iso) -> str:
    if not iso:
        return ""
    try:
        d = iso if isinstance(iso, datetime) else datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return ""
    now = datetime.now(timezone.utc)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    if d.date() == now.date():
        return d.strftime("%-I:%M %p")
    diff = (now.date() - d.date()).days
    if diff == 1:
        return "Yesterday"
    if 0 < diff < 7:
        return f"{diff}d ago"
    return d.strftime("%b %-d")


def _hour_str(iso) -> str:
    if not iso:
        return ""
    try:
        d = iso if isinstance(iso, datetime) else datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.strftime("%-I:%M %p")
    except Exception:  # noqa: BLE001
        return ""


@router.get("/pending-reconciliations")
async def cockpit_pending_reconciliations(
    user: dict = Depends(get_current_user),
):
    """Cross-company Pending Reconciliations roll-up.

    One row per (company × prior-month account) with its auto-finalize
    status. Powers the "Pending Reconciliations" card that appears below
    Closings during the end-of-month → day-6 handoff window.
    """
    from reconciliation_engine import PROVISIONAL_DAYS
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"empty": True, "companies": []}
    today = datetime.now(timezone.utc).date()
    if today.month == 1:
        py, pm = today.year - 1, 12
    else:
        py, pm = today.year, today.month - 1
    last = monthrange(py, pm)[1]
    prior_start = f"{py:04d}-{pm:02d}-01"
    prior_end = f"{py:04d}-{pm:02d}-{last:02d}"
    eligible_at = (datetime(py, pm, last) + timedelta(days=PROVISIONAL_DAYS)).date()
    waiting = today < eligible_at
    days_left = (eligible_at - today).days if waiting else 0

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(2000)
    out = []
    for c in companies:
        cid = c["id"]
        # Reuse the per-company endpoint logic inline to keep one source
        # of truth for status derivation. Pull all Plaid mappings, foreign-
        # txn hints, and existing full-month recon docs in bulk.
        mapped_ledger_ids: set[str] = set()
        async for item in db.plaid_items.find({"company_id": cid}):
            for pa_id, mp in (item.get("account_mappings") or {}).items():
                lid = mp.get("ledger_account_id")
                if lid:
                    mapped_ledger_ids.add(lid)

        # Candidate accounts: Plaid-mapped OR with prior-month txns.
        candidate_ids: set[str] = set(mapped_ledger_ids)
        async for row in db.transactions.aggregate([
            {"$match": {
                "company_id": cid, "posted": True,
                "bank_account_id": {"$exists": True, "$ne": None},
                "date": {"$gte": prior_start, "$lte": prior_end},
            }},
            {"$group": {"_id": "$bank_account_id"}},
        ]):
            candidate_ids.add(row["_id"])
        if not candidate_ids:
            continue
        accts = {}
        async for a in db.accounts.find(
            {"company_id": cid, "id": {"$in": list(candidate_ids)}},
            {"_id": 0, "id": 1, "code": 1, "name": 1, "type": 1},
        ):
            accts[a["id"]] = a

        rows = []
        for aid in candidate_ids:
            a = accts.get(aid) or {"id": aid, "name": "—", "code": "", "type": ""}
            existing = await db.reconciliations.find_one({
                "company_id": cid, "bank_account_id": aid,
                "status": {"$in": ["reconciled", "qbo_covered"]},
                "period_start": {"$lte": prior_start},
                "period_end": {"$gte": prior_end},
            }, sort=[("period_end", -1)])
            txn_count = await db.transactions.count_documents({
                "company_id": cid, "bank_account_id": aid, "posted": True,
                "date": {"$gte": prior_start, "$lte": prior_end},
            })
            is_plaid_mapped = aid in mapped_ledger_ids
            # This card is strictly about *auto*-reconciliations. Accounts
            # without a Plaid connection can only be reconciled manually,
            # so they belong on the Reconciliation Month Roster — not here.
            if not is_plaid_mapped and not existing:
                continue
            has_foreign = False
            if is_plaid_mapped:
                fd = await db.transactions.find_one({
                    "company_id": cid, "bank_account_id": aid,
                    "source": {"$not": {"$regex": "^plaid"}},
                    "posted": True,
                })
                has_foreign = bool(fd)
            if existing:
                status = "auto_reconciled" if existing.get("auto_generated") else "manually_reconciled"
                reason = f"{existing.get('source','manual')} · {str(existing.get('completed_at',''))[:10]}"
            elif has_foreign:
                status, reason = "ineligible_non_plaid", "Non-Plaid txns on account"
            elif waiting:
                status = "waiting_settle"
                reason = f"Plaid settle · {days_left} day{'s' if days_left != 1 else ''} left"
            else:
                status, reason = "ready_next_sync", "Will auto-finalize on next sync"
            rows.append({
                "account_id": aid,
                "account_code": a.get("code") or "",
                "account_name": a.get("name") or "—",
                "account_type": a.get("type") or "",
                "txn_count": txn_count,
                "plaid_mapped": is_plaid_mapped,
                "status": status, "reason": reason,
                "verification_method": (existing or {}).get("verification_method"),
            })
        order = {
            "ineligible_non_plaid": 0,
            "waiting_settle": 1, "ready_next_sync": 2,
            "auto_reconciled": 3, "manually_reconciled": 4,
        }
        rows.sort(key=lambda r: (order.get(r["status"], 9), r["account_code"]))
        if not rows:
            continue
        out.append({
            "company_id": cid,
            "company_name": c.get("name") or "Untitled",
            "rows": rows,
            "totals": {
                "accounts": len(rows),
                "done": sum(1 for r in rows if r["status"] in ("auto_reconciled", "manually_reconciled")),
                "waiting": sum(1 for r in rows if r["status"] == "waiting_settle"),
                "ready": sum(1 for r in rows if r["status"] == "ready_next_sync"),
                "manual": sum(1 for r in rows if r["status"] == "ineligible_non_plaid"),
            },
        })
    # Sort companies: those with pending/manual work first, done-only last.
    out.sort(key=lambda c: (
        -c["totals"]["manual"],
        -c["totals"]["waiting"],
        -c["totals"]["ready"],
    ))
    return {
        "month": f"{py:04d}-{pm:02d}",
        "period_start": prior_start,
        "period_end": prior_end,
        "settle_days": PROVISIONAL_DAYS,
        "eligible_at": eligible_at.isoformat(),
        "today": today.isoformat(),
        "waiting": waiting,
        "days_left": days_left,
        "companies": out,
    }


EMAIL_Q_GROUPS = {
    "ai_ask_client":            "quick_ones",
    "ask_client":               "quick_ones",
    "client_review_batch":      "qc_emails",
    "client_welcome":           "setup_invites",
    "client_welcome_returning": "setup_invites",
    "portal_invite":            "setup_invites",
    "team_invite":              "setup_invites",
}


async def _email_scope(user: dict) -> tuple[list[str], dict]:
    """Companies whose outbound client emails this user may see.
    superadmin → all · enterprise owner → every company served by any pro
    in their enterprise (same rule as the Enterprises page rollup) ·
    pro → own memberships."""
    base = await require_firm_or_pro(user)
    role = (user.get("role") or "").lower()
    if role == "superadmin":
        return base, {"scope": "superadmin"}
    ent = await db.enterprises.find_one({"owner_user_id": user["id"]}, {"_id": 0, "id": 1, "name": 1})
    if ent:
        from enterprises import rollup_stats
        stats = await rollup_stats(ent["id"])
        ids = list({*base, *(stats.get("company_ids") or [])})
        return ids, {"scope": "enterprise", "enterprise_name": ent.get("name")}
    return base, {"scope": "pro"}


@router.get("/email-questions")
async def cockpit_email_questions(
    user: dict = Depends(get_current_user),
    days: int = Query(60, ge=1, le=365),
):
    """Every client-facing ask / set-up email the platform sent for the
    companies in this user's scope, joined to its outcome (answered,
    activated, accepted, completed, expired, still waiting)."""
    accessible, scope = await _email_scope(user)
    if not accessible:
        return {"rows": [], **scope}
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    since = (now - timedelta(days=days)).isoformat()

    co_names: dict[str, str] = {}
    async for c in db.companies.find({"id": {"$in": accessible}}, {"_id": 0, "id": 1, "name": 1}):
        co_names[c["id"]] = c.get("name") or "Untitled"

    comms = await db.communications.find({
        "company_id": {"$in": accessible},
        "kind": {"$in": list(EMAIL_Q_GROUPS)},
        "sent_at": {"$gte": since},
    }, {"_id": 0, "html": 0}).sort("sent_at", -1).to_list(400)

    def rel(c, k):
        return (c.get("related") or {}).get(k)

    q_ids = [rel(c, "question_id") for c in comms if rel(c, "question_id")]
    b_ids = [rel(c, "batch_id") for c in comms if rel(c, "batch_id")]
    t_ids = [rel(c, "password_set_token") for c in comms if rel(c, "password_set_token")]
    i_ids = [rel(c, "invite_id") for c in comms if rel(c, "invite_id")]

    questions = {q["id"]: q async for q in db.client_questions.find(
        {"id": {"$in": q_ids}}, {"_id": 0, "id": 1, "status": 1, "answered_at": 1, "question": 1, "expires_at": 1})} if q_ids else {}
    batches = {b["id"]: b async for b in db.client_review_batches.find(
        {"id": {"$in": b_ids}}, {"_id": 0, "id": 1, "status": 1, "client_token": 1, "completed_at": 1,
                                 "answer_count": 1, "items.item_id": 1})} if b_ids else {}
    tokens = {t["id"]: t async for t in db.password_set_tokens.find(
        {"id": {"$in": t_ids}}, {"_id": 0, "id": 1, "used": 1, "used_at": 1, "expires_at": 1})} if t_ids else {}
    invites = {i["id"]: i async for i in db.invites.find(
        {"id": {"$in": i_ids}}, {"_id": 0, "id": 1, "status": 1, "accepted_at": 1, "expires_at": 1})} if i_ids else {}

    def _days(iso):
        try:
            d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return max(0, (now - d).days)
        except Exception:  # noqa: BLE001
            return 0

    def _expired(iso):
        return bool(iso) and str(iso) < now_iso

    rows = []
    for c in comms:
        kind = c.get("kind")
        delivered = c.get("status") == "sent"
        outcome = "waiting" if delivered else "not_delivered"
        outcome_at = open_url = detail = None
        if kind in ("ai_ask_client", "ask_client"):
            q = questions.get(rel(c, "question_id") or "")
            if q:
                detail = q.get("question")
                open_url = f"/q/{q['id']}"
                if q.get("status") == "answered" or q.get("answered_at"):
                    outcome, outcome_at = "answered", q.get("answered_at")
                elif delivered and (q.get("status") == "expired" or _expired(q.get("expires_at"))):
                    outcome = "expired"
        elif kind == "client_review_batch":
            b = batches.get(rel(c, "batch_id") or "")
            if b:
                if b.get("client_token"):
                    open_url = f"/client-review/{b['client_token']}"
                detail = f"{int(b.get('answer_count') or 0)}/{len(b.get('items') or [])} answered"
                if b.get("status") == "completed":
                    outcome, outcome_at = "completed", b.get("completed_at")
                elif delivered and b.get("status") == "expired":
                    outcome = "expired"
        elif kind in ("client_welcome", "client_welcome_returning"):
            t = tokens.get(rel(c, "password_set_token") or "")
            if t:
                if t.get("used"):
                    outcome, outcome_at = "activated", t.get("used_at")
                elif delivered and _expired(t.get("expires_at")):
                    outcome = "expired"
            elif kind == "client_welcome_returning" and delivered:
                outcome = "info"
        elif kind == "team_invite":
            i = invites.get(rel(c, "invite_id") or "")
            detail = f"role: {rel(c, 'role') or '—'}"
            if i:
                st = i.get("status")
                if st == "accepted":
                    outcome, outcome_at = "accepted", i.get("accepted_at")
                elif st in ("revoked", "superseded"):
                    outcome = st
                elif delivered and _expired(i.get("expires_at")):
                    outcome = "expired"
        elif kind == "portal_invite" and delivered:
            outcome = "info"

        rows.append({
            "id":           c.get("id"),
            "kind":         kind,
            "group":        EMAIL_Q_GROUPS.get(kind, "other"),
            "to":           c.get("to"),
            "subject":      c.get("subject"),
            "delivery":     c.get("status"),
            "error":        c.get("error"),
            "sent_at":      c.get("sent_at"),
            "days_since":   _days(c.get("sent_at")),
            "company_id":   c.get("company_id"),
            "company_name": co_names.get(c.get("company_id") or "", "—"),
            "outcome":      outcome,
            "outcome_at":   outcome_at,
            "detail":       detail,
            "open_url":     open_url,
        })
    return {"rows": rows, "days": days, **scope}


@router.post("/scheduled-qc/{batch_id}/nudge")
async def cockpit_scheduled_qc_nudge(
    batch_id: str,
    user: dict = Depends(get_current_user),
):
    """One-click re-ping from the Missed / No Response rows. Sends the
    three-CTA reminder (answer now / pick a time / talk to bookkeeper)
    and stamps `manual_nudge_at` so the row can show it."""
    import client_review as cr
    accessible = await require_firm_or_pro(user)
    batch = await db.client_review_batches.find_one({"id": batch_id})
    if not batch or batch.get("company_id") not in (accessible or []):
        raise HTTPException(404, "Check-in not found")
    if batch.get("status") in ("completed", "expired"):
        raise HTTPException(409, f"Check-in is {batch.get('status')} — a fresh one will be generated instead")
    if not batch.get("client_email"):
        raise HTTPException(400, "No client email on this check-in")
    result = await cr._dispatch_reminder(batch, kind="passive_miss")
    status = result.get("status")
    now = datetime.now(timezone.utc).isoformat()
    if status == "sent":
        await db.client_review_batches.update_one(
            {"id": batch_id},
            {"$set": {"manual_nudge_at": now, "updated_at": now},
             "$inc": {"manual_nudge_count": 1}},
        )
    return {"ok": status == "sent", "status": status,
            "to": batch.get("client_email"), "manual_nudge_at": now if status == "sent" else None,
            "error": result.get("error")}


@router.get("/scheduled-qc")
async def cockpit_scheduled_qc(
    user: dict = Depends(get_current_user),
):
    """Scheduled Quick Check-in roster for the In Progress panel.

    Three signals, cross-company:
      * `scheduled`      — batches in `scheduled` state waiting to be
                           sent on their `scheduled_for` date.
      * `sent_awaiting`  — batches whose email was dispatched but the
                           client has not answered or let it expire.
      * `last_completed` — most recent completion per (company, client)
                           so pros can see who's engaged and who's gone
                           quiet. Includes "never completed" rows for
                           clients we've emailed at least once but who
                           never finished a batch.
    """
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"scheduled": [], "in_progress": [], "missed": [], "sent_awaiting": [],
                "expired_no_response": [], "completed": [], "last_completed": []}
    now = datetime.now(timezone.utc)

    co_names: dict[str, str] = {}
    async for c in db.companies.find(
        {"id": {"$in": accessible}}, {"_id": 0, "id": 1, "name": 1},
    ):
        co_names[c["id"]] = c.get("name") or "Untitled"

    def _dt(v):
        try:
            d = v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except Exception:  # noqa: BLE001
            return None

    def _pro_answered(items: list) -> dict:
        stamped = [it for it in items if it.get("answered_by")]
        names = []
        for it in stamped:
            n = (it["answered_by"].get("name") or "").split(",")[0].strip()
            if n and n not in names:
                names.append(n)
        return {"pro_answered": len(stamped), "pro_names": names}

    # One pass over every live batch. Buckets:
    #   scheduled   — client picked a time (status=scheduled) that is still ahead
    #   in_progress — client has engaged (answers / defers / snoozes / follow-up)
    #                 but hasn't finished
    #   missed      — picked time has passed with zero engagement
    #   no_response — emailed, never engaged, no time picked (or picked time
    #                 not applicable)
    scheduled: list[dict] = []
    in_progress: list[dict] = []
    missed: list[dict] = []
    sent_awaiting: list[dict] = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": {"$in": ["scheduled", "open", "in_progress", "sent", "reminded"]},
    }).sort("updated_at", -1).limit(400):
        items = b.get("items") or []
        total = len(items)
        answered = int(b.get("answer_count") or 0)
        deferred = int(b.get("defer_count") or 0)
        snoozed = [it for it in items
                   if it.get("snoozed_until") and not it.get("answered_at") and not it.get("deferred")]
        engaged = (answered + deferred) > 0 or bool(b.get("follow_up_at")) or bool(snoozed)
        sf_dt = _dt(b.get("scheduled_for"))
        sent_dt = _dt(b.get("email_sent_at"))
        days_waiting = max(0, (now - sent_dt).days) if sent_dt else 0
        next_snooze = min((it["snoozed_until"] for it in snoozed), default=None)
        row = {
            "batch_id":      b.get("id"),
            "client_token":  b.get("client_token"),
            "company_id":    b.get("company_id"),
            "company_name":  co_names.get(b.get("company_id") or "", "—"),
            "client_email":  b.get("client_email"),
            "scheduled_for": b.get("scheduled_for"),
            "email_sent_at": b.get("email_sent_at"),
            "expires_at":    b.get("expires_at"),
            "item_count":    total,
            "answered":      answered,
            "deferred":      deferred,
            "progress_pct":  int(100 * (answered + deferred) / total) if total else 0,
            "days_waiting":  days_waiting,
            "note":          b.get("note") or "",
            "reminder_sent": bool(b.get("reminder_sent_at")),
            "nudge_sent":    bool(b.get("nudge_sent_at")),
            "manual_nudge_at": b.get("manual_nudge_at"),
            "manual_nudge_count": int(b.get("manual_nudge_count") or 0),
            "follow_up_at":  b.get("follow_up_at"),
            "snoozed_count": len(snoozed),
            "next_snooze_at": next_snooze,
            **_pro_answered(items),
            "parked": [{
                "item_id":   it.get("item_id"),
                "prompt":    it.get("prompt") or "",
                "item_type": it.get("item_type"),
                "remind_at": it.get("snoozed_until"),
                "reminded":  bool(it.get("snooze_reminded_at")),
            } for it in sorted(snoozed, key=lambda x: str(x.get("snoozed_until")))],
            "updated_at":    b.get("updated_at"),
        }
        if engaged:
            in_progress.append(row)
        elif b.get("status") == "scheduled" and sf_dt is not None:
            if sf_dt >= now:
                scheduled.append(row)
            else:
                row["days_past"] = (now - sf_dt).days
                missed.append(row)
        elif sent_dt is not None:
            sent_awaiting.append(row)
    scheduled.sort(key=lambda r: str(r["scheduled_for"]))
    missed.sort(key=lambda r: -r["days_past"])
    in_progress.sort(key=lambda r: str(r.get("follow_up_at") or r.get("next_snooze_at") or "~") + str(r.get("updated_at") or ""))
    sent_awaiting.sort(key=lambda r: -r["days_waiting"])

    # Ghosted — link lapsed with zero answers in the last 60 days.
    expired_no_response: list[dict] = []
    async for b in db.client_review_batches.find({
        "company_id":   {"$in": accessible},
        "status":       "expired",
        "expired_at":   {"$gte": (now - timedelta(days=60)).isoformat()},
        "answer_count": {"$in": [None, 0]},
    }).sort("expired_at", -1).limit(100):
        expired_no_response.append({
            "batch_id":     b.get("id"),
            "client_token": b.get("client_token"),
            "company_id":   b.get("company_id"),
            "company_name": co_names.get(b.get("company_id") or "", "—"),
            "client_email": b.get("client_email"),
            "scheduled_for": b.get("scheduled_for"),
            "email_sent_at": b.get("email_sent_at"),
            "expired_at":   b.get("expired_at"),
            "item_count":   len(b.get("items") or []),
        })

    completed: list[dict] = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status":     "completed",
    }).sort("completed_at", -1).limit(60):
        completed.append({
            "batch_id":     b.get("id"),
            "client_token": b.get("client_token"),
            "company_id":   b.get("company_id"),
            "company_name": co_names.get(b.get("company_id") or "", "—"),
            "client_email": b.get("client_email"),
            "completed_at": b.get("completed_at"),
            "email_sent_at": b.get("email_sent_at"),
            "item_count":   len(b.get("items") or []),
            "answered":     int(b.get("answer_count") or 0),
            "deferred":     int(b.get("defer_count") or 0),
            **_pro_answered(b.get("items") or []),
        })

    # Last completed per (company, client_email). Groups across all
    # accessible companies in one aggregate pass. Also surface clients
    # we've emailed at least once but have never completed anything.
    last_completed_map: dict[tuple[str, str], dict] = {}
    async for row in db.client_review_batches.aggregate([
        {"$match": {
            "company_id": {"$in": accessible},
            "status":     "completed",
        }},
        {"$sort":  {"completed_at": -1}},
        {"$group": {
            "_id": {"cid": "$company_id", "email": "$client_email"},
            "completed_at": {"$first": "$completed_at"},
            "batch_id":     {"$first": "$id"},
            "client_token": {"$first": "$client_token"},
            "item_count":   {"$first": {"$size": {"$ifNull": ["$items", []]}}},
        }},
    ]):
        k = (row["_id"]["cid"], row["_id"]["email"] or "")
        last_completed_map[k] = {
            "company_id":   row["_id"]["cid"],
            "company_name": co_names.get(row["_id"]["cid"], "—"),
            "client_email": row["_id"]["email"],
            "completed_at": row.get("completed_at"),
            "batch_id":     row.get("batch_id"),
            "client_token": row.get("client_token"),
            "item_count":   row.get("item_count") or 0,
            "never":        False,
        }

    # Any (company, client) we've emailed but never completed → surface
    # too so the pro sees stale engagements.
    seen_contacted: set[tuple[str, str]] = set()
    async for row in db.client_review_batches.aggregate([
        {"$match": {
            "company_id":    {"$in": accessible},
            "email_sent_at": {"$ne": None},
        }},
        {"$group": {
            "_id": {"cid": "$company_id", "email": "$client_email"},
            "first_sent":   {"$min": "$email_sent_at"},
        }},
    ]):
        k = (row["_id"]["cid"], row["_id"]["email"] or "")
        seen_contacted.add(k)
        if k in last_completed_map:
            continue
        last_completed_map[k] = {
            "company_id":   row["_id"]["cid"],
            "company_name": co_names.get(row["_id"]["cid"], "—"),
            "client_email": row["_id"]["email"],
            "completed_at": None,
            "first_sent":   row.get("first_sent"),
            "never":        True,
        }

    last_completed = sorted(
        last_completed_map.values(),
        key=lambda r: (r["never"], -(1 if r.get("completed_at") else 0),
                       str(r.get("completed_at") or r.get("first_sent") or "")),
        reverse=False,
    )

    return {
        "scheduled":      scheduled,
        "in_progress":    in_progress,
        "missed":         missed,
        "sent_awaiting":  sent_awaiting,
        "expired_no_response": expired_no_response,
        "completed":      completed,
        "last_completed": last_completed,
    }


@router.get("/today-v4")
async def today_v4(
    days: int = Query(7, ge=1, le=90),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"empty": True, "days": days}

    since_dt_iso = _since_iso(days)
    since_date = _since_date(days)

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(2000)
    name_by_id = {c["id"]: c.get("name") or "Untitled" for c in companies}
    now = datetime.now(timezone.utc)

    # Assistant items the user has recently "Mark contacted"-ed drop
    # off tomorrow's list for 24h (item_id-scoped, not per-user).
    contacted_since = (now - timedelta(hours=24)).isoformat()
    contacted_ids: set[str] = set()
    async for row in db.assistant_contact_log.find({
        "company_id": {"$in": accessible},
        "contacted_at": {"$gte": contacted_since},
    }, {"item_id": 1}):
        if row.get("item_id"):
            contacted_ids.add(row["item_id"])

    # ---- 1. AI ACTIVITY PULSE -------------------------------------
    txns_total = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
    })
    txns_prev = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": _since_date(days * 2), "$lt": since_date},
    })
    # auto-posted rows carry ai_source ∈ {rule, contact_directory, plaid_pfc, llm}
    # and needs_review=False; anything else is either pro-touched or in queue.
    auto_posted = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
        "needs_review": False,
        "ai_source": {"$exists": True, "$nin": [None, ""]},
    })
    queued = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
        "needs_review": True,
    })
    rules_learned = await db.rules.count_documents({
        "company_id": {"$in": accessible},
        "created_at": {"$gte": since_dt_iso},
    })
    w9_captured = await db.agent_findings.count_documents({
        "company_id": {"$in": accessible},
        "kind": "w9_auto_captured",
        "created_at": {"$gte": since_dt_iso},
    })
    aliases_learned = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "posted_at": {"$gte": since_dt_iso},
        "contact_resolution": "alias",
    })
    # Bank-match count — auto_match_bank_feed writes a hint on the txn
    transfer_matches = await db.transactions.count_documents({
        "company_id": {"$in": accessible},
        "date": {"$gte": since_date},
        "transfer_matched_at": {"$exists": True},
    })

    # Sparkline: last N days daily txn counts
    daily_counts = []
    for i in range(days - 1, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        c = await db.transactions.count_documents({
            "company_id": {"$in": accessible}, "date": d,
        })
        daily_counts.append({"date": d, "count": c})

    # Velocity: rolling auto-posted % per day for last 30d
    velocity_series = []
    for i in range(29, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        total = await db.transactions.count_documents({
            "company_id": {"$in": accessible}, "date": d,
        })
        auto = await db.transactions.count_documents({
            "company_id": {"$in": accessible}, "date": d,
            "needs_review": False,
            "ai_source": {"$exists": True, "$nin": [None, ""]},
        })
        pct = round(auto / total * 100, 1) if total else 0
        velocity_series.append({"date": d, "pct": pct})

    seconds_saved = (
        auto_posted * SEC_PER_AUTO_POST +
        transfer_matches * SEC_PER_TRANSFER_MATCH +
        aliases_learned * SEC_PER_ALIAS +
        rules_learned * SEC_PER_RULE +
        w9_captured * SEC_PER_W9
    )
    hours_saved = round(seconds_saved / 3600.0, 1)
    tasks_handled = auto_posted + transfer_matches + aliases_learned + rules_learned + w9_captured

    time_saved_donut = [
        {"key": "categorization", "label": "Categorization",
         "hours": round(auto_posted * SEC_PER_AUTO_POST / 3600, 1)},
        {"key": "reconciliation", "label": "Reconciliation & transfers",
         "hours": round(transfer_matches * SEC_PER_TRANSFER_MATCH / 3600, 1)},
        {"key": "learning", "label": "Contact / alias learning",
         "hours": round(aliases_learned * SEC_PER_ALIAS / 3600, 1)},
        {"key": "rules", "label": "Rules mined",
         "hours": round(rules_learned * SEC_PER_RULE / 3600, 1)},
        {"key": "w9", "label": "W-9 capture",
         "hours": round(w9_captured * SEC_PER_W9 / 3600, 1)},
    ]

    pct_change = 0
    if txns_prev > 0:
        pct_change = round((txns_total - txns_prev) / txns_prev * 100, 1)

    activity = {
        "txns_processed": {
            "value": txns_total,
            "sparkline": daily_counts,
            "delta_pct": pct_change,
        },
        "auto_posted": {
            "count": auto_posted,
            "pct": round(auto_posted / txns_total * 100, 1) if txns_total else 0,
            "queued_count": queued,
        },
        "rules_learned": rules_learned,
        "w9_captured": w9_captured,
        "time_saved_donut": time_saved_donut,
        "velocity_series": velocity_series,
    }

    # ---- 2. CLIENT CONVERSATIONS ----------------------------------
    today_iso = now.date().isoformat()
    end_of_day = (now.replace(hour=23, minute=59, second=59)).isoformat()
    # Whole-week window for the schedule grid (Mon..Sun of the current week).
    week_start = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    week_end = (week_start + timedelta(days=6)).replace(
        hour=23, minute=59, second=59,
    )

    scheduled_today = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": "scheduled",
        "scheduled_for": {"$gte": week_start.isoformat(), "$lte": week_end.isoformat()},
    }).sort("scheduled_for", 1).limit(40):
        items = b.get("items") or []
        try:
            dt = datetime.fromisoformat(str(b.get("scheduled_for")).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dow = dt.weekday()  # 0=Mon..6=Sun
        except Exception:  # noqa: BLE001
            dow = 0
        scheduled_today.append({
            "id": b.get("id"),
            "company": name_by_id.get(b.get("company_id"), ""),
            "at": _hour_str(b.get("scheduled_for")),
            "count": len(items),
            "types": _item_type_mix(items),
            "dow": dow,
            "scheduled_for": b.get("scheduled_for"),
            "route": f"/cockpit/requests?batch={b.get('id')}",
        })

    in_progress = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": "in_progress",
    }).sort("updated_at", -1).limit(8):
        items = b.get("items") or []
        answered = sum(1 for it in items if it.get("status") in ("answered", "deferred"))
        current = next((it for it in items if it.get("status") not in ("answered", "deferred")), None)
        in_progress.append({
            "id": b.get("id"),
            "client_token": b.get("client_token"),
            "company_id": b.get("company_id"),
            "company": name_by_id.get(b.get("company_id"), ""),
            "answered": answered,
            "total": len(items),
            "current_type": (current or {}).get("kind") or "…",
            "started_ago": _iso_ago(b.get("started_at") or b.get("sent_at")),
            "route": f"/cockpit/requests?batch={b.get('id')}",
        })

    waiting = []
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": {"$in": ["sent", "reminded", "passive_miss"]},
    }).sort("sent_at", 1).limit(10):
        # Skip if the assistant surfaced this batch in the last 24h
        # and the user already marked it contacted.
        if f"wait-{b.get('id')}" in contacted_ids:
            continue
        sent_at = b.get("sent_at")
        try:
            sent_dt = datetime.fromisoformat(str(sent_at).replace("Z", "+00:00"))
            if sent_dt.tzinfo is None:
                sent_dt = sent_dt.replace(tzinfo=timezone.utc)
            days_silent = (now - sent_dt).days
        except Exception:  # noqa: BLE001
            days_silent = 0
        waiting.append({
            "id": b.get("id"),
            "client_token": b.get("client_token"),
            "company_id": b.get("company_id"),
            "company": name_by_id.get(b.get("company_id"), ""),
            "count": len(b.get("items") or []),
            "days_silent": days_silent,
            "reminder_at": _hour_str(b.get("reminder_at")),
            "route": f"/cockpit/requests?batch={b.get('id')}",
        })

    client_messages = []
    async for m in db.client_messages.find({
        "company_id": {"$in": accessible},
    }, {"_id": 0}).sort("updated_at", -1).limit(100):
        m["company"] = m.get("company_name") or name_by_id.get(m.get("company_id"), "")
        m["age"] = _iso_ago(m.get("created_at"))
        client_messages.append(m)

    conversations = {
        "scheduled_today": scheduled_today,
        "in_progress": in_progress,
        "client_messages": client_messages,
        "waiting_on_client": waiting,
        "empty": len(scheduled_today) == 0 and len(in_progress) == 0 and len(waiting) == 0,
    }

    # ---- 3. BOOKS PULSE -------------------------------------------
    client_health = []
    for c in companies:
        cid = c["id"]
        total = await db.transactions.count_documents({"company_id": cid})
        unrev = await db.transactions.count_documents({
            "company_id": cid, "needs_review": True,
        })
        recon_pct = 100 if total == 0 else round(max(0, 1 - unrev / total) * 100)
        # Cash sparkline: 7-day balance running total
        cash_spark = []
        running = 0.0
        for i in range(6, -1, -1):
            d = (now - timedelta(days=i)).date().isoformat()
            day_sum_rows = await db.transactions.aggregate([
                {"$match": {"company_id": cid, "date": d}},
                {"$group": {"_id": None, "s": {"$sum": "$amount"}}}
            ]).to_list(1)
            running += (day_sum_rows[0]["s"] if day_sum_rows else 0)
            cash_spark.append(round(running))
        # Last close status — most recent "closed" signoff for this company.
        last_close = await db.month_close_signoffs.find_one(
            {"company_id": cid, "kind": "closed"},
            sort=[("year", -1), ("month", -1)],
        )
        close_state = "Not started"
        if last_close:
            try:
                ly = int(last_close.get("year"))
                lm = int(last_close.get("month"))
                close_state = f"{datetime(ly, lm, 1).strftime('%b %Y')} ✓"
            except Exception:  # noqa: BLE001
                close_state = "—"
        client_health.append({
            "id": cid,
            "name": c.get("name") or "Untitled",
            "recon_pct": recon_pct,
            "cash_spark": cash_spark,
            "cash_current": cash_spark[-1] if cash_spark else 0,
            "close_state": close_state,
            "open_items": unrev,
        })
    # Least healthy first
    client_health.sort(key=lambda x: x["recon_pct"])

    # Cross-client daily volume: last 14d, top 5 clients
    top_ids = [c["id"] for c in client_health[:5]] or [c["id"] for c in companies[:5]]
    cross_volume = []
    for i in range(13, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        row = {"date": d}
        for cid in top_ids:
            row[cid] = await db.transactions.count_documents({
                "company_id": cid, "date": d,
            })
        cross_volume.append(row)
    top_labels = [{"id": cid, "name": name_by_id.get(cid, "?")} for cid in top_ids]

    # Runway top 4 (mocked flag on — heuristic only)
    runway = []
    for c in client_health[:4]:
        cid = c["id"]
        outflows = await db.transactions.aggregate([
            {"$match": {"company_id": cid, "amount": {"$lt": 0},
                        "date": {"$gte": _since_date(90)}}},
            {"$group": {"_id": None, "s": {"$sum": "$amount"}}}
        ]).to_list(1)
        avg_monthly_burn = abs(outflows[0]["s"] / 3.0) if outflows else 0
        months = round(c["cash_current"] / avg_monthly_burn, 1) if avg_monthly_burn > 0 else None
        runway.append({
            "id": cid,
            "name": c["name"],
            "cash": c["cash_current"],
            "burn": round(avg_monthly_burn),
            "months": months,
        })

    books = {
        "clients": client_health,
        "cross_volume": cross_volume,
        "cross_labels": top_labels,
        "runway": runway,
        "runway_mocked": True,
    }

    # ---- 4. JUDGMENT NEEDED ---------------------------------------
    # Load every "closed" signoff so we can identify prior months that
    # remain unsigned. `db.month_close_signoffs` (kind='closed') is the
    # authoritative "this month has been signed off" marker.
    # Also track `auto_locked` so the UI can distinguish auto-closed
    # (green outlined) from manually-closed (solid green) periods.
    closed_by_company: dict[str, set] = {}
    auto_locked_by_company: dict[str, set] = {}
    async for so in db.month_close_signoffs.find({
        "company_id": {"$in": accessible},
        "kind": "closed",
    }):
        try:
            ym = f"{int(so['year']):04d}-{int(so['month']):02d}"
        except Exception:  # noqa: BLE001
            continue
        cid = so.get("company_id")
        closed_by_company.setdefault(cid, set()).add(ym)
        if so.get("auto_locked"):
            auto_locked_by_company.setdefault(cid, set()).add(ym)

    # Build the last-12-month window as (year, month) pairs, oldest first.
    LOOKBACK_MONTHS = 12
    window_pairs: list[tuple[int, int]] = []
    y, m = now.year, now.month
    for _ in range(LOOKBACK_MONTHS):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        window_pairs.append((y, m))
    window_pairs.reverse()  # oldest → newest
    oldest_start = f"{window_pairs[0][0]:04d}-{window_pairs[0][1]:02d}-01"

    # One aggregation over all accessible companies, grouped by
    # (company_id, YYYY-MM) → txn count. Avoids 12×N synchronous queries.
    txn_counts: dict[tuple[str, str], int] = {}
    async for row in db.transactions.aggregate([
        {"$match": {
            "company_id": {"$in": accessible},
            "date": {"$gte": oldest_start},
        }},
        {"$group": {
            "_id": {
                "cid": "$company_id",
                "ym": {"$substr": ["$date", 0, 7]},
            },
            "n": {"$sum": 1},
        }},
    ]):
        key = (row["_id"]["cid"], row["_id"]["ym"])
        txn_counts[key] = row["n"]

    # 🚨 Per-client 12-month close-grid. Each cell is "closed" (green),
    # "unclosed" (red — has txns but no signoff), or "no_activity" (gray).
    # Before building the pills, trigger auto-lock evaluation for every
    # (company × month) with activity that isn't already closed — this
    # lazily stamps the auto-lock the moment the Cockpit loads, so the
    # pro doesn't have to visit the Month-Close page to materialise it.
    for c in companies:
        cid = c["id"]
        closed_set = closed_by_company.get(cid, set())
        for (yy, mm) in window_pairs:
            ym = f"{yy:04d}-{mm:02d}"
            if ym in closed_set:
                continue
            if txn_counts.get((cid, ym), 0) == 0:
                continue
            try:
                stamped = await _maybe_auto_lock(cid, yy, mm)
                if stamped:
                    closed_set.add(ym)
                    closed_by_company.setdefault(cid, set()).add(ym)
                    auto_locked_by_company.setdefault(cid, set()).add(ym)
            except Exception:  # noqa: BLE001
                pass

    close_grid = []
    prior_unclosed = []
    for c in companies:
        cid = c["id"]
        closed_set = closed_by_company.get(cid, set())
        auto_set = auto_locked_by_company.get(cid, set())
        months = []
        unclosed_count = 0
        for (yy, mm) in window_pairs:
            ym = f"{yy:04d}-{mm:02d}"
            n = txn_counts.get((cid, ym), 0)
            if ym in closed_set:
                state = "closed"
            elif n == 0:
                state = "no_activity"
            else:
                state = "unclosed"
                unclosed_count += 1
                months_overdue = (now.year - yy) * 12 + (now.month - mm)
                prior_unclosed.append({
                    "id": f"unclosed-{cid}-{ym}",
                    "company_id": cid,
                    "company_name": name_by_id.get(cid, "Client"),
                    "period": ym,
                    "period_label": datetime(yy, mm, 1).strftime("%b %Y"),
                    "month": datetime(yy, mm, 1).strftime("%B %Y"),
                    "text": f"{name_by_id.get(cid, 'Client')} · "
                            f"{datetime(yy, mm, 1).strftime('%B %Y')} books not closed",
                    "reason": "prior_month_unclosed",
                    "months_overdue": months_overdue,
                    "txn_count": n,
                    "route": f"/accounting/month-close?ym={ym}&company={cid}",
                    "signoff_route": f"/api/companies/{cid}/month-close/{ym}/checkpoint",
                })
            months.append({
                "period": ym,
                "label": datetime(yy, mm, 1).strftime("%b"),
                "year": yy,
                "state": state,
                "auto_locked": ym in auto_set,
                "txn_count": n,
                "months_ago": (now.year - yy) * 12 + (now.month - mm),
            })
        if unclosed_count == 0:
            continue
        oldest_unclosed = next(
            (mo["period"] for mo in months if mo["state"] == "unclosed"), None,
        )
        oldest_overdue = 0
        if oldest_unclosed:
            uy, um = int(oldest_unclosed[:4]), int(oldest_unclosed[5:])
            oldest_overdue = (now.year - uy) * 12 + (now.month - um)
        close_grid.append({
            "id": f"grid-{cid}",
            "company_id": cid,
            "company_name": c.get("name") or "Untitled",
            "months": months,
            "unclosed_count": unclosed_count,
            "oldest_unclosed_period": oldest_unclosed,
            "oldest_unclosed_months_ago": oldest_overdue,
        })
    # Sort by most-overdue oldest_unclosed first.
    close_grid.sort(
        key=lambda g: (g.get("oldest_unclosed_period") or "9999"),
    )
    # Keep prior_unclosed sorted oldest-first for the legacy flat consumer.
    prior_unclosed.sort(key=lambda x: x["period"])

    # 🚨 Blocking — vendor escalations
    blocking = []
    async for f in db.agent_findings.find({
        "company_id": {"$in": accessible},
        "kind": "vendor_outreach_escalated",
        "status": {"$ne": "resolved"},
    }).limit(5):
        blocking.append({
            "id": f.get("id"),
            "company_id": f.get("company_id"),
            "company": name_by_id.get(f.get("company_id"), ""),
            "text": f"{name_by_id.get(f.get('company_id'), 'Client')} · "
                    f"vendor outreach escalated · {f.get('title') or 'W-9 chase stuck'}",
            "route": f"/company/{f.get('company_id')}/contacts",
        })

    # 👀 Judgment needed — force-flagged categorizer reasons + unusual findings
    judgment_needed = []
    async for t in db.transactions.find({
        "company_id": {"$in": accessible},
        "needs_review": True,
        "review_reason": {"$in": [
            "meals_over_cap", "bank_cash_self_cancel", "generic_pfc",
            "self_cancelling_je", "unusual_amount"]},
    }).sort("date", -1).limit(8):
        judgment_needed.append({
            "id": t.get("id"),
            "company_id": t.get("company_id"),
            "company": name_by_id.get(t.get("company_id"), ""),
            "text": f"{name_by_id.get(t.get('company_id'), 'Client')} · "
                    f"{(t.get('description') or 'txn')[:56]} · ${abs(float(t.get('amount') or 0)):,.0f}",
            "reason": (t.get("review_reason") or "").replace("_", " "),
            "route": f"/company/{t.get('company_id')}/transactions?tid={t.get('id')}",
        })
    async for f in db.agent_findings.find({
        "company_id": {"$in": accessible},
        "kind": {"$in": ["unusual_amount", "self_cancelling_je", "client_deferred"]},
        "status": {"$ne": "resolved"},
    }).sort("created_at", -1).limit(5):
        judgment_needed.append({
            "id": f.get("id"),
            "company_id": f.get("company_id"),
            "company": name_by_id.get(f.get("company_id"), ""),
            "text": f"{name_by_id.get(f.get('company_id'), 'Client')} · {f.get('title') or f.get('kind')}",
            "reason": (f.get("kind") or "").replace("_", " "),
            "route": f"/company/{f.get('company_id')}/dashboard",
        })

    # 📋 Optional sign-off — mined rules, near-ready closes, aging outreach
    optional = []
    unreviewed_rules = await db.rules.count_documents({
        "company_id": {"$in": accessible},
        "source": "miner",
        "created_at": {"$gte": since_dt_iso},
        "reviewed_by_pro": {"$in": [None, False]},
    })
    if unreviewed_rules > 0:
        optional.append({
            "id": "mined-rules",
            "text": f"{unreviewed_rules} new auto-promoted rules this week — "
                    f"quick review before they compound",
            "route": "/settings/rules",
        })
    near_ready_closes = 0
    for c in client_health:
        if c["recon_pct"] >= 95 and c["open_items"] > 0:
            near_ready_closes += 1
    if near_ready_closes > 0:
        optional.append({
            "id": "near-ready-closes",
            "text": f"{near_ready_closes} client{'' if near_ready_closes == 1 else 's'} "
                    f"have reconciliation ≥95% — nudge them or sign off",
            "route": "/cockpit/close",
        })
    aging_outreach = await db.vendor_outreaches.count_documents({
        "company_id": {"$in": accessible},
        "status": {"$in": ["waiting_reply", "reminded"]},
        "last_touch_at": {"$lt": _since_iso(14)},
    })
    if aging_outreach > 0:
        optional.append({
            "id": "aging-outreach",
            "text": f"{aging_outreach} vendor-outreach thread"
                    f"{'' if aging_outreach == 1 else 's'} waiting >14 days — escalate or drop",
            "route": "/cockpit/communications",
        })

    # 🤝 Client relationship — ghosted batches
    ghosted = {}
    async for b in db.client_review_batches.find({
        "company_id": {"$in": accessible},
        "status": "expired",
        "expired_at": {"$gte": _since_iso(14)},
    }):
        cid = b.get("company_id")
        ghosted[cid] = ghosted.get(cid, 0) + 1
    relationship = []
    for cid, cnt in ghosted.items():
        if cnt >= 2 and f"ghost-{cid}" not in contacted_ids:
            relationship.append({
                "id": f"ghost-{cid}",
                "company_id": cid,
                "text": f"{name_by_id.get(cid, 'Client')} has ghosted "
                        f"{cnt} check-ins in a row — a warm ping may help",
                "route": f"/company/{cid}/dashboard",
            })

    # Drop any "optional" entries the user has already marked contacted
    # today (currently only the aging-outreach one flows into the
    # assistant panel, but future optional items may too).
    optional = [o for o in optional if o.get("id") not in contacted_ids]

    judgment = {
        "prior_unclosed": prior_unclosed,
        "close_grid": close_grid,
        "blocking": blocking,
        "needed": judgment_needed,
        "optional": optional,
        "relationship": relationship,
    }

    return {
        "days": days,
        "header": {
            "hours_saved": hours_saved,
            "tasks_handled": tasks_handled,
            "tasks_escalated": len(prior_unclosed) + len(blocking) + len(judgment_needed),
        },
        "activity": activity,
        "conversations": conversations,
        "books": books,
        "judgment": judgment,
    }


def _item_type_mix(items) -> list:
    """Compact type-tally for a batch — {'uncategorized': 3, 'w9': 1}."""
    tally = {}
    for it in items or []:
        k = (it.get("kind") or "other").split("_")[0]
        tally[k] = tally.get(k, 0) + 1
    return [{"kind": k, "count": v} for k, v in tally.items()]


@router.post("/assistant/mark-contacted")
async def mark_contacted(
    payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Record that the CPA reached out to a client outside the AI's
    channel, so today's "Human Assistant Can Help" item drops off
    tomorrow's list. Also drops a note against the client so the
    outreach shows up in their timeline.
    """
    accessible = await require_firm_or_pro(user)
    item_id = (payload.get("item_id") or "").strip()
    company_id = (payload.get("company_id") or "").strip() or None
    headline = (payload.get("headline") or "").strip()
    note_body = (payload.get("note") or "").strip()
    if not item_id:
        raise HTTPException(400, "item_id is required")

    # Resolve the target company. Some assistant items (e.g.
    # aging-outreach) aren't scoped to a single company — for those we
    # just log the contact filter without a note.
    if company_id and company_id not in accessible:
        raise HTTPException(403, "Not authorized for that company")

    now_iso = datetime.now(timezone.utc).isoformat()

    log_doc = {
        "id": str(uuid.uuid4()),
        "item_id": item_id,
        "company_id": company_id,
        "headline": headline,
        "marked_by_user_id": user["id"],
        "marked_by_name": user.get("name") or user.get("email") or "user",
        "note": note_body,
        "contacted_at": now_iso,
    }
    await db.assistant_contact_log.insert_one(log_doc)

    note_id = None
    if company_id:
        note_id = str(uuid.uuid4())
        who = user.get("name") or user.get("email") or "the accountant"
        body_parts = [
            f"Marked contacted from Today's Assistant panel by {who}."
        ]
        if headline:
            body_parts.append(f"Reason surfaced: {headline}")
        if note_body:
            body_parts.append(f"Note: {note_body}")
        await db.notes.insert_one({
            "id": note_id,
            "company_id": company_id,
            "entity_type": "assistant_action",
            "entity_id": item_id,
            "body": "\n".join(body_parts),
            "author_user_id": user["id"],
            "author_name": user.get("name") or user.get("email") or "user",
            "pinned": False,
            "created_at": now_iso,
            "updated_at": now_iso,
        })

    return {"ok": True, "log_id": log_doc["id"], "note_id": note_id}
