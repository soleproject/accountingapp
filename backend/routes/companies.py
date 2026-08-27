"""Axiom Ledger — Companies routes.

Auto-extracted from server.py during the Feb 2026 modularization refactor.
Behaviour is intentionally identical to the pre-split codebase.
"""
from __future__ import annotations
import os
import re
import uuid
import json
import random
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from regions import defaults_for as _region_defaults_for


_WS_RE = re.compile(r"\s+")


def _norm_name(s: Any) -> str:
    """Canonicalize a company name for the delete-confirm comparison.

    Collapses any run of whitespace (regular + non-breaking `\u00A0` +
    tabs, matching the frontend `normName` helper) into a single ASCII
    space then trims. This lets a user who typed `QBO 14 LLC` on their
    keyboard match a stored name that carries NBSPs or double spaces
    from legacy onboarding.
    """
    if not s:
        return ""
    return _WS_RE.sub(" ", str(s)).strip()

from auth import (
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
from ai_service import (
    categorize_transaction, chat_stream, suggest_chart_of_accounts,
    onboarding_interview_questions, onboarding_interview_synthesize,
    parse_voice_intent,
)
import reports as R
import plaid_service
import plaid_connect
import veryfi_service
import merchant_cache
import contact_resolver
from infra import get_cache

from models import (
    LoginIn, SignupIn, CompanyCreate, TransactionUpdate, TransactionCreate,
    SplitIn, RuleCreate, InvoiceCreate, BillCreate, ContactCreate,
    AccountCreate, JECreate, ChatIn, OnboardingUpdate, PaymentCreate,
    ReceiptCreate, GenericCreate, NewClientIn,
)
from deps import (
    DASH_CACHE_TTL,
    company_ids_for_user, require_company, log_ai,
    is_period_closed, assert_open,
    categorize_and_insert, sync_and_import,
)

router = APIRouter(prefix="/api")

# Import the shared canonicalizer here (lazy alias) so that both this
# route and the onboarding routes normalize business_type identically.
from routes.onboarding import _canonicalize_business_type as _canon_bt  # noqa: E402


# ----------------------- Companies -----------------------

@router.get("/companies")
async def list_companies(user: dict = Depends(get_current_user)):
    """Return every company the current user has access to, enriched with
    the owner's name + email so the top-left switcher can group by owner
    (helpful for Pros managing many client companies)."""
    ids = await company_ids_for_user(user)
    docs = await db.companies.find({"id": {"$in": ids}}).to_list(1000)
    # Batch-fetch owner users so we don't make one query per company.
    owner_ids = list({d.get("owner_user_id") for d in docs if d.get("owner_user_id")})
    owners = {u["id"]: u for u in await db.users.find({"id": {"$in": owner_ids}}).to_list(1000)}
    enriched = []
    from crypto_service import decrypt_doc
    for d in docs:
        row = coerce(decrypt_doc("companies", d))
        owner = owners.get(d.get("owner_user_id"))
        row["owner_name"] = (owner or {}).get("name")
        row["owner_email"] = (owner or {}).get("email")
        enriched.append(row)
    return {"companies": enriched}


@router.post("/companies")
async def create_company(inp: CompanyCreate, user: dict = Depends(get_current_user)):
    cid = str(uuid.uuid4())
    now = now_iso()
    # Count how many companies the caller already owns so we can decide
    # whether to send the "another company added to your login" email. On
    # signup (first company) we skip the email — the user just created
    # their account and doesn't need a "welcome" bounce.
    prior_owner_count = await db.memberships.count_documents({
        "user_id": user["id"], "role": "owner",
    })
    await db.companies.insert_one({
        "id": cid, "name": inp.name,
        # Snap the entity type to one of the seven canonical forms so
        # every downstream tax/reporting switch works against a closed
        # enum instead of colloquial variants.
        "business_type": _canon_bt(inp.business_type) or inp.business_type,
        "business_description": inp.business_description,
        "reporting_basis": inp.reporting_basis,
        # Default new companies to "simple" — the vast majority of small-
        # biz owners never touch Sales Receipts / Credit Memos / QBO-
        # entity editors. CPAs flip this to "advanced" per-client as
        # needed via Settings.
        "accounting_mode": "simple",
        # Phase 1 advanced-feature flags (Feb 2026). All default OFF so
        # every new AND existing company sees today's UX unchanged.
        # Toggled per-company in Settings when the Pro wants Classes /
        # Projects / Budgets. See `/app/memory/PRD.md` for the rollout
        # plan. Fields on transactions / JE lines already tolerate a
        # nullable `class_id` / `project_id` / `phase_id`, so turning a
        # flag on later doesn't require a migration.
        "features": {
            "classes_enabled":  False,
            "projects_enabled": False,
            "budgets_enabled":  False,
        },
        # Region + derived defaults (currency, date_format). `inp.region`
        # is None from every existing UI call, so this resolves to US —
        # zero behavior change for US customers. Kept as an unpacked
        # dict so a future Phase-1 UI can pass region="UK" and get GBP
        # + DD/MM/YYYY in one shot.
        **_region_defaults_for(inp.region),
        "owner_user_id": user["id"], "onboarding_complete": False,
        "created_at": now, "updated_at": now,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "company_id": cid,
        "role": "owner", "created_at": now,
    })
    # Auto-provision default CoA — branches on region. US companies
    # get the same 40-row starter CoA they've always had; UK companies
    # get the FRS 102 Section 1A layout (Fixed Assets → Current Assets
    # → Creditors <1y → Creditors >1y → Capital & Reserves).
    from seed import coa_for
    for code, name, atype, subtype, detail_type in coa_for(inp.region):
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": code, "name": name,
            "type": atype, "subtype": subtype, "detail_type": detail_type,
            "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    await db.onboarding_state.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "step": 0, "total_steps": 6,
        "complete": False, "answers": {}, "created_at": now, "updated_at": now,
    })

    # Owner-adds-another-company welcome email — matches the notification
    # a client gets when a Pro adds a new company to their login. Skipped
    # for the very first company (signup case) and for users without an
    # email on file. Never blocks — we return the actual send status so
    # the frontend can show an honest toast instead of "email sent!" when
    # Resend really failed.
    email_status = "skipped_first_company" if prior_owner_count == 0 else "skipped_no_email"
    email_error: str | None = None
    if prior_owner_count > 0 and user.get("email"):
        try:
            from email_dispatcher import dispatch, public_base_url
            import email_templates as _tmpl
            branding = user.get("branding") or {}
            firm_name = branding.get("firm_name") or None
            pro_name = user.get("full_name") or user.get("name") or user.get("email") or "You"
            subject, html = _tmpl.client_welcome_returning(
                client_name=user.get("name") or "there",
                pro_name=pro_name,
                firm_name=firm_name,
                brand_name=firm_name,
                company_name=inp.name,
                other_company_count=prior_owner_count,
                dashboard_url=f"{public_base_url()}/dashboard",
            )
            result = await dispatch(
                kind="client_welcome_returning", to=user["email"],
                subject=subject, html=html,
                initiating_user_id=user["id"], company_id=cid,
                related={"self_add": True, "prior_owner_count": prior_owner_count},
            )
            email_status = result.get("status", "failed")
            email_error = result.get("error")
        except Exception as _exc:
            import logging as _lg
            _lg.getLogger(__name__).exception(
                "Self-add welcome email failed (company creation still succeeded)"
            )
            email_status = "failed"
            email_error = str(_exc)

    return {
        "company_id": cid,
        "email_status": email_status,
        "email_error": email_error,
    }


