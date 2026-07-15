"""Per-company merchant → category cache. Bypasses the LLM for repeat merchants,
which is how QBO/Xero achieve their sub-minute imports.

Cache lookup order:
    1. Normalized-merchant exact hit  → apply cached (account_code, confidence)
    2. Miss                            → LLM categorize → upsert cache

User overrides always win: on approve/recategorize we upsert with source='user'
which is treated as authoritative and never overwritten by future LLM guesses.
"""
from __future__ import annotations
import asyncio
import re
from typing import Awaitable, Callable

from db import db, now_iso


# ---------- Normalization -----------------------------------------------------

_PAYMENT_PROCESSOR_PREFIXES = [
    "SQ *", "SQ*", "TST*", "TST *", "PP*", "PAYPAL *", "PAYPAL*",
    "PY *", "PY*", "DBT PURCHASE", "POS DEBIT",
    "ACH DEBIT", "ACH CREDIT", "ELECTRONIC PAYMENT",
    "AUTHORIZED PAYMENT", "AUTOMATIC PAYMENT",
    "CHECKCARD ", "PURCHASE AUTHORIZED ON ", "PURCHASE AUTHORIZED",
    "RECURRING DEBIT PURCHASE",
]

# Match common trailing junk added by processors: dates, ids, cities/states
_TAIL_JUNK_PATTERNS = [
    re.compile(r"\s+#\d+.*$"),                              # #1234 anything
    re.compile(r"\s+\d{1,2}/\d{1,2}(/\d{2,4})?\s*$"),       # trailing date like 7/12 or 07/12/25
    re.compile(r"\s+\d{4,}$"),                              # trailing txn id
    re.compile(r"\s+[A-Z]{2}\s*$"),                         # trailing state
    re.compile(r"\s+[A-Z][A-Z']+\s+[A-Z]{2}\s*$"),          # trailing "CITY ST"
    re.compile(r"\s+DES:\s*.*$", re.I),                     # ACH DES: descriptor
    re.compile(r"\s+ID:\s*.*$", re.I),                      # ID: xxx
    re.compile(r"\s+INDN:\s*.*$", re.I),                    # INDN: xxx
    re.compile(r"\s+CO ID:.*$", re.I),                      # CO ID: xxx
    re.compile(r"\*[A-Z0-9]{4,}$"),                         # *ABCD1234 (attached or standalone)
]


