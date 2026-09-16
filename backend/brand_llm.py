"""LLM-based semantic classification for Step 2 Brand Registry.

Three tasks — every result is cached in ``brand_llm_cache`` keyed on
the inputs and the model version so page reloads don't re-bill:

  1. :func:`identify_merchant`
       Match a truncated / messy descriptor (PayPal ID value, bank
       memo tail, OCR text, etc.) to an APPROVED registry entry or
       propose a new candidate with an LLM-suggested ``merchant_type``
       and ``category_hint``.

  2. :func:`category_fits`
       Given the merchant, ``pfc_detailed``, amount sign, and the
       assigned ledger account, decide if the categorization is
       coherent + return a one-sentence reason.

  3. :func:`merge_suggestion`
       Distinguish "same person written differently" from "different
       people who share a name". Suggestion only.

Guardrails (per user's Step 2 spec):
  • LLM PROPOSES, deterministic rules DECIDE auto-handle vs review.
  • Save the model version + reason on every cache row.
  • On LLM failure / unsure output, return a structured "unsure" result
    — callers translate that to ``review_reason = llm_unsure``.
  • Cache once per (task, inputs, model_version). Never recompute on
    page load; only when the underlying inputs change.
"""
from __future__ import annotations
import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from db import db
from ai_service import _new_chat, MODEL_HAIKU, MODEL_NAME
from llm_client import UserMessage, TextDelta, StreamDone
from brand_registry import MERCHANT_TYPES

log = logging.getLogger("axiom.brand_llm")

# Track approximate cost + hit rate for the Step 2 report.
_MODEL_VERSION = os.environ.get("BRAND_LLM_MODEL_VERSION",
                                f"{MODEL_HAIKU}:v2")

# Very rough cost heuristic — enough for the report line "approx cost".
# Assumes ~600 in + 200 out tokens per call at gpt-4o-mini rates.
_APPROX_COST_PER_CALL_USD = 0.00025


class BrandLLMStats:
    """In-process counters for the current audit-preview run."""
    def __init__(self) -> None:
        self.calls_made   = 0
        self.cache_hits   = 0
        self.failures     = 0

    def record_hit(self) -> None:  self.cache_hits += 1
    def record_call(self) -> None: self.calls_made += 1
    def record_fail(self) -> None: self.failures   += 1

    @property
    def approx_cost_usd(self) -> float:
        return round(self.calls_made * _APPROX_COST_PER_CALL_USD, 4)

    def as_dict(self) -> dict:
        return {
            "calls_made":     self.calls_made,
            "cache_hits":     self.cache_hits,
            "failures":       self.failures,
            "approx_cost_usd": self.approx_cost_usd,
            "model_version":   _MODEL_VERSION,
        }


