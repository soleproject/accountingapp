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

DEFAULT_SALES_TAX = {"frequency": "monthly", "due_day": 20}
VALID_TAX_FREQ = {"monthly", "quarterly", "annual"}

# Pattern weighting by detection confidence (Xero/Float-style: low-confidence
# detections are listed for review but not booked until the user confirms).
PATTERN_WEIGHT = {"high": 1.0, "medium": 0.85}
MAX_LATENESS_DAYS = 60
AR_EXCLUDE_AFTER_DAYS = 60   # >60d overdue → out of the base case until an expected date is set
PAYROLL_RE = r"payroll|gusto|adp|paychex|quickbooks payroll|intuit payroll|rippling|justworks|onpay"


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

    Uses the most trustworthy source available per account:
      1. Live Plaid balance (from `plaid_items.accounts[].balance_current`)
         matched to the ledger account by mask. This is the "actual bank
         balance right now" number and is always the anchor of truth.
      2. GL fallback — the same signed balance the Balance Sheet report
         computes (opening balance + every posted journal line through
         today, sign-correct per debit/credit convention). Used when the
         company isn't linked to Plaid or when a particular account has
         no live Plaid mask.
    """
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset", "detail_type": "cash_and_bank",
    }).to_list(500)
    if not accts:
        return 0.0, []
    today_iso = _iso(_today())
    # GL balances — canonical Balance-Sheet numbers per account (opening
    # balance + every posted JE line through today, sign-correct).
    from reports import _signed_balances
    gl_by_acct = await _signed_balances(cid, start=None, end=today_iso,
                                        include_pre_period=True, basis="accrual")
    # Live Plaid balances keyed by mask (last-4).
    plaid_by_mask: dict[str, dict] = {}
    async for pi in db.plaid_items.find({"company_id": cid}):
        for pa in (pi.get("accounts") or []):
            mask = str(pa.get("mask") or "").strip()
            if mask and pa.get("balance_current") is not None:
                plaid_by_mask[mask] = {
                    "balance_current": float(pa["balance_current"]),
                    "as_of": pi.get("balance_snapshot_at") or pi.get("updated_at"),
                }
    breakdown: list[dict] = []
    total = 0.0
    for a in accts:
        aid = a["id"]
        last4 = str(a.get("last4") or "").strip()
        plaid = plaid_by_mask.get(last4) if last4 else None
        if plaid:
            bal = round(plaid["balance_current"], 2)
            source = "plaid_live"
            as_of = plaid.get("as_of")
        else:
            bal = round(float(gl_by_acct.get(aid, 0.0)), 2)
            source = "gl"
            as_of = today_iso
        total += bal
        breakdown.append({
            "id": aid,
            "name": a.get("name"),
            "code": a.get("code"),
            "last4": last4 or None,
            "balance": bal,
            "balance_source": source,
            "balance_as_of": as_of,
        })
    return round(total, 2), breakdown


async def _get_settings(cid: str) -> dict:
    doc = await db.projection_settings.find_one({"company_id": cid}) or {}
    doc.pop("_id", None)
    return {
        "company_id": cid,
        "ar_haircuts": {**DEFAULT_HAIRCUTS, **(doc.get("ar_haircuts") or {})},
        "sales_tax": {**DEFAULT_SALES_TAX, **(doc.get("sales_tax") or {})},
        "custom_recurring": doc.get("custom_recurring") or [],
        "updated_at": doc.get("updated_at"),
        "updated_by": doc.get("updated_by"),
    }


async def _customer_lateness(cid: str) -> tuple[dict[str, int], int]:
    """Float-style "Smart Expected Dates": median days-late per customer from
    their paid invoices (≥2 samples), plus the company-wide median fallback.
    Lateness is clamped to [0, MAX_LATENESS_DAYS]; early payers count as 0."""
    paid_on: dict[str, str] = {}
    async for p in db.payments.find({"company_id": cid}, {"date": 1, "applications": 1, "invoice_id": 1, "linked_invoice_id": 1}):
        d = (p.get("date") or "")[:10]
        if not d:
            continue
        ids = [a.get("invoice_id") for a in (p.get("applications") or []) if a.get("invoice_id")]
        ids += [p.get("invoice_id"), p.get("linked_invoice_id")]
        for iid in ids:
            if iid and d > paid_on.get(iid, ""):
                paid_on[iid] = d
    if not paid_on:
        return {}, 0
    per_customer: dict[str, list[int]] = defaultdict(list)
    all_late: list[int] = []
    async for inv in db.invoices.find(
        {"company_id": cid, "id": {"$in": list(paid_on)}, "status": "paid"},
        {"id": 1, "due_date": 1, "issue_date": 1, "customer_id": 1},
    ):
        due = (inv.get("due_date") or inv.get("issue_date") or "")[:10]
        try:
            late = (date.fromisoformat(paid_on[inv["id"]]) - date.fromisoformat(due)).days
        except ValueError:
            continue
        late = max(0, min(MAX_LATENESS_DAYS, late))
        all_late.append(late)
        if inv.get("customer_id"):
            per_customer[inv["customer_id"]].append(late)
    from statistics import median
    by_customer = {c: int(round(median(v))) for c, v in per_customer.items() if len(v) >= 2}
    company = int(round(median(all_late))) if all_late else 0
    return by_customer, company


async def _open_invoice_events(cid: str, haircuts: dict, today: date) -> tuple[list[dict], list[dict]]:
    """Expected inflows from open AR.

    Rules (QBO/Xero/Float-aligned):
      • `expected_payment_date` set on the invoice → lands there, haircut by aging.
      • Not yet due → due_date + that customer's typical lateness, haircut d0_30.
      • ≤30d overdue → max(due + lateness, today+3), haircut d0_30.
      • 31–60d overdue → today + 14, haircut d30_60.
      • >60d overdue → EXCLUDED from the base case (returned separately so the
        UI can ask for an expected date), unless `expected_payment_date` is set.
    """
    invs = await db.invoices.find({
        "company_id": cid,
        "status": {"$nin": ["paid", "void", "voided"]},
    }).to_list(5000)
    lateness_by_customer, company_lateness = await _customer_lateness(cid)
    events: list[dict] = []
    excluded: list[dict] = []
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
        if days_over <= 30:
            hc_key = "d0_30"
        elif days_over <= 60:
            hc_key = "d30_60"
        elif days_over <= 90:
            hc_key = "d60_90"
        else:
            hc_key = "d90_plus"
        customer = inv.get("customer_id")
        lateness = lateness_by_customer.get(customer, company_lateness)
        expected = None
        try:
            if inv.get("expected_payment_date"):
                expected = date.fromisoformat(str(inv["expected_payment_date"])[:10])
        except ValueError:
            expected = None
        base = {
            "gross": round(bal, 2),
            "label": f"Invoice #{inv.get('number') or inv.get('id', '')[:8]}",
            "kind": "invoice",
            "haircut_bucket": hc_key,
            "invoice_id": inv.get("id"),
            "contact_id": customer,
            "contact_name": inv.get("customer_name") or "",
            "due_date": _iso(due_d),
            "days_overdue": max(0, days_over),
            "lateness_days": lateness,
        }
        if expected:
            landing = expected if expected > today else _add_days(today, 3)
            base["expected_payment_date"] = _iso(expected)
        elif days_over <= 0:
            landing = _add_days(due_d, lateness)
        elif days_over <= 30:
            landing = max(_add_days(due_d, lateness), _add_days(today, 3))
        elif days_over <= AR_EXCLUDE_AFTER_DAYS:
            landing = _add_days(today, 14)
        else:
            excluded.append({**base, "reason": "overdue_no_expected_date"})
            continue
        prob = float(haircuts.get(hc_key, DEFAULT_HAIRCUTS[hc_key]))
        events.append({
            **base,
            "date": _iso(landing),
            "amount": round(bal * prob, 2),
            "probability": prob,
        })
    return events, excluded


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
            "label": f"Bill {b.get('number') or ''} · {b.get('vendor_name') or b.get('contact_name') or ''}".replace("  ", " ").strip(" ·"),
            "kind": "bill",
            "bill_id": b.get("id"),
            "contact_id": b.get("vendor_id"),
            "contact_name": b.get("vendor_name") or "",
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
    """Upcoming payroll runs.

    Frequency comes from `responsibilities.payroll_frequency`; when unset we
    INFER it from the cadence of payroll-tagged transactions (≥3 in the last
    120 days) rather than silently omitting payroll — the single largest
    outflow for most small businesses. Amount = mean of the last 6 runs.
    """
    co = await db.companies.find_one({"id": cid}, {"responsibilities": 1})
    freq = ((co or {}).get("responsibilities") or {}).get("payroll_frequency")
    delta_map = {"weekly": 7, "biweekly": 14, "semimonthly": 15, "monthly": 30}
    txns = await db.transactions.find({
        "company_id": cid,
        "amount": {"$lt": 0},
        "$or": [
            {"category_account_name": {"$regex": "payroll", "$options": "i"}},
            {"description": {"$regex": PAYROLL_RE, "$options": "i"}},
        ],
    }).sort("date", -1).limit(12).to_list(12)
    if not txns:
        return []
    inferred = False
    if not freq or freq not in delta_map:
        recent = []
        for t in txns:
            try:
                d = date.fromisoformat(t["date"][:10])
            except (KeyError, ValueError):
                continue
            if (today - d).days <= 120:
                recent.append(d)
        recent.sort()
        if len(recent) < 3:
            return []
        gaps = sorted((recent[i] - recent[i - 1]).days for i in range(1, len(recent)))
        med = gaps[len(gaps) // 2]
        freq = next((f for f, dd in delta_map.items() if abs(med - dd) <= 2), None)
        if not freq:
            return []
        inferred = True
    delta_days = delta_map[freq]
    amounts = [abs(float(t.get("amount") or 0)) for t in txns[:6]]
    avg = round(sum(amounts) / len(amounts), 2) if amounts else 0.0
    if avg <= 0:
        return []
    try:
        anchor = date.fromisoformat(txns[0]["date"][:10])
    except (ValueError, KeyError):
        anchor = today
    events: list[dict] = []
    cursor = anchor
    while cursor <= today:
        cursor = _add_days(cursor, delta_days)
    while cursor <= horizon_end:
        events.append({
            "date": _iso(cursor),
            "amount": -avg,
            "label": f"Payroll ({freq}{', inferred' if inferred else ''})",
            "kind": "payroll",
            "inferred": inferred,
        })
        cursor = _add_days(cursor, delta_days)
    return events


def _tax_periods(today: date, horizon_end: date, frequency: str, due_day: int):
    """Yield (remit_date, period_start, period_end) for each remittance in the horizon."""
    months = {"monthly": 1, "quarterly": 3, "annual": 12}.get(frequency, 1)
    pm = today.month - 1 or 12
    y = today.year if today.month > 1 else today.year - 1
    m = ((pm - 1) // months) * months + 1  # cadence-aligned period containing last month
    for _ in range(14):
        p_start = date(y, m, 1)
        em = m + months - 1
        p_end = _month_end(date(y, em, 1))
        ny, nm = (y, em + 1) if em < 12 else (y + 1, 1)
        remit = date(ny, nm, min(due_day, monthrange(ny, nm)[1]))
        if remit > horizon_end:
            return
        if remit >= today:
            yield remit, p_start, p_end
        m += months
        if m > 12:
            m -= 12
            y += 1


async def _sales_tax_events(cid: str, today: date, horizon_end: date, tax_cfg: dict | None = None) -> list[dict]:
    """Next sales-tax remittances. Filing frequency + due day come from
    projection settings (`sales_tax`), default monthly on the 20th."""
    cfg = {**DEFAULT_SALES_TAX, **(tax_cfg or {})}
    frequency = cfg.get("frequency") if cfg.get("frequency") in VALID_TAX_FREQ else "monthly"
    due_day = max(1, min(28, int(cfg.get("due_day") or 20)))
    events: list[dict] = []
    seen: set[str] = set()
    for remit_date, start, end in _tax_periods(today, horizon_end, frequency, due_day):
        if _iso(start) in seen:
            continue
        seen.add(_iso(start))
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
            label = start.strftime("%b") if frequency == "monthly" else f"{start.strftime('%b')}–{end.strftime('%b')}"
            events.append({
                "date": _iso(remit_date),
                "amount": -net,
                "label": f"Sales-tax remittance ({label})",
                "kind": "sales_tax",
            })
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


async def _historical_burn(cid: str, today: date, lookback_days: int = 90) -> dict:
    """Trailing-N-day monthly in / out / net computed straight from bank
    activity. This is the ground-truth burn — no pattern detection, no
    scheduled event dependence, just what actually left/entered the cash
    accounts. 90 days (Xero/Float window) keeps it responsive to the
    business as it is now. Internal transfers between own accounts are
    excluded so moving money between pockets doesn't read as burn.
    """
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset", "detail_type": "cash_and_bank",
    }).to_list(500)
    if not accts:
        return {"avg_monthly_in": 0, "avg_monthly_out": 0, "avg_monthly_net": 0,
                "lookback_days": lookback_days,
                "trailing_start": _iso(today), "trailing_end": _iso(today)}
    acct_ids = [a["id"] for a in accts]
    start = _iso(_add_days(today, -lookback_days))
    end = _iso(today)
    agg = await db.transactions.aggregate([
        {"$match": {
            "company_id": cid,
            "$or": [
                {"bank_account_id": {"$in": acct_ids}},
                {"account_id":      {"$in": acct_ids}},
            ],
            "date": {"$gte": start, "$lte": end},
            "transfer_pair_id": {"$in": [None, ""]},
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
    months = max(1.0, lookback_days / 30.0)
    avg_in = round(tot_in / months, 2)
    avg_out = round(tot_out / months, 2)  # negative
    net = round(avg_in + avg_out, 2)
    return {
        "avg_monthly_in": avg_in,
        "avg_monthly_out": avg_out,
        "avg_monthly_net": net,
        "lookback_days": lookback_days,
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


def _pattern_events(
    patterns: list[dict], today: date, horizon_end: date,
) -> list[dict]:
    """Convert detected recurring patterns into forecast events.

    Skip patterns marked `rejected`. Amounts are weighted by detection
    confidence (high 1.0, medium 0.85); low-confidence patterns are only
    booked once the user has explicitly confirmed them (`user_confirmed`).
    Emits an event at each expected date up to the horizon.
    """
    out: list[dict] = []
    for p in patterns:
        if p.get("status") == "rejected":
            continue
        conf = p.get("confidence") or "low"
        weight = 1.0 if p.get("user_confirmed") else PATTERN_WEIGHT.get(conf)
        if weight is None:
            continue
        amount = float(p.get("median_amount") or 0)
        if amount == 0:
            continue
        cadence = p.get("cadence")
        delta = {"weekly": 7, "biweekly": 14, "semimonthly": 15,
                 "monthly": 30, "quarterly": 91, "annual": 365}.get(cadence)
        if not delta:
            continue
        try:
            cursor = date.fromisoformat((p.get("next_expected_date") or "")[:10])
        except ValueError:
            continue
        preferred_dom = p.get("preferred_day_of_month")
        # Emit through the horizon.
        while cursor <= horizon_end:
            if cursor >= today:
                out.append({
                    "date": _iso(cursor),
                    "amount": round(amount * weight, 2),
                    "gross": round(amount, 2),
                    "weight": weight,
                    "label": p.get("label") or "Recurring",
                    "kind": "pattern",
                    "source": p.get("source") or "local",
                    "cadence": cadence,
                    "confidence": conf,
                    "account_id": p.get("account_id"),
                    "pattern_key": p.get("pattern_key"),
                    "contact_id": p.get("contact_id"),
                    "contact_name": p.get("label") if p.get("contact_id") else "",
                })
            if cadence in ("monthly", "quarterly", "annual") and preferred_dom:
                # Advance by month (or 3 / 12 months) and snap to preferred day.
                months = {"monthly": 1, "quarterly": 3, "annual": 12}[cadence]
                new_y = cursor.year
                new_m = cursor.month + months
                while new_m > 12:
                    new_m -= 12
                    new_y += 1
                last = monthrange(new_y, new_m)[1]
                cursor = date(new_y, new_m, min(preferred_dom, last))
            else:
                cursor = _add_days(cursor, delta)
    return out


def _dedup_events(events: list[dict]) -> list[dict]:
    """Drop pattern-detected events that collide with an explicit event.

    Rules for "collision":
      • same sign (both inflow or both outflow)
      • within ±5 days of an explicit event
      • amount within 20% of the explicit event

    Explicit events are anything with kind != 'pattern' (invoice, bill,
    loan, payroll, sales_tax, custom).
    """
    explicit = [e for e in events if e.get("kind") != "pattern"]
    patterns = [e for e in events if e.get("kind") == "pattern"]
    kept: list[dict] = list(explicit)
    import re as _re
    payroll_rx = _re.compile(PAYROLL_RE, _re.I)
    has_payroll = any(e.get("kind") == "payroll" for e in explicit)
    custom_labels = {(e.get("label") or "").strip().lower() for e in explicit if e.get("kind") == "custom"}
    for p in patterns:
        plabel = (p.get("label") or "").strip().lower()
        # Payroll is modelled explicitly; a detected payroll stream would double count.
        if has_payroll and p["amount"] < 0 and payroll_rx.search(plabel):
            continue
        # A user-entered custom item for the same vendor wins over detection.
        if plabel and any(plabel in c or c in plabel for c in custom_labels if c):
            continue
        try:
            pd = date.fromisoformat(p["date"])
        except ValueError:
            continue
        pa = float(p["amount"])
        collided = False
        for ex in explicit:
            try:
                ed = date.fromisoformat(ex["date"])
            except ValueError:
                continue
            if (pa > 0) != (float(ex["amount"]) > 0):
                continue
            if abs((pd - ed).days) > 5:
                continue
            denom = max(abs(pa), abs(float(ex["amount"])), 0.01)
            if abs(pa - float(ex["amount"])) / denom <= 0.20:
                collided = True
                break
        if not collided:
            kept.append(p)
    return kept


def _per_account_timelines(
    accts: list[dict], today: date, horizon_end: date, events: list[dict],
) -> dict[str, list[dict]]:
    """Build a daily cash timeline per cash account.

    Routing rule: events with an explicit `account_id` land there.
    Events without one (open bills, invoices, sales-tax remittance)
    route to the largest cash account by starting balance — the
    "primary operating account" heuristic.
    """
    if not accts:
        return {}
    primary = max(accts, key=lambda a: a.get("balance", 0.0))
    by_acct_events: dict[str, list[dict]] = {a["id"]: [] for a in accts}
    for e in events:
        aid = e.get("account_id") or primary["id"]
        if aid in by_acct_events:
            by_acct_events[aid].append(e)
        else:
            # Pattern was tagged to an account we no longer hold — send
            # it to the primary.
            by_acct_events[primary["id"]].append(e)
    out: dict[str, list[dict]] = {}
    for a in accts:
        aid = a["id"]
        by_date: dict[str, float] = defaultdict(float)
        for e in by_acct_events[aid]:
            by_date[e["date"]] += float(e["amount"])
        cash = float(a.get("balance", 0.0))
        rows: list[dict] = []
        cursor = today
        while cursor <= horizon_end:
            iso = _iso(cursor)
            cash += by_date.get(iso, 0.0)
            rows.append({"date": iso, "cash": round(cash, 2)})
            cursor = _add_days(cursor, 1)
        out[aid] = rows
    return out


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


def _forward_metrics(timeline: list[dict], start_cash: float) -> dict:
    """Runway + forward burn derived from the projected timeline itself
    (not trailing history). This is what actually matches the chart the
    user sees.

    Runway strategy:
      • If cash today is already ≤ 0 → 0 days.
      • Else find the first row in the timeline where cash ≤ 0 → that's
        the runway in days.
      • Else if forward burn is ≥ $0/day (cash never dips) → None (∞).
      • Else extrapolate: (last_cash / daily_burn) beyond the horizon.

    Forward burn strategy:
      • Take the net change from day 7 → end of the horizon, divided by
        the number of days. Day-7 anchor smooths out the initial "spike"
        where open invoices tend to land quickly.
    """
    if not timeline:
        return {"runway_days": None, "forward_daily_burn": 0.0, "forward_monthly_burn": 0.0}
    # Forward burn — measured from day 7 to end so early AR spikes don't
    # skew the trend.
    anchor_idx = min(7, len(timeline) - 1)
    anchor_row = timeline[anchor_idx]
    last_row = timeline[-1]
    days_span = len(timeline) - anchor_idx - 1
    if days_span > 0:
        delta = last_row["cash"] - anchor_row["cash"]
        daily = delta / days_span
    else:
        daily = 0.0
    daily_burn = -daily
    monthly_burn = round(daily_burn * 30.0, 2)
    # Runway — first zero-crossing in the timeline.
    runway_days: Optional[float] = None
    if start_cash <= 0:
        runway_days = 0.0
    else:
        for i, row in enumerate(timeline):
            if row["cash"] <= 0:
                runway_days = float(i + 1)
                break
        # Extrapolate runway beyond horizon if cash never hit zero but
        # is trending down.
        if runway_days is None and daily_burn > 0.01 and last_row["cash"] > 0:
            runway_days = round(len(timeline) + (last_row["cash"] / daily_burn), 1)
    return {
        "runway_days": runway_days,
        "forward_daily_burn": round(daily_burn, 2),
        "forward_monthly_burn": monthly_burn,
    }


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


async def _forecast_confidence(cid: str, today: date, cash_breakdown: list[dict],
                               patterns: list[dict], burn: dict) -> dict:
    """Xero-style data-quality gate: how much should the owner trust this
    line? Scores the inputs the forecast depends on and explains each ding."""
    score = 100
    reasons: list[str] = []
    start_90 = _iso(_add_days(today, -90))
    # 1. Bank freshness
    live = [a for a in cash_breakdown if a.get("balance_source") == "plaid_live"]
    if cash_breakdown and not live:
        score -= 15
        reasons.append("No live bank balance — cash anchored on the ledger")
    else:
        stale = []
        for a in live:
            try:
                as_of = datetime.fromisoformat(str(a.get("balance_as_of")).replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - as_of).days > 3:
                    stale.append(a.get("name"))
            except (TypeError, ValueError):
                continue
        if stale:
            score -= 10
            reasons.append(f"Bank sync older than 3 days ({', '.join(str(s) for s in stale[:2])})")
    # 2. Categorization completeness (last 90 days)
    total_90 = await db.transactions.count_documents({"company_id": cid, "date": {"$gte": start_90}})
    if total_90:
        uncat = await db.transactions.count_documents({
            "company_id": cid, "date": {"$gte": start_90},
            "$or": [{"category_account_id": {"$in": [None, ""]}}, {"needs_review": True}],
        })
        pct = uncat / total_90
        if pct > 0.25:
            score -= 25
            reasons.append(f"{uncat} of {total_90} recent transactions uncategorized or flagged")
        elif pct > 0.10:
            score -= 12
            reasons.append(f"{uncat} recent transactions still need review")
    # 3. History depth
    first = await db.transactions.find_one({"company_id": cid}, {"date": 1}, sort=[("date", 1)])
    if not first:
        score -= 40
        reasons.append("No transaction history yet")
    else:
        try:
            age = (today - date.fromisoformat(first["date"][:10])).days
        except (KeyError, ValueError):
            age = 0
        if age < 90:
            score -= 20
            reasons.append(f"Only {age} days of history — recurring detection needs ~90")
    # 4. Last complete month reconciled / closed?
    pm = today.month - 1 or 12
    py = today.year if today.month > 1 else today.year - 1
    closed = await db.month_close_signoffs.find_one({"company_id": cid, "year": py, "month": pm, "kind": "closed"})
    if not closed and total_90:
        score -= 10
        reasons.append(f"{date(py, pm, 1).strftime('%B')} not yet closed")
    # 5. Unconfirmed low-confidence detections
    low_unconfirmed = sum(1 for p in patterns if p.get("confidence") == "low" and not p.get("user_confirmed") and p.get("status") != "rejected")
    if low_unconfirmed:
        reasons.append(f"{low_unconfirmed} low-confidence recurring detections awaiting review (not booked)")
    level = "high" if score >= 80 else ("medium" if score >= 55 else "low")
    return {"level": level, "score": max(0, score), "reasons": reasons}


# =============================================================================
# Endpoints
# =============================================================================

@router.get("/companies/{cid}/projections/cashflow")
async def projections_cashflow(
    cid: str,
    days: int = Query(120, ge=1, le=730),
    start_date: Optional[str] = Query(None, description="ISO YYYY-MM-DD; overrides today"),
    end_date: Optional[str] = Query(None, description="ISO YYYY-MM-DD; when set with start_date, overrides `days`"),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    today = _today()
    # Custom range takes precedence over the `days` shortcut.
    if start_date:
        try:
            today = date.fromisoformat(start_date[:10])
        except ValueError:
            raise HTTPException(400, "start_date must be YYYY-MM-DD")
    if end_date:
        try:
            horizon_end = date.fromisoformat(end_date[:10])
        except ValueError:
            raise HTTPException(400, "end_date must be YYYY-MM-DD")
        if horizon_end < today:
            raise HTTPException(400, "end_date must be on/after start_date")
        days = (horizon_end - today).days
    else:
        horizon_end = _add_days(today, days)

    settings = await _get_settings(cid)
    cash, cash_breakdown = await _cash_balance(cid)
    burn = await _historical_burn(cid, today)

    # Load auto-applied patterns from the last detection run. If none
    # exist yet, kick off a detection so the user sees signal on their
    # first visit.
    from routes.projection_patterns import load_active_patterns, detect_patterns
    import logging
    patterns = await load_active_patterns(cid)
    if not patterns:
        # First-visit auto-scan. Cheap for empty ledgers, safe otherwise.
        try:
            await detect_patterns(cid)
            patterns = await load_active_patterns(cid)
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning("pattern detection failed for %s: %s", cid, e)
            patterns = []

    # Assemble every scheduled event — explicit sources first, then
    # pattern-detected additions on top.
    events: list[dict] = []
    ar_events, excluded_ar = await _open_invoice_events(cid, settings["ar_haircuts"], today)
    events += ar_events
    events += await _open_bill_events(cid, today, horizon_end)
    events += await _loan_events(cid, today, horizon_end)
    events += await _payroll_events(cid, today, horizon_end)
    events += await _sales_tax_events(cid, today, horizon_end, settings["sales_tax"])
    events += _recurring_events_from_custom(settings["custom_recurring"], today, horizon_end)
    events += _pattern_events(patterns, today, horizon_end)
    # Dedup pattern events that collide with explicit ones (bill vs
    # detected rent, etc.).
    events = _dedup_events(events)

    # Ground-truth burn: what the bank statements actually show. This is
    # the anchor number — no pattern guessing, just historical fact.
    # We then compare it to what our scheduled + pattern events explain
    # over the next 30 days, and route any leftover through `daily_drift`
    # so the forward forecast matches reality (contractor payments, one-
    # off supplies, transfers — anything that never fits a recurring
    # definition but is real cash going out).
    scheduled_monthly_net = 0.0
    for e in events:
        try:
            ed = date.fromisoformat(e["date"])
        except ValueError:
            continue
        if today <= ed <= _add_days(today, 30):
            scheduled_monthly_net += float(e["amount"])
    hist_net = float(burn.get("avg_monthly_net", 0.0))
    residual_monthly = hist_net - scheduled_monthly_net
    # Cap the residual at the historical gross out/in so one unusual month
    # in the lookback can't dominate the forward line.
    cap = max(abs(float(burn.get("avg_monthly_out", 0.0))), abs(float(burn.get("avg_monthly_in", 0.0))), 0.0)
    residual_capped = residual_monthly != max(-cap, min(cap, residual_monthly))
    residual_monthly = max(-cap, min(cap, residual_monthly))
    daily_drift = round(residual_monthly / 30.0, 2)

    timeline = _compute_timeline(cash, today, horizon_end, events, daily_drift)

    # Conservative case: no AR collected at all, only high-confidence or
    # user-confirmed recurring items, same explicit obligations + drift.
    conservative_events = [
        e for e in events
        if e.get("kind") != "invoice"
        and not (e.get("kind") == "pattern" and e.get("amount", 0) > 0 and e.get("confidence") != "high" and e.get("weight", 1) < 1)
    ]
    timeline_conservative = [
        {"date": r["date"], "cash": r["cash"]}
        for r in _compute_timeline(cash, today, horizon_end, conservative_events, daily_drift)
    ]

    snapshots = [
        _snapshot(timeline, n, cash) for n in (30, 60, 90, 120) if n <= days
    ]
    forward = _forward_metrics(timeline, cash)
    insights = _insights(cash, timeline, forward["runway_days"], events)
    if excluded_ar:
        gross_excl = sum(e["gross"] for e in excluded_ar)
        insights.insert(0, {
            "severity": "warning",
            "message": f"{len(excluded_ar)} invoice(s) totalling ${gross_excl:,.2f} are >60 days overdue and "
                       f"excluded from the forecast until you set an expected payment date.",
        })
    per_account = _per_account_timelines(cash_breakdown, today, horizon_end, events)
    confidence = await _forecast_confidence(cid, today, cash_breakdown, patterns, burn)

    # Pattern review summary — this is what feeds the "Review detections"
    # chip on the header.
    pattern_summary = {
        "total": len(patterns),
        "high":   sum(1 for p in patterns if p.get("confidence") == "high"),
        "medium": sum(1 for p in patterns if p.get("confidence") == "medium"),
        "low":    sum(1 for p in patterns if p.get("confidence") == "low"),
        "plaid":  sum(1 for p in patterns if p.get("source") == "plaid"),
    }

    low_cons_30 = min((r["cash"] for r in timeline_conservative[:31]), default=cash)
    return {
        "as_of": _iso(today),
        "horizon_days": days,
        "horizon_end": _iso(horizon_end),
        "cash_today": cash,
        "cash_breakdown": cash_breakdown,
        "snapshots": snapshots,
        "runway_days": forward["runway_days"],
        "forward_daily_burn": forward["forward_daily_burn"],
        "forward_monthly_burn": forward["forward_monthly_burn"],
        "burn": burn,
        "daily_drift": daily_drift,
        # Transparent 3-line reconciliation between the projected forward
        # burn and the ground-truth historical burn. Sanity-check for the
        # CPA: "My bank statement burn is $14K, patterns cover $8K, and
        # $6K is unexplained residual spread evenly across the forecast."
        "burn_reconciliation": {
            "historical_monthly_net": hist_net,
            "historical_monthly_out": float(burn.get("avg_monthly_out", 0.0)),
            "historical_monthly_in":  float(burn.get("avg_monthly_in",  0.0)),
            "scheduled_next_30d_net": round(scheduled_monthly_net, 2),
            "unexplained_residual_monthly": round(residual_monthly, 2),
            "residual_capped": residual_capped,
            "lookback_days": int(burn.get("lookback_days", 90)),
        },
        "timeline": timeline,
        "timeline_conservative": timeline_conservative,
        "conservative": {
            "ending_cash": timeline_conservative[-1]["cash"] if timeline_conservative else cash,
            "low_30d": round(low_cons_30, 2),
            "assumptions": "No open invoices collected; only high-confidence or confirmed recurring inflows.",
        },
        "timeline_per_account": per_account,
        "events": events,
        "excluded_ar": excluded_ar,
        "confidence": confidence,
        "settings_summary": {
            "ar_haircuts": settings["ar_haircuts"],
            "sales_tax": settings["sales_tax"],
            "custom_recurring_count": len([r for r in settings["custom_recurring"] if r.get("active") is not False]),
        },
        "pattern_summary": pattern_summary,
        "insights": insights,
    }


# ---- Settings + custom recurring ------------------------------------------

class SettingsIn(BaseModel):
    ar_haircuts: Optional[dict[str, float]] = None
    sales_tax: Optional[dict[str, Any]] = None


class ExpectedDateIn(BaseModel):
    expected_payment_date: Optional[str] = None  # ISO date or null to clear


@router.post("/companies/{cid}/projections/invoices/{iid}/expected-date")
async def set_invoice_expected_date(
    cid: str, iid: str, inp: ExpectedDateIn, user: dict = Depends(get_current_user),
):
    """QBO/Xero-style: owner tells us when an overdue invoice will really be
    paid. Lives on the invoice (`expected_payment_date`) — never touches due_date."""
    await require_company(user, cid)
    val = None
    if inp.expected_payment_date:
        try:
            val = _iso(date.fromisoformat(inp.expected_payment_date[:10]))
        except ValueError:
            raise HTTPException(400, "expected_payment_date must be YYYY-MM-DD")
    r = await db.invoices.update_one(
        {"id": iid, "company_id": cid},
        {"$set": {"expected_payment_date": val, "expected_payment_set_by": user.get("email") or user.get("id"),
                  "expected_payment_set_at": now_iso()}},
    )
    if not r.matched_count:
        raise HTTPException(404, "Invoice not found")
    return {"ok": True, "invoice_id": iid, "expected_payment_date": val}


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
    if inp.sales_tax is not None:
        freq = str(inp.sales_tax.get("frequency") or DEFAULT_SALES_TAX["frequency"]).lower()
        if freq not in VALID_TAX_FREQ:
            raise HTTPException(400, f"sales_tax.frequency must be one of {sorted(VALID_TAX_FREQ)}")
        try:
            due_day = int(inp.sales_tax.get("due_day") or DEFAULT_SALES_TAX["due_day"])
        except (TypeError, ValueError):
            raise HTTPException(400, "sales_tax.due_day must be an integer")
        if not 1 <= due_day <= 28:
            raise HTTPException(400, "sales_tax.due_day must be between 1 and 28")
        updates["sales_tax"] = {"frequency": freq, "due_day": due_day}
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



# =============================================================================
# Historical ledger — what actually happens in the bank accounts
# =============================================================================

@router.get("/companies/{cid}/projections/historical-ledger")
async def historical_ledger(
    cid: str,
    days: int = Query(180, ge=30, le=730),
    user: dict = Depends(get_current_user),
):
    """Every real bank transaction from the last N days, keyed to real
    contacts, so the Ledger drawer can show a view whose totals actually
    reconcile with the bank feed.

    Complements the forecast-based ledger by answering the "what actually
    happens" question with facts, not projections. Recommended for the
    per-contact rollup because it captures the long tail (gas stations,
    restaurants, ad-hoc contractors) that the pattern detector will
    never label as "recurring."

    Returns:
        {
          "start": ISO, "end": ISO, "days": N,
          "txns": [{date, contact, amount, description, kind}],
          "daily_totals": [{date, ins, outs, net}],
          "per_contact": [{contact, direction, count, gross,
                           avg_monthly}],
          "totals": {gross_in, gross_out, net, avg_monthly_in,
                     avg_monthly_out, avg_monthly_net},
        }
    """
    await require_company(user, cid)
    today = _today()
    start = _add_days(today, -days)

    # Only look at bank-feed activity on cash accounts — same universe
    # the burn reconciliation uses so totals will match by design.
    accts = await db.accounts.find({
        "company_id": cid, "type": "asset", "detail_type": "cash_and_bank",
    }).to_list(500)
    acct_ids = [a["id"] for a in accts]

    txns = await db.transactions.find({
        "company_id": cid,
        "$or": [
            {"bank_account_id": {"$in": acct_ids}},
            {"account_id":      {"$in": acct_ids}},
        ],
        "date": {"$gte": _iso(start), "$lte": _iso(today)},
    }).sort("date", -1).to_list(20000)

    # Pull all contact names in one shot for efficient labelling.
    contact_ids = list({
        t.get("contact_id") or t.get("vendor_id") or t.get("customer_id")
        for t in txns
        if (t.get("contact_id") or t.get("vendor_id") or t.get("customer_id"))
    })
    contacts = {}
    if contact_ids:
        async for c in db.contacts.find({"id": {"$in": contact_ids}}):
            contacts[c["id"]] = c.get("name") or c.get("display_name") or ""

    slim_txns: list[dict] = []
    daily_ins: dict[str, float] = defaultdict(float)
    daily_outs: dict[str, float] = defaultdict(float)
    per_contact: dict[tuple, dict] = {}

    for t in txns:
        amt = float(t.get("amount") or 0)
        if amt == 0:
            continue
        cid_ = t.get("contact_id") or t.get("vendor_id") or t.get("customer_id")
        contact_name = (contacts.get(cid_) if cid_ else "") or t.get("contact_name") \
            or t.get("vendor_name") or t.get("customer_name") \
            or (t.get("description") or t.get("memo") or "Uncategorized")[:60]
        d = (t.get("date") or "")[:10]
        slim_txns.append({
            "date": d,
            "amount": round(amt, 2),
            "contact": contact_name,
            "contact_id": cid_,
            "description": t.get("description") or t.get("memo") or "",
            "category": t.get("category_account_name"),
        })
        if amt > 0:
            daily_ins[d] += amt
        else:
            daily_outs[d] += amt
        direction = "in" if amt > 0 else "out"
        pkey = (contact_name, direction)
        bucket = per_contact.setdefault(pkey, {
            "contact": contact_name, "direction": direction,
            "count": 0, "gross": 0.0,
        })
        bucket["count"] += 1
        bucket["gross"] += abs(amt)

    months = max(1.0, days / 30.0)
    for b in per_contact.values():
        b["avg_monthly"] = round(b["gross"] / months, 2)
        b["gross"] = round(b["gross"], 2)
    per_contact_list = sorted(per_contact.values(), key=lambda b: -b["avg_monthly"])

    gross_in = round(sum(daily_ins.values()), 2)
    gross_out = round(sum(daily_outs.values()), 2)  # negative
    net = round(gross_in + gross_out, 2)

    # Daily totals, sorted ascending so the ledger can compute a running
    # balance forward (opens with the historical-start cash balance).
    all_dates = sorted(set(list(daily_ins.keys()) + list(daily_outs.keys())))
    daily_totals = [{
        "date": d,
        "ins":  round(daily_ins.get(d, 0.0), 2),
        "outs": round(daily_outs.get(d, 0.0), 2),
        "net":  round(daily_ins.get(d, 0.0) + daily_outs.get(d, 0.0), 2),
    } for d in all_dates]

    return {
        "start": _iso(start),
        "end": _iso(today),
        "days": days,
        "txns": slim_txns,
        "daily_totals": daily_totals,
        "per_contact": per_contact_list,
        "totals": {
            "gross_in": gross_in,
            "gross_out": gross_out,
            "net": net,
            "avg_monthly_in":  round(gross_in / months, 2),
            "avg_monthly_out": round(gross_out / months, 2),
            "avg_monthly_net": round(net / months, 2),
        },
    }
