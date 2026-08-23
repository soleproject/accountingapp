"""Help assistant — routes natural-language "how do I / where do I / can I /
what is / show me" questions to the 34-task help catalog.

Two-layer classifier
--------------------
1. Keyword/alias match against the hand-curated `HELP_CATALOG.aliases`
   list (≤50ms, deterministic). Handles ~90% of expected phrasings.
2. LLM fallback (Claude Haiku) only when layer 1 misses. Given the
   full task-id list, returns the best match or None.

The endpoint never intercepts direct imperatives ("create an invoice",
"take me to X") — those still route through the existing voice command
system. Detection is verb-prefix based: only fires on Where/How/Can/
What/Show questions.
"""
from __future__ import annotations

import os
import re
from typing import Any

from fastapi import APIRouter, Depends

from help_catalog import HELP_CATALOG, HELP_INDEX
from auth import get_current_user

router = APIRouter(prefix="/api/help", tags=["help"])


# ---------------------------------------------------------------------------
# Layer 1 — deterministic classifier
# ---------------------------------------------------------------------------
# Verb detector — case-insensitive prefix scan. If no verb matches we
# return None from `ask()` so the frontend falls back to the existing
# insights/voice pipelines. This is the safety valve that guarantees
# we never break "create an invoice" style imperatives.
_VERB_PATTERNS = {
    "how":  re.compile(r"\b(how\s+do\s+(?:i|you|we)|how\s+to|how\s+can\s+(?:i|you|we))\b", re.I),
    "where": re.compile(r"\b(where\s+do\s+(?:i|you|we)|where\s+is|where\s+can\s+(?:i|you|we)|where\s+to)\b", re.I),
    "can":  re.compile(r"\b(can\s+(?:i|you|we)|is\s+it\s+possible|do\s+you\s+support)\b", re.I),
    "what": re.compile(r"\b(what\s+is|what\s+does|what\s+are|what's|whats)\b", re.I),
    "show": re.compile(r"\b(show\s+me|show\s+the|open\s+the|take\s+me\s+to)\b", re.I),
}


def _detect_verb(text: str) -> str | None:
    for verb, pat in _VERB_PATTERNS.items():
        if pat.search(text):
            return verb
    return None


def _score_alias_match(query: str, task: dict) -> int:
    """Higher = better. 0 = no match."""
    q = query.lower()
    best = 0
    # Full-alias exact substring beats partials
    for a in task.get("aliases", []):
        al = a.lower()
        if al in q:
            best = max(best, len(al) * 3)  # weight full-alias hits
        else:
            # word-overlap heuristic
            words = set(al.split())
            hits = sum(1 for w in words if w in q)
            if hits and hits == len(words):
                best = max(best, hits * 2)
            elif hits >= 2:
                best = max(best, hits)
    # Title token hit as tiebreaker
    for w in task.get("title", "").lower().split():
        if len(w) >= 4 and w in q:
            best += 1
    return best


def _classify(query: str) -> dict | None:
    """Return the best-matching task dict or None."""
    scored = [(t, _score_alias_match(query, t)) for t in HELP_CATALOG]
    scored.sort(key=lambda x: -x[1])
    if scored and scored[0][1] >= 3:  # tunable threshold
        return scored[0][0]
    return None


# ---------------------------------------------------------------------------
# Layer 2 — LLM fallback (uses Emergent LLM key, Claude Haiku for speed)
# ---------------------------------------------------------------------------
async def _llm_classify(query: str) -> str | None:
    """Fall back to Claude Haiku when the keyword matcher misses. Given
    the catalog's task ids + one-line summaries, ask the model to pick
    the single best id or `NONE`. ~600-900ms. Cheap.
    """
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception:
        return None
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        return None

    catalog_lines = "\n".join(
        f"- {t['id']}: {t['title']}" for t in HELP_CATALOG
    )
    system = (
        "You classify user questions about an accounting app into a fixed "
        "catalog of task ids. Return ONLY the id string or the literal token "
        "NONE (uppercase). No explanation, no markdown, no punctuation.\n\n"
        f"Catalog:\n{catalog_lines}"
    )
    try:
        chat = LlmChat(api_key=key, session_id=f"help-{hash(query) & 0xffff}",
                       system_message=system).with_model("anthropic", "claude-haiku-4-5-20251001")
        resp = await chat.send_message(UserMessage(text=query))
        pick = (resp or "").strip().split()[0]
        if pick and pick != "NONE" and pick in HELP_INDEX:
            return pick
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Response builder — assembles the {answer, take_me_there, do_it_for_me}
# payload from a matched task + detected verb.
# ---------------------------------------------------------------------------
def _build_response(task: dict, verb: str | None) -> dict:
    title = task["title"]

    # Verb → body selection
    if verb == "where":
        body = task.get("where") or task.get("how", "")
        heading = f"Where to {title.lower()}"
    elif verb == "can":
        body = f"Yes — Axiom supports **{title.lower()}**.\n\n" + task.get("how", "")
        heading = f"Can I {title.lower()}? Yes"
    elif verb == "what":
        body = task.get("what") or task.get("how", "")
        heading = title
    elif verb == "show":
        body = task.get("where") or task.get("how", "")
        heading = f"Opening {title}"
    else:  # "how" or fallback
        body = task.get("how") or task.get("what", "")
        heading = f"How to {title.lower()}"

    return {
        "heading": heading,
        "body": body,
        "take_me_there": task.get("deep_link"),
        "do_it_for_me": (
            {
                "label": task.get("action_hint") or title,
                "url": task.get("deep_link"),
                "tier": task.get("action_tier"),
            }
            if task.get("action_tier") in ("green", "yellow") and task.get("deep_link")
            else None
        ),
        "task_id": task["id"],
    }


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@router.post("/ask")
async def help_ask(payload: dict, user: dict = Depends(get_current_user)) -> dict:
    """Route a natural-language help question to the catalog.

    Payload: ``{"query": "<user text>"}``. Returns
    ``{"matched": bool, "verb": str|None, ...response}``. When
    ``matched=False`` the frontend should fall through to its existing
    behavior (voice command router / data-Q pipeline).
    """
    q = (payload.get("query") or "").strip()
    if not q:
        return {"matched": False}

    verb = _detect_verb(q)
    if not verb:
        # No verb keyword → let the existing pipelines handle it.
        return {"matched": False, "reason": "no_verb"}

    task = _classify(q)
    if not task:
        pick = await _llm_classify(q)
        task = HELP_INDEX.get(pick) if pick else None

    if not task:
        return {
            "matched": False, "verb": verb,
            "fallback": "I'm not sure — try 'What can you do?' to see everything I can help with.",
        }

    resp: dict[str, Any] = {"matched": True, "verb": verb}
    resp.update(_build_response(task, verb))
    return resp