def _hash_key(kind: str, payload: dict) -> str:
    blob = json.dumps({"kind": kind, "payload": payload, "m": _MODEL_VERSION},
                      sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


async def _cache_get(cache_key: str) -> Optional[dict]:
    row = await db.brand_llm_cache.find_one({"cache_key": cache_key})
    if not row:
        return None
    return row.get("result")


async def _cache_put(cache_key: str, kind: str, inputs: dict, result: dict) -> None:
    try:
        await db.brand_llm_cache.update_one(
            {"cache_key": cache_key},
            {"$set": {
                "cache_key":     cache_key,
                "kind":          kind,
                "inputs":        inputs,
                "result":        result,
                "model_version": _MODEL_VERSION,
                "created_at":    datetime.now(timezone.utc).isoformat(),
            }},
            upsert=True,
        )
    except Exception as e:  # noqa: BLE001
        log.debug("brand_llm cache put failed: %s", e)


async def _run_llm_json(system: str, user_prompt: str, *,
                        session_prefix: str, feature: str,
                        stats: BrandLLMStats | None = None,
                        timeout_s: float = 15.0,
                        model_override: str | None = None) -> Optional[dict]:
    """Run a single LLM call, expect a strict JSON object back. Returns
    the parsed dict or None on any failure. Uses the FAST model by
    default; pass ``model_override`` to use a stronger model for
    comparison studies.
    """
    stats and stats.record_call()
    sid = f"{session_prefix}-{int(time.time()*1000)}"
    chat = _new_chat(system, sid,
                     model_name=(model_override or MODEL_HAIKU),
                     feature=feature)
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=user_prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:  # noqa: BLE001
        log.warning("brand_llm call failed: %s", e)
        stats and stats.record_fail()
        return None
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        stats and stats.record_fail()
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        stats and stats.record_fail()
        return None


# ---------------------------------------------------------------- (1)

_IDENTIFY_SYSTEM = (
    "You classify bank-descriptor / merchant strings into a shared "
    "merchant brand registry. You must be conservative: if the string "
    "is ambiguous, output unsure. Never invent a specific merchant "
    "name that isn't obvious from the input.\n\n"
    "merchant_type must be one of the following. Read the definitions "
    "carefully — the wrong bucket triggers the wrong review rules:\n"
    " • merchant       = single-purpose retailer where the merchant "
    "name tells you what was bought. Includes restaurants, fast food, "
    "cafes, coffee chains (Starbucks, Panera, Chick-fil-A, Panda "
    "Express, Little Caesar's, Baskin-Robbins), pet stores (PetSmart, "
    "Petco), craft stores (Michaels, Hobby Lobby), furniture / home "
    "goods (Pottery Barn, Crate & Barrel, IKEA), electronics (Best "
    "Buy, Apple retail), auto parts (AutoZone), specialty grocery "
    "chains, and any other retailer where the purchase type is "
    "obvious from the store.\n"
    " • multi_purpose  = STORES WHERE THE PURCHASE TYPE CANNOT BE "
    "INFERRED FROM THE MERCHANT: superstores, warehouse clubs, online "
    "marketplaces, department stores. Concrete list: Walmart, Target, "
    "Costco, Sam's Club, BJ's Wholesale, Amazon, eBay, Meijer, Fred "
    "Meyer. Dollar stores / pharmacies / grocery are NOT multi_purpose "
    "(they are merchant with personal_risk=true). Restaurants are "
    "NEVER multi_purpose.\n"
    " • payment_app    = intermediary (PayPal, Venmo, Cash App, Zelle "
    "host, Stripe, Square).\n"
    " • bank_lender    = banks that issue loans (Rocket Mortgage, "
    "Wells Fargo Home Mortgage, SoFi, LendingClub).\n"
    " • credit_card    = card issuer (Amex, Chase Card, Capital One, "
    "Citi Card, Discover, Synchrony).\n"
    " • government     = IRS / state tax authority, DMV, SoS, "
    "municipal utility, court.\n"
    " • insurance      = carriers, brokers (Trupanion, Healthy Paws, "
    "State Farm, Geico).\n"
    " • utility        = power / water / gas / telco / internet / "
    "waste (NV Energy, Truckee Meadows Water, AT&T, Verizon, Comcast, "
    "PG&E).\n\n"
    "personal_risk (bool) = the merchant sells items that are commonly "
    "personal purchases even when the card is business (dollar stores, "
    "pharmacies, grocery). Setting this true lets the review-rules "
    "engine flag closer for personal use.\n\n"
    "Reply ONLY with strict JSON, no prose. Shape:\n"
    "{\n"
    '  "match": "existing" | "new" | "unsure",\n'
    '  "canonical_name": "Walmart" | null,\n'
    '  "merchant_type":  "multi_purpose" | null,\n'
    '  "category_hint":  "Office Supplies" | null,\n'
    '  "personal_risk":  false,\n'
    '  "confidence":     0.0-1.0,\n'
    '  "unsure_cause":   "ambiguous_merchant" | "missing_inputs" | '
    '"low_confidence" | null,\n'
    '  "reason":         "one short sentence explaining the decision"\n'
    "}\n"
)


async def identify_merchant(
    *,
    descriptor: str,
    merchant_field: str | None,
    pfc_detailed: str | None,
    amount: float | None,
    approved_registry_sample: list[str],
    stats: BrandLLMStats | None = None,
    model_override: str | None = None,
) -> dict:
    """Classify a merchant string. Result shape (always returned):

        {
            "match": "existing" | "new" | "unsure",
            "canonical_name": str | None,
            "merchant_type":  str | None,
            "category_hint":  str | None,
            "confidence":     float,
            "reason":         str,
            "from_cache":     bool,
        }
    """
    inputs = {
        "descriptor":     (descriptor or "")[:200],
        "merchant_field": (merchant_field or "")[:80],
        "pfc_detailed":   pfc_detailed or "",
        "direction":      "in" if (amount or 0) > 0 else "out",
    }
    # Include the model in the cache key when overriden so the stronger-
    # model comparison run doesn't collide with the fast-model cache.
    cache_inputs = dict(inputs)
    if model_override:
        cache_inputs["_model"] = model_override
    cache_key = _hash_key("identify_merchant", cache_inputs)

    cached = await _cache_get(cache_key)
    if cached is not None:
        stats and stats.record_hit()
        return {**cached, "from_cache": True, "prompt_inputs": inputs}

    # Trim the approved sample to keep the prompt cheap.
    sample = ", ".join(sorted(set(approved_registry_sample))[:60]) or "(empty)"

    prompt = (
        f"Approved brands (pick from these when match=existing): {sample}\n\n"
        f"Bank descriptor:  {inputs['descriptor']}\n"
        f"Enriched merchant field: {inputs['merchant_field']}\n"
        f"Plaid pfc_detailed:      {inputs['pfc_detailed']}\n"
        f"Direction:               {inputs['direction']}\n\n"
        "Classify the merchant. Prefer match=existing when the "
        "descriptor names one of the approved brands. Use match=new "
        "when you can identify a specific merchant not in the list "
        "(propose canonical_name + merchant_type + category_hint). "
        "Use match=unsure when the descriptor is generic / opaque / "
        "internal transfer / just the payment app.\n\n"
        "Return the JSON now."
    )
    parsed = await _run_llm_json(
        _IDENTIFY_SYSTEM, prompt,
        session_prefix="identify",
        feature="brand-llm-identify",
        stats=stats,
        model_override=model_override,
    )
    if not parsed:
        result = {
            "match":         "unsure",
            "canonical_name": None,
            "merchant_type":  None,
            "category_hint":  None,
            "personal_risk":  False,
            "confidence":     0.0,
            "unsure_cause":   "parsing_failure",
            "reason":         "LLM call failed or returned unparseable output",
        }
    else:
        # Guardrail sanitize
        match = str(parsed.get("match", "unsure")).lower()
        if match not in ("existing", "new", "unsure"):
            match = "unsure"
        mtype = parsed.get("merchant_type")
        if mtype not in MERCHANT_TYPES:
            mtype = None
        try:
            conf = float(parsed.get("confidence") or 0.0)
        except Exception:
            conf = 0.0
        cause = parsed.get("unsure_cause")
        if match != "unsure":
            cause = None
        elif cause not in ("ambiguous_merchant", "missing_inputs",
                             "low_confidence", "parsing_failure"):
            # Infer if the LLM didn't self-classify
            if not (descriptor or merchant_field):
                cause = "missing_inputs"
            elif conf and conf < 0.5:
                cause = "low_confidence"
            else:
                cause = "ambiguous_merchant"
        result = {
            "match":          match,
            "canonical_name": (parsed.get("canonical_name") or None),
            "merchant_type":  mtype,
            "category_hint":  parsed.get("category_hint") or None,
            "personal_risk":  bool(parsed.get("personal_risk")),
            "confidence":     max(0.0, min(conf, 1.0)),
            "unsure_cause":   cause,
            "reason":         (parsed.get("reason") or "")[:200],
        }
    await _cache_put(cache_key, "identify_merchant", inputs, result)
    return {**result, "from_cache": False, "prompt_inputs": inputs}


# ---------------------------------------------------------------- (2)

_CATEGORY_FITS_SYSTEM = (
    "You are the last check on whether a bookkeeping categorization "
    "is coherent. Given a merchant, its recent Plaid category "
    "(pfc_detailed), the amount + direction, and the ledger account "
    "the categorizer would post to, return whether the pairing is "
    "reasonable.\n\n"
    "Return ONLY strict JSON:\n"
    "{\n"
    '  "fits":       true | false,\n'
    '  "reason":     "one short sentence"\n'
    "}\n"
    "Be conservative: prefer fits=true when the account name is a "
    "reasonable generalization of the merchant's activity. Return "
    "fits=false only when the pairing is clearly wrong (e.g. "
    "Starbucks -> Rent, Home Depot -> Payroll Expense, IRS -> Office "
    "Supplies)."
)


async def category_fits(
    *,
    merchant: str,
    pfc_detailed: str | None,
    amount: float | None,
    direction: str,
    account_name: str,
    account_type: str,
    stats: BrandLLMStats | None = None,
) -> dict:
    """Return {'fits': bool, 'reason': str, 'from_cache': bool}."""
    inputs = {
        "merchant":     (merchant or "")[:80],
        "pfc_detailed": pfc_detailed or "",
        "direction":    direction,
        "account":      (account_name or "")[:80],
        "account_type": (account_type or "")[:20],
        # Amount rounded to nearest dollar so cents don't bust the cache.
        "amount_bucket": round(abs(float(amount or 0)), 0),
    }
    cache_key = _hash_key("category_fits", inputs)
    cached = await _cache_get(cache_key)
    if cached is not None:
        stats and stats.record_hit()
        return {**cached, "from_cache": True}

    prompt = (
        f"Merchant:     {inputs['merchant']}\n"
        f"pfc_detailed: {inputs['pfc_detailed']}\n"
        f"Amount:       {'$'+str(inputs['amount_bucket'])} ({direction})\n"
        f"Assigned account: {inputs['account']} ({inputs['account_type']})\n\n"
        "Does this posting make sense? Return the JSON now."
    )
    parsed = await _run_llm_json(
        _CATEGORY_FITS_SYSTEM, prompt,
        session_prefix="catfit",
        feature="brand-llm-category-fits",
        stats=stats,
    )
    if not parsed:
        # Conservative fallback: unsure → route to review.
        result = {"fits": False, "reason": "llm_unsure"}
    else:
        result = {
            "fits":   bool(parsed.get("fits")),
            "reason": (parsed.get("reason") or "")[:200] or "no reason",
        }
    await _cache_put(cache_key, "category_fits", inputs, result)
    return {**result, "from_cache": False}


# ---------------------------------------------------------------- (3)

_MERGE_SYSTEM = (
    "Given two contact names on the same company's book, decide "
    "whether they are the SAME PERSON written differently (a merge "
    "candidate) or DIFFERENT PEOPLE who happen to share a name.\n\n"
    "Rules:\n"
    " • Same last name alone is NOT enough — treat different first "
    "names as different people.\n"
    " • Middle initial variants ('John A Smith' vs 'John Smith'), "
    "run-together variants ('Smithjohn' vs 'John Smith'), or "
    "first-last order swaps are strong signals of the same person.\n"
    " • Business names (LLC / Inc / Co) should never merge with a "
    "personal name.\n\n"
    "Return ONLY strict JSON:\n"
    "{\n"
    '  "same_person": true | false,\n'
    '  "confidence":  0.0-1.0,\n'
    '  "reason":      "one short sentence"\n'
    "}"
)


async def merge_suggestion(
    *, name_a: str, name_b: str,
    stats: BrandLLMStats | None = None,
) -> dict:
    """LLM opinion on whether two names are the same person. Suggestion
    only; the CPA UI is always the final say."""
    inputs = {"a": (name_a or "")[:80].strip(),
              "b": (name_b or "")[:80].strip()}
    if not inputs["a"] or not inputs["b"]:
        return {"same_person": False, "confidence": 0.0,
                "reason": "empty input", "from_cache": False}
    # Order-independent cache
    ordered = sorted([inputs["a"], inputs["b"]], key=str.lower)
    cache_inputs = {"a": ordered[0], "b": ordered[1]}
    cache_key = _hash_key("merge_suggestion", cache_inputs)
    cached = await _cache_get(cache_key)
    if cached is not None:
        stats and stats.record_hit()
        return {**cached, "from_cache": True}

    prompt = (
        f"Contact A: {inputs['a']}\n"
        f"Contact B: {inputs['b']}\n\n"
        "Are they the same person? Return the JSON now."
    )
    parsed = await _run_llm_json(
        _MERGE_SYSTEM, prompt,
        session_prefix="merge",
        feature="brand-llm-merge",
        stats=stats,
    )
    if not parsed:
        result = {"same_person": False, "confidence": 0.0,
                  "reason": "llm_unsure"}
    else:
        try:
            conf = float(parsed.get("confidence") or 0.0)
        except Exception:
            conf = 0.0
        result = {
            "same_person": bool(parsed.get("same_person")),
            "confidence":  max(0.0, min(conf, 1.0)),
            "reason":      (parsed.get("reason") or "")[:200],
        }
    await _cache_put(cache_key, "merge_suggestion", cache_inputs, result)
    return {**result, "from_cache": False}
