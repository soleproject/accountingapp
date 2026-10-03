"""Superadmin → Client Payments: every subscription on the platform, who's
current / behind / trialing, what's due next, and per-client payment history."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from db import db, now_iso, coerce
from auth import require_role
from routes.stripe_billing import (
    PLAN_LABELS, PLAN_MONTHLY_CENTS, _fetch_sub_snapshot, _STRIPE_KEY,
)

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)

_BILLABLE_Q = {"$or": [
    {"stripe_subscription_id": {"$exists": True, "$ne": None}},
    {"billing_payer": {"$in": ["client_email", "client_card", "enterprise", "free_spot"]}},
    {"billing_state": {"$in": ["active", "past_due", "canceled"]}},
]}


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def _status_for(c: dict) -> str:
    s = c.get("sub_status")
    if s in ("trialing", "active", "past_due", "canceled"):
        return s
    if s in ("unpaid",):
        return "past_due"
    if s in ("incomplete_expired",):
        return "canceled"
    if c.get("billing_payer") == "enterprise":
        return "enterprise"
    if c.get("billing_payer") == "free_spot":
        return "free"
    bs = c.get("billing_state")
    return bs if bs in ("active", "past_due", "canceled") else "pending"


def _amount_cents(c: dict) -> Optional[int]:
    if c.get("sub_amount_cents") is not None:
        return int(c["sub_amount_cents"])
    prod = c.get("billing_product")
    if prod in PLAN_MONTHLY_CENTS:
        base = PLAN_MONTHLY_CENTS[prod]
        if c.get("billing_discount") and prod == "simple_start":
            base = 3000
        return base * 10 if c.get("billing_cadence") == "annual" else base
    return None


def _cadence_for(c: dict) -> str:
    if c.get("billing_cadence") in ("monthly", "annual"):
        return c["billing_cadence"]
    return "annual" if c.get("sub_interval") == "year" else "monthly"


def _row(c: dict, owner: dict, ent: dict, ltv_cents: int) -> dict:
    status = _status_for(c)
    cadence = _cadence_for(c)
    amount = _amount_cents(c)
    mrr = 0
    if status in ("active", "past_due") and amount:
        mrr = amount // 12 if cadence == "annual" else amount
    next_charge_at = None
    if status in ("trialing", "active", "past_due") and not c.get("sub_cancel_at_period_end"):
        next_charge_at = c.get("sub_trial_end") if status == "trialing" else c.get("sub_current_period_end")
    failure = c.get("sub_last_failure") or None
    return {
        "company_id": c["id"],
        "company_name": c.get("name"),
        "owner_name": owner.get("name"),
        "owner_email": owner.get("email"),
        "enterprise_id": ent.get("id"),
        "enterprise_name": ent.get("name"),
        "payer": c.get("billing_payer") or ("client_card" if c.get("stripe_subscription_id") else None),
        "product": c.get("billing_product"),
        "product_label": PLAN_LABELS.get(c.get("billing_product") or "", c.get("billing_product")),
        "cadence": cadence,
        "amount_cents": amount,
        "mrr_cents": mrr,
        "status": status,
        "cancel_at_period_end": bool(c.get("sub_cancel_at_period_end")),
        "trial_end": c.get("sub_trial_end"),
        "current_period_end": c.get("sub_current_period_end"),
        "next_charge_at": next_charge_at,
        "next_charge_cents": amount if next_charge_at else None,
        "started_at": c.get("sub_started_at") or c.get("billing_checkout_completed_at") or c.get("created_at"),
        "canceled_at": c.get("sub_canceled_at"),
        "card": (f"{(c.get('sub_card_brand') or '').title()} •••• {c.get('sub_card_last4')}"
                 if c.get("sub_card_last4") else None),
        "last_failure": failure,
        "ltv_cents": ltv_cents,
        "stripe_customer_id": c.get("stripe_customer_id"),
        "stripe_subscription_id": c.get("stripe_subscription_id"),
        "has_snapshot": bool(c.get("sub_synced_at")),
        "signup_firm_slug": c.get("signup_firm_slug"),
        "onboarding_complete": bool(c.get("onboarding_complete")),
    }


async def _load_context(companies: list[dict]) -> tuple[dict, dict, dict]:
    cids = [c["id"] for c in companies]
    owner_ms = await db.memberships.find({"company_id": {"$in": cids}, "role": "owner"},
                                         {"_id": 0, "company_id": 1, "user_id": 1}).to_list(10000)
    owner_uid_by_cid = {}
    for m in owner_ms:
        owner_uid_by_cid.setdefault(m["company_id"], m["user_id"])
    for c in companies:
        if c["id"] not in owner_uid_by_cid and c.get("owner_user_id"):
            owner_uid_by_cid[c["id"]] = c["owner_user_id"]
    users = {u["id"]: u for u in await db.users.find(
        {"id": {"$in": list(set(owner_uid_by_cid.values()))}}, {"_id": 0, "id": 1, "name": 1, "email": 1}).to_list(10000)}
    owners = {cid: users.get(uid, {}) for cid, uid in owner_uid_by_cid.items()}
    eids = list({c.get("enterprise_id") for c in companies if c.get("enterprise_id")})
    ents = {e["id"]: e for e in await db.enterprises.find({"id": {"$in": eids}}, {"_id": 0, "id": 1, "name": 1}).to_list(1000)}
    pipeline = [{"$match": {"company_id": {"$in": cids}}},
                {"$group": {"_id": "$company_id", "total": {"$sum": "$amount_cents"}}}]
    ltv = {r["_id"]: int(r["total"] or 0) async for r in db.platform_payments.aggregate(pipeline)}
    return owners, ents, ltv


async def _scope_query(user: dict) -> dict:
    """Superadmin sees everything; pros see their enterprise's companies + ones they manage."""
    if user.get("role") == "superadmin":
        return _BILLABLE_Q
    ms = await db.memberships.find(
        {"user_id": user["id"], "role": "pro", "$or": [{"archived_at": {"$exists": False}}, {"archived_at": None}]},
        {"_id": 0, "company_id": 1}).to_list(5000)
    ors = [{"id": {"$in": [m["company_id"] for m in ms]}}]
    if user.get("enterprise_id"):
        ors.append({"enterprise_id": user["enterprise_id"]})
    return {"$and": [{"$or": ors}, _BILLABLE_Q]}


