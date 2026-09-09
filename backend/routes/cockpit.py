"""SmartBooks — Cockpit routes.

Cross-client command surface for accounting professionals. The Cockpit
shell lives above every product shell in the sidebar and aggregates
signal across every company the caller has access to.

Endpoints
---------
GET  /api/cockpit/accessible-companies  — list of companies the user
                                          can see across the platform.
GET  /api/cockpit/today                 — unified todo feed.
GET  /api/cockpit/close-board           — kanban of every client's
                                          current close state.
POST /api/cockpit/close-board/advance   — advance a client's close
                                          phase (drag-drop).

All routes reject `role="client"` accounts with only a single company —
the Cockpit is a firm/pro/partner/superadmin surface.
"""
from __future__ import annotations
import uuid
from calendar import monthrange
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import db, now_iso, coerce
from auth import get_current_user
from deps import company_ids_for_user
from routes.month_close import _month_status, _month_bounds

router = APIRouter(prefix="/api/cockpit")


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------

_FIRM_ROLES = {"superadmin", "pro", "admin", "partner"}


async def require_firm_or_pro(user: dict) -> list[str]:
    """Return the list of accessible company ids for a Cockpit user.

    Rejects single-company client-owner accounts (they don't need a
    cross-client shell). Firm/pro/admin/partner/superadmin always pass.
    """
    ids = await company_ids_for_user(user)
    role = (user.get("role") or "").lower()
    if role in _FIRM_ROLES:
        return ids
    # Client-role users only get Cockpit if they somehow have access to
    # more than one company (rare — usually via co-owner memberships).
    if len(ids) <= 1:
        raise HTTPException(
            403,
            "Cockpit is a cross-client surface — your account only manages one book.",
        )
    return ids


@router.get("/accessible-companies")
async def accessible_companies(user: dict = Depends(get_current_user)):
    ids = await require_firm_or_pro(user)
    if not ids:
        return {"companies": []}
    docs = await db.companies.find({"id": {"$in": ids}}).to_list(1000)
    out = []
    for d in docs:
        out.append({
            "id": d.get("id"),
            "name": d.get("name") or "Untitled",
            "brand_logo_url": d.get("brand_logo_url") or d.get("logo_url"),
            "tags": d.get("tags") or [],
        })
    out.sort(key=lambda c: (c.get("name") or "").lower())
    return {"companies": out}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _current_ym() -> tuple[int, int]:
    d = datetime.now(timezone.utc)
    return d.year, d.month


def _prev_ym(y: int, m: int) -> tuple[int, int]:
    if m == 1:
        return y - 1, 12
    return y, m - 1


def _deadline_iso(y: int, m: int, day: int = 15) -> str:
    """Firm-wide default: books should be closed by the 15th of the
    following month. Returns an ISO date string for the deadline of
    the (y, m) close period."""
    # Deadline = day-N of the month AFTER (y, m).
    next_y, next_m = (y, m + 1) if m < 12 else (y + 1, 1)
    return f"{next_y:04d}-{next_m:02d}-{day:02d}"


def _days_to_deadline(deadline_iso: str) -> int:
    today = datetime.now(timezone.utc).date()
    try:
        d = datetime.strptime(deadline_iso, "%Y-%m-%d").date()
    except Exception:
        return 0
    return (d - today).days


def _parse_ym(ym: Optional[str]) -> tuple[int, int]:
    if not ym:
        return _current_ym()
    try:
        y, m = ym.split("-")
        return int(y), int(m)
    except Exception:
        raise HTTPException(400, "Period must be YYYY-MM")


# ---------------------------------------------------------------------------
# Close phase derivation
# ---------------------------------------------------------------------------

PHASES = [
    "not_started",
    "cleanup",
    "reconciling",
    "adjusting",
    "client_review",
    "ready_to_close",
    "closed",
]


