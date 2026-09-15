"""Review v2 backend — endpoints that power `/accounting/lab/review-v2`.

Two POST/GET routes:

  • GET  /companies/{cid}/reviewv2/account-pairs
        Pulls confirmed transfer pairs directly from the ledger so
        stage 1 doesn't depend on the batch surfacing type-5
        (Ambiguous Transfer) items. A transfer pair is any set of
        matched transactions where txn_type == "Transfer" and both
        `bank_account_id` and `transfer_pair_id` (or similar) tie
        two accounts together. Groups by (from_account, to_account),
        returns dollar totals + samples.

  • POST /companies/{cid}/reviewv2/ai-propose
        Given transaction context + a free-text user answer,
        proposes a booking using the company's entity/tax setup.
        For pass-through entities (Sole Prop, LLC-Partnership,
        LLC-Solo-Proprietor) the mapping enforces "business income
        tax on owner → Owner Draw + flag for accountant"; for
        C-Corp / S-Corp it stays "Income Tax Expense". Also detects
        when the typed answer conflicts with the bank description
        (e.g. "office rent" typed on a transaction descriptioned
        "AMAZON MKTPL").
"""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Body
from collections import defaultdict

from db import db
from auth import get_current_user
from deps import require_company
from ai_service import _new_chat
from llm_client import UserMessage, TextDelta, StreamDone
import json, re

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------- stage 1

@router.get("/companies/{cid}/reviewv2/account-pairs")
async def list_transfer_pairs(cid: str, user: dict = Depends(get_current_user)):
    """Group confirmed transfer transactions by (from_account, to_account).

    Only surfaces pairs with ≥1 matched transfer so the client is asked
    "are these both yours?" once per pair. The response drives Stage 1
    of the v2 review flow.
    """
    await require_company(user, cid)

    # Load account name lookup once.
    accts = {a["id"]: a async for a in db.accounts.find({"company_id": cid},
             {"id": 1, "name": 1, "code": 1, "type": 1, "bank_last4": 1})}

    # Group by transfer_pair_id (canonical field emitted by the transfer
    # matcher). Each pair produces two ledger rows — one debit, one
    # credit — that carry the same pair id.
    pair_map: dict[str, dict] = {}
    async for t in db.transactions.find({
        "company_id": cid,
        "txn_type": "Transfer",
        "transfer_pair_id": {"$exists": True, "$nin": [None, ""]},
    }, {
        "id": 1, "date": 1, "amount": 1, "transfer_pair_id": 1,
        "bank_account_id": 1, "category_account_id": 1,
    }):
        pid = t["transfer_pair_id"]
        p = pair_map.setdefault(pid, {"legs": []})
        p["legs"].append(t)

    # Roll pair rows up to (from, to) account groupings.
    groups: dict[tuple, dict] = {}
    for pid, p in pair_map.items():
        legs = p["legs"]
        if len(legs) < 2:
            continue
        # Debit side = destination (money in), credit side = source.
        src = next((l for l in legs if (l.get("amount") or 0) < 0), legs[0])
        dst = next((l for l in legs if (l.get("amount") or 0) > 0), legs[-1])
        src_id = src.get("bank_account_id") or src.get("category_account_id")
        dst_id = dst.get("bank_account_id") or dst.get("category_account_id")
        if not src_id or not dst_id:
            continue
        key = (src_id, dst_id)
        g = groups.setdefault(key, {
            "src_id": src_id, "dst_id": dst_id,
            "count": 0, "total_dollars": 0.0,
            "samples": [],
        })
        g["count"] += 1
        amt = abs(float(src.get("amount") or 0))
        g["total_dollars"] += amt
        if len(g["samples"]) < 3:
            g["samples"].append({"date": src.get("date"), "amount": amt})

    def _label(a: dict | None) -> str:
        if not a:
            return "—"
        last4 = a.get("bank_last4") or ""
        base = a.get("name") or a.get("code") or "account"
        return f"{base} ···{last4}" if last4 else base

    pairs = []
    for (src_id, dst_id), g in groups.items():
        src_acct = accts.get(src_id)
        dst_acct = accts.get(dst_id)
        pairs.append({
            "pair_id":       f"{src_id}::{dst_id}",
            "from":          _label(src_acct),
            "to":            _label(dst_acct),
            "from_id":       src_id,
            "to_id":         dst_id,
            "transfer_count": g["count"],
            "total_dollars": round(g["total_dollars"], 2),
            "samples":       g["samples"],
        })
    pairs.sort(key=lambda p: p["total_dollars"], reverse=True)
    return {"pairs": pairs}


# ---------------------------------------------------------------- ai propose

PASS_THROUGH_ENTITIES = {
    "Sole Proprietor",
    "LLC – Solo Proprietor",
    "LLC – Partnership",
    "Limited Partnership",
    'LLC – "S" Elected',
    '"S" Corporation',
}


