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
async def pro_clients(user: dict = Depends(require_role("pro", "superadmin", "partner"))):
    # Only ACTIVE pro memberships — archived staff shouldn't see their
    # former client list. Superadmins are unaffected (they get every
    # company below).
    ms = await db.memberships.find({
        "user_id": user["id"], "role": "pro",
        "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}],
    }).to_list(1000)
    company_ids = [m["company_id"] for m in ms]
    if user["role"] == "superadmin":
        companies = await db.companies.find({}).to_list(1000)
    else:
        companies = await db.companies.find({"id": {"$in": company_ids}}).to_list(1000)
    if not companies:
        return {"clients": []}
    all_cids = [c["id"] for c in companies]
    # Batch the owner lookup + transaction counts so /pro/clients scales
    # cleanly past 200 clients — one aggregate per collection instead of
    # 2N round-trips.
    owner_memberships = await db.memberships.find(
        {"company_id": {"$in": all_cids}, "role": "owner"}
    ).to_list(2000)
    owner_by_cid: dict[str, dict] = {}
    owner_ids = list({m["user_id"] for m in owner_memberships})
    owner_users = {
        u["id"]: u for u in
        await db.users.find({"id": {"$in": owner_ids}}, {"_id": 0, "id": 1, "email": 1, "name": 1}).to_list(2000)
    }
    for m in owner_memberships:
        if m["company_id"] not in owner_by_cid:
            owner_by_cid[m["company_id"]] = owner_users.get(m["user_id"]) or {}
    result = []
    for c in companies:
        # Kept the per-company count queries — they're indexed on
        # company_id and Motor pipelines them concurrently anyway.
        txn_count = await db.transactions.count_documents({"company_id": c["id"]})
        needs_review = await db.transactions.count_documents({"company_id": c["id"], "needs_review": True})
        owner = owner_by_cid.get(c["id"]) or {}
        result.append({
            "id": c["id"], "name": c["name"], "business_type": c.get("business_type", ""),
            "onboarding_complete": c.get("onboarding_complete", False),
            "transactions": txn_count, "needs_review": needs_review,
            # Owner snapshot — used by the client-list search + list view.
            # Stripped to the minimum PII needed for the UI (no phone, no
            # settings blob) so the response stays lightweight.
            "owner_name": owner.get("name"),
            "owner_email": owner.get("email"),
            "billing_payer": c.get("billing_payer"),
            "billing_state": c.get("billing_state"),
            "needs_activation": (
                c.get("billing_payer") == "client_email"
                and (c.get("billing_state") or "pending") == "pending"
            ),
        })
    return {"clients": result}


@router.get("/pro/clients/lookup")
async def pro_lookup_client(email: str, user: dict = Depends(require_role("pro", "superadmin", "partner"))):
    """Lightweight probe used by the New-Client dialog to detect whether the
    given email already belongs to a client user. Only reveals name — never
    password / other PII. Returns {exists: bool, name: str|null}.
    """
    u = await db.users.find_one({"email": (email or "").strip().lower(), "role": "client"})
    if not u:
        return {"exists": False, "name": None}
    return {"exists": True, "name": u.get("name")}


