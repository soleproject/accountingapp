"""Axiom Ledger — Pro dashboard routes.

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

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
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


# ----------------------- Pro dashboard -----------------------

@router.get("/pro/clients")
async def pro_clients(user: dict = Depends(require_role("pro", "superadmin"))):
    ms = await db.memberships.find({"user_id": user["id"], "role": "pro"}).to_list(1000)
    company_ids = [m["company_id"] for m in ms]
    if user["role"] == "superadmin":
        companies = await db.companies.find({}).to_list(1000)
    else:
        companies = await db.companies.find({"id": {"$in": company_ids}}).to_list(1000)
    result = []
    for c in companies:
        txn_count = await db.transactions.count_documents({"company_id": c["id"]})
        needs_review = await db.transactions.count_documents({"company_id": c["id"], "needs_review": True})
        result.append({
            "id": c["id"], "name": c["name"], "business_type": c.get("business_type", ""),
            "onboarding_complete": c.get("onboarding_complete", False),
            "transactions": txn_count, "needs_review": needs_review,
            # Billing snapshot so the client-card can surface a
            # "needs activation" indicator + tailor the resend-email
            # tooltip. Only three fields we need on the tile.
            "billing_payer": c.get("billing_payer"),
            "billing_state": c.get("billing_state"),
            "needs_activation": (
                c.get("billing_payer") == "client_email"
                and (c.get("billing_state") or "pending") == "pending"
            ),
        })
    return {"clients": result}


@router.get("/pro/clients/lookup")
async def pro_lookup_client(email: str, user: dict = Depends(require_role("pro", "superadmin"))):
    """Lightweight probe used by the New-Client dialog to detect whether the
    given email already belongs to a client user. Only reveals name — never
    password / other PII. Returns {exists: bool, name: str|null}.
    """
    u = await db.users.find_one({"email": (email or "").strip().lower(), "role": "client"})
    if not u:
        return {"exists": False, "name": None}
    return {"exists": True, "name": u.get("name")}


@router.get("/pro/billing/context")
async def pro_billing_context(user: dict = Depends(require_role("pro", "superadmin"))):
    """Everything the Add-Client modal needs to render its payer/product/
    discount pickers in a single fetch:

      * The caller Pro's parent enterprise (id, name, free spots left,
        default_product, default_discount).
      * The product catalog with regular + discounted USD prices, so the
        UI can render the side-by-side price the pro/client will see.
    """
    import enterprises as _entmod

    ent_id = user.get("enterprise_id")
    ent_out = None
    if ent_id:
        ent = await db.enterprises.find_one({"id": ent_id}, {"_id": 0})
        if ent:
            stats = await _entmod.rollup_stats(ent_id)
            ent_out = _entmod.serialize(ent, stats=stats)
    return {
        "enterprise": ent_out,
        "price_catalog": _entmod.PRICE_CATALOG,
        "payers": list(_entmod.BILLING_PAYERS),
        "products": list(_entmod.BILLING_PRODUCTS),
    }



@router.post("/pro/clients")
async def pro_create_client(inp: NewClientIn, user: dict = Depends(require_role("pro", "superadmin"))):
    """Create (or reuse) a client user + a new company + memberships, and seed
    the default CoA. If the email already belongs to a `client` user, we reuse
    that user and just add a fresh membership for the new company — this lets
    one owner login switch between multiple companies they own via the company
    dropdown at the top-left.

    On success, sends one of two welcome emails via Resend:
      * First-time client (no prior companies) → magic-link password-set
        email. The temp password on ``inp`` is ignored; the user picks
        their own via the ``/set-password/{token}`` page.
      * Returning client (already owns at least one company) → "we
        added another company to your login" email pointing at the
        top-left switcher.
    """
    now = now_iso()
    email = inp.client_email.lower()
    existing = await db.users.find_one({"email": email})
    reused = False
    other_company_count = 0
    if existing:
        if existing.get("role") != "client":
            raise HTTPException(
                400,
                "That email belongs to a non-client account (pro/superadmin) and cannot be reused as a client.",
            )
        client_id = existing["id"]
        reused = True
        # Count the companies they already own BEFORE we add this one, so the
        # returning-client welcome email reports the number correctly.
        other_company_count = await db.memberships.count_documents({
            "user_id": client_id, "role": "owner",
        })
    else:
        # Insert with a random placeholder password. The client will replace
        # it via the magic-link, and any submitted temp password on `inp`
        # is intentionally ignored so a Pro can't leak plaintext creds.
        import secrets as _secrets
        placeholder = hash_password(_secrets.token_urlsafe(48))
        client_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": client_id, "email": email, "name": inp.client_name,
            "password": placeholder, "role": "client",
            "must_set_password": True,
            "created_at": now, "updated_at": now,
        })

    # -----------------------------------------------------------
    # Phase B — validate & persist billing intent on the company.
    # If the pro picks `free_spot` we bounce back to the enterprise's
    # remaining capacity BEFORE creating the company so we never end
    # up with a company that consumed a spot the firm didn't have.
    # -----------------------------------------------------------
    import enterprises as _entmod
    billing_payer = inp.billing_payer
    billing_product = inp.billing_product
    billing_discount = bool(inp.billing_discount) if inp.billing_discount is not None else False
    ent_id = user.get("enterprise_id")
    if billing_payer:
        if billing_payer not in _entmod.BILLING_PAYERS:
            raise HTTPException(400, f"billing_payer must be one of {list(_entmod.BILLING_PAYERS)}")
    if billing_product:
        if billing_product not in _entmod.BILLING_PRODUCTS:
            raise HTTPException(400, f"billing_product must be one of {list(_entmod.BILLING_PRODUCTS)}")
    if billing_payer == "free_spot":
        if not ent_id:
            raise HTTPException(400, "Pro user is not attached to an enterprise; free spots unavailable.")
        stats = await _entmod.rollup_stats(ent_id)
        ent = await db.enterprises.find_one({"id": ent_id})
        remaining = max(0, int((ent or {}).get("free_user_allotment") or 0) - stats["free_used"])
        if remaining <= 0:
            raise HTTPException(400, "This enterprise has no free spots remaining.")

    company_id = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": company_id, "name": inp.company_name,
        "business_type": inp.business_type, "business_description": inp.business_description,
        "reporting_basis": inp.reporting_basis,
        "owner_user_id": client_id, "pro_user_id": user["id"],
        "onboarding_complete": False,
        # Enterprise + billing intent. `billing_state` starts pending;
        # Phase C's Stripe webhook flips it to active/past_due/canceled.
        # For free_spot we can mark it active immediately since no charge
        # ever posts.
        "enterprise_id": ent_id,
        "billing_payer": billing_payer,
        "billing_product": billing_product,
        "billing_discount": billing_discount,
        "billing_state": "active" if billing_payer == "free_spot" else "pending",
        "created_at": now, "updated_at": now,
    })

    # Add memberships (avoid duplicates just in case)
    mems = [
        {"id": str(uuid.uuid4()), "user_id": client_id, "company_id": company_id, "role": "owner", "created_at": now},
        {"id": str(uuid.uuid4()), "user_id": user["id"], "company_id": company_id, "role": "pro", "created_at": now},
    ]
    await db.memberships.insert_many(mems)

    from seed import DEFAULT_COA
    for code, name, atype, subtype in DEFAULT_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id, "code": code, "name": name,
            "type": atype, "subtype": subtype, "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    await db.onboarding_state.insert_one({
        "id": str(uuid.uuid4()), "company_id": company_id, "step": 0, "total_steps": 6,
        "complete": False, "answers": {}, "created_at": now, "updated_at": now,
    })

    # -----------------------------------------------------------
    # Welcome email — first-time OR returning branch.
    # Never blocks the create flow: if Resend errors, we still return
    # 200 so the Pro's UI updates, and the error is surfaced in the
    # `communications` log for follow-up. We return the actual send
    # status on the response so the frontend can show an honest toast
    # ("emailed" vs "email failed — check Communications").
    # -----------------------------------------------------------
    email_status = "skipped_no_email"
    email_error: Optional[str] = None
    email_kind: Optional[str] = None
    try:
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        from routes.auth import mint_password_set_token

        pro_name = user.get("full_name") or user.get("name") or user.get("email") or "Your accountant"
        firm_name = (user.get("branding") or {}).get("firm_name") or None
        firm_slug = (user.get("branding") or {}).get("signin_subdomain") or None
        base = public_base_url()

        # Pros with a `signin_subdomain` set (i.e. private-label firms)
        # get every outbound URL suffixed with `?firm={slug}` so the
        # login / set-password / billing pages resolve the firm brand
        # instead of falling back to SmartBooks. The frontend
        # `/branding/by-subdomain/{sub}` endpoint drives the whole
        # sign-in-gate lookup off that param. If the Pro is not private-
        # labelled we leave the URLs plain so they resolve to platform.
        def _brand(url: str) -> str:
            if not firm_slug:
                return url
            sep = "&" if "?" in url else "?"
            return f"{url}{sep}firm={firm_slug}"

        # When billing_payer=client_email we surface a "Pay & activate"
        # CTA in the welcome email that deep-links to the client's
        # /billing page — after they set their password (or if they
        # already have a login and click through), the BillingLockedModal
        # will open Stripe checkout for this specific company.
        payment_url: Optional[str] = None
        if billing_payer == "client_email":
            payment_url = _brand(f"{base}/billing?company={company_id}")

        if reused and other_company_count > 0:
            subject, html = _tmpl.client_welcome_returning(
                client_name=inp.client_name or "there",
                pro_name=pro_name, firm_name=firm_name,
                brand_name=firm_name,
                company_name=inp.company_name,
                other_company_count=other_company_count,
                dashboard_url=_brand(f"{base}/dashboard"),
                payment_url=payment_url,
            )
            email_kind = "client_welcome_returning"
            result = await dispatch(
                kind=email_kind, to=email,
                subject=subject, html=html,
                initiating_user_id=user["id"], company_id=company_id,
                related={"reused": True, "other_company_count": other_company_count},
            )
            email_status = result.get("status", "failed")
            email_error = result.get("error")
        else:
            token = await mint_password_set_token(client_id, purpose="client_welcome")
            subject, html = _tmpl.client_welcome_first_time(
                client_name=inp.client_name or "there",
                pro_name=pro_name, firm_name=firm_name,
                brand_name=firm_name,
                company_name=inp.company_name,
                set_password_url=_brand(f"{base}/set-password/{token}"),
                payment_url=payment_url,
            )
            email_kind = "client_welcome"
            result = await dispatch(
                kind=email_kind, to=email,
                subject=subject, html=html,
                initiating_user_id=user["id"], company_id=company_id,
                related={"reused": False, "password_set_token": token},
            )
            email_status = result.get("status", "failed")
            email_error = result.get("error")
    except Exception as _exc:  # noqa: BLE001 — email failure never blocks client creation
        import logging as _lg
        _lg.getLogger(__name__).exception("Welcome email failed (client create still succeeded)")
        email_status = "failed"
        email_error = str(_exc)

    # How many companies does this owner now have access to?
    total = await db.memberships.count_documents({"user_id": client_id, "role": "owner"})
    return {
        "company_id": company_id,
        "client_id": client_id,
        "reused_existing_user": reused,
        "owner_company_count": total,
        "email_status": email_status,
        "email_error": email_error,
        "email_kind": email_kind,
    }


@router.post("/pro/clients/{cid}/resend-welcome")
async def resend_welcome_email(cid: str, user: dict = Depends(require_role("pro", "superadmin"))):
    """Re-send the welcome / activation email for ``cid``'s owner.

    Two paths, chosen automatically:

    * **First-time client** (`must_set_password=True`) — mint a fresh
      magic-link token and use the ``client_welcome_first_time``
      template. Existing behavior.
    * **Returning client** — the client already has a password, so we
      don't mint a token; we send ``client_welcome_returning`` instead.
      This unblocks the previous 409 that the endpoint used to raise,
      which was the wrong call whenever a client-email/pending company
      lost its activation link — the Pro had no way to resend without
      deleting and re-adding the company.

    Regardless of path, if this company's payer is ``client_email`` and
    the subscription is still ``pending``, the email surfaces the
    "Pay & activate books" CTA that deep-links to Stripe checkout.
    """
    # Membership check — Pro must be on this company.
    m = await db.memberships.find_one({
        "company_id": cid, "user_id": user["id"], "role": "pro",
    })
    if not m and user["role"] != "superadmin":
        raise HTTPException(403, "You don't manage this client.")

    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found.")
    owner_m = await db.memberships.find_one({"company_id": cid, "role": "owner"})
    if not owner_m:
        raise HTTPException(404, "Client has no owner on file.")
    owner = await db.users.find_one({"id": owner_m["user_id"]})
    if not owner:
        raise HTTPException(404, "Client user missing.")
    if not owner.get("email"):
        raise HTTPException(400, "Client has no email on file.")

    from email_dispatcher import dispatch, public_base_url
    import email_templates as _tmpl
    from routes.auth import mint_password_set_token

    base = public_base_url()
    pro_name = user.get("full_name") or user.get("name") or user.get("email") or "Your accountant"
    firm_name = (user.get("branding") or {}).get("firm_name") or None
    firm_slug = (user.get("branding") or {}).get("signin_subdomain") or None

    # Mirror /pro/clients (add_client) branding — carry ?firm=<slug>
    # so the client's set-password + billing pages render the Pro's
    # private label instead of the SmartBooks platform brand.
    def _brand(url: str) -> str:
        if not firm_slug:
            return url
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}firm={firm_slug}"

    needs_activation = (
        company.get("billing_payer") == "client_email"
        and (company.get("billing_state") or "pending") == "pending"
    )
    payment_url = _brand(f"{base}/billing?company={cid}") if needs_activation else None

    if owner.get("must_set_password"):
        token = await mint_password_set_token(owner["id"], purpose="client_welcome_resend")
        subject, html = _tmpl.client_welcome_first_time(
            client_name=owner.get("name") or "there",
            pro_name=pro_name, firm_name=firm_name,
            brand_name=firm_name,
            company_name=company.get("name") or "",
            set_password_url=_brand(f"{base}/set-password/{token}"),
            payment_url=payment_url,
        )
        related = {"resend": True, "password_set_token": token, "needs_activation": needs_activation}
        kind = "client_welcome"
    else:
        # Returning client — count how many other companies they own so
        # the "you now have N companies" copy stays accurate.
        other_count = await db.memberships.count_documents({
            "user_id": owner["id"], "role": "owner",
        }) - 1
        subject, html = _tmpl.client_welcome_returning(
            client_name=owner.get("name") or "there",
            pro_name=pro_name, firm_name=firm_name,
            brand_name=firm_name,
            company_name=company.get("name") or "",
            other_company_count=max(0, other_count),
            dashboard_url=_brand(f"{base}/dashboard"),
            payment_url=payment_url,
        )
        related = {"resend": True, "needs_activation": needs_activation}
        kind = "client_welcome_returning"

    result = await dispatch(
        kind=kind, to=owner["email"],
        subject=f"[Re-sent] {subject}", html=html,
        initiating_user_id=user["id"], company_id=cid,
        related=related,
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Email send failed")
    return {
        "status": result["status"],
        "sent_to": owner["email"],
        "communication_id": result["id"],
        "included_payment_link": needs_activation,
    }



# ---------------------------------------------------------------------------
# Pro branding — enterprise theming for firms managing their own clients.
# All fields live under the user (pro) doc's `branding` sub-doc:
#   {
#     logos: { logo_light, logo_dark, icon_light, icon_dark },  # base64 data URLs
#     signin_subdomain: "acme",
#     theme_preset: "default" | "midnight" | "forest" | "violet",
#     theme_custom: { primary, accent, sidebar_bg, sidebar_active_bg, topbar_bg } | null,
#   }
# Backwards-compat: the legacy `logo_data_url` (slice A) is treated as
# `logos.logo_light` if `logos` is missing. New writes always go into `logos`.
# ---------------------------------------------------------------------------

_ALLOWED_PRESETS = {"default", "midnight", "forest", "violet"}
_SUBDOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
_MAX_LOGO_BYTES = 512 * 1024  # 500 KB — plenty for a lossless PNG/SVG logo.
_LOGO_VARIANTS = {"logo_light", "logo_dark", "icon_light", "icon_dark"}
_THEME_TOKENS = {"primary", "accent", "sidebar_bg", "sidebar_active_bg", "topbar_bg"}
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class BrandingPatch(BaseModel):
    # Public/private-label name the firm renders as everywhere the app or an
    # outbound email is branded (browser tab, email sender name, client
    # sign-in header). Blank string clears it, in which case the effective
    # name falls back to the pro user's own name.
    firm_name: Optional[str] = None
    signin_subdomain: Optional[str] = None
    theme_preset: Optional[str] = None
    # Sparse object — every key must be in `_THEME_TOKENS`. Pass `null` to
    # reset all custom colors back to the preset.
    theme_custom: Optional[dict] = None


def _logos_from(b: dict) -> dict:
    """Return the 4-slot logo dict, migrating legacy `logo_data_url` on read."""
    logos = dict(b.get("logos") or {})
    if not logos.get("logo_light") and b.get("logo_data_url"):
        logos["logo_light"] = b["logo_data_url"]
    # Always emit all 4 keys — makes the frontend simpler.
    return {k: logos.get(k) for k in ["logo_light", "logo_dark", "icon_light", "icon_dark"]}


def _branding_out(user_doc: dict) -> dict:
    b = (user_doc or {}).get("branding") or {}
    fallback = (user_doc or {}).get("name") or None
    stored = b.get("firm_name") or None
    return {
        # The firm's display name — falls back to the user's own name so
        # newly-signed-up pros get something sensible in the tab title / UI
        # before they've set Enterprise Settings explicitly.
        "firm_name": stored or fallback,
        # `firm_name_raw` is what the pro has actually stored on their
        # branding sub-doc. The Enterprise Settings form uses this so the
        # empty input surfaces (rather than the user's own name) — the
        # placeholder shows the fallback value.
        "firm_name_raw": stored,
        "firm_name_fallback": fallback,
        "logos": _logos_from(b),
        # Preserved for backwards-compat with older frontend builds; new
        # clients should read `logos.logo_light` instead.
        "logo_data_url": _logos_from(b).get("logo_light"),
        "signin_subdomain": b.get("signin_subdomain"),
        "theme_preset": b.get("theme_preset") or "default",
        "theme_custom": b.get("theme_custom") or None,
    }


@router.get("/pro/branding")
async def get_pro_branding(user: dict = Depends(require_role("pro", "superadmin"))):
    doc = await db.users.find_one({"id": user["id"]})
    return _branding_out(doc or {})


@router.get("/branding/effective")
async def get_effective_branding(user: dict = Depends(get_current_user)):
    """Return the branding the current user should SEE (as opposed to
    edit). Pros/superadmins see their own. Client-users (owners) inherit
    the branding of the pro who manages any company they belong to —
    that's how firm branding cascades into the client's app."""
    if user.get("role") in {"pro", "superadmin"}:
        doc = await db.users.find_one({"id": user["id"]})
        return _branding_out(doc or {})
    # Owner / client-user: find a managing pro through shared company
    # memberships. If they belong to multiple firms, pick the most recent
    # pro relationship — an edge case for now, and deterministic enough.
    memberships = await db.memberships.find({"user_id": user["id"]}).to_list(200)
    company_ids = [m["company_id"] for m in memberships if m.get("company_id")]
    if not company_ids:
        return _branding_out({})
    pro_ms = await db.memberships.find({
        "company_id": {"$in": company_ids},
        "role": "pro",
    }).sort("created_at", -1).to_list(50)
    for pm in pro_ms:
        pro = await db.users.find_one({"id": pm["user_id"]})
        if pro:
            return _branding_out(pro)
    return _branding_out({})


@router.patch("/pro/branding")
async def patch_pro_branding(
    inp: BrandingPatch,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    updates: dict = {}
    unsets: dict = {}
    if inp.firm_name is not None:
        name = inp.firm_name.strip()
        if not name:
            unsets["branding.firm_name"] = ""
        else:
            if len(name) > 60:
                raise HTTPException(400, "Private label name must be 60 characters or less.")
            updates["branding.firm_name"] = name
    if inp.theme_preset is not None:
        if inp.theme_preset not in _ALLOWED_PRESETS:
            raise HTTPException(400, f"Unknown theme preset — must be one of {sorted(_ALLOWED_PRESETS)}")
        updates["branding.theme_preset"] = inp.theme_preset
    if inp.signin_subdomain is not None:
        from subdomain_util import validate_subdomain
        sub_raw = inp.signin_subdomain.strip().lower()
        if sub_raw == "":
            updates["branding.signin_subdomain"] = None
        else:
            ok, err, sub = validate_subdomain(sub_raw)
            if not ok:
                raise HTTPException(400, err)
            clash = await db.users.find_one({
                "branding.signin_subdomain": sub,
                "id": {"$ne": user["id"]},
            })
            if clash:
                raise HTTPException(409, f"'{sub}' is already taken.")
            updates["branding.signin_subdomain"] = sub
    if inp.theme_custom is not None:
        # `null` (sent as {} via python bool trick) — clear customization.
        if inp.theme_custom == {}:
            unsets["branding.theme_custom"] = ""
        else:
            cleaned = {}
            for k, v in inp.theme_custom.items():
                if k not in _THEME_TOKENS:
                    raise HTTPException(400, f"Unknown theme token '{k}' — allowed: {sorted(_THEME_TOKENS)}")
                if v is None or v == "":
                    continue
                if not _HEX_COLOR_RE.match(str(v)):
                    raise HTTPException(400, f"Color '{k}' must be a #RRGGBB hex value (got {v!r}).")
                cleaned[k] = str(v).lower()
            if cleaned:
                updates["branding.theme_custom"] = cleaned
            else:
                unsets["branding.theme_custom"] = ""
    mongo_ops: dict = {}
    if updates: mongo_ops["$set"] = updates
    if unsets: mongo_ops["$unset"] = unsets
    if mongo_ops:
        await db.users.update_one({"id": user["id"]}, mongo_ops)
    # If the pro just set/changed their Private Label Name, promote them
    # to their own Enterprise (or rename the existing one). Idempotent.
    if inp.firm_name is not None:
        try:
            import enterprises as _entmod
            await _entmod.ensure_personal_enterprise_for_pro(user["id"])
        except Exception:
            import logging as _lg
            _lg.getLogger(__name__).exception(
                "Failed to spawn personal enterprise on branding save (non-fatal)"
            )
    doc = await db.users.find_one({"id": user["id"]})
    return _branding_out(doc or {})


@router.post("/pro/branding/logo")
async def upload_pro_logo(
    file: UploadFile = File(...),
    variant: str = Form("logo_light"),
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Accept PNG/JPG/SVG/WebP up to 500 KB. Written into
    `branding.logos.<variant>` where variant ∈ {logo_light, logo_dark,
    icon_light, icon_dark}. Only `logo_light` is strictly required; the
    others fall back at render time when unset."""
    if variant not in _LOGO_VARIANTS:
        raise HTTPException(400, f"Unknown variant — must be one of {sorted(_LOGO_VARIANTS)}")
    if file.content_type not in {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}:
        raise HTTPException(400, "Logo must be PNG, JPG, SVG, or WebP.")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    if len(raw) > _MAX_LOGO_BYTES:
        raise HTTPException(400, f"Logo too large — max 500 KB (got {len(raw) // 1024} KB).")
    import base64 as _b64
    data_url = f"data:{file.content_type};base64,{_b64.b64encode(raw).decode('ascii')}"
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {f"branding.logos.{variant}": data_url}},
    )
    doc = await db.users.find_one({"id": user["id"]})
    return {"variant": variant, "logos": _logos_from((doc or {}).get("branding") or {})}


