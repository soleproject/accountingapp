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
    ent = await db.enterprises.find_one({"owner_user_id": u["id"], "merged_into": {"$in": [None, ""]}},
                                        {"_id": 0, "id": 1, "name": 1, "partner_id": 1})
    if ent:
        n_cos = await db.companies.count_documents({"enterprise_id": ent["id"]})
        n_users = await db.users.count_documents({"enterprise_id": ent["id"], "id": {"$ne": u["id"]}})
        n_inv = await db.enterprise_invoices.count_documents({"enterprise_id": ent["id"]})
        targets = [{"id": e["id"], "name": e.get("name")} async for e in db.enterprises.find(
            {"id": {"$ne": ent["id"]}, "owner_user_id": {"$nin": [None, "", u["id"]]},
             "merged_into": {"$in": [None, ""]}, "status": {"$ne": "archived"}},
            {"_id": 0, "id": 1, "name": 1}).sort("name", 1)]
        return {"kind": "enterprise", "id": ent["id"], "name": ent.get("name"), "companies": n_cos,
                "users": n_users, "invoices": n_inv, "targets": targets}
    if u.get("role") == "partner" and not u.get("partner_merged_into"):
        pid = u["id"]
        n_ents = await db.enterprises.count_documents({"partner_id": pid})
        n_cos = await db.companies.count_documents({"partner_id": pid})
        n_users = await db.users.count_documents({"partner_id": pid, "id": {"$ne": pid}})
        targets = [{"id": p["id"], "name": (p.get("branding") or {}).get("firm_name") or p.get("name") or p.get("email")}
                   async for p in db.users.find({"role": "partner", "id": {"$ne": pid}, "partner_merged_into": {"$in": [None, ""]}},
                                                {"_id": 0, "id": 1, "name": 1, "email": 1, "branding.firm_name": 1}).sort("name", 1)]
        return {"kind": "partner", "id": pid, "name": (u.get("branding") or {}).get("firm_name") or u.get("name"),
                "enterprises": n_ents, "companies": n_cos, "users": n_users, "targets": targets}
    return None


async def _swap_pro_seats(from_uid: str, to_uid: str, company_ids: list[str]) -> int:
    """Move firm-pro memberships on the given companies from one owner to another."""
    if not company_ids:
        return 0
    r = await db.memberships.delete_many({"company_id": {"$in": company_ids}, "user_id": from_uid, "role": "pro"})
    have = {m["company_id"] for m in await db.memberships.find(
        {"company_id": {"$in": company_ids}, "user_id": to_uid}, {"_id": 0, "company_id": 1}).to_list(5000)}
    docs = [{"id": str(uuid.uuid4()), "user_id": to_uid, "company_id": cid, "role": "pro",
             "created_at": now_iso(), "via": "admin_transfer"} for cid in company_ids if cid not in have]
    if docs:
        await db.memberships.insert_many(docs)
    return r.deleted_count


async def _unflag_own_books(uid: str) -> int:
    """Firm/Partner Books of a departing owner become regular companies so they can be deleted."""
    r = await db.companies.update_many(
        {"owner_user_id": uid, "$or": [{"is_firm_books": True}, {"is_partner_books": True}]},
        {"$set": {"is_firm_books": False, "is_partner_books": False, "was_firm_books": True, "updated_at": now_iso()}})
    return r.modified_count


class TransferIn(BaseModel):
    target_id: str
    confirm_name: str


