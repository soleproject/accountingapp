"""AI-populated PFC → account map builder.

REPLACES the (retired) `qbo_ai_align.py` "stamp our codes onto QBO
accounts" approach with the cleaner architecture:

    Plaid PFC (~130 detailed codes)
        ↓
    pfc_org_overrides collection  ← we populate THIS via AI (once)
        ↓
    Any account (QBO, seeded, or hybrid)

The `pfc_resolver.resolve_pfc_coa` function already reads this
collection as Step 1 (highest precedence), so once populated the
categorization pipeline just works — no changes to the resolver.

Why this is better than code-stamping:
* QBO accounts keep their original schema (no artificial codes)
* Structural accounts (AP, AR, Inventory, Fixed Assets, COGS,
  Depreciation) are NEVER touched — they simply aren't PFC targets
* AI failures are graceful: worst case, PFCs fall through to
  Step 2 (code lookup) which still hits our seeded uncategorized
* User can override any single PFC → account decision without
  polluting the chart of accounts
"""
from __future__ import annotations
import json
import re
import logging
from typing import Any

from db import db, now_iso
from pfc_mapping import PFC_COA_MAPPINGS
from pfc_resolver import set_pfc_override
from llm_client import UserMessage, TextDelta, StreamDone
from ai_service import _new_chat, MODEL_NAME

logger = logging.getLogger(__name__)


def _pfc_targets() -> list[dict]:
    """Distill the ~130 PFC detailed codes into a compact list the LLM
    can reason over. Group by primary category so the model sees
    structure (all FOOD_AND_DRINK_* codes are near each other)."""
    seen = set()
    out = []
    for m in PFC_COA_MAPPINGS:
        if m.pfc_detailed in seen:
            continue
        seen.add(m.pfc_detailed)
        out.append({
            "pfc_detailed": m.pfc_detailed,
            "pfc_primary": m.pfc_primary,
            "classification": m.classification,  # business_expense | business_income | ...
            "hint_code": m.account_code,  # our seeded target — a hint to the LLM
        })
    return out


def _prompt(targets: list[dict], accounts: list[dict]) -> str:
    return (
        "You are a CPA mapping Plaid's Personal-Finance-Category codes "
        "(PFC) to the correct account in a company's chart of accounts. "
        "Every business transaction Plaid returns carries a `pfc_detailed` "
        "code — we need to know which account on this company's books that "
        "transaction should post to.\n\n"
        "HARD RULES:\n"
        "  1. TYPE MUST MATCH: `business_expense` → expense account; "
        "     `business_income` → revenue account; `asset_movement` → "
        "     asset (bank) account; `liability_increase` → liability. "
        "     Never cross types.\n"
        "  2. NEVER map to a structural account: Accounts Payable, "
        "     Accounts Receivable, Inventory, Prepaid Expenses, Fixed "
        "     Assets, Retained Earnings, Opening Balance Equity, "
        "     Uncategorized. Those are for journal entries and manual "
        "     posting — Plaid never routes there.\n"
        "  3. NEVER map to a bank/checking/savings/credit-card account "
        "     (subtype='Bank' or subtype='cash_and_bank' or "
        "     detail_type='cash_and_bank' or type='liability' with "
        "     'credit card' in the name) UNLESS the PFC is a TRANSFER — "
        "     then it maps to the specific bank being transferred to.\n"
        "  4. Use `hint_code` as a soft suggestion for what CATEGORY this "
        "     PFC represents. Then find the best account of that "
        "     conceptual match in the actual company's chart.\n"
        "  5. If NO account in the company's chart is a good fit, return "
        "     `\"\"` for account_id. That PFC will fall through to the "
        "     seeded uncategorized default at runtime — that's fine.\n"
        "  6. Confidence: `high` (exact conceptual match), `medium` "
        "     (reasonable), `low` (weak), `none` (no match, empty id).\n\n"
        f"PFC CODES TO MAP ({len(targets)} codes):\n"
        f"{json.dumps(targets, indent=0)}\n\n"
        f"COMPANY CHART OF ACCOUNTS ({len(accounts)} accounts):\n"
        f"{json.dumps(accounts, indent=0)}\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown). Each item:\n"
        '  {"pfc_detailed": "<code>", '
        '"account_id": "<id from the chart, or empty string>", '
        '"confidence": "high|medium|low|none", '
        '"reasoning": "<one short sentence>"}'
    )


