"""SmartBooks — Agent Platform (Cockpit Phase 5A).

Puzzle-class scheduled AI agents built on top of the workflows we
already ship. Every agent = an instance of one **template** with a
schedule, a scope (company_id or firm-wide), and a config blob.

Templates seeded in this file (`_TEMPLATES`):
  1. cleanup_sweep        — auto-categorize uncat'd transactions
  2. je_auto_drafter      — run prepaid amort + accrual JE drafters
  3. advisor_report_send  — generate + optionally send advisor pack
  4. tax_1099_watcher     — quarterly vendor threshold check
  5. portal_chase         — nudge stale portal client questions
  6. signoff_reminder     — nudge unresolved close sign-offs after N days

Each template exposes `run(cid, agent, config, user_hint)` returning a
list of `finding` dicts.  Findings surface in Today feed as
`source=agent` cards and can be approved/dismissed from the drawer.

Scheduler: **wake-on-request**. When any firm user hits
`/api/cockpit/today` or `/api/cockpit/agents/*` we call
`tick_due_agents()` which enqueues due agents via a background task.
Simpler than APScheduler, no infra, no leader-election.
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Callable

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from db import db, now_iso, coerce
from auth import get_current_user
from routes.cockpit import require_firm_or_pro

router = APIRouter(prefix="/api/cockpit", tags=["agents"])


# ---------------------------------------------------------------------------
# Template catalog
# ---------------------------------------------------------------------------
# Each template is a plain dict + a `run` async callable.  Keeping the
# implementations inline (rather than dynamic imports) keeps the module
# easy to reason about and grep.

async def _run_cleanup_sweep(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Count uncategorized transactions and surface a finding if any."""
    threshold = int(cfg.get("min_uncategorized", 1) or 1)
    n = await db.transactions.count_documents({
        "company_id": cid,
        "$or": [
            {"account_id": None},
            {"account_id": ""},
            {"needs_review": True},
        ],
    })
    if n < threshold:
        return []
    return [{
        "kind": "cleanup_sweep",
        "severity": "amber" if n < 25 else "red",
        "title": f"{n} transactions need categorization",
        "detail": (
            f"Auto-sweep found {n} uncategorized or flagged transactions. "
            "Open Cleanup Copilot to review and post."
        ),
        "action_label": "Open Cleanup",
        "action_route": f"/accounting/ai-cleanup-review?company={cid}",
        "count": n,
    }]


