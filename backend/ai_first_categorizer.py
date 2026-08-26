"""AI-First categorization pipeline (Puzzle-style).

Single smart-batch LLM call, structured output constrained to the
client's CoA, prior CPA corrections as high-priority few-shot examples.
Replaces the PFC → Rules Miner → LLM cascade for companies opted into
`categorization_mode == "ai_first"`.

The LLM's job ends at "here's the account this transaction hits + the
contact." Downstream `posting_service.py` still owns all JE/GL
mechanics — the LLM never touches the ledger directly.
"""
from __future__ import annotations

import os
import json
import logging
import uuid
from typing import Any

from db import db, now_iso

log = logging.getLogger(__name__)

_MODEL_PROVIDER = "anthropic"
_MODEL_NAME = "claude-sonnet-5"
_MAX_TXNS_PER_BATCH = 50   # Keep batches small enough for tight latency + reliable JSON output.
_FEWSHOT_LIMIT = 30        # How many prior CPA-approved rows to include as examples.


async def categorize_batch(
    company_id: str,
    transactions: list[dict],
) -> list[dict]:
    """Categorize a batch of transactions in one LLM call.

    Args:
        company_id: which company these txns belong to (drives CoA + contacts + priors)
        transactions: raw txn dicts with at minimum {id, date, description, merchant, amount}

    Returns:
        List of categorization dicts, one per input txn, each with:
            {txn_id, contact_id?, contact_name?, category_account_id?,
             category_account_code?, category_account_name?, confidence,
             reasoning, needs_review}

    On any failure (LLM error, invalid JSON, unknown account code), the
    row falls back to 6999-Uncategorized Expense (or 4999 for deposits)
    with needs_review=true. Never raises — always returns a full list.
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

    # Build the prompt.
    system = _build_system_prompt(company, coa_ok, contacts)
    user_prompt = _build_user_prompt(transactions, fewshots)

    try:
        # Chunk if the batch is larger than our per-call max.
        out: list[dict] = []
        for i in range(0, len(transactions), _MAX_TXNS_PER_BATCH):
            chunk = transactions[i:i + _MAX_TXNS_PER_BATCH]
            chunk_prompt = _build_user_prompt(chunk, fewshots)
            reply = await _call_llm(system, chunk_prompt)
            out.extend(_parse_and_validate(chunk, reply, code_to_acct, contacts))
        return out
    except Exception as e:  # noqa: BLE001 — never fail the whole batch
        log.exception("AI-first categorize_batch failed cid=%s: %s", company_id, e)
        return _fallback_all(transactions, f"LLM error: {e}")


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
    """Non-streaming Claude Sonnet 5 call, returns raw text."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    key = os.environ["EMERGENT_LLM_KEY"]
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
