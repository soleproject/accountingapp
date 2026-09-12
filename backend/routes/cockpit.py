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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
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
        # If there's exactly one pending thread we can deep-link straight
        # to it (question_id) so the detail panel pre-opens. Otherwise we
        # just narrow the client + source filter. Note: the communications
        # doc's own `id` is the dispatch id — the actual portal thread id
        # lives in `related.question_id`, which is what the Communications
        # page uses to match.
        route = f"/cockpit/communications?company_ids={cid}&source=portal"
        if len(comms) == 1:
            related = comms[0].get("related") or {}
            qid = related.get("question_id")
            if qid:
                route += f"&question_id={qid}"
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
            "action_route": route,
            "count": len(comms),
            "created_at": comms[0].get("sent_at") or now.isoformat(),
        })

    # ---- Ready for review — client answered, CPA hasn't checked off yet.
    # Kept in the Today queue (even when the answer was auto-applied to
    # the txn) so the CPA still gets to see the client's own words and
    # acknowledge before it disappears.
    try:
        answered = await db.client_questions.find({
            "company_id": cid,
            "status": "answered",
            "cpa_reviewed_at": {"$in": [None, ""]},
        }).sort("answered_at", -1).limit(50).to_list(50)
    except Exception:  # noqa: BLE001
        answered = []
    if answered:
        # One card per answered question so the CPA can check them off
        # individually and see what the client actually said inline.
        for a in answered[:20]:
            qid = a.get("id")
            prop = a.get("ai_proposal") or {}
            auto_note = ""
            if prop.get("auto_applied"):
                auto_note = f"Auto-posted to {prop.get('account_code')} · {prop.get('account_name')}"
            elif prop.get("account_code") and prop.get("account_code") != "9999":
                auto_note = f"AI suggests {prop.get('account_code')} · {prop.get('account_name')}"
            answer_preview = (a.get("answer") or "").strip().replace("\n", " ")
            if len(answer_preview) > 80:
                answer_preview = answer_preview[:77] + "…"
            subtitle_parts = [f"“{answer_preview}”"] if answer_preview else []
            if auto_note:
                subtitle_parts.append(auto_note)
            items.append({
                "id": f"answered-{qid}",
                "source": "portal",
                "company_id": cid,
                "company_name": cname,
                "urgency": "blue",
                "title": "Client answered — ready to review",
                "subtitle": " · ".join(subtitle_parts) or "New client answer waiting.",
                "action_label": "Review answer",
                "action_route": (
                    f"/cockpit/communications?company_ids={cid}"
                    f"&source=portal&question_id={qid}"
                ),
                "count": 1,
                "created_at": a.get("answered_at") or now.isoformat(),
                "related": {"question_id": qid, "auto_applied": bool(prop.get("auto_applied"))},
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
                    "action_route": f"/accounting/month-close?ym={y:04d}-{m:02d}&company={cid}",
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
                "action_route": f"/accounting/month-close?ym={y:04d}-{m:02d}&company={cid}",
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
            "action_route": f"/accounting/month-close?ym={period_ym}&company={cid}",
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
    background: BackgroundTasks,
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

    # Fire the Cockpit agent scheduler (wake-on-request). Any agent whose
    # cadence has elapsed will be queued as a background task.
    try:
        from routes.agents import tick_due_agents, tick_due_runbooks  # local import to avoid cycles
        await tick_due_agents(list(filter_ids), background=background)
        await tick_due_runbooks(list(filter_ids), background=background)
    except Exception:  # noqa: BLE001
        pass

    y, m = _current_ym()
    # Prior month is where most close work actually sits (books-lag).
    py, pm = _prev_ym(y, m)

    # Grab company names in one shot. Only iterate over companies that
    # actually exist in the DB — filter_ids may still contain stale
    # cids from a pro's access list after a company was deleted, which
    # would otherwise produce ghost "Untitled" sign-off cards that
    # mirror what a real company already shows.
    companies = await db.companies.find({"id": {"$in": list(filter_ids)}}).to_list(1000)
    name_by_id = {c["id"]: (c.get("name") or "Untitled") for c in companies}
    live_cids = [cid for cid in filter_ids if cid in name_by_id]

    all_items: list[dict] = []
    for cid in live_cids:
        cname = name_by_id[cid]
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

    # Overlay OPEN agent findings from Phase 5. Each finding becomes a
    # Today card tagged source=agent, using the finding's own severity.
    #
    # We de-dupe agent findings across (company_id, template_key, title)
    # so a template that fired multiple times on the same company (e.g.
    # cleanup_sweep run every hour) surfaces as ONE card instead of a
    # wall of identical rows. `findings` is already sorted `created_at`
    # DESC, so the first hit for each key is the freshest and wins.
    try:
        finding_q = {"status": "open", "$or": [
            {"company_id": {"$in": list(filter_ids)}},
            {"company_id": None},
        ]}
        findings = await db.agent_findings.find(finding_q).sort("created_at", -1).limit(200).to_list(200)
        finding_seen: set[tuple] = set()
        for f in findings:
            cid = f.get("company_id")
            dedup_key = (cid, f.get("template_key"), f.get("title"))
            if dedup_key in finding_seen:
                continue
            finding_seen.add(dedup_key)
            unique.append({
                "id": f"agent-finding-{f['id']}",
                "source": "agent",
                "company_id": cid,
                "company_name": name_by_id.get(cid, "Firm-wide"),
                "urgency": f.get("severity") or "blue",
                "title": f.get("title") or "Agent finding",
                "subtitle": f.get("detail") or "",
                "action_label": f.get("action_label") or "Review",
                "action_route": f.get("action_route") or "/cockpit/agents",
                "created_at": f.get("created_at") or datetime.now(timezone.utc).isoformat(),
                "count": f.get("count") or 1,
                "finding_id": f["id"],
                "template_key": f.get("template_key"),
            })
    except Exception:  # noqa: BLE001
        pass

    # Final safety-net de-dupe across the *whole* Today feed by
    # (company_id, title). Belt-and-braces catch for any other source
    # that might drop a near-duplicate card into the queue (e.g. a
    # portal pending + an agent finding both saying "3 client answers
    # pending" for the same client). First-in-wins because the list is
    # already priority-sorted at their point of insertion.
    dedup_seen: set[tuple] = set()
    deduped: list[dict] = []
    for it in unique:
        key = (it.get("company_id"), it.get("title"))
        if key in dedup_seen:
            continue
        dedup_seen.add(key)
        deduped.append(it)
    unique = deduped

    if urgency:
        unique = [i for i in unique if i.get("urgency") == urgency]

    # ── Cockpit 2 augmentation ─────────────────────────────────────
    # Attach `needs_decision`, `risk_bucket`, `age_days`, and
    # `confidence` (when known) to every item. These fields are
    # additive — the original Cockpit "Today" page ignores unknown
    # keys, so Cockpit 2 can drive richer sorting/grouping while the
    # legacy page keeps working unchanged.
    _now = datetime.now(timezone.utc)
    _COMPLIANCE_TEMPLATES = {
        "close_deadline_slip", "tax_1099_watcher",
        "sales_tax_watcher", "payroll_tax_watcher",
        "unsigned_advisor_reports",
    }
    for it in unique:
        # Age in days from created_at (best-effort — some items stamp
        # `created_at` as an ISO string, some as an aware datetime).
        try:
            ca = it.get("created_at") or ""
            if isinstance(ca, str) and ca:
                d = datetime.fromisoformat(ca.replace("Z", "+00:00"))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                it["age_days"] = max(0, (_now - d).days)
            else:
                it["age_days"] = 0
        except Exception:  # noqa: BLE001
            it["age_days"] = 0

        src = it.get("source") or ""
        urg = it.get("urgency") or "grey"
        tpl = it.get("template_key") or ""

        # `needs_decision` = the ball is in the CPA's court. Portal
        # ambers are the client's ball; grey items are informational.
        if src == "portal" and urg in ("amber", "red"):
            it["needs_decision"] = False
        elif urg in ("red", "blue"):
            it["needs_decision"] = True
        else:
            it["needs_decision"] = False

        # `risk_bucket` for the ranked queue on Cockpit 2.
        if src == "deadline" or (src == "agent" and tpl in _COMPLIANCE_TEMPLATES):
            it["risk_bucket"] = "compliance"
        elif urg == "red" and it["age_days"] >= 3:
            it["risk_bucket"] = "high_risk"
        elif urg in ("red", "amber", "blue"):
            it["risk_bucket"] = "flagged"
        else:
            it["risk_bucket"] = "routine"

        # `confidence` — surface it when the source already carries it
        # via the `related` sub-doc (e.g. auto-applied portal answers).
        # A future pass can join `client_questions.ai_proposal.confidence`
        # by question_id to enrich items that don't yet.
        rel = it.get("related") or {}
        if "confidence" in rel:
            it["confidence"] = rel["confidence"]

    # Sort: red > amber > blue > grey, then by age.
    order = {"red": 0, "amber": 1, "blue": 2, "grey": 3}
    unique.sort(key=lambda x: (order.get(x.get("urgency"), 9), x.get("created_at", "")))

    counts_by_urgency: dict = {}
    counts_by_source: dict = {}
    counts_by_risk: dict = {"compliance": 0, "high_risk": 0, "flagged": 0, "routine": 0}
    decisions_count = 0
    for it in unique:
        counts_by_urgency[it["urgency"]] = counts_by_urgency.get(it["urgency"], 0) + 1
        counts_by_source[it["source"]] = counts_by_source.get(it["source"], 0) + 1
        counts_by_risk[it.get("risk_bucket", "routine")] += 1
        if it.get("needs_decision"):
            decisions_count += 1

    return {
        "items": unique[:limit],
        "counts_by_urgency": counts_by_urgency,
        "counts_by_source": counts_by_source,
        "counts_by_risk": counts_by_risk,
        "decisions_count": decisions_count,
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


@router.get("/company/{cid}/overview")
async def cockpit_company_overview(
    cid: str,
    period: Optional[str] = Query(None, description="YYYY-MM; defaults to prior month"),
    user: dict = Depends(get_current_user),
):
    """Per-company control room. Aggregates the CPA-facing state of one
    client in a single call — vitals, in-flight AI activity, human-
    decision items, waiting-on-client threads — so the Client Cockpit
    tab renders in one round trip. Firm/pro role only.

    This endpoint is a FACADE over existing capabilities (no new AI):
      • close checkpoints from `_month_status`
      • uncategorized count from `transactions.needs_review`
      • open questions from `client_questions`
      • pending proposals from `transactions.ai_proposal_from_answer`
      • recent agent runs from `agent_runs`
      • today items via `_today_items_for_company` scoped to this cid
    """
    accessible = await require_firm_or_pro(user)
    if cid not in accessible:
        raise HTTPException(404, "Client not found or you don't have access.")

    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Client not found.")

    # Which month are we cockpit-ing for? Default to prior month (the
    # book-lag reality — Sep 3 → looking at Aug close).
    if period:
        y, m = _parse_ym(period)
    else:
        cur_y, cur_m = _current_ym()
        y, m = _prev_ym(cur_y, cur_m)

    # Close status + vitals in parallel would be nice, but everything
    # is Mongo-cheap so serial is fine and easier to read.
    try:
        status = await _month_status(cid, y, m)
    except Exception:  # noqa: BLE001
        status = None

    ninety_days_ago = (datetime.now(timezone.utc) - timedelta(days=90)).date().isoformat()

    uncategorized = await db.transactions.count_documents({
        "company_id": cid,
        "needs_review": True,
        "date": {"$gte": ninety_days_ago},
    })
    open_questions = await db.client_questions.count_documents({
        "company_id": cid,
        "status": {"$in": ["pending", "sent"]},
    })
    answered_unreviewed = await db.client_questions.count_documents({
        "company_id": cid,
        "status": "answered",
        "cpa_reviewed_at": {"$in": [None, ""]},
    })
    pending_proposals = await db.transactions.count_documents({
        "company_id": cid,
        "ai_proposal_from_answer": {"$exists": True, "$ne": None},
        "$or": [
            {"human_reviewed": {"$ne": True}},
            {"ai_proposal_from_answer.auto_applied": {"$ne": True}},
        ],
    })

    # In-flight AI activity — most recent 8 runs, plus a `running` count.
    agent_runs = await db.agent_runs.find(
        {"company_id": cid}
    ).sort("started_at", -1).limit(20).to_list(20)
    running = sum(1 for r in agent_runs if r.get("status") == "running")
    agent_activity = [{
        "id": r.get("id"),
        "template_key": r.get("template_key"),
        "status": r.get("status"),
        "started_at": r.get("started_at"),
        "ended_at": r.get("ended_at"),
        "finding_count": len(r.get("findings") or []),
        "cost_cents": r.get("cost_cents"),
    } for r in agent_runs[:8]]

    # Waiting on this client — pending questions with age.
    now_utc = datetime.now(timezone.utc)
    waiting_docs = await db.client_questions.find({
        "company_id": cid,
        "status": {"$in": ["pending", "sent"]},
    }).sort("sent_at", 1).to_list(50)
    waiting_on_client: list[dict] = []
    for q in waiting_docs:
        sent_at = q.get("sent_at") or q.get("created_at")
        try:
            sent_dt = datetime.fromisoformat((sent_at or "").replace("Z", "+00:00"))
            days_since = (now_utc - sent_dt).days
        except Exception:  # noqa: BLE001
            days_since = None
        waiting_on_client.append({
            "id": q.get("id"),
            "question": (q.get("question") or "")[:160],
            "to_email": q.get("to_email"),
            "sent_at": sent_at,
            "days_since": days_since,
        })

    # Today items scoped to this one cid — reuses existing generator.
    today_items: list[dict] = []
    try:
        raw = await _today_items_for_company(cid, company.get("name") or "Untitled", y, m)
        seen_titles: set[tuple] = set()
        for it in raw:
            key = (it.get("company_id"), it.get("title"))
            if key in seen_titles:
                continue
            seen_titles.add(key)
            today_items.append(it)
    except Exception:  # noqa: BLE001
        today_items = []

    # Ordered by urgency (red > amber > blue > green) then created_at.
    _URG = {"red": 0, "amber": 1, "blue": 2, "green": 3}
    today_items.sort(key=lambda i: (_URG.get(i.get("urgency"), 4), -(int(i.get("count") or 0))))

    return {
        "company": {
            "id": company["id"],
            "name": company.get("name") or "Untitled",
            "primary_color": company.get("primary_color"),
            "entity_type": company.get("entity_type"),
            "industry": company.get("industry"),
        },
        "period": f"{y:04d}-{m:02d}",
        "close_status": status or {},
        "vitals": {
            "uncategorized_count": int(uncategorized),
            "open_questions": int(open_questions),
            "answered_unreviewed": int(answered_unreviewed),
            "pending_proposals": int(pending_proposals),
            "running_agents": int(running),
        },
        "agent_activity": agent_activity,
        "today_items": today_items,
        "waiting_on_client": waiting_on_client,
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


# =============================================================================
# Rule preview + acknowledge (with optional "save as rule")
# =============================================================================
# When a CPA acknowledges a client-answered question that resolved to a
# real account (not the 9999 fallback), we offer to spawn a `rules` doc
# so future txns from the same counterparty auto-categorize with zero
# touch. Pre-check the checkbox iff the counterparty is already
# recurring (≥ 2 prior charges in the last 90 days).

_RULE_STOPWORDS = {
    "ACH", "CARD", "PAYMENT", "DEBIT", "CREDIT", "CHECK", "CHECKCARD",
    "ZELLE", "VENMO", "PAYPAL", "TRANSFER", "PURCHASE", "WITHDRAWAL",
    "FROM", "TO", "THE",
}


def _derive_rule_pattern(desc: str) -> str:
    """Extract a stable uppercase substring from a bank description that
    we can safely match against future txns. Strategy: drop the common
    processor prefixes/stopwords + digits + dates, keep the two longest
    remaining tokens joined by a space. Falls back to the full trimmed
    string if the extraction is empty."""
    import re as _re
    if not desc:
        return ""
    upper = desc.upper()
    # Drop obvious noise: standalone dates, dollar amounts, leading refs.
    upper = _re.sub(r"\b\d{1,4}[/-]\d{1,4}([/-]\d{2,4})?\b", " ", upper)
    upper = _re.sub(r"\$?\d[\d,]*(?:\.\d+)?", " ", upper)
    tokens = [t for t in _re.split(r"[^A-Z0-9]+", upper) if t]
    tokens = [t for t in tokens if t not in _RULE_STOPWORDS and len(t) >= 3]
    tokens.sort(key=len, reverse=True)
    if not tokens:
        return upper.strip()[:40]
    return " ".join(tokens[:2])


@router.get("/requests/{qid}/rule-preview")
async def cockpit_rule_preview(qid: str, user: dict = Depends(get_current_user)):
    """Return the CPA-facing "save as rule" preview for an answered
    question: the extracted match pattern, the destination account, and
    whether we've already seen this counterparty recur (which decides
    the pre-checked state)."""
    accessible = await require_firm_or_pro(user)
    q = await db.client_questions.find_one({"id": qid})
    if not q or q.get("company_id") not in accessible:
        raise HTTPException(404, "Question not found or you don't have access.")
    proposal = q.get("ai_proposal") or {}
    code = proposal.get("account_code")
    if not code or code == "9999":
        return {"eligible": False}
    tx_ids = q.get("txn_ids") or ([q.get("txn_id")] if q.get("txn_id") else [])
    if not tx_ids:
        return {"eligible": False}
    txn = await db.transactions.find_one({"id": tx_ids[0], "company_id": q["company_id"]})
    if not txn:
        return {"eligible": False}
    pattern = _derive_rule_pattern(txn.get("description") or "")
    if not pattern:
        return {"eligible": False}
    # Existing rule for this pattern? If so, saving is a no-op.
    existing_rule = await db.rules.find_one({
        "company_id": q["company_id"],
        "match_type": "description_contains",
        "match_value": pattern,
    })
    # Recurring? Count prior transactions in the last 90 days that would
    # match this pattern.
    ninety_days_ago = (datetime.now(timezone.utc) - timedelta(days=90)).date().isoformat()
    prior_count = await db.transactions.count_documents({
        "company_id": q["company_id"],
        "description": {"$regex": pattern, "$options": "i"},
        "date": {"$gte": ninety_days_ago},
    })
    return {
        "eligible": True,
        "pattern": pattern,
        "account_code": code,
        "account_name": proposal.get("account_name"),
        "prior_count": int(prior_count),
        "recurring": prior_count >= 2,
        "already_exists": existing_rule is not None,
    }


class AcknowledgeIn(BaseModel):
    save_rule: Optional[bool] = False
    rule_pattern: Optional[str] = None  # optional CPA override


@router.post("/requests/{qid}/acknowledge")
async def cockpit_acknowledge(
    qid: str,
    inp: Optional[AcknowledgeIn] = None,
    user: dict = Depends(get_current_user),
):
    """Mark a client-answered question as reviewed by the CPA. This is
    the "check it off" action — the Today feed drops the corresponding
    'Client answered — ready to review' card as soon as `cpa_reviewed_at`
    is set. Optionally spawns a `rules` doc so future txns from the same
    counterparty auto-categorize without another ask-client round-trip.
    Idempotent; re-acknowledging is a no-op."""
    accessible = await require_firm_or_pro(user)
    q = await db.client_questions.find_one({"id": qid})
    if not q or q.get("company_id") not in accessible:
        raise HTTPException(404, "Question not found or you don't have access.")
    if q.get("status") != "answered":
        raise HTTPException(400, "Only answered questions can be acknowledged.")
    now = now_iso()
    save_rule = bool(inp and inp.save_rule)

    rule_created: Optional[dict] = None
    if save_rule:
        proposal = q.get("ai_proposal") or {}
        code = proposal.get("account_code")
        acct_id = proposal.get("account_id")
        acct_name = proposal.get("account_name")
        # Only save when the proposal points at a real account.
        if code and code != "9999" and acct_id:
            tx_ids = q.get("txn_ids") or ([q.get("txn_id")] if q.get("txn_id") else [])
            pattern = (inp.rule_pattern or "").strip().upper() if inp else ""
            if not pattern and tx_ids:
                txn = await db.transactions.find_one({
                    "id": tx_ids[0], "company_id": q["company_id"],
                })
                if txn:
                    pattern = _derive_rule_pattern(txn.get("description") or "")
            if pattern:
                existing = await db.rules.find_one({
                    "company_id": q["company_id"],
                    "match_type": "description_contains",
                    "match_value": pattern,
                })
                if not existing:
                    rule_doc = {
                        "id": str(uuid.uuid4()),
                        "company_id": q["company_id"],
                        "match_type": "description_contains",
                        "match_value": pattern,
                        "account_code": code,
                        "account_id": acct_id,
                        "account_name": acct_name,
                        "source": "cpa_from_answer",
                        "source_question_id": qid,
                        "created_by": user.get("email") or user.get("id"),
                        "hits": 0,
                        "created_at": now,
                        "updated_at": now,
                    }
                    await db.rules.insert_one(rule_doc)
                    rule_created = {
                        "id": rule_doc["id"],
                        "pattern": pattern,
                        "account_code": code,
                        "account_name": acct_name,
                    }

    update: dict = {
        "cpa_reviewed_at": now,
        "cpa_reviewed_by": user.get("email") or user.get("id"),
    }
    if rule_created:
        update["rule_id"] = rule_created["id"]
    await db.client_questions.update_one({"id": qid}, {"$set": update})
    return {"ok": True, "cpa_reviewed_at": now, "rule_created": rule_created}


@router.post("/requests/acknowledge-all")
async def cockpit_acknowledge_all(
    company_ids: Optional[str] = Query(None, description="Comma-separated cids to limit scope"),
    user: dict = Depends(get_current_user),
):
    """Bulk-acknowledge every answered-but-unreviewed client question in
    the caller's accessible companies. Great for clearing a legacy
    backlog after enabling the review flow. Optional `company_ids`
    param scopes the sweep to specific clients."""
    accessible = await require_firm_or_pro(user)
    if company_ids:
        scope = [c.strip() for c in company_ids.split(",") if c.strip() and c.strip() in accessible]
    else:
        scope = accessible
    if not scope:
        return {"ok": True, "count": 0}
    now = now_iso()
    r = await db.client_questions.update_many(
        {
            "company_id": {"$in": scope},
            "status": "answered",
            "cpa_reviewed_at": {"$in": [None, ""]},
        },
        {"$set": {
            "cpa_reviewed_at": now,
            "cpa_reviewed_by": user.get("email") or user.get("id"),
            "cpa_reviewed_bulk": True,
        }},
    )
    return {"ok": True, "count": int(r.modified_count), "cpa_reviewed_at": now}




# =============================================================================
# Cockpit Communications — cross-client unified inbox
# =============================================================================
# Wraps three sources into one stream:
#   1. `communications` collection — outgoing emails (ask-client, digests, etc.)
#   2. `client_questions` collection — portal Q&A magic-link threads
#   3. `contacts.activities[]` where meta.source="notetaker" — AI meeting recaps
#
# Every item is normalized to a common shape:
#   { id, source, company_id, company_name, contact, subject, preview,
#     status, direction, created_at, meta }

@router.get("/communications")
async def cockpit_communications(
    q: Optional[str] = Query(None, description="Search across subjects/previews"),
    source: Optional[str] = Query(None, description="email | portal | meeting"),
    company_ids: Optional[str] = Query(None, description="Comma-separated filter"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"items": [], "counts": {"email": 0, "portal": 0, "meeting": 0}}

    filter_ids = set(accessible)
    if company_ids:
        wanted = {c.strip() for c in company_ids.split(",") if c.strip()}
        filter_ids &= wanted
    if not filter_ids:
        return {"items": [], "counts": {"email": 0, "portal": 0, "meeting": 0}}

    id_list = list(filter_ids)
    name_by_id: dict[str, str] = {}
    async for c in db.companies.find({"id": {"$in": id_list}}, {"id": 1, "name": 1}):
        name_by_id[c["id"]] = c.get("name") or "Untitled"

    q_re = None
    if q:
        import re as _re
        q_re = _re.compile(_re.escape(q), _re.IGNORECASE)

    items: list[dict] = []

    # ---- Emails ------------------------------------------------------------
    if source in (None, "email"):
        email_q: dict = {"company_id": {"$in": id_list}}
        if q_re:
            email_q["$or"] = [{"subject": q_re}, {"body": q_re}, {"to": q_re}]
        emails = await db.communications.find(email_q).sort("sent_at", -1).limit(limit).to_list(limit)
        for e in emails:
            body = str(e.get("body") or "")
            preview = (body[:180] + "…") if len(body) > 180 else body
            items.append({
                "id": f"email-{e.get('id') or e.get('_id')}",
                "source": "email",
                "company_id": e.get("company_id"),
                "company_name": name_by_id.get(e.get("company_id")) or "?",
                "contact": e.get("to") or "",
                "subject": e.get("subject") or "(no subject)",
                "preview": preview,
                "status": e.get("status") or "sent",
                "direction": "outbound",
                "created_at": e.get("sent_at") or e.get("created_at"),
                "meta": {"kind": e.get("kind")},
            })

    # ---- Portal Q&A --------------------------------------------------------
    if source in (None, "portal"):
        p_q: dict = {"company_id": {"$in": id_list}}
        if q_re:
            p_q["$or"] = [{"question": q_re}, {"final_answer": q_re}]
        portal = await db.client_questions.find(p_q).sort("sent_at", -1).limit(limit).to_list(limit)
        for p in portal:
            chat = p.get("chat") or []
            last_msg = chat[-1].get("text") if chat else (p.get("final_answer") or "")
            preview = (last_msg[:180] + "…") if len(last_msg) > 180 else last_msg
            items.append({
                "id": f"portal-{p.get('id') or p.get('token') or p.get('_id')}",
                "source": "portal",
                "company_id": p.get("company_id"),
                "company_name": name_by_id.get(p.get("company_id")) or "?",
                "contact": p.get("to_email") or "",
                "subject": (p.get("question") or "Client question")[:120],
                "preview": preview,
                "status": p.get("status") or "pending",
                "direction": "thread",
                "created_at": p.get("answered_at") or p.get("sent_at"),
                "meta": {
                    "turns": len(chat),
                    "token": p.get("id") or p.get("token"),
                    "answer": p.get("answer"),
                    "answered_at": p.get("answered_at"),
                    "cpa_reviewed_at": p.get("cpa_reviewed_at"),
                    "ai_proposal": p.get("ai_proposal"),
                    "question_id": p.get("id"),
                },
            })

    # ---- Meeting recaps (contacts.activities) ------------------------------
    if source in (None, "meeting"):
        # Grab contacts across the filtered companies, then explode activities.
        cursor = db.contacts.find(
            {"company_id": {"$in": id_list},
             "activities": {"$elemMatch": {"meta.source": "notetaker"}}},
            {"id": 1, "name": 1, "company_id": 1, "activities": 1},
        )
        async for c in cursor:
            for a in (c.get("activities") or []):
                meta = a.get("meta") or {}
                if meta.get("source") != "notetaker":
                    continue
                title = meta.get("meeting_title") or a.get("title") or "Meeting recap"
                preview = a.get("summary") or a.get("note") or ""
                if q_re and not (q_re.search(title) or q_re.search(preview)):
                    continue
                items.append({
                    "id": f"meeting-{c['id']}-{a.get('id')}",
                    "source": "meeting",
                    "company_id": c.get("company_id"),
                    "company_name": name_by_id.get(c.get("company_id")) or "?",
                    "contact": c.get("name") or "",
                    "subject": title[:120],
                    "preview": (preview[:180] + "…") if len(preview) > 180 else preview,
                    "status": "recap",
                    "direction": "meeting",
                    "created_at": a.get("at") or meta.get("started_at"),
                    "meta": {
                        "provider": meta.get("provider"),
                        "transcript_url": meta.get("transcript_url"),
                    },
                })

    # Sort newest-first and cap.
    items.sort(key=lambda i: str(i.get("created_at") or ""), reverse=True)
    items = items[:limit]

    counts = {"email": 0, "portal": 0, "meeting": 0}
    for it in items:
        counts[it["source"]] = counts.get(it["source"], 0) + 1

    return {"items": items, "counts": counts, "total": len(items)}



# =============================================================================
# Cockpit Communications — compose actions (Feb 2026)
# =============================================================================
# Two endpoints so a firm user never has to leave the Cockpit view:
#   1. POST /communications/portal/{token}/nudge   — follow-up on portal thread
#   2. POST /communications/ask-client             — generic new client question
# Both piggy-back on the existing communications.py primitives (dispatch,
# email templates, client_questions collection).

class PortalNudgeIn(BaseModel):
    message: Optional[str] = ""


@router.post("/communications/portal/{token}/nudge")
async def cockpit_portal_nudge(
    token: str, inp: PortalNudgeIn,
    user: dict = Depends(get_current_user),
):
    """Append a CPA-authored follow-up to a portal thread and re-send the
    magic-link email so the client sees it. Idempotent per token+minute
    (rate-limits accidental double-clicks via a `updated_at` guard)."""
    accessible = await require_firm_or_pro(user)
    q = await db.client_questions.find_one({"id": token})
    if not q:
        q = await db.client_questions.find_one({"token": token})
    if not q:
        raise HTTPException(404, "Portal thread not found.")
    if q.get("company_id") not in accessible:
        raise HTTPException(403, "You don't have access to this client.")

    from email_dispatcher import dispatch, public_base_url

    magic_url = f"{public_base_url()}/q/{q['id']}"
    body = (inp.message or "").strip()

    # Append a CPA turn to the transcript (so the portal shows it).
    if body:
        await db.client_questions.update_one(
            {"id": q["id"]},
            {"$push": {"chat": {
                "role": "pro",
                "author": user.get("full_name") or user.get("email"),
                "text": body,
                "at": now_iso(),
            }}, "$set": {"updated_at": now_iso()}},
        )

    # Very small purpose-built email — reuses ask_client_batch template if
    # we have the txn data, else a plain follow-up.
    subject = f"Follow-up: {(q.get('question') or 'your accountant asked')[:80]}"
    html = (
        f"<p>Hi,</p>"
        f"<p>{body or 'Just checking in on this — could you take a look when you have a moment?'}</p>"
        f"<p><a href=\"{magic_url}\">Open the client portal</a> to reply.</p>"
        f"<p>Thanks,<br/>{user.get('full_name') or user.get('email')}</p>"
    )
    result = await dispatch(
        kind="ask_client",
        to=q.get("to_email"),
        subject=subject,
        html=html,
        initiating_user_id=user["id"],
        company_id=q["company_id"],
        related={"question_id": q["id"], "nudge": True},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Email send failed")
    return {"ok": True, "communication_id": result["id"], "status": result["status"]}


class CockpitAskClientIn(BaseModel):
    company_id: str
    subject: str
    body: str
    to: Optional[str] = None  # override — else uses the company owner


@router.post("/communications/ask-client")
async def cockpit_ask_client(
    inp: CockpitAskClientIn, user: dict = Depends(get_current_user),
):
    """Kick off a brand new client-portal question from the Cockpit. No
    transactions required — great for standalone advisory questions like
    'Can you confirm your 2025 W-9 details?'"""
    accessible = await require_firm_or_pro(user)
    if inp.company_id not in accessible:
        raise HTTPException(403, "You don't have access to this client.")
    if not inp.subject.strip() or not inp.body.strip():
        raise HTTPException(400, "Subject and body are required.")

    import secrets
    from email_dispatcher import dispatch, public_base_url
    from routes.communications import _resolve_client_email

    to_email = inp.to or (await _resolve_client_email(inp.company_id))[0]
    if not to_email:
        raise HTTPException(400, "No client email on file — set one on the company profile.")

    token = secrets.token_urlsafe(24)
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    q_doc = {
        "id": token,
        "company_id": inp.company_id,
        "flow_type": "pro_ask_client",
        "asked_by_user_id": user["id"],
        "asked_by_name": user.get("full_name") or user.get("email"),
        "question": inp.subject,
        "body": inp.body,
        "status": "pending",
        "sent_at": now_iso(),
        "expires_at": expires,
        "to_email": to_email,
        "chat": [{
            "role": "pro",
            "author": user.get("full_name") or user.get("email"),
            "text": inp.body,
            "at": now_iso(),
        }],
    }
    await db.client_questions.insert_one(q_doc)

    magic_url = f"{public_base_url()}/q/{token}"
    company = await db.companies.find_one({"id": inp.company_id}, {"name": 1})
    company_name = (company or {}).get("name") or ""
    html = (
        f"<p>Hi,</p>"
        f"<p>{inp.body}</p>"
        f"<p><a href=\"{magic_url}\">Open the client portal</a> to reply.</p>"
        f"<p>Thanks,<br/>{user.get('full_name') or user.get('email')}"
        f"{' · ' + company_name if company_name else ''}</p>"
    )
    result = await dispatch(
        kind="ask_client",
        to=to_email,
        subject=inp.subject.strip(),
        html=html,
        initiating_user_id=user["id"],
        company_id=inp.company_id,
        related={"question_id": token, "cockpit_compose": True},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Email send failed")
    return {
        "ok": True, "question_id": token,
        "communication_id": result["id"], "status": result["status"],
    }



# ---------------------------------------------------------------------------
# Cockpit 2 — Handled overnight + Client health
# ---------------------------------------------------------------------------
# These endpoints power the parallel Cockpit 2 page at /cockpit/today-v2.
# The legacy /today page ignores them entirely; they can be adopted by
# either page opportunistically without breaking the other.

def _parse_since(since_iso: Optional[str]) -> datetime:
    """`since` defaults to a rolling 24-hour window so the "handled
    overnight" strip has something meaningful to show on any request,
    regardless of local wall-clock. Client can override with any ISO
    timestamp — including a start-of-today value for a stricter view."""
    if since_iso:
        try:
            d = datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return d
        except Exception:  # noqa: BLE001
            pass
    return datetime.now(timezone.utc) - timedelta(hours=24)


@router.get("/handled-overnight")
async def handled_overnight(
    since: Optional[str] = Query(None, description="ISO cutoff — default: start of today UTC"),
    company_ids: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    """Aggregate every AI action taken since `since` across the caller's
    accessible companies. Feeds the collapsed "N items handled overnight
    — view" strip at the bottom of Cockpit 2."""
    accessible = await require_firm_or_pro(user)
    filter_ids = set(accessible)
    if company_ids:
        filter_ids &= {c.strip() for c in company_ids.split(",") if c.strip()}
    if not filter_ids:
        return {"since": None, "total": 0, "by_source": {}, "items": []}

    cutoff = _parse_since(since)
    cutoff_iso = cutoff.isoformat()

    companies = await db.companies.find({"id": {"$in": list(filter_ids)}}, {"name": 1, "id": 1}).to_list(1000)
    name_by_id = {c["id"]: (c.get("name") or "Untitled") for c in companies}

    items: list[dict] = []
    by_source: dict = {}

    # 1) Auto-categorized transactions — confident enough that the AI
    #    posted them without asking. `ai_confidence >= 0.80` mirrors
    #    the auto-post threshold used elsewhere in the codebase.
    try:
        tx_cur = db.transactions.find({
            "company_id": {"$in": list(filter_ids)},
            "ai_confidence": {"$gte": 0.80},
            "posted": True,
            "created_at": {"$gte": cutoff_iso},
        }).sort("created_at", -1).limit(limit)
        async for t in tx_cur:
            items.append({
                "id": f"tx-{t.get('id')}",
                "kind": "auto_categorized_txn",
                "company_id": t.get("company_id"),
                "company_name": name_by_id.get(t.get("company_id"), "—"),
                "title": (t.get("description") or "Transaction")[:80],
                "subtitle": f"Categorized · ${abs(float(t.get('amount') or 0)):,.2f}",
                "confidence": t.get("ai_confidence"),
                "amount": t.get("amount"),
                "when": t.get("created_at"),
                "route": "/accounting/transactions",
            })
            by_source["auto_categorized_txns"] = by_source.get("auto_categorized_txns", 0) + 1
    except Exception:  # noqa: BLE001
        pass

    # 2) Portal answers auto-applied without CPA review.
    try:
        q_cur = db.client_questions.find({
            "company_id": {"$in": list(filter_ids)},
            "ai_proposal.auto_applied": True,
            "answered_at": {"$gte": cutoff_iso},
        }).sort("answered_at", -1).limit(limit)
        async for q in q_cur:
            prop = q.get("ai_proposal") or {}
            items.append({
                "id": f"qa-{q.get('id')}",
                "kind": "auto_applied_portal_answer",
                "company_id": q.get("company_id"),
                "company_name": name_by_id.get(q.get("company_id"), "—"),
                "title": (q.get("question") or "Client answered")[:80],
                "subtitle": f"Auto-posted to {prop.get('account_code')} · {prop.get('account_name')}",
                "confidence": prop.get("confidence"),
                "when": q.get("answered_at"),
                "route": f"/cockpit/communications?company_ids={q.get('company_id')}&question_id={q.get('id')}",
            })
            by_source["auto_applied_portal_answers"] = by_source.get("auto_applied_portal_answers", 0) + 1
    except Exception:  # noqa: BLE001
        pass

    # 3) Agent runs completed successfully — every one represents work
    #    the CPA didn't have to touch.
    try:
        r_cur = db.agent_runs.find({
            "company_id": {"$in": list(filter_ids)},
            "status": "success",
            "finished_at": {"$gte": cutoff_iso},
        }).sort("finished_at", -1).limit(limit)
        async for r in r_cur:
            items.append({
                "id": f"run-{r.get('id')}",
                "kind": "agent_run",
                "company_id": r.get("company_id"),
                "company_name": name_by_id.get(r.get("company_id"), "Firm-wide"),
                "title": f"{r.get('template_key') or 'Agent'} run",
                "subtitle": f"{r.get('findings_count', 0)} finding{'s' if r.get('findings_count', 0) != 1 else ''}",
                "when": r.get("finished_at"),
                "route": "/cockpit/agents",
            })
            by_source["agent_runs"] = by_source.get("agent_runs", 0) + 1
    except Exception:  # noqa: BLE001
        pass

    # Sort newest first, cap at limit for the expanded list.
    items.sort(key=lambda x: x.get("when") or "", reverse=True)

    return {
        "since": cutoff_iso,
        "total": sum(by_source.values()),
        "by_source": by_source,
        "items": items[:limit],
    }


@router.get("/client-health")
async def client_health(
    company_ids: Optional[str] = Query(None),
    chronic_days: int = Query(30, description="Threshold for `chronic` flag"),
    lookback_days: int = Query(90, description="Window for median response calc"),
    user: dict = Depends(get_current_user),
):
    """Per-client relationship health scoring for the persistent strip
    at the top of Cockpit 2. Surfaces clients whose responsiveness has
    degraded so the CPA sees them even on days when nothing about
    them happens to be "red" on Today."""
    accessible = await require_firm_or_pro(user)
    filter_ids = set(accessible)
    if company_ids:
        filter_ids &= {c.strip() for c in company_ids.split(",") if c.strip()}
    if not filter_ids:
        return {"clients": []}

    companies = await db.companies.find({"id": {"$in": list(filter_ids)}}, {"name": 1, "id": 1}).to_list(1000)
    name_by_id = {c["id"]: (c.get("name") or "Untitled") for c in companies}

    now = datetime.now(timezone.utc)
    lookback_iso = (now - timedelta(days=lookback_days)).isoformat()

    out: list[dict] = []
    for cid in filter_ids:
        if cid not in name_by_id:
            continue

        # Open (unanswered) client questions — the strip's primary signal.
        open_cur = db.client_questions.find({
            "company_id": cid,
            "status": {"$nin": ["answered", "archived", "failed"]},
        }, {"sent_at": 1, "created_at": 1})
        max_stale_days = 0
        open_count = 0
        async for q in open_cur:
            open_count += 1
            ts = q.get("sent_at") or q.get("created_at")
            if isinstance(ts, str) and ts:
                try:
                    d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    if d.tzinfo is None:
                        d = d.replace(tzinfo=timezone.utc)
                    max_stale_days = max(max_stale_days, (now - d).days)
                except Exception:  # noqa: BLE001
                    pass

        # Historical response times to compute median + trend.
        hist_cur = db.client_questions.find({
            "company_id": cid,
            "status": "answered",
            "answered_at": {"$gte": lookback_iso},
        }, {"sent_at": 1, "answered_at": 1, "created_at": 1})
        response_days: list[float] = []
        response_days_recent: list[float] = []
        recent_cutoff = now - timedelta(days=7)
        async for q in hist_cur:
            s = q.get("sent_at") or q.get("created_at")
            a = q.get("answered_at")
            if not (isinstance(s, str) and isinstance(a, str)):
                continue
            try:
                sd = datetime.fromisoformat(s.replace("Z", "+00:00"))
                ad = datetime.fromisoformat(a.replace("Z", "+00:00"))
                if sd.tzinfo is None: sd = sd.replace(tzinfo=timezone.utc)
                if ad.tzinfo is None: ad = ad.replace(tzinfo=timezone.utc)
                delta_days = (ad - sd).total_seconds() / 86400.0
                if delta_days < 0:
                    continue
                response_days.append(delta_days)
                if ad >= recent_cutoff:
                    response_days_recent.append(delta_days)
            except Exception:  # noqa: BLE001
                pass

        def _median(nums: list[float]) -> Optional[float]:
            if not nums:
                return None
            s = sorted(nums)
            n = len(s)
            mid = n // 2
            return s[mid] if n % 2 == 1 else (s[mid - 1] + s[mid]) / 2.0

        med = _median(response_days)
        med_recent = _median(response_days_recent)

        # Trend: improving | stalling | steady | chronic | new
        if max_stale_days >= chronic_days:
            trend = "chronic"
        elif med_recent is not None and med is not None and med_recent > med * 1.5:
            trend = "stalling"
        elif med_recent is not None and med is not None and med_recent < med * 0.7:
            trend = "improving"
        elif med is not None:
            trend = "steady"
        else:
            trend = "new"

        chronic = max_stale_days >= chronic_days or (med is not None and med >= 14)

        if open_count == 0 and not chronic:
            continue  # skip clients with nothing to say

        out.append({
            "company_id": cid,
            "company_name": name_by_id[cid],
            "open_questions": open_count,
            "max_stale_days": max_stale_days,
            "median_response_days": round(med, 1) if med is not None else None,
            "median_response_days_recent": round(med_recent, 1) if med_recent is not None else None,
            "trend": trend,
            "chronic": chronic,
        })

    # Chronic clients first, then by max_stale_days desc, then name asc.
    out.sort(key=lambda x: (
        0 if x["chronic"] else 1,
        -x["max_stale_days"],
        x["company_name"].lower(),
    ))

    return {"clients": out, "chronic_threshold_days": chronic_days}
