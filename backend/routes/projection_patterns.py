"""
Recurring-pattern detection for Projections.

Reads up to 365 days of historical transactions and detects recurring
cash flows the client hasn't explicitly declared (rent, payroll, ad
platform charges, retainer inflows, subscription revenue, etc.).

Persisted to the `recurring_patterns` collection so the forecast
endpoint can read them without re-running detection on every request.
Runs on-demand via `POST /api/companies/{cid}/projections/detect-patterns`
and (later) nightly.

Detection algorithm
===================
1. Fetch every transaction for the company from the last 365 days.
2. Group by *recurrence key*:
   • With contact:    (contact_id, sign, amount_bucket)
   • Without contact: (desc_fingerprint, sign, amount_bucket)
   where `amount_bucket` = round to nearest 5% so a $432 charge and a
   $431 charge cluster together.
3. For each group with ≥ 3 occurrences:
   • Compute intervals between consecutive dates.
   • Compute median_interval, interval_cv (σ/μ).
   • Compute median_amount, amount_cv.
   • Bucket cadence: weekly (5-8d), biweekly (12-16d), monthly (27-33d),
     quarterly (85-95d), else irregular (discard).
   • Record preferred day-of-month + day-of-week.
   • Apply recency filter: drop patterns whose `last_seen` is older
     than 2 × median_interval (i.e. missed too many cycles).
4. Score confidence:
   • high:   occ ≥ 6, interval_cv < 0.15, amount_cv < 0.15
   • medium: occ ≥ 4, interval_cv < 0.30, amount_cv < 0.30
   • low:    everything else that passes the min thresholds
5. Compute next_expected_date (last_seen + median_interval, snapped to
   preferred day where possible).
6. Upsert into `recurring_patterns`.

Recency filter rationale
========================
User wants: "if present in 9/12 months but not the last 2, drop until
it comes back." Formalized as: drop if `last_seen_date` is older than
`2 × median_interval`. That gives monthly items ~60d grace, quarterly
items ~180d — matches the intent perfectly and generalizes to any
cadence.

Everything a pattern captures also carries `account_id` (mode of the
underlying transactions), so per-account forecasts can route each
event to the right cash account.
"""
from __future__ import annotations

import hashlib
import re
from calendar import monthrange
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone, date
from statistics import median, mean, pstdev
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from deps import require_company


router = APIRouter(prefix="/api")


# =============================================================================
# Constants
# =============================================================================

MIN_OCCURRENCES = 3
LOOKBACK_DAYS = 365
AMOUNT_BUCKET_PCT = 0.05  # ±5% amount tolerance for grouping

CADENCE_BUCKETS = [
    # (label, min_days, max_days)
    ("weekly",     5,  8),
    ("biweekly",  12, 16),
    ("semimonthly", 13, 17),  # 15 ±2 days
    ("monthly",   27, 33),
    ("quarterly", 85, 95),
]


# =============================================================================
# Helpers
# =============================================================================

def _today() -> date:
    return datetime.now(timezone.utc).date()


def _iso(d: date) -> str:
    return d.isoformat()


def _desc_fingerprint(desc: str) -> str:
    """Normalize a transaction description to a stable clustering key.

    • Lowercase, strip
    • Remove digits, stars, hash markers
    • Drop trailing store/ref numbers
    • Take first 3 meaningful words
    """
    if not desc:
        return "unknown"
    s = desc.lower()
    s = re.sub(r"[#*][a-z0-9\-]+", " ", s)   # strip refs like *1234
    s = re.sub(r"\b\d{3,}\b", " ", s)         # strip long numbers
    s = re.sub(r"[^\w\s]", " ", s)
    words = [w for w in s.split() if len(w) > 2]
    key = " ".join(words[:3]) or "unknown"
    return hashlib.md5(key.encode()).hexdigest()[:12]


