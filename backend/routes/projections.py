"""
Cashflow Projections — where will the client be in 30/60/90/120 days.

Design goal
===========
Forecast a client's daily cash position for the next 120 days by blending:
  • current cash balance (asset accounts with detail_type=cash_and_bank)
  • scheduled outflows: open bills, loan repayments, next payroll,
    next sales-tax remittance
  • expected inflows: open invoices, weighted by AR aging haircuts
  • recurring cadence detected from historical transactions
  • user-added custom recurring items (subscription revenue etc.)

Nothing here overrides existing data — it reads live ledger state and
projects forward. All settings (AR haircut %, custom recurring items)
persist in `projection_settings` per company.

Data model
==========
`projection_settings` — one doc per company:
    {
        "company_id": cid,
        "ar_haircuts": {
            "d0_30":  0.95,
            "d30_60": 0.80,
            "d60_90": 0.60,
            "d90_plus": 0.30,
        },
        "custom_recurring": [{
            "id": uuid,
            "label": "Retainer",
            "amount": 3500.00,       # positive = inflow, negative = outflow
            "cadence": "monthly",    # weekly|biweekly|monthly|quarterly
            "day_of_month": 1,       # for monthly/quarterly
            "day_of_week": null,     # 0-6 for weekly/biweekly
            "next_date": "2026-10-01",
            "active": true,
        }],
        "updated_at": ISO, "updated_by": email,
    }
"""
from __future__ import annotations

import uuid
from calendar import monthrange
from collections import defaultdict
from datetime import datetime, timedelta, timezone, date
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from deps import require_company


router = APIRouter(prefix="/api")


# =============================================================================
# Defaults / catalogs
# =============================================================================

DEFAULT_HAIRCUTS = {
    "d0_30":  0.95,
    "d30_60": 0.80,
    "d60_90": 0.60,
    "d90_plus": 0.30,
}

VALID_CADENCE = {"weekly", "biweekly", "monthly", "quarterly", "one_time"}


# =============================================================================
# Helpers
# =============================================================================

def _today() -> date:
    return datetime.now(timezone.utc).date()


def _add_days(d: date, n: int) -> date:
    return d + timedelta(days=n)


def _iso(d: date) -> str:
    return d.isoformat()


def _month_end(d: date) -> date:
    return date(d.year, d.month, monthrange(d.year, d.month)[1])


async def _cash_balance(cid: str) -> tuple[float, list[dict]]:
    """Sum of ledger balance across every `cash_and_bank` asset account.

    Uses the same math the Balance Sheet uses: sum of every posted
    transaction on those accounts up through today.
    """
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset", "detail_type": "cash_and_bank",
    }).to_list(500)
    if not accts:
        return 0.0, []
    acct_ids = [a["id"] for a in accts]
    today_iso = _iso(_today())
    agg = await db.transactions.aggregate([
        {"$match": {
            "company_id": cid,
            "account_id": {"$in": acct_ids},
            "date": {"$lte": today_iso},
        }},
        {"$group": {"_id": "$account_id", "total": {"$sum": "$amount"}}},
    ]).to_list(500)
    by_acct = {a["_id"]: float(a["total"] or 0.0) for a in agg}
    total = round(sum(by_acct.values()), 2)
    breakdown = [
        {"id": a["id"], "name": a.get("name"), "code": a.get("code"),
         "balance": round(by_acct.get(a["id"], 0.0), 2)}
        for a in accts
    ]
    return total, breakdown


async def _get_settings(cid: str) -> dict:
    doc = await db.projection_settings.find_one({"company_id": cid}) or {}
    doc.pop("_id", None)
    return {
        "company_id": cid,
        "ar_haircuts": {**DEFAULT_HAIRCUTS, **(doc.get("ar_haircuts") or {})},
        "custom_recurring": doc.get("custom_recurring") or [],
        "updated_at": doc.get("updated_at"),
        "updated_by": doc.get("updated_by"),
    }


