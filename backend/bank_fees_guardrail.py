"""Bank-Fees guardrail — cached semantic identification + PFC-driven
re-routing of transactions that shouldn't live in a company's
Bank-Fees-equivalent account(s).

Scope: intentionally **narrow** — only touches transactions that
would post to accounts pre-identified as "Bank Fees" for the specific
company. All other accounts are unaffected.

Flow:
    1. `identify_bank_fees_accounts(cid)` — one-shot LLM semantic
       scan of the company's Chart of Accounts, returning the ids of
       every account whose role is "bank fees / banking charges /
       wire fees / merchant processing / overdraft" etc. Cached on
       `companies.bank_fees_account_ids`.
    2. `guardrail_check(cid, txn, proposed_account_id)` — returns
       `{allow, redirect_hint, reason}`. Called from
       `chat-propose-account` and the retroactive cleanup scan.
    3. Retroactive endpoint `/reviewv2/bank-fees-scan` — for existing
       pollution: sweeps posted rows already sitting in the cached
       Bank Fees accounts, groups the mis-categorized ones by PFC
       family, and returns proposed reroutes for the CPA to accept
       in bulk via the existing AI-cleanup flow.

Only Plaid PFC signal is used — if `pfc_primary` is absent the row
is left alone (no downside; the guardrail is a strict superset of
"do nothing").
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from db import db

logger = logging.getLogger(__name__)

# Keyword safety-net used when the LLM identifier returns nothing.
_KEYWORD_HINTS = (
    "bank fee", "bank charge", "banking fee", "banking cost",
    "service charge", "wire fee", "wire transfer fee",
    "atm fee", "overdraft", "merchant fee", "merchant service",
    "processing fee", "card fee", "payment processing",
    "financial charge", "banking service",
)

# Plaid PFC → semantic bucket. Only the "structural" families where PFC
# is highly reliable. Other families fall through to `unknown` and the
# guardrail flags-for-review rather than force-reroute.
PFC_BUCKETS = {
    "BANK_FEES":       "bank_fees",       # keep in Bank Fees
    "LOAN_PAYMENTS":   "loan_payments",   # → liability / CC paydown
    "TRANSFER_IN":     "transfer_in",     # → Uncategorized Income / Owner Contribution
    "TRANSFER_OUT":    "transfer_out",    # → Owner Draws / Transfer Out
    "INCOME":          "income",          # → real income category
    "RENT_AND_UTILITIES": "rent_or_utils",  # → Rent / Utilities
}


def _pfc_primary(txn: dict) -> str:
    return (txn.get("pfc_primary")
            or (txn.get("plaid_personal_finance_category") or {}).get("primary")
            or "").upper().strip()


def _pfc_detailed(txn: dict) -> str:
    return (txn.get("pfc_detailed")
            or (txn.get("plaid_personal_finance_category") or {}).get("detailed")
            or "").upper().strip()


async def _keyword_match_ids(cid: str) -> list[str]:
    ids: list[str] = []
    async for a in db.accounts.find(
        {"company_id": cid, "type": {"$in": ["expense", "cogs"]}},
        {"_id": 0, "id": 1, "name": 1},
    ):
        n = (a.get("name") or "").lower()
        if any(k in n for k in _KEYWORD_HINTS):
            ids.append(a["id"])
    return ids


async def _llm_identify(cid: str) -> list[str]:
    """One LLM call — asks Claude to pick out every account in the
    company's CoA whose semantic role is a bank-fees equivalent.
    """
    try:
        # Local imports so this module has no hard import-time
        # dependency on the LLM client for callers that only need
        # the guardrail helpers.
        from llm_client import LlmChat, UserMessage
    except Exception:  # noqa: BLE001
        return []
    key = os.getenv("EMERGENT_LLM_KEY") or os.getenv("ANTHROPIC_API_KEY")
    if not key:
        return []

    coa: list[dict] = []
    async for a in db.accounts.find(
        {"company_id": cid,
         "type": {"$in": ["expense", "cogs", "other_expense"]}},
        {"_id": 0, "id": 1, "name": 1, "code": 1, "subtype": 1},
    ).sort("code", 1):
        coa.append(a)
    if not coa:
        return []

    prompt = (
        "You are auditing a Chart of Accounts. Identify EVERY account "
        "whose role is a *bank fees equivalent* — bank/banking charges, "
        "wire transfer fees, ATM fees, overdraft fees, merchant / payment "
        "processing fees, service charges, etc. Be inclusive. If the CoA "
        "splits fees across multiple accounts (e.g., 'Wire Fees' + 'ATM Fees' "
        "+ 'Bank Fees'), return all of them. Interest EXPENSE is not a bank "
        "fee (return only if the account name literally reads as a fee).\n\n"
        "Return STRICT JSON only, no prose:\n"
        '{"account_ids": ["<id1>", "<id2>", ...]}\n\n'
        "Chart of Accounts:\n"
        + json.dumps([{"id": a["id"], "code": a.get("code"),
                       "name": a.get("name"), "subtype": a.get("subtype")}
                      for a in coa], separators=(",", ":"))
    )
    try:
        chat = (LlmChat(api_key=key, session_id=f"bank-fees-id-{cid}",
                        system_message="Return strict JSON.")
                .with_model("anthropic", "claude-haiku-4-5"))
        raw = await chat.send_message(UserMessage(text=prompt))
        s, e = raw.find("{"), raw.rfind("}")
        parsed = json.loads(raw[s:e + 1]) if s >= 0 and e > s else {}
        ids = [str(x) for x in (parsed.get("account_ids") or []) if x]
        # Only keep ids that actually exist in this company's CoA.
        valid = {a["id"] for a in coa}
        return [i for i in ids if i in valid]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Bank-fees LLM identify failed for %s: %s", cid, exc)
        return []


async def identify_bank_fees_accounts(
    cid: str, *, force_refresh: bool = False,
) -> list[str]:
    """Return the list of `account_id`s that play the Bank Fees role
    for this company. Cached on `companies.bank_fees_account_ids`;
    pass `force_refresh=True` to rebuild after CoA changes.
    """
    if not force_refresh:
        co = await db.companies.find_one(
            {"id": cid}, {"_id": 0, "bank_fees_account_ids": 1})
        if co and isinstance(co.get("bank_fees_account_ids"), list):
            return list(co["bank_fees_account_ids"])
    ids = await _llm_identify(cid)
    if not ids:
        ids = await _keyword_match_ids(cid)
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"bank_fees_account_ids": ids}},
    )
    return ids


def redirect_for_pfc(pfc_primary: str, pfc_detailed: str,
                    amount: float) -> tuple[str, str]:
    """Given a PFC and direction, decide the *semantic* redirect bucket
    and a human-readable reason. Returns ("keep", "") if PFC says this
    row legitimately belongs in Bank Fees.
    """
    fam = PFC_BUCKETS.get(pfc_primary, "unknown")
    if fam == "bank_fees":
        return ("keep", "")
    if fam == "loan_payments":
        return ("loan_payment",
                f"Plaid tagged this as {pfc_detailed or 'a loan payment'} — "
                "belongs on the liability, not an expense line.")
    if fam == "transfer_in":
        return ("transfer_in",
                f"Plaid tagged this as {pfc_detailed or 'an incoming transfer'} — "
                "money into the business, not a fee.")
    if fam == "transfer_out":
        return ("transfer_out",
                f"Plaid tagged this as {pfc_detailed or 'an outgoing transfer'} — "
                "a withdrawal/transfer, not a bank fee.")
    if fam == "income":
        return ("income",
                f"Plaid tagged this as {pfc_detailed or 'income'} — belongs "
                "on an income line.")
    if fam == "rent_or_utils":
        return ("rent_or_utils",
                f"Plaid tagged this as {pfc_detailed or 'rent/utilities'} — "
                "belongs on a rent or utility expense line.")
    return ("review",
            f"Plaid tagged this as {pfc_primary or 'uncategorized'}, "
            "which doesn't match Bank Fees — please review.")


async def guardrail_check(
    cid: str, txn: dict, proposed_account_id: str,
) -> dict[str, Any]:
    """Return `{allow: bool, bucket: str, reason: str}`.

    - allow=True, bucket=""             → not a bank-fees account OR PFC agrees.
    - allow=False, bucket="loan_payment" → redirect target bucket + reason.
    - allow=False, bucket="review"       → flag for CPA review (no PFC signal).
    """
    if not proposed_account_id:
        return {"allow": True, "bucket": "", "reason": ""}
    bank_fees_ids = await identify_bank_fees_accounts(cid)
    if proposed_account_id not in bank_fees_ids:
        return {"allow": True, "bucket": "", "reason": ""}
    primary = _pfc_primary(txn)
    detailed = _pfc_detailed(txn)
    if not primary:
        # No PFC signal to base a redirect on — allow but nudge.
        return {"allow": True, "bucket": "no_pfc",
                "reason": "No Plaid category available — verify this is a "
                          "genuine bank fee."}
    bucket, reason = redirect_for_pfc(
        primary, detailed, float(txn.get("amount") or 0))
    return {"allow": bucket == "keep",
            "bucket": bucket if bucket != "keep" else "",
            "reason": reason}
