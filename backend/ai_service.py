"""AI service: categorization + chat via Claude Sonnet 4.5 (emergentintegrations)."""
from __future__ import annotations
import os
import json
import re
from typing import AsyncGenerator, Optional
from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone

EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]
MODEL_PROVIDER = "anthropic"
MODEL_NAME = "claude-sonnet-4-5-20250929"

CATEGORIZATION_SYSTEM = (
    "You are an enterprise-grade AI accountant applying US GAAP. "
    "Given a bank transaction, choose the SINGLE best account from the provided Chart of Accounts. "
    "Return ONLY a compact JSON object with keys: account_code (string), confidence (0.0-1.0 float), "
    "reasoning (short string, one sentence). Never include any text outside the JSON. "
    "Confidence > 0.85 for clearly recognizable merchants and matches. "
    "Confidence 0.60-0.85 for likely but ambiguous. "
    "Confidence < 0.60 for uncertain — these will be flagged for human review."
)

ASSISTANT_SYSTEM = (
    "You are Axiom, an AI accounting assistant embedded in an enterprise SaaS accounting product. "
    "You help accounting pros and business owners understand their books. "
    "You are concise, precise, and reference GAAP where relevant. "
    "When the user's message includes a 'Context' block with a focused transaction, ground your reply in that transaction. "
    "Format numbers as US currency. Avoid emoji. Keep replies under 6 sentences unless deep analysis is requested."
)


def _new_chat(system: str, session_id: str) -> LlmChat:
    return LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=session_id,
        system_message=system,
    ).with_model(MODEL_PROVIDER, MODEL_NAME)


def _extract_json(text: str) -> dict | None:
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


async def categorize_transaction(merchant: str, amount: float, description: str, coa: list[dict]) -> dict:
    """Return {account_code, confidence, reasoning}."""
    coa_lines = "\n".join(f"- {a['code']} {a['name']} ({a['type']})" for a in coa)
    prompt = (
        f"Chart of Accounts:\n{coa_lines}\n\n"
        f"Transaction:\n"
        f"  Merchant: {merchant}\n"
        f"  Description: {description}\n"
        f"  Amount: {amount} (negative = money out, positive = money in)\n\n"
        f"Return the JSON now."
    )
    chat = _new_chat(CATEGORIZATION_SYSTEM, f"cat-{merchant}")
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        return {"account_code": "9999", "confidence": 0.3, "reasoning": f"AI unavailable: {e}"}
    data = _extract_json(text) or {}
    code = str(data.get("account_code", "9999"))
    try:
        conf = float(data.get("confidence", 0.5))
    except Exception:
        conf = 0.5
    reasoning = str(data.get("reasoning", "No reasoning provided."))[:400]
    return {"account_code": code, "confidence": max(0.0, min(1.0, conf)), "reasoning": reasoning}


async def chat_stream(
    session_id: str, user_text: str, context: Optional[dict] = None
) -> AsyncGenerator[str, None]:
    prompt = user_text
    if context:
        prompt = f"Context (focused transaction):\n{json.dumps(context, indent=2)}\n\nUser: {user_text}"
    chat = _new_chat(ASSISTANT_SYSTEM, session_id)
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                yield ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        yield f"[AI error: {e}]"


async def suggest_chart_of_accounts(business_type: str, description: str) -> list[dict]:
    """Ask AI to suggest additional industry-specific accounts on top of defaults."""
    prompt = (
        f"For a US small business of type: {business_type}\n"
        f"Description: {description}\n\n"
        "Suggest 4-8 ADDITIONAL industry-specific GAAP accounts (beyond a standard baseline) "
        "as a JSON array. Each item: {\"code\": \"6xxx or 4xxx\", \"name\": \"Account Name\", "
        "\"type\": \"asset|liability|equity|revenue|expense\", \"subtype\": \"operating_expense|...\"}. "
        "Return ONLY the JSON array."
    )
    chat = _new_chat(
        "You are a CPA designing a GAAP chart of accounts. Return ONLY valid JSON array.",
        f"coa-{business_type}",
    )
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception:
        return []
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
        return [x for x in arr if isinstance(x, dict) and "code" in x and "name" in x]
    except Exception:
        return []
