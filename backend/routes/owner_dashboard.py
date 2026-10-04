"""Owner dashboard — "Your business, in view".

One aggregator payload for the client-role landing page: Overview, Money,
Documents and Team tabs. Everything is read from existing collections and
engines (projections, month-close, income statement); nothing is written.
"""
from __future__ import annotations

import asyncio
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from db import db
from auth import get_current_user
from deps import require_company
import reports as R
from routes.firm_glance import _pct_delta
from routes.month_close import _month_status
from routes.plaid import sync_status
from routes.projections import projections_cashflow

router = APIRouter(prefix="/api")

AI_NAME = "Your AI bookkeeper"


def _iso(d: date) -> str:
    return d.isoformat()


def _month_bounds(ym: str) -> tuple[date, date]:
    y, m = int(ym[:4]), int(ym[5:7])
    return date(y, m, 1), date(y, m, monthrange(y, m)[1])


def _initials(name: str) -> str:
    parts = [p for p in (name or "").replace(",", " ").split() if p and p[0].isalpha()]
    return "".join(p[0].upper() for p in parts[:2]) or "?"


def _fmt_day(iso: Optional[str]) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%b %-d")
    except ValueError:
        return iso[:10]


# ---------------------------------------------------------------- books ----

async def _books(cid: str, period_start: date, period_end: date, cash_breakdown: list[dict], sync: dict) -> dict:
    ps, pe = _iso(period_start), _iso(period_end)
    status = await _month_status(cid, period_start.year, period_start.month)
    cps = status.get("checkpoints") or {}
    green = sum(1 for c in cps.values() if c.get("green"))
    tx = cps.get("txns_reviewed") or {}
    total = int(tx.get("total") or 0)
    uncategorized = int(tx.get("uncategorized") or 0)
    unreviewed = int(tx.get("unreviewed") or 0)
    pct = round(100 * (total - uncategorized) / total) if total else 100

    accts = await db.accounts.find(
        {"company_id": cid, "detail_type": {"$in": ["cash_and_bank", "credit_card"]}},
        {"id": 1, "name": 1, "detail_type": 1, "last4": 1},
    ).to_list(50)
    live = {a.get("id"): a for a in cash_breakdown}
    stmt_accts = {
        s.get("account_id") async for s in db.statement_imports.find(
            {"company_id": cid, "period_end": {"$gte": ps}, "status": {"$ne": "failed"}}, {"account_id": 1})
    }
    rows = []
    for a in accts:
        aid = a["id"]
        on_acct = {"$or": [{"bank_account_id": aid}, {"account_id": aid}]}
        tot, cleared, to_review = await asyncio.gather(
            db.transactions.count_documents({"company_id": cid, **on_acct, "date": {"$gte": ps, "$lte": pe}, "posted": {"$ne": False}}),
            db.transactions.count_documents({"company_id": cid, **on_acct, "date": {"$gte": ps, "$lte": pe}, "cleared_at": {"$nin": [None, ""]}}),
            db.transactions.count_documents({"company_id": cid, **on_acct, "needs_review": True}),
        )
        lv = live.get(aid) or {}
        plaid = lv.get("balance_source") == "plaid_live"
        if tot == 0 and not plaid and not (lv.get("balance") or 0):
            continue
        needs_statement = (not plaid) and aid not in stmt_accts and tot > 0 and cleared < tot
        if needs_statement:
            state, tone = "Needs statement", "warn"
        elif tot and cleared >= tot:
            state, tone = f"Reconciled through {period_end.strftime('%b %-d')}", "ok"
        elif plaid:
            state, tone = f"Synced {_fmt_day(lv.get('balance_as_of') or sync.get('last_sync_at'))}", "ok"
        else:
            state, tone = "In progress", "mute"
        rows.append({
            "id": aid, "name": a.get("name"), "kind": "card" if a.get("detail_type") == "credit_card" else "bank",
            "reconciled": cleared, "total": tot, "to_review": to_review,
            "state": state, "tone": tone, "needs_statement": needs_statement,
        })

    open_items = uncategorized + unreviewed
    overall = "complete" if green == len(cps) and open_items == 0 else ("nearly" if pct >= 85 else "behind")
    return {
        "period_label": period_start.strftime("%B"),
        "updated_through": (sync.get("last_sync_at") or "")[:10],
        "last_sync_at": sync.get("last_sync_at"),
        "total_txns": total, "categorized_pct": pct, "awaiting_answers": unreviewed, "uncategorized": uncategorized,
        "accounts": rows,
        "checkpoints_green": green, "checkpoints_total": len(cps),
        "status": overall, "preliminary": open_items > 0 or green < len(cps),
    }


