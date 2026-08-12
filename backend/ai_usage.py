"""Platform-wide AI + external-API cost tracker.

Every LLM call, Veryfi OCR, Resend email, and Plaid item is logged to
``ai_usage_events`` — one document per billable event with ``feature``,
``service``, ``cost_cents`` (float, USD cents), plus token/quantity
metadata. The Superadmin "Usage & Costs" page aggregates from here.

Pricing tables live in this file (not env) so a config bump requires a
deploy — costs are a compliance-flavoured metric and drift in a runtime
config would silently mis-report spend across billing periods.

Feature naming: kebab-case verbs (``ai-categorize``, ``ai-review``,
``ai-chat``, ``resolve-contact``, ``ai-onboarding``, ``ai-voice-intent``,
``veryfi-ocr``, ``resend-email``, ``plaid-item-monthly``). One row per
event = one row per billable unit — no rollups on write, aggregation
happens at read time so the raw event stream can be re-summarised later
if we change categorisation.
"""
from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone, timedelta
from typing import Optional

from db import db, now_iso

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pricing tables (USD per 1M tokens for LLMs; USD per unit for services).
# All figures current as of Feb 2026. Update on price changes + note the
# date in the commit message so historical rows are traceable.
# ---------------------------------------------------------------------------
LLM_PRICES_USD_PER_1M_TOKENS: dict[str, dict[str, float]] = {
    # OpenAI
    "gpt-4o-mini":     {"input": 0.15, "output": 0.60},
    "gpt-4o":          {"input": 2.50, "output": 10.00},
    "gpt-4.1-mini":    {"input": 0.40, "output": 1.60},
    "gpt-4.1":         {"input": 2.00, "output": 8.00},
    "gpt-5":           {"input": 2.50, "output": 10.00},
    "gpt-5-mini":      {"input": 0.25, "output": 2.00},
    # Anthropic
    "claude-sonnet-4-5-20250929": {"input": 3.00, "output": 15.00},
    "claude-haiku-4-5-20251001":  {"input": 1.00, "output": 5.00},
}

# Flat-rate services — cost per unit in USD.
SERVICE_UNIT_PRICE_USD: dict[str, float] = {
    "veryfi_ocr":            0.16,      # per document processed
    "plaid_linked_item":     0.30,      # per active item per month
    "resend_email":          0.0004,    # per email sent
}


# ---------------------------------------------------------------------------
# Request-scope context — set by the auth dependency, read by recorders so
# every logged event carries the initiating user + company without every
# call site having to plumb them through.
# ---------------------------------------------------------------------------
_current_user_id: ContextVar[Optional[str]] = ContextVar("_current_user_id", default=None)
_current_company_id: ContextVar[Optional[str]] = ContextVar("_current_company_id", default=None)


def set_request_context(user_id: str | None, company_id: str | None = None) -> None:
    """Set the calling-user context for the current async task. Called by
    the FastAPI auth dependency once per request."""
    if user_id is not None:
        _current_user_id.set(user_id)
    if company_id is not None:
        _current_company_id.set(company_id)


def _ctx_user_id() -> str | None:
    return _current_user_id.get()


def _ctx_company_id() -> str | None:
    return _current_company_id.get()


# ---------------------------------------------------------------------------
# Cost math
# ---------------------------------------------------------------------------
def _price_llm(model: str, input_tokens: int, output_tokens: int) -> float:
    """Cents (USD). Returns 0.0 when the model isn't priced yet — better to
    log the event with a zero than drop it silently."""
    rates = LLM_PRICES_USD_PER_1M_TOKENS.get(model)
    if not rates:
        # Try prefix match ("gpt-4o-mini-2024-07-18" → "gpt-4o-mini").
        for prefix, r in LLM_PRICES_USD_PER_1M_TOKENS.items():
            if model.startswith(prefix):
                rates = r
                break
    if not rates:
        logger.warning("ai_usage: no price for model %r — logging cost=0", model)
        return 0.0
    usd = (input_tokens / 1_000_000) * rates["input"] + (output_tokens / 1_000_000) * rates["output"]
    return usd * 100  # → cents