@router.get("/admin/client-payments")
async def list_client_payments(user: dict = Depends(require_role("superadmin", "pro"))):
    companies = await db.companies.find(await _scope_query(user), {"_id": 0}).to_list(5000)
    owners, ents, ltv = await _load_context(companies)
    rows = [_row(c, owners.get(c["id"], {}), ents.get(c.get("enterprise_id") or "", {}), ltv.get(c["id"], 0))
            for c in companies]
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=30)
    thirty_ago = now - timedelta(days=30)
    due_rows = [r for r in rows if r["next_charge_at"] and now <= (_parse_iso(r["next_charge_at"]) or now) <= horizon]
    past_due = [r for r in rows if r["status"] == "past_due"]
    churned = [r for r in rows if r["status"] == "canceled" and (_parse_iso(r["canceled_at"]) or thirty_ago - timedelta(days=1)) >= thirty_ago]
    attention = sorted(
        [r for r in rows if r["status"] == "past_due"
         or (r["status"] == "trialing" and r["trial_end"] and (_parse_iso(r["trial_end"]) or horizon) <= now + timedelta(days=2))],
        key=lambda r: (r["status"] != "past_due", r.get("next_charge_at") or ""),
    )
    order = {"past_due": 0, "trialing": 1, "active": 2, "pending": 3, "enterprise": 4, "free": 5, "canceled": 6}
    rows.sort(key=lambda r: (order.get(r["status"], 9), r.get("next_charge_at") or "9", (r.get("company_name") or "").lower()))
    return {
        "metrics": {
            "mrr_cents": sum(r["mrr_cents"] for r in rows),
            "active": sum(1 for r in rows if r["status"] == "active"),
            "trialing": sum(1 for r in rows if r["status"] == "trialing"),
            "past_due": len(past_due),
            "past_due_cents": sum((r["amount_cents"] or 0) for r in past_due),
            "due_30d": len(due_rows),
            "due_30d_cents": sum((r["next_charge_cents"] or 0) for r in due_rows),
            "churned_30d": len(churned),
            "enterprise_paid": sum(1 for r in rows if r["status"] in ("enterprise", "free")),
        },
        "attention": attention[:20],
        "rows": rows,
        "stripe_mode": "live" if (_STRIPE_KEY or "").startswith("sk_live_") else "test",
        "scope": "platform" if user.get("role") == "superadmin" else "enterprise",
        "generated_at": now_iso(),
    }