def _amount_bucket(amount: float) -> str:
    """Fixed-tier amount bucket. Groups similar amounts together but keeps
    structurally different bill sizes separate.

    Tiers snap to a step that scales with the order of magnitude so a
    $3,464.29 charge and a $3,465.88 charge (0.05% variance) end up in
    the same bucket, while a $112 monthly bill and a $30 ad-hoc charge
    to the same vendor stay separate.
    """
    if amount == 0:
        return "0"
    magnitude = abs(amount)
    if magnitude < 10:
        step = 1
    elif magnitude < 100:
        step = 5
    elif magnitude < 500:
        step = 25
    elif magnitude < 2000:
        step = 100
    else:
        step = 500
    bucket = round(magnitude / step) * step
    sign = "in" if amount > 0 else "out"
    return f"{sign}:{int(bucket)}"


def _classify_cadence(median_interval: float) -> Optional[str]:
    for label, lo, hi in CADENCE_BUCKETS:
        if lo <= median_interval <= hi:
            return label
    return None


def _confidence(occ: int, interval_cv: float, amount_cv: float) -> str:
    if occ >= 6 and interval_cv < 0.15 and amount_cv < 0.15:
        return "high"
    if occ >= 4 and interval_cv < 0.30 and amount_cv < 0.30:
        return "medium"
    return "low"


def _snap_to_preferred_dom(target: date, preferred_dom: int) -> date:
    """Move `target` to the closest date that matches `preferred_dom`.

    If the month doesn't have that day (e.g. Feb 30), use the month's
    last day.
    """
    if preferred_dom is None:
        return target
    last = monthrange(target.year, target.month)[1]
    dom = min(preferred_dom, last)
    return date(target.year, target.month, dom)


def _cv(values: list[float]) -> float:
    """Coefficient of variation. 0 = perfectly stable."""
    if len(values) < 2:
        return 0.0
    m = mean(values)
    if m == 0:
        return 0.0
    return pstdev(values) / abs(m)


# =============================================================================
# Core detector
# =============================================================================

