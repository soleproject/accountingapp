"""Affiliate custom pricing — SmartTally affiliates set their own monthly
price (Advanced tier, $130 floor) for a client, invite them by email,
and keep everything above the floor on every paid invoice.

Collection ``affiliate_priced_clients``:
    id, referrer_user_id, firm_slug, name, email, monthly_cents, cadence
    (monthly|annual), trial (bool), tier ("advanced"), floor_cents,
    invite_token, status (invited|signed_up|trialing|paying|canceled),
    user_id, company_id, stripe_subscription_id, created_at, updated_at,
    last_invited_at
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from db import db
from auth import get_current_user

logger = logging.getLogger("axiom.affiliate_pricing")
router = APIRouter(prefix="/api", tags=["affiliate-pricing"])

TIER = "advanced"
TIER_LABEL = "Advanced"
FLOOR_CENTS = int(os.environ.get("CUSTOM_PRICING_FLOOR_CENTS", "13000"))
_ALLOWED_SLUGS = {s.strip().lower() for s in os.environ.get("CUSTOM_PRICING_FIRM_SLUGS", "smarttally").split(",") if s.strip()}
TRIAL_DAYS = 7


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _annual_cents(monthly_cents: int) -> int:
    return monthly_cents * 10


def _firm_slug(firm: dict | None) -> str | None:
    b = (firm or {}).get("branding") or {}
    return (b.get("signin_subdomain") or b.get("subdomain") or b.get("subdomain_slug") or "").strip().lower() or None


async def _eligibility(user: dict) -> dict:
    from routes.auth import _resolve_firm_for_user, _firm_public_info
    firm = await _resolve_firm_for_user(user)
    slug = _firm_slug(firm)
    enabled = bool(slug and slug in _ALLOWED_SLUGS and user.get("role") in ("affiliate", "partner", "superadmin"))
    return {"enabled": enabled, "floor_cents": FLOOR_CENTS, "tier": TIER, "tier_label": TIER_LABEL,
            "trial_days": TRIAL_DAYS, "firm": _firm_public_info(firm), "firm_slug": slug}


async def _require_enabled(user: dict) -> dict:
    elig = await _eligibility(user)
    if not elig["enabled"]:
        raise HTTPException(403, "Custom pricing isn't enabled for your firm.")
    return elig


def _public(doc: dict) -> dict:
    d = {k: v for k, v in doc.items() if k not in ("_id", "invite_token")}
    d["annual_cents"] = _annual_cents(doc["monthly_cents"])
    d["margin_cents"] = max(0, doc["monthly_cents"] - doc.get("floor_cents", FLOOR_CENTS))
    return d


async def _refresh_status(doc: dict) -> dict:
    """Derive live status from the linked company's Stripe state."""
    status = doc.get("status") or "invited"
    if doc.get("company_id"):
        c = await db.companies.find_one({"id": doc["company_id"]}, {"sub_status": 1, "billing_state": 1, "stripe_subscription_id": 1, "sub_trial_end": 1, "sub_amount_cents": 1})
        if c:
            ss, bs = c.get("sub_status"), c.get("billing_state")
            if ss == "trialing":
                status = "trialing"
            elif ss in ("canceled", "unpaid", "incomplete_expired") or bs == "canceled":
                status = "canceled"
            elif c.get("stripe_subscription_id") and (ss == "active" or bs == "active"):
                status = "paying"
            elif not c.get("stripe_subscription_id"):
                status = "signed_up"
            doc["trial_end"] = c.get("sub_trial_end")
            if c.get("stripe_subscription_id") and not doc.get("stripe_subscription_id"):
                doc["stripe_subscription_id"] = c["stripe_subscription_id"]
                await db.affiliate_priced_clients.update_one({"id": doc["id"]}, {"$set": {"stripe_subscription_id": c["stripe_subscription_id"]}})
    elif doc.get("user_id"):
        status = "signed_up"
    if status != doc.get("status"):
        await db.affiliate_priced_clients.update_one({"id": doc["id"]}, {"$set": {"status": status}})
        doc["status"] = status
    return doc


