"""Superadmin view of shadow-mode entitlement events (who WOULD be blocked)."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from auth import require_role
from db import db
from entitlements import FEATURE_MIN_PLAN, PLAN_LABELS, PLAN_QUOTAS, _flag

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