@router.get("/admin/client-payments/{cid}")
async def client_payment_detail(cid: str, user: dict = Depends(require_role("superadmin", "pro"))):
    c = await db.companies.find_one({"$and": [{"id": cid}, await _scope_query(user)]} if user.get("role") != "superadmin" else {"id": cid}, {"_id": 0})
    if not c:
        raise HTTPException(404, "Company not found")
    owners, ents, ltv = await _load_context([c])
    row = _row(c, owners.get(cid, {}), ents.get(c.get("enterprise_id") or "", {}), ltv.get(cid, 0))
    payments = await db.platform_payments.find({"company_id": cid}, {"_id": 0}).sort("paid_at", -1).to_list(500)
    for p in payments:
        p["product_label"] = PLAN_LABELS.get(p.get("billing_product") or "", p.get("billing_product"))
    timeline = []
    if c.get("created_at"):
        src = f" via {c['signup_firm_slug']}" if c.get("signup_firm_slug") else ""
        timeline.append({"at": c["created_at"], "label": f"Company created{src}"})
    if c.get("billing_checkout_completed_at"):
        timeline.append({"at": c["billing_checkout_completed_at"], "label": "Checkout completed"})
    if c.get("sub_trial_end"):
        timeline.append({"at": c["sub_trial_end"], "label": "Trial ends"})
    for p in payments:
        timeline.append({"at": p.get("paid_at"), "label": f"Paid ${(p.get('amount_cents') or 0) / 100:,.2f}"})
    if (c.get("sub_last_failure") or {}).get("at"):
        timeline.append({"at": c["sub_last_failure"]["at"], "label": "Payment failed"})
    if c.get("sub_canceled_at"):
        timeline.append({"at": c["sub_canceled_at"], "label": "Subscription canceled"})
    timeline.sort(key=lambda t: t.get("at") or "")
    return {"client": row, "payments": [coerce(p) for p in payments], "timeline": timeline}


@router.post("/admin/client-payments/backfill")
async def backfill_client_payments(user: dict = Depends(require_role("superadmin"))):
    """Pull a fresh subscription snapshot from Stripe for every company with a subscription."""
    if not _STRIPE_KEY:
        raise HTTPException(503, "Stripe is not configured on this environment.")
    companies = await db.companies.find(
        {"stripe_subscription_id": {"$exists": True, "$ne": None}}, {"_id": 0, "id": 1, "stripe_subscription_id": 1}).to_list(5000)
    synced, failed = 0, []
    for c in companies:
        try:
            snap = await asyncio.to_thread(_fetch_sub_snapshot, c["stripe_subscription_id"])
            await db.companies.update_one({"id": c["id"]}, {"$set": {**snap, "updated_at": now_iso()}})
            synced += 1
        except Exception as e:  # noqa: BLE001
            failed.append({"company_id": c["id"], "error": str(e)[:200]})
    return {"synced": synced, "failed": failed, "total": len(companies)}