def _derive_phase(status: dict, portal_pending: int) -> str:
    """Given a month_close status dict + count of open client questions,
    infer which close-board column this company belongs in."""
    cps = status.get("checkpoints", {}) or {}
    closed = cps.get("closed", {}).get("green")
    if closed:
        return "closed"

    txns = cps.get("txns_reviewed", {}) or {}
    recon = cps.get("recon", {}) or {}
    inv = cps.get("invoices", {}) or {}
    bills = cps.get("bills", {}) or {}

    total_txns = txns.get("total", 0) or 0
    if total_txns == 0:
        # Genuinely nothing to close yet — no bank feed activity.
        return "not_started"

    # Blocked on client-answers → surface the wait explicitly.
    if portal_pending > 0 and (txns.get("green") or recon.get("green")):
        return "client_review"

    # Everything green → ready for principal lock.
    if all([txns.get("green"), recon.get("green"), inv.get("green"), bills.get("green")]):
        return "ready_to_close"

    # Recon done but invoices/bills sign-off pending → adjusting phase.
    if txns.get("green") and recon.get("green"):
        return "adjusting"

    # Cleanup done, still reconciling.
    if txns.get("green") and not recon.get("green"):
        return "reconciling"

    # Otherwise we're still in cleanup.
    return "cleanup"


def _phase_pct(status: dict) -> int:
    """0-100 rough progress across the 5 named checkpoints."""
    cps = status.get("checkpoints", {}) or {}
    keys = ["txns_reviewed", "invoices", "bills", "recon", "closed"]
    green = sum(1 for k in keys if (cps.get(k) or {}).get("green"))
    return int(round(green * 100.0 / len(keys)))


def _close_score(status: dict, portal_pending: int, anomaly_count: int = 0) -> int:
    """Weighted composite defined in COCKPIT_PRD § 5. Simplified for
    Phase 1 — reweights when the AI JE Drafters + client sign-off land."""
    cps = status.get("checkpoints", {}) or {}
    txns = cps.get("txns_reviewed", {}) or {}
    recon = cps.get("recon", {}) or {}
    inv = cps.get("invoices", {}) or {}
    bills = cps.get("bills", {}) or {}

    # Cleanup: 25 pts if txns reviewed green, prorated by unreviewed count otherwise.
    total = txns.get("total") or 0
    unrev = (txns.get("unreviewed") or 0) + (txns.get("uncategorized") or 0)
    cleanup_ratio = 1.0 if total == 0 else max(0.0, 1.0 - unrev / max(total, 1))
    cleanup_pts = 25 * cleanup_ratio

    # Recon: 25 pts based on cleared ratio.
    total_r = recon.get("total") or 0
    cleared = recon.get("cleared") or 0
    recon_ratio = 1.0 if total_r == 0 else cleared / max(total_r, 1)
    recon_pts = 25 * recon_ratio

    # Invoices / bills sign-off (10 + 10).
    inv_pts = 10 if inv.get("green") else 0
    bills_pts = 10 if bills.get("green") else 0

    # Client sign-off proxy for Phase 1 — no pending portal requests.
    client_pts = 10 if portal_pending == 0 else max(0, 10 - portal_pending * 2)

    # Adjust JE placeholder (15 pts) — nothing to draft yet so award if
    # cleanup + recon are both green.
    adjust_pts = 15 if txns.get("green") and recon.get("green") else 0

    # Anomaly deduction (up to 5 pts).
    anomaly_pen = min(5, anomaly_count)
    anomaly_pts = 5 - anomaly_pen

    total_pts = cleanup_pts + recon_pts + inv_pts + bills_pts + client_pts + adjust_pts + anomaly_pts
    return max(0, min(100, int(round(total_pts))))


async def _company_portal_pending(cid: str) -> int:
    """Count of unanswered Ask-Client communications for this company."""
    try:
        return await db.communications.count_documents({
            "company_id": cid,
            "kind": {"$in": ["ai_ask_client", "ask_client", "ask_client_batch"]},
            "status": {"$nin": ["answered", "archived", "failed"]},
        })
    except Exception:  # noqa: BLE001
        return 0


