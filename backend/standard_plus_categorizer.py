"""Standard+ Beta categorization enhancement (Feb 2026).

Runs as a POST-HOOK after the standard cascade finishes and BEFORE the
existing `detect_transfer_pairs` runs. For each just-inserted txn, we
consult the curated Global Vendor Rules library (485 merchants in v1)
and — if a rule matches with high enough confidence — override the
category the standard cascade picked.

Design guardrails (per product decision):
    * Standard cascade code is 100% untouched. This module only reads
      the rows Standard just inserted and issues `update_one` on any
      that got a better Global Rules match.
    * Only overrides the category. Contact matching (`contact_id`),
      `ai_confidence`, and `ai_reasoning` from the standard cascade are
      preserved — Global Rules only speak to category selection.
    * Uses the tri-state confidence gate identical to AI-First:
        rule_conf >= 0.75 → apply, needs_review = False
        0.50 <= rule_conf < 0.75 → apply, needs_review = True
        rule_conf < 0.50 → don't override (Standard's answer stands)
    * Falls back silently on any error — never blocks the sync.

Linked Transactions (inter-account transfer detection) already runs via
`routes.transactions.detect_transfer_pairs` post-sync, so we don't
duplicate that here.

Phase 2 will add: Plaid PFC → CoA mapping, MCC cross-reference,
industry-specific overrides, and vector-similarity fallback.
"""
from __future__ import annotations
import logging

from db import db, now_iso
import global_vendor_rules
import pfc_semantic_map

log = logging.getLogger(__name__)

_HIGH_CONFIDENCE = 0.75
_MIN_CONFIDENCE = 0.50


async def apply_global_rules_override(
    company_id: str, inserted_txn_ids: list[str],
) -> dict:
    """Consult Global Vendor Rules for each just-inserted row and
    override the category on any high-confidence match.

    Args:
        company_id: which company we're categorizing for
        inserted_txn_ids: the txn IDs that were just inserted by the
            standard cascade — we only touch these.

    Returns:
        Summary dict: {matched, overridden, review_flagged, skipped}
    """
    if not inserted_txn_ids:
        return {"matched": 0, "overridden": 0, "review_flagged": 0, "skipped": 0}

    company = await db.companies.find_one({"id": company_id})
    if not company:
        return {"matched": 0, "overridden": 0, "review_flagged": 0, "skipped": 0}

    template = company.get("industry_template") or "generic"

    # Load the CoA once so we can resolve semantic → account in one
    # pass. We resolve by NAME first (via `SEMANTIC_TO_NAME_PATTERNS`
    # in global_vendor_rules) and fall back to CODE only when no
    # account name matches. This is defensive against custom CoAs
    # where a template's canonical code (e.g., 6400 = Meals in the
    # generic template) got reassigned to a different name (e.g.,
    # 6400 = Insurance on a custom Chart of Accounts).
    accounts = await db.accounts.find({"company_id": company_id}).to_list(500)

    # Pull just the rows Standard just inserted.
    rows = await db.transactions.find(
        {"id": {"$in": inserted_txn_ids}, "company_id": company_id},
    ).to_list(len(inserted_txn_ids))

    stats = {"matched": 0, "overridden": 0, "review_flagged": 0, "skipped": 0,
             "matched_via_rule": 0, "matched_via_pfc": 0,
             "skipped_tenant_priority": 0}
    for t in rows:
        # Respect per-tenant categorizations. If Standard's cascade
        # already applied a customer-specific rule OR a hit from the
        # customer's own merchant memory, DON'T override — those tiers
        # sit above Global Rules in the priority stack:
        #   Tenant Custom Rule > Tenant Rules Miner > Tenant Merchant Cache
        #     > Global 485 (this file) > Plaid PFC > LLM fallback
        # Standard writes `ai_source` on each row; "rule" = per-tenant
        # rule fired, "memory" = per-tenant merchant-cache hit.
        tenant_source = t.get("ai_source")
        if tenant_source in ("rule", "memory"):
            stats["skipped_tenant_priority"] += 1
            continue

        # Try merchant first, description second — same fallback order
        # as Standard's own PFC step.
        text = (t.get("merchant") or t.get("merchant_name")
                or t.get("description") or "").strip()
        # Pass amount so amount-bucket rules (Costco/Walmart/Amazon/
        # Home Depot etc.) resolve to the right semantic per bucket.
        match = global_vendor_rules.match_and_resolve(
            text, template, amount=t.get("amount"),
        )
        match_source = "rule"

        # Stage 2 — Plaid PFC fallback. Every Plaid txn carries a
        # `personal_finance_category.detailed` string (~104 canonical
        # categories). Our ingest flattens it to `pfc_detailed` on the
        # txn doc. If Global Rules didn't match a specific merchant,
        # PFC gives us broad coverage on unknown vendors.
        if not match:
            pfc_detailed = t.get("pfc_detailed")
            # Plaid's confidence_level isn't currently persisted at
            # ingest — treat as UNKNOWN (0.65) which will apply the
            # category and flag needs_review (medium tier).
            plaid_conf = t.get("pfc_confidence_level") or "UNKNOWN"
            pfc_hit = pfc_semantic_map.resolve_pfc(pfc_detailed, plaid_conf)
            if pfc_hit:
                account_code = global_vendor_rules.resolve_semantic(
                    pfc_hit["semantic"], template,
                )
                if account_code:
                    match = {
                        "pattern": f"PFC:{pfc_hit['pfc_detailed']}",
                        "semantic": pfc_hit["semantic"],
                        "account_code": account_code,
                        "confidence": pfc_hit["confidence"],
                        "notes": f"Plaid PFC {plaid_conf}",
                    }
                    match_source = "pfc"

        if not match:
            stats["skipped"] += 1
            continue

        stats["matched"] += 1
        if match_source == "rule":
            stats["matched_via_rule"] += 1
        else:
            stats["matched_via_pfc"] += 1

        rule_conf = float(match.get("confidence") or 0.0)

        # Tri-state: below MIN, don't override — Standard's answer stands.
        if rule_conf < _MIN_CONFIDENCE:
            stats["skipped"] += 1
            continue

        acct = global_vendor_rules.resolve_semantic_to_account(
            match["semantic"], accounts, template,
        )
        if not acct:
            # Neither name nor code matched an account on this
            # company's CoA (rare — e.g., food_cogs on a SaaS shop).
            # Skip so Standard's answer stands.
            stats["skipped"] += 1
            continue

        needs_review = rule_conf < _HIGH_CONFIDENCE
        set_fields = {
            "category_account_id": acct.get("id"),
            "category_account_code": acct.get("code"),
            "category_account_name": acct.get("name"),
            "needs_review": needs_review,
            "categorization_source": (
                "standard_plus_rule" if match_source == "rule"
                else "standard_plus_pfc"
            ),
            "rule_matched": match["pattern"],
            "rule_semantic": match["semantic"],
            "rule_confidence": rule_conf,
            "updated_at": now_iso(),
        }
        await db.transactions.update_one(
            {"id": t["id"]}, {"$set": set_fields},
        )
        stats["overridden"] += 1
        if needs_review:
            stats["review_flagged"] += 1

    log.info("Standard+ override cid=%s: %s", company_id, stats)
    return stats
