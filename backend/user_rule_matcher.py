"""User-rule matcher — runs `db.rules` against a single transaction
candidate during Plaid + Veryfi ingest.

Historically rules were only applied retroactively (via
`apply_to_existing` at rule-creation time). This module is the shared
core that wires user-defined rules into the LIVE ingest pipeline so a
rule set once keeps working for every subsequent import.

Contract used by callers (`plaid_connect.py`, `statements.py`):

    rules = await user_rule_matcher.load_active_rules(cid)
    if rules:
        hit = user_rule_matcher.match_and_build_post(cand, rules, accts)
        if hit:
            post = hit["post"]
            # optional extras land on the candidate itself so downstream
            # insert code picks them up alongside contact/class/tags.
            cand.setdefault("contact_id",   hit["contact_id"])
            cand.setdefault("contact_name", hit["contact_name"])
            ...

Design notes
------------
- Rules are loaded once per batch. Callers cache the list; we never
  hit Mongo per-row.
- "Most-specific wins" — the rule with the most conditions attached
  (Tier-1 amount/bank + count(extra_conditions)) beats a bare merchant
  rule when both match the same row.
- Contact-keyed rules (match_field=="contact") require the candidate
  to have `contact_id` already populated. Callers must invoke this
  AFTER `contact_resolver.resolve_contacts_batch()`.
"""
from __future__ import annotations
import re
from typing import Iterable

from db import db, now_iso


# ---------- loading ----------

async def load_active_rules(cid: str) -> list[dict]:
    """One Mongo hit per ingest batch; every ENABLED rule for the
    company. Rules flipped off via the enabled toggle are silently
    skipped so the CPA can "pause" a rule without losing its config.
    """
    # `enabled` is a Tier-3 field; older rule docs lack it entirely
    # (they were created before the toggle existed) and must be
    # treated as enabled by default — hence the $ne check rather than
    # $eq true.
    return await db.rules.find(
        {"company_id": cid, "enabled": {"$ne": False}}
    ).to_list(1000)


# ---------- match helpers ----------

def _match_text(op: str, haystack: str, needle: str) -> bool:
    """Case-insensitive text ops mirror the Tier-2 UI vocabulary."""
    if not haystack:
        return False
    h, n = haystack.lower(), (needle or "").lower()
    if op == "contains":     return n in h
    if op == "not_contains": return n not in h
    if op == "starts_with":  return h.startswith(n)
    if op == "ends_with":    return h.endswith(n)
    if op == "equals":       return h == n
    return False


def _match_amount(op: str, amount: float | None,
                    value: float, value_2: float | None = None) -> bool:
    if amount is None:
        return False
    if op == "gt":      return amount > value
    if op == "lt":      return amount < value
    if op == "eq":      return amount == value
    if op == "between":
        if value_2 is None:
            return False
        lo, hi = sorted([value, value_2])
        return lo <= amount <= hi
    return False


def _match_bank(cand: dict, aid: str) -> bool:
    """A rule scoped to a bank account should match on either the
    manual ledger link (`bank_account_id`) or the Plaid feed
    (`plaid_account_id`) — same OR the listing endpoint uses."""
    return (
        cand.get("bank_account_id")  == aid
        or cand.get("plaid_account_id") == aid
    )


def _match_extra(cand: dict, ec: dict) -> bool:
    field = (ec.get("field") or "").lower()
    op    = (ec.get("op") or "").lower()
    val   = ec.get("value")
    val2  = ec.get("value_2")
    if field in ("merchant", "description"):
        return _match_text(op, cand.get(field) or "", str(val or ""))
    if field == "amount":
        try:
            return _match_amount(op, float(cand.get("amount") or 0),
                                    float(val), float(val2) if val2 is not None else None)
        except (TypeError, ValueError):
            return False
    if field == "bank_account":
        return _match_bank(cand, str(val or ""))
    return False


# ---------- primary + full rule matching ----------