# --------------------------------------------------------------- profit ----

async def _profit(cid: str, period_start: date, period_end: date, basis: str = "accrual") -> dict:
    ps, pe = _iso(period_start), _iso(period_end)
    prev_end = period_start - timedelta(days=1)
    prev_start = prev_end.replace(day=1)
    cur, prev = await asyncio.gather(
        R.compute_income_statement(cid, ps, pe, basis),
        R.compute_income_statement(cid, _iso(prev_start), _iso(prev_end), basis),
    )
    rev = float(cur.get("total_revenue") or 0)
    exp = float(cur.get("total_expense") or 0) + float(cur.get("total_cogs") or 0)
    net = float(cur.get("net_income") or 0)
    prev_net = float(prev.get("net_income") or 0)

    # 6-month bars (including current period) — one call per month.
    months = []
    cursor = period_start
    for _ in range(6):
        months.append(cursor)
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    months.reverse()
    series = await asyncio.gather(*[
        R.compute_income_statement(cid, _iso(m), _iso(m.replace(day=monthrange(m.year, m.month)[1])), basis)
        for m in months[:-1]
    ])
    bars = [
        {"label": m.strftime("%b"), "revenue": float(s.get("total_revenue") or 0),
         "expenses": float(s.get("total_expense") or 0) + float(s.get("total_cogs") or 0),
         "net": float(s.get("net_income") or 0)}
        for m, s in zip(months[:-1], series)
    ] + [{"label": period_start.strftime("%b"), "revenue": rev, "expenses": exp, "net": net}]

    # Plain-English "why" from the biggest movers.
    top_rev = sorted((r for r in (cur.get("revenue") or []) if float(r.get("amount") or 0) > 0), key=lambda r: -float(r["amount"]))[:2]
    top_exp = sorted((r for r in (cur.get("expenses") or []) if float(r.get("amount") or 0) > 0), key=lambda r: -float(r["amount"]))[:2]
    why = []
    if net > 0 and prev_net <= 0:
        why.append(f"{period_start.strftime('%B')} is profitable after a loss in {prev_start.strftime('%B')}.")
    elif net > prev_net:
        why.append(f"Profit is up vs {prev_start.strftime('%B')}.")
    elif net < prev_net:
        why.append(f"Profit is down vs {prev_start.strftime('%B')}.")
    if top_rev:
        why.append("Most income came from " + " and ".join(f"{r.get('name')} (${float(r['amount']):,.0f})" for r in top_rev) + ".")
    if top_exp:
        why.append("Largest costs: " + " and ".join(f"{r.get('name')} (${float(r['amount']):,.0f})" for r in top_exp) + ".")
    return {
        "basis": basis, "revenue": rev, "expenses": exp, "net": net,
        "margin_pct": round(100 * net / rev, 1) if rev else None,
        "delta_pct_vs_prev": _pct_delta(net, prev_net), "prev_label": prev_start.strftime("%B"),
        "months": bars, "why": " ".join(why),
    }


# ----------------------------------------------------------------- cash ----