@router.delete("/pro/branding/logo")
async def delete_pro_logo(
    variant: str = "logo_light",
    user: dict = Depends(require_role("pro", "superadmin")),
):
    if variant not in _LOGO_VARIANTS:
        raise HTTPException(400, f"Unknown variant — must be one of {sorted(_LOGO_VARIANTS)}")
    unset = {f"branding.logos.{variant}": ""}
    # Slice-A rows only had `logo_data_url`; if that was the light logo, kill it too.
    if variant == "logo_light":
        unset["branding.logo_data_url"] = ""
    await db.users.update_one({"id": user["id"]}, {"$unset": unset})
    doc = await db.users.find_one({"id": user["id"]})
    return {"variant": variant, "logos": _logos_from((doc or {}).get("branding") or {})}


# ---------------------------------------------------------------------------
# Public branded-login lookup — unauthenticated on purpose. The login page
# hits this with the subdomain from either the hostname (acme.<root>)
# or a `?firm=acme` query param to render the firm's logo/theme before the
# user has any credentials. Root domain configured via PRIVATE_LABEL_ROOT.
# ---------------------------------------------------------------------------

@router.get("/branding/by-subdomain/{sub}")
async def branding_by_subdomain(sub: str):
    from subdomain_util import validate_subdomain
    ok, err, sub_norm = validate_subdomain(sub or "")
    if not ok:
        raise HTTPException(400, err)
    owner = await db.users.find_one({"branding.signin_subdomain": sub_norm})
    if not owner:
        raise HTTPException(404, "No firm registered on that subdomain.")
    b = _branding_out(owner)
    # Never leak owner PII — return only the visual bits + a friendly name.
    return {
        "firm_name": owner.get("name") or owner.get("firm_name") or sub_norm.title(),
        "logos": b["logos"],
        "theme_preset": b["theme_preset"],
        "theme_custom": b["theme_custom"],
    }


