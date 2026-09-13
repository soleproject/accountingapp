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

import asyncio
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
  • Store-locator suffixes: `WALMART SUPERCENTER #4523 ORLANDO FL` — the
    merchant is Walmart, the number/city is location metadata.

PERSON-TO-PERSON TRANSFER APPS (very important, most common false positive):
  • **Zelle / Venmo / CashApp / PayPal / Apple Cash** are TRANSPORT LAYERS,
    NOT counterparties. The counterparty is the INDIVIDUAL PERSON on the
    other end of the transfer.
  • On "Zelle Transfer Conf# XXX; ROMEO UGALI" — the counterparty is
    **Romeo Ugali**, NOT "Zelle." If the current contact is already
    "Romeo Ugali", the assignment is CORRECT — verdict=ok.
  • On "PAYPAL *SELLERNAME" — the counterparty is the seller (that
    appears after the asterisk), not PayPal.
  • On "VENMO PAYMENT TO John Smith" — the counterparty is John Smith.
  • Do NOT reassign a Zelle/Venmo/CashApp txn from a person's name to
    the app's name. That is the wrong direction of the fix.

PAYMENT PROCESSOR PROXIES (the merchant IS behind the proxy):
  • `SQ *THE COFFEE SHOP` (Square) → counterparty is The Coffee Shop.
  • `TST* RESTAURANT NAME` (Toast) → counterparty is that restaurant.
  • `AMZN MKTP US*4X8DK9` → counterparty is Amazon.
  • `STRIPE *MERCHANT` → counterparty is that merchant.

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

