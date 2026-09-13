"""Global Vendor Intel — cross-tenant knowledge cache of what merchants
ARE and how they should be categorized by industry.

Populated lazily by the `contact_category_auditor` agent (this module's
main caller). Every audit that encounters a new-to-the-platform vendor
kicks off a web-grounded LLM lookup; the answer is cached forever (or
until a human overrides it) so future audits on any tenant are free.

Human overrides are terminal — once a superadmin (or the future
"verify vendor intel" UI) stamps an entry with `verified_by`, the
LLM path is barred from overwriting it. LLM writes into an existing
row only merge new industry buckets or refresh stale ones.

Design notes locked with product owner (Feb 28 2026):
  1. Categories are STRINGS, not COA codes. The auditor emits things
     like "Repairs & Maintenance" or "Cost of Goods Sold"; the applier
     resolves those to a real `account_id` on the target company's CoA
     at fix-time. This keeps a single intel row valid across every
     tenant's chart regardless of numbering.
  2. Categories are keyed by INDUSTRY (matching `companies.industry_template`
     values), with a `default` bucket for tenants with no template set.
     A vendor row is legal with just a `default` entry — the auditor
     falls back to it whenever a specific industry bucket is missing.
  3. `multi_category=True` marks vendors like Amazon / Home Depot /
     Costco whose real-world purchases legitimately span 3+ accounts.
     The auditor uses a stricter confidence floor for these and emits
     "review per-txn" nudges instead of hard "wrong" verdicts.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db, now_iso
from contact_resolver import normalize_contact_name

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Industry taxonomy — matches `companies.industry_template` values so we
# can key intel rows off the same enum without an extra translation step.
# `default` is the fallback bucket for companies with no template set.
# ---------------------------------------------------------------------------
INDUSTRY_KEYS = frozenset({
    "restaurant", "contractor", "retail", "saas",
    "real_estate", "healthcare", "professional_services",
    "e_commerce", "generic", "default",
})


def company_industry_key(company: dict) -> str:
    """Return the intel-collection key for a company. Prefers the
    canonical `industry_template` field; falls back to `default`. Never
    raises — an unknown value collapses to `default` so we always have
    a bucket to look up."""
    raw = (company or {}).get("industry_template") or ""
    key = str(raw).strip().lower()
    if key in INDUSTRY_KEYS:
        # `generic` template = no strong industry signal → use `default`
        # for intel lookups.
        return "default" if key == "generic" else key
    return "default"


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

async def ensure_vendor_intel_index() -> None:
    """Idempotent — unique index on normalized_name so parallel research
    calls collapse to a single row per merchant."""
    try:
        await db.global_vendor_intel.create_index(
            [("normalized_name", 1)], unique=True, name="vendor_intel_uniq",
        )
    except Exception:
        logger.exception("failed to create vendor_intel index")


# ---------------------------------------------------------------------------
# Read path
# ---------------------------------------------------------------------------

async def get_intel(name: str) -> Optional[dict]:
    """Return the cached intel row for a merchant, or None. Normalizes
    the name via the shared `normalize_contact_name` so different
    spellings ("GitHub" vs "GitHub, Inc.") hit the same row."""
    key = normalize_contact_name(name)
    if not key:
        return None
    doc = await db.global_vendor_intel.find_one({"normalized_name": key})
    return doc


def industry_bucket(intel: dict, industry_key: str) -> Optional[dict]:
    """Extract the categorization bucket for a specific industry from
    an intel row, falling back to `default`. Returns `None` if neither
    is present."""
    buckets = (intel or {}).get("categorization_by_industry") or {}
    return buckets.get(industry_key) or buckets.get("default")


# ---------------------------------------------------------------------------
# Write path — web-grounded research
# ---------------------------------------------------------------------------

_RESEARCH_SYSTEM = """You are a research assistant helping a US bookkeeping
platform classify merchants. Given a vendor/merchant name (as it appears on a
bank statement), search the web to identify the real-world business, then emit
a strict JSON classification.

For each recognized merchant, return:
  {
    "canonical_name": "Home Depot",
    "entity_type": "corporation" | "individual" | "utility" | "government" | "bank" | "financial_institution" | "nonprofit" | "unknown",
    "vendor_purpose": "expense_vendor" | "financial_institution" | "tax_authority" | "personal" | "revenue_source" | "unknown",
    "business_summary": "Home improvement retailer — building materials, tools, hardware, garden supplies.",
    "multi_category": true | false,
    "categorization_by_industry": {
      "restaurant": {
        "reasonable_set":      ["Repairs & Maintenance", "Kitchen Equipment", "Supplies", "Small Tools", "Office Supplies"],
        "hard_wrong_signals":  ["Owner's Draw", "Cost of Goods Sold", "Meals & Entertainment", "Payroll Expense", "Rent Expense"],
        "primary":             "Repairs & Maintenance",
        "notes":               "Restaurants typically use HD for facility repairs, not menu ingredients."
      },
      "contractor":            { ... same shape ... },
      "retail":                { ... },
      "real_estate":           { ... },
      "healthcare":            { ... },
      "saas":                  { ... },
      "professional_services": { ... },
      "e_commerce":            { ... },
      "default":               { ... }
    },
    "confidence": 0.85,
    "citations": ["https://...", "..."]
  }

