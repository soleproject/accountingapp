"""Review Chat Co-Pilot — LLM classifier for the /accounting/review-chat
page. Takes a free-text CPA message + current card snapshot and returns
either a playbook match (deterministic beats will play in the UI) or a
plain conversational reply.

Design: pure classification + slot extraction. Never runs the fix
itself — the frontend tour engine does. Keeps LLM latency and cost
tiny (a few hundred output tokens max) and eliminates hallucination
risk on the UI actions.
"""
import json
import os
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from llm_client import LlmChat, UserMessage

router = APIRouter(prefix="/api")


# Kept in sync manually with
# /app/frontend/src/tours/reviewChatPlaybooks/index.js — PLAYBOOK_MANIFEST.
# When a playbook is added there, mirror the description here so the
# classifier knows it exists. (Phase 4 can auto-generate this from the
# JS module via a build step.)
PLAYBOOK_MANIFEST = [
    {
        "key": "wrong-single-contact",
        "match": "Every row on this card belongs to a DIFFERENT single contact than what I picked (e.g. 'this is really Bob, not Wells Fargo').",
        "slots": {"targetContact": "name of the correct contact (optional)"},
    },
    {
        "key": "wrong-mixed-contacts",
        "match": "Rows on this card belong to MULTIPLE different contacts (e.g. 'these aren't all Wells Fargo — some are Bob and some are Alice'). Requires sampleCount >= 5.",
        "slots": {},
    },
    {
        "key": "one-transaction-odd",
        "match": "One (or a few) specific rows are different from the rest (e.g. 'all of these are meals except the $500 one — that's rent').",
        "slots": {"targetDescription": "hint at which row(s) are odd (optional)"},
    },
    {
        "key": "sub-split-one-row",
        "match": "ONE transaction needs to be split across multiple accounts (e.g. '$500 Amazon = $450 office supplies + $50 sales tax').",
        "slots": {"targetDescription": "hint at which row to split"},
    },
    {
        "key": "explain-why",
        "match": "The CPA is asking a conversational question that doesn't need a UI action — 'why did you categorize this X?', general help, category comparisons, etc.",
        "slots": {},
    },
]


def _system_prompt(playbooks: list[dict]) -> str:
    """Compose the classifier's system message. Keep it tight —
    we want cheap, deterministic JSON output, not creative prose."""
    manifest = json.dumps(playbooks, indent=2)
    return f"""You are the CPA's bookkeeping co-pilot on the Review Chat page. Your job is to translate a CPA's free-text message about a review card into ONE playbook the frontend will execute, or into a plain conversational reply if none fits.

CRITICAL RULES:
1. Output MUST be valid JSON matching this schema exactly:
   {{
     "intent": "<playbook key from the list below>",
     "slots": {{ ... }},  // fill any slots the playbook accepts, or {{}} if none
     "reply": "<one or two friendly sentences, first-person, warm bookkeeper tone>"
   }}
2. The "intent" MUST be one of the playbook keys below. If nothing fits, use "explain-why" — that lets you reply conversationally.
3. Never invent playbook keys. Never invent UI button names.
4. Do NOT recommend actions in the "reply" field — the playbook beats already narrate the steps. Keep the reply to a warm acknowledgement + one-sentence framing of what's about to happen.
5. Slot values must be short strings extracted from the user's utterance. If a slot isn't clearly stated, omit the key.
6. Tone: friendly bookkeeper. First person ("I'll open…", "Let me walk you through…"). No accounting jargon unless the CPA used it first.

AVAILABLE PLAYBOOKS:
{manifest}

Return JSON ONLY. No prose before or after the JSON."""


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """Best-effort JSON extractor — the LLM sometimes wraps in prose
    despite instructions. Handles fenced ```json blocks and raw {…}."""
    if not text:
        return None
    # Fenced block first.
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    # First balanced {...} in the string.
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    start = None
    return None


class CardSnapshot(BaseModel):
    card_key: Optional[str] = None
    prompt: Optional[str] = None
    contact_name: Optional[str] = None
    direction: Optional[str] = None
    sample_count: Optional[int] = 0
    total_dollars: Optional[float] = 0.0


class ClassifyRequest(BaseModel):
    message: str
    card: Optional[CardSnapshot] = None


class ClassifyResponse(BaseModel):
    intent: str
    slots: Dict[str, Any] = {}
    reply: str


VALID_KEYS = {p["key"] for p in PLAYBOOK_MANIFEST}


@router.post("/companies/{company_id}/review-copilot/classify", response_model=ClassifyResponse)
async def classify(company_id: str, req: ClassifyRequest) -> ClassifyResponse:
    user_msg = (req.message or "").strip()
    if not user_msg:
        raise HTTPException(status_code=400, detail="message is required")

    card = req.card
    card_ctx = ""
    if card:
        card_ctx = (
            f"CURRENT CARD:\n"
            f"- Prompt: {card.prompt or '(none)'}\n"
            f"- Contact: {card.contact_name or '(none)'}\n"
            f"- Direction: {card.direction or '(unknown)'}\n"
            f"- Sample count: {card.sample_count}\n"
            f"- Total dollars: ${card.total_dollars:.2f}\n\n"
        )

    api_key = os.environ.get("EMERGENT_LLM_KEY", "")
    chat = LlmChat(
        api_key=api_key,
        system_message=_system_prompt(PLAYBOOK_MANIFEST),
        feature="review-copilot-classify",
        company_id=company_id,
    ).with_model("anthropic", "claude-haiku-4-5-20251001")

    composed = f"{card_ctx}CPA SAID: {user_msg}\n\nReturn JSON."
    try:
        raw = await chat.send_message(UserMessage(text=composed))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e

    parsed = _extract_json(raw or "")
    if not parsed or "intent" not in parsed:
        # Safe fallback — plain chat reply so the UX never dead-ends on
        # a malformed model response.
        return ClassifyResponse(
            intent="explain-why",
            slots={},
            reply=(raw or "").strip() or "I'm not sure how to help with that — could you rephrase?",
        )

    intent = str(parsed.get("intent", "")).strip()
    if intent not in VALID_KEYS:
        # Model hallucinated a playbook — downgrade to conversational.
        return ClassifyResponse(
            intent="explain-why",
            slots={},
            reply=str(parsed.get("reply", "") or "").strip() or "Let me think about that one — could you give me a bit more detail?",
        )

    slots = parsed.get("slots") or {}
    if not isinstance(slots, dict):
        slots = {}
    reply = str(parsed.get("reply", "") or "").strip()
    if not reply:
        reply = "On it — watch the cursor."
    return ClassifyResponse(intent=intent, slots=slots, reply=reply)
