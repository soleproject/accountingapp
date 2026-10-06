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
            "min_plan": FEATURE_MIN_PLAN, "labels": PLAN_LABELS, "prices": PLAN_PRICE}

    def full(source: str) -> dict:
        return {**base, "all_access": True, "source": source, "features": ALL_FEATURES, "grace": False}

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
        if sub in ("canceled", "unpaid", "incomplete_expired"):
            return {**base, "all_access": False, "source": "canceled", "plan": "simple_start",
                    "plan_label": "Core", "features": features_for_rank(1), "grace": False}
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
                                                "plan": ent.get("plan"), "source": ent.get("source"),
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
