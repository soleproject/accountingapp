"""Team-invite endpoints — Feature #3 (Feb 2026).

Supports four invite flavours from a single unified table + endpoint pair:

  * Company-level invites — a client-owner (or Pro managing them) invites a
    teammate/staff/external accountant with role ``editor|reviewer|viewer``
    against ONE specific company. Multiple accountants are allowed on the
    same company — no artificial cap.

  * Pro firm-staff invites — a Pro invites another user with role ``pro``
    and picks a *subset* of the Pro's client companies the invitee will
    have access to.

  * Superadmin invites — invite another superadmin, or bootstrap a new
    ``pro`` account (with no client-companies yet).

All flavours use the same magic-link acceptance flow (``/invite/{token}``)
and reuse the ``password_set_tokens`` mechanic when the invitee is a new
user. On accept we materialize the requested memberships and, for new
users, log them straight in.

Roles are stored on ``memberships.role`` — the existing values
``owner`` and ``pro`` still work; the new values ``editor``, ``reviewer``,
``viewer`` compose additively (any role above ``viewer`` implicitly
carries the strictly-lower privileges).
"""
from __future__ import annotations
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from auth import get_current_user, require_role, hash_password

router = APIRouter(prefix="/api")

# Company-scoped roles the invite flow can grant, in *strictly* increasing
# order of privilege. Owner is minted only via the New-Client flow.
COMPANY_ROLES = ("viewer", "reviewer", "editor")


class CompanyInviteIn(BaseModel):
    email: EmailStr
    role: Literal["editor", "reviewer", "viewer"] = "editor"
    name: Optional[str] = None


class ProInviteIn(BaseModel):
    """Pro-firm invite: the invitee is granted role=``pro`` on the picked
    ``company_ids``. Empty list = firm-staff-with-no-clients (still lets
    them log in and be added later)."""
    email: EmailStr
    company_ids: list[str] = Field(default_factory=list)
    name: Optional[str] = None


class AdminInviteIn(BaseModel):
    """Superadmin invite. ``role`` picks whether we're minting another
    ``superadmin`` or bootstrapping a new ``pro`` account (no clients yet)."""
    email: EmailStr
    role: Literal["superadmin", "pro"] = "pro"
    name: Optional[str] = None


class AcceptInviteIn(BaseModel):
    password: str = Field(min_length=8, max_length=200)
    name: Optional[str] = None


async def _existing_user(email: str) -> Optional[dict]:
    return await db.users.find_one({"email": email.lower()})


async def _create_invite(
    *, email: str, inviter: dict,
    role: str, company_ids: list[str],
    invitee_name: Optional[str] = None,
    ttl_days: int = 14,
) -> dict:
    """Insert the invite row + return the doc (which also contains the
    magic-link ``token``). Any older *pending* invite for the same email
    into the same scope is superseded so only the newest link works."""
    email = email.lower()
    now = datetime.now(timezone.utc)
    token = secrets.token_urlsafe(32)

    scope_key = "|".join(sorted(company_ids)) or f"role:{role}"
    await db.invites.update_many(
        {"email": email, "scope_key": scope_key, "status": "pending"},
        {"$set": {"status": "superseded", "superseded_at": now.isoformat()}},
    )

    doc = {
        "id": str(uuid.uuid4()),
        "token": token,
        "email": email,
        "invitee_name": invitee_name,
        "role": role,
        "company_ids": company_ids,
        "scope_key": scope_key,
        "invited_by_user_id": inviter["id"],
        "invited_by_name": inviter.get("name") or inviter.get("email"),
        "status": "pending",
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=ttl_days)).isoformat(),
    }
    await db.invites.insert_one(doc)
    return doc


def _labels_for_email(*, role: str, count: int) -> tuple[str, str]:
    """Return (short role label, friendly description) used in the invite
    email body."""
    if role == "pro":
        return ("Accounting professional", f"you'll have Pro-level access to {count} client{'' if count == 1 else 's'} in SmartBooks.")
    if role == "superadmin":
        return ("Superadmin", "you'll have full platform-level access.")
    verbs = {"editor": "categorize, post journal entries, and reconcile",
             "reviewer": "review and approve/reject entries",
             "viewer": "view reports and transactions (read-only)"}
    return (role.capitalize(), f"you'll be able to {verbs[role]}.")