CORE PRINCIPLE — **width, not narrowness**:
Real bookkeepers accept many acceptable accounts for the same vendor. Cooking classes at "Nothing To It Culinary" can plausibly post to Training & Development, Professional Fees, Dues & Subscriptions, or Meals & Entertainment — none of those is "wrong." Emit a WIDE `reasonable_set` (5-8 accounts) covering every account a competent CPA might legitimately choose. Only put an account in `hard_wrong_signals` if it would be a material posting error — mixing income statement with balance sheet, or a fundamentally different expense type (e.g., "Owner's Draw" for an obvious business vendor, "Meals & Entertainment" for a healthcare provider).

RULES:
  1. Use ACCOUNT NAMES, not COA numbers.
  2. Prefer standard GAAP account names: Cost of Goods Sold, Advertising & Marketing, Utilities, Rent Expense, Telephone, Internet & Software Subscriptions, Meals & Entertainment, Office Supplies, Repairs & Maintenance, Professional Fees, Bank Charges, Interest Expense, Insurance, Payroll Expense, Travel, Vehicle Expense, Training & Development, Dues & Subscriptions, Supplies, Small Tools, Kitchen Equipment, Property Improvements, Facilities Supplies, Software Subscriptions, Software & SaaS, Taxes - Federal Income, Taxes - State, Sales Tax Payable, Uncategorized Expense.
  3. `default` MUST be present. Every other industry bucket is optional — omit if you have no reasonable per-industry differentiation.
  4. `reasonable_set` = **5-8 accounts** any of which a competent CPA would accept for this vendor in this industry. Widen when in doubt.
  5. `hard_wrong_signals` = **only** accounts that would be a material posting error (equity account on a clear business vendor, income statement crossing balance sheet, wildly wrong expense category). Keep this list short (≤ 5).
  6. `vendor_purpose` values:
     - `expense_vendor` — normal business expense vendor (default)
     - `financial_institution` — bank, credit-card issuer, payment processor whose primary transactions are payoffs/transfers, NOT expense line items. Set this for Visa, MasterCard, Citi Card, Capital One, Chase Card, American Express, Synchrony, PayPal, Venmo, Zelle, Rocket Mortgage, Mercedes-Benz Financial Services, etc.
     - `tax_authority` — IRS, state DOR, county assessor — payments here hit tax expense or liability payoff
     - `personal` — an individual (not a business); transactions are usually transfers, gifts, or reimbursements
     - `revenue_source` — customer/client (money coming IN, not going OUT)
     - `unknown` — LLM can't determine
  7. Set `multi_category=true` ONLY when the merchant legitimately serves 3+ distinct GAAP accounts (Amazon, Costco, Target, Walmart, Home Depot, Best Buy). Multi-category vendors get PER-TRANSACTION review; their `reasonable_set` should span all realistic buckets.
  8. `confidence`: 0.9+ for household names, 0.5-0.7 for regional players, <0.4 to abstain (leave categorization_by_industry empty).
  9. If unrecognized after web search: `entity_type: "unknown"`, `vendor_purpose: "unknown"`, `confidence: 0.3`, `categorization_by_industry: {}`.
 10. Return STRICT JSON only. No prose, no markdown."""


def _extract_json_object(text: str) -> Optional[dict]:
    """Pull the first `{ ... }` object from a text blob. LLMs love to
    wrap JSON in code fences or a preamble; this is tolerant of both."""
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


async def research_vendor(name: str) -> Optional[dict]:
    """Web-grounded LLM classification of a vendor name.

    Uses `emergentintegrations.llm.chat.LlmChat` (NOT the local slim
    wrapper) so we can reach Anthropic's server-side `web_search` tool
    via the Emergent universal key — that surface isn't in the shim.
    Model: Claude Haiku 4.5 (cheap, strong pattern reasoning).

    Returns the parsed intel dict on success, or None on any failure —
    the caller should treat None as "no cache write, retry next audit."
    """
    from emergentintegrations.llm.chat import LlmChat as EmergentLlmChat
    from emergentintegrations.llm.chat import UserMessage as EmergentUserMessage
    from ai_usage import record_llm

    canonical = (name or "").strip()
    if not canonical:
        return None

    key = os.environ.get("EMERGENT_LLM_KEY", "")
    if not key:
        logger.error("research_vendor: EMERGENT_LLM_KEY not set — skipping web research")
        return None

    prompt = (
        f"Classify this merchant: {canonical!r}\n\n"
        "Search the web for what business this is, then emit the JSON "
        "classification per the system prompt."
    )
    session_id = f"vendor-intel-{uuid.uuid4()}"
    model_used = "claude-haiku-4-5-20251001"

    try:
        chat = (
            EmergentLlmChat(
                api_key=key,
                session_id=session_id,
                system_message=_RESEARCH_SYSTEM,
            )
            .with_model("anthropic", model_used)
            .with_tools([{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 3,
            }])
        )
        resp = await chat.send_message(EmergentUserMessage(text=prompt))
        text = resp.text if hasattr(resp, "text") else str(resp)
    except Exception:
        logger.exception("research_vendor: LLM call failed for %r", canonical)
        return None

    # Attribute cost to the ai_usage counter under a dedicated feature key.
    # Emergent LlmChat doesn't expose usage stats reliably here; log a
    # flat estimate so the counter isn't zero. (Real spend is on the
    # universal-key ledger; this feature key is for internal analytics.)
    try:
        await record_llm(
            feature="ai-vendor-intel-research",
            provider="anthropic",
            model=model_used,
            input_tokens=1500,   # rough estimate — one prompt + system
            output_tokens=500,
            company_id=None,
        )
    except Exception:
        logger.exception("research_vendor: cost log failed")

    parsed = _extract_json_object(text)
    if not parsed:
        logger.warning("research_vendor: no JSON in response for %r: %s",
                       canonical, (text or "")[:200])
        return None

    if not isinstance(parsed.get("categorization_by_industry"), dict):
        logger.info("research_vendor: unrecognized/skipped %r (conf=%s)",
                    canonical, parsed.get("confidence"))
        return None
    return parsed


# ---------------------------------------------------------------------------
# Upsert — layered dedup / human-override protection
# ---------------------------------------------------------------------------

async def upsert_intel(name: str, payload: dict) -> Optional[dict]:
    """Insert or refresh a vendor intel row from LLM research. Idempotent
    via the `normalized_name` unique index.

    Human-verified rows (`verified_by` set) are IMMUTABLE — we return
    the existing row unchanged so LLM re-research can't stomp on a
    superadmin's manual correction.
    """
    key = normalize_contact_name(name)
    if not key:
        return None

    existing = await db.global_vendor_intel.find_one({"normalized_name": key})
    if existing and existing.get("verified_by"):
        return existing

    now = now_iso()
    canonical = str(payload.get("canonical_name") or name).strip()[:120]
    doc = {
        "normalized_name": key,
        "canonical_name":  canonical,
        "entity_type":     payload.get("entity_type") or "unknown",
        "vendor_purpose":  payload.get("vendor_purpose") or "expense_vendor",
        "business_summary": (payload.get("business_summary") or "")[:400],
        "multi_category":  bool(payload.get("multi_category") or False),
        "categorization_by_industry": payload.get("categorization_by_industry") or {},
        "confidence":      float(payload.get("confidence") or 0),
        "updated_at":      now,
    }

    if existing:
        # Preserve first-seen metadata; merge sources list.
        sources = list(existing.get("sources") or [])
        sources.append({
            "kind": "llm_web_research",
            "at":   now,
            "confidence": doc["confidence"],
            "citations": (payload.get("citations") or [])[:8],
        })
        doc["sources"] = sources[-20:]  # cap history
        doc["created_at"] = existing.get("created_at") or now
        doc["usage_stats"] = existing.get("usage_stats") or {}
        await db.global_vendor_intel.update_one(
            {"normalized_name": key}, {"$set": doc},
        )
        return {**existing, **doc}

    doc.update({
        "id":         str(uuid.uuid4()),
        "created_at": now,
        "sources": [{
            "kind": "llm_web_research",
            "at":   now,
            "confidence": doc["confidence"],
            "citations": (payload.get("citations") or [])[:8],
        }],
        "verified_by": None,
        "usage_stats": {},
    })
    try:
        await db.global_vendor_intel.insert_one(doc)
    except Exception:
        # Race — another pod inserted the same row. Re-read and return.
        logger.info("upsert_intel: race on %r, re-reading", key)
        return await db.global_vendor_intel.find_one({"normalized_name": key})
    return doc


async def get_or_research(name: str) -> Optional[dict]:
    """Cache-first accessor. Returns a cached row when present; on miss
    kicks off a web-grounded lookup and caches the result. Callers that
    can tolerate a cache miss without blocking should call `get_intel`
    directly.

    Cached rows written under an older schema (missing `vendor_purpose`
    or `reasonable_set`) are treated as stale and re-researched, unless
    the row has been human-verified (verified_by set)."""
    cached = await get_intel(name)
    if cached is not None:
        needs_refresh = (
            not cached.get("verified_by")
            and (
                not cached.get("vendor_purpose")
                or not _has_reasonable_set(cached)
            )
        )
        if not needs_refresh:
            return cached
        logger.info("get_or_research: stale schema for %r — re-researching", name)
    fresh = await research_vendor(name)
    if fresh is None:
        return cached  # keep the stale row rather than losing data
    return await upsert_intel(name, fresh)


def _has_reasonable_set(intel: dict) -> bool:
    """True if any industry bucket on the intel row has a non-empty
    `reasonable_set`. The new schema requires it; legacy rows lack it."""
    for b in (intel.get("categorization_by_industry") or {}).values():
        if isinstance(b, dict) and (b.get("reasonable_set") or []):
            return True
    return False


__all__ = [
    "INDUSTRY_KEYS",
    "company_industry_key",
    "ensure_vendor_intel_index",
    "get_intel",
    "industry_bucket",
    "research_vendor",
    "upsert_intel",
    "get_or_research",
]