def _entity_hint(business_type: str | None) -> str:
    """Compose an entity-aware bookkeeping rules block for the LLM."""
    bt = (business_type or "").strip()
    if bt in PASS_THROUGH_ENTITIES:
        return (
            f"The business is a PASS-THROUGH entity ({bt or 'unknown pass-through'}).\n"
            "  • Business income tax paid on the owner's personal Form 1040 (or K-1) "
            "is NOT a business expense — book to 3200 Owner's Draw and FLAG for CPA.\n"
            "  • Owner health insurance premiums paid personally → Owner's Draw.\n"
            "  • Owner salary via Zelle/Venmo → Owner's Draw (never Payroll).\n"
            "  • Personal charges on business cards → Owner's Draw.\n"
            "  • Loans between owner and business → separate `Due to/from Owner` account."
        )
    return (
        f"The business is a TAXABLE ENTITY ({bt or 'C-Corp assumed'}).\n"
        "  • Federal / state corporate income tax → 6900 Income Tax Expense.\n"
        "  • Owner salary → Payroll (not Draw). Confirm W-2 is being issued.\n"
        "  • Dividends / distributions to shareholders → Retained Earnings, flag CPA."
    )


_PROPOSE_SYSTEM = (
    "You are the SmartBooks bookkeeping assistant helping a business owner "
    "categorize a single transaction. You must:\n"
    "1. Read the transaction's bank description and the owner's plain-language answer.\n"
    "2. Propose a single ledger account (name + code from the provided CoA).\n"
    "3. Apply the company's entity/tax rules (below) before choosing the account.\n"
    "4. Compare the owner's answer to the bank description. If they conflict "
    "(e.g. owner says 'office rent' but description says 'AMAZON MKTPL'), "
    "flag `conflict=true` and explain briefly.\n"
    "5. If the transaction requires accountant judgment (loans, tax payments on a "
    "pass-through, owner reimbursements, ambiguous splits), set `flag_for_cpa=true`.\n"
    "6. NEVER book anything yourself. Your output is a proposal only.\n\n"
    "Reply ONLY with strict JSON, no prose:\n"
    "{\n"
    '  "account_code":    "6100",\n'
    '  "account_name":    "Travel",\n'
    '  "reason":          "Owner said this was a client trip; bank shows an airline.",\n'
    '  "confidence":      0.86,\n'
    '  "conflict":        false,\n'
    '  "flag_for_cpa":    false,\n'
    '  "direction_note":  "money_out"\n'
    "}"
)


@router.post("/companies/{cid}/reviewv2/ai-propose")
async def ai_propose(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Given `{context, user_answer}` return an AI proposal (JSON).

    Never touches the ledger — the client always shows Confirm / Change
    before booking. The Confirm write goes through the existing
    /client-review answer handlers so ledger writes flow through the
    normalizer + audit trail.
    """
    await require_company(user, cid)
    ctx = payload.get("context") or {}
    user_answer = (payload.get("user_answer") or "").strip()
    if not user_answer:
        raise HTTPException(400, "user_answer is required")

    company = await db.companies.find_one({"id": cid}) or {}
    business_type = company.get("business_type") or ""

    # Load the company's Chart of Accounts (top 120 rows — same cap as
    # ai_service.categorize_transaction).
    coa = []
    async for a in db.accounts.find({"company_id": cid, "active": True},
            {"code": 1, "name": 1, "type": 1}).limit(120):
        coa.append(a)

    coa_lines = "\n".join(
        f"- {a.get('code','')} {a.get('name','')} ({a.get('type','')})"
        for a in coa if a.get("code") and a.get("name")
    )

    amount = float(ctx.get("amount") or 0)
    direction = "money_in" if amount > 0 else "money_out"

    prompt = (
        f"Entity rules:\n{_entity_hint(business_type)}\n\n"
        f"Chart of accounts:\n{coa_lines}\n\n"
        f"Transaction:\n"
        f"  Date:        {ctx.get('date') or '—'}\n"
        f"  Description: {ctx.get('description') or ctx.get('merchant') or '—'}\n"
        f"  Merchant:    {ctx.get('merchant') or '—'}\n"
        f"  Amount:      {amount} ({direction})\n"
        f"  Account:     {ctx.get('account') or '—'}\n\n"
        f"Owner's plain-language answer:\n  \"{user_answer}\"\n\n"
        "Return the JSON now."
    )

    chat = _new_chat(_PROPOSE_SYSTEM, f"rv2-{cid}", feature="reviewv2-propose", company_id=cid)
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        raise HTTPException(500, f"AI proposal failed: {e}")

    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {
            "ok": False,
            "raw": text,
            "reason": "The AI didn't return a parseable JSON proposal — try again or use 'Ask my accountant'.",
        }
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        return {"ok": False, "raw": text, "reason": "AI response was not valid JSON."}

    parsed.setdefault("direction_note", direction)
    parsed["ok"] = True
    parsed["business_type"] = business_type
    return parsed