async def _send_invite_email(*, invite: dict, inviter: dict, company_names: list[str]) -> None:
    """Best-effort invite email; logs but never raises so the invite row
    survives even if Resend has a hiccup."""
    from email_dispatcher import dispatch, public_base_url
    import email_templates as _tmpl
    label, description = _labels_for_email(role=invite["role"], count=len(company_names))
    magic_url = f"{public_base_url()}/invite/{invite['token']}"
    subject, html = _tmpl.team_invite(
        invitee_name=invite.get("invitee_name") or "there",
        inviter_name=inviter.get("name") or inviter.get("email") or "A colleague",
        role_label=label,
        role_description=description,
        company_names=company_names,
        magic_url=magic_url,
    )
    try:
        await dispatch(
            kind="team_invite", to=invite["email"],
            subject=subject, html=html,
            initiating_user_id=inviter["id"],
            company_id=invite["company_ids"][0] if invite["company_ids"] else None,
            related={"invite_id": invite["id"], "role": invite["role"]},
        )
    except Exception:  # noqa: BLE001
        import logging as _lg
        _lg.getLogger(__name__).exception("Invite email failed (invite still stored)")


# ==========================================================================
# Endpoints — CREATE
# ==========================================================================

@router.post("/companies/{cid}/invites")
async def create_company_invite(
    cid: str, inp: CompanyInviteIn,
    user: dict = Depends(get_current_user),
):
    """Client-owner (or Pro/superadmin managing that company) invites a
    teammate/external accountant. Role must be one of the 3 company-level
    roles — Owner is minted only via New-Client."""
    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found.")
    # Only owner/pro/superadmin can invite. Editors/reviewers/viewers cannot
    # invite further teammates (kept intentionally strict).
    m = await db.memberships.find_one({"user_id": user["id"], "company_id": cid})
    inviter_role = (m or {}).get("role") if m else None
    if user["role"] != "superadmin" and inviter_role not in {"owner", "pro"}:
        raise HTTPException(403, "You don't have permission to invite teammates to this company.")

    invite = await _create_invite(
        email=str(inp.email), inviter=user,
        role=inp.role, company_ids=[cid],
        invitee_name=inp.name,
    )
    await _send_invite_email(invite=invite, inviter=user, company_names=[company["name"]])
    return {"invite_id": invite["id"], "token": invite["token"], "email": invite["email"]}


@router.post("/pro/invites")
async def create_pro_invite(
    inp: ProInviteIn, user: dict = Depends(require_role("pro", "superadmin")),
):
    """Pro invites another firm-staff user with role=pro. Only the client
    companies where the *inviter* has a pro-membership can be granted."""
    if user["role"] == "pro":
        pro_memberships = await db.memberships.find({
            "user_id": user["id"], "role": "pro",
        }).to_list(1000)
        allowed = {m["company_id"] for m in pro_memberships}
        picked = set(inp.company_ids)
        if not picked.issubset(allowed):
            raise HTTPException(403, "You can only grant access to your own client companies.")

    company_ids = list(inp.company_ids)
    if company_ids:
        cs = await db.companies.find({"id": {"$in": company_ids}}).to_list(1000)
        names = [c["name"] for c in cs]
    else:
        names = []

    invite = await _create_invite(
        email=str(inp.email), inviter=user,
        role="pro", company_ids=company_ids,
        invitee_name=inp.name,
    )
    await _send_invite_email(invite=invite, inviter=user, company_names=names)
    return {"invite_id": invite["id"], "token": invite["token"], "email": invite["email"], "company_count": len(company_ids)}


@router.post("/admin/invites")
async def create_admin_invite(
    inp: AdminInviteIn, user: dict = Depends(require_role("superadmin")),
):
    """Superadmin invites another superadmin OR bootstraps a new Pro account."""
    invite = await _create_invite(
        email=str(inp.email), inviter=user,
        role=inp.role, company_ids=[], invitee_name=inp.name,
    )
    await _send_invite_email(invite=invite, inviter=user, company_names=[])
    return {"invite_id": invite["id"], "token": invite["token"], "email": invite["email"], "role": invite["role"]}


# ==========================================================================
# Endpoints — LIST + REVOKE
# ==========================================================================

