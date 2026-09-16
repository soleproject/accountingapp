"""Lab-only collection names + idempotent index setup.

Every collection here is prefixed ``lab_`` and is written to ONLY by
the lab pipeline. The live pipeline is unaware of these.

Called from ``server.py`` startup (additive, non-fatal on failure).
"""
from __future__ import annotations
import logging
from db import db

log = logging.getLogger("axiom.lab.collections")

# --- collection names (one source of truth so no typo drift) ----------
LAB_TRANSACTIONS        = "lab_transactions"
LAB_COMPANY_ACCOUNTS    = "lab_company_accounts"
LAB_RULES               = "lab_rules"
LAB_DIRECTORY_LABELS    = "lab_directory_labels"
LAB_FEEDBACK            = "lab_feedback"
LAB_LLM_CACHE           = "lab_llm_cache"
# Phase 2 additions
LAB_ENRICH_CACHE        = "lab_enrich_cache"      # Plaid /transactions/enrich response cache
LAB_CONTACTS            = "lab_contacts"          # contacts the lab would MINT but don't exist live
LAB_MERGE_SUGGESTIONS   = "lab_merge_suggestions" # name-variant merge candidates (CPA-approval only)
# Phase 3 additions
LAB_PENDING_ACCOUNTS    = "lab_pending_accounts"  # sub-accounts the lab would auto-create (CPA one-click accepts)


async def ensure_indexes() -> None:
    # lab_transactions is keyed on live txn id — one lab doc per live doc.
    await db[LAB_TRANSACTIONS].create_index(
        [("company_id", 1), ("txn_id", 1)],
        unique=True, name="uk_company_txn",
    )
    await db[LAB_TRANSACTIONS].create_index(
        [("company_id", 1), ("date", -1)], name="idx_company_date",
    )
    await db[LAB_TRANSACTIONS].create_index(
        [("company_id", 1), ("movement_type", 1)],
        name="idx_movement_type",
    )
    await db[LAB_TRANSACTIONS].create_index(
        [("company_id", 1), ("movement_pair_id", 1)],
        name="idx_movement_pair",
    )

    await db[LAB_COMPANY_ACCOUNTS].create_index(
        [("company_id", 1), ("account_key", 1)],
        unique=True, name="uk_company_account_key",
    )

    await db[LAB_RULES].create_index(
        [("company_id", 1), ("contact_id", 1), ("direction", 1)],
        unique=True, name="uk_company_contact_direction",
    )

    await db[LAB_DIRECTORY_LABELS].create_index(
        [("directory_key", 1)], unique=True, name="uk_directory_key",
    )
    await db[LAB_DIRECTORY_LABELS].create_index(
        [("status", 1)], name="idx_status",
    )

    await db[LAB_FEEDBACK].create_index(
        [("company_id", 1), ("txn_id", 1), ("created_at", -1)],
        name="idx_company_txn_created",
    )

    await db[LAB_LLM_CACHE].create_index(
        [("cache_key", 1)], unique=True, name="uk_cache_key",
    )
    # Phase 2 — enrich cache
    await db[LAB_ENRICH_CACHE].create_index(
        [("cache_key", 1)], unique=True, name="uk_enrich_cache_key",
    )
    await db[LAB_ENRICH_CACHE].create_index(
        [("company_id", 1), ("created_at", -1)], name="idx_company_created",
    )
    # Phase 2 — lab-minted contacts
    await db[LAB_CONTACTS].create_index(
        [("company_id", 1), ("normalized_name", 1)],
        unique=True, name="uk_company_normalized_name",
    )
    # Phase 2 — merge suggestions
    await db[LAB_MERGE_SUGGESTIONS].create_index(
        [("company_id", 1), ("key", 1)],
        unique=True, name="uk_company_merge_key",
    )
    # Phase 3 — pending sub-account proposals
    await db[LAB_PENDING_ACCOUNTS].create_index(
        [("company_id", 1), ("normalized_name", 1),
         ("parent_account_id", 1), ("parent_pending_id", 1)],
        name="idx_company_name_parent",
    )
    await db[LAB_PENDING_ACCOUNTS].create_index(
        [("company_id", 1), ("status", 1)], name="idx_company_status",
    )
    log.info("lab_pipeline: indexes ensured on all lab_* collections")