# ---------------------------------------------------------------------------
# Recorders — one function per billable unit.
# ---------------------------------------------------------------------------
async def record_llm(
    *,
    feature: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    user_id: Optional[str] = None,
    company_id: Optional[str] = None,
) -> float:
    """Record one LLM call. Returns the cost in cents so the caller can
    log it inline if they want. Never raises — a broken recorder must
    never take down a user-facing AI request.

    Feb 2026 — this is the single choke point for per-company spend
    tracking. Every LLM call (Insights, categorizer, onboarding, follow-
    up emails, cleanup copilot, AiPanel chat) lands here. We do THREE
    writes per event, all fire-and-forget so cost tracking never blocks
    the user-facing response:

      1. Detailed event → `ai_usage_events` (unchanged)
      2. Per-company period counter → `companies.ai_spend.{YYYY-MM}` via
         atomic $inc. This is what the cap-check reads at O(1).
      3. Daily rollup → `ai_spend_daily` upsert keyed by
         (company_id, day, feature). Used by admin reports so we don't
         have to $match+$group over `ai_usage_events` every time.
    """
    try:
        cost = _price_llm(model, input_tokens or 0, output_tokens or 0)
        cid = company_id or _ctx_company_id()
        doc = {
            "id": str(uuid.uuid4()),
            "feature": feature,
            "service": "openai_llm" if provider == "openai" else f"{provider}_llm",
            "provider": provider,
            "model": model,
            "input_tokens": int(input_tokens or 0),
            "output_tokens": int(output_tokens or 0),
            "total_tokens": int((input_tokens or 0) + (output_tokens or 0)),
            "quantity": int((input_tokens or 0) + (output_tokens or 0)),
            "unit": "token",
            "cost_cents": cost,
            "user_id": user_id or _ctx_user_id(),
            "company_id": cid,
            "ts": now_iso(),
        }
        await db.ai_usage_events.insert_one(doc)
        # Unified per-company period counter + daily rollup.
        if cid and cost > 0:
            await _increment_company_spend(cid, feature, cost)
        return cost
    except Exception:
        logger.exception("ai_usage.record_llm failed for %s / %s", feature, model)
        return 0.0


async def record_service(
    *,
    feature: str,
    service: str,
    quantity: float = 1,
    unit: str = "event",
    unit_price_usd: Optional[float] = None,
    user_id: Optional[str] = None,
    company_id: Optional[str] = None,
) -> float:
    """Record a non-LLM API call (Veryfi OCR, Resend email, etc.). If
    ``unit_price_usd`` is omitted the tracker looks it up in
    ``SERVICE_UNIT_PRICE_USD`` — falls back to 0 with a warning."""
    try:
        rate = unit_price_usd if unit_price_usd is not None else SERVICE_UNIT_PRICE_USD.get(service, 0.0)
        cost = quantity * rate * 100  # → cents
        cid = company_id or _ctx_company_id()
        doc = {
            "id": str(uuid.uuid4()),
            "feature": feature,
            "service": service,
            "quantity": float(quantity),
            "unit": unit,
            "unit_price_usd": float(rate),
            "cost_cents": float(cost),
            "user_id": user_id or _ctx_user_id(),
            "company_id": cid,
            "ts": now_iso(),
        }
        await db.ai_usage_events.insert_one(doc)
        if cid and cost > 0:
            await _increment_company_spend(cid, feature, cost)
        return cost
    except Exception:
        logger.exception("ai_usage.record_service failed for %s / %s", feature, service)
        return 0.0


# ---------------------------------------------------------------------------
# Per-company spend accumulator + cap check
# ---------------------------------------------------------------------------
#
# Design choice: two write targets per event so the two dominant reads
# stay O(1):
#   • "Is company X over budget for this month?" → single field lookup on
#     `companies.ai_spend.{YYYY-MM}`.
#   • "Who spent what across every feature by day?" → indexed query on
#     `ai_spend_daily(company_id, day)`.
#
# We accept the ~2× write amplification vs a single event insert because
# LLM calls are already ~500ms — the extra ~2ms of write cost is noise.

def _period_key(now: Optional[datetime] = None) -> str:
    n = now or datetime.now(timezone.utc)
    return n.strftime("%Y-%m")


def _day_key(now: Optional[datetime] = None) -> str:
    n = now or datetime.now(timezone.utc)
    return n.strftime("%Y-%m-%d")


async def _increment_company_spend(
    company_id: str, feature: str, cost_cents: float,
) -> None:
    """Atomically bump the per-company period counter AND daily rollup.
    Fire-and-forget — logs and swallows on failure so a broken counter
    never fails the LLM call itself."""
    try:
        period = _period_key()
        await db.companies.update_one(
            {"id": company_id},
            {"$inc": {f"ai_spend.{period}": float(cost_cents)}},
        )
        await db.ai_spend_daily.update_one(
            {"company_id": company_id, "day": _day_key(), "feature": feature},
            {
                "$inc": {"cost_cents": float(cost_cents), "events": 1},
                "$setOnInsert": {"created_at": now_iso()},
                "$set": {"updated_at": now_iso()},
            },
            upsert=True,
        )
    except Exception:
        logger.exception(
            "_increment_company_spend failed for cid=%s feature=%s cost=%s",
            company_id, feature, cost_cents,
        )