def _cash(proj: dict, today: date) -> dict:
    end30 = _iso(today + timedelta(days=30))
    ev30 = [e for e in proj.get("events", []) if today.isoformat() <= e["date"] <= end30]
    collections = sum(e["amount"] for e in ev30 if e["amount"] > 0)
    obligations = sum(e["amount"] for e in ev30 if e["amount"] < 0)
    tl = proj.get("timeline", [])[:31]
    tc = proj.get("timeline_conservative", [])[:31]
    timeline = [{"date": r["date"], "cash": r["cash"], "conservative": (tc[i]["cash"] if i < len(tc) else None)} for i, r in enumerate(tl)]
    low = min((r["cash"] for r in tl), default=proj.get("cash_today", 0))
    biggest = sorted((e for e in ev30 if e["amount"] < 0), key=lambda e: e["amount"])[:2]
    excl = proj.get("excluded_ar") or []
    conservative = proj.get("conservative") or {}
    why = []
    if low < 0:
        why.append("Cash is projected to dip below zero in the next 30 days.")
    elif conservative.get("low_30d", 0) < 0:
        why.append("You're covered if customers pay as usual — but a shortfall is possible if none of the open invoices come in.")
    else:
        why.append("No shortfall projected.")
    if biggest:
        why.append("Biggest outflows: " + " and ".join(f"{e['label']} (${abs(e['amount']):,.0f} on {_fmt_day(e['date'])})" for e in biggest) + ".")
    if excl:
        why.append(f"{len(excl)} invoice{'s' if len(excl) > 1 else ''} (${sum(e['gross'] for e in excl):,.0f}) are 60+ days late and not counted.")
    return {
        "cash_today": proj.get("cash_today", 0),
        "accounts": [{"id": a.get("id"), "name": a.get("name"), "balance": a.get("balance"), "as_of": a.get("balance_as_of"), "live": a.get("balance_source") == "plaid_live"}
                     for a in proj.get("cash_breakdown", []) if (a.get("balance") or 0) != 0 or a.get("balance_source") == "plaid_live"],
        "collections_30d": round(collections, 2), "obligations_30d": round(obligations, 2),
        "ending_30d": tl[-1]["cash"] if tl else proj.get("cash_today", 0),
        "low_30d": round(low, 2),
        "conservative_low_30d": conservative.get("low_30d"), "conservative_end_30d": (tc[-1]["cash"] if tc else None),
        "timeline": timeline, "confidence": proj.get("confidence"),
        "biggest_outflows": [{"label": e["label"], "date": e["date"], "amount": e["amount"]} for e in biggest],
        "excluded_ar": {"count": len(excl), "gross": round(sum(e["gross"] for e in excl), 2)},
        "shortfall": low < 0, "why": " ".join(why),
    }


# ------------------------------------------------------------ attention ----

async def _attention(cid: str, today: date, books: dict, batch: Optional[dict], proj: dict) -> list[dict]:
    items: list[dict] = []
    if batch:
        pending = [i for i in batch.get("items", []) if i.get("status") not in ("answered", "resolved", "dismissed") and not i.get("answer")]
        if pending:
            kinds = {}
            for i in pending:
                kinds[i.get("item_type")] = kinds.get(i.get("item_type"), 0) + 1
            items.append({
                "id": "checkin", "kind": "question", "tone": "brand",
                "title": "Your bookkeeper has a few quick questions" if len(pending) > 1 else "Your bookkeeper has a quick question",
                "subtitle": f"{len(pending)} item{'s' if len(pending) > 1 else ''} · about {max(1, len(pending) // 2)} min",
                "action_label": "Answer", "href": f"/q/{batch.get('client_token')}", "count": len(pending),
            })
    missing = await db.agent_findings.find(
        {"company_id": cid, "kind": "missing_receipt", "status": "open"}, {"title": 1, "detail": 1, "meta": 1}).limit(5).to_list(5)
    if missing:
        m0 = missing[0]
        items.append({
            "id": "receipts", "kind": "receipt", "tone": "warn",
            "title": "A receipt is missing" if len(missing) == 1 else f"{len(missing)} receipts are missing",
            "subtitle": (m0.get("title") or m0.get("detail") or "")[:90],
            "action_label": "Snap it", "href": f"/q/{batch.get('client_token')}" if batch else "/owner/documents", "count": len(missing),
        })
    overdue = [e for e in proj.get("events", []) if e.get("kind") == "invoice" and e.get("days_overdue", 0) > 0] + (proj.get("excluded_ar") or [])
    if overdue:
        worst = max(overdue, key=lambda e: e.get("days_overdue", 0))
        total = sum(e["gross"] for e in overdue)
        items.append({
            "id": "overdue", "kind": "invoice", "tone": "bad",
            "title": f"{len(overdue)} invoice{'s' if len(overdue) > 1 else ''} overdue — ${total:,.0f}",
            "subtitle": f"{worst.get('contact_name') or ''} {worst['label']} · ${worst['gross']:,.0f} · {worst['days_overdue']} days late".strip(),
            "action_label": "Send reminder", "href": "/owner/money", "count": len(overdue), "invoice_id": worst.get("invoice_id"),
        })
    for a in books.get("accounts", []):
        if a.get("needs_statement"):
            items.append({
                "id": f"stmt-{a['id']}", "kind": "statement", "tone": "mute",
                "title": f"{a['name']} statement needed",
                "subtitle": f"{books['period_label']} · to finish reconciling",
                "action_label": "Upload", "href": "/owner/documents", "count": 1,
            })
    return items


