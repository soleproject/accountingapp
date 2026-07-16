"""Categorization pipeline v2 — adopts Rocketbooks' merchant-grouping +
Uncategorized-bucketing + meal-cap guard, alongside our existing merchant
cache and 10-way parallelism.

Flow per import batch:
    1. Filter candidates (dedup / closed periods / source-of-truth)
    2. Group by (contact_id or normalized_merchant, direction)
    3. For each group:
        a. Cache lookup by normalized merchant       → skip LLM
        b. LLM categorize with PFC hint + full COA   → cache the result
        c. Apply result to every txn in the group    → 1 call, N updates
    4. Confidence tier:
        confidence >= threshold  → posted=true, needs_review=false (unless meal-cap)
        confidence <  threshold  → posted=true to Uncategorized bucket, needs_review=true
"""
from __future__ import annotations
import asyncio
from typing import Awaitable, Callable

from db import db, now_iso
import merchant_cache
import merchant_rules
from plaid_connect import _ensure_account  # reuse


# ---- Meal-cap guard: don't auto-approve big "meals" (probably mis-tagged) ---

MEAL_ACCOUNT_KEYWORDS = ("meal", "dining", "entertainment")
MEAL_AUTO_APPROVE_CAP = 150.00


def exceeds_meal_auto_approve_cap(account_name: str | None, amount: float) -> bool:
    """A meal-tagged expense over $150 is almost always mis-categorized
    (Plaid mis-tag, Uber miscategorized as delivery, etc.). Force review.
    """
    if not account_name:
        return False
    name = account_name.lower()
    if any(k in name for k in MEAL_ACCOUNT_KEYWORDS):
        return abs(float(amount)) > MEAL_AUTO_APPROVE_CAP
    return False


# ---- Uncategorized-bucket account creation ---------------------------------

async def ensure_uncategorized_accounts(company_id: str) -> tuple[dict, dict]:
    """Return (uncat_expense, uncat_income) for this company, creating them if
    absent. Codes 6999 (expense) and 4999 (income) — sortable to end of list.
    """
    exp = await _ensure_account(
        company_id, "6999", "Uncategorized Expense", "expense", "operating_expense",
    )
    inc = await _ensure_account(
        company_id, "4999", "Uncategorized Income", "revenue", "operating_revenue",
    )
    return exp, inc


async def ensure_transfer_clearing_account(company_id: str) -> dict:
    """Bank-to-bank transfer clearing/suspense account. Internal transfers
    (Online Banking transfer, WELLS FARGO DDA TO DDA, etc.) post here until an
    accountant manually pairs the two legs. This prevents ~10-20% of raw Plaid
    volume from being mis-tagged as revenue or expense (which was skewing
    355 LLC's balance sheet by $15K–$20K/month).
    """
    return await _ensure_account(
        company_id, "1099", "Bank Transfer Clearing", "asset", "current_asset",
    )


# ---- Grouping --------------------------------------------------------------

def _group_key(item: dict) -> str:
    """(contact OR normalized merchant, direction) — same grouping rule
    Rocketbooks uses. `direction` is inferred from `amount` sign."""
    contact_id = item.get("contact_id")
    if contact_id:
        merchant_part = f"c:{contact_id}"
    else:
        merchant_part = f"m:{merchant_cache.normalize_merchant(item.get('merchant') or '')}"
    direction = "in" if float(item.get("amount", 0)) >= 0 else "out"
    return f"{merchant_part}|{direction}"