def normalize_merchant(raw: str) -> str:
    """Return a canonical, case-insensitive key for a merchant string. Two
    strings that describe the same real-world merchant should collapse to the
    same normalized value.

        "SQ *Blue Bottle Coffee 4th S" → "blue bottle coffee"
        "AMZN Mktp US*A12B3CD"          → "amzn mktp us"
        "Uber Trip 7/12"                → "uber trip"
    """
    if not raw:
        return ""
    s = str(raw).strip().upper()

    # Strip payment-processor prefixes (may be chained)
    for _ in range(3):
        for pfx in _PAYMENT_PROCESSOR_PREFIXES:
            if s.startswith(pfx):
                s = s[len(pfx):].lstrip()
                break
        else:
            break

    # Strip trailing junk (dates, ids, cities)
    for _ in range(3):
        changed = False
        for pat in _TAIL_JUNK_PATTERNS:
            new = pat.sub("", s)
            if new != s:
                s = new
                changed = True
        if not changed:
            break

    # Collapse whitespace + strip punctuation edges
    s = re.sub(r"[^A-Z0-9 &']+", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()

    # Drop trailing single-word noise like "LLC", "INC"
    s = re.sub(r"\s+(LLC|INC|CO|CORP|LTD|COM|USA)$", "", s)
    return s.lower()


# ---------- CRUD --------------------------------------------------------------

async def lookup(company_id: str, merchant_raw: str) -> dict | None:
    """Return a cached categorization for the given merchant, or None on miss.
    Bumps `hit_count` and `last_used_at` on hit.
    """
    key = normalize_merchant(merchant_raw)
    if not key:
        return None
    doc = await db.merchant_cache.find_one({"company_id": company_id, "merchant_normalized": key})
    if not doc:
        return None
    # Non-blocking increment (wrap in coroutine — motor returns a Future not a coro)
    async def _bump():
        try:
            await db.merchant_cache.update_one(
                {"_id": doc["_id"]},
                {"$inc": {"hit_count": 1}, "$set": {"last_used_at": now_iso()}},
            )
        except Exception:  # noqa: BLE001
            pass
    asyncio.create_task(_bump())
    return {
        "account_code": doc["account_code"],
        "account_name": doc.get("account_name"),
        "confidence": doc.get("confidence", 0.90),
        "reasoning": f"Cached from prior categorization (used {doc.get('hit_count', 0) + 1}× · source={doc.get('source', 'llm')})",
        "cache_hit": True,
        "cache_source": doc.get("source", "llm"),
    }


async def upsert(company_id: str, merchant_raw: str, account_code: str,
                 account_name: str, confidence: float, source: str = "llm") -> None:
    """Insert or update a cache entry. User-source entries are authoritative and
    never overwritten by LLM entries.
    """
    key = normalize_merchant(merchant_raw)
    if not key or not account_code:
        return
    existing = await db.merchant_cache.find_one({"company_id": company_id, "merchant_normalized": key})
    if existing:
        # If a user has already categorized this merchant, never let the LLM
        # overwrite it — cache is authoritative in that direction.
        if existing.get("source") == "user" and source == "llm":
            return
        # Never let a low-confidence LLM guess overwrite anything either
        if source == "llm" and confidence < 0.85:
            return
        await db.merchant_cache.update_one(
            {"_id": existing["_id"]},
            {"$set": {
                "account_code": account_code,
                "account_name": account_name,
                "confidence": confidence,
                "source": source,
                "merchant_raw": merchant_raw,
                "updated_at": now_iso(),
            }},
        )
        return
    # Don't seed the cache with a low-confidence LLM guess — it would propagate
    # a bad first-impression to every future txn from the same merchant.
    if source == "llm" and confidence < 0.85:
        return
    await db.merchant_cache.insert_one({
        "company_id": company_id,
        "merchant_normalized": key,
        "merchant_raw": merchant_raw,
        "account_code": account_code,
        "account_name": account_name,
        "confidence": confidence,
        "source": source,
        "hit_count": 0,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "last_used_at": None,
    })


async def ensure_indexes() -> None:
    """Idempotent index setup. Called at app startup."""
    try:
        await db.merchant_cache.create_index(
            [("company_id", 1), ("merchant_normalized", 1)],
            unique=True, name="company_merchant_uniq",
        )
        await db.merchant_cache.create_index(
            [("company_id", 1), ("hit_count", -1)], name="company_hit_desc",
        )
    except Exception:  # noqa: BLE001
        pass


# ---------- Parallel categorizer ----------------------------------------------

async def categorize_with_cache(
    company_id: str, merchant: str, amount: float, description: str,
    coa: list[dict], llm_fn: Callable[..., Awaitable[dict]],
) -> dict:
    """Cache-first categorization. On cache hit, no LLM call. On miss, calls the
    supplied LLM function and caches the result before returning.
    """
    hit = await lookup(company_id, merchant)
    if hit:
        return hit
    result = await llm_fn(merchant, amount, description, coa)
    try:
        await upsert(
            company_id, merchant,
            account_code=result["account_code"],
            account_name=next((a["name"] for a in coa if a["code"] == result["account_code"]), None),
            confidence=float(result.get("confidence") or 0.85),
            source="llm",
        )
    except Exception:  # noqa: BLE001
        pass  # cache upsert never blocks the categorization return
    result["cache_hit"] = False
    return result


async def categorize_batch(
    company_id: str, items: list[dict], coa: list[dict],
    llm_fn: Callable[..., Awaitable[dict]], concurrency: int = 10,
) -> list[dict]:
    """Categorize many txns in parallel with a concurrency limit. Cache hits
    short-circuit without holding a slot for LLM work. `items` must be
    list of {merchant, amount, description}; returns results in the same order.
    """
    sem = asyncio.Semaphore(concurrency)

    async def one(idx: int, item: dict) -> tuple[int, dict]:
        async with sem:
            r = await categorize_with_cache(
                company_id, item["merchant"], item["amount"],
                item["description"], coa, llm_fn,
            )
            return idx, r

    tasks = [asyncio.create_task(one(i, it)) for i, it in enumerate(items)]
    out: list[dict | None] = [None] * len(items)
    for coro in asyncio.as_completed(tasks):
        idx, res = await coro
        out[idx] = res
    return [r for r in out if r is not None]
