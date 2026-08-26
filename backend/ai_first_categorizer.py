"""AI-First categorization pipeline (Puzzle-style).

Cluster-based categorization: transactions are grouped by canonical
merchant + amount bucket. Only ONE representative row per cluster hits
the LLM; the resulting category propagates to every sibling in the
cluster. This is the same trick Puzzle / Ramp / Brex use to hit their
"98% auto-categorized" numbers — categorizing 50 Starbucks charges
costs 1 LLM call, not 50.

Cluster calls run in parallel (concurrency=8) via an asyncio Semaphore
so a big backfill (2,000 rows / ~300 clusters) categorizes in single-
digit minutes instead of an hour.

The LLM's job ends at "here's the account this transaction hits + the
contact." Downstream `posting_service.py` still owns all JE/GL
mechanics — the LLM never touches the ledger directly.

STANDARD-mode categorization (PFC → Rules Miner → LLM cascade) is NOT
affected by anything in this file — that pipeline stays 100% untouched
per product decision.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from typing import Any

from db import db, now_iso

log = logging.getLogger(__name__)

_MODEL_PROVIDER = "anthropic"
_MODEL_NAME = "claude-sonnet-5"
_REPS_PER_LLM_CALL = 60    # How many cluster reps to send in one prompt.
_LLM_CONCURRENCY = 24      # Parallel LLM calls (Anthropic rate-limit friendly).
_FEWSHOT_LIMIT = 30        # How many prior CPA-approved rows to include as examples.
_PROPAGATE_MIN_CONFIDENCE = 0.75  # Below this, cluster members go to needs_review.

# Amount buckets — same-merchant charges can hit different accounts at
# different sizes (Costco $8 = Meals, Costco $2,400 = Supplies). Splitting
# by amount bucket prevents cross-contamination when propagating.
_AMOUNT_BUCKETS = [
    (50.0, "s"),      # < $50
    (500.0, "m"),     # $50 – $500
    (5000.0, "l"),    # $500 – $5,000
    (float("inf"), "xl"),  # $5,000+
]

# Merchant strings that carry no categorization signal — never cluster
# these together, always send each row through the LLM individually.
_UNCLUSTERABLE_MERCHANT_PATTERNS = re.compile(
    r"\b(ach|wire|zelle|venmo|paypal|cash app|counter withdrawal|"
    r"check\s?deposit|check\s?#|atm|transfer|deposit|withdrawal|"
    r"payment|refund)\b",
    re.IGNORECASE,
)


async def categorize_batch(
    company_id: str,
    transactions: list[dict],
) -> list[dict]:
    """Categorize a batch of transactions using cluster-based propagation.

    Args:
        company_id: which company these txns belong to (drives CoA + contacts + priors)
        transactions: raw txn dicts with at minimum {id, date, description, merchant, amount}

    Returns:
        List of categorization dicts, one per input txn (indexed by txn_id,
        order may differ from input), each with:
            {txn_id, contact_id?, contact_name?, category_account_id?,
             category_account_code?, category_account_name?, confidence,
             reasoning, needs_review, source}

        `source` will be one of:
            "ai_first"             — rep row, categorized directly by LLM
            "ai_first_propagated"  — cluster member, cloned from a rep
            "ai_first_fallback"    — LLM error or unknown code

    On any failure the row falls back to 6999-Uncategorized Expense (or
    4999 for deposits) with needs_review=true. Never raises.
    """
    if not transactions:
        return []

    company = await db.companies.find_one({"id": company_id})
    if not company:
        return _fallback_all(transactions, "Company not found")

    # Only accounts active AND not the two Uncat sinks — those are for us
    # to route to as a fallback, never something the LLM should pick.
    accounts = await db.accounts.find(
        {"company_id": company_id, "active": {"$ne": False}},
    ).to_list(500)
    coa_ok = [a for a in accounts if a.get("code") not in ("4999", "6999", "9999")]
    if not coa_ok:
        return _fallback_all(transactions, "CoA empty")
    code_to_acct = {a["code"]: a for a in coa_ok}

    contacts = await db.contacts.find({"company_id": company_id}).to_list(500)

    fewshots = await _load_fewshots(company_id)

    # ---- CLUSTERING ------------------------------------------------------
    # Group every input txn by (canonical_merchant, amount_bucket). Rows
    # with no merchant signal (ACH, wires, checks, etc.) each form a
    # cluster of one so they get their own LLM look.
    clusters = _build_clusters(transactions)

    # One representative row per cluster. LLM only ever sees the reps.
    reps: list[dict] = [members[0] for members in clusters.values()]
    log.info(
        "AI-first cluster stats cid=%s: %d txns → %d clusters (compression=%.1fx)",
        company_id, len(transactions), len(clusters),
        len(transactions) / max(len(clusters), 1),
    )

    # ---- LLM (parallel) --------------------------------------------------
    system = _build_system_prompt(company, coa_ok, contacts)
    try:
        rep_results = await _categorize_reps_parallel(
            reps, system, fewshots, code_to_acct, contacts,
        )
    except Exception as e:  # noqa: BLE001 — never fail the whole batch
        log.exception("AI-first categorize_reps_parallel failed cid=%s: %s", company_id, e)
        return _fallback_all(transactions, f"LLM error: {e}")

    # rep_results is keyed by txn_id → categorization dict.

    # ---- PROPAGATE -------------------------------------------------------
    out: list[dict] = []
    for cluster_key, members in clusters.items():
        rep_txn_id = members[0]["id"]
        rep_result = rep_results.get(rep_txn_id)
        if not rep_result:
            # Somehow no result came back — fallback the whole cluster.
            out.extend(_fallback(m, "Cluster rep result missing") for m in members)
            continue

        # Rep itself always keeps its own result.
        out.append(rep_result)

        if len(members) == 1:
            continue

        # Decide whether to propagate. High confidence → propagate. Low
        # confidence → each cluster member goes to needs_review with the
        # same fallback account so the CPA can review them together.
        confident = rep_result.get("confidence", 0.0) >= _PROPAGATE_MIN_CONFIDENCE
        for m in members[1:]:
            if confident:
                out.append(_propagate(rep_result, m))
            else:
                out.append(_fallback(
                    m,
                    f"Cluster rep low-conf {rep_result.get('confidence', 0):.2f}"
                    f" — review together",
                ))

    return out


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------


def _build_clusters(transactions: list[dict]) -> dict[str, list[dict]]:
    """Group txns by (canonical_merchant, amount_bucket, direction).

    Returns:
        dict mapping cluster_key → list of member txns (input order
        preserved; first member is the representative).
    """
    clusters: dict[str, list[dict]] = {}
    for t in transactions:
        key = _cluster_key(t)
        clusters.setdefault(key, []).append(t)
    return clusters


def _cluster_key(txn: dict) -> str:
    """Stable cluster key for a single txn.

    Unclusterable rows (ACH, wires, checks, no-merchant) get a UNIQUE key
    per row so they cluster only with themselves — forcing an individual
    LLM look for each one. Everything else groups by canonical merchant
    + amount bucket + direction (income vs expense).
    """
    canonical = _canonicalize_merchant(txn)
    if not canonical:
        # No merchant signal → unique cluster per row.
        return f"__solo__::{txn.get('id')}"
    bucket = _amount_bucket(txn.get("amount", 0))
    direction = "in" if (txn.get("amount") or 0) > 0 else "out"
    return f"{canonical}::{bucket}::{direction}"


def _canonicalize_merchant(txn: dict) -> str:
    """Return a canonical uppercase key for the merchant, or "" if the row
    has no useful merchant signal and should not be clustered."""
    raw = (txn.get("merchant") or txn.get("merchant_name") or "").strip()
    if not raw:
        raw = (txn.get("description") or "").strip()
    if not raw:
        return ""

    # Rows whose merchant string is dominated by transfer/ACH/check noise
    # carry no reliable category signal.
    if _UNCLUSTERABLE_MERCHANT_PATTERNS.search(raw):
        return ""

    # Cleanup: uppercase, strip common suffixes, collapse whitespace, drop
    # trailing store numbers / phone / dates.
    s = raw.upper()
    s = re.sub(r"\b(LLC|INC|CORP|CO|LTD|LP|LLP|GROUP|COMPANY)\b", "", s)
    s = re.sub(r"[#*\-_]+", " ", s)
    s = re.sub(r"\d{2,}", " ", s)  # store #s, phone digits, dates
    s = re.sub(r"\s+", " ", s).strip()
    return s or ""


def _amount_bucket(amount: Any) -> str:
    try:
        a = abs(float(amount or 0))
    except (TypeError, ValueError):
        a = 0.0
    for cap, label in _AMOUNT_BUCKETS:
        if a < cap:
            return label
    return _AMOUNT_BUCKETS[-1][1]


# ---------------------------------------------------------------------------
# Parallel LLM
# ---------------------------------------------------------------------------


async def _categorize_reps_parallel(
    reps: list[dict],
    system: str,
    fewshots: list[dict],
    code_to_acct: dict[str, dict],
    contacts: list[dict],
) -> dict[str, dict]:
    """Fan out cluster reps to the LLM in parallel chunks.

    Returns a dict keyed by rep txn_id → categorization dict.
    """
    if not reps:
        return {}

    sem = asyncio.Semaphore(_LLM_CONCURRENCY)

    async def _run_chunk(chunk: list[dict]) -> list[dict]:
        async with sem:
            chunk_prompt = _build_user_prompt(chunk, fewshots)
            reply = await _call_llm(system, chunk_prompt)
            return _parse_and_validate(chunk, reply, code_to_acct, contacts)

    chunks = [
        reps[i:i + _REPS_PER_LLM_CALL]
        for i in range(0, len(reps), _REPS_PER_LLM_CALL)
    ]
    results_by_chunk = await asyncio.gather(
        *(_run_chunk(c) for c in chunks), return_exceptions=True,
    )
    out: dict[str, dict] = {}
    for chunk, chunk_res in zip(chunks, results_by_chunk):
        if isinstance(chunk_res, Exception):
            log.warning("AI-first: chunk failed, falling back rows: %s", chunk_res)
            for t in chunk:
                out[t["id"]] = _fallback(t, f"LLM chunk error: {chunk_res}")
            continue
        for r in chunk_res:
            out[r["txn_id"]] = r
    return out


# ---------------------------------------------------------------------------
# Propagation
# ---------------------------------------------------------------------------


def _propagate(rep_result: dict, member: dict) -> dict:
    """Clone the rep's categorization onto a cluster member.

    Confidence is preserved but source is stamped `ai_first_propagated`
    so downstream analytics can tell propagated rows from LLM-touched
    rows.  Reasoning cites the rep's txn_id for auditability.
    """
    cloned = dict(rep_result)
    cloned["txn_id"] = member["id"]
    cloned["source"] = "ai_first_propagated"
    cloned["reasoning"] = (
        f"Propagated from cluster rep {rep_result.get('txn_id', '?')[:8]}: "
        f"{rep_result.get('reasoning', '')}"
    )[:200]
    # If the rep was flagged needs_review, so is the member.
    return cloned


def _build_system_prompt(company: dict, accounts: list[dict], contacts: list[dict]) -> str:
    """Compact system prompt: business context + CoA target space + contacts."""
    template = company.get("industry_template") or "generic"
    coa_lines = "\n".join(
        f"  {a['code']} · {a['name']} ({a.get('type', '?')}"
        + (f" / {a.get('detail_type')}" if a.get("detail_type") else "")
        + ")"
        for a in accounts
    )
    contact_lines = (
        "\n".join(f"  {c['id']} · {c['name']}" for c in contacts[:200])
        if contacts else "  (none yet — you may propose new contacts by name)"
    )
    return (
        f"You are an accountant categorizing bank transactions for a business.\n"
        f"Business: {company.get('name', '?')}\n"
        f"Industry template: {template}\n\n"
        "TASK: For each transaction, pick the single best account CODE from the CoA "
        "below and (if a match exists) a contact_id from the contact list. Output "
        "MUST be valid JSON matching the schema in the user message.\n\n"
        "Rules:\n"
        "- account_code MUST be one of the codes listed below. If nothing fits, "
        "  return an empty string for account_code (will be flagged for CPA review).\n"
        "- If unsure between two accounts, pick the more specific one and lower "
        "  confidence.\n"
        "- confidence is 0.0-1.0. Use 0.85+ only when the merchant/description "
        "  strongly and unambiguously implies the category.\n"
        "- reasoning: one sentence, max 120 chars.\n"
        "- contact_id: match to an existing contact_id if the merchant clearly "
        "  matches. Otherwise leave blank and put a proposed name in "
        "  contact_name_new.\n\n"
        f"AVAILABLE CoA:\n{coa_lines}\n\n"
        f"AVAILABLE CONTACTS:\n{contact_lines}\n"
    )


def _build_user_prompt(txns: list[dict], fewshots: list[dict]) -> str:
    """Serialize few-shot examples + the batch to categorize."""
    lines = []
    if fewshots:
        lines.append("PRIOR CPA-APPROVED CATEGORIZATIONS (learn the client's patterns):")
        for ex in fewshots:
            lines.append(
                f"  * {ex.get('date', '?')} · {ex.get('description', '?')[:70]} · "
                f"${ex.get('amount', 0):.2f} → account {ex.get('category_account_code', '?')}"
                + (f" · contact {ex.get('contact_id')}" if ex.get('contact_id') else "")
            )
        lines.append("")

    lines.append("CATEGORIZE THESE TRANSACTIONS (return JSON array in same order):")
    for t in txns:
        lines.append(
            f"  - id={t['id']} · {t.get('date', '?')} · "
            f"description={t.get('description', '')!r} · "
            f"merchant={t.get('merchant', '') or ''!r} · "
            f"amount={t.get('amount', 0):.2f}"
        )
    lines.append("")
    lines.append(
        "Return a JSON array of objects, one per input txn, IN ORDER. Schema:\n"
        '[{"txn_id": str, "account_code": str, "contact_id": str | null, '
        '"contact_name_new": str | null, "confidence": float, "reasoning": str}]'
    )
    lines.append("Return ONLY the JSON array. No prose, no markdown fences.")
    return "\n".join(lines)


async def _load_fewshots(company_id: str) -> list[dict]:
    """Recent CPA-approved rows — the 'learning' the LLM sees."""
    cursor = db.transactions.find(
        {"company_id": company_id, "human_reviewed": True,
         "category_account_code": {"$exists": True, "$nin": [None, "", "4999", "6999", "9999"]}},
        {"date": 1, "description": 1, "merchant": 1, "amount": 1,
         "category_account_code": 1, "contact_id": 1},
    ).sort("updated_at", -1).limit(_FEWSHOT_LIMIT)
    return [t async for t in cursor]


async def _call_llm(system: str, user_prompt: str) -> str:
    """Non-streaming Claude Sonnet 5 call, returns raw text.

    Uses Anthropic prompt caching on the system block (CoA + contacts +
    few-shots, easily >1,024 tokens) — this is the same content on every
    call inside a batch, and repeats across the ~18 chunks of a 1,500-
    row backfill. Caching gives us ~50% lower per-call latency and
    ~90% lower cost on cache hits vs. a cold call.

    LiteLLM supports Anthropic's `cache_control` marker on structured
    system-block content, which we route via `initial_messages` on the
    LlmChat wrapper. Non-Anthropic providers get a plain-string system
    message via the same fallback path.
    """
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    key = os.environ["EMERGENT_LLM_KEY"]

    if _MODEL_PROVIDER == "anthropic":
        # Structured system block with `cache_control: ephemeral`. Anthropic
        # requires the cached block to be ≥1,024 tokens; our CoA + contacts
        # + few-shots easily clears that.
        initial_messages = [{
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                },
            ],
        }]
        chat = LlmChat(
            api_key=key,
            session_id=f"ai-first-{uuid.uuid4()}",
            system_message="",  # ignored — initial_messages takes precedence
            initial_messages=initial_messages,
        ).with_model(_MODEL_PROVIDER, _MODEL_NAME)
    else:
        chat = LlmChat(
            api_key=key,
            session_id=f"ai-first-{uuid.uuid4()}",
            system_message=system,
        ).with_model(_MODEL_PROVIDER, _MODEL_NAME)

    resp = await chat.send_message(UserMessage(text=user_prompt))
    return resp.strip() if isinstance(resp, str) else str(resp)


def _parse_and_validate(
    input_txns: list[dict],
    raw_reply: str,
    code_to_acct: dict[str, dict],
    contacts: list[dict],
) -> list[dict]:
    """Strip fences, parse JSON, validate account_code against CoA."""
    text = raw_reply.strip()
    # Strip common markdown fences the LLM sometimes adds despite instructions.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    try:
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001
        log.warning("AI-first: bad JSON reply, falling back all rows. text=%s", text[:400])
        return _fallback_all(input_txns, "Bad JSON from LLM")
    if not isinstance(parsed, list):
        return _fallback_all(input_txns, "LLM returned non-array")

    # Index the LLM's replies by txn_id for order-independent matching.
    by_id = {r.get("txn_id"): r for r in parsed if isinstance(r, dict)}
    contact_by_id = {c["id"]: c for c in contacts}
    out: list[dict] = []
    for t in input_txns:
        r = by_id.get(t["id"])
        if not r:
            out.append(_fallback(t, "LLM omitted this txn"))
            continue
        code = (r.get("account_code") or "").strip()
        acct = code_to_acct.get(code)
        if not acct:
            out.append(_fallback(t, f"LLM picked unknown code={code!r}"))
            continue
        conf = float(r.get("confidence") or 0.0)
        needs_review = conf < 0.85
        contact_id = r.get("contact_id") or None
        contact = contact_by_id.get(contact_id) if contact_id else None
        out.append({
            "txn_id": t["id"],
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "contact_id": contact["id"] if contact else None,
            "contact_name": contact["name"] if contact else None,
            "contact_name_new": r.get("contact_name_new") or None,
            "confidence": conf,
            "reasoning": (r.get("reasoning") or "")[:200],
            "needs_review": needs_review,
            "source": "ai_first",
        })
    return out


def _fallback(txn: dict, reason: str) -> dict:
    """Uncategorized fallback — positive amounts → 4999, negative → 6999."""
    is_income = (txn.get("amount") or 0) > 0
    return {
        "txn_id": txn["id"],
        "category_account_code": "4999" if is_income else "6999",
        "category_account_name": (
            "Uncategorized Income" if is_income else "Uncategorized Expense"
        ),
        "confidence": 0.0,
        "reasoning": reason,
        "needs_review": True,
        "source": "ai_first_fallback",
    }


def _fallback_all(txns: list[dict], reason: str) -> list[dict]:
    return [_fallback(t, reason) for t in txns]
