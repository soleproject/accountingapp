"""Affiliate directory — superadmin (platform-wide) + firm-scoped (pro/partner).

Rows = every `role: affiliate` user plus any other user who owns a
referral slug AND has referral activity (clicks / leads / signups /
earnings). Superadmins can reassign an affiliate to a white-label firm
(fixes older affiliates whose `signup_firm_slug` was never stamped).
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user, require_role

router = APIRouter(prefix="/api", tags=["affiliates"])

_FIRM_PROJ = {"_id": 0, "id": 1, "name": 1, "enterprise_id": 1, "branding.firm_name": 1,
              "branding.signin_subdomain": 1, "branding.subdomain": 1, "branding.subdomain_slug": 1,
              "branding.buy_page_url": 1}


def _slug_of(firm: dict) -> Optional[str]:
    b = firm.get("branding") or {}
    return (b.get("signin_subdomain") or b.get("subdomain") or b.get("subdomain_slug") or "").strip().lower() or None


async def _all_firms() -> list[dict]:
    docs = await db.users.find({"$or": [
        {"branding.signin_subdomain": {"$nin": [None, ""]}},
        {"branding.subdomain": {"$nin": [None, ""]}},
        {"branding.subdomain_slug": {"$nin": [None, ""]}},
    ]}, _FIRM_PROJ).to_list(2000)
    out, seen = [], set()
    for d in docs:
        s = _slug_of(d)
        if not s or s in seen:
            continue
        seen.add(s)
        out.append({"slug": s, "name": (d.get("branding") or {}).get("firm_name") or d.get("name") or s.title(),
                    "owner_user_id": d["id"], "enterprise_id": d.get("enterprise_id")})
    out.sort(key=lambda f: f["name"].lower())
    return out


async def _counts_by(coll: str, field: str, ids: list[str], distinct_field: str | None = None) -> dict[str, int]:
    if not ids:
        return {}
    group = {"_id": f"${field}", "n": {"$addToSet": f"${distinct_field}"} if distinct_field else {"$sum": 1}}
    pipeline = [{"$match": {field: {"$in": ids}}}, {"$group": group}]
    out = {}
    async for r in db[coll].aggregate(pipeline):
        out[r["_id"]] = len(r["n"]) if distinct_field else r["n"]
    return out


async def _affiliate_rows(firm_slugs: Optional[set[str]] = None, q: str = "") -> dict:
    from routes.auth import _resolve_firm_for_user, _firm_public_info, _share_link_for
    firms = await _all_firms()
    firm_by_slug = {f["slug"]: f for f in firms}

    active_ids: set[str] = set()
    for coll, field in (("referral_earnings", "referrer_user_id"), ("referral_clicks", "referrer_user_id"),
                        ("leads", "referrer_user_id"), ("users", "referred_by_user_id")):
        active_ids.update(x for x in await db[coll].distinct(field) if x)
    users = await db.users.find(
        {"$or": [{"role": "affiliate"}, {"id": {"$in": list(active_ids)}, "referral_slug": {"$nin": [None, ""]}}]},
        {"_id": 0, "id": 1, "name": 1, "email": 1, "role": 1, "referral_slug": 1, "created_at": 1,
         "signup_firm_slug": 1, "enterprise_id": 1, "branding": 1, "affiliate_upgraded_at": 1},
    ).to_list(5000)
    ids = [u["id"] for u in users]
    clicks = await _counts_by("referral_clicks", "referrer_user_id", ids)
    leads = await _counts_by("leads", "referrer_user_id", ids)
    signups = await _counts_by("users", "referred_by_user_id", ids)
    paying = await _counts_by("referral_earnings", "referrer_user_id", ids, distinct_field="referred_user_id")
    earned: dict[str, dict] = {}
    async for r in db.referral_earnings.aggregate([
        {"$match": {"referrer_user_id": {"$in": ids}}},
        {"$group": {"_id": {"r": "$referrer_user_id", "s": "$status"}, "c": {"$sum": "$share_cents"}}}]):
        e = earned.setdefault(r["_id"]["r"], {"accrued": 0, "paid": 0})
        e["paid" if r["_id"]["s"] == "paid_out" else "accrued"] += int(r["c"] or 0)

    needle = (q or "").strip().lower()
    rows = []
    for u in users:
        firm = await _resolve_firm_for_user(u)
        info = _firm_public_info(firm) or {}
        fslug = (info.get("slug") or "").lower() or None
        if firm_slugs is not None and fslug not in firm_slugs:
            continue
        if needle and not any(needle in str(v or "").lower() for v in
                              (u.get("name"), u.get("email"), u.get("referral_slug"), info.get("name"))):
            continue
        link, link_source = _share_link_for(u, u.get("referral_slug") or "", firm) if u.get("referral_slug") else ("", "none")
        e = earned.get(u["id"], {"accrued": 0, "paid": 0})
        rows.append({
            "user_id": u["id"], "name": u.get("name"), "email": u.get("email"), "role": u.get("role"),
            "slug": u.get("referral_slug"), "link": link, "link_source": link_source,
            "firm_slug": fslug, "firm_name": info.get("name"),
            "firm_assigned": bool(u.get("signup_firm_slug")) or (firm is u),
            "created_at": u.get("created_at"),
            "clicks": clicks.get(u["id"], 0), "leads": leads.get(u["id"], 0),
            "signups": signups.get(u["id"], 0), "paying": paying.get(u["id"], 0),
            "earned_cents": e["accrued"] + e["paid"], "pending_cents": e["accrued"],
        })
    rows.sort(key=lambda r: (-(r["pending_cents"]), -(r["signups"]), r.get("created_at") or ""))
    totals = {
        "affiliates": len(rows), "clicks": sum(r["clicks"] for r in rows), "leads": sum(r["leads"] for r in rows),
        "signups": sum(r["signups"] for r in rows), "paying": sum(r["paying"] for r in rows),
        "earned_cents": sum(r["earned_cents"] for r in rows), "pending_cents": sum(r["pending_cents"] for r in rows),
    }
    visible_firms = [f for f in firms if firm_slugs is None or f["slug"] in firm_slugs]
    return {"items": rows, "totals": totals, "firms": [{"slug": f["slug"], "name": f["name"]} for f in visible_firms]}


async def _affiliate_detail(uid: str) -> dict:
    from routes.auth import _resolve_firm_for_user, _firm_public_info
    u = await db.users.find_one({"id": uid}, {"_id": 0, "password_hash": 0, "password": 0})
    if not u:
        raise HTTPException(404, "Affiliate not found")
    referred = await db.users.find({"referred_by_user_id": uid},
                                   {"_id": 0, "id": 1, "name": 1, "email": 1, "role": 1, "created_at": 1}).to_list(2000)
    earnings = await db.referral_earnings.find({"referrer_user_id": uid}).sort("created_at", -1).to_list(2000)
    by_ref: dict[str, dict] = {}
    for e in earnings:
        e.pop("_id", None)
        r = by_ref.setdefault(e.get("referred_user_id"), {"earned_cents": 0, "pending_cents": 0, "payments": 0})
        c = int(e.get("share_cents") or 0)
        r["earned_cents"] += c
        r["payments"] += 1
        if (e.get("status") or "accrued") != "paid_out":
            r["pending_cents"] += c
    for ru in referred:
        ru.update(by_ref.get(ru["id"], {"earned_cents": 0, "pending_cents": 0, "payments": 0}))
        ru["paying"] = ru["payments"] > 0
    referred.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    leads = await db.leads.find({"referrer_user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(200)
    clicks = await db.referral_clicks.count_documents({"referrer_user_id": uid})
    firm = _firm_public_info(await _resolve_firm_for_user(u))
    return {
        "user": {"id": u["id"], "name": u.get("name"), "email": u.get("email"), "role": u.get("role"),
                 "slug": u.get("referral_slug"), "created_at": u.get("created_at"),
                 "signup_firm_slug": u.get("signup_firm_slug")},
        "firm": firm, "clicks": clicks, "referred": referred, "leads": leads, "earnings": earnings[:200],
    }


# ---- Superadmin ----------------------------------------------------------

@router.get("/admin/affiliates")
async def admin_affiliates(q: str = "", firm: str = "", user: dict = Depends(require_role("superadmin"))):
    slugs = {firm.strip().lower()} if firm.strip() else None
    return await _affiliate_rows(slugs, q)


@router.get("/admin/affiliates/{uid}")
async def admin_affiliate_detail(uid: str, user: dict = Depends(require_role("superadmin"))):
    return await _affiliate_detail(uid)


class FirmAssign(BaseModel):
    firm_slug: Optional[str] = None


@router.patch("/admin/affiliates/{uid}/firm")
async def admin_affiliate_assign_firm(uid: str, body: FirmAssign, user: dict = Depends(require_role("superadmin"))):
    target = await db.users.find_one({"id": uid}, {"_id": 0, "id": 1})
    if not target:
        raise HTTPException(404, "Affiliate not found")
    slug = (body.firm_slug or "").strip().lower()
    if slug:
        if not re.fullmatch(r"[a-z0-9-]{1,63}", slug):
            raise HTTPException(400, "Invalid firm slug")
        firms = {f["slug"] for f in await _all_firms()}
        if slug not in firms:
            raise HTTPException(404, "No firm registered on that slug")
        await db.users.update_one({"id": uid}, {"$set": {"signup_firm_slug": slug, "updated_at": now_iso(),
                                                         "firm_assigned_by": user["id"]}})
    else:
        await db.users.update_one({"id": uid}, {"$unset": {"signup_firm_slug": ""}, "$set": {"updated_at": now_iso()}})
    return {"ok": True, "firm_slug": slug or None}


# ---- Firm-scoped (pro / partner) ----------------------------------------

async def _caller_firm_slugs(user: dict) -> set[str]:
    doc = await db.users.find_one({"id": user["id"]}, _FIRM_PROJ) or {}
    slugs = set()
    s = _slug_of(doc)
    if s:
        slugs.add(s)
    if doc.get("enterprise_id"):
        ent = await db.enterprises.find_one({"id": doc["enterprise_id"]}, {"_id": 0, "owner_user_id": 1})
        if ent and ent.get("owner_user_id"):
            owner = await db.users.find_one({"id": ent["owner_user_id"]}, _FIRM_PROJ) or {}
            s2 = _slug_of(owner)
            if s2:
                slugs.add(s2)
    return slugs


@router.get("/firm/affiliates")
async def firm_affiliates(q: str = "", user: dict = Depends(require_role("pro", "partner", "superadmin"))):
    slugs = await _caller_firm_slugs(user)
    if not slugs:
        return {"items": [], "totals": {"affiliates": 0}, "firms": [], "no_firm": True}
    return await _affiliate_rows(slugs, q)


@router.get("/firm/affiliates/{uid}")
async def firm_affiliate_detail(uid: str, user: dict = Depends(require_role("pro", "partner", "superadmin"))):
    from routes.auth import _resolve_firm_for_user, _firm_public_info
    slugs = await _caller_firm_slugs(user)
    target = await db.users.find_one({"id": uid}, {"_id": 0, "id": 1, "signup_firm_slug": 1, "enterprise_id": 1, "branding": 1})
    if not target:
        raise HTTPException(404, "Affiliate not found")
    info = _firm_public_info(await _resolve_firm_for_user(target)) or {}
    if user["role"] != "superadmin" and (info.get("slug") or "").lower() not in slugs:
        raise HTTPException(403, "Not your affiliate")
    return await _affiliate_detail(uid)
