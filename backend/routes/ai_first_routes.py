"""Categorization mode routes: industry templates, mode toggle
(Standard | Standard+), and Standard+ retroactive apply."""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from db import db, now_iso
from auth import get_current_user
from deps import require_company
import industry_templates

router = APIRouter(prefix="/api")


@router.get("/industry-templates")
async def list_industry_templates(user: dict = Depends(get_current_user)) -> dict:
    return {"templates": industry_templates.list_templates()}


async def _accounts_in_use(cid: str, account_ids: list[str]) -> set[str]:
    """Return the subset of `account_ids` that are referenced by at
    least one transaction (category/bank), journal-entry line, or
    rule on this company. Used as a safety guard before deleting
    industry-seeded accounts on an onboarding template switch.
    """
    if not account_ids:
        return set()
    id_set = set(account_ids)
    used: set[str] = set()

    # Transactions: category or bank side.
    async for t in db.transactions.find(
        {"company_id": cid,
         "$or": [{"category_account_id": {"$in": list(id_set)}},
                 {"bank_account_id": {"$in": list(id_set)}}]},
        projection={"category_account_id": 1, "bank_account_id": 1},
    ):
        if t.get("category_account_id") in id_set:
            used.add(t["category_account_id"])
        if t.get("bank_account_id") in id_set:
            used.add(t["bank_account_id"])

    # Journal entries (any line referencing any of these accounts).
    async for je in db.journal_entries.find(
        {"company_id": cid, "lines.account_id": {"$in": list(id_set)}},
        projection={"lines.account_id": 1},
    ):
        for ln in (je.get("lines") or []):
            aid = ln.get("account_id")
            if aid in id_set:
                used.add(aid)

    # Rules: keyed by code, not id — look up which of our ids share
    # a code with any existing rule.
    id_to_code = {a["id"]: a["code"] async for a in db.accounts.find(
        {"company_id": cid, "id": {"$in": list(id_set)}},
        projection={"id": 1, "code": 1},
    )}
    codes_in_use = set()
    async for r in db.rules.find(
        {"company_id": cid, "account_code": {"$in": list(id_to_code.values())}},
        projection={"account_code": 1},
    ):
        if r.get("account_code"):
            codes_in_use.add(r["account_code"])
    for aid, code in id_to_code.items():
        if code in codes_in_use:
            used.add(aid)

    return used


@router.post("/companies/{cid}/industry-template")
async def set_industry_template(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    """Set (or change) the company's industry template.

    Behaviour:
      * `dry_run=true`  → returns a preview: which accounts WOULD be added
        for the new template, and which OLD industry-specific accounts
        are safe to remove (no txn/JE/rule references). No writes.
      * `dry_run=false` (default) + `confirm_cleanup=false` → additive
        only. Seeds missing accounts. Leaves any old-industry accounts
        alone. Backwards-compatible with the pre-Feb-2026 behaviour.
      * `dry_run=false` + `confirm_cleanup=true` → seeds missing new
        accounts AND removes safely-orphaned old-industry accounts
        (stamped `seeded_by_industry=<old_slug>` and not referenced
        anywhere). Manually-added or referenced accounts are never
        touched.

    Every account inserted or (retro-)claimed by a template gets a
    `seeded_by_industry=<slug>` provenance stamp so future switches
    can distinguish template-seeded rows from manually-added ones.
    """
    await require_company(user, cid)
    slug = (payload.get("template") or "").strip()
    tpl = industry_templates.get_template(slug)
    if not tpl:
        raise HTTPException(400, f"Unknown template: {slug!r}")
    dry_run = bool(payload.get("dry_run", False))
    confirm_cleanup = bool(payload.get("confirm_cleanup", False))

    company = await db.companies.find_one({"id": cid}) or {}
    old_slug = company.get("industry_template")

    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    existing_by_code = {a.get("code"): a for a in existing}

    # New accounts to seed (in new template, not currently on the CoA).
    to_insert_preview = [
        {"code": a["code"], "name": a["name"], "type": a.get("type", "")}
        for a in tpl["accounts"] if a["code"] not in existing_by_code
    ]

    # Candidate old-industry accounts to remove — codes that were
    # unique to the OLD industry AND aren't in the NEW template.
    # Guard: STRICTLY only include accounts explicitly stamped with
    # `seeded_by_industry == old_slug`. Un-stamped rows (whether truly
    # manual or legacy pre-provenance) are treated as manual and left
    # alone. Legacy companies can opt in by re-saving the same
    # template (which retro-stamps matching rows).
    remove_candidates: list[dict] = []
    if old_slug and old_slug != slug:
        old_only = industry_templates.industry_only_codes(old_slug)
        new_codes = industry_templates.template_codes(slug)
        cleanup_codes = old_only - new_codes
        for code in cleanup_codes:
            acct = existing_by_code.get(code)
            if not acct:
                continue
            if acct.get("seeded_by_industry") != old_slug:
                continue  # manual / legacy / different-industry row
            remove_candidates.append(acct)

    # Split candidates into safe-to-remove vs blocked (in use).
    candidate_ids = [a["id"] for a in remove_candidates]
    in_use = await _accounts_in_use(cid, candidate_ids)
    safe_remove = [a for a in remove_candidates if a["id"] not in in_use]
    blocked_remove = [a for a in remove_candidates if a["id"] in in_use]

    preview = {
        "template": slug,
        "old_template": old_slug,
        "dry_run": dry_run,
        "would_add": to_insert_preview,
        "would_remove": [
            {"id": a["id"], "code": a["code"], "name": a["name"],
             "type": a.get("type", ""), "seeded_by_industry": a.get("seeded_by_industry")}
            for a in safe_remove
        ],
        "blocked_remove": [
            {"id": a["id"], "code": a["code"], "name": a["name"],
             "type": a.get("type", ""), "reason": "in_use"}
            for a in blocked_remove
        ],
    }
    if dry_run:
        return {"ok": True, **preview}

    # ---------------- Writes ------------------
    now = now_iso()

    # Remove safe orphans if cleanup was confirmed.
    removed_ids: list[str] = []
    if confirm_cleanup and safe_remove:
        removed_ids = [a["id"] for a in safe_remove]
        await db.accounts.delete_many(
            {"company_id": cid, "id": {"$in": removed_ids}},
        )

    # Insert every missing new-template account, stamped with provenance.
    # Note: `remove_candidates` (and thus `removed_ids`) are drawn from
    # `old_only - new_codes`, so by construction none of the removed
    # codes overlap the new template. A simple "if code already exists,
    # skip" check is therefore sufficient.
    to_insert = []
    template_codes_set = {a["code"] for a in tpl["accounts"]}
    for a in tpl["accounts"]:
        if a["code"] in existing_by_code:
            continue
        to_insert.append({
            **a,
            "id": f"acct-{cid[:8]}-{a['code']}",
            "company_id": cid,
            "active": True,
            "seeded_by_industry": slug,
            "created_at": now,
            "updated_at": now,
        })
    if to_insert:
        await db.accounts.insert_many(to_insert)

    # Backfill provenance stamp on any existing account whose code
    # belongs to the new template but has no stamp yet — so future
    # switches can identify these as template-seeded.
    unstamped_ids = [
        a["id"] for a in existing
        if a.get("code") in template_codes_set
        and not a.get("seeded_by_industry")
        and a["id"] not in removed_ids
    ]
    if unstamped_ids:
        await db.accounts.update_many(
            {"company_id": cid, "id": {"$in": unstamped_ids}},
            {"$set": {"seeded_by_industry": slug, "updated_at": now}},
        )

    await db.companies.update_one(
        {"id": cid},
        {"$set": {
            "industry_template": slug,
            "industry_selected_at": now,
            "updated_at": now,
        }},
    )
    return {
        "ok": True,
        "template": slug,
        "old_template": old_slug,
        "seeded_accounts": len(to_insert),
        "removed_accounts": len(removed_ids),
        "removed": [{"id": a["id"], "code": a["code"], "name": a["name"]}
                    for a in safe_remove if a["id"] in removed_ids],
        "blocked_remove": preview["blocked_remove"],
    }


@router.post("/companies/{cid}/categorization-mode")
async def set_categorization_mode(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    """Flip between 'standard' | 'standard_plus'. Applies to incoming
    txns from this moment forward — never rewrites already-categorized
    rows (use the Standard+ retroactive apply endpoint for that)."""
    await require_company(user, cid)
    mode = (payload.get("mode") or "").strip()
    if mode not in ("standard", "standard_plus"):
        raise HTTPException(
            400, "mode must be 'standard' or 'standard_plus'",
        )
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"categorization_mode": mode, "updated_at": now_iso()}},
    )
    return {"ok": True, "mode": mode}