@router.get("/branding/by-host")
async def branding_by_host(host: str = Query(..., description="Full hostname (e.g. acme.accountingapp.ai)")):
    """Server-side host → brand resolver.

    Mirrors Rocket Suite's `resolveHostBrand`. Frontend can pass its current
    `window.location.hostname` here to get the correct brand for the sign-in
    gate WITHOUT needing to know the private-label root — that's kept
    server-side so it can change without a frontend rebuild.

    Returns one of three modes:
      • {mode: "platform"}                    — SmartBooks brand
      • {mode: "firm",   firm_name, logos, …} — a firm's white-label brand
      • {mode: "neutral"}                     — bare root or unknown label
    """
    from subdomain_util import PRIMARY_HOST, PRIVATE_LABEL_ROOT, subdomain_from_host
    h = (host or "").split(":", 1)[0].strip().lower()
    if not h:
        return {"mode": "neutral"}
    if h == PRIMARY_HOST:
        return {"mode": "platform"}
    label = subdomain_from_host(h)
    if label:
        owner = await db.users.find_one({"branding.signin_subdomain": label})
        if owner:
            b = _branding_out(owner)
            return {
                "mode": "firm",
                "firm_name": owner.get("name") or owner.get("firm_name") or label.title(),
                "logos": b["logos"],
                "theme_preset": b["theme_preset"],
                "theme_custom": b["theme_custom"],
            }
        # Valid subdomain shape but no firm claims it — neutral, not platform.
        return {"mode": "neutral"}
    if h == PRIVATE_LABEL_ROOT or h.endswith(f".{PRIVATE_LABEL_ROOT}"):
        return {"mode": "neutral"}
    return {"mode": "platform"}


