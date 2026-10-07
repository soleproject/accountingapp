"""Superadmin view of shadow-mode entitlement events (who WOULD be blocked)."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_role
from db import db, now_iso
from entitlements import FEATURE_MIN_PLAN, PLAN_LABELS, PLAN_QUOTAS, PLAN_RANK, _flag, quota_usage

router = APIRouter(prefix="/api")


@router.get("/admin/entitlements/events")
async def entitlement_events(days: int = Query(30, ge=1, le=365), user: dict = Depends(require_role("superadmin"))):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    pipeline = [
        {"$match": {"at": {"$gte": since}}},
        {"$group": {"_id": {"company_id": "$company_id", "feature": "$feature"},
                    "count": {"$sum": 1}, "last_at": {"$max": "$at"}, "first_at": {"$min": "$at"},
                    "plan": {"$last": "$plan"}, "source": {"$last": "$source"}, "min_plan": {"$last": "$min_plan"},
                    "used": {"$last": "$used"}, "limit": {"$last": "$limit"},
                    "enforced": {"$sum": {"$cond": ["$enforced", 1, 0]}},
                    "users": {"$addToSet": "$user_id"}}},
        {"$sort": {"count": -1}},
    ]
    groups = await db.entitlement_events.aggregate(pipeline).to_list(2000)
    cids = sorted({g["_id"]["company_id"] for g in groups if g["_id"].get("company_id")})
    companies = {c["id"]: c for c in await db.companies.find(
        {"id": {"$in": cids}}, {"_id": 0, "id": 1, "name": 1, "billing_product": 1, "billing_payer": 1, "sub_status": 1}).to_list(len(cids) or 1)}
    rows, by_feature, by_plan, by_company, feat_min = [], {}, {}, {}, {}
    for g in groups:
        cid, feat = g["_id"].get("company_id"), g["_id"].get("feature")
        c = companies.get(cid, {})
        plan = g.get("plan") or c.get("billing_product")
        shadow = g["count"] - g["enforced"]
        min_plan = g.get("min_plan") or FEATURE_MIN_PLAN.get(feat)
        rows.append({"company_id": cid, "company_name": c.get("name") or cid, "feature": feat,
                     "min_plan": min_plan, "plan": plan, "plan_label": PLAN_LABELS.get(plan, plan or "—"),
                     "used": g.get("used"), "limit": g.get("limit"),
                     "payer": c.get("billing_payer"), "sub_status": c.get("sub_status"), "source": g.get("source"),
                     "count": g["count"], "shadow": shadow, "enforced": g["enforced"],
                     "users": len([u for u in g.get("users") or [] if u]), "first_at": g.get("first_at"), "last_at": g.get("last_at")})
        by_feature[feat] = by_feature.get(feat, 0) + shadow
        feat_min[feat] = min_plan
        by_plan[plan or "none"] = by_plan.get(plan or "none", 0) + shadow
        if shadow:
            by_company[cid] = by_company.get(cid, 0) + shadow
    return {"enforce": _flag("ENTITLEMENTS_ENFORCE"), "preview_switcher": _flag("PLAN_PREVIEW_SWITCHER"), "days": days,
            "totals": {"events": sum(r["count"] for r in rows), "shadow": sum(r["shadow"] for r in rows),
                       "enforced": sum(r["enforced"] for r in rows), "companies": len(by_company)},
            "by_feature": sorted(({"feature": k, "count": v, "min_plan": feat_min.get(k)} for k, v in by_feature.items()), key=lambda x: -x["count"]),
            "by_plan": sorted(({"plan": k, "label": PLAN_LABELS.get(k, k), "count": v} for k, v in by_plan.items()), key=lambda x: -x["count"]),
            "rows": rows, "labels": PLAN_LABELS, "quotas": PLAN_QUOTAS}


@router.get("/admin/entitlements/preflight")
async def entitlement_preflight(user: dict = Depends(require_role("superadmin"))):
    """Every company with a paid plan on file: what enforcement would do to it (plan, payer, status, usage vs quota)."""
    out = []
    cur = db.companies.find({"billing_product": {"$in": list(PLAN_RANK)}},
                            {"_id": 0, "id": 1, "name": 1, "owner_email": 1, "billing_product": 1, "billing_payer": 1,
                             "sub_status": 1, "billing_state": 1, "partner_sponsored": 1, "stripe_subscription_id": 1})
    async for c in cur:
        plan, payer = c["billing_product"], (c.get("billing_payer") or "").lower()
        sub = (c.get("sub_status") or c.get("billing_state") or "").lower()
        usage = await quota_usage(c["id"])
        if payer in ("free_spot", "enterprise", "investor") or c.get("partner_sponsored"):
            outcome, quotas = "all_access", None
        elif sub == "trialing":
            outcome, quotas = "trial", None
        elif sub in ("canceled", "unpaid", "incomplete_expired"):
            outcome, quotas = "core_fallback", PLAN_QUOTAS["simple_start"]
        elif PLAN_RANK[plan] >= 4:
            outcome, quotas = "all_access", PLAN_QUOTAS[plan]
        else:
            outcome, quotas = "gated", PLAN_QUOTAS[plan]
        over = [k for k in ("users", "connected_accounts") if quotas and quotas.get(k) is not None and usage[k] > quotas[k]]
        out.append({"company_id": c["id"], "name": c.get("name"), "owner_email": c.get("owner_email"), "plan": plan,
                    "plan_label": PLAN_LABELS.get(plan, plan), "payer": payer or None, "sub_status": sub or None,
                    "has_stripe_sub": bool(c.get("stripe_subscription_id")), "outcome": outcome, "usage": usage,
                    "quotas": quotas, "over": over, "grace": sub == "past_due"})
    out.sort(key=lambda r: ({"gated": 0, "core_fallback": 1, "trial": 2, "all_access": 3}[r["outcome"]], r["name"] or ""))
    total = await db.companies.count_documents({})
    return {"enforce": _flag("ENTITLEMENTS_ENFORCE"), "total_companies": total, "no_plan": total - len(out),
            "gated": sum(1 for r in out if r["outcome"] in ("gated", "core_fallback")),
            "over_quota": sum(1 for r in out if r["over"]), "rows": out}


OVERRIDE_PAYERS = ("client_email", "client_card", "enterprise", "free_spot", "investor")
OVERRIDE_STATUSES = ("active", "trialing", "past_due", "canceled", "pending")


class BillingOverrideIn(BaseModel):
    billing_product: Optional[str] = None
    billing_payer: Optional[str] = None
    sub_status: Optional[str] = None
    clear: bool = False


@router.get("/admin/entitlements/companies")
async def entitlement_companies(user: dict = Depends(require_role("superadmin"))):
    """Lightweight picker list for the plan-override tool."""
    rows = await db.companies.find({}, {"_id": 0, "id": 1, "name": 1, "owner_email": 1, "billing_product": 1}).sort("name", 1).to_list(2000)
    return {"companies": rows, "plans": list(PLAN_RANK), "payers": OVERRIDE_PAYERS, "statuses": OVERRIDE_STATUSES}


@router.patch("/admin/entitlements/companies/{cid}/billing")
async def override_company_billing(cid: str, inp: BillingOverrideIn, user: dict = Depends(require_role("superadmin"))):
    """Superadmin test/correction tool: set the plan fields entitlements read. No Stripe side effects."""
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "id": 1, "billing_product": 1, "billing_payer": 1, "sub_status": 1, "stripe_subscription_id": 1})
    if not company:
        raise HTTPException(404, "company not found")
    before = {k: company.get(k) for k in ("billing_product", "billing_payer", "sub_status")}
    if inp.clear:
        await db.companies.update_one({"id": cid}, {"$unset": {"billing_product": "", "billing_payer": "", "sub_status": "", "billing_state": ""},
                                                    "$set": {"billing_override": None, "updated_at": now_iso()}})
    else:
        if inp.billing_product is not None and inp.billing_product not in PLAN_RANK:
            raise HTTPException(400, f"billing_product must be one of {list(PLAN_RANK)}")
        if inp.billing_payer is not None and inp.billing_payer not in OVERRIDE_PAYERS:
            raise HTTPException(400, f"billing_payer must be one of {list(OVERRIDE_PAYERS)}")
        if inp.sub_status is not None and inp.sub_status not in OVERRIDE_STATUSES:
            raise HTTPException(400, f"sub_status must be one of {list(OVERRIDE_STATUSES)}")
        sets = {k: v for k, v in (("billing_product", inp.billing_product), ("billing_payer", inp.billing_payer), ("sub_status", inp.sub_status)) if v is not None}
        if not sets:
            raise HTTPException(400, "nothing to change")
        if "sub_status" in sets:
            sets["billing_state"] = sets["sub_status"]
        sets["billing_override"] = {"by": user.get("email"), "at": now_iso(), "before": before}
        sets["updated_at"] = now_iso()
        await db.companies.update_one({"id": cid}, {"$set": sets})
    await db.admin_audit.insert_one({"kind": "billing_override", "company_id": cid, "by": user.get("email"), "at": now_iso(),
                                     "before": before, "after": None if inp.clear else inp.model_dump(exclude_none=True)})
    return {"ok": True, "warning": "This company has a live Stripe subscription — the next Stripe webhook may overwrite these fields." if company.get("stripe_subscription_id") else None}