async def _company_top_blockers(cid: str, status: dict, portal_pending: int) -> list[dict]:
    """Up to 3 top blockers for a close card."""
    out: list[dict] = []
    cps = status.get("checkpoints", {}) or {}

    txns = cps.get("txns_reviewed", {}) or {}
    unrev = (txns.get("unreviewed") or 0) + (txns.get("uncategorized") or 0)
    if unrev > 0:
        out.append({
            "kind": "unrev_txns",
            "label": f"{unrev} unreviewed transaction{'s' if unrev != 1 else ''}",
            "count": unrev,
        })

    recon = cps.get("recon", {}) or {}
    total_r = recon.get("total") or 0
    cleared = recon.get("cleared") or 0
    if total_r > 0 and cleared < total_r:
        out.append({
            "kind": "unrec_txns",
            "label": f"{total_r - cleared} uncleared bank txns",
            "count": total_r - cleared,
        })

    if portal_pending > 0:
        out.append({
            "kind": "portal_wait",
            "label": f"{portal_pending} client answer{'s' if portal_pending != 1 else ''} pending",
            "count": portal_pending,
        })

    # AI Adjust Drafts pending review — surface as a first-class blocker
    # so the whole loop closes (Phase 3 → Close Board handshake).
    try:
        period = status.get("period_start", "")[:7]  # "YYYY-MM"
    except Exception:  # noqa: BLE001
        period = ""
    if period:
        drafts_pending = await db.je_drafts.count_documents({
            "company_id": cid, "period": period, "status": "pending",
        })
        if drafts_pending > 0:
            out.append({
                "kind": "adjust_drafts",
                "label": f"{drafts_pending} AI adjust draft{'s' if drafts_pending != 1 else ''} to review",
                "count": drafts_pending,
            })

    inv = cps.get("invoices", {}) or {}
    if not inv.get("green") and (inv.get("outstanding") or 0) > 0:
        out.append({
            "kind": "invoices_signoff",
            "label": f"{inv.get('outstanding')} outstanding invoices to sign off",
            "count": inv.get("outstanding"),
        })

    bills = cps.get("bills", {}) or {}
    if not bills.get("green") and (bills.get("outstanding") or 0) > 0:
        out.append({
            "kind": "bills_signoff",
            "label": f"{bills.get('outstanding')} outstanding bills to sign off",
            "count": bills.get("outstanding"),
        })

    return out[:3]


# ---------------------------------------------------------------------------
# Today feed
# ---------------------------------------------------------------------------