class AiSpendCapExceeded(Exception):
    """Raised by ``check_spend_cap`` when the company's monthly AI
    spend is at or above their configured cap. The caller (LlmChat, the
    Insights SSE handler, the categorizer) should translate this into a
    402 Payment Required so the user sees a real 'raise your cap or
    wait' message rather than a generic 500.
    """
    def __init__(self, company_id: str, spent_cents: float, cap_cents: float):
        self.company_id = company_id
        self.spent_cents = spent_cents
        self.cap_cents = cap_cents
        super().__init__(
            f"AI spend cap reached for company {company_id}: "
            f"${spent_cents / 100:.2f} / ${cap_cents / 100:.2f} this month"
        )


async def check_spend_cap(company_id: Optional[str]) -> None:
    """Pre-flight cap check called by every LLM entry point.

    Feb 2026 — this is intentionally a SOFT cap, not a hard 402. A
    paying customer mid-close hitting a "AI unavailable" wall is a
    churn risk. Instead:
      • Under 80% of cap → no-op, silent
      • 80-99% of cap    → log a WARNING (so the admin dashboard's
        ai-spend page + Sentry pick it up), but LLM call proceeds
      • ≥100% of cap     → log ERROR + increment a counter on the
        company doc (`ai_spend_over_cap_events`) so ops has an
        audit trail. Still allows the call — only a company doc
        with `ai_spend_hard_block: true` will raise
        AiSpendCapExceeded and 402 the request.

    Superadmin can flip `ai_spend_hard_block` per-company from the
    admin UI when they see a runaway offender. Default is off.
    """
    if not company_id:
        return
    doc = await db.companies.find_one(
        {"id": company_id},
        {"ai_spend_cap_cents": 1, "ai_spend": 1, "insights_spend": 1,
         "ai_spend_hard_block": 1, "name": 1},
    )
    if not doc:
        return
    cap = float(doc.get("ai_spend_cap_cents") or 0)
    if cap <= 0:
        return  # unlimited
    period = _period_key()
    spent = float((doc.get("ai_spend") or {}).get(period) or 0)
    spent += float((doc.get("insights_spend") or {}).get(period) or 0)
    if spent < 0.8 * cap:
        return

    ratio = spent / cap
    over = ratio >= 1.0
    hard = bool(doc.get("ai_spend_hard_block"))
    name = doc.get("name") or company_id

    if over:
        # Latch a running counter so admins can see WHICH companies
        # crossed the line and how many events happened after.
        try:
            await db.companies.update_one(
                {"id": company_id},
                {
                    "$inc": {f"ai_spend_over_cap_events.{period}": 1},
                    "$set": {f"ai_spend_over_cap_first_at.{period}": now_iso()
                             if not (doc.get("ai_spend_over_cap_first_at") or {}).get(period)
                             else (doc.get("ai_spend_over_cap_first_at") or {})[period],
                             "updated_at": now_iso()},
                },
            )
        except Exception:
            logger.exception("failed to latch over-cap counter for %s", company_id)
        logger.error(
            "AI_SPEND OVER CAP: company=%s (%s) spent=$%.2f cap=$%.2f (%.0f%%) hard_block=%s",
            company_id, name, spent / 100, cap / 100, ratio * 100, hard,
        )
        if hard:
            raise AiSpendCapExceeded(company_id, spent, cap)
    else:
        logger.warning(
            "AI_SPEND 80%%+ threshold: company=%s (%s) spent=$%.2f cap=$%.2f (%.0f%%)",
            company_id, name, spent / 100, cap / 100, ratio * 100,
        )


# ---------------------------------------------------------------------------
# Aggregation helpers used by the superadmin route.
# ---------------------------------------------------------------------------
def _range_start(range_key: str) -> str:
    """Return the ISO cutoff for a range shorthand: 7d, 30d, 90d, month, all."""
    now = datetime.now(timezone.utc)
    if range_key == "7d":
        return (now - timedelta(days=7)).isoformat()
    if range_key == "30d":
        return (now - timedelta(days=30)).isoformat()
    if range_key == "90d":
        return (now - timedelta(days=90)).isoformat()
    if range_key == "month":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    if range_key == "all":
        return "1970-01-01T00:00:00+00:00"
    return (now - timedelta(days=30)).isoformat()


