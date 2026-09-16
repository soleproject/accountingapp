"""Lab pipeline per-company settings.

Read-only from live ``companies`` and ``accounts``. Never writes to
live data. Settings that the CPA / client can override live under
``companies.lab_settings`` (a NEW field, additive only — never
displaces existing keys).
"""
from __future__ import annotations
from db import db

# Platform-wide safe defaults. Every company inherits these unless
# ``companies.lab_settings`` overrides a specific key.
DEFAULTS: dict = {
    # Amount above which multi_purpose / regular purchases are
    # flagged, IF the amount is also well above the merchant's median
    # for this company (Phase 4).
    "flag_threshold_usd":               250.0,
    "typical_spend_multiplier":         3.0,
    # Per-bank-account personal-use flag. Answered via the stage-1
    # "used for personal spending?" card. Keys are ledger account ids.
    "account_used_for_personal":        {},
    # Transfer-pair matching window (days) — copied from live behavior
    # but exposed so a CPA could tighten it.
    "transfer_pair_window_days":        3,
    "card_payment_window_days":         5,
    # Low-confidence equal-amount pairs (no transfer language on
    # either leg, no matching last-4) — still flagged but not
    # auto-verified.
    "low_confidence_pair_max_amt_usd":  25_000.0,
}


async def get_settings(company_id: str) -> dict:
    doc = await db.companies.find_one(
        {"id": company_id}, {"lab_settings": 1}
    ) or {}
    stored = doc.get("lab_settings") or {}
    return {**DEFAULTS, **stored}


async def is_lab_enabled(company_id: str) -> bool:
    """Read the per-company ``features.lab_pipeline_v3`` flag."""
    doc = await db.companies.find_one({"id": company_id}, {"features": 1}) or {}
    return bool((doc.get("features") or {}).get("lab_pipeline_v3", False))