HARD RULES (violations = your answer will be rejected):
  1. When the memo text plausibly maps to an entity in the provided
     "existing_contacts" list — EVEN under a different spelling
     ("AMZN MKTP" → "Amazon"; "WM SUPERCENTER" → "Walmart") — prefer
     `reassign_to_existing`. Only propose `create_new` when no existing
     contact represents this entity.
  2. **`existing_contact_id` MUST be a verbatim id from the
     EXISTING_CONTACTS list above.** Do NOT invent ids. Do NOT copy the
     txn_id into the existing_contact_id field. If the correct
     counterparty is NOT in EXISTING_CONTACTS, you MUST use
     `action=create_new` instead.
  3. **`existing_contact_id` MUST NOT equal `current_contact_id`.** If
     the current contact is already correct, the verdict is "ok" — do
     not propose a reassignment to the same contact.
  4. Never mark verdict="wrong" unless confidence >= 0.75.
  5. `canonical_name` for a new contact must be the clean merchant name
     (title case, no #12345 suffixes, no ACH artifacts). E.g. "Credit
     One Bank" not "CREDIT ONE BANK DES:PAYMENT".
  6. For Zelle/Venmo/CashApp/PayPal transfers where the current contact
     is already the individual person named in the memo, verdict="ok".
  7. **The current contact is often the CANONICAL, COMPLETE name of a
     merchant that appears in an abbreviated form in the memo.** If
     `current_contact` is a plausible fuller form of what shows up in
     the memo (memo says "BASKIN #356811" and current is "Baskin-Robbins";
     memo says "IN-N-OUT SPARKS NV" and current is "In-N-Out Burger";
     memo says "SPROUTS FARMER 04/03" and current is "Sprouts Farmers
     Market"; memo says "CTLP*APP INC" and current is "App Inc"), the
     current assignment is CORRECT — verdict="ok". Do NOT propose
     shortening a canonical name to match the noisy memo string.
  8. **DO NOT propose cosmetic name expansions.** If the current
     contact is a valid short form, brand mark, or root of the fuller
     merchant name (current is "Raley's" and the merchant is "Raley's
     Supermarket"; current is "76" and merchant is "76 Gas Stations";
     current is "AT&T" and merchant is "AT&T Mobility"; current is
     "Costco" and merchant is "Costco Wholesale"), verdict="ok". A
     longer name is not automatically "more correct" — same entity =
     no change. Only propose a rename when the two names refer to
     genuinely DIFFERENT entities.
  9. **NEVER propose a placeholder `canonical_name`.** Names like
     "Individual", "Unnamed Individual", "Individual Payment",
     "Individual Person", "Anonymous", "Generic Payer", "Unknown
     Customer", "Unspecified Vendor" are FORBIDDEN — they identify
     nothing and pollute the contact list. If the memo is genuinely
     opaque (e.g. a Venmo debit with no `INDN:` name, no `*username`
     tag, and no Plaid enrichment counterparty), return
     verdict="uncertain" so the CPA can decide manually — do NOT
     invent a placeholder recipient.
  10. Return ONLY a JSON array. No prose, no markdown, no explanation
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
        # Plaid enrichment context — surfaced verbatim so the LLM can
        # extract INDN names and Plaid Enrichment counterparties without
        # having to re-parse ACH memos from `description` (which is the
        # cleaned Plaid `name` and often just "Venmo" / "Zelle").
        orig_desc = (t.get("original_description") or "")[:280]
        cps       = t.get("counterparties") or []
        cps_block = ""
        if cps:
            cps_block = "\n    counterparties=[" + ", ".join(
                f"{{name={c.get('name')!r}, type={c.get('type') or 'unknown'!r}}}"
                for c in cps if c and c.get("name")
            ) + "]"
        orig_block = f"\n    original_description={orig_desc!r}" if orig_desc else ""
        lines.append(
            f"  - txn_id={t['id']}\n"
            f"    date={t.get('date','')}, amount={amt:+.2f} ({direction})\n"
            f"    description={(t.get('description') or '')[:280]!r}\n"
            f"    merchant={t.get('merchant') or ''!r}"
            f"{orig_block}{cps_block}\n"
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
    been auto-assigned (not user-confirmed), must be within lookback window.

    Skips txns with an OPEN `contact_mismatch` finding already tracking
    them (prevents duplicate flags across runs). Skips txns whose contact
    was already applied/reverted by the auditor. Verdict=ok txns get
    NO stamp so future runs will re-check them (bounded by the
    per-run cap).
    """
    since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

    # Txns with an open contact_mismatch finding — skip to avoid dupes.
    open_txn_ids: set[str] = set()
    async for f in db.agent_findings.find(
        {"company_id": cid, "kind": "contact_mismatch", "status": "open"},
        {"meta.txn_id": 1},
    ):
        tid = (f.get("meta") or {}).get("txn_id")
        if tid:
            open_txn_ids.add(tid)

    cursor = db.transactions.find({
        "company_id": cid,
        "contact_id": {"$nin": [None, ""]},
        "$or": [
            {"ai_source": {"$in": list(AI_ASSIGNED_SOURCES)}},
            {"ai_source": {"$regex": "^pfc_"}},
        ],
        "human_reviewed": {"$ne": True},
        "updated_at": {"$gte": since},
        # Never re-touch txns already applied/reverted by the auditor.
        "contact_audit_status": {"$nin": ["auto_applied", "manually_applied", "reverted"]},
    }).sort("updated_at", -1).limit(limit + len(open_txn_ids) + 50)

    out = []
    async for t in cursor:
        if t["id"] in open_txn_ids:
            continue
        out.append(t)
        if len(out) >= limit:
            break
    return out


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

    # OK → no finding. Do NOT stamp `contact_audit_status` — that would
    # freeze this txn out of re-audits, which we want on-demand runs to
    # cover freshly. The next run will re-check anyway; cost is bounded
    # by the `max_txns_per_run` cap.
    if verdict == "ok":
        return {"skipped": True}

    if verdict == "uncertain" or verdict != "wrong":
        # Uncertain → skip. Without a concrete proposal these are just
        # "something feels off" — noise. If we later add a "let me
        # investigate this txn" affordance we can revisit.
        return {"skipped": True}

    # ── verdict == "wrong" — resolve the target contact ──
    action = audit.get("action")
    new_contact_id: str | None = None
    new_contact_label = ""
    was_created = False

    if action == "reassign_to_existing":
        candidate_id = audit.get("existing_contact_id")
        # LLM sometimes hallucinates the current contact as the fix or
        # invents an id not in the shortlist. When either happens BUT
        # the reason text names a concrete counterparty from the memo
        # (very common on the "INDN:MICHAEL GIORGI on a Credit One
        # payment" pattern), re-interpret as `create_new` using a
        # canonical name derived from the memo's DES: / merchant slot
        # rather than dropping the finding. If we can't confidently
        # extract a canonical name, fall through to a plain flag.
        proposed_bad = (
            candidate_id == txn.get("contact_id")
            or not contacts_by_id.get(candidate_id or "")
        )
        if proposed_bad:
            derived = _derive_canonical_from_memo(txn, reason)
            if derived and not _names_refer_to_same_entity(derived, current_contact_name):
                action = "create_new"
                audit = {**audit, "canonical_name": derived,
                         "contact_type": audit.get("contact_type") or "vendor",
                         "is_1099_vendor": audit.get("is_1099_vendor") or False}
                # fall through to the create_new branch below
            else:
                # Either we couldn't derive a canonical, or the derived
                # name refers to the same entity as the current contact
                # — this is a false positive (LLM was confused about a
                # correct assignment). Skip rather than flag; noise is
                # worse than a miss.
                return {"skipped": True}
        else:
            candidate = contacts_by_id.get(candidate_id)
            # Same-entity safety net: even when contact_ids differ, if
            # the proposed contact refers to the same real-world entity
            # (short form vs full form, e.g. "Raley's" vs "Raley's
            # Supermarket"), there's no user-visible improvement.
            # Usually this is a duplicate-contact issue that belongs to
            # the contacts-cleanup tool, not this auditor.
            if _names_refer_to_same_entity(candidate.get("name") or "", current_contact_name):
                return {"skipped": True}
            new_contact_id = candidate["id"]
            new_contact_label = candidate.get("name") or ""

    if action == "create_new":
        canonical_name = _clean_canonical_name(audit.get("canonical_name") or "")
        # Placeholder guard: the LLM sometimes proposes "Individual",
        # "Unnamed Individual", "Individual Payment", "Anonymous" etc.
        # when it can't resolve the real counterparty from the memo.
        # These label nothing and pollute the contact list. Skip the
        # finding rather than mint a garbage contact — the CPA can
        # always assign a real contact manually if they know who it
        # was. This is the systemic fix for Venmo/Zelle rows where
        # Plaid enrichment didn't expose the recipient.
        if _is_placeholder_canonical(canonical_name):
            return {"skipped": True}
        # Same-entity filter: if the LLM's canonical refers to the same
        # entity as the current contact (short form vs full form),
        # there's no user-visible change — skip.
        if canonical_name and _names_refer_to_same_entity(canonical_name, current_contact_name):
            return {"skipped": True}
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
        # LLM said "wrong" but proposed no concrete action (missing/
        # malformed action field). Without a proposed target we can't
        # help the CPA. Skip rather than emit a noisy "review needed"
        # flag — noise erodes trust in the auditor faster than misses do.
        return {"skipped": True}

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
                "txn_detail": _txn_detail(txn),
            },
        }

    # Flag-only path (auto_apply off OR confidence below threshold).
    # Note: we intentionally do NOT stamp `contact_audit_status` here —
    # the finding row itself is the audit trail. Stamping would prevent
    # re-runs from re-evaluating flagged rows with a better prompt.
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
            "txn_detail": _txn_detail(txn),
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
            "txn_detail": _txn_detail(txn),
        },
    }


def _txn_detail(txn: dict) -> dict:
    """Compact per-txn detail stashed on findings so the card can expand
    to show what the LLM was reasoning about."""
    return {
        "date":        txn.get("date"),
        "amount":      txn.get("amount"),
        "description": (txn.get("description") or "")[:400],
        "merchant":    txn.get("merchant") or "",
    }


# LLM placeholder / non-entity name detector.
# The auditor's LLM sometimes proposes "Individual", "Unnamed Individual",
# "Individual Payment", "Anonymous", "Customer" etc. when it can't
# resolve the real counterparty from the memo. These are useless as
# contacts — a "contact" named "Individual" tells the CPA nothing.
# Better to skip the finding entirely than mint a garbage contact.
_PLACEHOLDER_NAME_RX = re.compile(
    r"^(individual|unnamed(\s+individual)?|anonymous|generic\s+(payer|payee|contact|customer|vendor)|"
    r"unknown(\s+(payer|payee|contact|customer|vendor|individual))?|"
    r"(unspecified|unidentified|nameless)(\s+(payer|payee|contact|customer|vendor|individual))?|"
    r"individual\s+(payment|payer|payee|person|customer|transfer|deposit))\.?$",
    re.IGNORECASE,
)


def _is_placeholder_canonical(name: str | None) -> bool:
    """True when `name` is one of the useless LLM placeholder labels
    ("Individual Payment", "Unnamed Individual", "Anonymous", …). These
    identify no real entity and pollute the contact list."""
    if not name:
        return True
    return bool(_PLACEHOLDER_NAME_RX.match(name.strip()))


def _clean_canonical_name(name: str) -> str:
    """Strip ACH memo artifacts from an LLM-proposed canonical name.
    The LLM sometimes echoes the raw memo (`Credit One Bank DES:Payment
    ID:XXX INDN:XXX CO ID:XXX WEB`) instead of the clean entity name
    (`Credit One Bank`). We trim anything after the first `DES:` /
    `ID:` / `INDN:` / `CO ID:` marker."""
    if not name:
        return name
    s = name.strip()
    # Cut at any of the standard ACH descriptor tokens
    for marker in (" DES:", " ID:", " INDN:", " CO ID:", " CONF#", " CONF:"):
        idx = s.upper().find(marker)
        if idx > 0:
            s = s[:idx].strip()
    # Cap length to protect against runaway output
    return s[:80].strip(" -,.\t\n")


def _pretty_amount(txn: dict) -> str:
    try:
        return f"${abs(float(txn.get('amount') or 0)):,.2f}"
    except Exception:  # noqa: BLE001
        return "$?"


# Tokens that carry no distinguishing signal — dropped from token-set
# comparisons in `_names_refer_to_same_entity`. Deliberately conservative:
# generic industry words that pad a merchant name without changing what
# entity is meant (e.g. "Raley's" vs "Raley's Supermarket").
_GENERIC_ENTITY_TOKENS = frozenset({
    "the", "and", "of",
    "supermarket", "supermarkets", "market", "markets",
    "stores", "store", "shop", "shops",
    "gas", "stations", "station",
    "wholesale", "warehouse",
    "mobility", "wireless", "communications",
    "restaurant", "restaurants", "cafe", "coffee",
    "pharmacy", "drugstore",
    "services", "service", "solutions", "systems", "group", "holdings",
    "company", "companies",
    "bank", "banking", "financial", "credit", "union",
    "usa", "us", "america", "american",
})


def _significant_tokens(name: str) -> list[str]:
    """Break a contact name into normalized, distinguishing tokens.
    Drops corporate suffixes (via `normalize_contact_name`), pure
    punctuation, single-char apostrophe leftovers, and generic industry
    padding words. Used only to compare two names for "same entity"."""
    base = normalize_contact_name(name)
    if not base:
        return []
    raw = re.split(r"[^a-z0-9]+", base)
    return [t for t in raw if len(t) >= 2 and t not in _GENERIC_ENTITY_TOKENS]


def _names_refer_to_same_entity(a: str, b: str) -> bool:
    """True when two contact names almost certainly refer to the same
    real-world entity, just at different verbosity. Catches:
      • Exact / normalized equality ("GitHub" vs "GitHub, Inc.")
      • Short-form vs long-form ("Raley's" vs "Raley's Supermarket";
        "76" vs "76 Gas Stations"; "AT&T" vs "AT&T Mobility")
      • Same significant-token set in any order ("Wells Fargo Bank"
        vs "Bank of Wells Fargo" — rare but harmless to collapse)

    False (i.e. genuinely different entities) when the two names share
    no significant tokens (e.g. "Michael Giorgi" vs "Credit One Bank")
    or when the significant tokens diverge on brand ("Chase" vs "US
    Bank"). Errs toward "same entity" for short currents (≤1
    significant token) since those are exactly the cases where the
    auditor was over-firing.
    """
    if not a or not b:
        return False
    na, nb = normalize_contact_name(a), normalize_contact_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True

    ta, tb = _significant_tokens(a), _significant_tokens(b)
    if not ta or not tb:
        # One side collapsed to zero significant tokens (e.g. a name
        # made entirely of generic words). Fall back to normalized
        # substring check.
        return na in nb or nb in na

    set_a, set_b = set(ta), set(tb)

    # Exact significant-token set match — same entity regardless of order
    if set_a == set_b:
        return True

    # One side's significant tokens are a subset of the other's — this
    # is the "Raley's" ⊂ "Raley's Supermarket" case (after dropping
    # "supermarket" as generic; "raleys" is the only significant token
    # in both, but if the generic list ever misses a word we still want
    # to catch it).
    if set_a.issubset(set_b) or set_b.issubset(set_a):
        return True

    return False


# Common ACH descriptor patterns that surface the real counterparty.
# Matched in order — first hit wins. Used only as a fallback when the
# LLM proposes a hallucinated existing_contact_id (a no-op or an
# invented id) but its `reason` text clearly names a concrete
# counterparty from the memo.
_CANON_FROM_MEMO_PATTERNS: list[tuple[re.Pattern, int]] = [
    # "Credit One Bank DES:PAYMENT ..." → "Credit One Bank"
    (re.compile(r"^\s*([A-Z][A-Za-z0-9 &.'\-]+?)\s+DES:", re.IGNORECASE), 1),
    # "ACH HOLD Credit One Bank Payment ON 09/09" → "Credit One Bank"
    (re.compile(r"ACH HOLD\s+([A-Z][A-Za-z0-9 &.'\-]+?)\s+(?:PAYMENT|PAYROLL|DEPOSIT|TRANSFER|ON\s)", re.IGNORECASE), 1),
    # "IRS DES:USATAXPYMT ..." → "Internal Revenue Service"
    (re.compile(r"\bIRS\s+DES:USATAXPYMT", re.IGNORECASE), 0),
]


def _derive_canonical_from_memo(txn: dict, reason: str) -> str | None:
    """Best-effort canonical merchant name from the txn memo. Used as a
    fallback when the LLM correctly identified a wrong contact but
    hallucinated the existing_contact_id. Prefers Plaid's `merchant`
    field, then a curated set of ACH regex patterns, then the LLM's
    own reason text as last resort."""
    merchant = (txn.get("merchant") or "").strip()
    if merchant and not merchant.upper().startswith(("ACH", "PPD", "CCD")):
        return merchant

    desc = (txn.get("description") or "").strip()
    for rgx, grp in _CANON_FROM_MEMO_PATTERNS:
        m = rgx.search(desc)
        if m:
            if grp == 0:
                # Hard-coded canonical (e.g. IRS)
                if "IRS" in m.group(0).upper():
                    return "Internal Revenue Service"
            else:
                cand = m.group(grp).strip()
                # Title-case and trim
                if cand and 2 <= len(cand) <= 60:
                    return " ".join(w.capitalize() for w in cand.split())

    # Last-resort: pull "should be X" from the LLM's own reason string
    m = re.search(r"should be ([A-Z][A-Za-z0-9 &.'\-]{2,60})", reason)
    if m:
        return m.group(1).strip()
    m = re.search(r"counterparty is\s+([A-Z][A-Za-z0-9 &.'\-]{2,60})", reason, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return None


# ---------------------------------------------------------------------------
# Contact deduplication scan
# ---------------------------------------------------------------------------
# This pass runs BEFORE the per-txn pairing audit and flags obvious duplicate
# contacts on the company's book (e.g., "Bb Diner" + "Bb Diner Sparks",
# "Westminister Title" + "Westminster Title" typo, "R.c. Willey" + "RC
# Willey", "Healthy Paws" + "Healthy Paws Pet" + "Healthy Paws Pet Insura").
#
# Detection: pairwise similarity using three cheap signals —
#   1. `_names_refer_to_same_entity` (existing token-set / subset logic).
#   2. Edit-distance ratio ≥ 0.90 on the normalized names (catches typos
#      like "Westminister" vs "Westminster" and "Truckee Meadow" vs
#      "Truckee Meadows").
#   3. Normalized prefix — one side is a >=6-char prefix of the other AND
#      shares its first significant token (catches truncations like
#      "Tokyo Japa" prefix of "Tokyo Japanese Lifestyle").
#
# Connected components: any pair that flags becomes an edge; we take
# transitive closure so A~B, B~C fold into one 3-contact group.
#
# Keeper: contact with the most transactions wins; ties broken by
# earliest `created_at`, then shortest name (cleaner canonical). Losers
# are the rest of the component.

def _levenshtein_ratio(a: str, b: str) -> float:
    """Similarity ratio in [0,1]. 1.0 = identical. Uses a lightweight
    DP implementation to avoid pulling in `python-Levenshtein`. Cheap
    enough for the O(N²) pairwise scan (bounded at ≤200 contacts)."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if abs(la - lb) / max(la, lb) > 0.35:
        # Length disparity too large — early-out; a 90% ratio is
        # impossible when 35%+ of the chars have to be inserted.
        return 0.0
    # Rolling DP array (memory O(min(la, lb))).
    if la < lb:
        a, b = b, a
        la, lb = lb, la
    prev = list(range(lb + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * lb
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur[j] = min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = cur
    dist = prev[lb]
    return 1.0 - (dist / max(la, lb))


def _alnum_only(s: str) -> str:
    """Lowercase alphanumeric-only form of a name. Strips spaces, dots,
    apostrophes, ampersands, hyphens — so `R.c. Willey`, `RC Willey`
    and `RC-Willey` all collapse to the same key for typo detection."""
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _dedup_pair_matches(name_a: str, name_b: str) -> bool:
    """Return True when two contact names look like duplicates. Deliberately
    stricter than `_names_refer_to_same_entity`: that helper collapses any
    single-token name into a match with anything containing that token
    (great for shortlist matching, disastrous for dedup where it makes
    every "Sparks"-suffixed vendor look like the same entity).

    Signals — any one is sufficient:
      1. Same significant-token set (order-independent equality).
      2. Strict subset AND shorter side has ≥2 significant tokens.
      3. Alphanumeric-collapsed edit-distance ratio ≥ 0.92 AND at least
         one shared significant token (catches punctuation/plural typos
         "Bj's Restaurants" ↔ "Bjs Restaurants", "Truckee Meadow" ↔
         "Truckee Meadows", "R.c. Willey" ↔ "RC Willey" — which collapse
         to identical alnum keys — and "Westminister" ↔ "Westminster").
      4. Alphanumeric-prefix truncation: shorter's alnum key is a prefix
         of longer's, len(short_alnum) ≥ 8, AND both share their first
         significant token (catches "Tokyo Japa" ↔ "Tokyo Japanese
         Lifestyle").
    """
    if not name_a or not name_b:
        return False
    na = normalize_contact_name(name_a)
    nb = normalize_contact_name(name_b)
    if not na or not nb:
        return False
    if na == nb:
        return True

    ta = _significant_tokens(name_a)
    tb = _significant_tokens(name_b)
    if not ta or not tb:
        return False
    set_a, set_b = set(ta), set(tb)

    # Signal 1: exact significant-token set match
    if set_a == set_b:
        return True

    # Signal 2: strict subset with ≥2 tokens on shorter side AND at most
    # ONE new significant token on the longer side. Rejecting +2-token
    # extensions cuts false positives like "Truckee Meadows" ⊂ "Truckee
    # Meadows Water Authority" (the water district is a separate legal
    # entity), at the cost of missing 3-word-ish partial names like
    # "Healthy Paws Pet Insura" (which we still catch via VCA-style
    # subset chaining: "Healthy Paws" ↔ "Healthy Paws Pet" ↔ "Healthy
    # Paws Pet Insura" wire together through the +1-token subset rule).
    short_tokens, long_tokens = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if len(short_tokens) >= 2 and set(short_tokens).issubset(set(long_tokens)):
        extras = set(long_tokens) - set(short_tokens)
        if len(extras) <= 1:
            return True

    # Signal 3: alnum-collapsed edit-distance ≥ 0.92 + shared significant
    # token OR identical alnum keys (catches "Bj's Restaurants" ↔ "Bjs
    # Restaurants" where the apostrophe splits the sig-token but the
    # alnum key is identical).
    ka, kb = _alnum_only(name_a), _alnum_only(name_b)
    if ka and kb:
        if ka == kb:
            return True
        if _levenshtein_ratio(ka, kb) >= 0.92 and (set_a & set_b):
            return True

    # Signal 4: alnum-prefix truncation, first sig token equal, AND the
    # longer side adds at most ONE new significant token (same guard as
    # Signal 2 — rejects "Truckee Meadow" ⊂ "Truckee Meadows Water
    # Authority" while still catching "Tokyo Japa" ⊂ "Tokyo Japanese
    # Lifestyle" where the extra is a single new token).
    short_key, long_key = (ka, kb) if len(ka) <= len(kb) else (kb, ka)
    if len(short_key) >= 8 and long_key.startswith(short_key) and ta[0] == tb[0]:
        extras = set(long_tokens) - set(short_tokens)
        if len(extras) <= 1:
            return True

    return False


def _connected_components(edges: list[tuple[str, str]], node_ids: set[str]) -> list[set[str]]:
    """Union-find over the edge list. Returns components with ≥2 nodes.
    Nodes with no edges are omitted (a single contact isn't a dup)."""
    parent = {n: n for n in node_ids}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    for a, b in edges:
        union(a, b)
    groups: dict[str, set[str]] = {}
    for n in node_ids:
        r = find(n)
        groups.setdefault(r, set()).add(n)
    return [g for g in groups.values() if len(g) >= 2]


async def _scan_contact_duplicates(cid: str) -> list[dict]:
    """Return a list of `contact_duplicate` findings — one per detected
    group of duplicate contacts. Skips contacts already covered by an
    OPEN dedup finding (dedupe of dedupes). Bounded at 200 contacts.

    Keeper selection: highest txn count wins; then a "de-truncation"
    bonus (a name whose alnum key contains another member's as a
    strict prefix beats the truncated form); then LONGEST name; then
    earliest `created_at`."""
    contacts = await db.contacts.find(
        {"company_id": cid},
        {"id": 1, "name": 1, "type": 1, "created_at": 1},
    ).to_list(2000)
    if len(contacts) < 2:
        return []
    contacts = contacts[:200]  # bound O(N²) work

    # Skip contact_ids already in an open dedup finding
    already_flagged: set[str] = set()
    async for f in db.agent_findings.find(
        {"company_id": cid, "kind": "contact_duplicate", "status": "open"},
        {"meta.keeper_id": 1, "meta.loser_ids": 1},
    ):
        m = f.get("meta") or {}
        if m.get("keeper_id"):
            already_flagged.add(m["keeper_id"])
        for lid in (m.get("loser_ids") or []):
            already_flagged.add(lid)

    live = [c for c in contacts if c["id"] not in already_flagged]
    if len(live) < 2:
        return []

    # Pairwise edges
    edges: list[tuple[str, str]] = []
    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            if _dedup_pair_matches(live[i].get("name") or "", live[j].get("name") or ""):
                edges.append((live[i]["id"], live[j]["id"]))
    if not edges:
        return []

    id_to_c = {c["id"]: c for c in live}
    groups = _connected_components(edges, {c["id"] for c in live})
    if not groups:
        return []

    # Fetch txn counts for every contact in every group (bulk aggregate).
    all_ids = [i for g in groups for i in g]
    counts_pipeline = [
        {"$match": {"company_id": cid, "contact_id": {"$in": all_ids}}},
        {"$group": {"_id": "$contact_id", "n": {"$sum": 1}}},
    ]
    counts: dict[str, int] = {}
    async for row in db.transactions.aggregate(counts_pipeline):
        counts[row["_id"]] = int(row["n"])

    findings: list[dict] = []
    for group in groups:
        members = [
            {
                "id":         cid_,
                "name":       id_to_c[cid_].get("name") or "",
                "txn_count":  counts.get(cid_, 0),
                "created_at": id_to_c[cid_].get("created_at") or "",
            }
            for cid_ in group
        ]

        # De-truncation pass — when one member's alnum key is a strict
        # prefix of another's, the shorter name is a truncation
        # ("Tokyo Japa" vs "Tokyo Japanese Lifestyle") and the LONGER
        # form is always the canonical entity. Give the longer form a
        # bonus so it wins the keeper tiebreak even if txn counts tie.
        alnum_keys = {m["id"]: _alnum_only(m["name"]) for m in members}
        detrunc_bonus: dict[str, int] = {m["id"]: 0 for m in members}
        for mi in members:
            for mj in members:
                if mi["id"] == mj["id"]:
                    continue
                ki, kj = alnum_keys[mi["id"]], alnum_keys[mj["id"]]
                if ki and kj and len(ki) > len(kj) and ki.startswith(kj):
                    # `mi` is the un-truncated longer form of `mj`.
                    detrunc_bonus[mi["id"]] += 1

        # Choose keeper: most txns, then de-truncation bonus, then
        # LONGEST name (more descriptive canonical form beats a short
        # abbreviation), then earliest created_at.
        members.sort(key=lambda m: (
            -m["txn_count"],
            -detrunc_bonus[m["id"]],
            -len(m["name"]),
            m["created_at"] or "9999",
        ))
        keeper = members[0]
        losers = members[1:]
        total_txns = sum(m["txn_count"] for m in members)

        loser_labels = ", ".join(
            f"**{m['name']}** ({m['txn_count']} txn{'s' if m['txn_count'] != 1 else ''})"
            for m in losers
        )
        title = (
            f"Duplicate contacts: **{keeper['name']}** — merge "
            f"{len(losers)} similar contact{'s' if len(losers) != 1 else ''} "
            f"({total_txns} txns total)"
        )
        detail = (
            f"These contacts look like the same real-world entity as "
            f"**{keeper['name']}** (keeper — has {keeper['txn_count']} "
            f"txns). Losers to merge: {loser_labels}.\n\n"
            f"Applying will reassign every txn/invoice/bill/payment/receipt "
            f"from the losers to **{keeper['name']}** and delete the "
            f"duplicate contact rows. Undo requires manually recreating "
            f"the losers, so double-check before applying."
        )
        findings.append({
            "kind":         "contact_duplicate",
            "severity":     "amber",
            "title":        title,
            "detail":       detail,
            "action_label": "Merge",
            "action_route": f"/accounting/contacts",
            "count":        len(losers),
            "meta": {
                "keeper_id":         keeper["id"],
                "keeper_name":       keeper["name"],
                "keeper_txn_count":  keeper["txn_count"],
                "loser_ids":         [m["id"] for m in losers],
                "loser_names":       [m["name"] for m in losers],
                "loser_txn_counts":  [m["txn_count"] for m in losers],
                "total_txns":        total_txns,
                "confidence":        0.9,
                "verdict":           "wrong",
                "applied":           False,
            },
        })
    return findings


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

    findings: list[dict] = []

    # Pre-scan: flag duplicate contacts (unrelated to per-txn pairing).
    # Skipped when `cfg.skip_dedupe=True` so an admin can run a
    # pairing-only sweep if the dedup pass ever needs to be quiet.
    if not bool(cfg.get("skip_dedupe") or False):
        try:
            dedup_findings = await _scan_contact_duplicates(cid)
            findings.extend(dedup_findings)
        except Exception:
            logger.exception("contact_auditor: dedupe scan failed for %r", cid)

    txns = await _gather_candidates(cid, lookback, max_txns)
    if not txns:
        return findings

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

    within_batch_caches: list[dict[str, str]] = []  # one per parallel batch

    # Fan out batches in parallel groups of 5 — Haiku is IO-bound, so
    # concurrency here cuts a 25-batch sweep from ~90s to ~20s. Each
    # batch gets its own within-batch cache to prevent stepping on
    # a sibling batch's newly-created contact (Layer 3 DB unique index
    # is the failsafe when cross-batch races occur).
    PARALLEL = 5
    batches = [txns[i:i + BATCH_SIZE] for i in range(0, len(txns), BATCH_SIZE)]
    for group_start in range(0, len(batches), PARALLEL):
        group = batches[group_start:group_start + PARALLEL]
        audits_list = await asyncio.gather(
            *(_audit_batch(b, contacts_shortlist) for b in group),
            return_exceptions=False,
        )
        for batch, audits in zip(group, audits_list):
            audit_by_txn = {a.get("txn_id"): a for a in audits}
            batch_cache: dict[str, str] = {}
            for txn in batch:
                audit = audit_by_txn.get(txn["id"])
                if not audit:
                    continue
                result = await _apply_finding(
                    cid=cid, txn=txn, audit=audit,
                    contacts_by_id=contacts_by_id,
                    within_batch_cache=batch_cache,
                    dry_run=not auto_apply,
                )
                if result and not result.get("skipped"):
                    findings.append(result)

    return findings


__all__ = ["run_audit", "AI_ASSIGNED_SOURCES"]