@router.get("/branding/subdomain-available")
async def branding_subdomain_available(
    sub: str = Query(..., description="Candidate subdomain label"),
    user=Depends(get_current_user),
):
    """Live availability check for the Enterprise Settings input. Returns
    {available, reason?, normalized} so the UI can gate the Save button."""
    from subdomain_util import validate_subdomain
    ok, err, norm = validate_subdomain(sub)
    if not ok:
        return {"available": False, "reason": err, "normalized": norm}
    clash = await db.users.find_one({
        "branding.signin_subdomain": norm,
        "id": {"$ne": user["id"]},
    })
    if clash:
        return {"available": False, "reason": f"'{norm}' is already taken.", "normalized": norm}
    return {"available": True, "normalized": norm}


@router.get("/branding/config")
async def branding_config():
    """Public config the frontend needs to render the sign-in gate.

    Currently just the private-label root domain so the ProSettings UI can
    show the correct `.accountingapp.ai` suffix without a rebuild if ops
    changes it later.
    """
    from subdomain_util import PRIMARY_HOST, PRIVATE_LABEL_ROOT
    return {
        "private_label_root": PRIVATE_LABEL_ROOT,
        "primary_host": PRIMARY_HOST,
    }




# --------------------------------------------------------------------------
# Pro Alerts — in-app notification inbox powered by pro_alerts.py.
# Currently populated by the Stripe payment_failed webhook; designed to
# be extended (churn signals, onboarding stalls, unusual AI cost spikes).
# --------------------------------------------------------------------------
from pro_alerts import (  # noqa: E402
    list_alerts,
    unread_count,
    mark_read,
    mark_all_read,
)


@router.get("/pro/alerts")
async def pro_list_alerts(
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Return the current pro's last 50 alerts, newest first, plus the
    unread count so the sidebar badge can render in one round-trip."""
    items = await list_alerts(user["id"], limit=50)
    unread = await unread_count(user["id"])
    return {"items": items, "unread": unread}


@router.post("/pro/alerts/{alert_id}/read")
async def pro_mark_alert_read(
    alert_id: str,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    ok = await mark_read(alert_id, user["id"])
    if not ok:
        raise HTTPException(404, "Alert not found")
    return {"ok": True}


@router.post("/pro/alerts/read-all")
async def pro_mark_all_alerts_read(
    user: dict = Depends(require_role("pro", "superadmin")),
):
    n = await mark_all_read(user["id"])
    return {"ok": True, "marked": n}
