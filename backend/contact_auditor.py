"""Contact-Pairing Auditor — second-opinion review of `contact_id` assignments
after Plaid/Veryfi/statement ingestion.

Independent of `contact_resolver.py`. The resolver runs INLINE at ingestion,
optimizing for coverage + speed with deterministic-first logic and LLM as
fallback. The auditor runs POST-HOC, optimizing for accuracy with LLM-first
logic and batched calls. Two systems, one feedback loop: over time we can
mine systematic auditor corrections and propose new resolver rules
(future work — v1 is flag/auto-fix only).

Design (locked with product owner, Feb 28 2026):
  1. Model: Claude Haiku 4.5 via Emergent LLM key (best pattern-reasoning
     on ACH strings per dollar; ~$0.00053/txn amortized in batches of 10).
  2. Authority: **flag-only by default**. When the agent's config has
     `auto_apply=True`, findings with confidence ≥ `auto_apply_threshold`
     (default 0.90) get applied immediately and severity flips to `blue`
     (informational — "we already fixed this, one-tap to undo") instead of
     `amber` (pending review).
  3. Scope: **AI-assigned contacts only** — we never second-guess a
     user-confirmed contact. Skip txns with `ai_source in {"manual",
     "user_rule", "human_reviewed"}`.
  4. Trigger: on-demand only for v1 (via the standard `/agents/{id}/run-now`
     endpoint). Scheduling remains an option but isn't the default.

Duplicate-safety (the "3 txns in one batch all need Credit One Bank" case):
  - Layer 1: within-batch consolidation groups suggested new contacts by
    normalized name — one create max per unique name per batch.
  - Layer 2: `contact_resolver.normalize_contact_name` produces the match
    key; both lookups and inserts key on `normalized_name`.
  - Layer 3: MongoDB unique index on `(company_id, normalized_name)`
    (already created by `contact_resolver.ensure_contact_index`) is the
    failsafe against parallel-batch races.

Semantic matching (the "AMZN MKTP" vs "Amazon" case):
  Baked into the audit prompt itself. The LLM sees the top-20 existing
  contacts for the company AND is instructed to prefer `reassign_to_existing`
  over `create_new` when a memo maps to an entity already in the list, even
  when the string spellings differ. Fuzzy string similarity is a downstream
  safety net for the rare shortlist miss.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from db import db, now_iso
from contact_resolver import normalize_contact_name, _insert_contact

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tuning knobs — kept in-module so tests can monkeypatch and rollouts don't
# depend on env-var mutations.
# ---------------------------------------------------------------------------
BATCH_SIZE = 10                # txns per LLM call
DEFAULT_MAX_TXNS_PER_RUN = 200 # protect against a runaway sweep on a new company
DEFAULT_LOOKBACK_DAYS = 30     # audit txns updated in the last N days
SHORTLIST_TOP_N_CONTACTS = 20  # existing contacts included in the audit prompt
FUZZY_SIMILARITY_THRESHOLD = 0.90  # downstream safety net for shortlist misses
DEFAULT_AUTO_APPLY_THRESHOLD = 0.90


# `ai_source` values that indicate the contact was set by AI/rules
# (i.e. safe to second-guess). Anything not in this set = human or
# high-trust source, DO NOT audit. Matched via `_is_ai_assigned`
# below which also accepts any `pfc_*` prefix.
AI_ASSIGNED_SOURCES = frozenset({
    "directory", "contact_learning", "vendor_rule", "memory", "ai",
    "ai_new", "ai_match", "merchant_name",
})


def _is_ai_assigned(source: str | None) -> bool:
    """Match against the frozen set OR the `pfc_*` prefix family
    (pfc_primary, pfc_semantic, pfc_directory, pfc_ai, pfc_ai_new, ...)."""
    if not source:
        return False
    if source in AI_ASSIGNED_SOURCES:
        return True
    return source.startswith("pfc_")


# ---------------------------------------------------------------------------
# Prompt engineering
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a senior bookkeeping auditor. Your job is to verify that the
`contact_id` (counterparty) currently assigned to a bank transaction is the
correct real-world entity paying or being paid — NOT just any name that
happens to appear in the memo.

Common ACH memo conventions you must understand:
  • `INDN:NAME` = "Individual Name" — this is the ACCOUNTHOLDER's name on
    the payment, NOT the counterparty. E.g. on a "Credit One Bank
    DES:Payment ... INDN:MICHAEL GIORGI" line, the counterparty is
    **Credit One Bank** (the merchant being paid), and Michael Giorgi is
    just the person whose account funded the payment. Assigning
    Michael as the contact would be WRONG.
  • `ORIG:NAME` = originator of an ACH credit. On an incoming deposit,
    ORIG usually IS the counterparty.
  • `DES:PAYMENT` / `DES:PMT` / `DES:PURCHASE` = descriptor code, ignore.
  • `CO ID:XXXX` = originator company ID, ignore for contact-matching.
  • `PPD` / `CCD` / `WEB` / `TEL` = SEC codes, ignore.
  • Payment processor proxies: `SQ *`, `TST*`, `PAYPAL *`, `AMZN MKTP` —
    the real merchant is the string AFTER the proxy marker, not the
    proxy itself.
  • Store-locator suffixes: `WALMART SUPERCENTER #4523 ORLANDO FL` — the
    merchant is Walmart, the number/city is location metadata.

For each transaction in the batch, output one JSON object with:
  • `txn_id`: exact id from input
  • `verdict`: "ok" | "wrong" | "uncertain"
  • `confidence`: 0.0-1.0
  • `reason`: brief 1-sentence explanation
  • If verdict is "wrong", also include ONE of:
       `action`: "reassign_to_existing"  + `existing_contact_id`: <one of the provided contact ids>
       OR
       `action`: "create_new"            + `canonical_name`: <clean canonical merchant name>
                                          + `contact_type`: "vendor" | "customer" | "both"
                                          + `is_1099_vendor`: true | false (banks/utilities/big-cos = false; individual contractors = true)
  • If verdict is "uncertain", omit action fields — the CPA will decide.

CRITICAL RULES:
  1. When the memo text plausibly maps to an entity in the provided
     "existing_contacts" list — EVEN under a different spelling
     ("AMZN MKTP" → "Amazon"; "WM SUPERCENTER" → "Walmart") — prefer
     `reassign_to_existing`. Only propose `create_new` when no existing
     contact represents this entity.
  2. Never mark verdict="wrong" unless confidence >= 0.75.
  3. `canonical_name` for a new contact must be the clean merchant name
     (title case, no #12345 suffixes, no ACH artifacts). E.g. "Credit
     One Bank" not "CREDIT ONE BANK DES:PAYMENT".
  4. Return ONLY a JSON array. No prose, no markdown, no explanation
     outside the JSON. Exactly one object per input transaction.
"""


