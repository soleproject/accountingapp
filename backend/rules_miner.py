"""Rules miner — infer categorization rules from historical transactions.

QBO doesn't expose Bank Rules via any public API, so we can't migrate
the accountant's actual rule set. Instead we mine the *outcome* of
those rules — every posted transaction on the ledger — and codify the
patterns as our own rules. This works for QBO-migrated, Plaid-imported,
and native-created ledgers alike.

Algorithm (default thresholds, tunable per caller):
  1. Group every transaction that has BOTH a `merchant` and a
     `category_account_code` set.
  2. For each unique `merchant`, count how many times each category
     was used and pick the majority.
  3. Surface as a `rule_candidate` when:
        * total hits ≥ ``min_hits`` (default 3), AND
        * majority share ≥ ``min_confidence`` (default 0.90).
  4. **Auto-apply** — skip the candidate step entirely and drop a real
     rule into ``db.rules`` when:
        * total hits ≥ ``auto_apply_min_hits`` (default 10), AND
        * majority share ≥ ``auto_apply_min_confidence`` (default 0.98).
     Audit-logged so the pro can find them on the Rules page under
     ``created_by == "ai_miner"``.

Idempotent — safe to re-run. Never touches an existing rule; if a rule
already exists for the same ``(merchant, account_code)`` pair the
miner emits neither a candidate nor an auto-rule.

Feb 28 2026 — ships as the QBO Bank Rules substitute discussed in the
Aug 23 planning thread (Option 1: infer from history).
"""
from __future__ import annotations

import re
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from db import db


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_merchant(raw: str) -> str:
    """Lowercase, strip trailing numerics + whitespace, collapse spaces.

    Handles POS payload noise like ``"Starbucks #4712"`` and
    ``"AMZN Mktp US*8F0K3"`` — both fold to ``"starbucks"`` and
    ``"amzn mktp us"`` respectively so we don't fragment the pattern
    across 1000 slightly-different merchant strings.
    """
    s = (raw or "").strip().lower()
    # Chop trailing store numbers / txn ids: "starbucks #4712" -> "starbucks"
    s = re.sub(r"[\s#*\-]+[a-z0-9]{2,}$", "", s)
    # Collapse whitespace.
    s = re.sub(r"\s+", " ", s).strip()
    return s