@router.get("/pro/billing/context")
async def pro_billing_context(user: dict = Depends(require_role("pro", "superadmin", "partner"))):
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
async def pro_create_client(inp: NewClientIn, user: dict = Depends(require_role("pro", "superadmin", "partner"))):
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
    # Snap the entity type to one of the seven canonical forms.
    from routes.onboarding import _canonicalize_business_type as _canon_bt
    _bt = _canon_bt(inp.business_type) or inp.business_type
    await db.companies.insert_one({
        "id": company_id, "name": inp.company_name,
        "business_type": _bt, "business_description": inp.business_description,
        "reporting_basis": inp.reporting_basis,
        "owner_user_id": client_id, "pro_user_id": user["id"],
        # Partner stamp — when the caller is a Partner, we tag the
        # company so the Partner's dashboard rollups + scoping filters
        # find it. Pros/Superadmins never set this so their clients
        # remain in the platform-wide bucket.
        **({"partner_id": user["id"]} if user.get("role") == "partner" else {}),
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
    if not inp.send_welcome_email:
        # Enterprise/pro opted out of the welcome email at create time.
        # We still return 200 + the created company; the pro can send the
        # welcome later via `POST /pro/clients/{cid}/resend-welcome`.
        email_status = "skipped_by_pro"
    else:
      try:
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        from routes.auth import mint_password_set_token

        pro_name = user.get("full_name") or user.get("name") or user.get("email") or "Your accountant"
        firm_name = (user.get("branding") or {}).get("firm_name") or None
        firm_slug = (user.get("branding") or {}).get("signin_subdomain") or None
        # Base URL flips to the firm's private-label subdomain
        # (e.g. `https://priyabooks.accountingapp.ai`) when the Pro has
        # a signin_subdomain AND the PRIVATE_LABEL_HOST_TEMPLATE env is
        # configured. Otherwise falls back to the platform URL. The
        # `?firm={slug}` param is still appended so preview environments
        # (or Pros whose subdomain isn't provisioned yet) still resolve
        # the firm brand via the hostname-independent query lookup.
        base = public_base_url(firm_slug)

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
async def resend_welcome_email(cid: str, user: dict = Depends(require_role("pro", "superadmin", "partner"))):
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

    pro_name = user.get("full_name") or user.get("name") or user.get("email") or "Your accountant"
    firm_name = (user.get("branding") or {}).get("firm_name") or None
    firm_slug = (user.get("branding") or {}).get("signin_subdomain") or None
    base = public_base_url(firm_slug)

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
    # ---- Sign-in page options -----------------------------------------
    # When True, the seeded "Demo Accounts" block on the sign-in page is
    # hidden for anyone landing on this firm's private-label host. Useful
    # once the firm has real end-users so the demo shortcut doesn't leak.
    hide_demo_accounts: Optional[bool] = None
    # When True, the "No account? Create one" link is hidden — for firms
    # that only onboard clients by invite (magic-link flow).
    hide_signup_link: Optional[bool] = None
    # Optional replacement for the default "Welcome back. Let's get to the
    # numbers." tagline under the Sign-in heading. Max 120 chars. Empty
    # string clears the override and restores the default.
    signin_tagline: Optional[str] = None
    # Optional replacement for the SmartBooks marketing hero on the left
    # half of the login page. Accepts a data URL (`data:image/...`) or a
    # regular https URL. Empty string clears.
    signin_hero_image: Optional[str] = None
    # Optional destination for the affiliate "Refer & earn" link. When
    # set, the referral link becomes ``{buy_page_url}?ref=<slug>`` — the
    # firm sends prospects straight to their own pricing / checkout page.
    # Empty string clears and falls back to the platform signup route.
    buy_page_url: Optional[str] = None


def _logos_from(b: dict) -> dict:
    """Return the 4-slot logo dict, migrating legacy `logo_data_url` on read."""
    logos = dict(b.get("logos") or {})
    if not logos.get("logo_light") and b.get("logo_data_url"):
        logos["logo_light"] = b["logo_data_url"]
    # Always emit all 4 keys — makes the frontend simpler.
    return {k: logos.get(k) for k in ["logo_light", "logo_dark", "icon_light", "icon_dark"]}


def _whitelabel_state(user_doc: dict) -> dict:
    """Compute white-label unlock state for a pro. Comp (granted by
    superadmin) takes precedence over Paid so a comped firm never gets
    downgraded even after their subscription lapses.

    Returns::

        {
            "whitelabel_unlocked": bool,
            "whitelabel_source":   "comp" | "paid" | None,
            "whitelabel_comp":     bool,
            "whitelabel_paid":     bool,
        }
    """
    b = (user_doc or {}).get("branding") or {}
    comp = bool(b.get("whitelabel_comp"))
    paid = bool(b.get("whitelabel_paid"))
    src = "comp" if comp else ("paid" if paid else None)
    return {
        "whitelabel_unlocked": comp or paid,
        "whitelabel_source": src,
        "whitelabel_comp": comp,
        "whitelabel_paid": paid,
    }


def _branding_out(user_doc: dict) -> dict:
    b = (user_doc or {}).get("branding") or {}
    fallback = (user_doc or {}).get("name") or None
    stored = b.get("firm_name") or None
    wl = _whitelabel_state(user_doc)
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
        "hide_demo_accounts": bool(b.get("hide_demo_accounts")),
        "hide_signup_link": bool(b.get("hide_signup_link")),
        "signin_tagline": b.get("signin_tagline") or "",
        "signin_hero_image": b.get("signin_hero_image") or "",
        "buy_page_url": b.get("buy_page_url") or "",
        # White-label gate — every editable branding field except `buy_page_url`
        # (which is affiliate-facing) is off-limits until this flips true,
        # either by a Superadmin comp grant or a successful Stripe payment.
        **wl,
    }


@router.get("/pro/branding")
async def get_pro_branding(user: dict = Depends(require_role("pro", "superadmin", "partner"))):
    doc = await db.users.find_one({"id": user["id"]})
    return _branding_out(doc or {})


@router.get("/branding/effective")
async def get_effective_branding(user: dict = Depends(get_current_user)):
    """Return the branding the current user should SEE (as opposed to
    edit).

    Cascade (specific → general):
      1. Pro / Partner / Superadmin — always see their OWN branding.
      2. Client / Enterprise-owner user — walks:
           a) Enterprise brand — if their managing pro has an
              `enterprise_id` and that enterprise's owner has WL
              unlocked, return the enterprise owner's branding.
           b) Partner brand — if the company was provisioned by a
              Partner (company.partner_id set) and the Partner has WL
              unlocked, return the Partner's branding.
           c) Pro brand — existing behaviour: the managing pro's own
              branding, if their WL is unlocked.
           d) Platform default (empty) — no override anywhere in the
              chain.

    Rationale: each tier can opt out (turn WL off) and gracefully falls
    through to the next. Guarantees a client of a private-labelled
    Enterprise sees THAT enterprise's brand, and a client of a
    non-private-labelled Enterprise-under-Partner sees the Partner's
    brand, and everyone else sees SmartBooks.
    """
    if user.get("role") in {"pro", "superadmin", "partner"}:
        doc = await db.users.find_one({"id": user["id"]}) or {}
        # Pros that live under a Partner cascade to the Partner's
        # branding when their OWN white-label isn't unlocked. This
        # matches the client-user cascade: "specific over general"
        # (Pro's own → Partner → Platform), just for the tier one
        # level up. Partners and Superadmins always return their own
        # (they ARE the brand source).
        if user.get("role") == "pro":
            own_wl = _whitelabel_state(doc).get("whitelabel_unlocked")
            if not own_wl:
                # Two paths to a Partner: directly on the Pro
                # (`partner_id`) or via the Enterprise the Pro owns
                # (`enterprise.partner_id`). Both stamped at
                # provisioning time.
                partner_uid = doc.get("partner_id")
                if not partner_uid and doc.get("enterprise_id"):
                    ent = await db.enterprises.find_one({"id": doc["enterprise_id"]})
                    partner_uid = (ent or {}).get("partner_id")
                if partner_uid:
                    partner_doc = await db.users.find_one({
                        "id": partner_uid, "role": "partner",
                    })
                    if partner_doc and _whitelabel_state(partner_doc).get("whitelabel_unlocked"):
                        return _branding_out(partner_doc)
        return _branding_out(doc)

    # Owner / client-user — walk the cascade.
    memberships = await db.memberships.find({"user_id": user["id"]}).to_list(200)
    company_ids = [m["company_id"] for m in memberships if m.get("company_id")]
    if not company_ids:
        return _branding_out({})

    # Load the most-recently-updated company the user belongs to as the
    # "primary" — matches the transaction-scoping default we use
    # elsewhere. Also carries partner_id + enterprise_id if set.
    company = await db.companies.find_one(
        {"id": {"$in": company_ids}},
        sort=[("updated_at", -1)],
    ) or {}

    # 1) Enterprise brand — via the managing pro's enterprise_id.
    pro_ms = await db.memberships.find({
        "company_id": {"$in": company_ids},
        "role": "pro",
    }).sort("created_at", -1).to_list(50)
    managing_pro = None
    for pm in pro_ms:
        p = await db.users.find_one({"id": pm["user_id"]})
        if p:
            managing_pro = p
            break

    if managing_pro and managing_pro.get("enterprise_id"):
        ent = await db.enterprises.find_one({"id": managing_pro["enterprise_id"]})
        if ent and ent.get("owner_user_id"):
            ent_owner = await db.users.find_one({"id": ent["owner_user_id"]})
            if ent_owner and _whitelabel_state(ent_owner).get("whitelabel_unlocked"):
                return _branding_out(ent_owner)

    # 2) Partner brand — via company.partner_id (stamped at create-time
    #    for any company a Partner provisioned). Falls through to the
    #    pro branding if the Partner hasn't unlocked WL yet.
    if company.get("partner_id"):
        partner_doc = await db.users.find_one({
            "id": company["partner_id"], "role": "partner",
        })
        if partner_doc and _whitelabel_state(partner_doc).get("whitelabel_unlocked"):
            return _branding_out(partner_doc)

    # 3) Pro brand — the historical fallback. Returns pro branding
    #    even if WL isn't unlocked (so the firm_name in the tab title
    #    still shows something friendly). If your pro has WL locked,
    #    the returned `whitelabel_unlocked: false` disables editable
    #    fields on the client side but the display name still renders.
    if managing_pro:
        return _branding_out(managing_pro)

    # 4) Platform default.
    return _branding_out({})


@router.post("/pro/branding/whitelabel-waitlist")
async def whitelabel_waitlist(user: dict = Depends(require_role("pro", "superadmin", "partner"))):
    """One-click "I want white-label" interest capture. Records the
    firm owner + timestamp on ``users.branding.whitelabel_waitlist_at``
    so a superadmin can pull the list before enabling the payment
    block. Idempotent — repeated clicks refresh the timestamp rather
    than erroring out."""
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"branding.whitelabel_waitlist_at": now_iso()}},
    )
    return {"joined": True}