@router.get("/companies/{cid}/team")
async def list_company_team(cid: str, user: dict = Depends(get_current_user)):
    """Return every membership + pending invite scoped to the company. Used
    by the Company → Team surface."""
    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found.")
    # Access check — any member can view the team roster.
    m = await db.memberships.find_one({"user_id": user["id"], "company_id": cid})
    if not m and user["role"] != "superadmin":
        raise HTTPException(403, "No access to this company.")

    ms = await db.memberships.find({"company_id": cid}).to_list(500)
    user_ids = [x["user_id"] for x in ms]
    users = {u["id"]: u for u in await db.users.find({"id": {"$in": user_ids}}).to_list(500)}
    members = [
        {
            "user_id": x["user_id"],
            "name": users.get(x["user_id"], {}).get("name"),
            "email": users.get(x["user_id"], {}).get("email"),
            "role": x["role"],
            "created_at": x.get("created_at"),
        }
        for x in ms
    ]
    invites = await db.invites.find({
        "company_ids": cid, "status": "pending",
    }).to_list(500)
    return {
        "members": members,
        "pending_invites": [
            {
                "id": i["id"], "email": i["email"], "role": i["role"],
                "created_at": i["created_at"], "expires_at": i["expires_at"],
                "invited_by_name": i.get("invited_by_name"),
            }
            for i in invites
        ],
    }


@router.get("/pro/team")
async def list_pro_team(user: dict = Depends(require_role("pro", "superadmin"))):
    """All firm-staff users the current Pro has invited or who share
    Pro-memberships on the same client companies."""
    # Companies I manage.
    my_ms = await db.memberships.find({"user_id": user["id"], "role": "pro"}).to_list(1000)
    my_cids = {m["company_id"] for m in my_ms}

    # Other users with pro membership on any of my companies (my firm).
    others = await db.memberships.find({
        "company_id": {"$in": list(my_cids)},
        "role": "pro",
        "user_id": {"$ne": user["id"]},
    }).to_list(1000)
    grouped: dict[str, list[str]] = {}
    for m in others:
        grouped.setdefault(m["user_id"], []).append(m["company_id"])
    users = {u["id"]: u for u in await db.users.find({"id": {"$in": list(grouped)}}).to_list(500)}

    members = [
        {
            "user_id": uid,
            "name": users.get(uid, {}).get("name"),
            "email": users.get(uid, {}).get("email"),
            "company_ids": cids,
        }
        for uid, cids in grouped.items()
    ]
    invites = await db.invites.find({
        "invited_by_user_id": user["id"], "role": "pro", "status": "pending",
    }).to_list(500)
    return {
        "members": members,
        "pending_invites": [
            {
                "id": i["id"], "email": i["email"], "role": i["role"],
                "company_ids": i.get("company_ids") or [],
                "created_at": i["created_at"], "expires_at": i["expires_at"],
            }
            for i in invites
        ],
    }


@router.delete("/invites/{invite_id}")
async def revoke_invite(invite_id: str, user: dict = Depends(get_current_user)):
    """Only the original inviter (or a superadmin) can revoke."""
    inv = await db.invites.find_one({"id": invite_id})
    if not inv:
        raise HTTPException(404, "Invite not found.")
    if user["role"] != "superadmin" and inv["invited_by_user_id"] != user["id"]:
        raise HTTPException(403, "Only the inviter can revoke this invite.")
    await db.invites.update_one(
        {"id": invite_id},
        {"$set": {"status": "revoked", "revoked_at": now_iso(), "revoked_by": user["id"]}},
    )
    return {"ok": True}


# ==========================================================================
# Membership-management (post-accept team edits)
# ==========================================================================

class StaffAccessIn(BaseModel):
    """New complete list of client company IDs the staff member should
    have access to. Diffed against current — memberships are added or
    removed to match exactly."""
    company_ids: list[str]