async def detect_patterns(cid: str) -> dict:
    """Run the pattern detector, upsert results into `recurring_patterns`.

    Returns a summary dict:
        {
          "scanned_txns": N,
          "detected": N,
          "high": N, "medium": N, "low": N,
          "stale_dropped": N,
        }
    """
    today = _today()
    start = today - timedelta(days=LOOKBACK_DAYS)
    txns = await db.transactions.find({
        "company_id": cid,
        "date": {"$gte": _iso(start), "$lte": _iso(today)},
    }).to_list(20000)

    # Group txns by recurrence key. Prefer contact_id when present since
    # it's the highest-signal grouping key. We STILL bucket by amount
    # even for contact-tagged groups — but with a fixed-tier bucket that
    # catches near-identical amounts (Rocket Mortgage $3,464 ↔ $3,465
    # both snap to bucket 3500) while keeping structurally different bill
    # sizes separate (AT&T monthly $112 stays out of AT&T ad-hoc $30).
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for t in txns:
        amt = float(t.get("amount") or 0)
        if amt == 0:
            continue
        sign = "in" if amt > 0 else "out"
        bucket = _amount_bucket(amt)
        contact = t.get("contact_id") or t.get("vendor_id") or t.get("customer_id")
        if contact:
            key = ("contact", contact, sign, bucket)
        else:
            fp = _desc_fingerprint(t.get("description") or t.get("memo") or "")
            key = ("desc", fp, sign, bucket)
        groups[key].append(t)

    detected: list[dict] = []
    stale_dropped = 0

    for key, group in groups.items():
        if len(group) < MIN_OCCURRENCES:
            continue
        group.sort(key=lambda t: t["date"])
        dates: list[date] = []
        for t in group:
            try:
                dates.append(date.fromisoformat(t["date"][:10]))
            except (KeyError, ValueError):
                continue
        if len(dates) < MIN_OCCURRENCES:
            continue
        # Intervals between consecutive occurrences.
        intervals = [(dates[i] - dates[i - 1]).days for i in range(1, len(dates))]
        if not intervals:
            continue
        med_interval = median(intervals)
        cadence = _classify_cadence(med_interval)
        if not cadence:
            continue
        int_cv = _cv([float(x) for x in intervals])
        # Hard interval-CV cutoff — patterns with intervals that vary by
        # more than 60% (σ/μ > 0.6) aren't really "recurring", they're
        # sporadic same-vendor activity (Walmart shopping trips, ad-hoc
        # bank transfers, etc.). Auto-applying them into the forecast
        # inflates burn with noise, so we skip them here entirely.
        if int_cv > 0.6:
            continue
        amounts = [abs(float(t.get("amount") or 0)) for t in group]
        med_amount = median(amounts)
        amt_cv = _cv(amounts)
        # Recency filter — user rule: "if 9/12 months but not last 2 → drop."
        # Formalized as: drop when last_seen is older than 3 × median_interval.
        # (Was 2× — too aggressive; killed Rocket Mortgage-style patterns
        # where one late payment created a gap that killed the whole group.
        # 3× gives monthly items ~90d grace, quarterly ~270d.)
        last_seen = max(dates)
        gap = (today - last_seen).days
        if gap > (3 * med_interval):
            stale_dropped += 1
            continue

        # Preferred day-of-month + day-of-week (mode).
        dom_mode = Counter(d.day for d in dates).most_common(1)[0][0]
        dow_mode = Counter(d.weekday() for d in dates).most_common(1)[0][0]
        conf = _confidence(len(dates), int_cv, amt_cv)

        # Account (mode of underlying transactions' account_id).
        acct_ids = [t.get("account_id") for t in group if t.get("account_id")]
        account_id = Counter(acct_ids).most_common(1)[0][0] if acct_ids else None

        # Human-readable label.
        sign = key[2]
        if key[0] == "contact":
            contact_id = key[1]
            # Peek at the contact record for a nicer label.
            c = await db.contacts.find_one({"id": contact_id}) if contact_id else None
            base_name = (c or {}).get("name") or (c or {}).get("display_name") or "Contact"
            label = f"{base_name}"
        else:
            fp = key[1]
            base = (group[0].get("description") or group[0].get("memo") or "Recurring").strip()
            label = re.sub(r"[#*].+$", "", base)[:60].strip() or "Recurring"

        # Next expected date — round from last_seen + median_interval.
        next_est = last_seen + timedelta(days=int(round(med_interval)))
        # For monthly-ish cadences snap to preferred day-of-month.
        if cadence in ("monthly", "quarterly"):
            next_est = _snap_to_preferred_dom(next_est, dom_mode)
        # Guarantee it's in the future (patterns detected today with
        # last_seen=today would land in the past otherwise).
        while next_est <= today:
            next_est = next_est + timedelta(days=int(round(med_interval)))

        signed_amount = -med_amount if sign == "out" else med_amount

        detected.append({
            "company_id": cid,
            "pattern_key": "|".join(str(x) for x in key),
            "grouping": key[0],
            "contact_id": key[1] if key[0] == "contact" else None,
            "description_fingerprint": key[1] if key[0] == "desc" else None,
            "label": label,
            "sign": sign,
            "cadence": cadence,
            "median_interval_days": round(med_interval, 2),
            "interval_cv": round(int_cv, 3),
            "median_amount": round(signed_amount, 2),
            "amount_cv": round(amt_cv, 3),
            "occurrence_count": len(dates),
            "first_seen_date": _iso(min(dates)),
            "last_seen_date": _iso(last_seen),
            "next_expected_date": _iso(next_est),
            "preferred_day_of_month": dom_mode,
            "preferred_day_of_week": dow_mode,
            "account_id": account_id,
            "confidence": conf,
            "status": "active",  # auto-applied per user setting
            "updated_at": now_iso(),
        })

    # Snapshot: delete existing patterns for this company, re-insert.
    # Approve/reject states are stored separately in `pattern_overrides`
    # so a re-scan doesn't wipe them out.
    overrides = {
        o["pattern_key"]: o for o in await db.pattern_overrides.find(
            {"company_id": cid}
        ).to_list(2000)
    }
    for d in detected:
        pk = d["pattern_key"]
        ov = overrides.get(pk)
        if ov:
            d["status"] = ov.get("status", "active")
            # Allow user amount/cadence overrides too.
            if ov.get("override_amount") is not None:
                d["median_amount"] = float(ov["override_amount"])
            if ov.get("override_cadence"):
                d["cadence"] = ov["override_cadence"]

    await db.recurring_patterns.delete_many({"company_id": cid})
    if detected:
        await db.recurring_patterns.insert_many(detected)

    return {
        "scanned_txns": len(txns),
        "detected": len(detected),
        "high":     sum(1 for d in detected if d["confidence"] == "high"),
        "medium":   sum(1 for d in detected if d["confidence"] == "medium"),
        "low":      sum(1 for d in detected if d["confidence"] == "low"),
        "stale_dropped": stale_dropped,
        "run_at": now_iso(),
    }