async def get_summary(
    range_key: str = "month",
    category: str | None = None,
    company_ids: list[str] | None = None,
) -> dict:
    """Return the aggregated dashboard payload:
        totals { cost_cents, events, unique_users, avg_cost_cents }
        by_feature [{feature, events, cost_cents}]
        by_service [{service, quantity, unit, unit_price_usd, cost_cents}]
        by_category [{category, cost_cents}]  ← llm | bank | email | ocr

    `company_ids` (optional) — restrict the rollup to events emitted
    on companies in this list. Used by the partner-scoped
    `/partner/usage` endpoint to keep partners from seeing platform-
    wide spend. `None` = no filter (admin view).
    """
    since = _range_start(range_key)
    match: dict = {"ts": {"$gte": since}}
    if category and category != "all":
        match["category_key"] = category  # only used when we build category_key upstream
    if company_ids is not None:
        # Explicit empty-list guard — partners with zero tree companies
        # should see zeros, not the whole platform (Mongo treats `$in: []`
        # as "match nothing" already but this makes the intent explicit).
        if not company_ids:
            return {
                "range": range_key, "since": since,
                "totals": {"cost_cents": 0, "events": 0,
                           "unique_users": 0, "avg_cost_cents": 0},
                "by_feature": [], "by_service": [], "by_category": [],
                "by_company": [], "by_user": [],
            }
        match["company_id"] = {"$in": company_ids}

    events = await db.ai_usage_events.find(match).to_list(50_000)

    # Category classification (LLM → llm, plaid → bank, resend → email, veryfi → ocr).
    def _cat(service: str) -> str:
        if service.endswith("_llm"):
            return "llm"
        if service == "plaid_linked_item":
            return "bank"
        if service == "resend_email":
            return "email"
        if service == "veryfi_ocr":
            return "ocr"
        return "other"

    # Filter by category if requested.
    if category and category != "all":
        events = [e for e in events if _cat(e.get("service", "")) == category]

    total_cost = sum(float(e.get("cost_cents") or 0) for e in events)
    total_events = len(events)
    unique_users = len({e.get("user_id") for e in events if e.get("user_id")})
    avg = (total_cost / total_events) if total_events else 0

    # By feature
    by_feature: dict[str, dict] = {}
    for e in events:
        key = e.get("feature") or "unknown"
        row = by_feature.setdefault(key, {"feature": key, "events": 0, "cost_cents": 0.0})
        row["events"] += 1
        row["cost_cents"] += float(e.get("cost_cents") or 0)
    by_feature_list = sorted(by_feature.values(), key=lambda r: r["cost_cents"], reverse=True)

    # By service
    by_service: dict[str, dict] = {}
    for e in events:
        svc = e.get("service") or "unknown"
        row = by_service.setdefault(svc, {
            "service": svc, "quantity": 0.0, "unit": e.get("unit") or "event",
            "unit_price_usd": float(e.get("unit_price_usd") or 0),
            "cost_cents": 0.0, "events": 0,
        })
        row["quantity"] += float(e.get("quantity") or 0)
        row["cost_cents"] += float(e.get("cost_cents") or 0)
        row["events"] += 1
        # For LLM, capture the model as a hint (last-writer wins).
        if e.get("model"):
            row["model"] = e["model"]
    by_service_list = sorted(by_service.values(), key=lambda r: r["cost_cents"], reverse=True)

    # Category rollup for the chip row (All / llm / bank / email / ocr).
    by_category: dict[str, float] = {}
    for e in events:
        k = _cat(e.get("service", ""))
        by_category[k] = by_category.get(k, 0.0) + float(e.get("cost_cents") or 0)

    # Per-company rollup (enterprise view).
    by_company: dict[str, dict] = {}
    for e in events:
        cid = e.get("company_id")
        if not cid:
            continue
        row = by_company.setdefault(cid, {"company_id": cid, "events": 0, "cost_cents": 0.0, "unique_users": set()})
        row["events"] += 1
        row["cost_cents"] += float(e.get("cost_cents") or 0)
        if e.get("user_id"):
            row["unique_users"].add(e["user_id"])
    for row in by_company.values():
        row["unique_users"] = len(row["unique_users"])
    by_company_list = sorted(by_company.values(), key=lambda r: r["cost_cents"], reverse=True)

    # Per-user rollup.
    by_user: dict[str, dict] = {}
    for e in events:
        uid = e.get("user_id")
        if not uid:
            continue
        row = by_user.setdefault(uid, {"user_id": uid, "events": 0, "cost_cents": 0.0})
        row["events"] += 1
        row["cost_cents"] += float(e.get("cost_cents") or 0)
    by_user_list = sorted(by_user.values(), key=lambda r: r["cost_cents"], reverse=True)

    return {
        "range": range_key,
        "since": since,
        "totals": {
            "cost_cents": total_cost,
            "events": total_events,
            "unique_users": unique_users,
            "avg_cost_cents": avg,
        },
        "by_feature": by_feature_list,
        "by_service": by_service_list,
        "by_category": [{"category": k, "cost_cents": v} for k, v in sorted(by_category.items(), key=lambda kv: -kv[1])],
        "by_company": by_company_list,
        "by_user": by_user_list,
    }