@router.put("/pro/staff/{user_id}/access")
async def update_pro_staff_access(
    user_id: str, inp: StaffAccessIn,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Reset a firm-staff member's access to exactly the listed companies
    (which must all be companies the CURRENT Pro manages). Adds any
    missing ``pro`` memberships and removes any that are no longer in the
    list. Never touches memberships on companies the current Pro does not
    manage — a staff member's access via a different Pro stays intact."""
    if user["role"] == "pro":
        my = await db.memberships.find(
            {"user_id": user["id"], "role": "pro"},
        ).to_list(1000)
        allowed = {m["company_id"] for m in my}
    else:
        allowed = None   # superadmin — no restriction

    picked = set(inp.company_ids)
    if allowed is not None and not picked.issubset(allowed):
        raise HTTPException(403, "You can only grant access to your own client companies.")

    # Current memberships (constrained to the current Pro's client set).
    existing = await db.memberships.find({
        "user_id": user_id, "role": "pro",
        **({"company_id": {"$in": list(allowed)}} if allowed is not None else {}),
    }).to_list(1000)
    existing_ids = {m["company_id"] for m in existing}

    to_add = picked - existing_ids
    to_remove = existing_ids - picked

    now = now_iso()
    if to_add:
        await db.memberships.insert_many([
            {
                "id": str(uuid.uuid4()),
                "user_id": user_id, "company_id": cid, "role": "pro",
                "created_at": now, "granted_by": user["id"],
            }
            for cid in to_add
        ])
    if to_remove:
        await db.memberships.delete_many({
            "user_id": user_id, "role": "pro",
            "company_id": {"$in": list(to_remove)},
        })

    return {"added": list(to_add), "removed": list(to_remove), "total": len(picked)}


@router.delete("/pro/staff/{user_id}")
async def remove_pro_staff(
    user_id: str, user: dict = Depends(require_role("pro", "superadmin")),
):
    """Revoke ALL of a staff member's ``pro`` memberships on the current
    Pro's clients. The user account itself is NOT deleted — they may
    still have memberships on other Pros' clients, or a login unrelated
    to this firm. This is effectively "archive from my firm"."""
    if user["role"] == "pro":
        my = await db.memberships.find(
            {"user_id": user["id"], "role": "pro"},
        ).to_list(1000)
        my_cids = [m["company_id"] for m in my]
        result = await db.memberships.delete_many({
            "user_id": user_id, "role": "pro",
            "company_id": {"$in": my_cids},
        })
    else:
        # Superadmin can nuke all pro memberships for this user.
        result = await db.memberships.delete_many({
            "user_id": user_id, "role": "pro",
        })
    return {"removed": result.deleted_count}


class CompanyMemberPatch(BaseModel):
    role: Literal["editor", "reviewer", "viewer"]


@router.patch("/companies/{cid}/team/{user_id}")
async def update_company_member_role(
    cid: str, user_id: str, inp: CompanyMemberPatch,
    user: dict = Depends(get_current_user),
):
    """Change a company teammate's role (editor/reviewer/viewer).
    Owners on the company cannot be re-roled here — that requires
    ownership transfer, which isn't in scope for this feature."""
    m = await db.memberships.find_one({"user_id": user_id, "company_id": cid})
    if not m:
        raise HTTPException(404, "Member not found on this company.")
    if m["role"] in {"owner", "pro"}:
        raise HTTPException(400, "Owner and Pro memberships can't be re-roled here.")

    my = await db.memberships.find_one({"user_id": user["id"], "company_id": cid})
    if user["role"] != "superadmin" and (my or {}).get("role") not in {"owner", "pro"}:
        raise HTTPException(403, "Only owners or Pros can change teammate roles.")

    await db.memberships.update_one(
        {"id": m["id"]},
        {"$set": {"role": inp.role, "updated_at": now_iso()}},
    )
    return {"user_id": user_id, "role": inp.role}


@router.delete("/companies/{cid}/team/{user_id}")
async def remove_company_member(
    cid: str, user_id: str, user: dict = Depends(get_current_user),
):
    """Remove a teammate (editor/reviewer/viewer) from a specific
    company. Owner and Pro memberships cannot be removed here."""
    m = await db.memberships.find_one({"user_id": user_id, "company_id": cid})
    if not m:
        raise HTTPException(404, "Member not found on this company.")
    if m["role"] in {"owner", "pro"}:
        raise HTTPException(400, "Owner and Pro memberships can't be removed here.")

    my = await db.memberships.find_one({"user_id": user["id"], "company_id": cid})
    if user["role"] != "superadmin" and (my or {}).get("role") not in {"owner", "pro"}:
        raise HTTPException(403, "Only owners or Pros can remove teammates.")

    await db.memberships.delete_one({"id": m["id"]})
    return {"ok": True}


# ==========================================================================
# Endpoints — PUBLIC accept (magic-link)
# ==========================================================================

@router.get("/invites/{token}")
async def public_invite_check(token: str):
    """Public — validate the magic-link and return a preview of what
    accepting it will grant, so the UI can greet the invitee properly."""
    inv = await db.invites.find_one({"token": token})
    if not inv:
        raise HTTPException(404, "This invitation link is invalid.")
    if inv["status"] == "accepted":
        raise HTTPException(410, "This invitation has already been used.")
    if inv["status"] == "revoked":
        raise HTTPException(410, "This invitation was revoked.")
    if inv["status"] == "superseded":
        raise HTTPException(410, "A newer invitation was sent to your email. Please use that one.")
    if inv["expires_at"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(410, "This invitation has expired.")

    inviter = await db.users.find_one({"id": inv["invited_by_user_id"]}) or {}
    company_names: list[str] = []
    if inv["company_ids"]:
        cs = await db.companies.find({"id": {"$in": inv["company_ids"]}}).to_list(50)
        company_names = [c["name"] for c in cs]

    existing = await _existing_user(inv["email"])
    return {
        "email": inv["email"],
        "role": inv["role"],
        "company_names": company_names,
        "inviter_name": inviter.get("name") or inviter.get("email"),
        "needs_password": not existing or bool(existing.get("must_set_password")),
    }


@router.post("/invites/{token}/accept")
async def public_invite_accept(token: str, inp: AcceptInviteIn):
    """Public — accept the invite. Creates the user (or attaches to the
    existing one), materializes memberships, marks the invite consumed,
    and issues a JWT so the invitee is logged in immediately."""
    from auth import create_token
    inv = await db.invites.find_one({"token": token})
    if not inv:
        raise HTTPException(404, "This invitation link is invalid.")
    if inv["status"] != "pending":
        raise HTTPException(410, "This invitation is no longer valid.")
    if inv["expires_at"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(410, "This invitation has expired.")

    # Atomic single-use claim.
    claim = await db.invites.update_one(
        {"id": inv["id"], "status": "pending"},
        {"$set": {"status": "accepted", "accepted_at": now_iso()}},
    )
    if claim.modified_count != 1:
        raise HTTPException(410, "This invitation is no longer valid.")

    existing = await _existing_user(inv["email"])
    now = now_iso()
    if existing:
        user_id = existing["id"]
        # Update password only if the account is new-ish (never set their own).
        if existing.get("must_set_password"):
            await db.users.update_one(
                {"id": user_id},
                {"$set": {
                    "password": hash_password(inp.password),
                    "must_set_password": False,
                    "name": inp.name or existing.get("name") or inv.get("invitee_name") or existing["email"].split("@")[0],
                    "updated_at": now,
                }},
            )
        # An existing pro/superadmin invited into a plain company keeps
        # their firm-level role globally; we still add the per-company
        # membership below so `require_company` passes.
        role_for_user = existing.get("role") or inv["role"]
    else:
        user_id = str(uuid.uuid4())
        # If the invitee is being minted as a pro/superadmin, that's the
        # user's global role; otherwise this is a per-company teammate and
        # they default to the "client" global role.
        global_role = inv["role"] if inv["role"] in {"pro", "superadmin"} else "client"
        await db.users.insert_one({
            "id": user_id,
            "email": inv["email"],
            "name": inp.name or inv.get("invitee_name") or inv["email"].split("@")[0],
            "password": hash_password(inp.password),
            "role": global_role,
            "must_set_password": False,
            "created_at": now, "updated_at": now,
        })
        role_for_user = global_role

    # Materialize memberships (dedupe existing to keep idempotent).
    if inv["company_ids"]:
        for cid in inv["company_ids"]:
            exists_m = await db.memberships.find_one({"user_id": user_id, "company_id": cid})
            if exists_m:
                # Upgrade role if the invite grants strictly more privilege
                # (viewer < reviewer < editor). owner/pro are separate axes
                # and we don't downgrade them.
                if inv["role"] not in {"owner", "pro"} and exists_m.get("role") in COMPANY_ROLES:
                    if COMPANY_ROLES.index(inv["role"]) > COMPANY_ROLES.index(exists_m["role"]):
                        await db.memberships.update_one(
                            {"id": exists_m["id"]}, {"$set": {"role": inv["role"]}},
                        )
                continue
            await db.memberships.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user_id, "company_id": cid, "role": inv["role"],
                "created_at": now,
            })

    jwt_tok = create_token(user_id, role_for_user)
    fresh = await db.users.find_one({"id": user_id})
    return {
        "token": jwt_tok,
        "user": {
            "id": user_id, "email": fresh["email"],
            "name": fresh["name"], "role": fresh["role"],
        },
    }