@router.patch("/pro/branding")
async def patch_pro_branding(
    inp: BrandingPatch,
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    # ------------------------------------------------------------------
    # White-label gate — every branding field EXCEPT the affiliate
    # ``buy_page_url`` is locked until the firm is unlocked (Superadmin
    # comp or Stripe-paid). Superadmins editing their own tenant bypass.
    # ------------------------------------------------------------------
    _wl_gated_fields = {
        "firm_name", "signin_subdomain", "theme_preset", "theme_custom",
        "hide_demo_accounts", "hide_signup_link", "signin_tagline",
        "signin_hero_image",
    }
    requested = {k for k in inp.dict(exclude_unset=True).keys()
                 if k in _wl_gated_fields}
    if requested and user.get("role") != "superadmin":
        me = await db.users.find_one({"id": user["id"]})
        if not _whitelabel_state(me).get("whitelabel_unlocked"):
            raise HTTPException(
                402,
                "White-label is locked on your firm. Upgrade to unlock branding, "
                "or ask an admin to comp your account.",
            )
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
    if inp.hide_demo_accounts is not None:
        updates["branding.hide_demo_accounts"] = bool(inp.hide_demo_accounts)
    if inp.hide_signup_link is not None:
        updates["branding.hide_signup_link"] = bool(inp.hide_signup_link)
    if inp.signin_tagline is not None:
        t = inp.signin_tagline.strip()
        if not t:
            unsets["branding.signin_tagline"] = ""
        else:
            if len(t) > 120:
                raise HTTPException(400, "Sign-in tagline must be 120 characters or less.")
            updates["branding.signin_tagline"] = t
    if inp.signin_hero_image is not None:
        img = inp.signin_hero_image.strip()
        if not img:
            unsets["branding.signin_hero_image"] = ""
        else:
            if not (img.startswith("data:image/") or img.startswith("https://")):
                raise HTTPException(400, "Hero image must be an https URL or a data:image/... URL.")
            # Cap data-URL length to keep the user doc small (~2 MB base64).
            if len(img) > 2_800_000:
                raise HTTPException(400, "Hero image is too large — keep under ~2 MB.")
            updates["branding.signin_hero_image"] = img
    if inp.buy_page_url is not None:
        url = inp.buy_page_url.strip()
        if not url:
            unsets["branding.buy_page_url"] = ""
        else:
            if not (url.startswith("http://") or url.startswith("https://")):
                raise HTTPException(400, "Buy page URL must start with http:// or https://")
            if len(url) > 500:
                raise HTTPException(400, "Buy page URL must be 500 characters or less.")
            updates["branding.buy_page_url"] = url
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
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    """Accept PNG/JPG/SVG/WebP up to 500 KB. Written into
    `branding.logos.<variant>` where variant ∈ {logo_light, logo_dark,
    icon_light, icon_dark}. Only `logo_light` is strictly required; the
    others fall back at render time when unset."""
    if user.get("role") != "superadmin":
        me = await db.users.find_one({"id": user["id"]})
        if not _whitelabel_state(me).get("whitelabel_unlocked"):
            raise HTTPException(402, "White-label is locked — upload logos after unlocking.")
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
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    if user.get("role") != "superadmin":
        me = await db.users.find_one({"id": user["id"]})
        if not _whitelabel_state(me).get("whitelabel_unlocked"):
            raise HTTPException(402, "White-label is locked — nothing to remove.")
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
        "hide_demo_accounts": b["hide_demo_accounts"],
        "hide_signup_link": b["hide_signup_link"],
        "signin_tagline": b["signin_tagline"],
        "signin_hero_image": b["signin_hero_image"],
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
                "hide_demo_accounts": b["hide_demo_accounts"],
                "hide_signup_link": b["hide_signup_link"],
                "signin_tagline": b["signin_tagline"],
                "signin_hero_image": b["signin_hero_image"],
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
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    """Return the current pro's last 50 alerts, newest first, plus the
    unread count so the sidebar badge can render in one round-trip."""
    items = await list_alerts(user["id"], limit=50)
    unread = await unread_count(user["id"])
    return {"items": items, "unread": unread}


@router.post("/pro/alerts/{alert_id}/read")
async def pro_mark_alert_read(
    alert_id: str,
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    ok = await mark_read(alert_id, user["id"])
    if not ok:
        raise HTTPException(404, "Alert not found")
    return {"ok": True}


@router.post("/pro/alerts/read-all")
async def pro_mark_all_alerts_read(
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    n = await mark_all_read(user["id"])
    return {"ok": True, "marked": n}


# ── Insights cost alerts (per-firm threshold, per-client watch) ──────
#
# The firm sets a monthly spend threshold (in USD) on their profile;
# any client whose current-month Insights spend crosses the threshold
# is surfaced as a warning tile on the Pro's Clients page so the firm
# can proactively raise the client's cap or investigate runaway usage
# before the client hits their own hard block.

class InsightsCostAlertConfigIn(BaseModel):
    threshold_usd: float = Field(ge=0, le=10000)


def _current_period() -> str:
    from datetime import date as _d
    return _d.today().strftime("%Y-%m")


@router.get("/pro/insights-cost-alerts/config")
async def get_insights_cost_alert_config(
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    """Return the firm's per-client Insights-spend threshold. `0` means
    the alert tile is disabled (no threshold set)."""
    doc = await db.users.find_one({"id": user["id"]}, {"insights_alert_threshold_usd": 1}) or {}
    return {"threshold_usd": float(doc.get("insights_alert_threshold_usd") or 0)}


@router.patch("/pro/insights-cost-alerts/config")
async def patch_insights_cost_alert_config(
    inp: InsightsCostAlertConfigIn,
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    """Save the firm's per-client Insights-spend threshold. Set to 0 to
    disable the warning tile entirely."""
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"insights_alert_threshold_usd": float(inp.threshold_usd),
                  "updated_at": now_iso()}},
    )
    return {"threshold_usd": float(inp.threshold_usd)}


@router.get("/pro/insights-cost-alerts")
async def list_insights_cost_alerts(
    threshold_usd: Optional[float] = Query(None, ge=0, le=10000),
    user: dict = Depends(require_role("pro", "superadmin", "partner")),
):
    """Return every client whose current-month Insights spend meets or
    exceeds the firm's configured threshold.

    Response:
      {
        "period": "YYYY-MM",
        "threshold_usd": 5.0,
        "clients_over": [
          {"id", "name", "spent", "over_by"},
          ...
        ]
      }
    """
    # Resolve threshold: query override → firm's saved setting → 0.
    if threshold_usd is None:
        cfg = await db.users.find_one({"id": user["id"]}, {"insights_alert_threshold_usd": 1}) or {}
        threshold = float(cfg.get("insights_alert_threshold_usd") or 0)
    else:
        threshold = float(threshold_usd)

    period = _current_period()

    # Pro sees only their assigned clients; superadmin sees everyone.
    if user["role"] == "superadmin":
        companies = await db.companies.find(
            {}, {"id": 1, "name": 1, "insights_spend": 1}
        ).to_list(2000)
    else:
        ms = await db.memberships.find({
            "user_id": user["id"], "role": "pro",
            "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}],
        }).to_list(2000)
        cids = [m["company_id"] for m in ms]
        if not cids:
            return {"period": period, "threshold_usd": threshold, "clients_over": []}
        companies = await db.companies.find(
            {"id": {"$in": cids}}, {"id": 1, "name": 1, "insights_spend": 1}
        ).to_list(2000)

    rows: list[dict] = []
    for c in companies:
        spend_map = c.get("insights_spend") or {}
        spent = float(spend_map.get(period) or 0)
        # A threshold of 0 means "alerts disabled" — never flag anyone.
        if threshold > 0 and spent >= threshold:
            rows.append({
                "id": c["id"],
                "name": c.get("name") or "(unnamed)",
                "spent": round(spent, 4),
                "over_by": round(spent - threshold, 4),
            })

    rows.sort(key=lambda r: r["spent"], reverse=True)
    return {"period": period, "threshold_usd": threshold, "clients_over": rows}
