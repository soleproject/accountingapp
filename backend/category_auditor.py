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
      • have `category_account_id` set (categorized)
      • categorization came from AI (ai_source in AI_ASSIGNED_SOURCES)
      • are within the lookback window
      • the contact has NO human-touched txns (excludes the entire contact)
      • at least `min_txns` eligible txns

    Also skips contacts whose most recent audit finding is still OPEN.
    Returns each contact enriched with `_txns` (list) and `_dominant_account`
    (id, name, type)."""
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
        {"id": 1, "name": 1, "type": 1, "code": 1, "sub_type": 1, "account_type": 1},
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
# Account type — the balance-sheet blind-spot guard
# ---------------------------------------------------------------------------

# Account types the auditor is ALLOWED to touch. Everything else is a
# balance-sheet posting the CPA made intentionally (credit-card payoff,
# owner distribution, asset purchase, sales tax remittance) and NOT the
# auditor's job — even if the vendor "obviously" sells expenses.
_EXPENSE_TYPE_TOKENS = frozenset({
    "expense", "expenses", "cogs", "cost of goods sold",
    "other expense", "other_expense",
})
# Exception carve-outs: equity accounts where a business-vendor posting
# IS suspicious enough to audit (Owner's Draw catching medical bills is
# a legit high-value catch — see VCA Animal Hospitals, Renown Health).
_AUDITABLE_EQUITY_TOKENS = frozenset({"equity", "owner", "draw", "distributions"})


def _account_type_token(acct: dict) -> str:
    """Best-effort normalized account_type from a variable-schema account
    doc. Accounts across our seeds use `type` OR `account_type` OR
    `sub_type` — coalesce to a lowercase token."""
    for k in ("account_type", "type", "sub_type"):
        v = (acct or {}).get(k)
        if v:
            return str(v).strip().lower()
    return ""


def _current_is_auditable(acct: dict, vendor_purpose: str) -> bool:
    """Skip contacts whose current dominant account is on the balance
    sheet UNLESS the pairing is inherently suspicious (equity account
    on an expense-vendor)."""
    t = _account_type_token(acct)
    if any(tok in t for tok in _EXPENSE_TYPE_TOKENS):
        return True
    # Equity/Owner's Draw is auditable when the vendor is a normal
    # expense vendor — that's the "why is this on the owner's tab?" case.
    if any(tok in t for tok in _AUDITABLE_EQUITY_TOKENS):
        return vendor_purpose == "expense_vendor"
    # Uncategorized: audit.
    if "uncategorized" in (acct.get("name") or "").lower():
        return True
    return False


# ---------------------------------------------------------------------------
# Reasonable-set helpers
# ---------------------------------------------------------------------------

def _bucket_accounts(bucket: dict) -> tuple[list[str], list[str], str]:
    """Return (reasonable_set, hard_wrong_signals, primary) from a
    vendor-intel bucket, tolerant of the older `primary + secondary`
    shape that pre-refresh rows still carry."""
    if not bucket:
        return [], [], ""
    rs = list(bucket.get("reasonable_set") or [])
    hw = list(bucket.get("hard_wrong_signals") or [])
    primary = str(bucket.get("primary") or "").strip()
    if not rs:
        # Legacy schema: synthesize a reasonable_set from primary+secondary
        rs = [primary] if primary else []
        for s in (bucket.get("secondary") or []):
            if s and s not in rs:
                rs.append(s)
    return rs, hw, primary


def _current_in_reasonable_set(current_name: str, reasonable_set: list[str]) -> bool:
    """Semantic-match the current account name against any entry in the
    reasonable set. Uses the same-entity token logic. This is the main
    'skip — this is fine' gate for Path A."""
    if not current_name or not reasonable_set:
        return False
    for candidate in reasonable_set:
        if candidate and _names_refer_to_same_entity(current_name, candidate):
            return True
    return False


def _current_is_hard_wrong(current_name: str, hard_wrong_signals: list[str]) -> bool:
    """Is the current account explicitly listed as a hard-wrong signal
    for this vendor in this industry? Semantic match, not string equality."""
    if not current_name or not hard_wrong_signals:
        return False
    for bad in hard_wrong_signals:
        if bad and _names_refer_to_same_entity(current_name, bad):
            return True
    return False


# ---------------------------------------------------------------------------
# Comparison — LLM-assisted, but now much narrower in scope
# ---------------------------------------------------------------------------

_COMPARE_SYSTEM = """You are a senior bookkeeping auditor giving a second
opinion on AI-assigned categorizations. Real bookkeepers accept a WIDE range
of accounts for the same vendor — "Nothing To It Culinary Center" could
reasonably book to Training, Professional Fees, Dues & Subscriptions, or
Meals & Entertainment. Only escalate to a "hard_wrong" verdict when the
current posting is materially wrong.