async def _open_invoice_events(cid: str, haircuts: dict, today: date) -> list[dict]:
    """Expected inflows from open AR, weighted by aging haircut.

    Rules:
      • Invoices with due_date in the future → land on due_date at haircut d0_30
      • Overdue invoices → land at (today + 7 days) but haircut based on
        how overdue they already are.
    """
    invs = await db.invoices.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided"]},
    }).to_list(5000)
    events: list[dict] = []
    for inv in invs:
        bal = float(inv.get("balance_due") or inv.get("total") or 0)
        if bal <= 0:
            continue
        due = inv.get("due_date") or inv.get("issue_date")
        if not due:
            continue
        try:
            due_d = date.fromisoformat(due[:10])
        except ValueError:
            continue
        days_over = (today - due_d).days
        if days_over <= 0:
            landing = due_d
            hc_key = "d0_30"
        elif days_over <= 30:
            landing = _add_days(today, 3)
            hc_key = "d0_30"
        elif days_over <= 60:
            landing = _add_days(today, 7)
            hc_key = "d30_60"
        elif days_over <= 90:
            landing = _add_days(today, 14)
            hc_key = "d60_90"
        else:
            landing = _add_days(today, 21)
            hc_key = "d90_plus"
        prob = float(haircuts.get(hc_key, DEFAULT_HAIRCUTS[hc_key]))
        events.append({
            "date": _iso(landing),
            "amount": round(bal * prob, 2),
            "gross": round(bal, 2),
            "probability": prob,
            "label": f"Invoice #{inv.get('number') or inv.get('id', '')[:8]}",
            "kind": "invoice",
            "haircut_bucket": hc_key,
            "invoice_id": inv.get("id"),
        })
    return events


async def _open_bill_events(cid: str, today: date, horizon_end: date) -> list[dict]:
    """Scheduled outflows from open AP.

    Overdue bills → assume they'll be paid within 7 days (worst-case cash
    hit sooner rather than later).
    """
    bills = await db.bills.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided"]},
    }).to_list(5000)
    events: list[dict] = []
    for b in bills:
        bal = float(b.get("balance_due") or b.get("total") or 0)
        if bal <= 0:
            continue
        due = b.get("due_date") or b.get("bill_date")
        if not due:
            continue
        try:
            due_d = date.fromisoformat(due[:10])
        except ValueError:
            continue
        if due_d < today:
            landing = _add_days(today, 7)
        else:
            landing = due_d
        if landing > horizon_end:
            continue
        events.append({
            "date": _iso(landing),
            "amount": -round(bal, 2),
            "label": f"Bill {b.get('vendor_name') or b.get('vendor_id', '')[:8]}",
            "kind": "bill",
            "bill_id": b.get("id"),
        })
    return events


async def _loan_events(cid: str, today: date, horizon_end: date) -> list[dict]:
    """Scheduled loan payments over the horizon."""
    loans = await db.loans.find({
        "company_id": cid, "active": {"$ne": False},
    }).to_list(200)
    events: list[dict] = []
    for l in loans:
        sched = l.get("schedule") or []
        for row in sched:
            paid = row.get("paid") or row.get("status") == "paid"
            if paid:
                continue
            due = row.get("due_date") or row.get("date")
            if not due:
                continue
            try:
                due_d = date.fromisoformat(due[:10])
            except ValueError:
                continue
            if due_d < today or due_d > horizon_end:
                continue
            payment = float(row.get("payment") or row.get("total") or 0)
            if payment <= 0:
                continue
            events.append({
                "date": _iso(due_d),
                "amount": -round(payment, 2),
                "label": f"Loan payment · {l.get('lender') or 'loan'}",
                "kind": "loan",
                "loan_id": l.get("id"),
            })
    return events


