"""Conversational interview engine for the batch client review page.

Haiku 4.5 drives the client-facing dialogue for each item in the batch.
Every turn returns EITHER a conversational message (ask a follow-up)
OR a structured action (record answer / defer / clarify with quick
replies / advance to next item).

Design choices
--------------
* **Structured JSON output**, not tool-calling. Simpler than
  registering tool schemas across a session that spans multiple
  item types.
* **Per-item message thread**, not one long thread across the whole
  batch. Prevents the LLM from cross-contaminating one item's context
  with another's, and keeps token cost bounded — we never re-send
  the full history of prior items.
* **Company + client context is packed into the system prompt** once
  per turn. That means the pro sees the same book with the same
  Chart of Accounts codes the AI does.
* **Every turn must be safe to abandon.** The client can close the
  tab at any point; state lives in `batch.messages` (per-item) and
  `batch.items[i].answer` when finalized.

Cost budget
-----------
Haiku 4.5 input + output at typical prompt sizes → ~$0.001–0.003 per
turn. A finished batch of 5 items with 2–3 turns each ≈ $0.02.
"""
from __future__ import annotations
import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger("axiom.client_review.engine")


# The JSON contract the model must return every turn.
_JSON_CONTRACT = """
You must respond with a JSON object in exactly this shape — no other text,
no markdown fences, no commentary:

{
  "reply":  "<what to say to the user in this turn>",
  "action": {
    "type":    "clarify" | "quick_replies" | "answer" | "defer" | "next",
    "payload": { ... type-specific ... }
  },
  "quick_replies": ["short chip 1", "short chip 2", ...]   // optional, max 4
}

Action types:
  * `clarify`       — ask a follow-up question. `payload` is {}.
  * `quick_replies` — present the user with tappable choices via
                       `quick_replies`. `payload.pending_answer` is {}.
  * `answer`        — the user has given a definitive answer. `payload`
                       carries the structured extraction:
                         { "answer_text": "<verbatim user answer>",
                           "account_id":  "<CoA account id or null>",
                           "account_name":"<friendly name>",
                           "flow":        "attached|provided_fields|follow_up"
                                          (item 4 W-9 only) }
  * `defer`         — the user chose "not sure — send to bookkeeper".
                       `payload.note` optional short note.
  * `next`          — done with this item, advance. `payload` is {}.

Rules:
  * Be warm and brief. Two sentences max per `reply`.
  * Never invent an `account_id`. Only use ids from the provided
    Chart of Accounts list. If nothing fits, set `account_id: null`.
  * If the user's answer is unambiguous, go straight to `answer` — do
    not clarify just because you can.
  * Suggest `quick_replies` when three or four plain-language options
    would be faster than typing (only useful for items with a
    short answer space, e.g. business vs personal).
""".strip()