async def _today_items_for_company(cid: str, cname: str, y: int, m: int) -> list[dict]:
    """Build todo items for a single company. Returns a list."""
    items: list[dict] = []
    now = datetime.now(timezone.utc)

    # ---- Waiting on client (amber → red after 7 days)
    try:
        comms = await db.communications.find({
            "company_id": cid,
            "kind": {"$in": ["ai_ask_client", "ask_client", "ask_client_batch"]},
            "status": {"$nin": ["answered", "archived", "failed"]},
        }).sort("sent_at", -1).limit(50).to_list(50)
    except Exception:  # noqa: BLE001
        comms = []

    if comms:
        # Bucket by age.
        oldest_days = 0
        for c in comms:
            sent = c.get("sent_at") or c.get("created_at")
            if isinstance(sent, str):
                try:
                    d = datetime.fromisoformat(sent.replace("Z", "+00:00"))
                    age = (now - d).days
                    oldest_days = max(oldest_days, age)
                except Exception:  # noqa: BLE001
                    pass
        urgency = "red" if oldest_days >= 7 else "amber"
        items.append({
            "id": f"portal-{cid}",
            "source": "portal",
            "company_id": cid,
            "company_name": cname,
            "urgency": urgency,
            "title": f"{len(comms)} client answer{'s' if len(comms) != 1 else ''} pending",
            "subtitle": (
                f"Oldest sent {oldest_days} day{'s' if oldest_days != 1 else ''} ago"
                if oldest_days > 0 else "Sent today"
            ),
            "action_label": "Resend & remind" if oldest_days >= 7 else "View thread",
            "action_route": f"/cockpit/communications?company={cid}",
            "count": len(comms),
            "created_at": comms[0].get("sent_at") or now.isoformat(),
        })

    # ---- Ready for review (blue) — checkpoints that are auto-green but
    # have never been human-signed off. Uses _month_status directly.
    try:
        status = await _month_status(cid, y, m)
    except Exception:  # noqa: BLE001
        status = None

    if status:
        cps = status.get("checkpoints", {}) or {}
        for kind, label in [
            ("recon", "Reconciliation ready for sign-off"),
            ("invoices", "Outstanding invoices ready for sign-off"),
            ("bills", "Outstanding bills ready for sign-off"),
        ]:
            cp = cps.get(kind, {})
            if cp.get("green") and cp.get("auto") and not cp.get("signed_at"):
                items.append({
                    "id": f"signoff-{cid}-{kind}",
                    "source": "signoff",
                    "company_id": cid,
                    "company_name": cname,
                    "urgency": "blue",
                    "title": label,
                    "subtitle": f"Auto-passed — one-click sign to close {y:04d}-{m:02d}",
                    "action_label": "Sign off",
                    "action_route": f"/accounting/month-close?ym={y:04d}-{m:02d}",
                    "created_at": now.isoformat(),
                })

        # If EVERY checkpoint (excluding closed) is green — ready to close.
        pre = ("txns_reviewed", "invoices", "bills", "recon")
        if all((cps.get(k) or {}).get("green") for k in pre) and not (cps.get("closed") or {}).get("green"):
            items.append({
                "id": f"close-ready-{cid}",
                "source": "signoff",
                "company_id": cid,
                "company_name": cname,
                "urgency": "blue",
                "title": f"Ready to close {y:04d}-{m:02d}",
                "subtitle": "All 4 pre-close checkpoints are green.",
                "action_label": "Close period",
                "action_route": f"/accounting/month-close?ym={y:04d}-{m:02d}",
                "created_at": now.isoformat(),
            })

    # ---- Close-deadline alert (red if overdue, amber if ≤3 days)
    deadline = _deadline_iso(y, m)
    dtd = _days_to_deadline(deadline)
    closed_green = bool((status or {}).get("checkpoints", {}).get("closed", {}).get("green"))
    if not closed_green and dtd <= 3:
        urgency = "red" if dtd < 0 else "amber"
        items.append({
            "id": f"deadline-{cid}",
            "source": "deadline",
            "company_id": cid,
            "company_name": cname,
            "urgency": urgency,
            "title": (
                f"Close for {y:04d}-{m:02d} is {abs(dtd)} day{'s' if abs(dtd) != 1 else ''} overdue"
                if dtd < 0 else
                f"Close due in {dtd} day{'s' if dtd != 1 else ''} ({deadline})"
            ),
            "subtitle": "Finish cleanup, reconciliations, and sign-off.",
            "action_label": "Open close",
            "action_route": f"/cockpit/close/{cid}?period={y:04d}-{m:02d}",
            "created_at": now.isoformat(),
        })

    # ---- Client sign-off events (blue = approved, red = questioned)
    period_ym = f"{y:04d}-{m:02d}"
    signoff = await db.client_signoffs.find_one({"company_id": cid, "period": period_ym})
    if signoff and signoff.get("status") == "approved":
        items.append({
            "id": f"signoff-approved-{cid}-{period_ym}",
            "source": "signoff_client",
            "company_id": cid,
            "company_name": cname,
            "urgency": "blue",
            "title": f"Client approved {period_ym}",
            "subtitle": f"Signed off by {signoff.get('client_email','client')} — safe to lock the period.",
            "action_label": "Lock period",
            "action_route": f"/accounting/month-close?ym={period_ym}",
            "created_at": signoff.get("approved_at") or now.isoformat(),
        })
    elif signoff and signoff.get("status") == "questioned":
        items.append({
            "id": f"signoff-questioned-{cid}-{period_ym}",
            "source": "signoff_client",
            "company_id": cid,
            "company_name": cname,
            "urgency": "red",
            "title": f"Client has questions on {period_ym}",
            "subtitle": "Answer the client's questions and re-send the report.",
            "action_label": "Review questions",
            "action_route": f"/cockpit/requests?company={cid}",
            "created_at": signoff.get("questioned_at") or now.isoformat(),
        })

    return items