# ---------------------------------------------------------------- invite email
async def _send_invite(doc: dict, affiliate: dict, firm: dict | None) -> None:
    from email_dispatcher import dispatch, public_base_url
    from affiliate_emails import _body, h, p, btn, box, small
    firm_name = ((firm or {}).get("branding") or {}).get("firm_name") or (firm or {}).get("firm_name") or "SmartTally"
    slug = _firm_slug(firm)
    base = public_base_url(slug).rstrip("/")
    from urllib.parse import urlencode
    link = f"{base}/signup?" + urlencode({"invite": doc["invite_token"], "email": doc["email"], "name": doc["name"],
                                          "ref": affiliate.get("referral_slug") or ""})
    monthly = f"${doc['monthly_cents'] / 100:,.2f}"
    annual = f"${_annual_cents(doc['monthly_cents']) / 100:,.2f}"
    aff_name = affiliate.get("name") or "Your advisor"
    first = (doc["name"] or "").split()[0] if doc.get("name") else "there"
    trial_line = (f"Start with a {TRIAL_DAYS}-day free trial — your card isn't charged until the trial ends."
                  if doc.get("trial") else "Your subscription starts as soon as you check out.")
    html = _body(
        h(f"{aff_name} set you up with {firm_name} {TIER_LABEL}"),
        p(f"Hi {first},"),
        p(f"{aff_name} has arranged {firm_name}'s <b>{TIER_LABEL}</b> plan for your business at a custom rate:"),
        box(f"<div style='font-size:22px;font-weight:700'>{monthly}<span style='font-size:13px;font-weight:400;color:#64748b'> / month</span></div>"
            f"<div style='font-size:12px;color:#64748b;margin-top:4px'>or {annual} / year (2 months free)</div>"),
        p(trial_line),
        btn("Create my account", link),
        small(f"This link is for {doc['email']}. Questions? Reply to this email and {aff_name} will follow up."),
        brand=firm_name,
    )
    res = await dispatch(kind="affiliate_custom_price_invite", to=doc["email"],
                         subject=f"{aff_name} set up your {firm_name} {TIER_LABEL} plan — {monthly}/mo",
                         html=html, initiating_user_id=affiliate["id"],
                         related={"priced_client_id": doc["id"], "firm_slug": slug},
                         firm_name_override=firm_name)
    if res.get("status") != "sent":
        raise HTTPException(502, f"Invite email could not be sent: {res.get('error') or res.get('status')}")
    return {"link": link, "resend_id": res.get("resend_id")}


# ---------------------------------------------------------------- endpoints
@router.get("/affiliate/custom-pricing/eligibility")
async def custom_pricing_eligibility(user: dict = Depends(get_current_user)):
    return await _eligibility(user)


@router.get("/affiliate/custom-pricing/clients")
async def list_priced_clients(user: dict = Depends(get_current_user)):
    elig = await _require_enabled(user)
    rows = await db.affiliate_priced_clients.find({"referrer_user_id": user["id"]}).sort("created_at", -1).to_list(500)
    out = [_public(await _refresh_status(r)) for r in rows]
    paying = [r for r in out if r["status"] in ("paying", "trialing")]
    return {"clients": out, "floor_cents": elig["floor_cents"], "tier_label": TIER_LABEL,
            "summary": {"count": len(out), "active": len(paying),
                        "margin_month_cents": sum(r["margin_cents"] for r in out if r["status"] == "paying")}}


class PricedClientIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr
    monthly_cents: int = Field(..., ge=0)
    cadence: str = "monthly"
    trial: bool = True


