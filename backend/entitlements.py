"""Plan-based feature entitlements.

The gate follows the COMPANY: `billing_product` decides the tier; sponsored
seats (free_spot / enterprise), the firm's own books, legacy companies with
no plan on file, and superadmins are all-access. "Deny only when we
positively know the plan is lower."

Env flags (backend/.env):
  ENTITLEMENTS_ENFORCE=true      → require_feature blocks with 402 (else shadow: log only)
  PLAN_PREVIEW_SWITCHER=true     → honor `X-Plan-Preview` header (preview env only)
"""
from __future__ import annotations
import logging
import os
from typing import Optional

from fastapi import Depends, HTTPException, Request

from auth import get_current_user
from db import db, now_iso

log = logging.getLogger(__name__)

PLAN_RANK = {"simple_start": 1, "essentials": 2, "assistant": 2, "plus": 3, "bookkeeper": 3, "advanced": 4}
PLAN_LABELS = {"simple_start": "Core", "assistant": "AI Assistant", "bookkeeper": "AI Bookkeeper", "advanced": "Advanced"}
PLAN_PRICE = {"simple_start": 38, "assistant": 79, "bookkeeper": 99, "advanced": 149}
RANK_TO_PLAN = {1: "simple_start", 2: "assistant", 3: "bookkeeper", 4: "advanced"}
# Seat / connected-account quotas per tier (pricing page). Informational for now — not enforced.
PLAN_QUOTAS = {
    "simple_start": {"companies": 1, "users": 1, "accountant": True, "connected_accounts": 3},
    "assistant": {"companies": 1, "users": 3, "accountant": True, "connected_accounts": 6},
    "bookkeeper": {"companies": 1, "users": 5, "accountant": True, "connected_accounts": None},
    "advanced": {"companies": 1, "users": 5, "accountant": True, "connected_accounts": None},
}

FEATURE_MIN_PLAN = {
    # AI Assistant ($79)
    "chat": "assistant", "receipt_ai": "assistant", "outlook": "assistant",
    # AI Bookkeeper ($99)
    "checkins": "bookkeeper", "statements_ai": "bookkeeper", "month_close": "bookkeeper",
    "bookkeeper_review": "bookkeeper", "liability_ai": "bookkeeper", "classes": "bookkeeper",
    "automations": "bookkeeper", "auto_emails": "bookkeeper",
    # Advanced ($149)
    "bills_ai": "advanced", "adv_insights": "advanced", "adv_forecast": "advanced",
    "budgets": "advanced", "inventory": "advanced", "sales_tax": "advanced", "reimbursements": "advanced",
}
ALL_FEATURES = sorted(FEATURE_MIN_PLAN)
PREVIEW_CHOICES = {"simple_start", "assistant", "bookkeeper", "advanced", "free_spot", "real"}


def _flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes")


def features_for_rank(rank: int) -> list[str]:
    return [f for f, p in FEATURE_MIN_PLAN.items() if PLAN_RANK[p] <= rank]


QUOTA_KINDS = ("users", "connected_accounts")
_CLIENT_SEAT_ROLES = ("owner", "editor", "reviewer", "viewer")


async def quota_usage(cid: str) -> dict:
    """Client-side seats (pro/accountant seats are free) + mapped Plaid accounts."""
    users = await db.memberships.count_documents({"company_id": cid, "role": {"$in": list(_CLIENT_SEAT_ROLES)}, "archived_at": None})
    pending = await db.invites.count_documents({"company_ids": cid, "status": "pending", "role": {"$in": list(_CLIENT_SEAT_ROLES)}})
    accounts = 0
    async for it in db.plaid_items.find({"company_id": cid}, {"account_mappings": 1}):
        accounts += len(it.get("account_mappings") or {})
    return {"users": users + pending, "connected_accounts": accounts}


def next_plan_for(kind: str, current: Optional[str], needed: int) -> Optional[str]:
    cur = PLAN_RANK.get(current or "", 0)
    for r in range(cur + 1, 5):
        lim = PLAN_QUOTAS[RANK_TO_PLAN[r]][kind]
        if lim is None or lim >= needed:
            return RANK_TO_PLAN[r]
    return None


def preview_override(request: Optional[Request], user: dict) -> Optional[str]:
    if not request or not _flag("PLAN_PREVIEW_SWITCHER"):
        return None
    if user.get("role") not in ("superadmin", "pro", "partner", "enterprise"):
        return None
    v = (request.headers.get("x-plan-preview") or "").strip().lower()
    return v if v in PREVIEW_CHOICES and v != "real" else None