async def _payroll_events(cid: str, today: date, horizon_end: date) -> list[dict]:
    """Estimate upcoming payroll runs based on `responsibilities.payroll_frequency`
    + the mean of the last few payroll transactions on this company.

    Heuristic — good enough for a projection; the CPA can override the
    number via custom_recurring items on the settings sheet.
    """
    co = await db.companies.find_one({"id": cid}, {"responsibilities": 1})
    freq = ((co or {}).get("responsibilities") or {}).get("payroll_frequency")
    if not freq:
        return []
    delta_days = {"weekly": 7, "biweekly": 14, "semimonthly": 15, "monthly": 30}.get(freq)
    if not delta_days:
        return []
    # Sample the last few payroll-tagged transactions to derive amount +
    # anchor date. Fall back to zero → we still emit events so the user
    # sees the cadence, just as a $0 line.
    txns = await db.transactions.find({
        "company_id": cid,
        "$or": [
            {"category_account_name": {"$regex": "payroll", "$options": "i"}},
            {"description": {"$regex": "payroll|gusto|adp|paychex", "$options": "i"}},
        ],
    }).sort("date", -1).limit(6).to_list(6)
    if not txns:
        return []
    amounts = [abs(float(t.get("amount") or 0)) for t in txns]
    avg = round(sum(amounts) / len(amounts), 2) if amounts else 0.0
    if avg <= 0:
        return []
    # Anchor on the most recent payroll date + delta.
    try:
        anchor = date.fromisoformat(txns[0]["date"][:10])
    except (ValueError, KeyError):
        anchor = today
    events: list[dict] = []
    cursor = anchor
    # Roll forward until we're past today, then emit each payment through
    # the horizon.
    while cursor <= today:
        cursor = _add_days(cursor, delta_days)
    while cursor <= horizon_end:
        events.append({
            "date": _iso(cursor),
            "amount": -avg,
            "label": f"Payroll ({freq})",
            "kind": "payroll",
        })
        cursor = _add_days(cursor, delta_days)
    return events


async def _sales_tax_events(cid: str, today: date, horizon_end: date) -> list[dict]:
    """Estimate the next sales-tax remittance.

    Simple model: on the 20th of every month, remit whatever's currently
    collected minus already-remitted for the prior month. If the net
    obligation is negative (credit), no event is emitted.
    """
    events: list[dict] = []
    y, m = today.year, today.month
    for _ in range(4):
        remit_date = date(y, m, 20)
        if remit_date < today:
            remit_date = _month_end(remit_date)
            # Move to next month.
            m += 1
            if m > 12:
                m = 1
                y += 1
            continue
        if remit_date > horizon_end:
            break
        # Sum tax on invoices from the PRIOR month.
        pm = m - 1 or 12
        py = y if m > 1 else y - 1
        start = date(py, pm, 1)
        end = _month_end(start)
        invs = await db.invoices.find({
            "company_id": cid,
            "issue_date": {"$gte": _iso(start), "$lte": _iso(end)},
        }).to_list(5000)
        collected = sum(float(i.get("tax") or 0) for i in invs)
        pays = await db.tax_payments.find({
            "company_id": cid,
            "date": {"$gte": _iso(start), "$lte": _iso(end)},
        }).to_list(500)
        already = sum(float(p.get("amount") or 0) for p in pays)
        net = round(collected - already, 2)
        if net > 0.01:
            events.append({
                "date": _iso(remit_date),
                "amount": -net,
                "label": f"Sales-tax remittance ({start.strftime('%b')})",
                "kind": "sales_tax",
            })
        m += 1
        if m > 12:
            m = 1
            y += 1
    return events


def _recurring_events_from_custom(custom: list[dict], today: date, horizon_end: date) -> list[dict]:
    events: list[dict] = []
    for r in custom or []:
        if r.get("active") is False:
            continue
        amount = float(r.get("amount") or 0)
        if amount == 0:
            continue
        cadence = r.get("cadence")
        if cadence not in VALID_CADENCE:
            continue
        # Start from next_date or today.
        try:
            cursor = date.fromisoformat((r.get("next_date") or _iso(today))[:10])
        except ValueError:
            cursor = today
        if cadence == "one_time":
            if today <= cursor <= horizon_end:
                events.append({
                    "date": _iso(cursor), "amount": amount,
                    "label": r.get("label") or "Custom event",
                    "kind": "custom", "recurring_id": r.get("id"),
                })
            continue
        delta = {"weekly": 7, "biweekly": 14, "monthly": 30, "quarterly": 90}.get(cadence, 30)
        # Roll the cursor forward if it's in the past.
        while cursor < today:
            cursor = _add_days(cursor, delta)
        while cursor <= horizon_end:
            events.append({
                "date": _iso(cursor), "amount": amount,
                "label": r.get("label") or "Custom event",
                "kind": "custom", "recurring_id": r.get("id"),
            })
            cursor = _add_days(cursor, delta)
    return events