# ----------------------------------------------------------------- team ----

async def _team(cid: str, today: date, batch: Optional[dict], books: dict) -> dict:
    week_start = today - timedelta(days=today.weekday())
    ws = _iso(week_start)
    ws_dt = f"{ws}T00:00:00"
    members_raw = await db.memberships.find({"company_id": cid, "archived_at": {"$in": [None, ""]}}).to_list(50)
    users = {u["id"]: u async for u in db.users.find({"id": {"$in": [m["user_id"] for m in members_raw]}}, {"id": 1, "name": 1, "email": 1, "role": 1, "title": 1})}
    members = [{"name": AI_NAME, "initials": "AI", "is_ai": True, "title": "Daily categorization, receipt matching, bank monitoring, cash-flow forecasting"}]
    booking_url = None
    for m in members_raw:
        u = users.get(m["user_id"])
        if not u or m.get("role") not in ("pro", "editor", "reviewer") and u.get("role") not in ("pro", "superadmin"):
            continue
        members.append({"name": u.get("name") or u.get("email"), "initials": _initials(u.get("name") or u.get("email")),
                        "is_ai": False, "title": u.get("title") or "Review, reconciliation and month-end close", "user_id": u["id"]})
        if not booking_url:
            bs = await db.user_booking_settings.find_one({"user_id": u["id"]}, {"slug": 1})
            if bs and bs.get("slug"):
                booking_url = f"/book/{bs['slug']}"

    fresh = _iso(week_start - timedelta(days=7))
    categorized, matched, reconciled = await asyncio.gather(
        db.transactions.count_documents({"company_id": cid, "category_account_id": {"$nin": [None, ""]},
                                         "$or": [{"approved_at": {"$gte": ws_dt}}, {"human_reviewed_at": {"$gte": ws_dt}},
                                                 {"created_at": {"$gte": ws_dt}, "date": {"$gte": fresh}}]}),
        db.transactions.count_documents({"company_id": cid, "matched_at": {"$gte": ws_dt}}),
        db.transactions.count_documents({"company_id": cid, "cleared_at": {"$gte": ws}}),
    )

    next_checkin = None
    if batch:
        total = len(batch.get("items", []))
        answered = sum(1 for i in batch.get("items", []) if i.get("answer") or i.get("status") in ("answered", "resolved"))
        next_checkin = {
            "status": batch.get("status"), "total": total, "answered": answered,
            "sent_at": batch.get("email_sent_at") or batch.get("scheduled_for") or batch.get("created_at"),
            "href": f"/q/{batch.get('client_token')}", "reason": batch.get("scheduled_reason"),
        }

    comms = await db.communications.find({"company_id": cid, "kind": {"$nin": ["internal", "system"]}}).sort("sent_at", -1).limit(5).to_list(5)
    pro_name = next((m["name"] for m in members if not m["is_ai"]), "Your bookkeeper")
    conversations = []
    seen = set()
    for c in comms:
        key = (c.get("subject"), (c.get("sent_at") or "")[:16])
        if key in seen:
            continue
        seen.add(key)
        conversations.append({
            "actor": pro_name if c.get("user_id") else AI_NAME, "at": c.get("sent_at"), "kind": c.get("kind"),
            "subject": c.get("subject") or c.get("kind", "").replace("_", " ").capitalize(),
            "href": f"/q/{(c.get('related') or {}).get('client_token')}" if (c.get("related") or {}).get("client_token") else None,
        })

    working_on = []
    for a in books.get("accounts", []):
        if a["total"] and a["reconciled"] < a["total"]:
            working_on.append({"title": f"{books['period_label']} reconciliation", "subtitle": f"{a['name']} · {a['reconciled']} of {a['total']} cleared", "status": "In progress", "tone": "warn"})
            break
    waiting = (books.get("awaiting_answers") or 0) + sum(1 for a in books.get("accounts", []) if a.get("needs_statement"))
    if waiting:
        working_on.append({"title": "Missing information", "subtitle": f"{books.get('awaiting_answers', 0)} transactions" + (" · 1 statement" if any(a.get("needs_statement") for a in books.get("accounts", [])) else ""), "status": "Waiting on you", "tone": "bad"})
    if books.get("checkpoints_green", 0) < books.get("checkpoints_total", 5):
        working_on.append({"title": f"{books['period_label']} close review", "subtitle": pro_name, "status": "Up next", "tone": "mute"})
    working_on.append({"title": f"{today.strftime('%B')} bookkeeping", "subtitle": "Daily bank activity", "status": "In progress", "tone": "ok"})

    return {
        "members": members, "booking_url": booking_url,
        "weekly": {"categorized": categorized, "receipts_matched": matched, "reconciled": reconciled,
                   "label": f"{week_start.strftime('%b %-d')} – {today.strftime('%b %-d')}"},
        "next_checkin": next_checkin, "conversations": conversations, "working_on": working_on,
    }