async def _ask_claude(prompt: str, company_id: str) -> list[dict]:
    chat = _new_chat(
        system=("You are a CPA mapping Plaid Personal-Finance-Category "
                "codes to accounts. Return only valid JSON, no prose."),
        session_id=f"pfc-map-{company_id[:8]}",
        model_name=MODEL_NAME,
        feature="pfc-ai-map",
        company_id=company_id,
    )
    text = ""
    async for ev in chat.stream_message(UserMessage(text=prompt)):
        if isinstance(ev, TextDelta):
            text += ev.content
        elif isinstance(ev, StreamDone):
            break
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        logger.warning("PFC AI map: no JSON in response — raw: %s", text[:400])
        return []
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        logger.warning("PFC AI map JSON parse failed: %s", e)
        return []


async def _list_company_accounts(company_id: str) -> list[dict]:
    """Return QBO accounts if any; otherwise seeded. Excludes deactivated
    and bank accounts (bank accounts are never PFC targets — see rule 3)."""
    accts = await db.accounts.find(
        {"company_id": company_id,
         "active": {"$ne": False}},
        {"id": 1, "name": 1, "type": 1, "subtype": 1, "code": 1, "source": 1,
         "_id": 0},
    ).to_list(2000)
    # Prefer QBO if present.
    qbo = [a for a in accts if a.get("source") == "qbo"]
    return qbo or accts


async def plan_pfc_map(company_id: str) -> dict[str, Any]:
    """Ask Claude for the best account for each PFC code. Returns the
    plan for review (no DB writes)."""
    accounts = await _list_company_accounts(company_id)
    if not accounts:
        return {"proposals": [], "summary": {},
                "note": "No accounts found for this company."}

    # Give the AI the accounts in a lean form.
    acct_list = [{
        "id": a["id"], "name": a.get("name", ""),
        "type": a.get("type", ""), "subtype": a.get("subtype", ""),
    } for a in accounts]

    targets = _pfc_targets()
    raw = await _ask_claude(_prompt(targets, acct_list), company_id)

    by_pfc = {r.get("pfc_detailed"): r for r in raw if r.get("pfc_detailed")}
    acct_by_id = {a["id"]: a for a in accounts}
    proposals: list[dict] = []
    summary = {"high": 0, "medium": 0, "low": 0, "none": 0}
    for t in targets:
        r = by_pfc.get(t["pfc_detailed"]) or {}
        conf = (r.get("confidence") or "none").lower()
        if conf not in summary:
            conf = "none"
        summary[conf] += 1
        acct_id = r.get("account_id") or ""
        acct = acct_by_id.get(acct_id) if acct_id else None
        proposals.append({
            "pfc_detailed": t["pfc_detailed"],
            "pfc_primary": t["pfc_primary"],
            "classification": t["classification"],
            "hint_code": t["hint_code"],
            "account_id": acct_id if acct else "",
            "account_name": acct["name"] if acct else "",
            "account_type": acct.get("type", "") if acct else "",
            "confidence": conf,
            "reasoning": (r.get("reasoning") or "")[:280],
        })
    return {"proposals": proposals, "summary": summary,
            "account_count": len(accounts)}


async def apply_pfc_map(
    company_id: str, proposals: list[dict], min_confidence: str = "medium",
) -> dict[str, int]:
    """Commit a PFC map to `pfc_org_overrides`. Only proposals with an
    account_id AND confidence >= threshold are written; the rest are
    skipped (they'll use Step-2 code fallback at resolve time)."""
    rank = {"high": 3, "medium": 2, "low": 1, "none": 0}
    threshold = rank.get(min_confidence, 2)
    valid_account_ids = {
        a["id"] async for a in db.accounts.find(
            {"company_id": company_id}, {"id": 1, "_id": 0},
        )
    }
    written = skipped = 0
    for p in proposals or []:
        pfc = (p.get("pfc_detailed") or "").strip()
        aid = (p.get("account_id") or "").strip()
        conf = (p.get("confidence") or "none").lower()
        if not pfc or not aid or aid not in valid_account_ids \
                or rank.get(conf, 0) < threshold:
            skipped += 1
            continue
        await set_pfc_override(
            company_id=company_id,
            pfc_detailed=pfc,
            category_account_id=aid,
            source="ai",
            confidence={"high": 0.9, "medium": 0.7,
                        "low": 0.4}.get(conf, 0.5),
            reasoning=p.get("reasoning"),
            ai_model=MODEL_NAME,
        )
        written += 1
    return {"written": written, "skipped": skipped}


