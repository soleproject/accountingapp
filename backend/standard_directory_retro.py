"""Retroactive Global Contact Directory sweep for Standard mode.

Purpose
    Applies the 5,221-entry Global Contact Directory to a company's
    EXISTING transactions. Fills the gap that opened when the
    directory was introduced: rows ingested before the directory
    existed carry no `category_hint_semantic`, so this pass looks
    them up now via the contact/merchant string and applies the
    linked semantic if the resolver finds a matching account on the
    company's actual CoA (name-first).

    Runs on ANY company regardless of `categorization_mode` (both
    Standard and Standard+ tenants benefit — the ingest-time tier
    only helps NEW rows).

Priority guard
    Preserves the same tenant-first priority stack as the ingest
    cascade:
      - Never overrides rows sourced from `rule`, `memory`, `user`,
        `human_reviewed`, or `standard_plus_rule` (tenant rules or
        higher-priority curated tier already spoke).
      - Never overrides PFC-primary rows (those were resolved with
        high confidence at ingest via a tenant PFC override).
    Only rewrites rows whose current source is `ai`, `llm`,
    `uncategorized`, `directory` (idempotent re-sweep), or missing.

Return value
    Same shape as `standard_plus_categorizer.apply_global_rules_override`
    so the UI can render both counters identically.
"""
from __future__ import annotations
import logging
from typing import Optional

from db import db, now_iso
import global_contact_directory
import global_vendor_rules

log = logging.getLogger("axiom.standard_directory")


# Sources whose categorization we're allowed to overwrite.  Everything
# else is either tenant-owned or already carrying a stronger signal.
_OVERRIDABLE_SOURCES = {
    "ai", "llm", "uncategorized", "directory", None, "",
}


async def apply_directory_to_existing(
    company_id: str,
    transaction_ids: Optional[list[str]] = None,
) -> dict:
    """Sweep the directory over existing rows.  Returns a stats dict.

    Args:
        company_id: which tenant to sweep.
        transaction_ids: optional filter — when omitted, every txn on
            the company is scanned.

    Returns:
        {
          "scanned":                total rows we looked at,
          "matched":                rows the directory identified,
          "overridden":             rows we actually rewrote,
          "skipped_tenant_priority": rows we left alone due to source,
          "skipped_no_hint":        rows the directory didn't match,
          "skipped_no_account":     hint resolved but no matching CoA
                                    account (e.g. food_cogs on SaaS CoA),
          "skipped_same_answer":    directory answer matched current
                                    posting — no update needed,
        }
    """
    company = await db.companies.find_one({"id": company_id})
    if not company:
        return {"error": "company not found"}
    template = company.get("industry_template") or "generic"

    # Load CoA once — the name-first resolver walks it per row.
    accounts = await db.accounts.find({"company_id": company_id}).to_list(500)
    # Load contact lookup: id → doc (for linked_semantic on legacy rows).
    contacts_by_id = {}
    async for c in db.contacts.find({"company_id": company_id}):
        contacts_by_id[c["id"]] = c

    # Row filter — either the caller-supplied list or the whole book.
    query: dict = {"company_id": company_id}
    if transaction_ids:
        query["id"] = {"$in": transaction_ids}
    rows = await db.transactions.find(query).to_list(1_000_000)

    stats = {
        "scanned": len(rows), "matched": 0, "overridden": 0,
        "skipped_tenant_priority": 0, "skipped_no_hint": 0,
        "skipped_no_account": 0, "skipped_same_answer": 0,
    }

    for t in rows:
        # ---- Tenant-priority guard --------------------------------------
        src = t.get("ai_source")
        if src not in _OVERRIDABLE_SOURCES:
            stats["skipped_tenant_priority"] += 1
            continue
        # Also skip standard_plus_rule / standard_plus_directory rows —
        # those already ran through the same or a higher tier.
        cat_src = t.get("categorization_source")
        if cat_src in ("standard_plus_rule", "standard_plus_directory"):
            stats["skipped_tenant_priority"] += 1
            continue

        # ---- Find the hint -----------------------------------------------
        # 1. Already stamped on the row (ingest-time directory hit).
        hint = t.get("category_hint_semantic")
        # 2. Fall back to the contact's linked_semantic (set at contact
        #    creation via directory hit).
        if not hint:
            cid = t.get("contact_id")
            if cid and cid in contacts_by_id:
                hint = contacts_by_id[cid].get("linked_semantic")
        # 3. Last chance — look up the directory directly against the
        #    merchant / description string.  Covers rows whose contacts
        #    predate the directory entirely.
        gd_hit = None
        if not hint:
            text = (t.get("merchant") or t.get("merchant_name")
                    or t.get("description") or "")
            gd_hit = global_contact_directory.lookup(text)
            if gd_hit:
                hint = gd_hit["semantic"]

        if not hint:
            stats["skipped_no_hint"] += 1
            continue
        stats["matched"] += 1

        # ---- Resolve semantic -> account on THIS CoA --------------------
        acct = global_vendor_rules.resolve_semantic_to_account(
            hint, accounts, template,
        )
        if not acct:
            stats["skipped_no_account"] += 1
            continue

        # ---- Idempotent short-circuit -----------------------------------
        if t.get("category_account_id") == acct.get("id"):
            stats["skipped_same_answer"] += 1
            continue

        # ---- Apply ------------------------------------------------------
        update_fields = {
            "category_account_id":   acct.get("id"),
            "category_account_code": acct.get("code"),
            "category_account_name": acct.get("name"),
            "ai_source": "directory",
            "ai_confidence": 0.85,
            "ai_reasoning": (
                f"Retroactive directory sweep → semantic '{hint}' → "
                f"account '{acct.get('name')}'"
            ),
            "needs_review": False,
            "categorization_source": "standard_directory_retro",
            # Stamp the hint fields so future re-sweeps recognise this
            # row was directory-driven.
            "category_hint_semantic": hint,
            "category_hint_source":   "global_directory",
            "updated_at": now_iso(),
        }
        # If we resolved via a fresh directory lookup, also backfill
        # the contact's linked_semantic + logo so future ingests
        # don't have to re-lookup.
        if gd_hit and t.get("contact_id") and t["contact_id"] in contacts_by_id:
            contact = contacts_by_id[t["contact_id"]]
            if not contact.get("linked_semantic"):
                await db.contacts.update_one(
                    {"id": t["contact_id"], "company_id": company_id},
                    {"$set": {
                        "linked_semantic": gd_hit["semantic"],
                        "logo_url": contact.get("logo_url")
                                    or global_contact_directory.logo_url_for(gd_hit),
                        "updated_at": now_iso(),
                    }},
                )
        await db.transactions.update_one(
            {"id": t["id"]}, {"$set": update_fields},
        )
        stats["overridden"] += 1

    log.info("Retroactive directory sweep cid=%s: %s", company_id, stats)
    return stats