@router.post("/admin/users/{uid}/transfer-firm")
async def admin_transfer_firm(uid: str, body: TransferIn, user: dict = Depends(require_role("superadmin"))):
    """Move everything under this enterprise/partner owner to another firm."""
    from routes.companies import _norm_name
    u = await db.users.find_one({"id": uid})
    if not u:
        raise HTTPException(404, "User not found")
    block = await _enterprise_block(u)
    if not block:
        raise HTTPException(400, "This user doesn't own an enterprise or partner")
    target = next((t for t in block["targets"] if t["id"] == body.target_id), None)
    if not target:
        raise HTTPException(404, "Target firm not found")
    if _norm_name(body.confirm_name) != _norm_name(target["name"] or ""):
        raise HTTPException(400, "Target firm name doesn't match")
    now = now_iso()
    moved: dict[str, int] = {}

    if block["kind"] == "enterprise":
        src_eid, tgt_eid = block["id"], target["id"]
        tgt = await db.enterprises.find_one({"id": tgt_eid}, {"_id": 0, "owner_user_id": 1, "partner_id": 1})
        tgt_owner = tgt["owner_user_id"]
        partner_set = {"partner_id": tgt["partner_id"]} if tgt.get("partner_id") else {}
        partner_unset = {} if tgt.get("partner_id") else {"partner_id": ""}
        cids = [c["id"] for c in await db.companies.find({"enterprise_id": src_eid}, {"_id": 0, "id": 1}).to_list(5000)]
        pro_cids = [m["company_id"] for m in await db.memberships.find(
            {"user_id": uid, "role": "pro"}, {"_id": 0, "company_id": 1}).to_list(5000)]
        upd = {"$set": {"enterprise_id": tgt_eid, "updated_at": now, **partner_set}}
        if partner_unset:
            upd["$unset"] = partner_unset
        r = await db.companies.update_many({"enterprise_id": src_eid}, upd)
        moved["companies"] = r.modified_count
        uupd = {"$set": {"enterprise_id": tgt_eid, "updated_at": now, **partner_set}}
        if partner_unset:
            uupd["$unset"] = partner_unset
        r = await db.users.update_many({"enterprise_id": src_eid, "id": {"$ne": uid}}, uupd)
        moved["users"] = r.modified_count
        moved["pro_seats"] = await _swap_pro_seats(uid, tgt_owner, sorted(set(cids) | set(pro_cids)))
        r = await db.enterprise_invoices.update_many({"enterprise_id": src_eid},
                                                     {"$set": {"enterprise_id": tgt_eid, "transferred_from": src_eid}})
        moved["invoices"] = r.modified_count
        await db.enterprises.update_one({"id": src_eid}, {"$set": {
            "merged_into": tgt_eid, "merged_at": now, "status": "archived", "archived_at": now, "updated_at": now}})
        await db.users.update_one({"id": uid}, {"$unset": {"enterprise_id": ""}, "$set": {"updated_at": now}})
    else:
        src_pid, tgt_pid = block["id"], target["id"]
        cids = [c["id"] for c in await db.companies.find({"partner_id": src_pid}, {"_id": 0, "id": 1}).to_list(5000)]
        pro_cids = [m["company_id"] for m in await db.memberships.find(
            {"user_id": uid, "role": "pro"}, {"_id": 0, "company_id": 1}).to_list(5000)]
        r = await db.enterprises.update_many({"partner_id": src_pid}, {"$set": {"partner_id": tgt_pid, "updated_at": now}})
        moved["enterprises"] = r.modified_count
        r = await db.companies.update_many({"partner_id": src_pid}, {"$set": {"partner_id": tgt_pid, "updated_at": now}})
        moved["companies"] = r.modified_count
        r = await db.users.update_many({"partner_id": src_pid, "id": {"$ne": uid}}, {"$set": {"partner_id": tgt_pid, "updated_at": now}})
        moved["users"] = r.modified_count
        moved["pro_seats"] = await _swap_pro_seats(uid, tgt_pid, sorted(set(cids) | set(pro_cids)))
        await db.partners.update_one({"id": src_pid}, {"$set": {"merged_into": tgt_pid, "merged_at": now}})
        await db.users.update_one({"id": uid}, {"$set": {"partner_merged_into": tgt_pid, "updated_at": now}})
    moved["books_unflagged"] = await _unflag_own_books(uid)

    await db.admin_audit_log.insert_one({
        "id": str(uuid.uuid4()), "kind": f"{block['kind']}_transferred", "granting_admin_id": user["id"],
        "granting_admin_email": user.get("email"), "target_user_id": uid, "source_id": block["id"],
        "source_name": block["name"], "destination_id": target["id"], "destination_name": target["name"],
        "moved": moved, "at": now,
    })
    return {"ok": True, "kind": block["kind"], "moved": moved, "target": target}


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