async def get_pfc_map(company_id: str) -> list[dict]:
    """Return the current PFC → account map for this company.
    One row per detailed PFC code — either from the override collection
    or from the seeded default. UI uses this to render the settings
    page."""
    accts = await db.accounts.find(
        {"company_id": company_id},
        {"id": 1, "name": 1, "type": 1, "code": 1, "_id": 0},
    ).to_list(2000)
    acct_by_id = {a["id"]: a for a in accts}

    overrides = {}
    async for o in db.pfc_org_overrides.find({"company_id": company_id}):
        overrides[o["pfc_detailed"]] = o

    rows = []
    seen = set()
    for m in PFC_COA_MAPPINGS:
        if m.pfc_detailed in seen:
            continue
        seen.add(m.pfc_detailed)
        o = overrides.get(m.pfc_detailed)
        acct = acct_by_id.get(o["category_account_id"]) if o else None
        rows.append({
            "pfc_detailed": m.pfc_detailed,
            "pfc_primary": m.pfc_primary,
            "classification": m.classification,
            "hint_code": m.account_code,
            "account_id": o.get("category_account_id") if o else None,
            "account_name": acct["name"] if acct else None,
            "source": o.get("source") if o else None,   # ai | user | pinned
            "confidence": o.get("confidence") if o else None,
            "reasoning": o.get("reasoning") if o else None,
        })
    return rows


# ------------------------------------------------------------------
# Duplicate-cleanup after PFC map is built
# ------------------------------------------------------------------

# Codes that must NEVER be deactivated even if the PFC has been
# remapped — these are structural fallbacks the resolver falls back
# to when no override exists, so removing them would leave certain
# Plaid transactions with no destination at all.
_STRUCTURAL_KEEP_CODES = {
    "1010", "1020",   # bank / savings — receive Plaid item holders
    "2100", "2110",   # credit card payables
    "3200",           # Inter-Account Transfer
    "4999", "6999",   # Uncategorized fallbacks
    "9999",           # Uncategorized Expense (legacy fallback)
    "2000", "1200", "1300", "1500", "1100",   # AP/AR/Inventory/etc — structural
    "3000", "3100", "3300",                    # equity accounts
    "1600", "1700",                            # fixed assets
}


async def plan_cleanup(company_id: str) -> dict:
    """List seeded accounts that have a QBO equivalent AND are safely
    unreferenced. Returns {candidates: [...], kept_structural: [...]}
    for the UI to show. Nothing is written."""
    seeded = await db.accounts.find(
        {"company_id": company_id,
         "source": {"$ne": "qbo"},
         "active": {"$ne": False}},
        {"id": 1, "code": 1, "name": 1, "type": 1, "_id": 0},
    ).to_list(500)

    # Every PFC target code that has an override to a QBO account.
    overridden_codes: set[str] = set()
    qbo_by_id = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "code": 1, "name": 1, "type": 1, "_id": 0},
    ):
        qbo_by_id[a["id"]] = a

    async for o in db.pfc_org_overrides.find({"company_id": company_id}):
        aid = o.get("category_account_id")
        if not aid or aid not in qbo_by_id:
            continue
        # This PFC now routes to a QBO account. Any seeded account
        # with the same "target code" for this PFC is now redundant.
        for m in PFC_COA_MAPPINGS:
            if m.pfc_detailed == o["pfc_detailed"] and m.account_code:
                overridden_codes.add(m.account_code)

    candidates = []
    kept = []
    for a in seeded:
        code = str(a.get("code") or "")
        if code in _STRUCTURAL_KEEP_CODES:
            kept.append({**a, "reason": "structural fallback"})
            continue
        if code not in overridden_codes:
            kept.append({**a, "reason": "no QBO replacement"})
            continue

        # Reference check — never deactivate a seeded account with live
        # ledger entries pointing at it. Cheap $exists probes.
        refs = 0
        for coll, field in [
            ("transactions", "category_account_id"),
            ("invoices", "line_items.account_id"),
            ("bills", "line_items.account_id"),
            ("journal_entries", "lines.account_id"),
            ("payments", "deposit_account_id"),
        ]:
            if await db[coll].find_one(
                {"company_id": company_id, field: a["id"]},
                projection={"_id": 1},
            ):
                refs += 1
        if refs:
            kept.append({**a, "reason": f"referenced by {refs} ledger doc types"})
            continue

        # Which QBO account is going to inherit this seeded's PFC traffic?
        replacement = None
        async for o in db.pfc_org_overrides.find(
            {"company_id": company_id},
            {"pfc_detailed": 1, "category_account_id": 1, "_id": 0},
        ):
            aid = o.get("category_account_id")
            if aid not in qbo_by_id:
                continue
            for m in PFC_COA_MAPPINGS:
                if m.pfc_detailed == o["pfc_detailed"] and m.account_code == code:
                    replacement = qbo_by_id[aid]
                    break
            if replacement:
                break
        candidates.append({
            **a,
            "replacement_account_id": replacement["id"] if replacement else None,
            "replacement_name": replacement["name"] if replacement else None,
        })
    return {"candidates": candidates, "kept": kept}