async def _run_je_auto_drafter(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Kick the JE drafters scan and report how many pending drafts exist."""
    from routes.je_drafters import (
        _draft_prepaid_amortizations, _draft_recurring_accruals,
    )
    period = cfg.get("period") or _last_closed_or_current_ym()
    try:
        y, m = int(period[:4]), int(period[5:7])
    except Exception:
        return []
    # Clear stale pending drafts (same behavior as the scan endpoint).
    await db.je_drafts.delete_many({
        "company_id": cid, "period": period, "status": "pending",
    })
    drafts = []
    kinds = set(cfg.get("kinds") or ["prepaid_amort", "accrual"])
    if "prepaid_amort" in kinds:
        drafts += await _draft_prepaid_amortizations(cid, y, m)
    if "accrual" in kinds:
        drafts += await _draft_recurring_accruals(cid, y, m)
    if drafts:
        await db.je_drafts.insert_many(drafts)
    if not drafts:
        return []
    return [{
        "kind": "je_auto_drafter",
        "severity": "blue",
        "title": f"{len(drafts)} JE drafts ready for review",
        "detail": (
            f"Auto-drafted prepaid amortization + accruals for {period}. "
            "Approve or edit each before posting."
        ),
        "action_label": "Review drafts",
        "action_route": f"/accounting/journal-entries?tab=drafts&company={cid}",
        "count": len(drafts),
        "meta": {"period": period},
    }]


async def _run_advisor_report_send(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Check if the target period's advisor report exists; produce a finding
    if the CPA still needs to generate/send it."""
    period = cfg.get("period") or _last_closed_or_current_ym()
    existing = await db.advisor_reports.find_one({"company_id": cid, "period": period})
    if existing and existing.get("sent_to_client_at"):
        return []
    if existing:
        return [{
            "kind": "advisor_report_send",
            "severity": "amber",
            "title": f"Advisor report ready — not yet sent",
            "detail": f"The {period} advisor pack is generated but hasn't been shared with the client.",
            "action_label": "Send to portal",
            "action_route": f"/cockpit/reports?company={cid}&period={period}",
            "count": 1,
            "meta": {"period": period, "report_id": existing.get("id")},
        }]
    return [{
        "kind": "advisor_report_send",
        "severity": "amber",
        "title": f"Advisor report not generated for {period}",
        "detail": "Auto-run scheduled — generate and send the branded monthly pack.",
        "action_label": "Generate report",
        "action_route": f"/cockpit/reports?company={cid}&period={period}",
        "count": 1,
        "meta": {"period": period},
    }]


async def _run_tax_1099_watcher(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Flag vendors approaching or past the 1099 threshold."""
    threshold = float(cfg.get("threshold", 600.0) or 600.0)
    warn_at = float(cfg.get("warn_at", 500.0) or 500.0)
    year = int(cfg.get("year") or datetime.now(timezone.utc).year)
    start = f"{year:04d}-01-01"; end = f"{year:04d}-12-31"

    pipeline = [
        {"$match": {
            "company_id": cid,
            "date": {"$gte": start, "$lte": end},
            "kind": {"$in": ["bill", "expense", "check", "payment"]},
        }},
        {"$group": {"_id": "$vendor_id", "total": {"$sum": "$amount"}}},
        {"$match": {"total": {"$gte": warn_at}}},
    ]
    try:
        rows = await db.transactions.aggregate(pipeline).to_list(500)
    except Exception:
        rows = []
    if not rows:
        return []
    over = [r for r in rows if (r.get("total") or 0) >= threshold]
    warn = [r for r in rows if warn_at <= (r.get("total") or 0) < threshold]
    findings = []
    if over:
        findings.append({
            "kind": "tax_1099_watcher",
            "severity": "amber",
            "title": f"{len(over)} vendor{'s' if len(over) != 1 else ''} crossed 1099 threshold",
            "detail": f"Confirm W-9s are on file and prepare 1099-NEC forms for {year}.",
            "action_label": "Open 1099 Cockpit",
            "action_route": f"/cockpit/1099?company={cid}&year={year}",
            "count": len(over),
            "meta": {"year": year, "threshold": threshold},
        })
    if warn:
        findings.append({
            "kind": "tax_1099_watcher",
            "severity": "blue",
            "title": f"{len(warn)} vendor{'s' if len(warn) != 1 else ''} near 1099 threshold",
            "detail": f"Vendors paid ${warn_at:,.0f}–${threshold:,.0f} year-to-date — watch through year-end.",
            "action_label": "Open 1099 Cockpit",
            "action_route": f"/cockpit/1099?company={cid}&year={year}",
            "count": len(warn),
            "meta": {"year": year, "warn_at": warn_at},
        })
    return findings


async def _run_portal_chase(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Surface stale portal client questions past `stale_days`."""
    stale_days = int(cfg.get("stale_days", 3) or 3)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    stale = await db.client_questions.count_documents({
        "company_id": cid,
        "status": "pending",
        "sent_at": {"$lt": cutoff},
    })
    if stale <= 0:
        return []
    return [{
        "kind": "portal_chase",
        "severity": "amber",
        "title": f"{stale} client question{'s' if stale != 1 else ''} unanswered {stale_days}+ days",
        "detail": "Send a friendly nudge from the Client Requests rail.",
        "action_label": "Open Requests",
        "action_route": f"/cockpit/requests?company={cid}",
        "count": stale,
    }]


async def _run_signoff_reminder(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Flag close periods sitting in `waiting` sign-off past `stale_days`."""
    stale_days = int(cfg.get("stale_days", 3) or 3)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
    stale = await db.client_signoffs.count_documents({
        "company_id": cid,
        "status": "waiting",
        "sent_at": {"$lt": cutoff},
    })
    if stale <= 0:
        return []
    return [{
        "kind": "signoff_reminder",
        "severity": "amber",
        "title": f"{stale} close sign-off{'s' if stale != 1 else ''} pending {stale_days}+ days",
        "detail": "Resend the sign-off link or ping the client on the portal.",
        "action_label": "Open Requests",
        "action_route": f"/cockpit/requests?company={cid}",
        "count": stale,
    }]


# ---------------------------------------------------------------------------
# Phase 5A.2 templates — parity with Puzzle's Cowork library
# ---------------------------------------------------------------------------

async def _run_txn_vendor_inconsistencies(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """For each vendor in the last N days, flag category drift and outlier
    amounts (3x the vendor's mean)."""
    lookback = int(cfg.get("lookback_days", 90) or 90)
    since = (datetime.now(timezone.utc) - timedelta(days=lookback)).date().isoformat()
    pipeline = [
        {"$match": {"company_id": cid, "date": {"$gte": since},
                    "vendor_id": {"$nin": [None, ""]}}},
        {"$group": {
            "_id": "$vendor_id",
            "n": {"$sum": 1},
            "categories": {"$addToSet": "$account_id"},
            "avg": {"$avg": "$amount"},
            "max": {"$max": "$amount"},
        }},
        {"$match": {"n": {"$gte": 3}}},
    ]
    try:
        rows = await db.transactions.aggregate(pipeline).to_list(500)
    except Exception:
        rows = []
    drift = [r for r in rows if len([c for c in (r.get("categories") or []) if c]) > 1]
    outliers = [r for r in rows if (r.get("avg") or 0) > 0 and (r.get("max") or 0) > 3 * (r.get("avg") or 1)]
    findings: list[dict] = []
    if drift:
        findings.append({
            "kind": "txn_vendor_inconsistencies",
            "severity": "amber",
            "title": f"{len(drift)} vendor{'s' if len(drift) != 1 else ''} with category drift",
            "detail": f"Same vendor recorded to multiple accounts in the last {lookback} days.",
            "action_label": "Open Transactions",
            "action_route": f"/accounting/transactions?filter=vendor-drift&company={cid}",
            "count": len(drift),
        })
    if outliers:
        findings.append({
            "kind": "txn_vendor_inconsistencies",
            "severity": "amber",
            "title": f"{len(outliers)} vendor{'s' if len(outliers) != 1 else ''} with outlier amount",
            "detail": "One recent charge is 3x the vendor's typical amount.",
            "action_label": "Open Transactions",
            "action_route": f"/accounting/transactions?filter=outlier&company={cid}",
            "count": len(outliers),
        })
    return findings


async def _run_first_time_large_txn(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Surface transactions in the last N days that are (a) from a brand-new
    vendor or (b) 3x the vendor's historical average."""
    lookback = int(cfg.get("lookback_days", 30) or 30)
    min_amount = float(cfg.get("min_amount", 500.0) or 500.0)
    since = (datetime.now(timezone.utc) - timedelta(days=lookback)).date().isoformat()
    recent = await db.transactions.find({
        "company_id": cid, "date": {"$gte": since},
        "amount": {"$gte": min_amount},
    }).limit(500).to_list(500)
    new_vendor = 0
    big_jump = 0
    for t in recent:
        vid = t.get("vendor_id")
        if not vid:
            continue
        history = await db.transactions.count_documents({
            "company_id": cid, "vendor_id": vid, "date": {"$lt": since},
        })
        if history == 0:
            new_vendor += 1
            continue
        # cheap average from Mongo
        agg = await db.transactions.aggregate([
            {"$match": {"company_id": cid, "vendor_id": vid, "date": {"$lt": since}}},
            {"$group": {"_id": None, "avg": {"$avg": "$amount"}}},
        ]).to_list(1)
        avg = float((agg[0].get("avg") if agg else 0) or 0)
        if avg > 0 and (t.get("amount") or 0) > 3 * avg:
            big_jump += 1
    findings: list[dict] = []
    if new_vendor:
        findings.append({
            "kind": "first_time_large_txn",
            "severity": "amber",
            "title": f"{new_vendor} large txn{'s' if new_vendor != 1 else ''} from new vendors",
            "detail": f"Charges ≥ ${min_amount:,.0f} to vendors never seen before in the last {lookback} days.",
            "action_label": "Review Transactions",
            "action_route": f"/accounting/transactions?filter=new-vendor&company={cid}",
            "count": new_vendor,
        })
    if big_jump:
        findings.append({
            "kind": "first_time_large_txn",
            "severity": "amber",
            "title": f"{big_jump} charge{'s' if big_jump != 1 else ''} 3x vendor's normal amount",
            "detail": "Investigate before month-end close.",
            "action_label": "Review Transactions",
            "action_route": f"/accounting/transactions?filter=amount-jump&company={cid}",
            "count": big_jump,
        })
    return findings


async def _run_internal_transfers(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Detect transactions that look like internal money transfers but aren't
    linked as such."""
    lookback = int(cfg.get("lookback_days", 60) or 60)
    since = (datetime.now(timezone.utc) - timedelta(days=lookback)).date().isoformat()
    q = {
        "company_id": cid, "date": {"$gte": since},
        "$or": [
            {"description": {"$regex": r"transfer|xfer|zelle|ach\s+to\s+self", "$options": "i"}},
            {"memo":        {"$regex": r"transfer|xfer|zelle|ach\s+to\s+self", "$options": "i"}},
        ],
        "linked_transfer_id": {"$in": [None, ""]},
    }
    n = await db.transactions.count_documents(q)
    if n <= 0:
        return []
    return [{
        "kind": "internal_transfers",
        "severity": "blue",
        "title": f"{n} likely internal transfer{'s' if n != 1 else ''} not linked",
        "detail": "Match the debit/credit side or re-categorize to a transfer account.",
        "action_label": "Open Transactions",
        "action_route": f"/accounting/transactions?filter=unlinked-transfer&company={cid}",
        "count": n,
    }]


async def _run_match_unpaid_bills(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """For each open bill, look for uncategorized bank txns with matching
    amount and vendor within the tolerance window."""
    tol_days = int(cfg.get("tolerance_days", 5) or 5)
    tol_amount = float(cfg.get("tolerance_amount", 1.0) or 1.0)
    open_bills = await db.bills.find({
        "company_id": cid, "status": {"$nin": ["paid", "void", "cancelled"]},
    }).limit(500).to_list(500)
    matches = 0
    for b in open_bills:
        amt = float(b.get("balance_due") or b.get("amount") or 0)
        if amt <= 0:
            continue
        try:
            dt = datetime.fromisoformat((b.get("date") or "")[:10])
        except Exception:
            continue
        lo = (dt - timedelta(days=tol_days)).date().isoformat()
        hi = (dt + timedelta(days=tol_days + 30)).date().isoformat()
        hit = await db.transactions.find_one({
            "company_id": cid, "vendor_id": b.get("contact_id"),
            "amount": {"$gte": amt - tol_amount, "$lte": amt + tol_amount},
            "date": {"$gte": lo, "$lte": hi},
            "linked_bill_id": {"$in": [None, ""]},
        })
        if hit:
            matches += 1
    if matches <= 0:
        return []
    return [{
        "kind": "match_unpaid_bills",
        "severity": "blue",
        "title": f"{matches} bill{'s' if matches != 1 else ''} likely already paid",
        "detail": "Auto-matcher found a bank transaction that lines up with each open bill. Confirm to close.",
        "action_label": "Review AP",
        "action_route": f"/accounting/bills?filter=possible-match&company={cid}",
        "count": matches,
    }]


async def _run_match_unpaid_invoices(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Same idea as unpaid bills but from the AR side."""
    tol_days = int(cfg.get("tolerance_days", 5) or 5)
    tol_amount = float(cfg.get("tolerance_amount", 1.0) or 1.0)
    open_inv = await db.invoices.find({
        "company_id": cid, "status": {"$nin": ["paid", "void", "cancelled"]},
    }).limit(500).to_list(500)
    matches = 0
    for i in open_inv:
        amt = float(i.get("balance_due") or i.get("total") or i.get("amount") or 0)
        if amt <= 0:
            continue
        try:
            dt = datetime.fromisoformat((i.get("date") or i.get("issue_date") or "")[:10])
        except Exception:
            continue
        lo = (dt - timedelta(days=tol_days)).date().isoformat()
        hi = (dt + timedelta(days=tol_days + 30)).date().isoformat()
        hit = await db.transactions.find_one({
            "company_id": cid, "contact_id": i.get("contact_id"),
            "amount": {"$gte": amt - tol_amount, "$lte": amt + tol_amount},
            "date": {"$gte": lo, "$lte": hi},
            "linked_invoice_id": {"$in": [None, ""]},
        })
        if hit:
            matches += 1
    if matches <= 0:
        return []
    return [{
        "kind": "match_unpaid_invoices",
        "severity": "blue",
        "title": f"{matches} invoice{'s' if matches != 1 else ''} likely already paid",
        "detail": "Customer deposits found that line up with each open invoice. Confirm to close.",
        "action_label": "Review AR",
        "action_route": f"/accounting/invoices?filter=possible-match&company={cid}",
        "count": matches,
    }]


async def _run_missing_receipts(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Transactions above the threshold with no receipt attached."""
    threshold = float(cfg.get("min_amount", 75.0) or 75.0)
    lookback = int(cfg.get("lookback_days", 60) or 60)
    since = (datetime.now(timezone.utc) - timedelta(days=lookback)).date().isoformat()
    q = {
        "company_id": cid, "date": {"$gte": since},
        "amount": {"$gte": threshold},
        "$and": [
            {"$or": [{"receipt_id": {"$in": [None, ""]}}, {"receipt_id": {"$exists": False}}]},
            {"$or": [{"veryfi_receipt_id": {"$in": [None, ""]}}, {"veryfi_receipt_id": {"$exists": False}}]},
        ],
    }
    n = await db.transactions.count_documents(q)
    if n <= 0:
        return []
    return [{
        "kind": "missing_receipts",
        "severity": "amber",
        "title": f"{n} transaction{'s' if n != 1 else ''} over ${threshold:,.0f} missing receipts",
        "detail": f"Attach receipts for the last {lookback} days of large charges.",
        "action_label": "Ask client for receipts",
        "action_route": "/cockpit/requests?flow=receipts",
        "count": n,
    }]


async def _run_variance_analysis(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Compare current-period P&L to prior period; flag accounts moving more
    than X% AND more than $Y."""
    from reports import compute_income_statement
    period = cfg.get("period") or _last_closed_or_current_ym()
    pct_threshold = float(cfg.get("pct_threshold", 5.0) or 5.0)
    dollar_threshold = float(cfg.get("dollar_threshold", 1000.0) or 1000.0)
    try:
        y, m = int(period[:4]), int(period[5:7])
        prev_y, prev_m = (y - 1, 12) if m == 1 else (y, m - 1)
        from calendar import monthrange
        cur_start = f"{y:04d}-{m:02d}-01"
        cur_end = f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
        prev_start = f"{prev_y:04d}-{prev_m:02d}-01"
        prev_end = f"{prev_y:04d}-{prev_m:02d}-{monthrange(prev_y, prev_m)[1]:02d}"
        cur = await compute_income_statement(cid, cur_start, cur_end, "accrual")
        prev = await compute_income_statement(cid, prev_start, prev_end, "accrual")
    except Exception:
        return []

    def _by_name(is_dict: dict) -> dict:
        by = {}
        for section in ("revenue", "cogs", "expenses"):
            for row in (is_dict.get(section) or []):
                by[row.get("name") or ""] = float(row.get("amount") or 0)
        return by

    cur_by = _by_name(cur); prev_by = _by_name(prev)
    flagged = []
    for name in (set(cur_by) | set(prev_by)):
        if not name:
            continue
        c = cur_by.get(name, 0.0); p = prev_by.get(name, 0.0)
        diff = c - p
        base = max(abs(p), abs(c))
        if base == 0:
            continue
        pct = abs(diff) / base * 100.0
        if pct >= pct_threshold and abs(diff) >= dollar_threshold:
            flagged.append({"name": name, "diff": diff, "pct": pct})
    if not flagged:
        return []
    flagged.sort(key=lambda x: abs(x["diff"]), reverse=True)
    top = flagged[:3]
    detail = "; ".join(
        f"{f['name']} {'up' if f['diff'] > 0 else 'down'} ${abs(f['diff']):,.0f} ({f['pct']:.0f}%)"
        for f in top
    )
    return [{
        "kind": "variance_analysis",
        "severity": "amber",
        "title": f"{len(flagged)} account{'s' if len(flagged) != 1 else ''} moved >{pct_threshold:.0f}% & >${dollar_threshold:,.0f}",
        "detail": f"vs prior period ({prev_start[:7]}): {detail}",
        "action_label": "Open P&L",
        "action_route": f"/accounting/reports/income-statement?ym={period}&company={cid}",
        "count": len(flagged),
        "meta": {"period": period, "top": top},
    }]


async def _run_profit_margin_analysis(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Rank classes/projects by gross margin; flag when the spread between
    top and bottom is large enough to warrant a conversation."""
    period = cfg.get("period") or _last_closed_or_current_ym()
    min_spread = float(cfg.get("min_spread_pct", 20.0) or 20.0)
    try:
        y, m = int(period[:4]), int(period[5:7])
        from calendar import monthrange
        start = f"{y:04d}-{m:02d}-01"
        end = f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
    except Exception:
        return []

    pipeline = [
        {"$match": {"company_id": cid, "date": {"$gte": start, "$lte": end}}},
        {"$unwind": {"path": "$lines", "preserveNullAndEmptyArrays": True}},
        {"$match": {"lines.class_id": {"$nin": [None, ""]}}},
        {"$group": {
            "_id": "$lines.class_id",
            "revenue": {"$sum": {"$cond": [{"$in": ["$lines.account_type", ["revenue", "income"]]}, "$lines.credit", 0]}},
            "cogs": {"$sum": {"$cond": [{"$eq": ["$lines.account_type", "cogs"]}, "$lines.debit", 0]}},
        }},
    ]
    try:
        rows = await db.journal_entries.aggregate(pipeline).to_list(200)
    except Exception:
        rows = []
    margins = []
    for r in rows:
        rev = float(r.get("revenue") or 0)
        cogs = float(r.get("cogs") or 0)
        if rev <= 0:
            continue
        margins.append({"class_id": r["_id"], "margin_pct": (rev - cogs) / rev * 100.0})
    if len(margins) < 2:
        return []
    margins.sort(key=lambda x: x["margin_pct"], reverse=True)
    spread = margins[0]["margin_pct"] - margins[-1]["margin_pct"]
    if spread < min_spread:
        return []
    return [{
        "kind": "profit_margin_analysis",
        "severity": "blue",
        "title": f"{spread:.0f}% margin spread across {len(margins)} segments",
        "detail": f"Top segment margin {margins[0]['margin_pct']:.0f}% · lowest {margins[-1]['margin_pct']:.0f}%. Consider a pricing / cost review of the laggards.",
        "action_label": "Open P&L by Class",
        "action_route": f"/accounting/reports/income-statement?ym={period}&by=class&company={cid}",
        "count": len(margins),
        "meta": {"period": period, "spread_pct": spread},
    }]


async def _run_pdf_txn_import_watcher(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Unprocessed bank statement uploads older than the cutoff."""
    stale_hours = int(cfg.get("stale_hours", 24) or 24)
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=stale_hours)).isoformat()
    n = 0
    try:
        n = await db.bank_statements.count_documents({
            "company_id": cid,
            "status": {"$nin": ["processed", "completed", "reconciled"]},
            "created_at": {"$lt": cutoff},
        })
    except Exception:
        n = 0
    if n <= 0:
        return []
    return [{
        "kind": "pdf_txn_import_watcher",
        "severity": "amber",
        "title": f"{n} bank statement{'s' if n != 1 else ''} still processing {stale_hours}+ hours",
        "detail": "Re-run OCR extraction or fall back to CSV import.",
        "action_label": "Open Reconciliation",
        "action_route": f"/accounting/reconciliation?company={cid}",
        "count": n,
    }]


async def _run_receipt_capture_watcher(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Uploaded receipts that never got matched to a transaction."""
    stale_hours = int(cfg.get("stale_hours", 24) or 24)
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=stale_hours)).isoformat()
    n = 0
    try:
        n = await db.receipts.count_documents({
            "company_id": cid,
            "$or": [{"transaction_id": {"$in": [None, ""]}}, {"transaction_id": {"$exists": False}}],
            "created_at": {"$lt": cutoff},
        })
    except Exception:
        n = 0
    if n <= 0:
        return []
    return [{
        "kind": "receipt_capture_watcher",
        "severity": "blue",
        "title": f"{n} receipt{'s' if n != 1 else ''} unmatched {stale_hours}+ hours",
        "detail": "Auto-match usually catches these — investigate if the amount or date is off.",
        "action_label": "Open Receipts",
        "action_route": f"/accounting/receipts?company={cid}",
        "count": n,
    }]


# ---------------------------------------------------------------------------
# Phase 5A.3 — LLM-powered insight templates (wraps existing engines)
# ---------------------------------------------------------------------------

async def _llm_ask(system: str, user: str, feature: str) -> Optional[str]:
    """Thin wrapper around the shared LlmChat used by advisor_reports.
    Returns the raw LLM text or None on failure so callers can fall back
    to a templated string.  Uses Emergent LLM key via ai_service._new_chat."""
    try:
        from ai_service import _new_chat
        from llm_client import UserMessage
        chat = _new_chat(system=system, session_id=str(uuid.uuid4()), feature=feature)
        r = await chat.send_message(UserMessage(text=user))
        return r.text if hasattr(r, "text") else str(r)
    except Exception:
        return None


async def _kpis_for_period(cid: str, period: str) -> dict:
    """Reuse the advisor-reports data generator for the LLM prompts."""
    from routes.advisor_reports import _generate_report_data
    try:
        data = await _generate_report_data(cid, period, "accrual")
        return data.get("kpis") or {}
    except Exception:
        return {}


async def _run_key_business_insight(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """One high-value insight + a client-facing email draft. Wraps the
    insights-chat / advisor-reports LLM path.  Always fires (blue) —
    scheduled cadence controls frequency."""
    period = cfg.get("period") or _last_closed_or_current_ym()
    kpis = await _kpis_for_period(cid, period)
    if not kpis:
        return []
    system = (
        "You are a senior CPA advising a small-business owner. Surface ONE "
        "specific, data-backed insight from the KPIs. Always cite one exact "
        "dollar or percent value. Then draft a short (3-4 sentence) client "
        "email in the CPA's voice. Return JSON: {insight, email}."
    )
    prompt = (
        f"Period: {period}. KPIs: {kpis}. "
        "Return ONE JSON object with keys insight, email."
    )
    text = await _llm_ask(system, prompt, feature="agent-insight")
    insight = ""
    email = ""
    if text:
        import json, re
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                j = json.loads(m.group(0))
                insight = str(j.get("insight") or "")[:600]
                email = str(j.get("email") or "")[:1200]
            except Exception:
                pass
    if not insight:
        # Deterministic fallback so schedule always produces value.
        rev = kpis.get("revenue") or 0
        margin = kpis.get("gross_margin_pct") or 0
        insight = f"Revenue was ${rev:,.0f} at {margin:.1f}% gross margin — check whether pricing keeps pace with cost."
    return [{
        "kind": "key_business_insight",
        "severity": "blue",
        "title": f"Key insight for {period}",
        "detail": insight,
        "action_label": "Draft client email",
        "action_route": f"/cockpit/communications?draft=insight&period={period}",
        "count": 1,
        "meta": {"period": period, "email": email},
    }]


async def _run_whats_going_well(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """5 bright spots in the client's numbers. Wraps `_flux_narrative`'s
    LLM engine with a positive-framed prompt."""
    period = cfg.get("period") or _last_closed_or_current_ym()
    kpis = await _kpis_for_period(cid, period)
    if not kpis:
        return []
    system = (
        "You are a positive, precise CPA. Given the KPIs, list 5 specific "
        "bright spots — each with one dollar or percent value. No hedging, "
        "no jargon. Return JSON: {bright_spots: [str, str, str, str, str]}."
    )
    prompt = f"Period: {period}. KPIs: {kpis}. Return ONE JSON object."
    text = await _llm_ask(system, prompt, feature="agent-bright-spots")
    spots: list[str] = []
    if text:
        import json, re
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                j = json.loads(m.group(0))
                for s in (j.get("bright_spots") or [])[:5]:
                    if isinstance(s, str) and s.strip():
                        spots.append(s.strip()[:200])
            except Exception:
                pass
    if not spots:
        rev = kpis.get("revenue") or 0
        margin = kpis.get("gross_margin_pct") or 0
        cash = kpis.get("cash") or 0
        spots = [
            f"Booked ${rev:,.0f} in revenue for {period}.",
            f"Gross margin held at {margin:.1f}%.",
            f"Cash on hand ended at ${cash:,.0f}.",
        ]
    return [{
        "kind": "whats_going_well",
        "severity": "blue",
        "title": f"{len(spots)} bright spot{'s' if len(spots) != 1 else ''} in {period}",
        "detail": " · ".join(spots),
        "action_label": "Share with client",
        "action_route": f"/cockpit/communications?draft=bright-spots&period={period}",
        "count": len(spots),
        "meta": {"period": period, "bright_spots": spots},
    }]


async def _run_board_meeting_prep(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Board-meeting commentary. Wraps the advisor pack + adds LLM-generated
    talking points suitable for a board deck."""
    period = cfg.get("period") or _last_closed_or_current_ym()
    kpis = await _kpis_for_period(cid, period)
    if not kpis:
        return []
    # Ensure the advisor pack exists — if not, that's part of the finding.
    existing = await db.advisor_reports.find_one({"company_id": cid, "period": period})
    pack_note = ""
    if not existing:
        pack_note = " (Advisor pack not yet generated — enable Advisor Report Auto-Send.)"

    system = (
        "You are a fractional CFO prepping a founder for a board meeting. "
        "From the KPIs, produce 3-5 board-ready talking points. Each 1 "
        "sentence, business-owner voice, one concrete number, no jargon. "
        "Return JSON: {talking_points: [str, ...]}."
    )
    prompt = f"Period: {period}. KPIs: {kpis}. Return ONE JSON object."
    text = await _llm_ask(system, prompt, feature="agent-board-prep")
    points: list[str] = []
    if text:
        import json, re
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                j = json.loads(m.group(0))
                for s in (j.get("talking_points") or [])[:5]:
                    if isinstance(s, str) and s.strip():
                        points.append(s.strip()[:240])
            except Exception:
                pass
    if not points:
        rev = kpis.get("revenue") or 0
        rev_pct = kpis.get("revenue_pct_change") or 0
        net = kpis.get("net_income") or 0
        cash = kpis.get("cash") or 0
        points = [
            f"Revenue ${rev:,.0f}, {'up' if rev_pct >= 0 else 'down'} {abs(rev_pct):.1f}% vs prior period.",
            f"Net income landed at ${net:,.0f}.",
            f"Cash runway supported by ${cash:,.0f} on hand.",
        ]
    return [{
        "kind": "board_meeting_prep",
        "severity": "blue",
        "title": f"Board pack ready for {period}",
        "detail": (" · ".join(points)) + pack_note,
        "action_label": "Open Advisor Report",
        "action_route": "/cockpit/reports",
        "count": len(points),
        "meta": {"period": period, "talking_points": points, "advisor_pack_ready": bool(existing)},
    }]


# ---------------------------------------------------------------------------
# From-Scratch Custom Agents (Phase 5D)
# ---------------------------------------------------------------------------
# Firms can compose their own AI agents by picking a natural-language prompt
# and a list of data "tools" (bounded read-only slices of the client's book).
# The runner assembles the tool payload, hands the prompt+payload to the
# shared LLM wrapper, and expects a JSON finding back.  Never any writes,
# never any data outside the accessible company.

async def _tool_transactions_recent(cid: str, cfg: dict) -> dict:
    days = int(cfg.get("lookback_days") or 30)
    since = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    rows = await db.transactions.find(
        {"company_id": cid, "date": {"$gte": since}},
        {"_id": 0, "date": 1, "amount": 1, "description": 1, "account_id": 1, "vendor_id": 1},
    ).sort("date", -1).limit(100).to_list(100)
    return {"transactions_recent": rows, "count": len(rows), "since": since}


async def _tool_transactions_uncategorized(cid: str, cfg: dict) -> dict:
    rows = await db.transactions.find(
        {"company_id": cid,
         "$or": [{"account_id": {"$in": [None, ""]}}, {"needs_review": True}]},
        {"_id": 0, "date": 1, "amount": 1, "description": 1, "vendor_id": 1},
    ).sort("date", -1).limit(50).to_list(50)
    return {"uncategorized": rows, "count": len(rows)}


async def _tool_bills_open(cid: str, cfg: dict) -> dict:
    rows = await db.bills.find(
        {"company_id": cid, "status": {"$nin": ["paid", "void", "cancelled"]}},
        {"_id": 0, "date": 1, "amount": 1, "balance_due": 1, "contact_id": 1, "status": 1},
    ).sort("date", -1).limit(50).to_list(50)
    return {"open_bills": rows, "count": len(rows)}


async def _tool_invoices_open(cid: str, cfg: dict) -> dict:
    rows = await db.invoices.find(
        {"company_id": cid, "status": {"$nin": ["paid", "void", "cancelled"]}},
        {"_id": 0, "issue_date": 1, "due_date": 1, "total": 1, "balance_due": 1, "contact_id": 1, "status": 1},
    ).sort("issue_date", -1).limit(50).to_list(50)
    return {"open_invoices": rows, "count": len(rows)}


async def _tool_receipts_recent(cid: str, cfg: dict) -> dict:
    rows = await db.receipts.find(
        {"company_id": cid}, {"_id": 0, "date": 1, "amount": 1, "transaction_id": 1, "vendor_id": 1},
    ).sort("created_at", -1).limit(30).to_list(30)
    return {"receipts_recent": rows, "count": len(rows)}


async def _tool_journal_entries_recent(cid: str, cfg: dict) -> dict:
    rows = await db.journal_entries.find(
        {"company_id": cid, "posted": True},
        {"_id": 0, "date": 1, "memo": 1, "lines": 1, "kind": 1},
    ).sort("date", -1).limit(30).to_list(30)
    return {"journal_entries_recent": rows, "count": len(rows)}


async def _tool_income_statement(cid: str, cfg: dict) -> dict:
    from reports import compute_income_statement
    period = cfg.get("period") or _last_closed_or_current_ym()
    try:
        y, m = int(period[:4]), int(period[5:7])
        from calendar import monthrange
        start = f"{y:04d}-{m:02d}-01"
        end = f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
        data = await compute_income_statement(cid, start, end, "accrual")
    except Exception:
        data = {}
    return {"income_statement": data, "period": period}


async def _tool_balance_sheet(cid: str, cfg: dict) -> dict:
    from reports import compute_balance_sheet
    period = cfg.get("period") or _last_closed_or_current_ym()
    try:
        y, m = int(period[:4]), int(period[5:7])
        from calendar import monthrange
        as_of = f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
        data = await compute_balance_sheet(cid, as_of, "accrual")
    except Exception:
        data = {}
    return {"balance_sheet": data, "period": period}


TOOL_CATALOG: dict[str, dict] = {
    "transactions.recent": {
        "key": "transactions.recent",
        "label": "Recent transactions",
        "description": "Last 30 days (configurable) of bank feed activity.",
        "fetch": _tool_transactions_recent,
    },
    "transactions.uncategorized": {
        "key": "transactions.uncategorized",
        "label": "Uncategorized transactions",
        "description": "Anything without an account or flagged needs-review.",
        "fetch": _tool_transactions_uncategorized,
    },
    "bills.open": {
        "key": "bills.open",
        "label": "Open bills",
        "description": "Unpaid vendor bills.",
        "fetch": _tool_bills_open,
    },
    "invoices.open": {
        "key": "invoices.open",
        "label": "Open invoices",
        "description": "Unpaid customer invoices.",
        "fetch": _tool_invoices_open,
    },
    "receipts.recent": {
        "key": "receipts.recent",
        "label": "Recent receipts",
        "description": "Uploaded receipts (matched or unmatched).",
        "fetch": _tool_receipts_recent,
    },
    "journal_entries.recent": {
        "key": "journal_entries.recent",
        "label": "Recent journal entries",
        "description": "Last 30 posted journal entries.",
        "fetch": _tool_journal_entries_recent,
    },
    "reports.income_statement": {
        "key": "reports.income_statement",
        "label": "Income Statement (period)",
        "description": "P&L for the target period (accrual).",
        "fetch": _tool_income_statement,
    },
    "reports.balance_sheet": {
        "key": "reports.balance_sheet",
        "label": "Balance Sheet (period)",
        "description": "Balance Sheet as-of end of the target period.",
        "fetch": _tool_balance_sheet,
    },
}


async def _run_custom_agent(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Executor for `__custom__` template agents. Reads the agent's
    `custom_definition = {prompt, tools}`, fetches the tool payloads,
    calls the shared LLM, and parses one finding out of the JSON reply."""
    definition = agent.get("custom_definition") or {}
    prompt = (definition.get("prompt") or "").strip()
    tools: list[str] = list(definition.get("tools") or [])
    if not prompt or not tools:
        return []

    payload: dict = {}
    for key in tools:
        tool = TOOL_CATALOG.get(key)
        if not tool:
            continue
        try:
            payload[key] = await tool["fetch"](cid, cfg)
        except Exception as exc:  # noqa: BLE001
            payload[key] = {"error": f"{type(exc).__name__}: {exc}"}

    system = (
        "You are a custom AI agent authored by an accounting firm to watch a "
        "client's books. Use ONLY the data provided in the user message. "
        "Return ONE JSON object with keys: title (<=90 chars), detail (<=350 "
        "chars), severity (one of red|amber|blue), action_label (<=24 chars), "
        "action_route (starts with /accounting or /cockpit). If nothing is "
        "worth flagging, return {\"skip\": true}."
    )
    import json as _json
    user_msg = f"AGENT INSTRUCTIONS:\n{prompt}\n\nDATA:\n{_json.dumps(payload, default=str)[:8000]}"
    text = await _llm_ask(system, user_msg, feature="agent-custom")
    if not text:
        return []
    import re
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return []
    try:
        parsed = _json.loads(m.group(0))
    except Exception:
        return []
    if parsed.get("skip"):
        return []
    title = str(parsed.get("title") or "").strip()[:90]
    detail = str(parsed.get("detail") or "").strip()[:350]
    severity = parsed.get("severity") or "blue"
    if severity not in {"red", "amber", "blue"}:
        severity = "blue"
    action_label = str(parsed.get("action_label") or "Review")[:24]
    action_route = str(parsed.get("action_route") or "/cockpit/agents")
    if not action_route.startswith(("/accounting", "/cockpit")):
        action_route = "/cockpit/agents"
    if not title:
        return []
    return [{
        "kind": "custom_agent",
        "severity": severity,
        "title": title,
        "detail": detail,
        "action_label": action_label,
        "action_route": action_route,
        "count": 1,
        "meta": {"tools": tools},
    }]


async def _run_contact_pairing_auditor(cid: str, agent: dict, cfg: dict) -> list[dict]:
    """Post-hoc second-opinion review of AI-assigned `contact_id` values on
    recent transactions. Independent of the ingestion-time resolver
    (`contact_resolver.py`) — this pass is LLM-first (Claude Haiku 4.5),
    batched at 10 txns per call, and flag-only by default.

    Config knobs:
      • `max_txns_per_run` (int, default 200)
      • `lookback_days` (int, default 30)
      • `auto_apply` (bool, default False) — when True, findings with
        confidence >= `auto_apply_threshold` are applied immediately.
        Every application records `prev_contact_id` on the txn for
        one-tap undo.
      • `auto_apply_threshold` (float, default 0.90)
    """
    from contact_auditor import run_audit
    try:
        return await run_audit(cid, cfg)
    except Exception as exc:  # noqa: BLE001
        # Never bring down a scheduled run because the auditor blew up.
        return [{
            "kind": "contact_mismatch",
            "severity": "amber",
            "title": "Contact auditor errored",
            "detail": f"{type(exc).__name__}: {exc}",
            "action_label": "Open Agents",
            "action_route": "/cockpit/agents",
            "count": 1,
        }]


_TEMPLATES: dict[str, dict] = {
    "cleanup_sweep": {
        "key": "cleanup_sweep",
        "name": "Cleanup Sweep",
        "description": "Detects uncategorized and needs-review transactions and posts them to Today.",
        "icon": "Sparkles",
        "category": "Transactions",
        "default_schedule": "daily",
        "default_config": {"min_uncategorized": 1},
        "config_fields": [
            {"key": "min_uncategorized", "label": "Minimum txns to trigger", "type": "number", "default": 1},
        ],
        "scope": "per_company",
        "run": _run_cleanup_sweep,
    },
    "je_auto_drafter": {
        "key": "je_auto_drafter",
        "name": "JE Auto-Drafter",
        "description": "Scans prepaid amortization and recurring accruals; queues JE drafts for review.",
        "icon": "FileEdit",
        "category": "Close",
        "default_schedule": "monthly",
        "default_config": {"kinds": ["prepaid_amort", "accrual"]},
        "config_fields": [
            {"key": "kinds", "label": "Drafter kinds", "type": "multiselect",
             "options": [
                {"value": "prepaid_amort", "label": "Prepaid amortization"},
                {"value": "accrual", "label": "Recurring accruals"},
             ], "default": ["prepaid_amort", "accrual"]},
        ],
        "scope": "per_company",
        "run": _run_je_auto_drafter,
    },
    "advisor_report_send": {
        "key": "advisor_report_send",
        "name": "Advisor Report Auto-Send",
        "description": "Ensures every closed period has an advisor pack generated and delivered to the client.",
        "icon": "FileBarChart2",
        "category": "Advisory",
        "default_schedule": "monthly",
        "default_config": {},
        "config_fields": [],
        "scope": "per_company",
        "run": _run_advisor_report_send,
    },
    "tax_1099_watcher": {
        "key": "tax_1099_watcher",
        "name": "1099 Threshold Watcher",
        "description": "Watches vendor spend and warns as vendors approach the $600 IRS threshold.",
        "icon": "Receipt",
        "category": "Compliance",
        "default_schedule": "quarterly",
        "default_config": {"threshold": 600.0, "warn_at": 500.0},
        "config_fields": [
            {"key": "threshold", "label": "1099 threshold ($)", "type": "number", "default": 600.0},
            {"key": "warn_at", "label": "Early warning at ($)", "type": "number", "default": 500.0},
        ],
        "scope": "per_company",
        "run": _run_tax_1099_watcher,
    },
    "portal_chase": {
        "key": "portal_chase",
        "name": "Portal Chase",
        "description": "Nudges stale client-portal questions after a configurable number of days.",
        "icon": "MessageSquare",
        "category": "Close",
        "default_schedule": "daily",
        "default_config": {"stale_days": 3},
        "config_fields": [
            {"key": "stale_days", "label": "Days before stale", "type": "number", "default": 3},
        ],
        "scope": "per_company",
        "run": _run_portal_chase,
    },
    "signoff_reminder": {
        "key": "signoff_reminder",
        "name": "Sign-off Reminder",
        "description": "Reminds clients who haven't approved their monthly close after a configurable number of days.",
        "icon": "BellRing",
        "category": "Close",
        "default_schedule": "daily",
        "default_config": {"stale_days": 3},
        "config_fields": [
            {"key": "stale_days", "label": "Days before reminder", "type": "number", "default": 3},
        ],
        "scope": "per_company",
        "run": _run_signoff_reminder,
    },
    "txn_vendor_inconsistencies": {
        "key": "txn_vendor_inconsistencies",
        "name": "Vendor Inconsistencies",
        "description": "Flags category drift and outlier amounts per vendor across a rolling window.",
        "icon": "AlertTriangle",
        "category": "Transactions",
        "default_schedule": "weekly",
        "default_config": {"lookback_days": 90},
        "config_fields": [
            {"key": "lookback_days", "label": "Lookback window (days)", "type": "number", "default": 90},
        ],
        "scope": "per_company",
        "run": _run_txn_vendor_inconsistencies,
    },
    "first_time_large_txn": {
        "key": "first_time_large_txn",
        "name": "First-Time / Large Transactions",
        "description": "Flags large charges from brand-new vendors and 3x jumps in an existing vendor's typical amount.",
        "icon": "TrendingUp",
        "category": "Transactions",
        "default_schedule": "daily",
        "default_config": {"lookback_days": 30, "min_amount": 500.0},
        "config_fields": [
            {"key": "lookback_days", "label": "Lookback window (days)", "type": "number", "default": 30},
            {"key": "min_amount", "label": "Minimum amount ($)", "type": "number", "default": 500.0},
        ],
        "scope": "per_company",
        "run": _run_first_time_large_txn,
    },
    "internal_transfers": {
        "key": "internal_transfers",
        "name": "Internal Money Transfers",
        "description": "Reviews unlinked or misclassified internal money transfers between the client's own accounts.",
        "icon": "ArrowLeftRight",
        "category": "Transactions",
        "default_schedule": "weekly",
        "default_config": {"lookback_days": 60},
        "config_fields": [
            {"key": "lookback_days", "label": "Lookback window (days)", "type": "number", "default": 60},
        ],
        "scope": "per_company",
        "run": _run_internal_transfers,
    },
    "match_unpaid_bills": {
        "key": "match_unpaid_bills",
        "name": "Match Unpaid Bills → Payments",
        "description": "Finds open bills and proposes matching vendor payments already sitting in the bank feed.",
        "icon": "Landmark",
        "category": "Accounts Payable",
        "default_schedule": "daily",
        "default_config": {"tolerance_days": 5, "tolerance_amount": 1.0},
        "config_fields": [
            {"key": "tolerance_days", "label": "Date tolerance (± days)", "type": "number", "default": 5},
            {"key": "tolerance_amount", "label": "Amount tolerance ($)", "type": "number", "default": 1.0},
        ],
        "scope": "per_company",
        "run": _run_match_unpaid_bills,
    },
    "match_unpaid_invoices": {
        "key": "match_unpaid_invoices",
        "name": "Match Unpaid Invoices → Payments",
        "description": "Finds open invoices and proposes matching customer deposits already in the bank feed.",
        "icon": "Banknote",
        "category": "Accounts Receivable",
        "default_schedule": "daily",
        "default_config": {"tolerance_days": 5, "tolerance_amount": 1.0},
        "config_fields": [
            {"key": "tolerance_days", "label": "Date tolerance (± days)", "type": "number", "default": 5},
            {"key": "tolerance_amount", "label": "Amount tolerance ($)", "type": "number", "default": 1.0},
        ],
        "scope": "per_company",
        "run": _run_match_unpaid_invoices,
    },
    "missing_receipts": {
        "key": "missing_receipts",
        "name": "Missing Receipts",
        "description": "Finds transactions over a threshold with no receipt attached.",
        "icon": "ReceiptText",
        "category": "Receipts",
        "default_schedule": "weekly",
        "default_config": {"min_amount": 75.0, "lookback_days": 60},
        "config_fields": [
            {"key": "min_amount", "label": "Minimum amount ($)", "type": "number", "default": 75.0},
            {"key": "lookback_days", "label": "Lookback window (days)", "type": "number", "default": 60},
        ],
        "scope": "per_company",
        "run": _run_missing_receipts,
    },
    "variance_analysis": {
        "key": "variance_analysis",
        "name": "Variance (Flux) Analysis",
        "description": "Compares current-period P&L to prior period; flags any account moving more than X% AND $Y.",
        "icon": "Activity",
        "category": "Advisory",
        "default_schedule": "monthly",
        "default_config": {"pct_threshold": 5.0, "dollar_threshold": 1000.0},
        "config_fields": [
            {"key": "pct_threshold", "label": "Percent threshold (%)", "type": "number", "default": 5.0},
            {"key": "dollar_threshold", "label": "Dollar threshold ($)", "type": "number", "default": 1000.0},
        ],
        "scope": "per_company",
        "run": _run_variance_analysis,
    },
    "profit_margin_analysis": {
        "key": "profit_margin_analysis",
        "name": "Profit Margin Analysis",
        "description": "Ranks classes / segments by gross margin; flags large spreads between top and bottom.",
        "icon": "PieChart",
        "category": "Advisory",
        "default_schedule": "monthly",
        "default_config": {"min_spread_pct": 20.0},
        "config_fields": [
            {"key": "min_spread_pct", "label": "Minimum spread to flag (%)", "type": "number", "default": 20.0},
        ],
        "scope": "per_company",
        "run": _run_profit_margin_analysis,
    },
    "pdf_txn_import_watcher": {
        "key": "pdf_txn_import_watcher",
        "name": "PDF Statement Watcher",
        "description": "Detects bank statement uploads still stuck in OCR / processing.",
        "icon": "FileWarning",
        "category": "Transactions",
        "default_schedule": "hourly",
        "default_config": {"stale_hours": 24},
        "config_fields": [
            {"key": "stale_hours", "label": "Stale after (hours)", "type": "number", "default": 24},
        ],
        "scope": "per_company",
        "run": _run_pdf_txn_import_watcher,
    },
    "receipt_capture_watcher": {
        "key": "receipt_capture_watcher",
        "name": "Receipt Capture Watcher",
        "description": "Detects uploaded receipts that never matched to a transaction.",
        "icon": "ScanLine",
        "category": "Receipts",
        "default_schedule": "hourly",
        "default_config": {"stale_hours": 24},
        "config_fields": [
            {"key": "stale_hours", "label": "Stale after (hours)", "type": "number", "default": 24},
        ],
        "scope": "per_company",
        "run": _run_receipt_capture_watcher,
    },
    "key_business_insight": {
        "key": "key_business_insight",
        "name": "Find a Key Business Insight",
        "description": "AI surfaces one high-value insight from the period's KPIs and drafts a client-facing email you can send in one click.",
        "icon": "Lightbulb",
        "category": "Insights",
        "default_schedule": "monthly",
        "default_config": {},
        "config_fields": [
            {"key": "period", "label": "Period (YYYY-MM, blank = last closed)", "type": "number", "default": ""},
        ],
        "scope": "per_company",
        "run": _run_key_business_insight,
    },
    "whats_going_well": {
        "key": "whats_going_well",
        "name": "What's Going Well?",
        "description": "5 positive-framed bright spots you can share with the client — each with a specific number and no jargon.",
        "icon": "Sparkles",
        "category": "Insights",
        "default_schedule": "monthly",
        "default_config": {},
        "config_fields": [],
        "scope": "per_company",
        "run": _run_whats_going_well,
    },
    "board_meeting_prep": {
        "key": "board_meeting_prep",
        "name": "Board Meeting Prep",
        "description": "3-5 board-ready talking points a founder can walk into their next meeting with; complements the Advisor Report pack.",
        "icon": "Presentation",
        "category": "Insights",
        "default_schedule": "monthly",
        "default_config": {},
        "config_fields": [],
        "scope": "per_company",
        "run": _run_board_meeting_prep,
    },
    "__custom__": {
        "key": "__custom__",
        "name": "Custom Agent",
        "description": "Firm-authored agent — prompt + tool allowlist, powered by LLM.",
        "icon": "Bot",
        "category": "Custom",
        "default_schedule": "daily",
        "default_config": {},
        "config_fields": [],
        "scope": "per_company",
        "run": _run_custom_agent,
        "hidden": True,  # not shown in the template library
        "cost_cents": 2.0,
    },
    "contact_pairing_auditor": {
        "key": "contact_pairing_auditor",
        "name": "Contact Pairing Auditor",
        "description": (
            "Post-hoc second-opinion review of AI-assigned contacts on recent "
            "transactions. Catches misfires like a Credit One payment tagged "
            "to the accountholder instead of Credit One Bank."
        ),
        "icon": "ShieldCheck",
        "category": "Transactions",
        "default_schedule": "weekly",
        "default_config": {
            "max_txns_per_run": 200,
            "lookback_days": 30,
            "auto_apply": False,
            "auto_apply_threshold": 0.90,
        },
        "config_fields": [
            {"key": "max_txns_per_run", "label": "Max txns per run",
             "type": "number", "default": 200},
            {"key": "lookback_days", "label": "Lookback window (days)",
             "type": "number", "default": 30},
            {"key": "auto_apply", "label": "Auto-apply high-confidence fixes",
             "type": "boolean", "default": False},
            {"key": "auto_apply_threshold",
             "label": "Auto-apply confidence threshold (0-1)",
             "type": "number", "default": 0.90},
        ],
        "scope": "per_company",
        "run": _run_contact_pairing_auditor,
        "cost_cents": 2.0,
    },
}

_SCHEDULE_INTERVALS: dict[str, timedelta] = {
    "hourly":    timedelta(hours=1),
    "daily":     timedelta(days=1),
    "weekly":    timedelta(days=7),
    "monthly":   timedelta(days=30),
    "quarterly": timedelta(days=90),
}

# ---------------------------------------------------------------------------
# Cost model (Phase 5C)
# ---------------------------------------------------------------------------
# Every run gets a `cost_cents` stamp so the analytics dashboard can roll up
# per-firm spend. We keep the model deliberately simple:
#   • Deterministic detectors (Mongo aggregations, no LLM) → 0.2¢ / run
#   • LLM-powered templates                               → 2.0¢ / run  (real
#     token cost is captured in the shared ai_usage counter — we surface a
#     flat estimate here so the UI has a value even when the LLM path
#     returns a fallback)
# Override per template via `cost_cents` in the template dict.
_LLM_TEMPLATE_KEYS = {
    "key_business_insight", "whats_going_well", "board_meeting_prep",
    "contact_pairing_auditor",
}
_DEFAULT_COST_CENTS = 0.2
_LLM_COST_CENTS = 2.0


def _template_cost_cents(template_key: str) -> float:
    t = _TEMPLATES.get(template_key) or {}
    if "cost_cents" in t:
        return float(t["cost_cents"])
    if template_key in _LLM_TEMPLATE_KEYS:
        return _LLM_COST_CENTS
    return _DEFAULT_COST_CENTS


def _last_closed_or_current_ym() -> str:
    """Prior month YYYY-MM — books-lag heuristic used across Cockpit."""
    now = datetime.now(timezone.utc)
    if now.month == 1:
        return f"{now.year - 1:04d}-12"
    return f"{now.year:04d}-{now.month - 1:02d}"


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def _run_agent(agent: dict, triggered_by: str = "schedule") -> dict:
    """Execute one agent and persist a run + findings. Idempotent per
    (agent_id, triggered_by) — we always create a new run doc."""
    template = _TEMPLATES.get(agent.get("template_key"))
    if not template:
        return {"ok": False, "error": "unknown-template"}

    run_id = str(uuid.uuid4())
    started_at = now_iso()
    await db.agent_runs.insert_one({
        "id": run_id, "agent_id": agent["id"], "company_id": agent.get("company_id"),
        "template_key": agent["template_key"],
        "status": "running", "triggered_by": triggered_by,
        "started_at": started_at, "finished_at": None,
        "findings_count": 0, "error": None,
        "cost_cents": _template_cost_cents(agent["template_key"]),
    })

    cfg = {**(template.get("default_config") or {}), **(agent.get("config") or {})}
    cid = agent.get("company_id")

    findings: list[dict] = []
    error_msg: Optional[str] = None
    try:
        raw = await template["run"](cid, agent, cfg)
        for f in (raw or []):
            findings.append({
                "id": str(uuid.uuid4()),
                "agent_id": agent["id"],
                "run_id": run_id,
                "company_id": cid,
                "template_key": agent["template_key"],
                "kind": f.get("kind") or agent["template_key"],
                "severity": f.get("severity") or "blue",
                "title": f.get("title") or "Agent finding",
                "detail": f.get("detail") or "",
                "action_label": f.get("action_label"),
                "action_route": f.get("action_route"),
                "count": f.get("count") or 1,
                "meta": f.get("meta") or {},
                "status": "open",
                "created_at": now_iso(),
            })
    except Exception as exc:  # noqa: BLE001
        error_msg = f"{type(exc).__name__}: {exc}"

    if findings:
        await db.agent_findings.insert_many(findings)

    await db.agent_runs.update_one(
        {"id": run_id},
        {"$set": {
            "status": "failed" if error_msg else "success",
            "finished_at": now_iso(),
            "findings_count": len(findings),
            "error": error_msg,
        }},
    )
    await db.agents.update_one(
        {"id": agent["id"]},
        {"$set": {
            "last_run_at": now_iso(),
            "last_run_status": "failed" if error_msg else "success",
            "last_findings_count": len(findings),
        }},
    )
    return {
        "ok": not bool(error_msg), "run_id": run_id,
        "findings_count": len(findings), "error": error_msg,
    }


async def _due(agent: dict) -> bool:
    if not agent.get("enabled"):
        return False
    schedule = agent.get("schedule") or "daily"
    interval = _SCHEDULE_INTERVALS.get(schedule, timedelta(days=1))
    last = agent.get("last_run_at")
    if not last:
        return True
    try:
        d = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except Exception:
        return True
    return (datetime.now(timezone.utc) - d) >= interval


async def tick_due_agents(company_ids: list[str], *, background: BackgroundTasks | None = None) -> int:
    """Run every enabled agent whose next-run time has elapsed. Returns
    the number of runs enqueued.  Call from any Cockpit endpoint that a
    firm user hits.  Idempotent: an already-running agent will still get
    a new run, but the templates are safe to re-run (no double-writes).
    """
    if not company_ids:
        return 0
    cursor = db.agents.find({
        "enabled": True,
        "$or": [
            {"company_id": {"$in": company_ids}},
            {"company_id": None},  # firm-wide agents
        ],
    })
    agents = await cursor.to_list(500)
    launched = 0
    for a in agents:
        if not await _due(a):
            continue
        if background is not None:
            background.add_task(_run_agent, a, "schedule")
        else:
            # sync path used only in tests
            await _run_agent(a, "schedule")
        launched += 1
    return launched


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AgentCreateIn(BaseModel):
    template_key: str
    company_id: Optional[str] = None
    name: Optional[str] = None
    schedule: Optional[str] = None
    config: Optional[dict] = Field(default_factory=dict)
    enabled: bool = True


class AgentPatchIn(BaseModel):
    name: Optional[str] = None
    schedule: Optional[str] = None
    config: Optional[dict] = None
    enabled: Optional[bool] = None


class FindingPatchIn(BaseModel):
    status: str  # "open" | "resolved" | "dismissed"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/agents/templates")
async def list_templates(user: dict = Depends(get_current_user)):
    await require_firm_or_pro(user)
    out = []
    for t in _TEMPLATES.values():
        if t.get("hidden"):
            continue
        out.append({k: v for k, v in t.items() if k != "run"})
    return {"templates": out}


@router.get("/agents/tools")
async def list_agent_tools(user: dict = Depends(get_current_user)):
    """Catalog of data slices a custom agent can consume. Read-only."""
    await require_firm_or_pro(user)
    out = []
    for t in TOOL_CATALOG.values():
        out.append({"key": t["key"], "label": t["label"], "description": t["description"]})
    return {"tools": out}


class CustomAgentIn(BaseModel):
    name: str
    description: Optional[str] = ""
    company_id: Optional[str] = None
    prompt: str
    tools: list[str]
    schedule: str = "daily"
    enabled: bool = True


@router.post("/agents/custom")
async def create_custom_agent(inp: CustomAgentIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    if inp.company_id and inp.company_id not in accessible:
        raise HTTPException(403, "You don't have access to that company.")
    if not inp.prompt.strip():
        raise HTTPException(400, "Prompt is required.")
    if not inp.tools:
        raise HTTPException(400, "Select at least one tool.")
    unknown = [t for t in inp.tools if t not in TOOL_CATALOG]
    if unknown:
        raise HTTPException(400, f"Unknown tools: {unknown}")
    agent = {
        "id": str(uuid.uuid4()),
        "template_key": "__custom__",
        "name": inp.name.strip() or "Custom agent",
        "description": inp.description or "",
        "company_id": inp.company_id,
        "schedule": inp.schedule,
        "config": {},
        "custom_definition": {"prompt": inp.prompt, "tools": inp.tools},
        "enabled": inp.enabled,
        "is_custom": True,
        "created_by": user.get("email") or user.get("id"),
        "created_at": now_iso(),
        "last_run_at": None,
        "last_run_status": None,
        "last_findings_count": 0,
    }
    await db.agents.insert_one(agent)
    return {"agent": coerce(agent)}


@router.get("/agents")
async def list_agents(
    background: BackgroundTasks,
    company_id: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"agents": [], "counts": {}}
    q: dict = {"$or": [
        {"company_id": {"$in": accessible}},
        {"company_id": None},
    ]}
    if company_id:
        q = {"company_id": company_id}
    docs = await db.agents.find(q).sort("created_at", -1).limit(500).to_list(500)
    # Wake-on-request scheduler tick.
    await tick_due_agents(accessible, background=background)
    agents = [coerce(d) for d in docs]
    counts = {
        "total": len(agents),
        "enabled": sum(1 for a in agents if a.get("enabled")),
        "disabled": sum(1 for a in agents if not a.get("enabled")),
    }
    return {"agents": agents, "counts": counts}


@router.post("/agents")
async def create_agent(inp: AgentCreateIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    template = _TEMPLATES.get(inp.template_key)
    if not template:
        raise HTTPException(400, f"Unknown template: {inp.template_key}")
    if inp.company_id and inp.company_id not in accessible:
        raise HTTPException(403, "You don't have access to that company.")
    agent = {
        "id": str(uuid.uuid4()),
        "template_key": inp.template_key,
        "name": inp.name or template["name"],
        "company_id": inp.company_id,
        "schedule": inp.schedule or template["default_schedule"],
        "config": {**(template.get("default_config") or {}), **(inp.config or {})},
        "enabled": inp.enabled,
        "created_by": user.get("email") or user.get("id"),
        "created_at": now_iso(),
        "last_run_at": None,
        "last_run_status": None,
        "last_findings_count": 0,
    }
    await db.agents.insert_one(agent)
    return {"agent": coerce(agent)}


@router.patch("/agents/{agent_id}")
async def patch_agent(agent_id: str, inp: AgentPatchIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        raise HTTPException(404, "Agent not found.")
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    update: dict = {}
    if inp.name is not None:      update["name"] = inp.name
    if inp.schedule is not None:  update["schedule"] = inp.schedule
    if inp.config is not None:    update["config"] = inp.config
    if inp.enabled is not None:   update["enabled"] = inp.enabled
    if update:
        await db.agents.update_one({"id": agent_id}, {"$set": update})
    return {"agent": coerce(await db.agents.find_one({"id": agent_id}))}


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        return {"ok": True}
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    await db.agents.delete_one({"id": agent_id})
    await db.agent_findings.delete_many({"agent_id": agent_id})
    await db.agent_runs.delete_many({"agent_id": agent_id})
    return {"ok": True}


@router.post("/agents/{agent_id}/run-now")
async def run_now(agent_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        raise HTTPException(404, "Agent not found.")
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    result = await _run_agent(agent, triggered_by=f"manual:{user.get('email') or user.get('id')}")
    return result


class RunOnceIn(BaseModel):
    template_key: str
    company_id: Optional[str] = None
    config: Optional[dict] = Field(default_factory=dict)


@router.post("/agents/run-once")
async def run_once(inp: RunOnceIn, user: dict = Depends(get_current_user)):
    """Fire a template on-demand without persisting an agent doc.  The
    run + findings are still saved so results roll up into Today. Useful
    for CPAs kicking the tires before scheduling."""
    accessible = await require_firm_or_pro(user)
    template = _TEMPLATES.get(inp.template_key)
    if not template:
        raise HTTPException(400, f"Unknown template: {inp.template_key}")
    if inp.company_id and inp.company_id not in accessible:
        raise HTTPException(403, "You don't have access to that company.")
    # Synthetic (unpersisted) agent — _run_agent's final agents.update_one
    # is a no-op when no doc exists.
    synthetic = {
        "id": f"one-shot-{uuid.uuid4().hex}",
        "template_key": inp.template_key,
        "name": f"{template['name']} (one-shot)",
        "company_id": inp.company_id,
        "schedule": template.get("default_schedule") or "daily",
        "config": {**(template.get("default_config") or {}), **(inp.config or {})},
        "enabled": False,
        "one_shot": True,
    }
    result = await _run_agent(
        synthetic,
        triggered_by=f"run-once:{user.get('email') or user.get('id')}",
    )
    return {**result, "template_key": inp.template_key, "agent_id": synthetic["id"]}


@router.get("/agents/{agent_id}/runs")
async def list_runs(agent_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    agent = await db.agents.find_one({"id": agent_id})
    if not agent:
        raise HTTPException(404, "Agent not found.")
    if agent.get("company_id") and agent["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    docs = await db.agent_runs.find({"agent_id": agent_id}).sort("started_at", -1).limit(50).to_list(50)
    return {"runs": [coerce(d) for d in docs]}


@router.get("/agent-runs/{run_id}")
async def run_detail(run_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    run = await db.agent_runs.find_one({"id": run_id})
    if not run:
        raise HTTPException(404, "Run not found.")
    if run.get("company_id") and run["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    findings = await db.agent_findings.find({"run_id": run_id}).to_list(500)
    return {"run": coerce(run), "findings": [coerce(f) for f in findings]}


@router.get("/agent-findings")
async def list_findings(
    company_id: Optional[str] = Query(None),
    status: str = Query("open"),
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"findings": []}
    q: dict = {"status": status} if status and status != "all" else {}
    q["$or"] = [
        {"company_id": {"$in": accessible}},
        {"company_id": None},
    ]
    if company_id:
        q = {"company_id": company_id}
        if status and status != "all":
            q["status"] = status
    docs = await db.agent_findings.find(q).sort("created_at", -1).limit(limit).to_list(limit)
    return {"findings": [coerce(d) for d in docs]}


@router.patch("/agent-findings/{finding_id}")
async def patch_finding(finding_id: str, inp: FindingPatchIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    f = await db.agent_findings.find_one({"id": finding_id})
    if not f:
        raise HTTPException(404, "Finding not found.")
    if f.get("company_id") and f["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    if inp.status not in {"open", "resolved", "dismissed"}:
        raise HTTPException(400, "Invalid status.")
    await db.agent_findings.update_one(
        {"id": finding_id},
        {"$set": {"status": inp.status, "resolved_at": now_iso() if inp.status != "open" else None,
                  "resolved_by": user.get("email") or user.get("id") if inp.status != "open" else None}},
    )
    return {"ok": True}


@router.post("/agent-findings/{finding_id}/apply-contact-fix")
async def apply_contact_fix(finding_id: str, user: dict = Depends(get_current_user)):
    """Apply a `contact_mismatch` finding flagged (not auto-applied) by the
    Contact Pairing Auditor. Reassigns the txn to the proposed contact
    (creating it if the LLM had proposed `create_new` and the shortlist
    dedup didn't already do so). Records `prev_contact_id` on the txn so
    the same endpoint's `undo` counterpart can revert."""
    accessible = await require_firm_or_pro(user)
    f = await db.agent_findings.find_one({"id": finding_id})
    if not f:
        raise HTTPException(404, "Finding not found.")
    if f.get("company_id") and f["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    if f.get("kind") != "contact_mismatch":
        raise HTTPException(400, "Not a contact_mismatch finding.")
    meta = f.get("meta") or {}
    if meta.get("applied"):
        raise HTTPException(400, "Already applied.")
    if (meta.get("verdict") or "") != "wrong":
        raise HTTPException(400, "Only 'wrong'-verdict findings can be applied.")

    cid = f["company_id"]
    txn_id = meta.get("txn_id")
    proposed_id = meta.get("proposed_contact_id")
    proposed_name = meta.get("proposed_contact_name") or ""
    would_create = bool(meta.get("would_create_new"))

    if not (txn_id and cid):
        raise HTTPException(400, "Finding is missing txn_id / company_id.")

    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found.")

    # Resolve target contact — reuse the auditor's layered helper so a
    # newly-created contact goes through the same normalize + upsert path.
    if would_create and not proposed_id:
        from contact_auditor import _resolve_or_create_contact
        proposed_id = await _resolve_or_create_contact(
            cid, proposed_name, None, False, {},
        )
    if not proposed_id:
        raise HTTPException(400, "No proposed contact to apply.")

    prev_contact_id = txn.get("contact_id")
    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid},
        {"$set": {
            "contact_id": proposed_id,
            "prev_contact_id": prev_contact_id,
            "contact_audit_status": "manually_applied",
            "contact_audit_at": now_iso(),
            "ai_source": "contact_auditor",
            "updated_at": now_iso(),
        }},
    )
    await db.agent_findings.update_one(
        {"id": finding_id},
        {"$set": {
            "status": "resolved",
            "resolved_at": now_iso(),
            "resolved_by": user.get("email") or user.get("id"),
            "meta.applied": True,
            "meta.applied_by": "manual",
            "meta.new_contact_id": proposed_id,
            "meta.prev_contact_id": prev_contact_id,
        }},
    )
    return {"ok": True, "new_contact_id": proposed_id, "prev_contact_id": prev_contact_id}


@router.post("/agent-findings/{finding_id}/undo-contact-fix")
async def undo_contact_fix(finding_id: str, user: dict = Depends(get_current_user)):
    """Revert a `contact_mismatch` finding that was applied — either
    auto-applied by the Contact Pairing Auditor at high confidence or
    manually via `apply-contact-fix`. Restores `contact_id` from
    `prev_contact_id` on the txn."""
    accessible = await require_firm_or_pro(user)
    f = await db.agent_findings.find_one({"id": finding_id})
    if not f:
        raise HTTPException(404, "Finding not found.")
    if f.get("company_id") and f["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    if f.get("kind") != "contact_mismatch":
        raise HTTPException(400, "Not a contact_mismatch finding.")
    meta = f.get("meta") or {}
    if not meta.get("applied"):
        raise HTTPException(400, "Not applied — nothing to undo.")

    cid = f["company_id"]
    txn_id = meta.get("txn_id")
    prev_id = meta.get("prev_contact_id")

    if not (txn_id and cid):
        raise HTTPException(400, "Finding is missing txn_id / company_id.")

    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found.")

    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid},
        {"$set": {
            "contact_id": prev_id,
            "prev_contact_id": None,
            "contact_audit_status": "reverted",
            "contact_audit_at": now_iso(),
            "updated_at": now_iso(),
        }},
    )
    await db.agent_findings.update_one(
        {"id": finding_id},
        {"$set": {
            "status": "dismissed",
            "resolved_at": now_iso(),
            "resolved_by": user.get("email") or user.get("id"),
            "meta.applied": False,
            "meta.reverted": True,
        }},
    )
    return {"ok": True, "restored_contact_id": prev_id}


@router.post("/agent-findings/prune-same-entity")
async def prune_same_entity_findings(user: dict = Depends(get_current_user)):
    """One-shot cleanup: closes any OPEN `contact_mismatch` findings where
    the current and proposed contact names now refer to the same real-world
    entity under the auditor's refined same-entity filter (short form vs.
    long form: "Raley's" ⟷ "Raley's Supermarket", "76" ⟷ "76 Gas Stations",
    etc). Bounded to the caller's accessible companies. Idempotent."""
    from contact_auditor import _names_refer_to_same_entity
    accessible = await require_firm_or_pro(user)
    pruned: list[dict] = []
    async for f in db.agent_findings.find({
        "kind": "contact_mismatch",
        "status": "open",
        "company_id": {"$in": list(accessible)},
    }):
        meta = f.get("meta") or {}
        current = meta.get("current_contact_name") or ""
        proposed = meta.get("proposed_contact_name") or ""
        if current and proposed and _names_refer_to_same_entity(current, proposed):
            await db.agent_findings.update_one(
                {"id": f["id"]},
                {"$set": {
                    "status": "dismissed",
                    "resolved_at": now_iso(),
                    "resolved_by": user.get("email") or user.get("id"),
                    "dismissed_reason": "same_entity_refined_filter",
                }},
            )
            pruned.append({
                "id": f["id"],
                "current": current,
                "proposed": proposed,
                "company_id": f.get("company_id"),
            })
    return {"pruned_count": len(pruned), "pruned": pruned}





# =============================================================================
# Phase 5B — Runbooks (ordered agent chains with pass/fail gating)
# =============================================================================
# A **runbook** is a named ordered sequence of template invocations that runs
# against one company (or firm-wide) on a schedule.  Each step declares an
# `on_fail` policy ("stop" halts the chain, "continue" logs the error and
# proceeds).  Ship default: "End of Month" chains Cleanup → JE Drafter →
# Advisor Report Send → Sign-off Reminder.
# =============================================================================

DEFAULT_RUNBOOK_TEMPLATES: list[dict] = [
    {
        "key": "end_of_month",
        "name": "End of Month",
        "description": (
            "Full close cadence in one click: sweep uncategorized txns → auto-draft "
            "prepaid amort + accruals → generate & send the advisor pack → chase the "
            "client's sign-off. Each step is gated; a failure earlier halts the chain."
        ),
        "default_schedule": "monthly",
        "steps": [
            {"template_key": "cleanup_sweep",       "config": {}, "on_fail": "stop"},
            {"template_key": "je_auto_drafter",     "config": {}, "on_fail": "stop"},
            {"template_key": "advisor_report_send", "config": {}, "on_fail": "continue"},
            {"template_key": "signoff_reminder",    "config": {}, "on_fail": "continue"},
        ],
    },
    {
        "key": "weekly_health_check",
        "name": "Weekly Health Check",
        "description": (
            "Every Monday: sweep new uncategorized txns, look for vendor drift, and flag "
            "any large first-time charges. Non-gated so all three always run."
        ),
        "default_schedule": "weekly",
        "steps": [
            {"template_key": "cleanup_sweep",              "config": {}, "on_fail": "continue"},
            {"template_key": "txn_vendor_inconsistencies", "config": {}, "on_fail": "continue"},
            {"template_key": "first_time_large_txn",       "config": {}, "on_fail": "continue"},
        ],
    },
    {
        "key": "board_prep",
        "name": "Board Meeting Prep",
        "description": (
            "The full advisor storyline for a founder: bright spots → key insight → "
            "board-ready talking points. Uses AI narrative on top of the period's KPIs."
        ),
        "default_schedule": "monthly",
        "steps": [
            {"template_key": "whats_going_well",     "config": {}, "on_fail": "continue"},
            {"template_key": "key_business_insight", "config": {}, "on_fail": "continue"},
            {"template_key": "board_meeting_prep",  "config": {}, "on_fail": "continue"},
        ],
    },
]


class RunbookStepIn(BaseModel):
    template_key: str
    config: Optional[dict] = Field(default_factory=dict)
    on_fail: str = "continue"  # "stop" | "continue"


class RunbookCreateIn(BaseModel):
    name: str
    description: Optional[str] = ""
    company_id: Optional[str] = None
    schedule: str = "monthly"
    steps: list[RunbookStepIn]
    enabled: bool = True


class RunbookPatchIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    schedule: Optional[str] = None
    steps: Optional[list[RunbookStepIn]] = None
    enabled: Optional[bool] = None


async def _run_runbook(runbook: dict, triggered_by: str = "schedule") -> dict:
    """Execute the ordered steps.  Each step gets its own synthetic agent
    doc so the existing `_run_agent` writes a proper `agent_runs` row and
    findings — this way runbook history composes cleanly with the
    per-agent history views."""
    rb_run_id = str(uuid.uuid4())
    started_at = now_iso()
    await db.runbook_runs.insert_one({
        "id": rb_run_id, "runbook_id": runbook["id"],
        "company_id": runbook.get("company_id"),
        "status": "running", "triggered_by": triggered_by,
        "started_at": started_at, "finished_at": None,
        "step_results": [],
        "findings_count": 0,
    })

    step_results: list[dict] = []
    total_findings = 0
    halted = False
    any_failed = False

    for idx, step in enumerate(runbook.get("steps") or []):
        template_key = step.get("template_key")
        on_fail = step.get("on_fail") or "continue"
        template = _TEMPLATES.get(template_key)
        if not template:
            step_results.append({
                "step": idx, "template_key": template_key,
                "status": "failed", "findings_count": 0,
                "error": "unknown-template", "run_id": None,
            })
            any_failed = True
            if on_fail == "stop":
                halted = True
                break
            continue

        synthetic = {
            "id": f"runbook-{rb_run_id}-{idx}",
            "template_key": template_key,
            "name": f"{template['name']} (runbook)",
            "company_id": runbook.get("company_id"),
            "schedule": template.get("default_schedule") or "monthly",
            "config": {**(template.get("default_config") or {}), **(step.get("config") or {})},
            "enabled": False,
            "runbook_id": runbook["id"],
        }
        result = await _run_agent(synthetic, triggered_by=f"runbook:{runbook['id']}")
        step_results.append({
            "step": idx, "template_key": template_key,
            "status": "success" if result.get("ok") else "failed",
            "findings_count": result.get("findings_count") or 0,
            "error": result.get("error"),
            "run_id": result.get("run_id"),
        })
        total_findings += result.get("findings_count") or 0
        if not result.get("ok"):
            any_failed = True
            if on_fail == "stop":
                halted = True
                break

    if halted:
        status = "halted"
    elif any_failed:
        status = "partial"
    else:
        status = "success"

    await db.runbook_runs.update_one(
        {"id": rb_run_id},
        {"$set": {
            "status": status, "finished_at": now_iso(),
            "step_results": step_results,
            "findings_count": total_findings,
        }},
    )
    await db.runbooks.update_one(
        {"id": runbook["id"]},
        {"$set": {
            "last_run_at": now_iso(),
            "last_run_status": status,
            "last_findings_count": total_findings,
        }},
    )
    return {
        "ok": status == "success", "run_id": rb_run_id,
        "status": status, "findings_count": total_findings,
        "step_results": step_results,
    }


async def _runbook_due(rb: dict) -> bool:
    if not rb.get("enabled"):
        return False
    schedule = rb.get("schedule") or "monthly"
    interval = _SCHEDULE_INTERVALS.get(schedule, timedelta(days=30))
    last = rb.get("last_run_at")
    if not last:
        return True
    try:
        d = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except Exception:
        return True
    return (datetime.now(timezone.utc) - d) >= interval


async def tick_due_runbooks(company_ids: list[str], *, background: BackgroundTasks | None = None) -> int:
    if not company_ids:
        return 0
    cursor = db.runbooks.find({
        "enabled": True,
        "$or": [
            {"company_id": {"$in": company_ids}},
            {"company_id": None},
        ],
    })
    rbs = await cursor.to_list(500)
    launched = 0
    for rb in rbs:
        if not await _runbook_due(rb):
            continue
        if background is not None:
            background.add_task(_run_runbook, rb, "schedule")
        else:
            await _run_runbook(rb, "schedule")
        launched += 1
    return launched


# ---- Endpoints -------------------------------------------------------------

@router.get("/runbook-templates")
async def list_runbook_templates(user: dict = Depends(get_current_user)):
    await require_firm_or_pro(user)
    return {"templates": DEFAULT_RUNBOOK_TEMPLATES}


@router.get("/runbooks")
async def list_runbooks(user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"runbooks": []}
    docs = await db.runbooks.find({
        "$or": [
            {"company_id": {"$in": accessible}},
            {"company_id": None},
        ],
    }).sort("created_at", -1).limit(500).to_list(500)
    return {"runbooks": [coerce(d) for d in docs]}


@router.post("/runbooks")
async def create_runbook(inp: RunbookCreateIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    if inp.company_id and inp.company_id not in accessible:
        raise HTTPException(403, "You don't have access to that company.")
    for s in inp.steps:
        if s.template_key not in _TEMPLATES:
            raise HTTPException(400, f"Unknown template: {s.template_key}")
        if s.on_fail not in {"stop", "continue"}:
            raise HTTPException(400, "on_fail must be 'stop' or 'continue'.")
    rb = {
        "id": str(uuid.uuid4()),
        "name": inp.name,
        "description": inp.description or "",
        "company_id": inp.company_id,
        "schedule": inp.schedule,
        "steps": [s.dict() for s in inp.steps],
        "enabled": inp.enabled,
        "created_by": user.get("email") or user.get("id"),
        "created_at": now_iso(),
        "last_run_at": None,
        "last_run_status": None,
        "last_findings_count": 0,
    }
    await db.runbooks.insert_one(rb)
    return {"runbook": coerce(rb)}


@router.post("/runbooks/from-template")
async def create_runbook_from_template(
    template_key: str = Query(...),
    company_id: Optional[str] = Query(None),
    schedule: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    tmpl = next((t for t in DEFAULT_RUNBOOK_TEMPLATES if t["key"] == template_key), None)
    if not tmpl:
        raise HTTPException(400, f"Unknown runbook template: {template_key}")
    if company_id and company_id not in accessible:
        raise HTTPException(403, "You don't have access to that company.")
    rb = {
        "id": str(uuid.uuid4()),
        "name": tmpl["name"],
        "description": tmpl["description"],
        "company_id": company_id,
        "schedule": schedule or tmpl["default_schedule"],
        "steps": [dict(s) for s in tmpl["steps"]],
        "enabled": True,
        "created_by": user.get("email") or user.get("id"),
        "created_at": now_iso(),
        "last_run_at": None, "last_run_status": None, "last_findings_count": 0,
        "seeded_from": template_key,
    }
    await db.runbooks.insert_one(rb)
    return {"runbook": coerce(rb)}


@router.patch("/runbooks/{rb_id}")
async def patch_runbook(rb_id: str, inp: RunbookPatchIn, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    rb = await db.runbooks.find_one({"id": rb_id})
    if not rb:
        raise HTTPException(404, "Runbook not found.")
    if rb.get("company_id") and rb["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    update: dict = {}
    if inp.name is not None:        update["name"] = inp.name
    if inp.description is not None: update["description"] = inp.description
    if inp.schedule is not None:    update["schedule"] = inp.schedule
    if inp.enabled is not None:     update["enabled"] = inp.enabled
    if inp.steps is not None:
        for s in inp.steps:
            if s.template_key not in _TEMPLATES:
                raise HTTPException(400, f"Unknown template: {s.template_key}")
        update["steps"] = [s.dict() for s in inp.steps]
    if update:
        await db.runbooks.update_one({"id": rb_id}, {"$set": update})
    return {"runbook": coerce(await db.runbooks.find_one({"id": rb_id}))}


@router.delete("/runbooks/{rb_id}")
async def delete_runbook(rb_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    rb = await db.runbooks.find_one({"id": rb_id})
    if not rb:
        return {"ok": True}
    if rb.get("company_id") and rb["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    await db.runbooks.delete_one({"id": rb_id})
    await db.runbook_runs.delete_many({"runbook_id": rb_id})
    return {"ok": True}


@router.post("/runbooks/{rb_id}/run-now")
async def run_runbook_now(rb_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    rb = await db.runbooks.find_one({"id": rb_id})
    if not rb:
        raise HTTPException(404, "Runbook not found.")
    if rb.get("company_id") and rb["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    result = await _run_runbook(rb, triggered_by=f"manual:{user.get('email') or user.get('id')}")
    return result


@router.get("/runbooks/{rb_id}/runs")
async def list_runbook_runs(rb_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    rb = await db.runbooks.find_one({"id": rb_id})
    if not rb:
        raise HTTPException(404, "Runbook not found.")
    if rb.get("company_id") and rb["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    docs = await db.runbook_runs.find({"runbook_id": rb_id}).sort("started_at", -1).limit(50).to_list(50)
    return {"runs": [coerce(d) for d in docs]}


@router.get("/runbook-runs/{rb_run_id}")
async def runbook_run_detail(rb_run_id: str, user: dict = Depends(get_current_user)):
    accessible = await require_firm_or_pro(user)
    r = await db.runbook_runs.find_one({"id": rb_run_id})
    if not r:
        raise HTTPException(404, "Runbook run not found.")
    if r.get("company_id") and r["company_id"] not in accessible:
        raise HTTPException(403, "Not allowed.")
    return {"run": coerce(r)}


# =============================================================================
# Phase 5C — Analytics dashboard
# =============================================================================

@router.get("/agents/analytics")
async def agents_analytics(
    period: Optional[str] = Query(None, description="YYYY-MM (default: this month)"),
    user: dict = Depends(get_current_user),
):
    """Firm-wide agent spend + activity roll-up. Cheap Mongo aggregation
    over `agent_runs` scoped to the caller's accessible companies."""
    accessible = await require_firm_or_pro(user)
    if not accessible:
        return {"period": period, "totals": {}, "by_template": [], "by_client": [], "daily": []}

    now = datetime.now(timezone.utc)
    if period:
        try:
            y, m = int(period[:4]), int(period[5:7])
        except Exception:
            raise HTTPException(400, "period must be YYYY-MM")
    else:
        y, m = now.year, now.month
        period = f"{y:04d}-{m:02d}"
    from calendar import monthrange
    start_iso = f"{y:04d}-{m:02d}-01T00:00:00+00:00"
    last = monthrange(y, m)[1]
    end_iso = f"{y:04d}-{m:02d}-{last:02d}T23:59:59+00:00"

    py, pm = (y - 1, 12) if m == 1 else (y, m - 1)
    p_last = monthrange(py, pm)[1]
    prev_start = f"{py:04d}-{pm:02d}-01T00:00:00+00:00"
    prev_end = f"{py:04d}-{pm:02d}-{p_last:02d}T23:59:59+00:00"

    def _match(scope_start: str, scope_end: str):
        return {
            "$or": [
                {"company_id": {"$in": accessible}},
                {"company_id": None},
            ],
            "started_at": {"$gte": scope_start, "$lte": scope_end},
        }

    async def _totals(scope_start: str, scope_end: str) -> dict:
        pipeline = [
            {"$match": _match(scope_start, scope_end)},
            {"$group": {
                "_id": None,
                "runs":     {"$sum": 1},
                "success":  {"$sum": {"$cond": [{"$eq": ["$status", "success"]}, 1, 0]}},
                "failed":   {"$sum": {"$cond": [{"$eq": ["$status", "failed"]}, 1, 0]}},
                "findings": {"$sum": {"$ifNull": ["$findings_count", 0]}},
                "cost":     {"$sum": {"$ifNull": ["$cost_cents", 0]}},
            }},
        ]
        rows = await db.agent_runs.aggregate(pipeline).to_list(1)
        if not rows:
            return {"runs": 0, "success": 0, "failed": 0, "findings": 0, "cost": 0.0}
        r = rows[0]
        return {
            "runs": r.get("runs", 0),
            "success": r.get("success", 0),
            "failed": r.get("failed", 0),
            "findings": r.get("findings", 0),
            "cost": round(float(r.get("cost") or 0) / 100.0, 4),
        }

    cur = await _totals(start_iso, end_iso)
    prev = await _totals(prev_start, prev_end)

    tpl_rows = await db.agent_runs.aggregate([
        {"$match": _match(start_iso, end_iso)},
        {"$group": {
            "_id": "$template_key",
            "runs":     {"$sum": 1},
            "findings": {"$sum": {"$ifNull": ["$findings_count", 0]}},
            "cost":     {"$sum": {"$ifNull": ["$cost_cents", 0]}},
        }},
        {"$sort": {"cost": -1}},
    ]).to_list(50)
    by_template = [
        {
            "template_key": r["_id"],
            "name": (_TEMPLATES.get(r["_id"]) or {}).get("name") or r["_id"],
            "category": (_TEMPLATES.get(r["_id"]) or {}).get("category") or "?",
            "runs": r.get("runs", 0),
            "findings": r.get("findings", 0),
            "cost": round(float(r.get("cost") or 0) / 100.0, 4),
        }
        for r in tpl_rows
    ]

    cli_rows = await db.agent_runs.aggregate([
        {"$match": _match(start_iso, end_iso)},
        {"$group": {
            "_id": "$company_id",
            "runs":     {"$sum": 1},
            "findings": {"$sum": {"$ifNull": ["$findings_count", 0]}},
            "cost":     {"$sum": {"$ifNull": ["$cost_cents", 0]}},
        }},
        {"$sort": {"cost": -1}},
    ]).to_list(500)
    cids = [r["_id"] for r in cli_rows if r["_id"]]
    companies_by_id = {}
    if cids:
        async for c in db.companies.find({"id": {"$in": cids}}, {"id": 1, "name": 1}):
            companies_by_id[c["id"]] = c.get("name") or "Untitled"
    by_client = []
    for r in cli_rows:
        cid = r["_id"]
        by_client.append({
            "company_id": cid,
            "name": companies_by_id.get(cid) or ("Firm-wide" if not cid else cid),
            "runs": r.get("runs", 0),
            "findings": r.get("findings", 0),
            "cost": round(float(r.get("cost") or 0) / 100.0, 4),
        })

    daily_rows = await db.agent_runs.aggregate([
        {"$match": _match(start_iso, end_iso)},
        {"$group": {
            "_id": {"$substrCP": ["$started_at", 0, 10]},
            "runs": {"$sum": 1},
            "cost": {"$sum": {"$ifNull": ["$cost_cents", 0]}},
        }},
        {"$sort": {"_id": 1}},
    ]).to_list(31)
    daily = [
        {"date": r["_id"], "runs": r.get("runs", 0),
         "cost": round(float(r.get("cost") or 0) / 100.0, 4)}
        for r in daily_rows
    ]

    delta_cost = round(cur["cost"] - prev["cost"], 4)
    delta_pct = 0.0
    if prev["cost"] > 0:
        delta_pct = round((cur["cost"] - prev["cost"]) / prev["cost"] * 100.0, 1)

    return {
        "period": period,
        "totals": cur,
        "prior_totals": prev,
        "delta": {"cost": delta_cost, "cost_pct": delta_pct},
        "by_template": by_template,
        "by_client": by_client,
        "daily": daily,
        "assumptions": {
            "deterministic_cost_cents": _DEFAULT_COST_CENTS,
            "llm_cost_cents": _LLM_COST_CENTS,
        },
    }

