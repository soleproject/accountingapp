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
    never take down a user-facing AI request."""
    try:
        cost = _price_llm(model, input_tokens or 0, output_tokens or 0)
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
            "company_id": company_id or _ctx_company_id(),
            "ts": now_iso(),
        }
        await db.ai_usage_events.insert_one(doc)
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
        doc = {
            "id": str(uuid.uuid4()),
            "feature": feature,
            "service": service,
            "quantity": float(quantity),
            "unit": unit,
            "unit_price_usd": float(rate),
            "cost_cents": float(cost),
            "user_id": user_id or _ctx_user_id(),
            "company_id": company_id or _ctx_company_id(),
            "ts": now_iso(),
        }
        await db.ai_usage_events.insert_one(doc)
        return cost
    except Exception:
        logger.exception("ai_usage.record_service failed for %s / %s", feature, service)
        return 0.0


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


async def get_summary(range_key: str = "month", category: str | None = None) -> dict:
    """Return the aggregated dashboard payload:
        totals { cost_cents, events, unique_users, avg_cost_cents }
        by_feature [{feature, events, cost_cents}]
        by_service [{service, quantity, unit, unit_price_usd, cost_cents}]
        by_category [{category, cost_cents}]  ← llm | bank | email | ocr
    """
    since = _range_start(range_key)
    match: dict = {"ts": {"$gte": since}}
    if category and category != "all":
        match["category_key"] = category  # only used when we build category_key upstream

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
    }


async def ensure_indexes() -> None:
    """Called on FastAPI startup — indexes for the hot read paths."""
    await db.ai_usage_events.create_index([("ts", -1)])
    await db.ai_usage_events.create_index([("service", 1), ("ts", -1)])
    await db.ai_usage_events.create_index([("feature", 1), ("ts", -1)])
