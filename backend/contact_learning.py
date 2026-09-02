"""Contact-scoped category learning.

Sits between the user-rule matcher and the merchant-regex fallback in
the ingest pipeline. The idea (Feb 2026 planning thread):

  1. Contact-keyed rules — win when they fire (specificity +3 bump).
  2. Targeted merchant rules — direction / amount / bank filters.
  3. **Contact learning** (this module) — mines the CPA's approved
     history for this specific contact and applies the majority
     category if the signal is strong.
  4. Plain merchant rules — bare regex fallback.

Why: CPAs train the system by their actions, not by writing rules
explicitly. A CPA who manually posts 5 Walmart rows to 6300 has already
declared "Walmart goes to 6300" — the ingest pipeline should hear that
signal even without a formal rule, and it should override a stale
plain-merchant rule that was auto-mined earlier and now mis-categorizes.

Thresholds (tunable):
  * ``MIN_SAMPLE = 3`` — need at least 3 approved txns for this contact
    before extrapolating.
  * ``MIN_CONFIDENCE = 0.80`` — winning category must own ≥80% of the
    sample. Below that we abstain and let the downstream AI cascade
    decide.
  * ``WINDOW_SIZE = 20`` — look at the CPA's most recent 20 approved
    txns for this contact. Recent behavior dominates so habit changes
    (e.g. Walmart moved to a subaccount) propagate within a few txns.
  * ``PARKED_CODES`` — Uncategorized / holding-tank codes never count
    as signal even if human_reviewed=True on the row.
"""
from __future__ import annotations
from collections import Counter
from typing import Any, Iterable

from db import db


MIN_SAMPLE: int = 3
MIN_CONFIDENCE: float = 0.80
WINDOW_SIZE: int = 20
PARKED_CODES: set[str] = {"6999", "4999", "1999", "2999"}


def is_weak_merchant_rule(rule: dict) -> bool:
    """A plain merchant regex with no Tier-1 filters — the exact kind
    of rule the miner / rule_candidates auto-emits. Contact-keyed rules
    and merchant rules with direction / amount / bank filters are NOT
    weak — the CPA intentionally scoped them.
    """
    if (rule.get("match_field") or "merchant").lower() == "contact":
        return False
    if rule.get("direction"): return False
    if rule.get("amount_op"): return False
    if rule.get("bank_account_id"): return False
    if rule.get("extra_conditions"): return False
    return True


async def get_learned_category(
    cid: str,
    contact_id: str | None,
    accts: Iterable[dict],
) -> dict | None:
    """Return the learned-category post dict for this contact, or None
    if the signal is too weak. Shape mirrors ``user_rule_matcher._build_post``
    so callers can drop it into the same slot on the candidate.

    Returned dict:
      {
        "post": {
          "category_account_id", "category_account_code",
          "category_account_name", "ai_confidence", "ai_reasoning",
          "ai_source": "contact_learning",
          "needs_review": False, "posted": True,
        },
        "sample_size": int,
        "confidence": float,
        "winner_count": int,
      }
    """
    if not contact_id:
        return None
    rows = await db.transactions.find({
        "company_id":   cid,
        "contact_id":   contact_id,
        "human_reviewed": True,
        "posted":       True,
        "category_account_code": {"$exists": True, "$nin": [None, ""]},
    }).sort("date", -1).limit(WINDOW_SIZE).to_list(WINDOW_SIZE)
    # Drop rows whose category is a parked / holding-tank code — those
    # are effectively "still uncategorized" from a signal perspective.
    rows = [r for r in rows if r.get("category_account_code") not in PARKED_CODES]
    if len(rows) < MIN_SAMPLE:
        return None
    counter = Counter(r["category_account_code"] for r in rows)
    winner_code, winner_count = counter.most_common(1)[0]
    confidence = winner_count / len(rows)
    if confidence < MIN_CONFIDENCE:
        return None
    acct = next((a for a in accts if a.get("code") == winner_code), None)
    if not acct:
        # Winner code no longer exists in the CoA (renamed / deleted) —
        # refuse to apply rather than silently mis-post.
        return None
    return {
        "post": {
            "category_account_id":   acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence":         float(confidence),
            "ai_reasoning": (
                f"Learned from {winner_count} of {len(rows)} approved "
                f"transactions for this contact → {acct.get('name')}"
            ),
            "ai_source": "contact_learning",
            "needs_review": False,
            "posted":       True,
        },
        "sample_size":   len(rows),
        "confidence":    float(confidence),
        "winner_count":  int(winner_count),
    }
