"""Contact-Category Auditor — post-hoc audit of AI-assigned categorizations
on transactions, pivoted at the CONTACT level.

Companion to `contact_auditor.py` (which audits `contact_id` on txns).
This auditor audits `account_id` (the categorization / GAAP account) on
txns, but does its comparison one CONTACT at a time — not one txn at a
time — so a vendor like Verizon gets ONE finding regardless of how many
phone bills the book has.

Design (locked with product owner, Feb 28 2026):
  1. Model: two-hop LLM pipeline —
       (a) `global_vendor_intel.get_or_research` fills the cross-tenant
           cache on cache-miss via a web-grounded OpenAI/Anthropic call;
       (b) `_audit_batch` does the compare-expected-vs-actual step with
           the fast model (Haiku/gpt-4o-mini) in batches of 10 contacts.
  2. Authority: **flag-only by default**. Auto-apply gated on
     `auto_apply=True` AND `confidence >= auto_apply_threshold`, same
     shape as `contact_auditor`.
  3. Scope: **AI-assigned categorizations only**. If ANY of a contact's
     txns in a company has `ai_source in HUMAN_TOUCHED_SOURCES` we skip
     the WHOLE contact — that human already decided the vendor's home.
  4. Closed periods: configurable via `on_closed_period` —
       "block"          → emit an amber "period closed" finding, no writes
       "apply_anyway"   → write through with a warning stamp
       "skip_closed"    → apply only to open-period txns; still write
  5. Multi-category vendors (Amazon, Home Depot, ...): gentler nudge,
     stricter confidence floor, no `create_new_account` action.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections import Counter
from datetime import datetime, timezone, timedelta
from typing import Optional

from db import db, now_iso
from contact_auditor import _names_refer_to_same_entity, AI_ASSIGNED_SOURCES
from global_vendor_intel import (
    get_or_research, company_industry_key, industry_bucket,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------
BATCH_SIZE = 10                   # contacts per LLM compare call
PARALLEL_BATCHES = 5              # concurrent LLM calls
DEFAULT_MAX_CONTACTS_PER_RUN = 50
DEFAULT_MIN_TXNS_PER_CONTACT = 3  # not enough signal below this
DEFAULT_LOOKBACK_DAYS = 90        # wider than pairing auditor — vendor
                                  # history takes months to accumulate.
DEFAULT_AUTO_APPLY_THRESHOLD = 0.90
MULTI_CATEGORY_CONFIDENCE_FLOOR = 0.95  # extra strictness for Amazon &co.


# ai_source values indicating a HUMAN made the categorization decision
# (either directly or by authoring a rule). Presence of ANY such txn on
# a contact excludes the whole contact from audit. See handoff design
# doc for the rationale.
HUMAN_TOUCHED_SOURCES = frozenset({
    "vendor_rule", "user_rule", "manual", "manual_bulk",
    "human_reviewed", "user_bulk_approve_ai_ready",
})


# ---------------------------------------------------------------------------
# Candidate selection (contact-first)
# ---------------------------------------------------------------------------

async def _gather_candidate_contacts(
    cid: str, lookback_days: int, min_txns: int, limit: int,
) -> list[dict]:
    """Find contacts in this company whose txns are eligible for a
    category audit:
      • have `account_id` set (categorized)
      • categorization came from AI (ai_source in AI_ASSIGNED_SOURCES)
      • are within the lookback window
      • the contact has NO human-touched txns (excludes the entire contact)
      • at least `min_txns` eligible txns

    Also skips contacts whose most recent audit finding is still OPEN.
    Returns each contact enriched with `_txns` (list) and `_dominant_account`
    (id, name)."""
    since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

    # Open findings — skip contacts already flagged.
    open_contact_ids: set[str] = set()
    async for f in db.agent_findings.find(
        {"company_id": cid, "kind": "category_mismatch", "status": "open"},
        {"meta.contact_id": 1},
    ):
        c_id = (f.get("meta") or {}).get("contact_id")
        if c_id:
            open_contact_ids.add(c_id)

    # Find contacts that have at least one human-touched txn (exclude
    # entire contact per design rule).
    human_touched: set[str] = set()
    async for t in db.transactions.find(
        {
            "company_id": cid,
            "ai_source": {"$in": list(HUMAN_TOUCHED_SOURCES)},
            "contact_id": {"$nin": [None, ""]},
        },
        {"contact_id": 1},
    ):
        human_touched.add(t["contact_id"])

    # Aggregate AI-assigned txns per contact within lookback.
    # Note: `vendor_rule` appears in both AI_ASSIGNED_SOURCES (from the
    # contact auditor) AND HUMAN_TOUCHED_SOURCES here — user rules are
    # human decisions we don't second-guess. Exclude explicitly at the
    # query level so we never even consider those contacts.
    pipeline = [
        {"$match": {
            "company_id": cid,
            "contact_id": {"$nin": [None, ""]},
            "category_account_id": {"$nin": [None, ""]},
            "$and": [
                {"$or": [
                    {"ai_source": {"$in": list(AI_ASSIGNED_SOURCES)}},
                    {"ai_source": {"$regex": "^pfc_"}},
                ]},
                {"ai_source": {"$nin": list(HUMAN_TOUCHED_SOURCES)}},
            ],
            "updated_at": {"$gte": since},
        }},
        {"$group": {
            "_id": "$contact_id",
            "txn_count": {"$sum": 1},
            "accounts":  {"$addToSet": "$category_account_id"},
            "recent_ts": {"$max": "$updated_at"},
        }},
        {"$match": {"txn_count": {"$gte": min_txns}}},
        {"$sort": {"recent_ts": -1}},
        {"$limit": limit + len(open_contact_ids) + len(human_touched) + 25},
    ]
    grouped = await db.transactions.aggregate(pipeline).to_list(2000)

    picks: list[dict] = []
    for g in grouped:
        cid_key = g["_id"]
        if cid_key in open_contact_ids or cid_key in human_touched:
            continue
        picks.append({
            "contact_id": cid_key,
            "txn_count":  int(g["txn_count"]),
            "account_ids": list(g["accounts"]),
            "recent_ts":  g["recent_ts"],
        })
        if len(picks) >= limit:
            break

    if not picks:
        return []

    # Hydrate contact + account names and load the actual txns for
    # dominant-account computation.
    contact_ids = [p["contact_id"] for p in picks]
    contact_by_id: dict[str, dict] = {}
    async for c in db.contacts.find(
        {"company_id": cid, "id": {"$in": contact_ids}},
        {"id": 1, "name": 1, "normalized_name": 1, "type": 1},
    ):
        contact_by_id[c["id"]] = c

    all_account_ids: set[str] = set()
    for p in picks:
        all_account_ids.update(p["account_ids"])
    account_by_id: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": cid, "id": {"$in": list(all_account_ids)}},
        {"id": 1, "name": 1, "type": 1, "code": 1},
    ):
        account_by_id[a["id"]] = a

    # Per contact, load the eligible txns and compute dominant account.
    enriched: list[dict] = []
    for p in picks:
        contact = contact_by_id.get(p["contact_id"])
        if not contact:
            continue
        cursor = db.transactions.find({
            "company_id": cid,
            "contact_id": p["contact_id"],
            "category_account_id": {"$nin": [None, ""]},
            "$or": [
                {"ai_source": {"$in": list(AI_ASSIGNED_SOURCES)}},
                {"ai_source": {"$regex": "^pfc_"}},
            ],
            "updated_at": {"$gte": since},
        }, {
            "id": 1, "date": 1, "amount": 1, "description": 1,
            "category_account_id": 1, "category_account_name": 1,
            "ai_source": 1,
        }).sort("date", -1).limit(200)
        txns = await cursor.to_list(200)
        if not txns:
            continue
        # Dominant account = most common category_account_id among txns.
        counts = Counter(
            t["category_account_id"] for t in txns if t.get("category_account_id")
        )
        if not counts:
            continue
        dominant_id, dominant_count = counts.most_common(1)[0]
        dominant = account_by_id.get(dominant_id)
        if not dominant:
            # Fallback: use the denormalized name from any txn assigned
            # to this account_id (helps with orphaned account ids).
            name_from_txn = next(
                (t.get("category_account_name") for t in txns
                 if t.get("category_account_id") == dominant_id
                 and t.get("category_account_name")),
                "",
            )
            dominant = {"id": dominant_id, "name": name_from_txn or "", "type": ""}
        enriched.append({
            "contact":            contact,
            "txns":               txns,
            "account_by_id":      account_by_id,
            "dominant_account":   dominant,
            "dominant_count":     dominant_count,
            "total_txn_count":    len(txns),
            "distinct_accounts":  list(counts.keys()),
        })
    return enriched


# ---------------------------------------------------------------------------
# Closed-period lookup
# ---------------------------------------------------------------------------

async def _closed_ranges(cid: str) -> list[tuple[str, str]]:
    """Return a sorted list of (period_start, period_end) ISO date
    strings for every CLOSED period on this company. Empty list if
    none. Used by `_partition_txns_by_period_status`."""
    out: list[tuple[str, str]] = []
    async for p in db.close_periods.find(
        {"company_id": cid, "status": "closed"},
        {"period_start": 1, "period_end": 1},
    ):
        s, e = p.get("period_start"), p.get("period_end")
        if s and e:
            out.append((s, e))
    out.sort()
    return out


def _txn_in_closed_period(txn_date: Optional[str],
                          closed: list[tuple[str, str]]) -> bool:
    if not txn_date or not closed:
        return False
    d = txn_date[:10]
    for s, e in closed:
        if s <= d <= e:
            return True
    return False


# ---------------------------------------------------------------------------
# Comparison — LLM-assisted "same categorization intent"
# ---------------------------------------------------------------------------

_COMPARE_SYSTEM = """You are a senior bookkeeping auditor. For each vendor
in the batch you're given:
  • the vendor's canonical name and business summary
  • the categorization currently being applied on this company's books
    (an account name from THIS company's chart of accounts)
  • the categorization the platform's cross-tenant knowledge base says
    should be applied, keyed by industry (with a `primary` and optional
    `secondary` list)
  • the industry template of this specific company

Decide whether the ACTUAL categorization on the books matches the
EXPECTED categorization semantically. Use ACCOUNT NAMES, not codes.

Two account names refer to the SAME categorization intent when they
express the same GAAP purpose, even under different spellings:
  • "Repairs" ↔ "Repairs & Maintenance" ↔ "Repairs and Maintenance"
  • "Meals" ↔ "Meals & Entertainment" ↔ "Meals (50%)"
  • "Cost of Goods Sold" ↔ "COGS" ↔ "Job Materials / COGS"
  • "Office Supplies" ↔ "Office Expenses" (context-dependent — ok if
    memo is consumables)
  • "Telephone" ↔ "Utilities: Telephone" (parent:child on the CoA)
  • "Advertising" ↔ "Marketing" ↔ "Advertising & Marketing"

A match is also OK when the actual account appears in the expected
`secondary` list for this industry.

If the vendor is `multi_category=true` (Amazon, Home Depot, Costco,
Walmart, Target), the CATEGORIZATION IS EXPECTED TO VARY per txn. Emit
verdict="review_per_txn" instead of "wrong" — the CPA should look at
individual txns, not blanket-recategorize the whole vendor.

For each vendor in the input, output ONE JSON object:
  {
    "contact_id": "<verbatim id from input>",
    "verdict":    "ok" | "wrong" | "review_per_txn" | "uncertain",
    "confidence": 0.0-1.0,
    "reason":     "<one sentence>",
    "expected_account_name": "<the expected canonical account name>",
    "actual_account_name":   "<the current dominant account name>"
  }

RULES:
  1. `verdict="wrong"` requires confidence >= 0.75.
  2. `verdict="review_per_txn"` is required when the vendor is multi-category.
  3. If the actual account matches the primary OR any secondary account
     name semantically, verdict="ok".
  4. Return STRICT JSON array. No prose. No markdown. Exactly one object
     per input contact_id."""


def _build_compare_prompt(items: list[dict]) -> str:
    """items = [{contact_id, contact_name, business_summary,
                 multi_category, industry_key, expected_bucket (dict),
                 actual_account_name, sample_memos (list)}]"""
    lines = ["VENDORS TO AUDIT:"]
    for it in items:
        primary = (it["expected_bucket"] or {}).get("primary") or ""
        secondary = (it["expected_bucket"] or {}).get("secondary") or []
        notes = (it["expected_bucket"] or {}).get("notes") or ""
        lines.append(
            f"  - contact_id={it['contact_id']!r}\n"
            f"    vendor={it['contact_name']!r}\n"
            f"    business={it['business_summary']!r}\n"
            f"    multi_category={it['multi_category']}\n"
            f"    company_industry={it['industry_key']!r}\n"
            f"    expected_primary={primary!r}\n"
            f"    expected_secondary={secondary!r}\n"
            f"    expected_notes={notes!r}\n"
            f"    ACTUAL_dominant_account={it['actual_account_name']!r}\n"
            f"    sample_memos={it['sample_memos']!r}"
        )
    lines.append(
        f"\nReturn a JSON array with exactly {len(items)} objects, one "
        "per contact_id, in the schema described in the system prompt."
    )
    return "\n".join(lines)


async def _compare_batch(items: list[dict]) -> list[dict]:
    """Run one compare-batch LLM call. Returns per-contact verdicts."""
    from ai_service import _new_chat, MODEL_HAIKU
    from llm_client import UserMessage
    if not items:
        return []
    try:
        chat = _new_chat(
            system=_COMPARE_SYSTEM,
            session_id=str(uuid.uuid4()),
            model_name=MODEL_HAIKU,
            feature="ai-category-audit",
        )
        r = await chat.send_message(UserMessage(text=_build_compare_prompt(items)))
        text = r.text if hasattr(r, "text") else str(r)
    except Exception:
        logger.exception("category_auditor: LLM compare call failed")
        return []
    m = re.search(r"\[[\s\S]*\]", text or "")
    if not m:
        logger.warning("category_auditor: no JSON array: %s", (text or "")[:200])
        return []
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        logger.warning("category_auditor: unparseable JSON: %s", m.group(0)[:200])
        return []
    if not isinstance(parsed, list):
        return []
    ids_in_batch = {it["contact_id"] for it in items}
    out: list[dict] = []
    for r_item in parsed:
        if not isinstance(r_item, dict):
            continue
        if r_item.get("contact_id") in ids_in_batch:
            out.append(r_item)
    return out


# ---------------------------------------------------------------------------
# Same-account safety net (code-side; complements the LLM prompt)
# ---------------------------------------------------------------------------

def _account_names_match(a: str, b: str) -> bool:
    """Return True when two account NAMES express the same GAAP purpose.
    Reuses the `_names_refer_to_same_entity` helper (built for contact
    names) — the token-set logic is the same, only the generic-word
    stoplist differs. See the acct-specific aliases below."""
    if not a or not b:
        return False
    return _names_refer_to_same_entity(a, b)


# ---------------------------------------------------------------------------
# Findings assembly
# ---------------------------------------------------------------------------

def _pretty_count(n: int) -> str:
    return f"{n} txn" + ("" if n == 1 else "s")


def _severity_for(verdict: str) -> str:
    return {
        "wrong":           "amber",
        "review_per_txn":  "blue",
        "uncertain":       "blue",
    }.get(verdict, "blue")


def _finding_for(
    cid: str, entry: dict, intel: dict, industry_key: str,
    verdict: dict, closed_txn_ids: list[str], on_closed_period: str,
) -> Optional[dict]:
    v = verdict.get("verdict") or "uncertain"
    confidence = float(verdict.get("confidence") or 0)
    reason = str(verdict.get("reason") or "").strip()
    contact = entry["contact"]
    dominant = entry["dominant_account"]

    if v == "ok":
        return None

    # Multi-category vendors get a stricter floor before we emit any
    # "wrong" verdict — protects against LLM overconfidence on legit
    # spread across accounts.
    if intel.get("multi_category") and v == "wrong":
        if confidence < MULTI_CATEGORY_CONFIDENCE_FLOOR:
            v = "review_per_txn"

    expected_name = verdict.get("expected_account_name") or (
        (industry_bucket(intel, industry_key) or {}).get("primary") or ""
    )
    actual_name = verdict.get("actual_account_name") or dominant.get("name") or ""

    # Sanity: if names actually match under our code-side check, treat
    # as OK regardless of the LLM. Prevents false positives when the LLM
    # nitpicks between "Repairs" and "Repairs & Maintenance".
    if v == "wrong" and _account_names_match(expected_name, actual_name):
        return None

    all_affected_txn_ids = [t["id"] for t in entry["txns"] if t.get("category_account_id") == dominant["id"]]

    title_lead = {
        "wrong":          f"Categorization looks off for **{contact['name']}**",
        "review_per_txn": f"Per-txn review suggested for **{contact['name']}**",
        "uncertain":      f"Categorization unclear for **{contact['name']}**",
    }.get(v, f"Review **{contact['name']}**")

    title = (
        f"{title_lead}: "
        f"currently **{actual_name}**"
        + (f", expected **{expected_name}**" if expected_name else "")
        + f" · {_pretty_count(len(all_affected_txn_ids))}"
    )

    detail_parts = [reason] if reason else []
    if intel.get("business_summary"):
        detail_parts.append(f"_{intel['business_summary']}_")
    if intel.get("multi_category"):
        detail_parts.append(
            "This vendor legitimately spans multiple accounts — review "
            "per-transaction rather than blanket-recategorizing."
        )
    if closed_txn_ids:
        if on_closed_period == "block":
            detail_parts.append(
                f"⚠️ {len(closed_txn_ids)} of these txns are in closed periods. "
                "Apply-fix is disabled — reopen the period first."
            )
        elif on_closed_period == "skip_closed":
            detail_parts.append(
                f"ℹ️ {len(closed_txn_ids)} of these txns are in closed periods "
                "and will be SKIPPED on apply-fix."
            )
        else:  # apply_anyway
            detail_parts.append(
                f"⚠️ {len(closed_txn_ids)} of these txns are in closed periods "
                "but will still be reassigned on apply-fix."
            )

    action_label = (
        "Review" if v == "review_per_txn" or v == "uncertain"
        else ("Blocked (closed period)" if closed_txn_ids and on_closed_period == "block"
              else "Apply fix")
    )

    return {
        "kind":     "category_mismatch",
        "severity": _severity_for(v),
        "title":    title,
        "detail":   "\n\n".join(detail_parts) if detail_parts else "Review this categorization.",
        "action_label": action_label,
        "action_route": f"/accounting/transactions?contact_id={contact['id']}",
        "count": len(all_affected_txn_ids),
        "meta": {
            "contact_id":            contact["id"],
            "contact_name":          contact["name"],
            "current_account_id":    dominant["id"],
            "current_account_name":  actual_name,
            "expected_account_name": expected_name,
            "expected_secondary":    (industry_bucket(intel, industry_key) or {}).get("secondary") or [],
            "affected_txn_ids":      all_affected_txn_ids,
            "closed_txn_ids":        closed_txn_ids,
            "on_closed_period":      on_closed_period,
            "industry_key":          industry_key,
            "multi_category":        bool(intel.get("multi_category")),
            "confidence":            round(confidence, 2),
            "verdict":               v,
            "applied":               False,
        },
    }


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def run_audit(cid: str, cfg: dict) -> list[dict]:
    """Full sweep for one company. Returns finding dicts for the agent
    runner to persist. See module docstring for the design contract.

    Config knobs:
      • `max_contacts_per_run` (int, default 50)
      • `min_txns_per_contact` (int, default 3)
      • `lookback_days` (int, default 90)
      • `on_closed_period` ("block"|"apply_anyway"|"skip_closed"; default "block")
      • `auto_apply` (bool, default False)
      • `auto_apply_threshold` (float, default 0.90)
    """
    max_contacts = int(cfg.get("max_contacts_per_run") or DEFAULT_MAX_CONTACTS_PER_RUN)
    min_txns     = int(cfg.get("min_txns_per_contact") or DEFAULT_MIN_TXNS_PER_CONTACT)
    lookback     = int(cfg.get("lookback_days") or DEFAULT_LOOKBACK_DAYS)
    on_closed    = str(cfg.get("on_closed_period") or "block")
    if on_closed not in {"block", "apply_anyway", "skip_closed"}:
        on_closed = "block"

    company = await db.companies.find_one({"id": cid}, {"id": 1, "industry_template": 1})
    industry_key = company_industry_key(company or {})

    candidates = await _gather_candidate_contacts(cid, lookback, min_txns, max_contacts)
    if not candidates:
        return []

    closed = await _closed_ranges(cid)

    # Cache-miss research is inherently serial (each merchant is one
    # web-grounded LLM call). Do it up front so the compare-step can
    # batch cleanly. Bounded by max_contacts.
    intel_by_contact: dict[str, dict] = {}
    for entry in candidates:
        contact = entry["contact"]
        try:
            intel = await get_or_research(contact.get("name") or "")
        except Exception:
            logger.exception("category_auditor: intel lookup failed for %r",
                             contact.get("name"))
            intel = None
        if not intel:
            continue
        # Require categorization data — LLM abstentions get skipped.
        if not (intel.get("categorization_by_industry") or {}):
            continue
        intel_by_contact[contact["id"]] = intel

    # Build compare-batch inputs.
    batch_items: list[dict] = []
    entry_by_id: dict[str, dict] = {}
    for entry in candidates:
        contact = entry["contact"]
        intel = intel_by_contact.get(contact["id"])
        if not intel:
            continue
        bucket = industry_bucket(intel, industry_key)
        if not bucket:
            continue
        sample_memos = [
            (t.get("description") or "")[:80]
            for t in entry["txns"][:3]
            if t.get("description")
        ]
        batch_items.append({
            "contact_id":       contact["id"],
            "contact_name":     contact.get("name") or "",
            "business_summary": intel.get("business_summary") or "",
            "multi_category":   bool(intel.get("multi_category")),
            "industry_key":     industry_key,
            "expected_bucket":  bucket,
            "actual_account_name": entry["dominant_account"].get("name") or "",
            "sample_memos":     sample_memos,
        })
        entry_by_id[contact["id"]] = entry

    if not batch_items:
        return []

    # Fan-out compare calls.
    batches = [batch_items[i:i + BATCH_SIZE] for i in range(0, len(batch_items), BATCH_SIZE)]
    findings: list[dict] = []
    for group_start in range(0, len(batches), PARALLEL_BATCHES):
        group = batches[group_start:group_start + PARALLEL_BATCHES]
        verdict_lists = await asyncio.gather(
            *(_compare_batch(b) for b in group), return_exceptions=False,
        )
        for verdicts in verdict_lists:
            for v in verdicts:
                c_id = v.get("contact_id")
                entry = entry_by_id.get(c_id)
                if not entry:
                    continue
                intel = intel_by_contact.get(c_id)
                if not intel:
                    continue
                # Compute closed-period txns for this contact.
                dom_id = entry["dominant_account"]["id"]
                affected_txns = [
                    t for t in entry["txns"] if t.get("category_account_id") == dom_id
                ]
                closed_txn_ids = [
                    t["id"] for t in affected_txns
                    if _txn_in_closed_period(t.get("date"), closed)
                ]
                f = _finding_for(cid, entry, intel, industry_key,
                                 v, closed_txn_ids, on_closed)
                if f:
                    findings.append(f)

    return findings


__all__ = ["run_audit", "HUMAN_TOUCHED_SOURCES"]