def group_by_merchant(items: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for it in items:
        k = _group_key(it)
        groups.setdefault(k, []).append(it)
    return groups


# ---- Group-level categorizer -----------------------------------------------

async def categorize_group(
    company_id: str, group: list[dict], coa: list[dict],
    llm_fn: Callable[..., Awaitable[dict]],
) -> dict:
    """Categorize a whole group with ONE LLM call.
    Cache-first (via merchant_cache); LLM fallback picks a representative row
    (most recent by date). Returns a single categorization dict that will be
    applied to every row in the group.
    """
    if not group:
        return {"account_code": "9999", "confidence": 0.3,
                "reasoning": "empty group", "cache_hit": False}
    # Representative = most recent date
    rep = max(group, key=lambda x: x.get("date") or "")
    result = await merchant_cache.categorize_with_cache(
        company_id, rep.get("merchant") or "", float(rep.get("amount") or 0.0),
        rep.get("description") or "", coa,
        llm_fn=lambda m, a, d, c: llm_fn(m, a, d, c, pfc=rep.get("pfc")),
    )
    return result


async def categorize_batch_grouped(
    company_id: str, items: list[dict], coa: list[dict],
    llm_fn: Callable[..., Awaitable[dict]],
    concurrency: int = 10,
) -> list[dict]:
    """Groups items → 1 LLM call per group → returns per-item categorization
    dicts (same order as input). Massively cheaper than per-item calls when a
    company has repeat merchants (which is ~always).
    """
    groups = group_by_merchant(items)
    sem = asyncio.Semaphore(concurrency)

    async def do_group(key: str, group: list[dict]) -> tuple[str, dict]:
        async with sem:
            r = await categorize_group(company_id, group, coa, llm_fn)
            return key, r

    tasks = [asyncio.create_task(do_group(k, g)) for k, g in groups.items()]
    per_group: dict[str, dict] = {}
    for coro in asyncio.as_completed(tasks):
        k, r = await coro
        per_group[k] = r

    out: list[dict] = []
    for it in items:
        out.append(per_group[_group_key(it)])
    return out


# ---- Post-categorize decisioning -------------------------------------------

def decide_posting(
    result: dict, threshold: float, uncat_exp: dict, uncat_inc: dict,
    accts: list[dict], amount: float,
) -> dict:
    """Given a categorization result + amount, return the doc-fragment fields
    that determine where the txn posts.

    Returns:
      {category_account_id, category_account_code, category_account_name,
       ai_confidence, ai_reasoning, needs_review, posted, ai_source}
    """
    conf = float(result.get("confidence") or 0.5)
    code = str(result.get("account_code") or "")
    acct = next((a for a in accts if a["code"] == code), None)

    # Confidence below threshold OR no matching account → Uncategorized bucket
    if conf < threshold or not acct:
        bucket = uncat_inc if amount >= 0 else uncat_exp
        return {
            "category_account_id": bucket["id"],
            "category_account_code": bucket["code"],
            "category_account_name": bucket["name"],
            "ai_confidence": round(conf, 2),
            "ai_reasoning": result.get("reasoning", ""),
            "needs_review": True,
            "posted": True,  # posts to Uncategorized — hits the GL now
            "ai_source": "uncategorized",
        }

    # Meal-cap guard — post to the picked category but require human review
    force_review = exceeds_meal_auto_approve_cap(acct.get("name"), amount)
    return {
        "category_account_id": acct["id"],
        "category_account_code": acct["code"],
        "category_account_name": acct["name"],
        "ai_confidence": round(conf, 2),
        "ai_reasoning": result.get("reasoning", ""),
        "needs_review": force_review,
        "posted": True,
        "ai_source": "memory" if result.get("cache_hit") else "ai",
    }


def decide_posting_transfer(transfer_acct: dict) -> dict:
    """Doc-fragment for internal bank-to-bank transfers. Posts to a suspense
    clearing account with needs_review=True so an accountant pairs the two
    legs. Keeps transfers out of income/expense — the single biggest source
    of report skew on raw Plaid data.
    """
    return {
        "category_account_id": transfer_acct["id"],
        "category_account_code": transfer_acct["code"],
        "category_account_name": transfer_acct["name"],
        "ai_confidence": 1.00,
        "ai_reasoning": "Internal bank transfer — pair with matching leg.",
        "needs_review": True,
        "posted": True,
        "ai_source": "rule",
    }


async def get_auto_post_threshold(company_id: str) -> float:
    """Load per-org threshold from companies collection, default 0.80."""
    c = await db.companies.find_one({"id": company_id})
    if not c:
        return 0.80
    try:
        return float(c.get("auto_post_threshold") or 0.80)
    except Exception:  # noqa: BLE001
        return 0.80
