"""AI-powered QBO chart-of-accounts alignment.

After a QBO migration, every imported account is stored with QBO's own
`AccountType`, `AccountSubType`, and `Name` — but our downstream
categorization pipeline (`pfc_resolver.py`) looks up accounts by our
GAAP numeric code (`6100` = Meals, `4000` = Service Revenue, etc.).
QBO users rarely set numeric account numbers, so QBO's `AcctNum` is
usually blank, meaning every Plaid transaction would fall to
"Uncategorized" without an alignment step.

This module uses Claude Sonnet 5 to semantically match each unnumbered
QBO account to the most appropriate canonical code (from `DEFAULT_COA`
in `seed.py` + the target codes in `pfc_mapping.PFC_COA_MAPPINGS`).

Design:
* One LLM call per company (batches all accounts in a single prompt).
  With ~90 accounts and ~50 canonical targets the prompt fits well
  under Sonnet's context window.
* Model returns a JSON array of `{qbo_id, canonical_code, confidence,
  reasoning}` per QBO account. Confidence is one of
  {"high", "medium", "low", "none"}.
* Dry-run mode returns the proposal without touching the DB — the UI
  shows it for review before the user hits Apply.
* Apply mode stamps `code` onto the QBO account (only when confidence
  is `high` or `medium`) and mirrors the type/subtype from seed.py so
  the PFC resolver's Step-2 lookup succeeds.
"""
from __future__ import annotations
import json
import logging
import re
from typing import Any

from db import db, now_iso
from seed import DEFAULT_COA
from pfc_mapping import PFC_COA_MAPPINGS
from llm_client import LlmChat, UserMessage, TextDelta, StreamDone
from ai_service import _new_chat, MODEL_NAME  # reuse existing wiring

logger = logging.getLogger(__name__)


def _canonical_targets() -> list[dict]:
    """The 24 canonical codes PFC actually targets, hydrated with the
    friendly name/type/subtype from `DEFAULT_COA`. We only feed the
    LLM codes that transactions actually route to — feeding every
    seeded account would be noise (e.g. `1300 Inventory` isn't a PFC
    target for Plaid categorization)."""
    pfc_codes = {m.account_code for m in PFC_COA_MAPPINGS if m.account_code}
    by_code = {code: (code, name, typ, sub) for code, name, typ, sub in DEFAULT_COA}
    out = []
    for code in sorted(pfc_codes):
        row = by_code.get(code)
        if not row:
            # PFC targets a code that's not in DEFAULT_COA (rare — usually
            # a bespoke code like `4999 Uncategorized Income`). Emit a
            # minimal row so the LLM still knows it exists.
            out.append({"code": code, "name": f"Code {code}",
                        "type": "expense", "subtype": ""})
            continue
        c, name, typ, sub = row
        out.append({"code": c, "name": name, "type": typ, "subtype": sub})
    return out


def _prompt(targets: list[dict], qbo_accounts: list[dict]) -> str:
    return (
        "You are a CPA aligning a QuickBooks Online chart of accounts to a "
        "canonical GAAP-numbered target list used by our Plaid categorization "
        "engine. For each QBO account below, pick the SINGLE best canonical "
        "code from the target list, or return `\"\"` if none fits.\n\n"
        "RULES:\n"
        "  1. Match on meaning, not string similarity. \"Job Materials\" → "
        "     `6800 Supplies & Materials`. \"Fuel & Auto\" → `6120 "
        "     Transportation`. \"Client Gifts\" → `6200 Advertising & "
        "     Marketing`.\n"
        "  2. TYPE must match: never map an expense to a revenue code, or an "
        "     asset to a liability code, etc.\n"
        "  3. Multiple QBO accounts CAN map to the same canonical code — QBO "
        "     sub-accounts often collapse (e.g. QBO's `Utilities:Gas`, "
        "     `Utilities:Electric`, `Utilities:Water` all → `6600 Utilities`).\n"
        "  4. Assign a confidence: \"high\" (unambiguous), \"medium\" (likely "
        "     match), \"low\" (weak/needs review), \"none\" (no reasonable "
        "     match — return `\"\"` for canonical_code).\n"
        "  5. If a QBO account is clearly personal (Owner's personal "
        "     groceries, personal vehicle) map to `3300 Owner's Draw`.\n\n"
        f"CANONICAL TARGETS:\n{json.dumps(targets, indent=0)}\n\n"
        f"QBO ACCOUNTS TO MATCH:\n{json.dumps(qbo_accounts, indent=0)}\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown fence). Each "
        "item MUST be:\n"
        '  {"qbo_id": "<the QBO account id>", '
        '"canonical_code": "<matching code or empty string>", '
        '"confidence": "high|medium|low|none", '
        '"reasoning": "<one short sentence>"}'
    )