For each vendor in the batch you receive:
  • the canonical name + business summary + entity_type + vendor_purpose
  • the current ACCOUNT_NAME and current ACCOUNT_TYPE on this book
  • the `reasonable_set` — 5-8 acceptable accounts for this vendor in this
    industry (any of these ⇒ "ok")
  • the `hard_wrong_signals` — accounts that would be a material posting
    error for this vendor
  • sample transaction memos for context

Emit ONE object per input contact_id:
  {
    "contact_id":  "...",
    "verdict":     "hard_wrong" | "soft_review" | "ok",
    "confidence":  0.0-1.0,
    "reason":      "<one sentence>",
    "expected_account_name": "<if hard_wrong, the single account you'd
                              propose posting to instead>",
    "actual_account_name":   "<verbatim current account name>"
  }

VERDICT DEFINITIONS:
  • "ok" (default; use liberally) — the current account is on the
    `reasonable_set` semantically (Software & SaaS ↔ Internet & Software
    Subscriptions, Supplies & Materials ↔ Office Supplies, etc.), OR the
    current account is a balance-sheet account and the vendor_purpose is
    `financial_institution` / `tax_authority` / `personal` (payoffs and
    transfers aren't expenses).
  • "soft_review" — the current account is NOT in the reasonable_set but
    also not on the hard_wrong list. Judgment call for the CPA. Use this
    for anything ambiguous. Do NOT propose a rename.
  • "hard_wrong" (rare — use sparingly) — current account is on the
    `hard_wrong_signals` list OR is a fundamentally different posting
    type: equity/Owner's Draw on a clear business-expense vendor,
    Uncategorized Expense on a well-known merchant, tax-authority
    payment posted to Sales Tax Payable that should be Federal Income
    Tax, etc. Requires confidence ≥ 0.80.

STRICT RULES:
  1. If the current account name matches ANY entry in the reasonable_set
     under semantic comparison (SaaS ↔ Software Subscriptions, Meals ↔
     Meals & Entertainment, Repairs ↔ Repairs & Maintenance, Telephone ↔
     Utilities: Telephone), verdict="ok".
  2. If `vendor_purpose` is `financial_institution` OR `personal` OR
     `tax_authority` AND the current account_type is `liability` or
     `asset`, verdict="ok" — payoffs and transfers are correctly on the
     balance sheet.
  3. `hard_wrong` requires BOTH: (a) confidence ≥ 0.80 AND (b) the
     current account appears on `hard_wrong_signals` OR is a clear
     equity/uncategorized posting on an expense vendor.
  4. Multi-category vendors (Amazon, Costco, Target, Walmart, Home Depot,
     Best Buy): if the current account is on the reasonable_set,
     verdict="ok". Only emit "soft_review" when it's outside the set —
     do NOT hard_wrong these vendors.
  5. Return STRICT JSON array. No prose. No markdown. Exactly one object
     per input contact_id."""


def _build_compare_prompt(items: list[dict]) -> str:
    lines = ["VENDORS TO AUDIT:"]
    for it in items:
        lines.append(
            f"  - contact_id={it['contact_id']!r}\n"
            f"    vendor={it['contact_name']!r}\n"
            f"    entity_type={it['entity_type']!r}\n"
            f"    vendor_purpose={it['vendor_purpose']!r}\n"
            f"    business={it['business_summary']!r}\n"
            f"    multi_category={it['multi_category']}\n"
            f"    company_industry={it['industry_key']!r}\n"
            f"    ACTUAL_current_account_name={it['actual_account_name']!r}\n"
            f"    ACTUAL_current_account_type={it['actual_account_type']!r}\n"
            f"    reasonable_set={it['reasonable_set']!r}\n"
            f"    hard_wrong_signals={it['hard_wrong_signals']!r}\n"
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
        "hard_wrong":   "amber",
        "soft_review":  "blue",
    }.get(verdict, "blue")


def _finding_for(
    cid: str, entry: dict, intel: dict, industry_key: str,
    verdict: dict, closed_txn_ids: list[str], on_closed_period: str,
) -> Optional[dict]:
    v = verdict.get("verdict") or "ok"
    if v == "ok":
        return None

    confidence = float(verdict.get("confidence") or 0)
    reason = str(verdict.get("reason") or "").strip()
    contact = entry["contact"]
    dominant = entry["dominant_account"]

    bucket = industry_bucket(intel, industry_key)
    reasonable_set, hard_wrong_signals, primary_guess = _bucket_accounts(bucket)

    expected_name = verdict.get("expected_account_name") or primary_guess or ""
    actual_name = verdict.get("actual_account_name") or dominant.get("name") or ""

    # SAFETY NET 1 — same-name filter runs for EVERY verdict now (not
    # just "hard_wrong"). Prevents "Office Supplies → Office Supplies"
    # cases from ever leaking through.
    if _names_refer_to_same_entity(expected_name, actual_name):
        return None

    # SAFETY NET 2 — the current account is on the reasonable_set. LLM
    # missed the semantic match; we catch it in code.
    if _current_in_reasonable_set(actual_name, reasonable_set):
        return None

    # SAFETY NET 3 — balance-sheet blind spot. Financial institutions,
    # tax authorities, and personal transfers whose current account is
    # a liability/asset are correctly on the balance sheet.
    vendor_purpose = str(intel.get("vendor_purpose") or "expense_vendor")
    if not _current_is_auditable(dominant, vendor_purpose):
        return None

    # SAFETY NET 4 — LLM said "hard_wrong" but the current account is
    # NOT on the hard_wrong list AND is not equity/uncategorized. Downgrade.
    is_equity = any(tok in _account_type_token(dominant) for tok in _AUDITABLE_EQUITY_TOKENS)
    is_uncategorized = "uncategorized" in (actual_name or "").lower()
    if v == "hard_wrong":
        listed_wrong = _current_is_hard_wrong(actual_name, hard_wrong_signals)
        if not (listed_wrong or is_equity or is_uncategorized) or confidence < 0.80:
            v = "soft_review"

    # Multi-category: never hard_wrong at the contact level. If the
    # per-txn audit (Path B) found individual bad txns those get their
    # own findings; contact-level stays soft.
    if intel.get("multi_category") and v == "hard_wrong":
        v = "soft_review"

    all_affected_txn_ids = [
        t["id"] for t in entry["txns"] if t.get("category_account_id") == dominant["id"]
    ]
    if not all_affected_txn_ids:
        return None

    title_lead = (
        f"Fix categorization for **{contact['name']}**"
        if v == "hard_wrong"
        else f"Worth a look: **{contact['name']}**"
    )
    title = (
        f"{title_lead}: currently **{actual_name}**"
        + (f" — consider **{expected_name}**" if expected_name and v == "hard_wrong" else "")
        + f" · {_pretty_count(len(all_affected_txn_ids))}"
    )

    detail_parts = [reason] if reason else []
    if intel.get("business_summary"):
        detail_parts.append(f"_{intel['business_summary']}_")
    if intel.get("multi_category"):
        detail_parts.append(
            "Multi-category vendor — different transactions may legitimately post to different accounts."
        )
    if v == "soft_review" and reasonable_set:
        detail_parts.append(
            "Any of these would also be acceptable: "
            + ", ".join(f"**{a}**" for a in reasonable_set[:6])
        )
    if closed_txn_ids and v == "hard_wrong":
        if on_closed_period == "block":
            detail_parts.append(
                f"⚠️ {len(closed_txn_ids)} of these txns are in closed periods. "
                "Apply-fix is disabled — reopen the period first."
            )
        elif on_closed_period == "skip_closed":
            detail_parts.append(
                f"ℹ️ {len(closed_txn_ids)} txns in closed periods will be SKIPPED on apply-fix."
            )
        else:
            detail_parts.append(
                f"⚠️ {len(closed_txn_ids)} txns in closed periods will still be reassigned."
            )

    if v == "hard_wrong":
        action_label = (
            "Blocked (closed period)"
            if closed_txn_ids and on_closed_period == "block"
            else "Apply fix"
        )
    else:
        action_label = "Review"

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
            "current_account_type":  _account_type_token(dominant),
            "expected_account_name": expected_name,
            "reasonable_set":        reasonable_set,
            "expected_secondary":    reasonable_set,  # legacy alias for the frontend
            "hard_wrong_signals":    hard_wrong_signals,
            "vendor_purpose":        vendor_purpose,
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
# Path B — per-transaction audit for multi-category vendors
# ---------------------------------------------------------------------------

_PER_TXN_SYSTEM = """You are a bookkeeping auditor reviewing individual
transactions at multi-category vendors (Amazon, Costco, Home Depot, Best Buy,
Walmart, Target). Each transaction may legitimately post to a different
account based on WHAT was purchased. For each transaction you receive:
  • the vendor and its `reasonable_set` of acceptable accounts
  • the transaction memo, amount, and date
  • the current account this txn is posted to

Emit ONE object per transaction:
  {
    "txn_id":     "...",
    "verdict":    "ok" | "review",
    "confidence": 0.0-1.0,
    "reason":     "<one sentence>",
    "suggested_account_name": "<only if verdict=review; account from the reasonable_set that better fits the memo>"
  }

RULES:
  1. `ok` — the current account is a defensible choice for what the memo
     describes (or the memo is ambiguous). Prefer `ok` liberally.
  2. `review` — the memo clearly suggests a different bucket than where
     it's posted (e.g., memo "AMZN Marketplace laptop $1,200" posted to
     "Office Supplies" when Fixed Assets or Equipment is on the
     reasonable_set). Requires the memo to contain enough signal.
  3. Never propose an account outside the vendor's `reasonable_set`.
  4. Return STRICT JSON array only."""


async def _per_txn_audit(
    cid: str, industry_key: str, on_closed: str,
    entries: list[dict], intel_by_contact: dict[str, dict],
    closed: list[tuple[str, str]],
) -> list[dict]:
    """Per-transaction pass for multi-category vendors. For each vendor
    we pick the largest N txns and ask the LLM which look meaningfully
    off given the memo. Emits one finding PER TXN that needs review."""
    from ai_service import _new_chat, MODEL_HAIKU
    from llm_client import UserMessage

    findings: list[dict] = []
    for entry in entries:
        contact = entry["contact"]
        intel = intel_by_contact.get(contact["id"]) or {}
        bucket = industry_bucket(intel, industry_key)
        reasonable_set, _hw, _p = _bucket_accounts(bucket)
        if not reasonable_set:
            continue
        # Pick the top 8 txns by absolute amount — that's where any
        # miscategorization has the biggest P&L impact.
        txns = sorted(
            entry["txns"],
            key=lambda t: abs(float(t.get("amount") or 0)),
            reverse=True,
        )[:8]
        if len(txns) < 2:
            continue

        # Build the prompt payload.
        def _fmt_amt(t):
            try:
                return f"${abs(float(t.get('amount') or 0)):,.2f}"
            except Exception:
                return "$?"
        items = [{
            "txn_id":  t["id"],
            "memo":    (t.get("description") or "")[:140],
            "amount":  _fmt_amt(t),
            "date":    (t.get("date") or "")[:10],
            "current_account": t.get("category_account_name") or "",
        } for t in txns]
        prompt = (
            f"VENDOR: {contact['name']!r} — {intel.get('business_summary') or ''!r}\n"
            f"REASONABLE_SET: {reasonable_set!r}\n"
            f"INDUSTRY: {industry_key!r}\n\n"
            f"Transactions:\n" +
            "\n".join(
                f"  - txn_id={it['txn_id']!r}  date={it['date']!r}  "
                f"amount={it['amount']!r}  memo={it['memo']!r}  "
                f"current={it['current_account']!r}"
                for it in items
            ) +
            f"\n\nReturn a JSON array with exactly {len(items)} objects."
        )

        try:
            chat = _new_chat(
                system=_PER_TXN_SYSTEM,
                session_id=str(uuid.uuid4()),
                model_name=MODEL_HAIKU,
                feature="ai-category-audit-per-txn",
            )
            r = await chat.send_message(UserMessage(text=prompt))
            text = r.text if hasattr(r, "text") else str(r)
        except Exception:
            logger.exception("per_txn_audit: LLM call failed for %r", contact["name"])
            continue
        m = re.search(r"\[[\s\S]*\]", text or "")
        if not m:
            continue
        try:
            parsed = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue

        review_items: list[dict] = []
        by_id = {t["id"]: t for t in txns}
        for r_item in (parsed or []):
            if not isinstance(r_item, dict):
                continue
            if r_item.get("verdict") != "review":
                continue
            if float(r_item.get("confidence") or 0) < 0.65:
                continue
            tid = r_item.get("txn_id")
            txn = by_id.get(tid)
            if not txn:
                continue
            suggested = str(r_item.get("suggested_account_name") or "").strip()
            # Guard: suggestion must be inside the reasonable_set
            if not suggested or not _current_in_reasonable_set(suggested, reasonable_set):
                continue
            # Guard: don't emit if current already matches suggestion
            cur_name = txn.get("category_account_name") or ""
            if _names_refer_to_same_entity(cur_name, suggested):
                continue
            review_items.append({
                "txn_id":            tid,
                "date":              (txn.get("date") or "")[:10],
                "amount":            float(txn.get("amount") or 0),
                "memo":              (txn.get("description") or "")[:140],
                "current_account":   cur_name,
                "suggested_account": suggested,
                "reason":            str(r_item.get("reason") or "").strip(),
                "confidence":        round(float(r_item.get("confidence") or 0), 2),
            })
        if not review_items:
            continue

        # One SUMMARY finding per multi-category vendor listing the risky
        # txns inside meta.txns — avoids exploding the findings list.
        closed_ids = [
            it["txn_id"] for it in review_items
            if _txn_in_closed_period(it.get("date"), closed)
        ]
        findings.append({
            "kind":     "category_mismatch",
            "severity": "blue",
            "title": (
                f"Per-txn review — **{contact['name']}**: "
                f"{len(review_items)} of {len(items)} sampled txns look off"
            ),
            "detail": "\n\n".join([
                f"_{intel.get('business_summary') or ''}_",
                "Individual transactions with memos that suggest a "
                "different bucket. Click through to review each.",
            ]),
            "action_label": "Review txns",
            "action_route": f"/accounting/transactions?contact_id={contact['id']}",
            "count": len(review_items),
            "meta": {
                "contact_id":            contact["id"],
                "contact_name":          contact["name"],
                "kind_variant":          "per_txn_review",
                "current_account_id":    entry["dominant_account"]["id"],
                "current_account_name":  entry["dominant_account"].get("name") or "",
                "reasonable_set":        reasonable_set,
                "expected_secondary":    reasonable_set,
                "hard_wrong_signals":    [],
                "vendor_purpose":        str(intel.get("vendor_purpose") or "expense_vendor"),
                "affected_txn_ids":      [it["txn_id"] for it in review_items],
                "closed_txn_ids":        closed_ids,
                "on_closed_period":      on_closed,
                "industry_key":          industry_key,
                "multi_category":        True,
                "confidence":            round(sum(it["confidence"] for it in review_items) / len(review_items), 2),
                "verdict":               "soft_review",
                "applied":               False,
                "per_txn_reviews":       review_items,
            },
        })
    return findings




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
        reasonable_set, hard_wrong_signals, _primary = _bucket_accounts(bucket)
        # If the reasonable_set already contains the current account,
        # short-circuit — no LLM call needed.
        actual_name = entry["dominant_account"].get("name") or ""
        if _current_in_reasonable_set(actual_name, reasonable_set):
            continue
        # Same for balance-sheet accounts on non-expense vendor purposes.
        vp = str(intel.get("vendor_purpose") or "expense_vendor")
        if not _current_is_auditable(entry["dominant_account"], vp):
            continue
        sample_memos = [
            (t.get("description") or "")[:80]
            for t in entry["txns"][:3]
            if t.get("description")
        ]
        batch_items.append({
            "contact_id":              contact["id"],
            "contact_name":            contact.get("name") or "",
            "entity_type":             intel.get("entity_type") or "unknown",
            "vendor_purpose":          vp,
            "business_summary":        intel.get("business_summary") or "",
            "multi_category":          bool(intel.get("multi_category")),
            "industry_key":            industry_key,
            "reasonable_set":          reasonable_set,
            "hard_wrong_signals":      hard_wrong_signals,
            "actual_account_name":     actual_name,
            "actual_account_type":     _account_type_token(entry["dominant_account"]),
            "sample_memos":            sample_memos,
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

    # -----------------------------------------------------------------
    # Path B — per-txn audit for multi-category vendors
    # -----------------------------------------------------------------
    # Contact-level audit collapses too much signal for vendors like
    # Amazon / Costco / Home Depot / Best Buy where the correct account
    # depends on WHAT was bought. For those vendors we do a targeted
    # follow-up pass: pick the largest N txns and ask the LLM which
    # ones look materially miscategorized, given the memo.
    multi_entries: list[dict] = []
    for entry in candidates:
        intel = intel_by_contact.get(entry["contact"]["id"])
        if not intel or not intel.get("multi_category"):
            continue
        vp = str(intel.get("vendor_purpose") or "expense_vendor")
        if vp != "expense_vendor":
            continue
        multi_entries.append(entry)

    if multi_entries:
        per_txn_findings = await _per_txn_audit(
            cid=cid, industry_key=industry_key, on_closed=on_closed,
            entries=multi_entries[:20],  # bound cost — top 20 multi-cat vendors
            intel_by_contact=intel_by_contact, closed=closed,
        )
        findings.extend(per_txn_findings)

    return findings


__all__ = ["run_audit", "HUMAN_TOUCHED_SOURCES"]