async def mine_rule_candidates(
    company_id: str,
    *,
    min_hits: int = 3,
    min_confidence: float = 0.90,
    auto_apply_min_hits: int = 10,
    auto_apply_min_confidence: float = 0.98,
) -> dict[str, int]:
    """Mine one company's ledger for rule patterns.

    Returns a dict of counts::

        {
            "scanned":       <total txns considered>,
            "clusters":      <unique merchants>,
            "candidates":    <suggestions surfaced>,
            "auto_applied":  <rules created directly>,
            "skipped_existing": <clusters already covered by a rule>,
        }
    """
    # Pull both native (`merchant` + `category_account_code`) and QBO
    # (`contact_name` + `category_account_id`) schemas. Fall back
    # gracefully — a txn with neither payee nor category can't teach
    # us anything, so it's excluded downstream.
    cursor = db.transactions.find(
        {"company_id": company_id},
        {"_id": 0, "id": 1,
         "merchant": 1, "contact_name": 1,
         "category_account_code": 1, "category_account_id": 1,
         "category_account_name": 1},
    )

    # Load CoA once so we can resolve `category_account_id -> code` for
    # QBO-imported rows (which have `code` empty).
    accounts = await db.accounts.find(
        {"company_id": company_id},
        {"_id": 0, "id": 1, "code": 1, "name": 1, "detail_type": 1},
    ).to_list(1000)
    acct_by_id = {a["id"]: a for a in accounts if a.get("id")}
    acct_by_code = {a["code"]: a for a in accounts if a.get("code")}
    # Blocklist: never learn rules that route to holding-pen or
    # customer-check-workflow accounts. Rules that target these would
    # codify the exact miscategorization we just fixed on Plaid Test LLC
    # (WF→BOA deposits routed to Undeposited Funds). Feb 28 2026.
    _BLOCKED_CODES = {"4999", "6999"}  # Uncategorized Income / Expense
    _BLOCKED_DETAIL_TYPES = {"money_in_transit"}
    def _code_is_blocked(code: str) -> bool:
        if code in _BLOCKED_CODES:
            return True
        a = acct_by_code.get(code) or {}
        return (a.get("detail_type") or "").lower() in _BLOCKED_DETAIL_TYPES

    # merchant_key -> Counter({account_code: hits})
    tallies: dict[str, Counter] = defaultdict(Counter)
    # merchant_key -> raw display merchant (first seen)
    display_by_key: dict[str, str] = {}
    # merchant_key -> {account_code: account_name}
    name_by_pair: dict[tuple[str, str], str] = {}
    scanned = 0
    async for t in cursor:
        # Payee: prefer explicit merchant; fall back to contact_name
        raw = (t.get("merchant") or t.get("contact_name") or "").strip()
        key = _normalize_merchant(raw)
        if not key:
            continue
        # Category: prefer explicit code; fall back to id -> code lookup
        code = t.get("category_account_code") or ""
        if not code:
            aid = t.get("category_account_id") or ""
            a = acct_by_id.get(aid) if aid else None
            code = (a or {}).get("code") or ""
        if not code:
            continue
        tallies[key][code] += 1
        display_by_key.setdefault(key, raw)
        name_by_pair[(key, code)] = (
            t.get("category_account_name")
            or name_by_pair.get((key, code)) or "")
        scanned += 1

    # Load existing rules + candidates so the miner is idempotent.
    existing_rule_keys = set()
    async for r in db.rules.find({"company_id": company_id},
                                  {"_id": 0, "match_value": 1,
                                   "account_code": 1}):
        mv = _normalize_merchant(r.get("match_value") or "")
        ac = r.get("account_code") or ""
        if mv and ac:
            existing_rule_keys.add((mv, ac))

    existing_candidate_keys = set()
    async for c in db.rule_candidates.find(
        {"company_id": company_id}, {"_id": 0, "key": 1},
    ):
        existing_candidate_keys.add(c.get("key") or "")

    candidates_added = 0
    auto_applied = 0
    skipped_existing = 0

    for key, counter in tallies.items():
        if not counter:
            continue
        top_code, top_hits = counter.most_common(1)[0]
        total = sum(counter.values())
        conf = top_hits / total if total else 0
        if top_hits < min_hits or conf < min_confidence:
            continue
        # Blocked target: skip so we never learn a rule that routes to
        # Undeposited Funds / Uncategorized. See _code_is_blocked() +
        # ``merchant_cache.categorize_with_cache`` deposit guard.
        if _code_is_blocked(top_code):
            continue
        # Skip if a rule already exists for this exact pair.
        if (key, top_code) in existing_rule_keys:
            skipped_existing += 1
            continue

        display_merchant = display_by_key.get(key, key)
        acct = acct_by_code.get(top_code)
        if not acct:
            # Category code no longer on the CoA (e.g., renamed) —
            # can't safely emit either a rule or a candidate.
            continue
        acct_name = (name_by_pair.get((key, top_code))
                     or acct.get("name") or "")

        auto_ok = (
            top_hits >= auto_apply_min_hits
            and conf >= auto_apply_min_confidence
        )

        if auto_ok:
            # Promote directly to a real rule. `hits` = historical
            # count so the pro sees "12 txns matched" on the Rules
            # page immediately.
            await db.rules.insert_one({
                "id": str(uuid.uuid4()),
                "company_id": company_id,
                "match_type": "merchant_contains",
                "match_value": display_merchant,
                "account_code": top_code,
                "account_name": acct_name,
                "created_by": "ai_miner",
                "hits": top_hits,
                "mined_confidence": round(conf, 4),
                "mined_at": _now_iso(),
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            })
            auto_applied += 1
            existing_rule_keys.add((key, top_code))
            # If a stale candidate exists for the same pair, purge it.
            await db.rule_candidates.delete_many({
                "company_id": company_id,
                "key": f"{display_merchant}::{top_code}",
            })
            continue

        # Otherwise surface as a candidate. Use display merchant in the
        # composite key so it matches the manual-approval pipeline that
        # already writes `{merchant}::{account_code}`.
        candidate_key = f"{display_merchant}::{top_code}"
        if candidate_key in existing_candidate_keys:
            # Manual pipeline already tracked this — bump approvals so
            # the historical evidence is reflected.
            await db.rule_candidates.update_one(
                {"company_id": company_id, "key": candidate_key},
                {"$max": {"approvals": top_hits}},
            )
            continue

        await db.rule_candidates.insert_one({
            "id": str(uuid.uuid4()),
            "company_id": company_id,
            "key": candidate_key,
            "merchant": display_merchant,
            "account_code": top_code,
            "account_name": acct_name,
            "approvals": top_hits,
            "mined_confidence": round(conf, 4),
            "source": "miner",
            "created_at": _now_iso(),
        })
        candidates_added += 1

    return {
        "scanned": scanned,
        "clusters": len(tallies),
        "candidates": candidates_added,
        "auto_applied": auto_applied,
        "skipped_existing": skipped_existing,
    }