def _system_prompt(*, item: dict, coa: list[dict], first_name: str,
                   firm_name: str | None, company_name: str) -> str:
    """Compose the per-turn system prompt. Item-specific instructions
    are appended based on `item_type`."""
    coa_lines = "\n".join(
        f"  - {a['id']} :: {a['name']} ({a.get('type', 'expense')})"
        for a in coa[:120]
    ) or "  (no accounts loaded — use account_id: null)"

    ctx = item.get("context") or {}
    context_block = json.dumps(ctx, default=str, indent=2)

    signoff = firm_name or "your bookkeeping team"

    per_type_hints = _per_type_hints(item.get("item_type"))

    return f"""\
You are an AI bookkeeper conducting a quick, friendly interview with
{first_name}, the owner of {company_name}. You represent {signoff}.

You are working through ONE question at a time. The client is answering
question {item.get("_position", "one")} in a short batch. When THIS
question is resolved, you emit `action.type = "answer"` and stop —
another turn of the batch will hand you the next question. Do NOT tell
the client "you're all done" or "everything's taken care of" — the
platform decides when the batch is over, not you.

Question type:  {_type_name(item.get("item_type"))}
Prompt:         {item.get("prompt", "")}
Context (JSON):
{context_block}

{per_type_hints}

Chart of Accounts available for categorization:
{coa_lines}

Closing rules — READ CAREFULLY:
  * If the client's reply is a QUESTION back to you (asks something,
    ends with "?", or is a request for guidance like "should I…",
    "can I…", "do I need to…", "what if…", "how do I…"), you MUST
    emit `action: {{"type": "clarify", "payload": {{}}}}`. Answer their
    question in `reply` and STOP. Do NOT emit `answer` on the same
    turn — the platform will wait for their next reply before moving
    on. Asking a clarifying question is NOT itself a resolution.
  * The moment the client's reply is a plausible SUBSTANTIVE answer
    to THIS question (a category, a yes/no confirmation to something
    you asked, a name, an amount, a "done"), emit
    `action: {{"type": "answer", "payload": {{...}}}}`. Do NOT ask
    another clarifying question just to be polite.
  * If they've already uploaded a file (the previous message starts
    with "Uploaded" or "📎"), the file IS the answer — emit `answer`
    with `flow: "attached"` immediately.
  * If they say "done", "all done", "that's it", "that's all", "yes"
    (in response to a yes/no confirmation), "correct", "confirmed", or
    similar — emit `answer` right away with their prior substantive
    reply as `answer_text`.
  * Your `reply` after emitting `answer` should be a SHORT
    confirmation like "Got it — categorizing as Office Supplies." or
    "Perfect, marking that as an internal transfer." No offers of
    further help — the app moves to the next question automatically.

{_JSON_CONTRACT}
"""


def _type_name(item_type: int | None) -> str:
    return {
        1: "Uncategorized transaction",
        2: "Vendor / memo confirmation",
        3: "Missing receipt",
        4: "W-9 collection",
        5: "Ambiguous transfer",
        6: "New recurring charge classification",
        7: "Setup detail",
        8: "Split-transaction clarification",
        9: "Liability payment split (mortgage / credit card / auto loan)",
    }.get(item_type or 0, "Unknown")


def _per_type_hints(item_type: int | None) -> str:
    if item_type == 1:
        return ("Match the answer to a Chart-of-Accounts entry. "
                "'Fuel' → Auto Expense/Fuel. 'Lunch with a client' → "
                "Meals & Entertainment. Never invent an account id.")
    if item_type == 4:
        return ("The client can (a) upload a W-9 PDF → `flow: attached`, "
                "(b) type the vendor's info inline → `flow: provided_fields`, "
                "or (c) ask us to reach out → `flow: follow_up`. Prefer "
                "quick_replies to offer the three paths first turn.")
    if item_type == 6:
        return ("Two-option question: business or personal. Offer both "
                "as quick_replies on the first turn.")
    if item_type == 8:
        return ("Ask how the amount breaks down. Structured answer: "
                "`payload.splits = [{account_id, amount, percent}]`.")
    if item_type == 9:
        return ("This is a LIABILITY payment (mortgage, credit card, or "
                "auto/business loan). Prefer uploading the statement — if "
                "the client uploads a photo or PDF, GPT-4o vision reads it "
                "and returns a Principal / Interest / Escrow / Fees split "
                "automatically. If they can't upload, ask which type of "
                "liability it is (mortgage / credit card / auto loan) and "
                "collect the amounts inline.")
    return ""


