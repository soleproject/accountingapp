"""Step 8 — Review reason routing (Feb-2026 SCOPE-CUT: 5 buckets ONLY).

Applied AFTER Step 6 (merchant_type) and Step 7 (category). Every
lab_transactions row ends up either ``verified=True`` OR carrying
exactly one ``review_reason`` from the fixed set:

    1. uncategorized              — no category_source found
    2. unidentified_counterparty  — checks / wires / payment apps / individuals
                                     with no known counterparty name
    3. unknown_account            — bank account or card whose status is
                                     unknown in ``lab_company_accounts``
                                     (ONCE per account)
    4. sensitive_first_time       — first transaction for a bank_lender /
                                     government / payroll contact
                                     (ONCE per contact)
    5. account_personal_use       — bank account with no personal-use
                                     answer (ONCE per account)

The `once per account/contact` de-duplication is done here by stamping
``review_card_key`` on the row so the Phase-4 card builder can group
them. All other rows auto-book (``verified = True``). NO amount-based
flags. NO refund logic. NO source_disagreement. NO category_fits
review — a low-confidence LLM pick is left as a CPA note, not a review
trigger.
"""
from __future__ import annotations
import logging

from db import db
from .collections import LAB_TRANSACTIONS, LAB_COMPANY_ACCOUNTS
from .step6_directory import SENSITIVE_MERCHANT_TYPES

log = logging.getLogger("axiom.lab.step8")

_UNIDENTIFIED_CHANNELS   = frozenset({"check", "wire"})
_INDIVIDUAL_MERCHANT_TYPES = frozenset({"individual"})


async def run_step8(company_id: str) -> dict:
    """Stamp review_reason / verified onto every lab_transactions row.
    Idempotent. Returns diagnostics."""
    settings_doc = (await db.companies.find_one(
        {"id": company_id}, {"lab_settings": 1})) or {}
    ls = settings_doc.get("lab_settings") or {}
    personal_use   = ls.get("account_used_for_personal") or {}

    # Pre-compute "unknown" outside accounts once.
    unknown_accts: set[str] = set()
    async for a in db[LAB_COMPANY_ACCOUNTS].find(
        {"company_id": company_id, "status": "unknown"},
        {"account_key": 1},
    ):
        if a.get("account_key"):
            unknown_accts.add(a["account_key"])

    # De-dup trackers.
    sensitive_seen: set[str] = set()   # contact keys already flagged
    unknown_acct_seen: set[str] = set()
    personal_use_seen: set[str] = set()

    stats = {
        "verified":  0,
        "review":    0,
        "by_reason": {},
    }

    async for row in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id},
    ).sort("date", 1):
        reason: str | None = None
        card_key: str | None = None

        # Skip movement rows entirely — they're already categorized by
        # Step 7 and never need contact/category review.
        mt = row.get("movement_type")
        cat_source = row.get("category_source")
        contact_source = row.get("contact_source")
        merchant_type = row.get("merchant_type")
        channel = row.get("channel")

        # 1. uncategorized
        if not reason and cat_source == "unresolved":
            reason   = "uncategorized"
            card_key = f"uncat::{row.get('contact') or channel or 'unknown'}"

        # 2. unidentified_counterparty — Feb-2026 fix #4: fires ONLY
        # when BOTH contact is blank AND category is unresolved AND the
        # channel is check/wire/payment_app. A blank contact alone
        # (with a valid category) auto-books.
        if not reason:
            no_contact = (contact_source == "unresolved") or not row.get("contact")
            no_category = cat_source in (None, "unresolved")
            channel_qualifies = channel in _UNIDENTIFIED_CHANNELS or channel == "payment_app"
            if no_contact and no_category and channel_qualifies:
                reason   = "unidentified_counterparty"
                card_key = f"unident::{channel}::{row.get('bank_account_id')}"

        # 3. unknown_account (once per account)
        if not reason:
            linked = row.get("linked_lab_account")
            if linked and linked in unknown_accts and linked not in unknown_acct_seen:
                unknown_acct_seen.add(linked)
                reason   = "unknown_account"
                card_key = f"unkacct::{linked}"

        # 4. sensitive_first_time (once per contact)
        if not reason and merchant_type in SENSITIVE_MERCHANT_TYPES:
            ckey = (row.get("contact") or "").strip().lower()
            if ckey and ckey not in sensitive_seen:
                sensitive_seen.add(ckey)
                reason   = "sensitive_first_time"
                card_key = f"sensfirst::{ckey}"

        # 5. account_personal_use (once per account, only if unanswered)
        if not reason and not mt:
            acct = row.get("bank_account_id")
            if acct and acct not in personal_use and acct not in personal_use_seen:
                personal_use_seen.add(acct)
                reason   = "account_personal_use"
                card_key = f"personal::{acct}"

        verified = reason is None
        await db[LAB_TRANSACTIONS].update_one(
            {"_id": row["_id"]},
            {"$set": {
                "verified":       verified,
                "review_reason":  reason,
                "review_card_key": card_key,
            }},
        )
        if verified:
            stats["verified"] += 1
        else:
            stats["review"] += 1
            stats["by_reason"][reason] = stats["by_reason"].get(reason, 0) + 1
    return stats