@router.post("/affiliate/custom-pricing/clients")
async def create_priced_client(inp: PricedClientIn, user: dict = Depends(get_current_user)):
    elig = await _require_enabled(user)
    if inp.monthly_cents < FLOOR_CENTS:
        raise HTTPException(400, f"Price must be at least ${FLOOR_CENTS / 100:,.0f}/mo.")
    cadence = inp.cadence if inp.cadence in ("monthly", "annual") else "monthly"
    email = inp.email.lower().strip()
    if await db.affiliate_priced_clients.find_one({"email": email, "referrer_user_id": user["id"], "status": {"$ne": "canceled"}}):
        raise HTTPException(409, "You already added this client.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "That email already has an account — custom pricing only applies to new signups.")
    now = _now()
    doc = {"id": str(uuid.uuid4()), "referrer_user_id": user["id"], "firm_slug": elig["firm_slug"],
           "name": inp.name.strip(), "email": email, "monthly_cents": int(inp.monthly_cents), "cadence": cadence,
           "trial": bool(inp.trial), "tier": TIER, "floor_cents": FLOOR_CENTS, "invite_token": uuid.uuid4().hex,
           "status": "invited", "user_id": None, "company_id": None, "stripe_subscription_id": None,
           "created_at": now, "updated_at": now, "last_invited_at": now}
    await db.affiliate_priced_clients.insert_one(doc)
    if not await db.leads.find_one({"email": email, "referrer_user_id": user["id"]}):
        await db.leads.insert_one({"id": str(uuid.uuid4()), "name": doc["name"], "email": email, "role": "business_owner",
                                   "phone": None, "company_name": None, "ref_slug": user.get("referral_slug"),
                                   "referrer_user_id": user["id"], "notes": f"Custom price ${inp.monthly_cents / 100:,.2f}/mo ({TIER_LABEL})",
                                   "status": "contacted", "source": "custom_pricing", "activities": [], "created_at": now, "last_seen_at": now})
    from routes.auth import _resolve_firm_for_user
    firm = await _resolve_firm_for_user(user)
    email_status, email_error = "sent", None
    try:
        await _send_invite(doc, user, firm)
    except HTTPException as e:
        email_status, email_error = "failed", str(e.detail)
    except Exception as e:  # noqa: BLE001
        logger.exception("custom-price invite email failed for %s", email)
        email_status, email_error = "failed", str(e)
    return {"ok": True, "client": _public(doc), "email_status": email_status, "email_error": email_error}


@router.post("/affiliate/custom-pricing/clients/{pid}/resend")
async def resend_priced_invite(pid: str, user: dict = Depends(get_current_user)):
    await _require_enabled(user)
    doc = await db.affiliate_priced_clients.find_one({"id": pid, "referrer_user_id": user["id"]})
    if not doc:
        raise HTTPException(404, "Client not found")
    if doc.get("user_id"):
        raise HTTPException(400, "This client already signed up.")
    from routes.auth import _resolve_firm_for_user
    await _send_invite(doc, user, await _resolve_firm_for_user(user))
    await db.affiliate_priced_clients.update_one({"id": pid}, {"$set": {"last_invited_at": _now()}})
    return {"ok": True}


class PriceUpdateIn(BaseModel):
    monthly_cents: int = Field(..., ge=0)


@router.patch("/affiliate/custom-pricing/clients/{pid}")
async def update_priced_client(pid: str, inp: PriceUpdateIn, user: dict = Depends(get_current_user)):
    await _require_enabled(user)
    if inp.monthly_cents < FLOOR_CENTS:
        raise HTTPException(400, f"Price must be at least ${FLOOR_CENTS / 100:,.0f}/mo.")
    doc = await db.affiliate_priced_clients.find_one({"id": pid, "referrer_user_id": user["id"]})
    if not doc:
        raise HTTPException(404, "Client not found")
    doc = await _refresh_status(doc)
    sub_id = doc.get("stripe_subscription_id")
    proration = None
    if sub_id and doc["status"] in ("trialing", "paying"):
        proration = "none" if doc["status"] == "trialing" else "create_prorations"
        try:
            doc["cadence"] = await asyncio.to_thread(_update_subscription_price, sub_id, inp.monthly_cents, doc.get("cadence") or "monthly", proration)
        except stripe.error.StripeError as e:
            raise HTTPException(502, f"Stripe error: {e.user_message or str(e)}")
        if doc.get("company_id"):
            await db.companies.update_one({"id": doc["company_id"]}, {"$set": {
                "sub_amount_cents": inp.monthly_cents if doc.get("cadence") != "annual" else _annual_cents(inp.monthly_cents),
                "updated_at": _now()}})
    await db.affiliate_priced_clients.update_one({"id": pid}, {"$set": {"monthly_cents": int(inp.monthly_cents), "cadence": doc.get("cadence") or "monthly", "updated_at": _now()}})
    doc["monthly_cents"] = int(inp.monthly_cents)
    return {"ok": True, "client": _public(doc), "proration": proration}


def _price_data(monthly_cents: int, cadence: str, firm_name: str = "SmartTally") -> dict:
    annual = cadence == "annual"
    return {"currency": "usd", "unit_amount": _annual_cents(monthly_cents) if annual else monthly_cents,
            "recurring": {"interval": "year" if annual else "month"},
            "product_data": {"name": f"{TIER_LABEL} ({firm_name})", "metadata": {"billing_product": TIER}}}


def _update_subscription_price(sub_id: str, monthly_cents: int, cadence: str, proration: str) -> str:
    sub = stripe.Subscription.retrieve(sub_id)
    item = sub["items"]["data"][0]
    live_interval = ((item.get("price") or {}).get("recurring") or {}).get("interval")
    cadence = "annual" if live_interval == "year" else "monthly" if live_interval == "month" else cadence
    stripe.Subscription.modify(sub_id, items=[{"id": item["id"], "price_data": _price_data(monthly_cents, cadence)}],
                               proration_behavior=proration)
    return cadence


# ---------------------------------------------------------------- public + hooks
@router.get("/public/custom-pricing/invite/{token}")
async def public_invite(token: str):
    doc = await db.affiliate_priced_clients.find_one({"invite_token": token})
    if not doc:
        raise HTTPException(404, "Invite not found")
    aff = await db.users.find_one({"id": doc["referrer_user_id"]}, {"name": 1, "referral_slug": 1})
    return {"name": doc["name"], "email": doc["email"], "monthly_cents": doc["monthly_cents"],
            "annual_cents": _annual_cents(doc["monthly_cents"]), "cadence": doc["cadence"], "trial": doc["trial"],
            "tier": TIER, "tier_label": TIER_LABEL, "trial_days": TRIAL_DAYS, "firm_slug": doc.get("firm_slug"),
            "affiliate_name": (aff or {}).get("name"), "ref": (aff or {}).get("referral_slug"),
            "already_used": bool(doc.get("user_id"))}


async def attach_signup(user_id: str, email: str, invite_token: str | None) -> dict | None:
    """Called from /auth/signup: link the new user to their priced invite."""
    q = {"invite_token": invite_token} if invite_token else {"email": email.lower(), "status": "invited"}
    doc = await db.affiliate_priced_clients.find_one(q)
    if not doc or doc.get("user_id"):
        return None
    await db.affiliate_priced_clients.update_one({"id": doc["id"]}, {"$set": {"user_id": user_id, "status": "signed_up", "updated_at": _now()}})
    return doc


async def for_company(company: dict) -> dict | None:
    """Priced-client doc for a company (by linked company_id, else owner)."""
    doc = await db.affiliate_priced_clients.find_one({"company_id": company["id"]})
    if not doc and company.get("owner_user_id"):
        doc = await db.affiliate_priced_clients.find_one({"user_id": company["owner_user_id"], "company_id": None, "status": {"$ne": "canceled"}})
        if doc:
            await db.affiliate_priced_clients.update_one({"id": doc["id"]}, {"$set": {"company_id": company["id"], "updated_at": _now()}})
            doc["company_id"] = company["id"]
    return doc


def custom_share_cents(doc: dict, gross_cents: int) -> tuple[int, int]:
    floor = doc.get("floor_cents", FLOOR_CENTS) * (10 if doc.get("cadence") == "annual" else 1)
    share = max(0, gross_cents - floor)
    bps = int(round(share * 10_000 / gross_cents)) if gross_cents else 0
    return share, bps