def _match_primary(cand: dict, rule: dict) -> bool:
    """The always-required condition on every rule."""
    field = (rule.get("match_field") or "merchant").lower()
    val   = rule.get("match_value") or ""
    if field == "contact":
        # Requires contact_id already resolved on the candidate — always
        # invoke this matcher post-contact_resolver.
        return bool(val) and cand.get("contact_id") == val
    # Default: merchant regex (icase). Rules created before the toggle
    # existed have no match_field key and fall here.
    try:
        return bool(re.search(val, cand.get("merchant") or "", re.I))
    except re.error:
        return False


def _match_tier1(cand: dict, rule: dict) -> bool:
    """Amount + bank_account conditions from Tier-1. Always AND'd on."""
    if rule.get("bank_account_id"):
        if not _match_bank(cand, rule["bank_account_id"]):
            return False
    op = (rule.get("amount_op") or "").lower()
    if op:
        try:
            v  = float(rule.get("amount_value") or 0)
            v2 = rule.get("amount_value_2")
            v2 = float(v2) if v2 is not None else None
            if not _match_amount(op, float(cand.get("amount") or 0), v, v2):
                return False
        except (TypeError, ValueError):
            return False
    return True


def rule_matches(cand: dict, rule: dict) -> bool:
    """Full match: primary + Tier-1 + Tier-2 extras (ALL/ANY)."""
    if not _match_primary(cand, rule):
        return False
    if not _match_tier1(cand, rule):
        return False
    extras = rule.get("extra_conditions") or []
    if not extras:
        return True
    logic = (rule.get("condition_logic") or "all").lower()
    if logic == "any":
        return any(_match_extra(cand, ec) for ec in extras)
    return all(_match_extra(cand, ec) for ec in extras)


def _specificity(rule: dict) -> tuple[int, int]:
    """Sort key used to break ties when multiple rules match the same row.
    (priority DESC, specificity DESC). Tier-3 `priority` field wins
    over automatic specificity so CPAs get final say on ordering."""
    score = 1
    if rule.get("bank_account_id"): score += 2
    if rule.get("amount_op"):       score += 2
    score += len(rule.get("extra_conditions") or [])
    return (int(rule.get("priority") or 0), score)


# ---------- post builder ----------

def _build_post(rule: dict, accts: Iterable[dict]) -> dict:
    """Given a matched rule, construct the same shape the Plaid/Veryfi
    pipeline builds when directory / PFC / AI decides. The insert
    step downstream reads these keys verbatim."""
    acct = next((a for a in accts if a.get("code") == rule.get("account_code")), None)
    if not acct:
        # Rule pointed at an account that no longer exists — refuse to
        # match rather than silently mis-post.
        return {}
    posting_mode = (rule.get("posting_mode") or "auto").lower()
    return {
        "category_account_id":   acct["id"],
        "category_account_code": acct["code"],
        "category_account_name": acct["name"],
        "ai_confidence": 0.99,
        "ai_reasoning": (
            f"User rule: {rule.get('match_field') or 'merchant'} "
            f"{rule.get('match_type')} '{rule.get('match_value')}' "
            f"→ {acct.get('name')}"
        ),
        "ai_source": "user_rule",
        "needs_review": posting_mode != "auto",
        "posted": posting_mode == "auto",
    }


def match_and_build_post(cand: dict, rules: list[dict], accts: list[dict]) -> dict | None:
    """Return the winning rule's post dict + side-effect extras, or
    None if no rule matched. Winner = most specific matching rule."""
    winners: list[dict] = [r for r in rules if rule_matches(cand, r)]
    if not winners:
        return None
    winners.sort(key=_specificity, reverse=True)
    rule = winners[0]
    post = _build_post(rule, accts)
    if not post:
        return None
    return {
        "rule_id":      rule["id"],
        "post":         post,
        "contact_id":   rule.get("contact_id"),
        "contact_name": rule.get("contact_name"),
        "class_id":     rule.get("class_id"),
        "class_name":   rule.get("class_name"),
        "tag_ids":      list(rule.get("tag_ids") or []),
        "splits":       list(rule.get("splits") or []),
    }


async def bump_hit(rule_id: str) -> None:
    """Fire-and-forget counter bump used by both ingest pipelines so
    the Rules dashboard `applied` column stays live."""
    await db.rules.update_one(
        {"id": rule_id},
        {"$inc": {"hits": 1}, "$set": {"updated_at": now_iso()}},
    )