# ---------------------------------------------------------------- money ----

async def _money(cid: str, today: date, proj: dict) -> dict:
    invs = await db.invoices.find({"company_id": cid, "status": {"$nin": ["paid", "void", "voided"]}}).to_list(500)
    rows = []
    for i in invs:
        bal = float(i.get("balance_due") or i.get("total") or 0)
        if bal <= 0:
            continue
        due = (i.get("due_date") or i.get("issue_date") or "")[:10]
        try:
            over = (today - date.fromisoformat(due)).days
        except ValueError:
            over = 0
        rows.append({"id": i.get("id"), "number": i.get("number"), "contact": i.get("customer_name") or i.get("contact_name") or "",
                     "contact_email": i.get("customer_email") or i.get("contact_email"), "due_date": due, "days_overdue": max(0, over),
                     "balance": round(bal, 2), "expected_payment_date": i.get("expected_payment_date"),
                     "status": "overdue" if over > 0 else ("due_soon" if over >= -7 else "open")})
    rows.sort(key=lambda r: (-r["days_overdue"], r["due_date"]))
    end30 = _iso(today + timedelta(days=30))
    ev30 = [e for e in proj.get("events", []) if today.isoformat() <= e["date"] <= end30]
    upcoming = sorted((e for e in ev30 if e["amount"] < 0), key=lambda e: (e["date"], e["amount"]))
    bills_ops = sum(e["amount"] for e in upcoming if e.get("kind") in ("bill", "payroll", "sales_tax", "custom") or (e.get("kind") == "pattern" and e.get("contact_id")))
    recurring = sum(e["amount"] for e in upcoming) - bills_ops
    return {
        "ar": {"total": round(sum(r["balance"] for r in rows), 2), "overdue": round(sum(r["balance"] for r in rows if r["days_overdue"] > 0), 2),
               "count": len(rows), "overdue_count": sum(1 for r in rows if r["days_overdue"] > 0)},
        "invoices": rows,
        "ledger": {"opening": proj.get("cash_today", 0),
                   "collections": round(sum(e["amount"] for e in ev30 if e["amount"] > 0), 2),
                   "bills_operating": round(bills_ops, 2), "recurring": round(recurring, 2),
                   "drift_30d": round(float(proj.get("daily_drift") or 0) * 30, 2),
                   "ending": (proj.get("timeline") or [{}])[min(30, len(proj.get("timeline") or [1]) - 1)].get("cash", proj.get("cash_today", 0))},
        "upcoming": [{"label": e["label"], "date": e["date"], "amount": e["amount"], "kind": e.get("kind"), "source": e.get("source")} for e in upcoming[:12]],
        "upcoming_more": max(0, len(upcoming) - 12),
    }


# ------------------------------------------------------------ documents ----