@router.post("/companies/{cid}/standard-plus/apply-rules")
async def standard_plus_apply_rules(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    """Apply the Global Vendor Rules library to a set of existing
    transactions on the given company. Used for retroactive
    re-categorization when the CPA flips a company to Standard+ or
    when we ship a rule library update.

    Body accepts either:
      {"transaction_ids": [str, ...]}  → apply to that specific set
      {"all": true}                     → apply to every txn on the company
    Returns: {"ok": true, "stats": {matched, overridden, review_flagged,
             skipped, skipped_tenant_priority, matched_via_rule,
             matched_via_pfc}, "total_scanned": int}
    """
    await require_company(user, cid)
    import standard_plus_categorizer
    ids = payload.get("transaction_ids") or []
    if payload.get("all") is True:
        ids = [t["id"] async for t in db.transactions.find(
            {"company_id": cid}, projection={"id": 1},
        )]
    if not ids:
        raise HTTPException(400, "transaction_ids or all=true required")
    stats = await standard_plus_categorizer.apply_global_rules_override(cid, ids)
    return {"ok": True, "stats": stats, "total_scanned": len(ids)}


@router.post("/companies/{cid}/standard/apply-directory")
async def standard_apply_directory(
    cid: str, payload: dict = None, user: dict = Depends(get_current_user),
) -> dict:
    """Retroactively apply the Global Contact Directory to existing
    transactions on the given company.

    Runs on ANY company (Standard or Standard+ mode). Fills the gap
    for rows ingested before the directory shipped — they carry no
    `category_hint_semantic` yet, so this sweep looks each row up
    against the 5,221-entry directory and applies the linked semantic
    to rows the resolver can map to the company's CoA.

    Priority guard mirrors the ingest cascade — never overrides
    tenant-tier rows (custom rules, merchant memory, manual overrides,
    Standard+ rule/directory results, PFC-primary).

    Body accepts either:
      {}                              → apply to every txn on the company
      {"transaction_ids": [str, ...]} → apply to that specific set
    Returns: {"ok": true, "stats": {...}}
    """
    await require_company(user, cid)
    import standard_directory_retro
    body = payload or {}
    ids = body.get("transaction_ids") or None
    stats = await standard_directory_retro.apply_directory_to_existing(cid, ids)
    return {"ok": True, "stats": stats}


@router.get("/global-vendor-rules/stats")
async def global_vendor_rules_stats(user: dict = Depends(get_current_user)) -> dict:
    """Return summary metadata about the loaded Global Vendor Rules
    library. Used by the Settings UI to show rule coverage."""
    import global_vendor_rules
    return {"rule_count": global_vendor_rules.rule_count()}