async def _historical_burn(cid: str, today: date) -> dict:
    """Trailing-90-day cash net + avg-monthly-outflow for the runway math."""
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset", "detail_type": "cash_and_bank",
    }).to_list(500)
    if not accts:
        return {"avg_monthly_in": 0, "avg_monthly_out": 0, "avg_monthly_net": 0, "runway_days": None}
    acct_ids = [a["id"] for a in accts]
    start = _iso(_add_days(today, -90))
    end = _iso(today)
    agg = await db.transactions.aggregate([
        {"$match": {
            "company_id": cid,
            "account_id": {"$in": acct_ids},
            "date": {"$gte": start, "$lte": end},
        }},
        {"$group": {
            "_id": {"$cond": [{"$gt": ["$amount", 0]}, "in", "out"]},
            "total": {"$sum": "$amount"},
        }},
    ]).to_list(2)
    tot_in = 0.0
    tot_out = 0.0
    for a in agg:
        if a["_id"] == "in":
            tot_in = float(a["total"] or 0)
        else:
            tot_out = float(a["total"] or 0)
    avg_in = round(tot_in / 3.0, 2)
    avg_out = round(tot_out / 3.0, 2)  # negative
    net = round(avg_in + avg_out, 2)
    return {
        "avg_monthly_in": avg_in,
        "avg_monthly_out": avg_out,
        "avg_monthly_net": net,
        "trailing_start": start,
        "trailing_end": end,
    }


def _compute_timeline(
    start_cash: float, today: date, horizon_end: date, events: list[dict],
    daily_drift: float,
) -> list[dict]:
    """Roll cash forward day-by-day, applying event amounts + daily drift."""
    by_date: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        by_date[e["date"]].append(e)
    timeline: list[dict] = []
    cash = start_cash
    cursor = today
    while cursor <= horizon_end:
        iso = _iso(cursor)
        day_events = by_date.get(iso, [])
        ins = sum(e["amount"] for e in day_events if e["amount"] > 0)
        outs = sum(e["amount"] for e in day_events if e["amount"] < 0)
        cash += ins + outs + daily_drift
        timeline.append({
            "date": iso,
            "cash": round(cash, 2),
            "ins": round(ins, 2),
            "outs": round(outs, 2),
            "drift": round(daily_drift, 2),
            "events": day_events,
        })
        cursor = _add_days(cursor, 1)
    return timeline


def _snapshot(timeline: list[dict], days: int, start_cash: float) -> dict:
    if not timeline or days <= 0:
        return {"days": days, "cash": start_cash, "delta": 0.0, "date": None}
    idx = min(days - 1, len(timeline) - 1)
    row = timeline[idx]
    return {
        "days": days,
        "date": row["date"],
        "cash": row["cash"],
        "delta": round(row["cash"] - start_cash, 2),
    }


def _runway_days(start_cash: float, avg_monthly_net: float) -> Optional[float]:
    """Days of cash left at trailing burn rate. `None` when net is positive
    (no runway problem)."""
    if avg_monthly_net >= 0 or start_cash <= 0:
        return None
    monthly_burn = abs(avg_monthly_net)
    return round(start_cash / monthly_burn * 30.0, 1)