async def apply_cleanup(company_id: str, account_ids: list[str]) -> dict:
    """Deactivate the given seeded accounts. Only touches docs matching
    (company_id, id ∈ ids, source != qbo). Sets active=False +
    deactivated_reason='qbo_dedup' — reversible via a simple update."""
    if not account_ids:
        return {"deactivated": 0}
    r = await db.accounts.update_many(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "id": {"$in": account_ids}, "active": {"$ne": False}},
        {"$set": {"active": False, "deactivated_at": now_iso(),
                  "deactivated_reason": "qbo_dedup"}},
    )
    return {"deactivated": r.modified_count}


async def reverse_cleanup(company_id: str) -> dict:
    """Reactivate everything we deactivated via `apply_cleanup`. Undo
    button for the settings page."""
    r = await db.accounts.update_many(
        {"company_id": company_id, "deactivated_reason": "qbo_dedup"},
        {"$set": {"active": True},
         "$unset": {"deactivated_at": "", "deactivated_reason": ""}},
    )
    return {"reactivated": r.modified_count}


async def apply_cleanup_all_seeded(company_id: str) -> dict:
    """Aggressive cleanup: deactivate EVERY seeded account (source != qbo)
    that is not referenced by an existing ledger doc AND is not one of
    the two Plaid last-resort fallbacks (6999 Uncategorized Expense,
    4999 Uncategorized Income). Keeping these two guarantees Plaid
    transactions always have a valid destination even if QBO's own
    Uncategorized accounts are missing or renamed.

    Same `deactivated_reason='qbo_dedup'` marker so `reverse_cleanup`
    undoes it in one click.
    """
    # Only two codes are protected here — the resolver's last-resort
    # income/expense fallback slots. Everything else (bank, CC, AP, AR,
    # Equity, Fixed Assets, etc.) is fair game because QBO ships its
    # own equivalents when imported.
    _PLAID_FALLBACK_CODES = {"6999", "4999"}

    seeded = await db.accounts.find(
        {"company_id": company_id,
         "source": {"$ne": "qbo"},
         "active": {"$ne": False}},
        {"id": 1, "code": 1, "name": 1, "_id": 0},
    ).to_list(2000)

    to_deactivate: list[str] = []
    skipped_referenced = 0
    skipped_fallback = 0
    for a in seeded:
        code = str(a.get("code") or "")
        if code in _PLAID_FALLBACK_CODES:
            skipped_fallback += 1
            continue
        referenced = False
        for coll, field in [
            ("transactions", "category_account_id"),
            ("invoices", "line_items.account_id"),
            ("bills", "line_items.account_id"),
            ("journal_entries", "lines.account_id"),
            ("payments", "deposit_account_id"),
        ]:
            if await db[coll].find_one(
                {"company_id": company_id, field: a["id"]},
                projection={"_id": 1},
            ):
                referenced = True
                break
        if referenced:
            skipped_referenced += 1
            continue
        to_deactivate.append(a["id"])

    if not to_deactivate:
        return {"deactivated": 0, "skipped_structural": skipped_fallback,
                "skipped_referenced": skipped_referenced}

    r = await db.accounts.update_many(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "id": {"$in": to_deactivate}, "active": {"$ne": False}},
        {"$set": {"active": False, "deactivated_at": now_iso(),
                  "deactivated_reason": "qbo_dedup"}},
    )
    return {"deactivated": r.modified_count,
            "skipped_structural": skipped_fallback,
            "skipped_referenced": skipped_referenced}