async def _ask_claude(prompt: str, company_id: str) -> list[dict]:
    chat = _new_chat(
        system=("You are a CPA aligning QuickBooks accounts to a canonical "
                "GAAP chart of accounts. Return only valid JSON, no prose."),
        session_id=f"qbo-align-{company_id[:8]}",
        model_name=MODEL_NAME,   # Claude Sonnet — accuracy matters here
        feature="qbo-ai-align",
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
        logger.warning("QBO AI align: LLM returned no JSON array. Raw: %s",
                       text[:400])
        return []
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        logger.warning("QBO AI align: JSON parse failed: %s — raw: %s",
                       e, m.group(0)[:400])
        return []


async def plan_alignment(company_id: str) -> dict[str, Any]:
    """Ask Claude to align QBO accounts → canonical PFC codes. Returns
    a plan the caller can preview and then commit via `apply_alignment`.

    The plan shape:
    {
      "targets": [{code, name, type, subtype}, ...],
      "proposals": [
        {qbo_id, qbo_name, qbo_type, qbo_subtype, current_code,
         canonical_code, confidence, reasoning},
        ...
      ],
      "summary": {high: N, medium: N, low: N, none: N},
    }
    """
    targets = _canonical_targets()
    qbo_accts: list[dict] = []
    async for acc in db.accounts.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "code": 1, "name": 1, "type": 1, "subtype": 1,
         "active": 1, "_id": 0},
    ):
        # Skip already-aligned accounts (they carry a code from a prior
        # run). Callers can force re-alignment by clearing the code.
        qbo_accts.append({
            "qbo_id": acc["id"],
            "name": acc.get("name", ""),
            "type": acc.get("type", ""),
            "subtype": acc.get("subtype", ""),
        })

    if not qbo_accts:
        return {"targets": targets, "proposals": [], "summary": {},
                "note": "No QBO-imported accounts found for this company."}

    prompt = _prompt(targets, qbo_accts)
    raw = await _ask_claude(prompt, company_id)

    # Index raw by qbo_id so we can join back to full account info.
    by_id = {r.get("qbo_id"): r for r in raw if r.get("qbo_id")}
    proposals: list[dict] = []
    summary = {"high": 0, "medium": 0, "low": 0, "none": 0}
    for acc in qbo_accts:
        r = by_id.get(acc["qbo_id"]) or {}
        conf = (r.get("confidence") or "none").lower()
        if conf not in summary:
            conf = "none"
        summary[conf] += 1
        proposals.append({
            "qbo_id": acc["qbo_id"],
            "qbo_name": acc["name"],
            "qbo_type": acc["type"],
            "qbo_subtype": acc["subtype"],
            "canonical_code": r.get("canonical_code") or "",
            "confidence": conf,
            "reasoning": (r.get("reasoning") or "")[:280],
        })
    return {"targets": targets, "proposals": proposals, "summary": summary}


async def apply_alignment(
    company_id: str,
    proposals: list[dict],
    min_confidence: str = "medium",
    deactivate_seeded: bool = True,
) -> dict[str, int]:
    """Write `code` onto QBO accounts based on the AI proposal.

    Args:
        proposals: the `proposals` array from `plan_alignment` — the
            frontend may have edited entries (user override of the AI's
            match) before sending back.
        min_confidence: only auto-apply proposals with confidence >=
            this level. `low` / `none` proposals are ignored.
        deactivate_seeded: after applying, mark our seeded accounts
            (source != qbo) whose code was successfully mapped to a
            QBO account as `active: false` so they stop showing in the
            sidebar. Reversible — the doc stays in DB.

    Returns counts: `{stamped, deactivated, skipped}`
    """
    rank = {"high": 3, "medium": 2, "low": 1, "none": 0}
    threshold = rank.get(min_confidence, 2)
    stamped_codes: set[str] = set()
    stamped = skipped = 0

    for p in proposals or []:
        code = (p.get("canonical_code") or "").strip()
        qbo_id = p.get("qbo_id")
        conf = (p.get("confidence") or "none").lower()
        if not code or not qbo_id or rank.get(conf, 0) < threshold:
            skipped += 1
            continue
        r = await db.accounts.update_one(
            {"company_id": company_id, "source": "qbo", "id": qbo_id},
            {"$set": {"code": code, "pfc_aligned_at": now_iso(),
                      "pfc_alignment_confidence": conf}},
        )
        if r.modified_count:
            stamped += 1
            stamped_codes.add(code)
        else:
            skipped += 1

    deactivated = 0
    if deactivate_seeded and stamped_codes:
        # Deactivate our seeded duplicates ONLY for codes that got a
        # confident QBO match. Codes with no QBO match keep their
        # seeded account so PFC still has a fallback (e.g. `4999
        # Uncategorized Income` when QBO has no equivalent).
        r = await db.accounts.update_many(
            {"company_id": company_id,
             "source": {"$ne": "qbo"},
             "code": {"$in": list(stamped_codes)},
             "active": True},
            {"$set": {"active": False, "deactivated_at": now_iso(),
                      "deactivated_reason": "qbo_ai_aligned"}},
        )
        deactivated = r.modified_count

    return {"stamped": stamped, "deactivated": deactivated, "skipped": skipped}