def _insights(
    start_cash: float, timeline: list[dict], runway_days: Optional[float],
    events: list[dict],
) -> list[dict]:
    """Return 3–5 short, actionable notes for the AI Insights panel."""
    out: list[dict] = []
    if not timeline:
        return out
    # 1. Lowest point in the horizon
    low = min(timeline, key=lambda r: r["cash"])
    if low["cash"] < start_cash:
        sev = "critical" if low["cash"] < 0 else ("warning" if low["cash"] < start_cash * 0.25 else "info")
        note = (
            f"Cash dips to ${low['cash']:,.2f} on {low['date']}"
            if low["cash"] >= 0
            else f"Cash goes negative — projected ${low['cash']:,.2f} on {low['date']}"
        )
        out.append({"severity": sev, "date": low["date"], "message": note})
    # 2. Runway
    if runway_days is not None:
        sev = "critical" if runway_days < 60 else ("warning" if runway_days < 120 else "info")
        out.append({
            "severity": sev,
            "message": f"At current burn rate you have ~{runway_days:.0f} days of runway.",
        })
    # 3. Biggest single-day outflow
    outs = [e for e in events if e["amount"] < 0]
    if outs:
        biggest = min(outs, key=lambda e: e["amount"])
        out.append({
            "severity": "info", "date": biggest["date"],
            "message": f"Biggest scheduled outflow: {biggest['label']} — ${abs(biggest['amount']):,.2f} on {biggest['date']}.",
        })
    # 4. AR haircut summary
    ar_gross = sum(e.get("gross", 0) for e in events if e.get("kind") == "invoice")
    ar_expected = sum(e["amount"] for e in events if e.get("kind") == "invoice")
    if ar_gross > 0:
        haircut = 1 - (ar_expected / ar_gross)
        out.append({
            "severity": "info",
            "message": f"Open AR: ${ar_gross:,.2f} gross → ${ar_expected:,.2f} expected "
                       f"after aging haircut ({haircut*100:.0f}% discount).",
        })
    return out


# =============================================================================
# Endpoints
# =============================================================================