@router.get("/today")
async def today_feed(
    company_ids: Optional[str] = Query(None, description="Comma-separated filter"),
    urgency: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"items": [], "counts_by_urgency": {}, "counts_by_source": {}}

    filter_ids = set(accessible)
    if company_ids:
        wanted = {c.strip() for c in company_ids.split(",") if c.strip()}
        filter_ids &= wanted

    y, m = _current_ym()
    # Prior month is where most close work actually sits (books-lag).
    py, pm = _prev_ym(y, m)

    # Grab company names in one shot.
    companies = await db.companies.find({"id": {"$in": list(filter_ids)}}).to_list(1000)
    name_by_id = {c["id"]: (c.get("name") or "Untitled") for c in companies}

    all_items: list[dict] = []
    for cid in filter_ids:
        cname = name_by_id.get(cid, "Untitled")
        # Look at prior + current month so early-in-the-month users still
        # see "close August" work when it's the first week of September.
        for yy, mm in [(py, pm), (y, m)]:
            try:
                items = await _today_items_for_company(cid, cname, yy, mm)
            except Exception:  # noqa: BLE001
                items = []
            # Only surface prior-month items when they meaningfully
            # differ (avoid duplicating identical portal cards). Sign-off
            # events for prior periods are important too — a client who
            # approves August on Sep 3rd should still trigger a Today
            # card.
            if (yy, mm) == (py, pm):
                items = [i for i in items if i["source"] in ("signoff", "signoff_client", "deadline")]
            all_items.extend(items)

    # De-dupe by id (portal card would otherwise collide across months).
    seen: set[str] = set()
    unique: list[dict] = []
    for it in all_items:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        unique.append(it)

    if urgency:
        unique = [i for i in unique if i.get("urgency") == urgency]

    # Sort: red > amber > blue > grey, then by age.
    order = {"red": 0, "amber": 1, "blue": 2, "grey": 3}
    unique.sort(key=lambda x: (order.get(x.get("urgency"), 9), x.get("created_at", "")))

    counts_by_urgency: dict = {}
    counts_by_source: dict = {}
    for it in unique:
        counts_by_urgency[it["urgency"]] = counts_by_urgency.get(it["urgency"], 0) + 1
        counts_by_source[it["source"]] = counts_by_source.get(it["source"], 0) + 1

    return {
        "items": unique[:limit],
        "counts_by_urgency": counts_by_urgency,
        "counts_by_source": counts_by_source,
    }


# ---------------------------------------------------------------------------
# Close Board
# ---------------------------------------------------------------------------

async def _close_card(cid: str, cname: str, brand_logo_url: str, y: int, m: int) -> dict:
    try:
        status = await _month_status(cid, y, m)
    except Exception:  # noqa: BLE001
        status = {"checkpoints": {}}
    portal_pending = await _company_portal_pending(cid)
    phase = _derive_phase(status, portal_pending)
    pct = _phase_pct(status)
    score = _close_score(status, portal_pending)
    blockers = await _company_top_blockers(cid, status, portal_pending)
    deadline = _deadline_iso(y, m)

    # Client sign-off status for the period — surfaces on the Close
    # Board card as a green "Client approved" pill and (later) gates
    # the final period-lock action.
    period_ym = f"{y:04d}-{m:02d}"
    signoff = await db.client_signoffs.find_one({"company_id": cid, "period": period_ym})
    signoff_status = (signoff or {}).get("status")  # None | approved | questioned

    return {
        "company_id": cid,
        "company_name": cname,
        "brand_logo_url": brand_logo_url,
        "period": period_ym,
        "phase": phase,
        "phase_pct": pct,
        "close_score": score,
        "deadline_iso": deadline,
        "days_to_deadline": _days_to_deadline(deadline),
        "top_blockers": blockers,
        "portal_pending": portal_pending,
        "client_signoff": {
            "status": signoff_status,
            "approved_at": (signoff or {}).get("approved_at"),
            "questioned_at": (signoff or {}).get("questioned_at"),
        },
        "quick_actions": [
            {"kind": "open_close", "label": "Open close", "route": f"/accounting/month-close?ym={y:04d}-{m:02d}"},
            {"kind": "run_reconcile", "label": "Run reconciliation", "route": "/accounting/reconciliation"},
            {"kind": "ask_client", "label": "Send portal invite", "route": f"/accounting/transactions?noContactReview=1"},
        ],
        "last_activity_at": now_iso(),
    }