async def _documents(cid: str, period_start: date, batch: Optional[dict]) -> dict:
    receipts = await db.receipts.find({"company_id": cid, "$or": [{"attachment_data_url": {"$exists": True}}, {"source": "client_checkin"}, {"matched_transaction_id": {"$exists": True}}]}).sort("created_at", -1).limit(25).to_list(25)
    stmts = await db.statement_imports.find({"company_id": cid}).sort("created_at", -1).limit(10).to_list(10)
    rows = []
    for r in receipts:
        matched = bool(r.get("matched_transaction_id"))
        rows.append({"id": r.get("id"), "type": "receipt", "title": f"{r.get('merchant') or r.get('merchant_name') or 'Receipt'} · ${float(r.get('amount') or 0):,.2f}",
                     "added": (r.get("created_at") or "")[:10], "status": "Matched to bank activity" if matched else ("Suggested match" if r.get("suggested_matches") else "Received — matching"),
                     "tone": "ok" if matched else ("warn" if r.get("suggested_matches") else "mute")})
    for s in stmts:
        done = s.get("status") in ("completed", "reconciled", "done")
        rows.append({"id": s.get("id"), "type": "statement", "title": f"{s.get('account_name') or 'Bank'} statement · {(s.get('period_start') or '')[:7]}",
                     "added": (s.get("created_at") or "")[:10], "status": f"{s.get('transaction_count') or 0} transactions · {s.get('status') or ''}", "tone": "ok" if done else "mute"})
    rows.sort(key=lambda r: r["added"], reverse=True)
    missing = await db.agent_findings.find({"company_id": cid, "kind": "missing_receipt", "status": "open"}, {"id": 1, "title": 1, "detail": 1, "meta": 1}).limit(5).to_list(5)
    return {
        "missing_receipts": [{"id": m.get("id"), "title": m.get("title"), "detail": m.get("detail"), "amount": (m.get("meta") or {}).get("amount"), "date": (m.get("meta") or {}).get("date"),
                              "href": f"/q/{batch.get('client_token')}" if batch else None} for m in missing],
        "rows": rows,
        "counts": {"receipts": len(receipts), "statements": len(stmts)},
    }


# ------------------------------------------------------------- endpoint ----

@router.get("/companies/{cid}/owner-dashboard")
async def owner_dashboard(
    cid: str,
    period: Optional[str] = Query(None, description="YYYY-MM; defaults to the last complete month"),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    today = datetime.now(timezone.utc).date()
    if period and len(period) >= 7:
        ym = period[:7]
    else:
        last = today.replace(day=1) - timedelta(days=1)
        ym = last.strftime("%Y-%m")
    period_start, period_end = _month_bounds(ym)

    company = await db.companies.find_one({"id": cid}, {"name": 1, "legal_name": 1})
    proj, sync, batch = await asyncio.gather(
        projections_cashflow(cid=cid, days=120, start_date=None, end_date=None, user=user),
        sync_status(cid=cid, user=user),
        db.client_review_batches.find_one({"company_id": cid, "status": {"$nin": ["completed", "expired"]}}, sort=[("created_at", -1)]),
    )
    sync_info = {"last_sync_at": (sync or {}).get("last_sync_at")}

    books = await _books(cid, period_start, period_end, proj.get("cash_breakdown", []), sync_info)
    profit, team, money, documents = await asyncio.gather(
        _profit(cid, period_start, period_end),
        _team(cid, today, batch, books),
        _money(cid, today, proj),
        _documents(cid, period_start, batch),
    )
    cash = _cash(proj, today)
    attention = await _attention(cid, today, books, batch, proj)
    weekly_total = sum(team["weekly"][k] for k in ("categorized", "receipts_matched", "reconciled"))
    hour = datetime.now(timezone.utc).hour
    greeting = "Good morning" if 5 <= hour < 12 else ("Good afternoon" if 12 <= hour < 18 else "Good evening")
    first = (user.get("name") or "").split(" ")[0] or None

    return {
        "as_of": _iso(today),
        "company": {"id": cid, "name": (company or {}).get("name") or ""},
        "user": {"first_name": first, "greeting": greeting},
        "period": {"ym": ym, "label": period_start.strftime("%B %Y"), "start": _iso(period_start), "end": _iso(period_end)},
        "banner": {
            "handled_this_week": weekly_total,
            "needs_you": attention[0]["count"] if attention else 0,
            "needs_you_href": attention[0]["href"] if attention else None,
            "period_label": books["period_label"],
        },
        "books": books, "profit": profit, "cash": cash, "attention": attention,
        "team": team, "money": money, "documents": documents,
    }
