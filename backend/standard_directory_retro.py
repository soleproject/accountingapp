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
# NOTE: pfc_primary / pfc_business ARE overridable because the directory
# (canonical merchant identity) beats Plaid PFC (fuzzy category mapping).
_OVERRIDABLE_SOURCES = {
    "ai", "llm", "uncategorized", "directory",
    "pfc_primary", "pfc_business", "pfc_default", "pfc_personal",
    None, "",
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
    # Rows we revert via identity_only get queued for AI contact
    # re-resolution at the end of the sweep — one LLM pass extracts the
    # real payee (Andrew Chesnutt) out of "Zelle Andrew Chesnutt ZELLE
    # DEBIT" and swaps in the real-person contact.
    identity_only_reverts: list[dict] = []

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
                # identity_only entries (Zelle/Venmo/PayPal/etc.) never
                # provide a category hint — the payment channel says
                # nothing about what the underlying spend is.
                if gd_hit.get("identity_only"):
                    gd_hit = None
                else:
                    hint = gd_hit["semantic"]

        # ---- Revert legacy identity_only categorizations ----------------
        # Rows that got auto-categorized to inter_account_transfer via a
        # payment channel (Zelle/Venmo/PayPal) BEFORE the identity_only
        # flag existed — flip them back to Uncategorized so the CPA can
        # decide (owner draw? contractor? reimbursement?).
        if (t.get("ai_source") == "directory"
                and t.get("category_hint_source") == "global_directory"):
            current_hint = t.get("category_hint_semantic")
            # Look the merchant up NOW — if the directory would treat
            # it as identity_only today, revert.
            text = (t.get("merchant") or t.get("merchant_name")
                    or t.get("description") or "")
            live_hit = global_contact_directory.lookup(text)
            if live_hit and live_hit.get("identity_only"):
                # Find/create Uncategorized on this CoA (defensive — most
                # CoAs have code 6999 for it).
                unc = next(
                    (a for a in accounts if a.get("code") in ("6999", "9999")
                     or "uncategorized" in (a.get("name") or "").lower()),
                    None,
                )
                if unc:
                    await db.transactions.update_one(
                        {"id": t["id"]},
                        {"$set": {
                            "category_account_id":   unc["id"],
                            "category_account_code": unc.get("code"),
                            "category_account_name": unc.get("name"),
                            "ai_source": "uncategorized",
                            "needs_review": True,
                            "ai_reasoning": (
                                "Reverted from payment-channel category "
                                "(Zelle/Venmo/PayPal directory hit is identity-only "
                                "— category needs human review)"
                            ),
                            "categorization_source": "identity_only_reverted",
                            "updated_at": now_iso(),
                        },
                         "$unset": {
                             "category_hint_semantic": "",
                             "category_hint_source": "",
                        }},
                    )
                    stats["overridden"] += 1
                    stats.setdefault("reverted_identity_only", 0)
                    stats["reverted_identity_only"] += 1
                    # Queue for AI contact re-resolution below.
                    identity_only_reverts.append(t)
                continue

        if not hint:
            # Even if no category hint fires, check whether this row is
            # stuck on a payment-channel umbrella contact (Zelle/Venmo/
            # PayPal/etc.) — those need the AI heal to extract the real
            # payee. This catches rows reverted on a PREVIOUS sweep run
            # whose category was flipped but whose contact was never
            # re-resolved.
            _cname = (t.get("contact_name") or "").strip()
            if _cname in {"Zelle", "Venmo", "PayPal", "Cash App", "Wise",
                          "Apple Cash", "Google Pay", "Apple Pay"}:
                identity_only_reverts.append(t)
            stats["skipped_no_hint"] += 1
            continue
        stats["matched"] += 1

        # ---- Resolve semantic -> account on THIS CoA --------------------
        acct = global_vendor_rules.resolve_semantic_to_account(
            hint, accounts, template,
        )
        if not acct:
            # Fall back to canonical-account auto-creation. Every semantic
            # in our allowlist has a GAAP-clean canonical account defined
            # in `canonical_semantic_accounts`. Creating on first hit is
            # the user's chosen policy — see chat spec.
            import canonical_semantic_accounts
            acct = await canonical_semantic_accounts.ensure_semantic_account(
                db, company_id, hint, template,
            )
            if acct:
                # Update our local snapshot so subsequent rows in this
                # sweep reuse the newly-created account.
                accounts.append(acct)
                stats.setdefault("auto_created_accounts", 0)
                stats["auto_created_accounts"] += 1
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

    # ---- AI Contact Heal for identity-only reverts -----------------
    # After the category revert loop above, any row we flagged came
    # from a payment channel where the real payee is buried in the
    # memo. Run contact_resolver's AI path over them to swap in the
    # real-person contact. Batched with concurrency=8 so we don't
    # serialize 90 Haiku calls.
    if identity_only_reverts:
        import contact_resolver, ai_service, asyncio as _asyncio
        stats["contacts_reresolved"] = 0
        stats["contacts_created"] = 0
        # Fresh snapshot — we may have created a bunch of new contacts
        # earlier in this sweep too.
        existing_contacts = await db.contacts.find(
            {"company_id": company_id},
        ).to_list(5000)
        by_norm = {c.get("normalized_name"): c for c in existing_contacts}
        # In-batch dedupe so 90 Andrew Chesnutt rows all share one
        # newly-minted contact.
        new_this_batch: dict[str, dict] = {}
        sem = _asyncio.Semaphore(8)

        async def _heal_one(t):
            async with sem:
                desc = t.get("description") or t.get("memo") or t.get("merchant") or ""
                # Learning cache check (same helper contact_resolver
                # uses) before hitting the LLM.
                sig = contact_resolver._cache_signature(desc)
                cached_hit = await contact_resolver._lookup_learning_cache(company_id, sig)
                ai_result = None
                if cached_hit and cached_hit.get("contact_id"):
                    ai_result = {"contact_id": cached_hit["contact_id"],
                                  "contact_name": cached_hit.get("contact_name")}
                if not ai_result:
                    r = await ai_service.resolve_contact_ai(
                        desc, existing_contacts, pfc_primary=None,
                    )
                    if not r.get("has_counterparty") or not r.get("extracted_name"):
                        return
                    if r.get("match_existing_id"):
                        m = next((c for c in existing_contacts
                                  if c["id"] == r["match_existing_id"]), None)
                        if m:
                            ai_result = {"contact_id": m["id"],
                                          "contact_name": m["name"]}
                        else:
                            return
                    else:
                        name = r["extracted_name"].strip()
                        norm = contact_resolver.normalize_contact_name(name)
                        if norm in by_norm:
                            m = by_norm[norm]
                            ai_result = {"contact_id": m["id"], "contact_name": m["name"]}
                        elif norm in new_this_batch:
                            m = new_this_batch[norm]
                            ai_result = {"contact_id": m["id"], "contact_name": m["name"]}
                        else:
                            created = await contact_resolver._insert_contact(
                                company_id, name, source="ai_new",
                            )
                            new_this_batch[norm] = created
                            stats["contacts_created"] += 1
                            ai_result = {"contact_id": created["id"],
                                          "contact_name": created["name"]}
                    await contact_resolver._save_to_learning_cache(
                        company_id, sig,
                        ai_result["contact_id"], ai_result["contact_name"],
                    )

                if ai_result.get("contact_id"):
                    await db.transactions.update_one(
                        {"id": t["id"]},
                        {"$set": {
                            "contact_id":     ai_result["contact_id"],
                            "contact_name":   ai_result["contact_name"],
                            "contact_source": "ai_new_heal",
                            "updated_at": now_iso(),
                        }},
                    )
                    stats["contacts_reresolved"] += 1

        await _asyncio.gather(*(_heal_one(t) for t in identity_only_reverts),
                               return_exceptions=True)

    log.info("Retroactive directory sweep cid=%s: %s", company_id, stats)
    return stats