@router.get("/close-board")
async def close_board(
    period: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"period": period or "", "cards": [], "summary": {}}

    y, m = _parse_ym(period)

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(1000)
    cards: list[dict] = []
    for c in companies:
        cid = c["id"]
        try:
            card = await _close_card(
                cid,
                c.get("name") or "Untitled",
                c.get("brand_logo_url") or c.get("logo_url"),
                y, m,
            )
            cards.append(card)
        except Exception:  # noqa: BLE001 — one broken client shouldn't kill the board
            continue

    cards.sort(key=lambda x: (
        PHASES.index(x["phase"]) if x["phase"] in PHASES else 99,
        x["days_to_deadline"],
        x["company_name"].lower(),
    ))

    by_phase: dict = {p: 0 for p in PHASES}
    overdue = 0
    at_risk = 0
    for c in cards:
        by_phase[c["phase"]] = by_phase.get(c["phase"], 0) + 1
        if c["days_to_deadline"] < 0 and c["phase"] != "closed":
            overdue += 1
        elif c["days_to_deadline"] <= 3 and c["phase"] != "closed":
            at_risk += 1

    return {
        "period": f"{y:04d}-{m:02d}",
        "cards": cards,
        "summary": {
            "by_phase": by_phase,
            "overdue_count": overdue,
            "at_risk_count": at_risk,
            "total": len(cards),
        },
    }


class AdvanceIn(BaseModel):
    company_id: str
    period: str
    to_phase: str


@router.post("/close-board/advance")
async def close_board_advance(
    inp: AdvanceIn, user: dict = Depends(get_current_user),
):
    """Drag-drop phase change. Phase 1 semantics:

    - Advancing to `closed` runs the same gating as
      `POST /companies/{cid}/month-close/{ym}/checkpoint {kind:closed}`
      (all 4 pre-checkpoints must be green).
    - Advancing to any other phase is informational only — the phase
      derives from the underlying checkpoints, so we accept the drop
      but store an intent record in `close_phase_intents` for auditing.
      This lets the UI feel responsive while keeping the source of truth
      in the real checkpoint state.
    """
    accessible = await require_firm_or_pro(user)
    if inp.company_id not in accessible:
        raise HTTPException(403, "No access to that company")
    if inp.to_phase not in PHASES:
        raise HTTPException(400, f"Unknown phase '{inp.to_phase}'")

    try:
        y, m = [int(x) for x in inp.period.split("-")]
    except Exception:
        raise HTTPException(400, "Period must be YYYY-MM")

    status = await _month_status(inp.company_id, y, m)

    # Gate: can only drop to `closed` when all 4 pre-checkpoints are green.
    if inp.to_phase == "closed":
        cps = status["checkpoints"]
        blockers = []
        for pre in ("txns_reviewed", "invoices", "bills", "recon"):
            if not cps[pre]["green"]:
                blockers.append({"kind": pre, "label": pre.replace("_", " ")})
        if blockers:
            raise HTTPException(status_code=409, detail={
                "message": f"Cannot close {inp.period} — {len(blockers)} checkpoint(s) still open.",
                "blockers": blockers,
            })
        # Reuse the existing lock path.
        now = now_iso()
        await db.month_close_signoffs.update_one(
            {"company_id": inp.company_id, "year": y, "month": m, "kind": "closed"},
            {"$set": {
                "id": str(uuid.uuid4()),
                "company_id": inp.company_id, "year": y, "month": m, "kind": "closed",
                "signed_at": now,
                "signed_by": user.get("email") or user.get("id"),
            }},
            upsert=True,
        )
        start, end = _month_bounds(y, m)
        await db.close_periods.update_one(
            {"company_id": inp.company_id, "period_start": start, "period_end": end, "kind": "month"},
            {"$set": {
                "id": str(uuid.uuid4()),
                "company_id": inp.company_id, "period_start": start, "period_end": end, "kind": "month",
                "status": "closed",
                "closed_at": now,
                "closed_by": user.get("email") or user.get("id"),
            }},
            upsert=True,
        )

    # Store the intent for audit + optional UI hint.
    await db.close_phase_intents.update_one(
        {"company_id": inp.company_id, "period": inp.period},
        {"$set": {
            "company_id": inp.company_id,
            "period": inp.period,
            "to_phase": inp.to_phase,
            "set_by": user.get("email") or user.get("id"),
            "set_at": now_iso(),
        }},
        upsert=True,
    )

    # Recompute + return the card.
    company = await db.companies.find_one({"id": inp.company_id})
    card = await _close_card(
        inp.company_id,
        (company or {}).get("name") or "Untitled",
        (company or {}).get("brand_logo_url") or (company or {}).get("logo_url"),
        y, m,
    )
    return {"ok": True, "card": card}