async def ensure_indexes() -> None:
    """Called on FastAPI startup — indexes for the hot read paths."""
    await db.ai_usage_events.create_index([("ts", -1)])
    await db.ai_usage_events.create_index([("service", 1), ("ts", -1)])
    await db.ai_usage_events.create_index([("feature", 1), ("ts", -1)])
    # Per-company / per-user analytics + admin AI-spend report reads.
    await db.ai_usage_events.create_index([("company_id", 1), ("ts", -1)])
    await db.ai_usage_events.create_index([("user_id", 1), ("ts", -1)])
    # Daily rollup: unique on (company_id, day, feature) so upserts
    # from `_increment_company_spend` are atomic per feature per day.
    await db.ai_spend_daily.create_index(
        [("company_id", 1), ("day", -1), ("feature", 1)],
        unique=True, name="ai_spend_daily_uniq",
    )
    await db.ai_spend_daily.create_index([("day", -1)])


async def backfill_ai_spend_counters() -> dict:
    """One-shot backfill (Feb 2026) — sum every existing `ai_usage_events`
    row into `companies.ai_spend.{YYYY-MM}` and `ai_spend_daily` so the
    counters reflect ALL historical AI activity, not just events written
    after the unification landed. Idempotent: rebuilds counters from
    scratch on every call so re-running is safe.

    Returns a dict with `{companies_touched, events_scanned, daily_rows}`
    the caller can surface to ops as a sanity check.
    """
    # Wipe the two derived data stores. The source of truth is
    # `ai_usage_events` — as long as that's untouched we can always
    # rebuild these two views.
    await db.ai_spend_daily.delete_many({})
    await db.companies.update_many(
        {}, {"$unset": {"ai_spend": ""}},
    )

    company_period_totals: dict[tuple[str, str], float] = {}
    daily_totals: dict[tuple[str, str, str], dict] = {}
    n_events = 0
    async for ev in db.ai_usage_events.find({}, {
        "company_id": 1, "cost_cents": 1, "feature": 1, "ts": 1,
    }):
        n_events += 1
        cid = ev.get("company_id")
        cost = float(ev.get("cost_cents") or 0)
        ts = ev.get("ts") or ""
        if not cid or not ts or cost <= 0:
            continue
        period = ts[:7]      # "YYYY-MM"
        day = ts[:10]        # "YYYY-MM-DD"
        feat = ev.get("feature") or "ai-unknown"
        company_period_totals[(cid, period)] = (
            company_period_totals.get((cid, period), 0.0) + cost
        )
        row = daily_totals.setdefault((cid, day, feat),
                                       {"cost_cents": 0.0, "events": 0})
        row["cost_cents"] += cost
        row["events"] += 1

    # Bulk-write the results back.
    from pymongo import UpdateOne
    if company_period_totals:
        per_company: dict[str, dict] = {}
        for (cid, period), cost in company_period_totals.items():
            per_company.setdefault(cid, {})[f"ai_spend.{period}"] = cost
        ops = [
            UpdateOne({"id": cid}, {"$set": fields})
            for cid, fields in per_company.items()
        ]
        if ops:
            await db.companies.bulk_write(ops, ordered=False)

    daily_ops = []
    for (cid, day, feat), agg in daily_totals.items():
        daily_ops.append(UpdateOne(
            {"company_id": cid, "day": day, "feature": feat},
            {
                "$set": {"cost_cents": agg["cost_cents"], "events": agg["events"],
                         "updated_at": now_iso()},
                "$setOnInsert": {"created_at": now_iso()},
            },
            upsert=True,
        ))
    if daily_ops:
        await db.ai_spend_daily.bulk_write(daily_ops, ordered=False)

    return {
        "companies_touched": len(company_period_totals),
        "events_scanned": n_events,
        "daily_rows": len(daily_totals),
    }
