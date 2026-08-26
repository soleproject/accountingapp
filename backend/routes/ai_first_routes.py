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


@router.post("/companies/{cid}/industry-template")
async def set_industry_template(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    """Set (or change) the company's industry template + seed missing accounts.

    Non-destructive by design: only *adds* accounts from the template
    that don't already exist by code. Existing accounts are left alone
    so a CPA who's customized their CoA doesn't lose work.
    """
    await require_company(user, cid)
    slug = (payload.get("template") or "").strip()
    tpl = industry_templates.get_template(slug)
    if not tpl:
        raise HTTPException(400, f"Unknown template: {slug!r}")

    existing = await db.accounts.find({"company_id": cid}).to_list(1000)
    existing_codes = {a.get("code") for a in existing}
    to_insert = []
    for a in tpl["accounts"]:
        if a["code"] in existing_codes:
            continue
        to_insert.append({
            **a,
            "id": f"acct-{cid[:8]}-{a['code']}",
            "company_id": cid,
            "active": True,
            "created_at": now_iso(),
            "updated_at": now_iso(),
        })
    if to_insert:
        await db.accounts.insert_many(to_insert)
    await db.companies.update_one(
        {"id": cid}, {"$set": {"industry_template": slug, "updated_at": now_iso()}},
    )
    return {"ok": True, "template": slug, "seeded_accounts": len(to_insert)}


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

