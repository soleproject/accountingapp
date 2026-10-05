"""Superadmin user removal — company-by-company purge, then "delete user"
which demotes the account to `affiliate` so their referral link, earnings
and Refer & earn access survive untouched."""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import db, now_iso
from auth import require_role
from company_purge import company_data_preview, purge_company_data

router = APIRouter(prefix="/api", tags=["admin-users"])

_USER_SCOPED = ("notifications", "push_subscriptions", "user_prefs", "dashboard_layouts",
                "user_booking_settings", "bookings", "note_takers", "invites")


async def _owned_companies(uid: str) -> list[dict]:
    ids = {m["company_id"] for m in await db.memberships.find(
        {"user_id": uid, "role": "owner"}, {"_id": 0, "company_id": 1}).to_list(500)}
    async for c in db.companies.find({"owner_user_id": uid}, {"_id": 0, "id": 1}):
        ids.add(c["id"])
    return await db.companies.find({"id": {"$in": list(ids)}},
                                   {"_id": 0, "id": 1, "name": 1, "billing_state": 1, "stripe_subscription_id": 1,
                                    "is_firm_books": 1, "is_partner_books": 1, "enterprise_id": 1}).to_list(500)


async def _enterprise_block(u: dict) -> Optional[dict]:
    """Partner/enterprise owners stay locked until their firm is transferred."""
    ent = await db.enterprises.find_one({"owner_user_id": u["id"]}, {"_id": 0, "id": 1, "name": 1})
    if ent:
        n_cos = await db.companies.count_documents({"enterprise_id": ent["id"]})
        n_users = await db.users.count_documents({"enterprise_id": ent["id"], "id": {"$ne": u["id"]}})
        return {"kind": "enterprise", "id": ent["id"], "name": ent.get("name"), "companies": n_cos, "users": n_users}
    if u.get("role") == "partner":
        n_ents = await db.enterprises.count_documents({"partner_id": u.get("partner_id") or u["id"]})
        n_cos = await db.companies.count_documents({"partner_id": u.get("partner_id") or u["id"]})
        return {"kind": "partner", "id": u.get("partner_id") or u["id"], "name": (u.get("branding") or {}).get("firm_name") or u.get("name"),
                "enterprises": n_ents, "companies": n_cos}
    return None


@router.get("/admin/users/{uid}/deletion-preview")
async def deletion_preview(uid: str, user: dict = Depends(require_role("superadmin"))):
    u = await db.users.find_one({"id": uid}, {"_id": 0, "password_hash": 0, "password": 0})
    if not u:
        raise HTTPException(404, "User not found")
    owned = await _owned_companies(uid)
    for c in owned:
        c["data"] = await company_data_preview(c["id"])
        c["records"] = sum(c["data"].values())
    other_memberships = await db.memberships.count_documents({"user_id": uid, "role": {"$ne": "owner"}})
    block = await _enterprise_block(u)
    referral = {
        "slug": u.get("referral_slug"),
        "earnings": await db.referral_earnings.count_documents({"referrer_user_id": uid}),
        "referred_users": await db.users.count_documents({"referred_by_user_id": uid}),
        "leads": await db.leads.count_documents({"referrer_user_id": uid}),
    }
    return {
        "user": {"id": u["id"], "name": u.get("name"), "email": u.get("email"), "role": u.get("role")},
        "owned_companies": owned,
        "other_memberships": other_memberships,
        "enterprise_block": block,
        "referral": referral,
        "can_delete_user": not owned and not block and u.get("role") != "superadmin",
        "is_self": uid == user["id"],
    }


class ConfirmName(BaseModel):
    confirm: str


@router.delete("/admin/users/{uid}/companies/{cid}")
async def admin_delete_owned_company(uid: str, cid: str, body: ConfirmName,
                                     user: dict = Depends(require_role("superadmin"))):
    from routes.companies import _norm_name
    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found")
    owned = {c["id"] for c in await _owned_companies(uid)}
    if cid not in owned:
        raise HTTPException(400, "That company is not owned by this user")
    if _norm_name(body.confirm) != _norm_name(company.get("name", "")):
        raise HTTPException(400, "Company name doesn't match")
    if company.get("is_firm_books") or company.get("is_partner_books"):
        raise HTTPException(403, "Firm/Partner Books are protected — convert them to a regular company first")
    removed = await purge_company_data(cid)
    await db.admin_audit_log.insert_one({
        "id": str(uuid.uuid4()), "kind": "company_deleted_by_admin", "granting_admin_id": user["id"],
        "granting_admin_email": user.get("email"), "target_user_id": uid, "company_id": cid,
        "company_name": company.get("name"), "records_removed": removed, "at": now_iso(),
    })
    return {"deleted": True, "company_id": cid, "records_removed": removed}


class ConfirmEmail(BaseModel):
    confirm_email: str


@router.post("/admin/users/{uid}/delete")
async def admin_delete_user(uid: str, body: ConfirmEmail, user: dict = Depends(require_role("superadmin"))):
    """'Delete user' = strip every membership + firm link and demote to
    `affiliate`. Login, referral slug, earnings and /share stay intact."""
    u = await db.users.find_one({"id": uid})
    if not u:
        raise HTTPException(404, "User not found")
    if uid == user["id"]:
        raise HTTPException(400, "You can't delete your own account")
    if u.get("role") == "superadmin":
        raise HTTPException(403, "Revoke superadmin first")
    if (body.confirm_email or "").strip().lower() != (u.get("email") or "").lower():
        raise HTTPException(400, "Email doesn't match")
    if await _owned_companies(uid):
        raise HTTPException(409, "Delete or reassign this user's companies first")
    if await _enterprise_block(u):
        raise HTTPException(409, "Transfer this partner/enterprise's users first")
    removed: dict[str, int] = {}
    r = await db.memberships.delete_many({"user_id": uid})
    removed["memberships"] = r.deleted_count
    for coll in _USER_SCOPED:
        try:
            r = await db[coll].delete_many({"$or": [{"user_id": uid}, {"invited_by": uid}]})
        except Exception:  # noqa: BLE001
            continue
        if r.deleted_count:
            removed[coll] = r.deleted_count
    await db.users.update_one({"id": uid}, {
        "$set": {"role": "affiliate", "demoted_to_affiliate_at": now_iso(), "demoted_by": user["id"],
                 "previous_role": u.get("role"), "updated_at": now_iso()},
        "$unset": {"enterprise_id": "", "partner_id": "", "branding": "", "firm_name": ""},
    })
    await db.admin_audit_log.insert_one({
        "id": str(uuid.uuid4()), "kind": "user_deleted_to_affiliate", "granting_admin_id": user["id"],
        "granting_admin_email": user.get("email"), "target_user_id": uid, "target_email": u.get("email"),
        "previous_role": u.get("role"), "new_role": "affiliate", "records_removed": removed, "at": now_iso(),
    })
    return {"ok": True, "new_role": "affiliate", "records_removed": removed}