async def company_entitlements(cid: str, user: dict, override: Optional[str] = None) -> dict:
    company = await db.companies.find_one({"id": cid}) or {}
    plan = company.get("billing_product") or None
    payer = company.get("billing_payer")
    sub = (company.get("sub_status") or company.get("billing_state") or "").lower()
    base = {"company_id": cid, "plan": plan, "plan_label": PLAN_LABELS.get(plan, plan), "sub_status": sub or None,
            "payer": payer, "enforce": _flag("ENTITLEMENTS_ENFORCE"), "preview": override,
            "min_plan": FEATURE_MIN_PLAN, "labels": PLAN_LABELS, "prices": PLAN_PRICE,
            "quotas": PLAN_QUOTAS.get(override or plan), "usage": await quota_usage(cid)}

    def full(source: str) -> dict:
        return {**base, "all_access": True, "source": source, "features": ALL_FEATURES, "grace": False, "quotas": None}

    if override == "free_spot":
        return full("preview_free_spot")
    if override:
        plan = override
    else:
        if user.get("role") == "superadmin":
            return full("superadmin")
        if payer in ("free_spot", "enterprise") or company.get("partner_sponsored"):
            return full("sponsored")
        ms = await db.memberships.find_one({"company_id": cid, "user_id": user["id"]}, {"role": 1})
        if ms and ms.get("role") == "owner" and user.get("role") in ("pro", "partner", "enterprise"):
            return full("own_books")
        if not plan or plan not in PLAN_RANK:
            return full("no_plan_on_file")
        if sub == "trialing":
            return full("trial")
        if sub in ("canceled", "unpaid", "incomplete_expired"):
            return {**base, "all_access": False, "source": "canceled", "plan": "simple_start",
                    "plan_label": "Core", "features": features_for_rank(1), "grace": False,
                    "quotas": PLAN_QUOTAS["simple_start"]}
    rank = PLAN_RANK[plan]
    return {**base, "all_access": rank >= 4, "source": "plan", "plan": plan, "plan_label": PLAN_LABELS.get(plan, plan),
            "features": features_for_rank(rank), "grace": sub == "past_due"}


def upgrade_payload(feature: str, ent: dict) -> dict:
    min_plan = FEATURE_MIN_PLAN[feature]
    return {"code": "upgrade_required", "feature": feature, "min_plan": min_plan,
            "min_plan_label": PLAN_LABELS[min_plan], "min_plan_price": PLAN_PRICE[min_plan],
            "current_plan": ent.get("plan"), "current_plan_label": ent.get("plan_label")}


async def check_feature(cid: str, feature: str, user: dict, request: Optional[Request] = None) -> dict:
    """Shadow-mode aware gate. Raises 402 only when enforcing (or previewing)."""
    ent = await company_entitlements(cid, user, preview_override(request, user))
    if feature in ent["features"]:
        return ent
    payload = upgrade_payload(feature, ent)
    try:
        await db.entitlement_events.insert_one({"company_id": cid, "user_id": user.get("id"), "feature": feature,
                                                "plan": ent.get("plan"), "source": ent.get("source"), "preview": bool(ent["preview"]),
                                                "enforced": bool(ent["enforce"] or ent["preview"]), "at": now_iso()})
    except Exception:
        pass
    if ent["enforce"] or ent["preview"]:
        raise HTTPException(status_code=402, detail=payload)
    log.info("entitlement shadow-block company=%s feature=%s plan=%s", cid, feature, ent.get("plan"))
    return ent


def require_feature(feature: str, cid_param: str = "cid"):
    assert feature in FEATURE_MIN_PLAN, feature

    async def _dep(request: Request, user: dict = Depends(get_current_user)) -> dict:
        cid = request.path_params.get(cid_param) or request.query_params.get("company_id")
        if not cid:
            return user
        await check_feature(cid, feature, user, request)
        return user
    return _dep


def quota_payload(kind: str, ent: dict) -> dict:
    used, limit = ent["usage"][kind], (ent.get("quotas") or {}).get(kind)
    nxt = next_plan_for(kind, ent.get("plan"), used + 1)
    return {"code": "quota_exceeded", "feature": f"quota_{kind}", "kind": kind, "used": used, "limit": limit,
            "current_plan": ent.get("plan"), "current_plan_label": ent.get("plan_label"),
            "min_plan": nxt, "min_plan_label": PLAN_LABELS.get(nxt), "min_plan_price": PLAN_PRICE.get(nxt),
            "next_limit": PLAN_QUOTAS[nxt][kind] if nxt else None}


async def check_quota(cid: str, kind: str, user: dict, request: Optional[Request] = None) -> dict:
    """Blocks NEW seats/connections once at the plan cap (existing ones are grandfathered)."""
    ent = await company_entitlements(cid, user, preview_override(request, user))
    limit = (ent.get("quotas") or {}).get(kind)
    if limit is None or ent["usage"][kind] < limit:
        return ent
    payload = quota_payload(kind, ent)
    try:
        await db.entitlement_events.insert_one({"company_id": cid, "user_id": user.get("id"), "feature": payload["feature"],
                                                "plan": ent.get("plan"), "source": ent.get("source"), "min_plan": payload["min_plan"],
                                                "used": payload["used"], "limit": limit, "preview": bool(ent["preview"]),
                                                "enforced": bool(ent["enforce"] or ent["preview"]), "at": now_iso()})
    except Exception:
        pass
    if ent["enforce"] or ent["preview"]:
        raise HTTPException(status_code=402, detail=payload)
    log.info("quota shadow-block company=%s kind=%s used=%s limit=%s", cid, kind, payload["used"], limit)
    return ent


def require_quota(kind: str, cid_param: str = "cid"):
    assert kind in QUOTA_KINDS, kind

    async def _dep(request: Request, user: dict = Depends(get_current_user)) -> dict:
        cid = request.path_params.get(cid_param)
        if cid:
            await check_quota(cid, kind, user, request)
        return user
    return _dep