def _parse_model_reply(raw: str) -> dict:
    """Best-effort JSON extraction. Haiku is very consistent about the
    contract but the occasional stray markdown fence or preamble slips
    through — strip and try again.
    """
    txt = (raw or "").strip()
    # Strip ``` fences
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```\s*$", "", txt)
    # Find the first {...} block
    m = re.search(r"\{[\s\S]*\}", txt)
    if not m:
        return {"reply": raw or "", "action": {"type": "clarify", "payload": {}}}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"reply": raw or "", "action": {"type": "clarify", "payload": {}}}


async def run_turn(*, item: dict, batch: dict, user_message: str,
                   coa: list[dict], first_name: str,
                   firm_name: str | None, company_name: str,
                   history: list[dict]) -> dict:
    """Run one conversation turn. Returns:
        {"assistant_reply": str, "action": dict, "quick_replies": list,
         "raw": <model output>, "model": "claude-haiku-4-5-20251001"}

    `history` is the running per-item message list — passed by the
    caller so persistence is decoupled from the engine.
    """
    from llm_client import LlmChat, UserMessage
    api_key = os.environ.get("EMERGENT_LLM_KEY", "")
    if not api_key:
        logger.warning("EMERGENT_LLM_KEY missing — degraded engine reply")
        return {
            "assistant_reply": (
                "I need a moment to reach my AI. Can you type your answer "
                "or hit 'not sure — send to my bookkeeper'?"
            ),
            "action": {"type": "clarify", "payload": {}},
            "quick_replies": ["Send to my bookkeeper"],
            "raw": "",
            "model": "none",
        }

    chat = LlmChat(
        api_key=api_key,
        system_message=_system_prompt(
            item=item, coa=coa, first_name=first_name,
            firm_name=firm_name, company_name=company_name,
        ),
        feature="client_review_interview",
        company_id=batch["company_id"],
    ).with_model("anthropic", "claude-haiku-4-5-20251001")
    # Fold recent per-item history into the user message. The local
    # LlmChat shim in this project is stateless (single-turn), so we
    # linearize the arc into a `Prior conversation:` preamble instead
    # of relying on chat.history.
    convo = ""
    for msg in history[-12:]:  # cap for cost
        role = "You" if msg.get("role") == "assistant" else "Client"
        content = (msg.get("content") or "").strip()
        if content:
            convo += f"{role}: {content}\n"
    composed_user_msg = user_message
    if convo:
        composed_user_msg = (
            f"Prior conversation on this question:\n{convo}\n"
            f"Latest reply from the client:\n{user_message}"
        )

    try:
        raw = await chat.send_message(UserMessage(text=composed_user_msg))
    except Exception as e:  # noqa: BLE001 — always degrade gracefully
        logger.exception("client_review turn failed: %s", e)
        return {
            "assistant_reply": (
                "Something on my end hiccupped. Try again, or hit "
                "'not sure — send to my bookkeeper'."
            ),
            "action": {"type": "clarify", "payload": {}},
            "quick_replies": ["Send to my bookkeeper"],
            "raw": "",
            "model": "claude-haiku-4-5-20251001",
        }

    parsed = _parse_model_reply(raw)
    return {
        "assistant_reply": parsed.get("reply") or "",
        "action":          parsed.get("action") or {"type": "clarify", "payload": {}},
        "quick_replies":   parsed.get("quick_replies") or [],
        "raw":             raw,
        "model":           "claude-haiku-4-5-20251001",
    }


__all__ = ["run_turn", "analyze_receipt_for_split",
           "analyze_liability_statement_for_split",
           "analyze_receipt_for_categorization"]


# ---------------------------------------------------------------------------
# Receipt vision analysis for split-transaction items (item_type=8)
# ---------------------------------------------------------------------------
#
# The client uploads a Costco / Home Depot / Amazon receipt on a
# split-suggested question. We hand the image to gpt-4o (vision), it
# reads the line items, groups them into business vs personal, and
# proposes a percentage split back to the client. The client can then
# tap "Use this split" to finalize, or type a correction.

_SPLIT_VISION_SYSTEM_PROMPT = """\
You are a bookkeeper reading a store receipt. The client's business
was charged a single total but the receipt clearly mixes business
supplies with personal / household items.

Read the receipt image carefully. Then return ONLY a JSON object of
the shape:

{
  "vendor": "Costco Wholesale",           // merchant name printed on the receipt, best-effort
  "date": "2026-01-14",                    // transaction date in YYYY-MM-DD, best-effort
  "narrative": "1-2 sentence plain-English readout of what's on the receipt.",
  "line_items": [
    {"description": "…", "amount": 12.99, "kind": "business|personal|tax|shipping|unknown"}
  ],
  "suggested_splits": [
    {"account_name": "Office Supplies",       "amount": 720.00, "percent": 60},
    {"account_name": "Owner Personal Draws",  "amount": 480.00, "percent": 40}
  ],
  "totals": {"business": 720.00, "personal": 480.00, "grand_total": 1200.00}
}

Rules:
  * `kind=business` for tools, office supplies, materials, safety gear,
    software, professional books, cleaning supplies for a business space,
    coffee/snacks bought for an office kitchen, etc.
  * `kind=personal` for groceries, alcohol, kids' items, home decor,
    apparel, personal-care, personal electronics.
  * `kind=tax` / `kind=shipping` — allocate proportionally across the
    two split lines in `totals`.
  * `suggested_splits` MUST sum to the receipt grand total.
  * Use account names from the client's chart of accounts when
    provided; otherwise use reasonable QBO defaults ("Office Supplies",
    "Meals & Entertainment", "Owner Personal Draws" for out-of-scope).
  * No commentary outside the JSON. No markdown fences.
"""


async def analyze_receipt_for_split(
    *,
    attachment_data_url: str,
    coa: list[dict] | None = None,
    txn_amount: float | None = None,
    txn_desc: str | None = None,
    company_industry: str | None = None,
    company_name: str | None = None,
) -> dict | None:
    """Read a receipt with GPT-4o vision and propose a split. Returns
    None on failure — callers should fall back to the pre-baked
    suggestion in `item.context.meta.suggested_splits`.

    `company_industry` narrows the "business" bucket to the buyer's
    trade. A landscaper's fuel is business; a SaaS company's fuel
    is almost certainly personal reimbursement. Passed in as free-text
    (e.g. "Landscaping", "SaaS", "Restaurant", "General contractor").
    """
    if not attachment_data_url:
        return None
    api_key = os.environ.get("OPENAI_API_KEY") or ""
    if not api_key:
        return None

    coa_hint = ""
    if coa:
        top = [c for c in coa[:40] if c.get("type") in
               ("expense", "cost of goods sold", "cogs", "equity")]
        coa_hint = "\n".join(f"  - {c.get('name')} ({c.get('type')})" for c in top)
    industry_hint = ""
    if company_industry:
        industry_hint = (
            f"\n\nThe buyer is {company_name or 'a business'} — industry: "
            f"{company_industry}. Judge each line by that lens. What's a "
            f"business expense for a {company_industry} is different from "
            f"what's a business expense for a marketing agency. If a line "
            f"could plausibly be business given the industry, lean "
            f"business."
        )
    context_hint = (
        f"Transaction: {txn_desc or '(unknown)'} · "
        f"total ${abs(txn_amount or 0):.2f}."
        + industry_hint
        + (f"\n\nClient's chart of accounts (use these names when they fit):\n{coa_hint}"
           if coa_hint else "")
    )

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key)
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": _SPLIT_VISION_SYSTEM_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": context_hint},
                    {"type": "image_url",
                     "image_url": {"url": attachment_data_url, "detail": "high"}},
                ]},
            ],
            max_tokens=4096,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "").strip()
        finish = resp.choices[0].finish_reason
    except Exception:  # noqa: BLE001
        logger.exception("split receipt vision analysis failed")
        return None

    # If we hit the token cap the JSON is incomplete — retry once with
    # a shorter contract that just returns the totals and splits (no
    # per-line breakout) so we still surface *something* to the client.
    if finish == "length":
        try:
            resp2 = await client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content":
                        "Read the receipt. Return ONLY a JSON object of "
                        "this shape (no line_items — just the summary):\n"
                        "{\"narrative\": \"<1-2 sentences>\","
                        " \"suggested_splits\": [{\"account_name\":\"…\","
                        "\"amount\": <n>,\"percent\": <n>}, ...],"
                        " \"totals\":{\"business\":<n>,\"personal\":<n>,\"grand_total\":<n>}}"},
                    {"role": "user", "content": [
                        {"type": "text", "text": context_hint},
                        {"type": "image_url",
                         "image_url": {"url": attachment_data_url, "detail": "high"}},
                    ]},
                ],
                max_tokens=1200,
                response_format={"type": "json_object"},
            )
            raw = (resp2.choices[0].message.content or "").strip()
        except Exception:  # noqa: BLE001
            logger.exception("split receipt vision retry failed")

    # Extract JSON — model may still wrap in backticks despite the rule.
    import re as _re
    m = _re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(parsed, dict):
        return None
    # Log-usage best-effort so this call shows up in the AI usage table.
    try:
        from ai_usage import record_llm
        usage = getattr(resp, "usage", None)
        if usage:
            await record_llm(
                feature="split_receipt_vision", provider="openai", model="gpt-4o",
                input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
                company_id=None,
            )
    except Exception:  # noqa: BLE001
        pass
    return parsed



# ---------------------------------------------------------------------------
# Liability statement vision analysis for item_type=9
# ---------------------------------------------------------------------------
#
# The client uploads a mortgage / credit-card / auto-loan statement on a
# liability-payment question. We hand the image (or PDF page image) to
# gpt-4o (vision), it detects the statement type, and returns the
# canonical splits for whichever kind it is:
#
#   * mortgage      → principal, interest, escrow, fees
#   * credit_card   → principal (payment applied), interest, fees, other
#   * auto_loan     → principal, interest, fees
#   * generic_loan  → principal, interest, fees
#
# Each bucket carries a suggested GL account name so the pro-side book
# posts the payment into the correct rows (retiring loan principal on
# the balance sheet, hitting Interest Expense on the P&L, and dropping
# escrow into an escrow prepaid asset for mortgages).

_LIABILITY_VISION_SYSTEM_PROMPT = """\
You are a bookkeeper reading a liability-payment statement. The
client's business made ONE payment against a liability (a mortgage,
credit-card, or auto-loan bill) and needs the total broken into the
right accounting buckets so the ledger retires the correct portion of
the liability, expenses the interest, and (for mortgages) tracks
escrow separately.

Read the statement image carefully. First detect what KIND of
statement it is (mortgage / credit_card / auto_loan / generic_loan).
Then return ONLY a JSON object of the shape:

{
  "statement_type": "mortgage" | "credit_card" | "auto_loan" | "generic_loan",
  "lender_name":   "Wells Fargo Home Mortgage",
  "narrative":     "1-2 sentence plain-English readout.",
  "payment_amount": 2145.67,
  "buckets": [
    {"label": "Principal",  "amount": 812.45, "account_name": "Mortgage Payable"},
    {"label": "Interest",   "amount": 1104.22, "account_name": "Mortgage Interest Expense"},
    {"label": "Escrow",     "amount": 210.00,  "account_name": "Escrow (Prepaid)"},
    {"label": "Fees",       "amount": 19.00,   "account_name": "Bank Fees"}
  ],
  "totals": {"grand_total": 2145.67}
}

Rules by statement type:
  * **mortgage**: split into Principal, Interest, Escrow, Fees. Escrow
    covers property tax + homeowners insurance held in trust — always
    a separate bucket. Suggest accounts:
      - Principal → "Mortgage Payable" (long-term liability)
      - Interest  → "Mortgage Interest Expense"
      - Escrow    → "Escrow (Prepaid)" (asset)
      - Fees      → "Bank Fees" (expense)
  * **credit_card**: split into Principal (payment applied to balance),
    Interest, Fees. If the statement is a monthly statement, the
    "payment" typically retires principal only — interest & fees are
    already accrued into the balance and shouldn't double-hit. But if
    the client made a lump payment covering finance charges too,
    surface those explicitly. Suggest accounts:
      - Principal → "Credit Card Payable" (paydown)
      - Interest  → "Interest Expense"
      - Fees      → "Bank Fees"
  * **auto_loan / generic_loan**: split into Principal, Interest,
    Fees. Suggest accounts:
      - Principal → "Auto Loan Payable" (or "Notes Payable")
      - Interest  → "Interest Expense"
      - Fees      → "Bank Fees"

  * `buckets[].amount` MUST sum to `payment_amount`. If a bucket
    doesn't apply (e.g. no fees), OMIT it — do not emit zero-value
    buckets.
  * Use account names from the client's chart of accounts when
    provided; otherwise use the suggestions above.
  * If the statement type is ambiguous, default to `generic_loan`.
  * No commentary outside the JSON. No markdown fences.
"""


async def analyze_liability_statement_for_split(
    *,
    attachment_data_url: str,
    coa: list[dict] | None = None,
    txn_amount: float | None = None,
    txn_desc: str | None = None,
    company_industry: str | None = None,
    company_name: str | None = None,
) -> dict | None:
    """Read a mortgage / credit-card / auto-loan statement with GPT-4o
    vision and propose a liability-split (Principal / Interest / Escrow
    / Fees). Returns None on failure — callers should fall back to
    asking the client to type the split manually.
    """
    if not attachment_data_url:
        return None
    api_key = os.environ.get("OPENAI_API_KEY") or ""
    if not api_key:
        return None

    coa_hint = ""
    if coa:
        # Prefer expense + liability + asset accounts — these cover
        # interest expense, mortgage/loan payable, and escrow.
        keep = [c for c in coa[:80] if c.get("type") in
                ("expense", "liability", "asset", "long term liability",
                 "long-term liability", "other current liability")]
        coa_hint = "\n".join(f"  - {c.get('name')} ({c.get('type')})"
                             for c in keep[:40])
    industry_hint = ""
    if company_industry:
        industry_hint = (
            f"\n\nThe buyer is {company_name or 'a business'} — industry: "
            f"{company_industry}."
        )
    context_hint = (
        f"Payment transaction: {txn_desc or '(unknown)'} · "
        f"total ${abs(txn_amount or 0):.2f}."
        + industry_hint
        + (f"\n\nClient's chart of accounts (use these names when they fit):\n{coa_hint}"
           if coa_hint else "")
    )

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key)
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": _LIABILITY_VISION_SYSTEM_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": context_hint},
                    {"type": "image_url",
                     "image_url": {"url": attachment_data_url, "detail": "high"}},
                ]},
            ],
            max_tokens=2048,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "").strip()
    except Exception:  # noqa: BLE001
        logger.exception("liability statement vision analysis failed")
        return None

    import re as _re
    m = _re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(parsed, dict):
        return None

    # Normalise: enforce statement_type, non-empty buckets, and
    # totals that sum to payment_amount within a $0.02 tolerance.
    buckets = parsed.get("buckets") or []
    if not isinstance(buckets, list) or not buckets:
        return None
    clean_buckets = []
    for b in buckets:
        if not isinstance(b, dict):
            continue
        try:
            amt = round(float(b.get("amount") or 0), 2)
        except (TypeError, ValueError):
            continue
        if amt <= 0:
            continue
        clean_buckets.append({
            "label":        str(b.get("label") or "Unlabelled")[:32],
            "amount":       amt,
            "account_name": str(b.get("account_name") or "")[:64] or None,
        })
    if not clean_buckets:
        return None
    parsed["buckets"] = clean_buckets
    grand = round(sum(b["amount"] for b in clean_buckets), 2)
    parsed.setdefault("totals", {})["grand_total"] = grand
    if not parsed.get("payment_amount"):
        parsed["payment_amount"] = grand
    parsed.setdefault("statement_type", "generic_loan")

    try:
        from ai_usage import record_llm
        usage = getattr(resp, "usage", None)
        if usage:
            await record_llm(
                feature="liability_split_vision", provider="openai",
                model="gpt-4o",
                input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
                company_id=None,
            )
    except Exception:  # noqa: BLE001
        pass
    return parsed


# ---------------------------------------------------------------------------
# Receipt vision → per-item categorization (item_type=1 uncategorized txns)
# ---------------------------------------------------------------------------
#
# Reads a receipt image with GPT-4o vision and maps each line item to a
# single Chart-of-Accounts category. Unlike `analyze_receipt_for_split`
# (which groups business vs personal for MIXED-purpose receipts) this
# assumes the receipt is 100% business — the whole transaction is going
# on the books — and just proposes an account per line so the ledger
# gets the right granularity.
#
# Returned shape:
#   {
#     "narrative": "1-2 sentence readout.",
#     "line_items": [
#       {"description":"4x4x8 PT POST","amount":119.88,
#        "account_code":"5100","account_name":"Materials · Lumber"},
#       ...
#     ],
#     "suggested_categories": [
#       {"account_code":"5100","account_name":"Materials · Lumber",
#        "amount":187.64,"line_indices":[0,2]},
#       ...
#     ],
#     "totals": {"subtotal":449.15,"tax":34.14,"grand_total":483.29}
#   }

_RECEIPT_CATEGORIZATION_PROMPT = """\
You are a bookkeeper reading a business receipt for the client's
company. The client has already told us this expense is 100%
business — your only job is to map each line item to the correct
Chart-of-Accounts category so the ledger gets the right detail.

Read the receipt image carefully. Return ONLY a JSON object with
this shape:

{
  "narrative": "1-2 sentence plain-English readout ("Home Depot run — lumber, concrete, and a Milwaukee driver for job supplies. Sales tax billed separately.").",
  "line_items": [
    {"description": "4x4x8 PT POST",  "amount": 119.88, "account_code": "5100", "account_name": "Materials · Lumber",     "line_kind": "matched"},
    {"description": "QUIKRETE 80LB",  "amount":  69.80, "account_code": "5100", "account_name": "Materials · Concrete",   "line_kind": "matched"},
    {"description": "MILWAUKEE M18",  "amount":  99.00, "account_code": "5200", "account_name": "Small Tools & Equipment","line_kind": "matched"},
    {"description": "SALES TAX",      "amount":  34.14, "account_code": "6500", "account_name": "Taxes & Licenses",       "line_kind": "tax"}
  ],
  "totals": {"subtotal": 449.15, "tax": 34.14, "grand_total": 483.29}
}

RULES:
* Every line MUST include a `line_kind` — a closed enum that
  guarantees zero hallucination on the server side. Use exactly
  one of these values:
    - "tax"               (sales tax, use tax, permits, licenses)
    - "shipping"          (freight, postage, delivery)
    - "fuel"              (gas, diesel)
    - "vehicle"           (repairs on a vehicle, tires, oil change)
    - "repairs"           (equipment / building repairs)
    - "meals"             (business meals, dining)
    - "office_supplies"   (paper, pens, printer ink)
    - "software"          (SaaS, subscriptions)
    - "utilities"         (electricity, water, gas)
    - "telecom"           (internet, phone, cell)
    - "insurance"
    - "rent"
    - "professional_fees" (legal, accounting, consulting)
    - "bank_fees"         (bank charges, merchant fees)
    - "travel"            (flights, lodging, rideshare)
    - "advertising"       (marketing, ads)
    - "uncategorized_expense" (couldn't place — DO NOT invent)
    - "matched"           (specific industry account you're confident
                          about — e.g. Materials · Lumber for a
                          construction CoA, Food Cost for a
                          restaurant, Feed for agriculture)
* Use ONLY account_code + account_name pairs from the client's
  Chart of Accounts (provided below). If nothing fits, set
  `line_kind` to the closest canonical kind above and let the
  server resolve the actual account — NEVER invent an account_code
  or account_name that isn't in the client's CoA.
* Aggregate identical SKUs (same description + unit price) into
  ONE line item — the ext price is the sum. Skip zero-value lines.
* Sales tax: ALWAYS emit as its own line item with `"line_kind": "tax"`
  and map it to a dedicated tax expense account from the CoA.
  Prefer (in order): "Sales Tax Paid", "Sales Tax Expense",
  "Taxes & Licenses", "Taxes Paid", "State Sales Tax", "Use Tax",
  or the closest generic tax-flavored expense account. NEVER lump
  sales tax into the same category as the underlying goods —
  bookkeepers report sales tax paid separately for reconciliation.
  Shipping = its own line with `"line_kind": "shipping"`, mapped to
  "Shipping & Delivery" / "Freight" / "Postage" if available,
  otherwise to the same account as the underlying goods.
* `line_items[].amount` MUST sum to `totals.grand_total` within
  $0.02. If the receipt has an obvious grand total, that wins;
  if not, sum the item extendeds.
* No commentary outside the JSON. No markdown fences.
"""


async def analyze_receipt_for_categorization(
    *,
    attachment_data_url: str,
    coa: list[dict] | None = None,
    txn_amount: float | None = None,
    txn_desc: str | None = None,
    company_industry: str | None = None,
    company_name: str | None = None,
) -> dict | None:
    """Read a business receipt with GPT-4o vision and propose a Chart-
    of-Accounts category for each line item. Returns None on failure
    — callers should fall back to asking the client to type a summary.
    """
    if not attachment_data_url:
        return None
    api_key = os.environ.get("OPENAI_API_KEY") or ""
    if not api_key:
        return None

    coa_hint = ""
    if coa:
        # Prefer expense/COGS accounts — those are what a receipt
        # actually lands on. Cap at 60 accounts to keep the prompt
        # tight; landscaping/GC clients usually run 20-40 expense
        # rows total.
        expense = [c for c in coa if c.get("type") in
                   ("expense", "cogs", "cost of goods sold",
                    "other expense", "cost of sales")]
        if not expense:
            expense = list(coa)[:60]
        coa_hint = "\n".join(
            f"  - {c.get('code')} · {c.get('name')} ({c.get('type')})"
            for c in expense[:60]
        )
    industry_hint = ""
    if company_industry:
        industry_hint = (
            f"\n\nThe buyer is {company_name or 'a business'} — industry: "
            f"{company_industry}. Bias categorization toward accounts a "
            f"{company_industry} typically uses (materials, tools, "
            f"subs, fuel, meals, etc.)."
        )
    context_hint = (
        f"Transaction: {txn_desc or '(unknown)'} · total ${abs(txn_amount or 0):.2f}."
        + industry_hint
        + (f"\n\nClient's chart of accounts (use these EXACT codes + names):\n{coa_hint}"
           if coa_hint else "")
    )

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key)
        resp = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": _RECEIPT_CATEGORIZATION_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": context_hint},
                    {"type": "image_url",
                     "image_url": {"url": attachment_data_url, "detail": "high"}},
                ]},
            ],
            max_tokens=3000,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "").strip()
    except Exception:  # noqa: BLE001
        logger.exception("receipt categorization vision failed")
        return None

    import re as _re
    m = _re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(parsed, dict):
        return None

    items = parsed.get("line_items") or []
    if not isinstance(items, list) or not items:
        return None
    clean: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            amt = round(float(it.get("amount") or 0), 2)
        except (TypeError, ValueError):
            continue
        if amt <= 0:
            continue
        clean.append({
            "description":  str(it.get("description") or "")[:80] or "Item",
            "amount":       amt,
            "account_code": str(it.get("account_code") or "")[:12] or None,
            "account_name": str(it.get("account_name") or "")[:64] or None,
            "kind":         (it.get("kind") or "item").lower()[:16],
        })
    if not clean:
        return None
    parsed["line_items"] = clean

    # Roll up per-account subtotals for the pretty grouped UI.
    buckets: dict[str, dict] = {}
    for idx, it in enumerate(clean):
        key = f"{it.get('account_code') or ''}|{it.get('account_name') or ''}"
        b = buckets.setdefault(key, {
            "account_code": it.get("account_code"),
            "account_name": it.get("account_name") or "Uncategorized",
            "amount":       0.0,
            "line_indices": [],
        })
        b["amount"] = round(b["amount"] + it["amount"], 2)
        b["line_indices"].append(idx)
    parsed["suggested_categories"] = sorted(
        buckets.values(), key=lambda b: -b["amount"],
    )

    totals = parsed.get("totals") or {}
    if not isinstance(totals, dict):
        totals = {}
    grand = round(sum(it["amount"] for it in clean), 2)
    totals.setdefault("grand_total", grand)
    parsed["totals"] = totals

    try:
        from ai_usage import record_llm
        usage = getattr(resp, "usage", None)
        if usage:
            await record_llm(
                feature="receipt_categorization_vision", provider="openai",
                model="gpt-4o",
                input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
                company_id=None,
            )
    except Exception:  # noqa: BLE001
        pass
    return parsed