async def load_active_patterns(cid: str) -> list[dict]:
    """Return active (non-rejected) patterns for the forecast to consume."""
    docs = await db.recurring_patterns.find({
        "company_id": cid,
        "status": {"$ne": "rejected"},
    }).to_list(2000)
    for d in docs:
        d.pop("_id", None)
    return docs


# =============================================================================
# Endpoints
# =============================================================================

@router.post("/companies/{cid}/projections/detect-patterns")
async def api_detect_patterns(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    return await detect_patterns(cid)


@router.get("/companies/{cid}/projections/patterns")
async def list_patterns(
    cid: str,
    status: Optional[str] = Query(None, description="active|rejected|edited"),
    confidence: Optional[str] = Query(None, description="high|medium|low"),
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    if status:
        q["status"] = status
    if confidence:
        q["confidence"] = confidence
    docs = await db.recurring_patterns.find(q).sort([
        ("confidence", 1), ("occurrence_count", -1),
    ]).to_list(2000)
    for d in docs:
        d.pop("_id", None)
    return {"patterns": docs, "count": len(docs)}


class PatternOverrideIn(BaseModel):
    status: Optional[str] = None           # active|rejected
    override_amount: Optional[float] = None
    override_cadence: Optional[str] = None


@router.post("/companies/{cid}/projections/patterns/{pattern_key}/override")
async def override_pattern(
    cid: str, pattern_key: str, inp: PatternOverrideIn,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    if inp.status and inp.status not in ("active", "rejected"):
        raise HTTPException(400, "status must be active|rejected")
    now = now_iso()
    update = {"updated_at": now, "updated_by": user.get("email") or user.get("id")}
    if inp.status:
        update["status"] = inp.status
    if inp.override_amount is not None:
        update["override_amount"] = float(inp.override_amount)
    if inp.override_cadence:
        if inp.override_cadence not in {"weekly", "biweekly", "semimonthly", "monthly", "quarterly"}:
            raise HTTPException(400, f"Bad cadence: {inp.override_cadence}")
        update["override_cadence"] = inp.override_cadence
    await db.pattern_overrides.update_one(
        {"company_id": cid, "pattern_key": pattern_key},
        {"$set": {"company_id": cid, "pattern_key": pattern_key, **update}},
        upsert=True,
    )
    # Reflect the change on the live pattern doc so the forecast sees it
    # without waiting for the next detection run.
    live_update = {k: v for k, v in update.items() if k in {"status"}}
    if "override_amount" in update:
        live_update["median_amount"] = update["override_amount"]
    if "override_cadence" in update:
        live_update["cadence"] = update["override_cadence"]
    if live_update:
        await db.recurring_patterns.update_one(
            {"company_id": cid, "pattern_key": pattern_key},
            {"$set": live_update},
        )
    return {"ok": True}