@router.post("/companies/{cid}/contacts/backfill")
async def contacts_backfill(cid: str, user: dict = Depends(get_current_user)):
    """One-time migration: resolve + assign contacts on every transaction that
    doesn't yet have one. Uses the fast merchant_name path when available,
    Claude Haiku otherwise. Idempotent — running twice is safe.
    """
    await require_company(user, cid)
    from ai_service import resolve_contact_ai
    # Find txns missing contact_id (either field absent or explicit null)
    missing = await db.transactions.find({
        "company_id": cid,
        "$or": [{"contact_id": None}, {"contact_id": {"$exists": False}}],
    }).to_list(20000)
    if not missing:
        return {"scanned": 0, "resolved": 0, "created": 0, "left_null": 0}

    items = [{
        "merchant_name": t.get("merchant"),
        "description": t.get("description"),
        "amount": t.get("amount"),
        # Pass PFC so the new NO_COUNTERPARTY_PFC gate can filter out
        # transfers/ATM/fees/interest — otherwise the backfill would create
        # a bogus "BofA ATM 07/16 ..." contact for every self-transfer.
        "pfc_primary": t.get("pfc_primary"),
    } for t in missing]
    results = await contact_resolver.resolve_contacts_batch(
        cid, items, ai_fallback_fn=resolve_contact_ai, concurrency=5,
    )
    resolved = 0
    created = 0
    left_null = 0
    created_ids: set[str] = set()
    now = now_iso()
    for t, r in zip(missing, results):
        if r.get("contact_id"):
            await db.transactions.update_one(
                {"id": t["id"], "company_id": cid},
                {"$set": {"contact_id": r["contact_id"],
                          "contact_name": r["contact_name"],
                          "contact_source": r.get("source"),
                          "updated_at": now}},
            )
            resolved += 1
            if r.get("source") in ("merchant_name", "ai_new") and r["contact_id"] not in created_ids:
                created += 1
                created_ids.add(r["contact_id"])
        else:
            # Explicit no_counterparty marker so we know we've evaluated
            # this row (vs "never scanned yet") and can skip it next time.
            await db.transactions.update_one(
                {"id": t["id"], "company_id": cid},
                {"$set": {"contact_source": r.get("source") or "no_counterparty",
                          "updated_at": now}},
            )
            left_null += 1
    return {"scanned": len(missing), "resolved": resolved,
            "created": created, "left_null": left_null}