@router.get("/companies/{cid}/projections/cashflow")
async def projections_cashflow(
    cid: str,
    days: int = Query(120, ge=30, le=365),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    today = _today()
    horizon_end = _add_days(today, days)

    settings = await _get_settings(cid)
    cash, cash_breakdown = await _cash_balance(cid)
    burn = await _historical_burn(cid, today)

    # Assemble all scheduled events.
    events: list[dict] = []
    events += await _open_invoice_events(cid, settings["ar_haircuts"], today)
    events += await _open_bill_events(cid, today, horizon_end)
    events += await _loan_events(cid, today, horizon_end)
    events += await _payroll_events(cid, today, horizon_end)
    events += await _sales_tax_events(cid, today, horizon_end)
    events += _recurring_events_from_custom(settings["custom_recurring"], today, horizon_end)

    # Compute a "residual" daily drift = trailing net minus what we've
    # already captured explicitly. Prevents double-counting the same
    # recurring payroll / bills that already appear as scheduled events.
    scheduled_monthly = 0.0
    for e in events:
        try:
            ed = date.fromisoformat(e["date"])
        except ValueError:
            continue
        if today <= ed <= _add_days(today, 30):
            scheduled_monthly += e["amount"]
    residual_monthly = burn.get("avg_monthly_net", 0.0) - scheduled_monthly
    daily_drift = round(residual_monthly / 30.0, 2)

    timeline = _compute_timeline(cash, today, horizon_end, events, daily_drift)

    snapshots = [
        _snapshot(timeline, n, cash) for n in (30, 60, 90, 120) if n <= days
    ]
    runway = _runway_days(cash, burn.get("avg_monthly_net", 0.0))
    insights = _insights(cash, timeline, runway, events)

    return {
        "as_of": _iso(today),
        "horizon_days": days,
        "horizon_end": _iso(horizon_end),
        "cash_today": cash,
        "cash_breakdown": cash_breakdown,
        "snapshots": snapshots,
        "runway_days": runway,
        "burn": burn,
        "daily_drift": daily_drift,
        "timeline": timeline,
        "events": events,
        "settings_summary": {
            "ar_haircuts": settings["ar_haircuts"],
            "custom_recurring_count": len([r for r in settings["custom_recurring"] if r.get("active") is not False]),
        },
        "insights": insights,
    }


# ---- Settings + custom recurring ------------------------------------------

class SettingsIn(BaseModel):
    ar_haircuts: Optional[dict[str, float]] = None


@router.get("/companies/{cid}/projections/settings")
async def get_projection_settings(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    return await _get_settings(cid)


@router.post("/companies/{cid}/projections/settings")
async def save_projection_settings(
    cid: str, inp: SettingsIn, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    if inp.ar_haircuts:
        for k in inp.ar_haircuts:
            if k not in DEFAULT_HAIRCUTS:
                raise HTTPException(400, f"Unknown AR bucket: {k}")
            v = float(inp.ar_haircuts[k])
            if v < 0 or v > 1:
                raise HTTPException(400, f"{k} must be between 0 and 1")
    now = now_iso()
    updates: dict[str, Any] = {
        "updated_at": now,
        "updated_by": user.get("email") or user.get("id"),
    }
    if inp.ar_haircuts:
        updates["ar_haircuts"] = {**DEFAULT_HAIRCUTS, **inp.ar_haircuts}
    await db.projection_settings.update_one(
        {"company_id": cid},
        {"$set": {"company_id": cid, **updates}},
        upsert=True,
    )
    return await _get_settings(cid)


class RecurringIn(BaseModel):
    label: str
    amount: float
    cadence: str
    next_date: Optional[str] = None
    active: bool = True


@router.get("/companies/{cid}/projections/recurring")
async def list_recurring(cid: str, user: dict = Depends(get_current_user)):
    """Merged auto-detected + user-added recurring cashflows.

    Auto-detection = simple heuristic on rules table + historical
    transaction cadence. User adds live in `projection_settings.custom_recurring`.
    """
    await require_company(user, cid)
    settings = await _get_settings(cid)
    # Auto-detect: use rules whose category account is a P&L account to
    # infer expected recurring inflows/outflows. Basic — v2 will use a
    # cadence detector on transaction history.
    auto: list[dict] = []
    rules = await db.rules.find({"company_id": cid}).limit(200).to_list(200)
    for r in rules:
        if not r.get("enabled", True):
            continue
        # If the rule has been hit >= 3 times in the last 90 days it's
        # probably recurring. Cheap proxy: rule.hit_count.
        hits = int(r.get("hit_count") or 0)
        if hits < 3:
            continue
        auto.append({
            "id": f"auto-{r.get('id')}",
            "label": (r.get("description_pattern") or r.get("pattern") or r.get("name") or "Recurring")[:60],
            "amount": None,  # amount unknown from rule alone — display "auto-detected"
            "cadence": "monthly",
            "source": "rule",
            "hit_count": hits,
            "editable": False,
        })
    return {
        "auto": auto,
        "custom": settings["custom_recurring"],
    }


@router.post("/companies/{cid}/projections/recurring")
async def add_recurring(
    cid: str, inp: RecurringIn, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    if inp.cadence not in VALID_CADENCE:
        raise HTTPException(400, f"Bad cadence: {inp.cadence}")
    item = {
        "id": str(uuid.uuid4()),
        "label": inp.label.strip()[:80] or "Custom",
        "amount": round(float(inp.amount), 2),
        "cadence": inp.cadence,
        "next_date": inp.next_date or _iso(_today()),
        "active": bool(inp.active),
        "source": "user",
        "editable": True,
        "created_at": now_iso(),
        "created_by": user.get("email") or user.get("id"),
    }
    await db.projection_settings.update_one(
        {"company_id": cid},
        {"$setOnInsert": {"company_id": cid, "ar_haircuts": DEFAULT_HAIRCUTS},
         "$push": {"custom_recurring": item},
         "$set": {"updated_at": now_iso(), "updated_by": user.get("email") or user.get("id")}},
        upsert=True,
    )
    return {"ok": True, "item": item}


@router.delete("/companies/{cid}/projections/recurring/{rid}")
async def delete_recurring(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    r = await db.projection_settings.update_one(
        {"company_id": cid},
        {"$pull": {"custom_recurring": {"id": rid}},
         "$set": {"updated_at": now_iso(), "updated_by": user.get("email") or user.get("id")}},
    )
    if r.modified_count == 0:
        raise HTTPException(404, "Recurring item not found")
    return {"ok": True}
