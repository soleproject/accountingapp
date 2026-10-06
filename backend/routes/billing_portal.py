"""Stripe Customer Portal for existing subscribers (plan switch w/ proration, card, invoices).

Deep-links straight to the "confirm plan change" screen when a target plan is given.
The existing `customer.subscription.updated` webhook maps the new price → billing_product.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user
from db import db, now_iso
from routes.stripe_billing import _price_id, _plan_from_price_id

log = logging.getLogger("axiom.billing.portal")
router = APIRouter(prefix="/api")

_PLANS = ("simple_start", "assistant", "bookkeeper", "advanced")
_CFG_TAG = "smartbooks_plan_portal_v1"


class PortalIn(BaseModel):
    origin_url: Optional[str] = None
    return_path: Optional[str] = "/accounting/transactions"
    target_product: Optional[str] = None
    cadence: Optional[str] = None


async def _portal_configuration_id() -> Optional[str]:
    """Managed portal config that allows switching between our 4 plans. Cached per Stripe key."""
    key_tag = (os.environ.get("STRIPE_SECRET_KEY") or "")[-8:]
    cached = await db.app_settings.find_one({"key": "stripe_portal_config", "stripe_key_tag": key_tag})
    if cached and cached.get("configuration_id"):
        return cached["configuration_id"]
    try:
        for cfg in stripe.billing_portal.Configuration.list(limit=20, active=True).auto_paging_iter():
            if (cfg.get("metadata") or {}).get("managed_by") == _CFG_TAG:
                await db.app_settings.update_one({"key": "stripe_portal_config", "stripe_key_tag": key_tag},
                                                 {"$set": {"configuration_id": cfg["id"], "updated_at": now_iso()}}, upsert=True)
                return cfg["id"]
        products: dict[str, list[str]] = {}
        for plan in _PLANS:
            for cad in ("monthly", "annual"):
                pid = _price_id(plan, False, cad)
                if not pid:
                    continue
                price = stripe.Price.retrieve(pid)
                prod = price["product"] if isinstance(price["product"], str) else price["product"]["id"]
                products.setdefault(prod, []).append(pid)
        if not products:
            return None
        cfg = stripe.billing_portal.Configuration.create(
            business_profile={"headline": "Manage your plan"},
            features={
                "subscription_update": {"enabled": True, "default_allowed_updates": ["price"],
                                        "proration_behavior": "create_prorations",
                                        "products": [{"product": p, "prices": prices} for p, prices in products.items()]},
                "payment_method_update": {"enabled": True},
                "invoice_history": {"enabled": True},
                "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
            },
            metadata={"managed_by": _CFG_TAG},
        )
        await db.app_settings.update_one({"key": "stripe_portal_config", "stripe_key_tag": key_tag},
                                         {"$set": {"configuration_id": cfg["id"], "updated_at": now_iso()}}, upsert=True)
        return cfg["id"]
    except Exception as e:  # noqa: BLE001
        log.warning("portal configuration unavailable, falling back to Stripe default: %s", e)
        return None


@router.post("/companies/{cid}/billing/portal-session")
async def create_portal_session(cid: str, inp: PortalIn, user: dict = Depends(get_current_user)):
    if user.get("role") != "superadmin" and not await db.memberships.find_one({"user_id": user["id"], "company_id": cid}):
        raise HTTPException(404, "Company not found")
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "stripe_customer_id": 1, "stripe_subscription_id": 1, "owner_user_id": 1, "sub_status": 1, "billing_state": 1, "billing_cadence": 1})
    if not company:
        raise HTTPException(404, "Company not found")
    if not os.environ.get("STRIPE_SECRET_KEY"):
        raise HTTPException(503, "Stripe is not configured on this environment.")
    sub_id = company.get("stripe_subscription_id")
    customer = company.get("stripe_customer_id")
    if not customer and company.get("owner_user_id"):
        owner = await db.users.find_one({"id": company["owner_user_id"]}, {"_id": 0, "stripe_customer_id": 1})
        customer = (owner or {}).get("stripe_customer_id")
    state = (company.get("sub_status") or company.get("billing_state") or "").lower()
    if not customer or not sub_id or state in ("canceled", "unpaid", "incomplete_expired"):
        raise HTTPException(409, {"code": "no_subscription", "message": "No active subscription to manage — start one from the pricing page."})

    base = (inp.origin_url or os.environ.get("PUBLIC_APP_URL") or "").rstrip("/")
    return_url = f"{base}{inp.return_path or '/accounting/transactions'}" if base else None
    params: dict = {"customer": customer}
    if return_url:
        params["return_url"] = return_url
    cfg_id = await _portal_configuration_id()
    if cfg_id:
        params["configuration"] = cfg_id

    deep_link = None
    target = (inp.target_product or "").lower()
    if target in _PLANS:
        try:
            sub = stripe.Subscription.retrieve(sub_id)
            item = sub["items"]["data"][0]
            _, cur_cadence = _plan_from_price_id(item["price"]["id"])
            cadence = (inp.cadence or company.get("billing_cadence") or cur_cadence or "monthly").lower()
            new_price = _price_id(target, False, cadence) or _price_id(target, False, "monthly")
            if new_price and new_price != item["price"]["id"]:
                params["flow_data"] = {
                    "type": "subscription_update_confirm",
                    "subscription_update_confirm": {"subscription": sub_id, "items": [{"id": item["id"], "price": new_price, "quantity": 1}]},
                    **({"after_completion": {"type": "redirect", "redirect": {"return_url": return_url}}} if return_url else {}),
                }
                deep_link = target
        except Exception as e:  # noqa: BLE001
            log.warning("portal deep-link unavailable (%s); opening plain portal", e)
            params.pop("flow_data", None)

    try:
        session = stripe.billing_portal.Session.create(**params)
    except stripe.error.StripeError as e:
        if "flow_data" in params:
            params.pop("flow_data")
            try:
                session = stripe.billing_portal.Session.create(**params)
                deep_link = None
            except stripe.error.StripeError as e2:
                raise HTTPException(502, f"Stripe portal error: {getattr(e2, 'user_message', None) or str(e2)}")
        else:
            raise HTTPException(502, f"Stripe portal error: {getattr(e, 'user_message', None) or str(e)}")

    await db.billing_portal_sessions.insert_one({"company_id": cid, "user_id": user.get("id"), "session_id": session["id"],
                                                 "target_product": deep_link, "created_at": now_iso()})
    return {"portal_url": session["url"], "deep_link": deep_link}


def _ts_iso(ts) -> Optional[str]:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat() if ts else None


@router.get("/companies/{cid}/billing/plan-summary")
async def plan_summary(cid: str, user: dict = Depends(get_current_user)):
    """Current plan, next invoice, card, seats — one call for the Billing page."""
    from entitlements import company_entitlements, PLAN_LABELS, PLAN_PRICE, PLAN_QUOTAS, preview_override
    if user.get("role") != "superadmin" and not await db.memberships.find_one({"user_id": user["id"], "company_id": cid}):
        raise HTTPException(404, "Company not found")
    c = await db.companies.find_one({"id": cid}, {"_id": 0})
    if not c:
        raise HTTPException(404, "Company not found")
    ent = await company_entitlements(cid, user, None)
    plan = c.get("billing_product")
    sub_status = (c.get("sub_status") or c.get("billing_state") or None)
    sub_id, customer = c.get("stripe_subscription_id"), c.get("stripe_customer_id")
    has_sub = bool(sub_id) and (sub_status or "") not in ("canceled", "unpaid", "incomplete_expired")
    cadence = c.get("billing_cadence") or ("annual" if c.get("sub_interval") == "year" else "monthly")
    amount_cents = (c.get("sub_amount_cents") if has_sub else None) or (PLAN_PRICE.get(plan, 0) * 100 if plan in PLAN_PRICE and cadence == "monthly" else None)

    next_invoice = None
    if has_sub and os.environ.get("STRIPE_SECRET_KEY"):
        try:
            inv = stripe.Invoice.create_preview(subscription=sub_id)
            next_invoice = {"amount_cents": inv.get("amount_due"), "date": _ts_iso(inv.get("next_payment_attempt") or inv.get("period_end")),
                            "currency": inv.get("currency")}
        except Exception as e:  # noqa: BLE001
            log.info("invoice preview unavailable (%s); using snapshot", e)
    if not next_invoice and has_sub and c.get("sub_current_period_end"):
        next_invoice = {"amount_cents": amount_cents, "date": c.get("sub_current_period_end"), "currency": "usd", "estimated": True}
    if c.get("sub_cancel_at_period_end"):
        next_invoice = None

    return {
        "company_id": cid, "company_name": c.get("name"),
        "plan": plan, "plan_label": PLAN_LABELS.get(plan, plan) if plan else None,
        "effective_plan_label": ent.get("plan_label"), "all_access": ent.get("all_access"), "access_source": ent.get("source"),
        "payer": c.get("billing_payer"), "sub_status": sub_status,
        "trialing": sub_status == "trialing", "trial_end": c.get("sub_trial_end"),
        "cancel_at_period_end": bool(c.get("sub_cancel_at_period_end")), "current_period_end": c.get("sub_current_period_end"),
        "cadence": cadence, "amount_cents": amount_cents,
        "card": (f"{(c.get('sub_card_brand') or '').title()} •••• {c.get('sub_card_last4')}" if c.get("sub_card_last4") else None),
        "next_invoice": next_invoice,
        "has_subscription": has_sub, "can_open_portal": has_sub and bool(customer or c.get("owner_user_id")),
        "usage": ent.get("usage"), "quotas": ent.get("quotas") or PLAN_QUOTAS.get(plan),
        "stripe_configured": bool(os.environ.get("STRIPE_SECRET_KEY")),
    }
