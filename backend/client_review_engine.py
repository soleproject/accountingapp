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
  * The moment the client's reply is a plausible answer to THIS
    question, emit `action: {{"type": "answer", "payload": {{...}}}}`.
    Do NOT ask another clarifying question just to be polite.
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
        9: "Liability payment split",
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
        return ("Prefer document upload over asking for numbers. If the "
                "client can upload the statement, `flow: attached`.")
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


__all__ = ["run_turn", "analyze_receipt_for_split"]


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
) -> dict | None:
    """Read a receipt with GPT-4o vision and propose a split. Returns
    None on failure — callers should fall back to the pre-baked
    suggestion in `item.context.meta.suggested_splits`.
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
    context_hint = (
        f"Transaction: {txn_desc or '(unknown)'} · "
        f"total ${abs(txn_amount or 0):.2f}."
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