def _build_user_prompt(txns: list[dict], contacts_shortlist: list[dict]) -> str:
    """Serialize a batch of txns + shortlist of contacts into the audit
    prompt. Kept as a plain string builder so it's easy to eyeball what
    the LLM actually sees."""
    contacts_block = "\n".join(
        f"  - id={c['id']} | name={c['name']!r} | type={c.get('type') or 'unset'}"
        for c in contacts_shortlist
    ) or "  (no existing contacts)"

    lines = [
        "EXISTING_CONTACTS (top " + str(len(contacts_shortlist)) + " by recency):",
        contacts_block,
        "",
        "TRANSACTIONS TO AUDIT:",
    ]
    for t in txns:
        amt = float(t.get("amount") or 0)
        direction = "outflow" if amt < 0 else "inflow"
        lines.append(
            f"  - txn_id={t['id']}\n"
            f"    date={t.get('date','')}, amount={amt:+.2f} ({direction})\n"
            f"    description={(t.get('description') or '')[:280]!r}\n"
            f"    merchant={t.get('merchant') or ''!r}\n"
            f"    current_contact_id={t.get('contact_id') or 'null'}\n"
            f"    current_contact_name={t.get('_current_contact_name') or 'null'!r}"
        )

    lines.append(
        "\nReturn a JSON array with exactly "
        + str(len(txns))
        + " objects, one per txn_id above, in the schema described in the system prompt."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Candidate selection
# ---------------------------------------------------------------------------

async def _gather_candidates(cid: str, lookback_days: int, limit: int) -> list[dict]:
    """Fetch txns eligible for audit — must have a `contact_id`, must have
    been auto-assigned (not user-confirmed), must be within lookback window,
    must not have already been audited (avoid re-flagging fixed rows).

    Matches `ai_source` against both the explicit `AI_ASSIGNED_SOURCES`
    set AND any string starting with `pfc_` (covers `pfc_primary`,
    `pfc_semantic`, `pfc_ai`, etc. — the resolver stamps the specific
    variant used, and any of them are AI-driven).
    """
    since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
    cursor = db.transactions.find({
        "company_id": cid,
        "contact_id": {"$nin": [None, ""]},
        "$or": [
            {"ai_source": {"$in": list(AI_ASSIGNED_SOURCES)}},
            {"ai_source": {"$regex": "^pfc_"}},
        ],
        "human_reviewed": {"$ne": True},
        "updated_at": {"$gte": since},
        "contact_audit_status": {"$exists": False},
    }).sort("updated_at", -1).limit(limit)
    return [t async for t in cursor]


async def _hydrate_contact_names(cid: str, txns: list[dict]) -> None:
    """In-place: attach `_current_contact_name` (transient prefix) to each
    txn using a single batch fetch of the referenced contacts."""
    ids = list({t["contact_id"] for t in txns if t.get("contact_id")})
    if not ids:
        return
    by_id: dict[str, str] = {}
    async for c in db.contacts.find(
        {"company_id": cid, "id": {"$in": ids}},
        {"id": 1, "name": 1},
    ):
        by_id[c["id"]] = c.get("name") or ""
    for t in txns:
        t["_current_contact_name"] = by_id.get(t.get("contact_id") or "", "")


async def _company_contacts_shortlist(cid: str) -> list[dict]:
    """Return the top-N most-recent-activity contacts for a company. Used
    as the semantic-matching context in the audit prompt so the LLM prefers
    `reassign_to_existing` over `create_new` when a spelling variant of an
    existing entity shows up."""
    docs = await db.contacts.find(
        {"company_id": cid},
        {"id": 1, "name": 1, "type": 1, "updated_at": 1, "created_at": 1},
    ).sort([("updated_at", -1)]).limit(SHORTLIST_TOP_N_CONTACTS).to_list(SHORTLIST_TOP_N_CONTACTS)
    return docs


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

async def _audit_batch(
    txns: list[dict], contacts_shortlist: list[dict],
) -> list[dict]:
    """Send one batch to the configured fast LLM (env `LLM_MODEL_FAST` —
    Haiku 4.5 when the deploy is on Anthropic, gpt-4o-mini on OpenAI-only
    deploys) and parse the structured JSON response. Returns a list of
    per-txn audit results in the shape defined by the system prompt. On
    failure returns an empty list (upstream treats each txn as untouched)."""
    from ai_service import _new_chat, MODEL_HAIKU
    from llm_client import UserMessage
    try:
        chat = _new_chat(
            system=_SYSTEM_PROMPT,
            session_id=str(uuid.uuid4()),
            model_name=MODEL_HAIKU,
            feature="ai-contact-audit",
        )
        r = await chat.send_message(UserMessage(text=_build_user_prompt(txns, contacts_shortlist)))
        text = r.text if hasattr(r, "text") else str(r)
    except Exception:
        logger.exception("contact_auditor LLM call failed")
        return []

    # Extract JSON array — allow the model to wrap in code fences or add prose
    m = re.search(r"\[[\s\S]*\]", text or "")
    if not m:
        logger.warning("contact_auditor: no JSON array in LLM response: %s", (text or "")[:300])
        return []
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        logger.warning("contact_auditor: unparseable JSON: %s", m.group(0)[:300])
        return []
    if not isinstance(parsed, list):
        return []

    # Validate: only keep results whose txn_id was in the input batch.
    valid_ids = {t["id"] for t in txns}
    out = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        tid = item.get("txn_id")
        if tid not in valid_ids:
            continue
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# Applying an audit result (with layered dedup)
# ---------------------------------------------------------------------------

async def _resolve_or_create_contact(
    cid: str,
    canonical_name: str,
    contact_type: str | None,
    is_1099: bool,
    within_batch_cache: dict[str, str],
) -> str | None:
    """Layer 1 (in-batch cache) → Layer 2 (normalized name lookup) →
    Layer 3 (idempotent upsert via unique index). Returns the resolved
    or freshly-created contact_id, or None if the name is empty."""
    name = (canonical_name or "").strip()
    if not name:
        return None
    key = normalize_contact_name(name)
    if not key:
        return None

    # Layer 1 — same batch already produced this contact
    if key in within_batch_cache:
        return within_batch_cache[key]

    # Layer 2 — lookup by normalized_name
    existing = await db.contacts.find_one(
        {"company_id": cid, "normalized_name": key},
    )
    if existing:
        within_batch_cache[key] = existing["id"]
        return existing["id"]

    # Layer 3 — insert (idempotent via unique index; on race, returns the
    # winning doc)
    doc = await _insert_contact(cid, name, source="contact_auditor")
    # Stamp type + 1099 flag right away so the CPA doesn't have to.
    updates = {"updated_at": now_iso()}
    if contact_type in {"vendor", "customer", "both"}:
        updates["type"] = contact_type
    if is_1099:
        updates["is_1099_vendor"] = True
    await db.contacts.update_one({"id": doc["id"]}, {"$set": updates})
    within_batch_cache[key] = doc["id"]
    return doc["id"]


async def _apply_finding(
    cid: str,
    txn: dict,
    audit: dict,
    contacts_by_id: dict[str, dict],
    within_batch_cache: dict[str, str],
    dry_run: bool,
) -> dict:
    """Convert one audit dict into either a mutation (if `dry_run=False`
    AND confidence gate is met) or a flag. Returns a finding dict for
    upstream to insert into `agent_findings`."""
    verdict = audit.get("verdict")
    confidence = float(audit.get("confidence") or 0)
    reason = str(audit.get("reason") or "").strip()
    current_contact = contacts_by_id.get(txn.get("contact_id") or "", {})
    current_contact_name = current_contact.get("name") or "(none)"

    # OK → no finding, but we DO stamp the txn to skip re-audit next run.
    if verdict == "ok":
        await db.transactions.update_one(
            {"id": txn["id"]},
            {"$set": {
                "contact_audit_status": "verified",
                "contact_audit_at": now_iso(),
                "contact_audit_confidence": round(confidence, 2),
            }},
        )
        return {"skipped": True}

    if verdict == "uncertain" or verdict != "wrong":
        # Uncertain → flag for human review, no auto-apply
        title = f"Uncertain contact on {_pretty_amount(txn)} txn"
        return {
            "kind": "contact_mismatch",
            "severity": "amber",
            "title": title,
            "detail": (
                f"{reason}\n\nCurrent contact: **{current_contact_name}**"
            ),
            "action_label": "Review",
            "action_route": f"/accounting/transactions?letsReview=1&highlight={txn['id']}",
            "count": 1,
            "meta": {
                "txn_id": txn["id"],
                "current_contact_id": txn.get("contact_id"),
                "current_contact_name": current_contact_name,
                "confidence": round(confidence, 2),
                "verdict": verdict,
                "applied": False,
            },
        }

    # ── verdict == "wrong" — resolve the target contact ──
    action = audit.get("action")
    new_contact_id: str | None = None
    new_contact_label = ""
    was_created = False

    if action == "reassign_to_existing":
        candidate_id = audit.get("existing_contact_id")
        # Reject obvious hallucinations: LLM proposed the same contact
        # already on the row, or an id that isn't in this company's
        # contact list. Downgrade to a plain flag so the CPA can decide.
        if candidate_id == txn.get("contact_id"):
            return _flag_finding(
                txn, current_contact_name, confidence, reason,
                extra="LLM proposed the current contact as the fix — no-op.",
            )
        candidate = contacts_by_id.get(candidate_id) if candidate_id else None
        if not candidate:
            return _flag_finding(
                txn, current_contact_name, confidence, reason,
                extra=f"LLM proposed unknown contact_id={candidate_id}",
            )
        new_contact_id = candidate["id"]
        new_contact_label = candidate.get("name") or ""
    elif action == "create_new":
        canonical_name = audit.get("canonical_name")
        contact_type = audit.get("contact_type")
        is_1099 = bool(audit.get("is_1099_vendor"))
        new_contact_id = await _resolve_or_create_contact(
            cid, canonical_name, contact_type, is_1099, within_batch_cache,
        )
        if not new_contact_id:
            return _flag_finding(
                txn, current_contact_name, confidence, reason,
                extra="LLM proposed create_new but canonical_name was empty",
            )
        new_contact_label = canonical_name or ""
        was_created = True
    else:
        # Unknown or missing action — degrade to flag
        return _flag_finding(txn, current_contact_name, confidence, reason)

    # Auto-apply gate
    should_auto_apply = (not dry_run) and confidence >= DEFAULT_AUTO_APPLY_THRESHOLD

    if should_auto_apply:
        # Record the previous contact so the CPA can undo in one tap.
        await db.transactions.update_one(
            {"id": txn["id"]},
            {"$set": {
                "contact_id": new_contact_id,
                "prev_contact_id": txn.get("contact_id"),
                "contact_audit_status": "auto_applied",
                "contact_audit_at": now_iso(),
                "contact_audit_confidence": round(confidence, 2),
                "ai_source": "contact_auditor",
                "updated_at": now_iso(),
            }},
        )
        title = (
            f"Fixed: {current_contact_name} → **{new_contact_label}** "
            f"on {_pretty_amount(txn)}"
        )
        return {
            "kind": "contact_mismatch",
            "severity": "blue",   # informational — already applied
            "title": title,
            "detail": (
                f"{reason}\n\n"
                f"{'Created new contact' if was_created else 'Reassigned'}. "
                f"One-tap undo below."
            ),
            "action_label": "Undo",
            "action_route": f"/accounting/transactions?highlight={txn['id']}",
            "count": 1,
            "meta": {
                "txn_id": txn["id"],
                "prev_contact_id": txn.get("contact_id"),
                "prev_contact_name": current_contact_name,
                "new_contact_id": new_contact_id,
                "new_contact_name": new_contact_label,
                "created_new_contact": was_created,
                "confidence": round(confidence, 2),
                "verdict": "wrong",
                "applied": True,
            },
        }

    # Flag-only path (auto_apply off OR confidence below threshold)
    await db.transactions.update_one(
        {"id": txn["id"]},
        {"$set": {
            "contact_audit_status": "flagged",
            "contact_audit_at": now_iso(),
            "contact_audit_confidence": round(confidence, 2),
        }},
    )
    title = (
        f"Wrong contact on {_pretty_amount(txn)}: "
        f"was **{current_contact_name}**, should be **{new_contact_label}**"
    )
    return {
        "kind": "contact_mismatch",
        "severity": "amber",
        "title": title,
        "detail": reason,
        "action_label": "Apply fix",
        "action_route": f"/accounting/transactions?highlight={txn['id']}",
        "count": 1,
        "meta": {
            "txn_id": txn["id"],
            "current_contact_id": txn.get("contact_id"),
            "current_contact_name": current_contact_name,
            "proposed_contact_id": new_contact_id,
            "proposed_contact_name": new_contact_label,
            "would_create_new": was_created,
            "confidence": round(confidence, 2),
            "verdict": "wrong",
            "applied": False,
        },
    }


def _flag_finding(
    txn: dict, current_contact_name: str, confidence: float,
    reason: str, *, extra: str = "",
) -> dict:
    detail = reason + (f"\n\n_{extra}_" if extra else "")
    return {
        "kind": "contact_mismatch",
        "severity": "amber",
        "title": f"Contact review needed on {_pretty_amount(txn)}",
        "detail": detail or f"Current contact: **{current_contact_name}**",
        "action_label": "Review",
        "action_route": f"/accounting/transactions?highlight={txn['id']}",
        "count": 1,
        "meta": {
            "txn_id": txn["id"],
            "current_contact_id": txn.get("contact_id"),
            "current_contact_name": current_contact_name,
            "confidence": round(confidence, 2),
            "verdict": "wrong",
            "applied": False,
        },
    }


def _pretty_amount(txn: dict) -> str:
    try:
        return f"${abs(float(txn.get('amount') or 0)):,.2f}"
    except Exception:  # noqa: BLE001
        return "$?"


# ---------------------------------------------------------------------------
# Runner (called by the agent template)
# ---------------------------------------------------------------------------

async def run_audit(cid: str, cfg: dict) -> list[dict]:
    """Full audit sweep for one company. Returns a list of finding dicts
    ready for the agent runner to insert into `agent_findings`.

    Config knobs:
      • `max_txns_per_run` (int, default 200) — cap protects a first run
        on a large company from blowing through the LLM budget.
      • `lookback_days` (int, default 30) — only audit txns whose
        `updated_at` is within this window.
      • `auto_apply` (bool, default False) — when True, findings with
        confidence >= `auto_apply_threshold` are applied in-place with
        the previous contact recorded for one-tap undo.
      • `auto_apply_threshold` (float, default 0.90) — see above.
    """
    max_txns = int(cfg.get("max_txns_per_run") or DEFAULT_MAX_TXNS_PER_RUN)
    lookback = int(cfg.get("lookback_days") or DEFAULT_LOOKBACK_DAYS)
    auto_apply = bool(cfg.get("auto_apply") or False)

    txns = await _gather_candidates(cid, lookback, max_txns)
    if not txns:
        return []

    await _hydrate_contact_names(cid, txns)
    contacts_shortlist = await _company_contacts_shortlist(cid)
    # Also load ALL contacts as a lookup dict so we can resolve
    # `existing_contact_id` references from the LLM even when they're
    # outside the shortlist (shouldn't happen but defense in depth).
    all_contacts = await db.contacts.find(
        {"company_id": cid},
        {"id": 1, "name": 1, "type": 1},
    ).to_list(5000)
    contacts_by_id = {c["id"]: c for c in all_contacts}

    findings: list[dict] = []
    within_batch_cache: dict[str, str] = {}  # normalized_name → contact_id (rolls over per batch)

    for i in range(0, len(txns), BATCH_SIZE):
        batch = txns[i:i + BATCH_SIZE]
        # Within-batch cache resets per batch so a Layer-3 race between
        # sequential batches still gets hit correctly by Layer 2 lookup.
        within_batch_cache.clear()

        audits = await _audit_batch(batch, contacts_shortlist)
        audit_by_txn = {a.get("txn_id"): a for a in audits}

        for txn in batch:
            audit = audit_by_txn.get(txn["id"])
            if not audit:
                # LLM returned nothing for this txn — skip, will be re-audited next run
                continue
            result = await _apply_finding(
                cid=cid, txn=txn, audit=audit,
                contacts_by_id=contacts_by_id,
                within_batch_cache=within_batch_cache,
                dry_run=not auto_apply,
            )
            if result and not result.get("skipped"):
                findings.append(result)

    return findings


__all__ = ["run_audit", "AI_ASSIGNED_SOURCES"]