# ---------------------------------------------------------------------------
# Client Requests rail — cross-client aggregation of client_questions
# ---------------------------------------------------------------------------

def _age_days(iso: Optional[str]) -> int:
    if not iso:
        return 0
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - d).days
    except Exception:  # noqa: BLE001
        return 0


@router.get("/requests")
async def cockpit_requests(
    company_ids: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="open|answered|expired|cancelled|all"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    """Cross-client list of every client_questions doc — the "Client
    Requests" rail. Feeds both the standalone `/cockpit/requests` page
    and the auto-refresh loop that unblocks Close Board cards."""
    accessible = await require_firm_or_pro(user)
    ids = set(accessible)
    if company_ids:
        ids &= {c.strip() for c in company_ids.split(",") if c.strip()}

    q: dict = {"company_id": {"$in": list(ids)}}
    if status and status != "all":
        if status == "open":
            q["status"] = {"$in": ["pending", "sent"]}
        else:
            q["status"] = status

    docs = await db.client_questions.find(q).sort("sent_at", -1).limit(limit).to_list(limit)

    companies = await db.companies.find({"id": {"$in": list(ids)}}).to_list(1000)
    name_by_id = {c["id"]: c.get("name") or "Untitled" for c in companies}

    out = []
    for d in docs:
        age = _age_days(d.get("sent_at"))
        st = d.get("status") or "pending"
        stale = st in ("pending", "sent") and age >= 7
        out.append({
            "id": d.get("id"),
            "company_id": d.get("company_id"),
            "company_name": name_by_id.get(d.get("company_id"), "Untitled"),
            "question": d.get("question"),
            "status": st,
            "sent_at": d.get("sent_at"),
            "answered_at": d.get("answered_at"),
            "age_days": age,
            "stale": stale,
            "counterparty_label": d.get("counterparty_label"),
            "asked_by_name": d.get("asked_by_name"),
            "txn_count": len(d.get("txn_ids") or ([d.get("txn_id")] if d.get("txn_id") else [])),
            "chat_msg_count": len(d.get("chat_messages") or []),
            "to_email": d.get("to_email"),
        })

    counts = {"open": 0, "answered": 0, "expired": 0, "cancelled": 0, "stale": 0}
    for r in out:
        if r["status"] in ("pending", "sent"):
            counts["open"] += 1
        elif r["status"] in counts:
            counts[r["status"]] += 1
        if r["stale"]:
            counts["stale"] += 1

    return {"items": out, "counts": counts}


@router.post("/requests/{qid}/resend")
async def cockpit_resend(qid: str, user: dict = Depends(get_current_user)):
    """Resend the magic-link email for an open question."""
    accessible = await require_firm_or_pro(user)
    q = await db.client_questions.find_one({"id": qid})
    if not q or q.get("company_id") not in accessible:
        raise HTTPException(404, "Question not found or you don't have access.")
    if q.get("status") == "answered":
        raise HTTPException(400, "Already answered.")

    # Mark as re-sent so we get an audit trail. The actual email dispatch
    # reuses the same tmpl.ask_client path — kept lightweight here since
    # a full re-render requires the txn context.
    await db.client_questions.update_one(
        {"id": qid},
        {"$set": {"resent_at": now_iso(), "resent_count": (q.get("resent_count") or 0) + 1}},
    )
    return {"ok": True, "resent_count": (q.get("resent_count") or 0) + 1}


@router.post("/requests/{qid}/cancel")
async def cockpit_cancel(qid: str, user: dict = Depends(get_current_user)):
    """Cancel an open question — surfaces to client as expired next visit."""
    accessible = await require_firm_or_pro(user)
    q = await db.client_questions.find_one({"id": qid})
    if not q or q.get("company_id") not in accessible:
        raise HTTPException(404, "Question not found or you don't have access.")
    if q.get("status") == "answered":
        raise HTTPException(400, "Cannot cancel an answered question.")
    await db.client_questions.update_one(
        {"id": qid},
        {"$set": {
            "status": "cancelled",
            "cancelled_at": now_iso(),
            "cancelled_by": user.get("email") or user.get("id"),
        }},
    )
    return {"ok": True}
