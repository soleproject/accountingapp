"""AI-First Beta routes: industry templates + categorization mode toggle."""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends, HTTPException

from db import db, now_iso
from auth import get_current_user
from deps import require_company
import industry_templates
import ai_first_categorizer

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
    """Flip between 'standard' | 'ai_first' | 'standard_plus'. Applies
    to incoming txns from this moment forward — never rewrites already-
    categorized rows."""
    await require_company(user, cid)
    mode = (payload.get("mode") or "").strip()
    if mode not in ("standard", "ai_first", "standard_plus"):
        raise HTTPException(
            400, "mode must be 'standard', 'ai_first', or 'standard_plus'",
        )
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"categorization_mode": mode, "updated_at": now_iso()}},
    )
    return {"ok": True, "mode": mode}


@router.post("/companies/{cid}/ai-first/categorize-batch")
async def ai_first_categorize(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
) -> dict:
    """Categorize a batch of already-existing transactions using AI-First.

    Body: {"transaction_ids": [str, ...]}
    Applies results directly to the transactions (contact + category).
    Used for on-demand re-categorization on companies opted into
    ai_first mode. Live Plaid/statement imports should hook into this
    same function via the standard ingest path (branching on
    categorization_mode).
    """
    await require_company(user, cid)
    ids = payload.get("transaction_ids") or []
    if not ids:
        raise HTTPException(400, "transaction_ids required")
    rows = await db.transactions.find(
        {"id": {"$in": ids}, "company_id": cid}
    ).to_list(len(ids))
    results = await ai_first_categorizer.categorize_batch(cid, rows)
    updated = 0
    for r in results:
        set_fields = {
            "category_account_id": r.get("category_account_id"),
            "category_account_code": r.get("category_account_code"),
            "category_account_name": r.get("category_account_name"),
            "contact_id": r.get("contact_id"),
            "contact_name": r.get("contact_name"),
            "needs_review": r.get("needs_review", True),
            "ai_confidence": r.get("confidence", 0.0),
            "ai_reasoning": r.get("reasoning", ""),
            "categorization_source": r.get("source", "ai_first"),
            "updated_at": now_iso(),
        }
        # Drop empty values so we don't clobber existing data with nulls.
        set_fields = {k: v for k, v in set_fields.items() if v is not None}
        await db.transactions.update_one({"id": r["txn_id"]}, {"$set": set_fields})
        updated += 1
    return {"ok": True, "updated": updated, "results": results}


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


@router.get("/global-vendor-rules/stats")
async def global_vendor_rules_stats(user: dict = Depends(get_current_user)) -> dict:
    """Return summary metadata about the loaded Global Vendor Rules
    library. Used by the Settings UI to show rule coverage."""
    import global_vendor_rules
    return {"rule_count": global_vendor_rules.rule_count()}

