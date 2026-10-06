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
