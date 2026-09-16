"""Step 5 LLM fallback — normalize noisy descriptions to a merchant name.

Only invoked for rows that remain unresolved after every deterministic
step. Result is cached per normalized description hash so subsequent
runs and other companies with the same descriptor pay $0.

Model: Claude Haiku 4.5 (cheap, fast). Prompt asks the model to pick
from a shortlist of existing live contact names first; only mints a
new name when no candidate fits.
"""
from __future__ import annotations
import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db
from llm_client import LlmChat, UserMessage
from contact_resolver import normalize_contact_name, normalize_descriptor

from .collections import LAB_LLM_CACHE, LAB_TRANSACTIONS, LAB_CONTACTS

log = logging.getLogger("axiom.lab.llm")

# Anthropic model per spec #8.
_LLM_PROVIDER = "anthropic"
_LLM_MODEL    = "claude-haiku-4-5-20251001"


_AMT_TAIL_RX = re.compile(r"\s+\$?\d[\d,]*\.?\d{0,2}\s*$")


def _llm_cache_key(description: str) -> str:
    """SHA-1 of the normalized description with amounts also stripped.
    We strip trailing amounts on top of ``normalize_descriptor`` so the
    same merchant with different totals hits the same cache row."""
    d = _AMT_TAIL_RX.sub("", (description or "").strip())
    d = normalize_descriptor(d)
    return hashlib.sha1(d.encode("utf-8")).hexdigest()


async def _get_cached(cache_key: str) -> Optional[dict]:
    return await db[LAB_LLM_CACHE].find_one({"cache_key": cache_key}, {"_id": 0})


async def _put_cached(doc: dict) -> None:
    await db[LAB_LLM_CACHE].update_one(
        {"cache_key": doc["cache_key"]}, {"$set": doc}, upsert=True,
    )


def _make_shortlist(live_contacts: list[dict], hint: str,
                     limit: int = 40) -> list[str]:
    """Pick up to `limit` live contact names whose token overlap with the
    description is highest. Cheap heuristic: shared alphabetic tokens."""
    hint_tokens = {t for t in re.split(r"[^a-z]+", (hint or "").lower())
                   if len(t) >= 3}
    scored: list[tuple[int, str]] = []
    for c in live_contacts:
        name = c.get("name") or ""
        n_tokens = {t for t in re.split(r"[^a-z]+", name.lower())
                    if len(t) >= 3}
        if not n_tokens:
            continue
        overlap = len(hint_tokens & n_tokens)
        if overlap:
            scored.append((overlap, name))
    scored.sort(reverse=True)
    return [n for _s, n in scored[:limit]]


_SYSTEM = (
    "You normalize noisy bank-transaction descriptions into a single "
    "merchant or counterparty name. Never invent a person's name if the "
    "description doesn't contain one. Prefer picking a name from the "
    "provided candidates. If nothing fits, propose a short, clean "
    "merchant name. Output STRICT JSON: "
    '{"name": "...", "matched_existing": true|false, '
    '"confidence": "high|medium|low", "reason": "..."}. '
    'If no name can be extracted, return {"name": null, ...}.'
)


async def _call_llm(company_id: str, description: str,
                     shortlist: list[str]) -> dict:
    """Single Claude Haiku call. Returns the parsed JSON payload or a
    ``reason`` on parse failure."""
    chat = LlmChat(
        api_key=None, session_id=str(uuid.uuid4()),
        system_message=_SYSTEM, company_id=company_id,
    ).with_model(_LLM_PROVIDER, _LLM_MODEL)

    prompt = json.dumps({
        "description": description,
        "candidates":  shortlist,
    }, ensure_ascii=False)
    try:
        reply = await chat.send_message(UserMessage(text=prompt))
    except Exception as ex:                          # noqa: BLE001
        log.warning("lab.llm: send_message failed: %s", ex)
        return {"name": None, "matched_existing": False,
                "confidence": "low",
                "reason": f"llm_error: {type(ex).__name__}"}
    # Parse JSON from anywhere in the reply.
    text = (reply or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        return json.loads(text)
    except Exception:
        # Try to extract the first JSON object.
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
        return {"name": None, "matched_existing": False,
                "confidence": "low", "reason": "unparseable_llm_reply"}


async def resolve_llm_pending(company_id: str,
                               contacts_live: list[dict]) -> dict:
    """For every row with ``contact_source == "llm_pending"``, call the
    LLM once per unique description (cache-first) and stamp the result.

    Returns diagnostics: {targeted, cache_hits, calls, matched, new,
    still_unresolved, reasons}.
    """
    stats = {
        "targeted":         0,
        "cache_hits":       0,
        "calls":            0,
        "matched":          0,
        "new":              0,
        "still_unresolved": 0,
        "reasons":          {},
    }
    by_normname = {(c.get("normalized_name") or normalize_contact_name(c.get("name") or "")): c
                   for c in contacts_live if c.get("name")}
    async for row in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id, "contact_source": "llm_pending"},
    ):
        stats["targeted"] += 1
        desc = row.get("description_live") or ""
        cache_key = _llm_cache_key(desc)
        cached = await _get_cached(cache_key)
        if not cached:
            shortlist = _make_shortlist(contacts_live, desc, limit=40)
            payload = await _call_llm(company_id, desc, shortlist)
            stats["calls"] += 1
            cached = {
                "cache_key":  cache_key,
                "company_id": company_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "model":      _LLM_MODEL,
                "input":      {"description": desc, "shortlist": shortlist},
                "output":     payload,
            }
            await _put_cached(cached)
        else:
            stats["cache_hits"] += 1

        payload = cached.get("output") or {}
        name = (payload.get("name") or "").strip() or None
        set_doc: dict = {}
        if not name:
            set_doc = {
                "contact":        None,
                "contact_source": "unresolved",
                "contact_reason": payload.get("reason") or "llm_no_name",
                "contact_id_lab": None,
                "lab_contact_new": False,
            }
            stats["still_unresolved"] += 1
            r = payload.get("reason") or "no_name"
            stats["reasons"][r] = stats["reasons"].get(r, 0) + 1
        else:
            n = normalize_contact_name(name)
            live = by_normname.get(n)
            if live:
                set_doc = {
                    "contact":         live["name"],
                    "contact_source":  "llm_match_live",
                    "contact_reason":  payload.get("reason") or "llm matched existing",
                    "contact_id_lab":  live["id"],
                    "lab_contact_new": False,
                }
                stats["matched"] += 1
            else:
                set_doc = {
                    "contact":         name,
                    "contact_source":  "llm_new",
                    "contact_reason":  payload.get("reason") or "llm proposed new",
                    "contact_id_lab":  None,
                    "lab_contact_new": True,
                }
                stats["new"] += 1
                # Mint a lab_contacts row (idempotent).
                await db[LAB_CONTACTS].update_one(
                    {"company_id": company_id, "normalized_name": n},
                    {"$setOnInsert": {
                        "id":              str(uuid.uuid4()),
                        "company_id":      company_id,
                        "name":            name,
                        "normalized_name": n,
                        "source":          "llm_new",
                        "created_at":      datetime.now(timezone.utc).isoformat(),
                    },
                     "$inc": {"txn_count": 1},
                     "$set": {"last_txn_id": row.get("txn_id"),
                              "last_updated": datetime.now(timezone.utc).isoformat()}},
                    upsert=True,
                )
        await db[LAB_TRANSACTIONS].update_one(
            {"_id": row["_id"]}, {"$set": set_doc},
        )
    return stats