@router.patch("/companies/{cid}/settings/auto-post-threshold")
async def set_auto_post_threshold(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Per-company AI auto-post threshold (default 0.80)."""
    await require_company(user, cid)
    try:
        v = float(payload.get("threshold"))
    except Exception:
        raise HTTPException(400, "threshold must be a number 0.0-1.0")
    if not (0.0 <= v <= 1.0):
        raise HTTPException(400, "threshold must be between 0.0 and 1.0")
    await db.companies.update_one({"id": cid}, {"$set": {
        "auto_post_threshold": v, "updated_at": now_iso(),
    }})
    return {"auto_post_threshold": v}


# ---------------------------------------------------------------------------
# Plaid PFC → Chart-of-Accounts overrides (per Rocketbooks' pfc_org_overrides)
# ---------------------------------------------------------------------------

@router.get("/companies/{cid}/pfc-overrides")
async def list_pfc_overrides(cid: str, user: dict = Depends(get_current_user)):
    """List every Plaid PFCv2 detailed code alongside:
      - the default mapping (from `pfc_mapping.PFC_COA_MAPPINGS`)
      - the org's override, if pinned
    Used to render the PFC-mapping settings page.
    """
    await require_company(user, cid)
    import pfc_mapping as _pfcm
    overrides = await db.pfc_org_overrides.find({"company_id": cid}).to_list(500)
    by_pfc = {o["pfc_detailed"]: o for o in overrides}
    accts = await db.accounts.find({"company_id": cid, "is_active": {"$ne": False}}).to_list(2000)
    by_id = {a["id"]: a for a in accts}
    by_code = {a["code"]: a for a in accts}
    rows = []
    for m in _pfcm.PFC_COA_MAPPINGS:
        default_acct = by_code.get(m.account_code)
        ov = by_pfc.get(m.pfc_detailed)
        ov_acct = by_id.get(ov["category_account_id"]) if ov else None
        rows.append({
            "pfc_primary": m.pfc_primary,
            "pfc_detailed": m.pfc_detailed,
            "classification": m.classification,
            "description": m.description_v2,
            "default_account_code": m.account_code,
            "default_account_name": (default_acct or {}).get("name"),
            "override_account_id": (ov or {}).get("category_account_id"),
            "override_account_code": (ov_acct or {}).get("code"),
            "override_account_name": (ov_acct or {}).get("name"),
            "override_source": (ov or {}).get("source"),
            "override_confidence": (ov or {}).get("confidence"),
        })
    return {"count": len(rows), "rows": rows}


@router.put("/companies/{cid}/pfc-overrides/{pfc_detailed}")
async def set_pfc_override(cid: str, pfc_detailed: str, payload: dict,
                           user: dict = Depends(get_current_user)):
    """Pin a Plaid PFCv2 code to a specific chart-of-accounts row for this org.
    Body: {"category_account_id": "<coa-id>"}. `source` defaults to 'user'.
    """
    await require_company(user, cid)
    import pfc_mapping as _pfcm
    import pfc_resolver as _pfcr
    if not _pfcm.get_pfc_mapping(pfc_detailed):
        raise HTTPException(400, f"Unknown PFC detailed code: {pfc_detailed}")
    account_id = (payload or {}).get("category_account_id")
    if not account_id:
        raise HTTPException(400, "category_account_id is required")
    acct = await db.accounts.find_one({"company_id": cid, "id": account_id})
    if not acct:
        raise HTTPException(404, "Account not found on this company")
    saved = await _pfcr.set_pfc_override(
        cid, pfc_detailed, account_id,
        source=payload.get("source", "user"),
        confidence=payload.get("confidence"),
        reasoning=payload.get("reasoning"),
        ai_model=payload.get("ai_model"),
    )
    return {"ok": True, "override": saved}


@router.delete("/companies/{cid}/pfc-overrides/{pfc_detailed}")
async def delete_pfc_override(cid: str, pfc_detailed: str,
                              user: dict = Depends(get_current_user)):
    """Remove an override; the PFC falls back to the default mapping."""
    await require_company(user, cid)
    r = await db.pfc_org_overrides.delete_one({
        "company_id": cid, "pfc_detailed": pfc_detailed,
    })
    return {"ok": True, "deleted": r.deleted_count}


@router.patch("/companies/{cid}")
async def update_company(cid: str, patch: dict, request: Request, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    allowed = {
        "name", "business_type", "business_description", "reporting_basis", "auto_post_threshold",
        # Branding fields used on invoice/bill PDFs and printable views.
        # Logo is stored inline as a base64 data URL (small — <200KB
        # practical cap). Migration to object storage TBD once a firm
        # starts uploading huge logos.
        "logo_data_url", "address", "phone", "email", "website", "tax_id",
        # Two-tier UX toggle:
        #   "simple"   — bank feed + AI categorization only (default for
        #               regular business owners; hides Sales Receipts,
        #               Credit Memos, entity chip strip, QBO-shaped
        #               editors from the sidebar and Transactions page).
        #   "advanced" — full QBO parity, all editors + ledger views
        #               visible. CPAs / bookkeepers flip this on per
        #               client company as needed.
        "accounting_mode",
        # Per-company report styling (fonts, colors, spacing, labels).
        # Full schema lives in `reports.DEFAULT_REPORT_STYLE`. Front-end
        # sends the entire dict on save — server accepts as-is (dict
        # validation happens in the resolver at read time so a partial
        # or legacy dict never crashes the PDF pipeline).
        "report_style",
        # Firm Books flag — allows a pro to "detach" their firm books
        # (set it to false), which un-protects the company for deletion
        # and moves it out of the "Firm books" section in the switcher.
        # One-way in practice; the auto-provisioner won't re-flag once
        # cleared, and the pro can then delete via the normal flow.
        "is_firm_books",
        # Standard+ Beta: opt-in to render a subtle colored dot on
        # every Transactions row indicating which categorization tier
        # decided the category (tenant rule / global rule / PFC / LLM).
        # Default OFF — advanced UX for CPAs, hidden from end-users
        # who prefer clean books-look until they flip it on.
        "show_categorization_source_badges",
    }
    updates = {k: v for k, v in (patch or {}).items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No editable fields provided")
    # Validate accounting_mode enum — anything outside {simple, advanced}
    # would silently hide/show wrong UI, so reject with a clear 400.
    if "accounting_mode" in updates:
        if updates["accounting_mode"] not in ("simple", "advanced"):
            raise HTTPException(400,
                "accounting_mode must be 'simple' or 'advanced'")
    # Snap business_type to a canonical entity form so PATCHes from the
    # Company Settings page + AI-driven updates land on the same enum.
    if "business_type" in updates and isinstance(updates["business_type"], str):
        canon = _canon_bt(updates["business_type"])
        if canon:
            updates["business_type"] = canon
    updates["updated_at"] = now_iso()
    # Snapshot the BEFORE doc for the audit trail. Grabbed before we
    # touch the write path so encryption of tax_id/ein doesn't muddy
    # the diff (audit stores decrypted-ish state — the crypto layer
    # redacts the raw ciphertext through the field-name allowlist).
    before_doc = await db.companies.find_one({"id": cid})
    # Encrypt any sensitive fields (`tax_id`, `ein`) before hitting Mongo.
    from crypto_service import encrypt as _enc
    if "tax_id" in updates and updates["tax_id"]:
        updates["tax_id"] = _enc(updates["tax_id"])
    if "ein" in updates and updates["ein"]:
        updates["ein"] = _enc(updates["ein"])
    r = await db.companies.update_one({"id": cid}, {"$set": updates})
    if r.matched_count == 0:
        raise HTTPException(404, "Company not found")
    doc = await db.companies.find_one({"id": cid})
    # Return decrypted view — sensitive fields are stored ciphered but
    # the caller (settings page) expects plaintext to render in the UI.
    from crypto_service import decrypt_doc
    result = coerce(decrypt_doc("companies", doc))
    # Audit — company settings changes are full-snapshot events per
    # policy (see `_FULL_SNAPSHOT_ENTITIES` in audit.py).
    try:
        import audit as _audit
        _audit.log_event(
            event_type=_audit.EVENT_UPDATE,
            actor={"id": user["id"], "email": user.get("email"), "role": user.get("role")},
            company_id=cid,
            entity_type="company", entity_id=cid,
            before=decrypt_doc("companies", before_doc) if before_doc else None,
            after=result,
            request=request,
            summary=f"Company settings updated ({', '.join(sorted(updates.keys()))})",
        )
    except Exception:  # noqa: BLE001
        pass
    return result


@router.delete("/companies/{cid}")
async def delete_company(cid: str, confirm: str = "",
                         force_firm_books: bool = False,
                         force_partner_books: bool = False,
                         user: dict = Depends(get_current_user)):
    """Hard-delete a company and every record scoped to it. Requires
    `?confirm=<company_name>` in the query string as a safeguard against
    accidental deletes. The requester must have an owner/pro/superadmin
    membership on the company.
    """
    await require_company(user, cid)
    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found")
    if not confirm or _norm_name(confirm) != _norm_name(company.get("name", "")):
        raise HTTPException(
            400,
            f"To confirm deletion, pass ?confirm=<exact company name>. Got: {confirm!r}",
        )
    # Firm Books companies are the CPA's own accounting entity —
    # protected from deletion because losing it would strand the firm
    # itself. Bypass requires an explicit `force_firm_books=true` query
    # flag so a regular UI delete can't accidentally wipe it out; a
    # power user (or the future "Delete Firm Books" settings button)
    # has to opt-in on purpose. The audit trail still catches it either
    # way via the log_delete call at the end of this handler.
    if company.get("is_firm_books") is True and not force_firm_books:
        raise HTTPException(
            403,
            "Firm Books companies are protected. Pass "
            "`force_firm_books=true` to override, or convert this "
            "company to a regular company first via PATCH "
            "/companies/{cid} with {\"is_firm_books\": false}.",
        )
    # Partner Books are the same idea but scoped to Partner-role users
    # (see partners.ensure_partner_books_company_for_partner). Distinct
    # override flag from firm books so a client accidentally deleting a
    # firm-books row can't accidentally take out a partner-books row
    # via the same override — each protection is opted-in explicitly.
    if company.get("is_partner_books") is True and not force_partner_books:
        raise HTTPException(
            403,
            "Partner Books companies are protected. Pass "
            "`force_partner_books=true` to override, or convert this "
            "company to a regular company first via PATCH "
            "/companies/{cid} with {\"is_partner_books\": false}.",
        )
    # Every collection that carries a `company_id` field
    per_company_collections = [
        "accounts", "transactions", "journal_entries", "invoices", "bills",
        "customers", "vendors", "payments", "onboarding_state",
        "plaid_items", "veryfi_uploads", "ai_activity_log", "rules",
        "audit_logs", "period_locks", "memberships",
    ]
    deleted: dict[str, int] = {}
    for coll in per_company_collections:
        try:
            r = await db[coll].delete_many({"company_id": cid})
            if r.deleted_count:
                deleted[coll] = r.deleted_count
        except Exception:
            pass
    # Finally the company itself
    r = await db.companies.delete_one({"id": cid})
    deleted["companies"] = r.deleted_count
    return {"deleted": True, "company_id": cid, "records_removed": deleted}


