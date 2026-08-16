"""Feedback (bug reports + product recommendations).

Any signed-in user can `POST /api/feedback` to file a bug or recommendation
— optionally with screenshot attachments. Every submission emails every
user with `role == "superadmin"`. Superadmins triage via `/admin/feedback`
using a 4-state workflow (new / in_progress / completed / wont_do).

Communication model (Feb 2026):
  • Notes have `visibility: "internal" | "reporter"`.
      - Internal notes are only ever visible to superadmins.
      - Reporter notes appear on the submitter's `/feedback/mine`.
  • A note posted with `visibility=reporter` may optionally trigger an
    email to the reporter (`send_email=True`).
  • Every item has `notify_submitter: bool` (default TRUE). When true,
    status changes email the reporter automatically.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import get_current_user, require_role
from db import db, now_iso, coerce

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["feedback"])


# --------------------------------------------------------------------------
# Constants + payloads
# --------------------------------------------------------------------------
VALID_TYPES = {"bug", "recommendation"}
VALID_STATUSES = {"new", "in_progress", "completed", "wont_do"}
VALID_VISIBILITIES = {"internal", "reporter"}
STATUS_LABELS = {
    "new": "New",
    "in_progress": "In progress",
    "completed": "Completed",
    "wont_do": "Won't do",
}

# 5 MB per image, 20 MB per submission — cheap Mongo doc-size guardrail.
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024
ALLOWED_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


class FeedbackAttachment(BaseModel):
    filename: str = Field(..., max_length=200)
    mime: str = Field(..., max_length=100)
    data_url: str = Field(..., description="base64 data URL: data:image/png;base64,...")


class FeedbackCreate(BaseModel):
    type: str
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field("", max_length=5000)
    route: Optional[str] = Field(None, max_length=500)
    user_agent: Optional[str] = Field(None, max_length=500)
    company_id: Optional[str] = None
    attachments: List[FeedbackAttachment] = Field(default_factory=list)


class FeedbackPatch(BaseModel):
    status: Optional[str] = None
    admin_note: Optional[str] = None
    note_visibility: Optional[str] = None  # "internal" | "reporter"
    email_reporter: bool = False           # if note_visibility==reporter, also email
    notify_submitter: Optional[bool] = None


class FeedbackReporterReply(BaseModel):
    """Reporter posts a follow-up in the thread from `/feedback/mine`."""
    note: str = Field(..., min_length=1, max_length=2000)
    attachments: List[FeedbackAttachment] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _scrub(row: dict) -> dict:
    row = coerce(row)
    row.pop("_id", None)
    return row


def _is_unread_for_reporter(row: dict) -> bool:
    """A ticket is unread for the reporter if any superadmin-authored,
    reporter-visible note has landed after their `reporter_last_read_at`
    marker. Internal-only notes never count."""
    last = row.get("reporter_last_read_at")
    for n in row.get("admin_notes") or []:
        if (n.get("author_role") or "superadmin") != "superadmin":
            continue
        if (n.get("visibility") or "internal") != "reporter":
            continue
        if not last or (n.get("at") or "") > last:
            return True
    return False


def _is_unread_for_admin(row: dict, admin_id: str) -> bool:
    """A ticket is unread for a given admin if it's brand-new (never seen)
    or has a reporter follow-up newer than that admin's last read."""
    reads = row.get("admin_reads") or {}
    last = reads.get(admin_id)
    if not last:
        return True  # never opened
    # Reporter follow-ups after last read?
    for n in row.get("admin_notes") or []:
        if (n.get("author_role") or "superadmin") != "reporter":
            continue
        if (n.get("at") or "") > last:
            return True
    return False


def _scrub_for_submitter(row: dict) -> dict:
    """Return a copy safe to send to the submitter: internal notes stripped."""
    unread = _is_unread_for_reporter(row)
    row = _scrub(row)
    notes = row.get("admin_notes") or []
    row["admin_notes"] = [n for n in notes if (n.get("visibility") or "internal") == "reporter"]
    row["unread"] = unread
    # Drop the admin_reads dict from the reporter's view — it's admin-only
    row.pop("admin_reads", None)
    return row


_DATA_URL_RE = re.compile(r"^data:(?P<mime>[\w./+-]+);base64,(?P<b64>[A-Za-z0-9+/=\s]+)$")


def _validate_attachments(atts: List[FeedbackAttachment]) -> List[dict]:
    """Accept only image data-URLs; strip anything oversized. Returns the
    persisted dict-form (with an id + timestamp)."""
    out: list[dict] = []
    total = 0
    for a in atts:
        m = _DATA_URL_RE.match(a.data_url.strip())
        if not m:
            raise HTTPException(status_code=400, detail=f"Bad attachment format ({a.filename})")
        mime = m.group("mime").lower()
        if mime not in ALLOWED_MIMES:
            raise HTTPException(status_code=400, detail=f"Only image uploads allowed ({a.filename})")
        b64 = m.group("b64")
        # Approximate decoded size: len(b64) * 3/4 minus padding
        approx = int(len(b64) * 0.75)
        if approx > MAX_ATTACHMENT_BYTES:
            raise HTTPException(status_code=400, detail=f"Attachment too large ({a.filename}, max 5MB)")
        total += approx
        if total > MAX_TOTAL_ATTACHMENT_BYTES:
            raise HTTPException(status_code=400, detail="Attachments over 20MB total")
        out.append({
            "id": str(uuid.uuid4()),
            "filename": (a.filename or "attachment").strip()[:200],
            "mime": mime,
            "data_url": a.data_url.strip(),
            "size": approx,
            "at": now_iso(),
        })
    return out


async def _resolve_context(user: dict, company: Optional[dict]) -> dict:
    """Partner + Enterprise attribution — never raises."""
    partner_id = partner_name = None
    enterprise_id = enterprise_name = None

    def _brand(u: dict) -> str:
        return (
            ((u or {}).get("branding") or {}).get("firm_name")
            or (u or {}).get("firm_name")
            or (u or {}).get("name")
            or (u or {}).get("email")
            or "Partner"
        )

    if user.get("role") == "partner":
        partner_id = user["id"]
        partner_name = _brand(user)
    else:
        pid = user.get("partner_id") or (company or {}).get("partner_id")
        if pid:
            p = await db.users.find_one({"id": pid, "role": "partner"})
            if p:
                partner_id, partner_name = p["id"], _brand(p)

    eid = user.get("enterprise_id")
    if not eid and company:
        pro_uid = company.get("pro_user_id")
        if pro_uid:
            pro = await db.users.find_one({"id": pro_uid})
            if pro:
                eid = pro.get("enterprise_id")
    if eid:
        ent = await db.enterprises.find_one({"id": eid})
        if ent:
            enterprise_id = ent["id"]
            enterprise_name = ent.get("name")
            if not partner_id and ent.get("partner_id"):
                p = await db.users.find_one({"id": ent["partner_id"], "role": "partner"})
                if p:
                    partner_id, partner_name = p["id"], _brand(p)

    return {
        "partner_id": partner_id,
        "partner_name": partner_name,
        "enterprise_id": enterprise_id,
        "enterprise_name": enterprise_name,
    }


# Reserved test-domain suffixes (RFC 2606 / RFC 6761). Any email
# address ending in one of these is treated as a synthetic pytest
# fixture and MUST NOT trigger real Resend fanout — see the Feb 25
# 2026 incident where a pytest run flooded the ops inbox.
_TEST_EMAIL_SUFFIXES = (
    "@example.com", "@example.org", "@example.net",
    ".test", ".invalid", ".localhost",
)


def _is_test_email(addr: str | None) -> bool:
    """True when `addr` ends with a reserved test domain."""
    if not addr:
        return False
    a = addr.strip().lower()
    return any(a.endswith(sfx) for sfx in _TEST_EMAIL_SUFFIXES)


async def _notify_superadmins(item: dict, submitter: dict) -> None:
    try:
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl

        # Belt-and-suspenders: if the submitter is a test-shaped user
        # (e.g. `fb_XXXXXX@example.com` seeded by pytest), never fan
        # out to real superadmins. Feb 25 2026 incident — the test
        # suite ran against a shared DB and this fanout emailed the
        # real ops inbox 15+ times in one pytest sweep.
        if _is_test_email(submitter.get("email")):
            log.info("Feedback submitted by test user %s — superadmin "
                     "notification suppressed", submitter.get("email"))
            return

        admins = await db.users.find({"role": "superadmin"}).to_list(length=100)
        if not admins:
            return

        subject, html = _tmpl.feedback_new_submission(
            fb_type=item["type"],
            title=item["title"],
            description=item.get("description") or "",
            submitter_name=submitter.get("name") or submitter.get("email") or "Unknown",
            submitter_email=submitter.get("email") or "",
            submitter_role=submitter.get("role") or "",
            route=item.get("route") or "",
            company_name=item.get("company_name") or "",
            partner_name=item.get("partner_name") or "",
            enterprise_name=item.get("enterprise_name") or "",
            attachment_count=len(item.get("attachments") or []),
            inbox_url=f"{public_base_url()}/admin/feedback",
        )
        for admin in admins:
            email = admin.get("email")
            if not email or _is_test_email(email):
                continue
            await dispatch(
                kind="feedback_new_submission",
                to=email, subject=subject, html=html,
                initiating_user_id=None,
                related={"feedback_id": item["id"], "type": item["type"]},
            )
    except Exception:
        log.exception("Feedback superadmin notify failed (submission still saved)")


async def _notify_reporter_status_change(item: dict, new_status: str) -> None:
    """Fires only when `notify_submitter` is True on the item."""
    try:
        if not item.get("submitter_email"):
            return
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        subject, html = _tmpl.feedback_status_update(
            title=item["title"],
            fb_type=item.get("type", "bug"),
            new_status_label=STATUS_LABELS.get(new_status, new_status),
            submitter_name=item.get("submitter_name") or "there",
            my_feedback_url=f"{public_base_url()}/feedback/mine",
        )
        await dispatch(
            kind="feedback_status_update",
            to=item["submitter_email"], subject=subject, html=html,
            initiating_user_id=None,
            related={"feedback_id": item["id"], "new_status": new_status},
        )
    except Exception:
        log.exception("Feedback status-change notify failed")


async def _notify_reporter_reply(item: dict, note: dict, author: dict) -> None:
    """Superadmin posted a note visible to the reporter and asked to email it."""
    try:
        if not item.get("submitter_email"):
            return
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        subject, html = _tmpl.feedback_reply_reporter(
            title=item["title"],
            fb_type=item.get("type", "bug"),
            message=note.get("note") or "",
            author_name=note.get("author_name") or "Team",
            submitter_name=item.get("submitter_name") or "there",
            my_feedback_url=f"{public_base_url()}/feedback/mine",
        )
        await dispatch(
            kind="feedback_reply_reporter",
            to=item["submitter_email"], subject=subject, html=html,
            initiating_user_id=author.get("id"),
            related={"feedback_id": item["id"], "note_id": note.get("id")},
        )
    except Exception:
        log.exception("Feedback reply-to-reporter notify failed")


async def _notify_superadmins_of_reporter_reply(item: dict, note: dict, reporter: dict) -> None:
    """Reporter posted a follow-up from `/feedback/mine`. Every superadmin
    gets a heads-up so nothing stalls waiting on info that just came in."""
    try:
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl

        # Skip fanout when the reporter is a test-shaped user — same
        # protection as `_notify_superadmins`.
        if _is_test_email(reporter.get("email")):
            log.info("Reporter reply from test user %s — superadmin "
                     "notification suppressed", reporter.get("email"))
            return

        admins = await db.users.find({"role": "superadmin"}).to_list(length=100)
        if not admins:
            return
        subject, html = _tmpl.feedback_new_reporter_reply(
            title=item["title"],
            fb_type=item.get("type", "bug"),
            message=note.get("note") or "",
            reporter_name=reporter.get("name") or reporter.get("email") or "The reporter",
            reporter_email=reporter.get("email") or "",
            attachment_count=len(note.get("attachments") or []),
            inbox_url=f"{public_base_url()}/admin/feedback",
        )
        for admin in admins:
            email = admin.get("email")
            if not email or _is_test_email(email):
                continue
            await dispatch(
                kind="feedback_new_reporter_reply",
                to=email, subject=subject, html=html,
                initiating_user_id=None,
                related={"feedback_id": item["id"], "note_id": note.get("id")},
            )
    except Exception:
        log.exception("Feedback reporter-reply notify to superadmins failed")


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@router.post("/feedback")
async def create_feedback(inp: FeedbackCreate, user: dict = Depends(get_current_user)):
    if inp.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")

    attachments = _validate_attachments(inp.attachments or [])
    now = now_iso()

    company = None
    company_name = None
    if inp.company_id:
        company = await db.companies.find_one({"id": inp.company_id})
        if company:
            company_name = company.get("name")

    ctx = await _resolve_context(user, company)

    item = {
        "id": str(uuid.uuid4()),
        "type": inp.type,
        "title": inp.title.strip(),
        "description": (inp.description or "").strip(),
        "status": "new",
        "submitter_user_id": user["id"],
        "submitter_email": user.get("email"),
        "submitter_name": user.get("name") or user.get("full_name"),
        "submitter_role": user.get("role"),
        "company_id": inp.company_id,
        "company_name": company_name,
        "partner_id": ctx["partner_id"],
        "partner_name": ctx["partner_name"],
        "enterprise_id": ctx["enterprise_id"],
        "enterprise_name": ctx["enterprise_name"],
        "route": (inp.route or "").strip() or None,
        "user_agent": (inp.user_agent or "").strip() or None,
        "admin_notes": [],
        "attachments": attachments,
        "notify_submitter": True,  # default ON — reporter gets pings on status changes
        # Read tracking: nulls until each side visits their inbox.
        "reporter_last_read_at": None,
        "admin_reads": {},   # {admin_user_id: iso}
        "created_at": now,
        "updated_at": now,
    }
    await db.feedback_items.insert_one(item)
    await _notify_superadmins(item, user)
    return {"id": item["id"], "status": "new"}


@router.get("/feedback/mine")
async def list_my_feedback(
    status: Optional[str] = Query(None),
    only_unread: bool = Query(False),
    user: dict = Depends(get_current_user),
):
    query: dict = {"submitter_user_id": user["id"]}
    if status:
        if status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUSES)}")
        query["status"] = status
    rows = await db.feedback_items.find(query).sort("created_at", -1).to_list(length=500)
    items = [_scrub_for_submitter(r) for r in rows]
    if only_unread:
        items = [i for i in items if i.get("unread")]
    # Counts across the whole user's inbox (ignoring filters) drive the
    # filter pills on the frontend.
    all_rows = await db.feedback_items.find(
        {"submitter_user_id": user["id"]},
    ).to_list(length=500)
    counts = {s: 0 for s in VALID_STATUSES}
    unread_total = 0
    for r in all_rows:
        s = r.get("status") or "new"
        if s in counts:
            counts[s] += 1
        if _is_unread_for_reporter(r):
            unread_total += 1
    return {
        "items": items,
        "counts": counts,
        "unread": unread_total,
    }


@router.get("/feedback/mine/unread-count")
async def my_unread_count(user: dict = Depends(get_current_user)):
    """Lightweight endpoint the layout polls to render the profile-menu
    badge without pulling the full list."""
    rows = await db.feedback_items.find(
        {"submitter_user_id": user["id"]},
    ).to_list(length=500)
    total = sum(1 for r in rows if _is_unread_for_reporter(r))
    return {"unread": total}


@router.post("/feedback/mine/mark-read")
async def mark_mine_read(user: dict = Depends(get_current_user)):
    """Called on visit to /feedback/mine — clears the reporter's badge."""
    now = now_iso()
    await db.feedback_items.update_many(
        {"submitter_user_id": user["id"]},
        {"$set": {"reporter_last_read_at": now}},
    )
    return {"ok": True, "at": now}


@router.get("/feedback/tenants")
async def feedback_tenants(user: dict = Depends(require_role("superadmin"))):
    """Distinct partners + enterprises that have ever filed feedback,
    used by the superadmin inbox filter dropdowns."""
    partners: dict[str, str] = {}
    enterprises: dict[str, str] = {}
    has_no_partner = False
    has_no_enterprise = False
    async for r in db.feedback_items.find(
        {},
        {"partner_id": 1, "partner_name": 1, "enterprise_id": 1, "enterprise_name": 1},
    ):
        pid, pname = r.get("partner_id"), r.get("partner_name")
        eid, ename = r.get("enterprise_id"), r.get("enterprise_name")
        if pid:
            partners[pid] = pname or pid
        else:
            has_no_partner = True
        if eid:
            enterprises[eid] = ename or eid
        else:
            has_no_enterprise = True
    return {
        "partners": sorted(
            [{"id": pid, "name": pname} for pid, pname in partners.items()],
            key=lambda x: (x["name"] or "").lower(),
        ),
        "enterprises": sorted(
            [{"id": eid, "name": ename} for eid, ename in enterprises.items()],
            key=lambda x: (x["name"] or "").lower(),
        ),
        "has_no_partner": has_no_partner,
        "has_no_enterprise": has_no_enterprise,
    }


@router.get("/feedback")
async def list_all_feedback(
    status: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    partner_id: Optional[str] = Query(None, description="'__none__' for orphan"),
    enterprise_id: Optional[str] = Query(None, description="'__none__' for orphan"),
    user: dict = Depends(require_role("superadmin")),
):
    query: dict = {}
    if status:
        if status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUSES)}")
        query["status"] = status
    if type:
        if type not in VALID_TYPES:
            raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")
        query["type"] = type
    if partner_id == "__none__":
        query["$or"] = [{"partner_id": None}, {"partner_id": {"$exists": False}}]
    elif partner_id:
        query["partner_id"] = partner_id
    if enterprise_id == "__none__":
        ex = [{"enterprise_id": None}, {"enterprise_id": {"$exists": False}}]
        # Preserve any prior $or (unlikely to collide but be safe)
        if "$or" in query:
            query["$and"] = [{"$or": query.pop("$or")}, {"$or": ex}]
        else:
            query["$or"] = ex
    elif enterprise_id:
        query["enterprise_id"] = enterprise_id
    if q:
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        search = [{"title": rx}, {"description": rx}, {"submitter_email": rx}]
        if "$and" in query:
            query["$and"].append({"$or": search})
        elif "$or" in query:
            query["$and"] = [{"$or": query.pop("$or")}, {"$or": search}]
        else:
            query["$or"] = search

    rows = await db.feedback_items.find(query).sort("created_at", -1).to_list(length=1000)
    items = []
    for r in rows:
        scrubbed = _scrub(r)
        scrubbed["unread"] = _is_unread_for_admin(r, user["id"])
        items.append(scrubbed)

    counts = {s: 0 for s in VALID_STATUSES}
    unread_total = 0
    async for r in db.feedback_items.find({}, {"status": 1, "admin_notes": 1, "admin_reads": 1}):
        s = r.get("status") or "new"
        if s in counts:
            counts[s] += 1
        if _is_unread_for_admin(r, user["id"]):
            unread_total += 1
    return {"items": items, "counts": counts, "unread": unread_total}


@router.get("/feedback/unread-count")
async def admin_unread_count(user: dict = Depends(require_role("superadmin"))):
    """Superadmin's global unread count — polled by the layout badge."""
    total = 0
    async for r in db.feedback_items.find({}, {"admin_notes": 1, "admin_reads": 1}):
        if _is_unread_for_admin(r, user["id"]):
            total += 1
    return {"unread": total}


@router.post("/feedback/mark-read")
async def admin_mark_read(user: dict = Depends(require_role("superadmin"))):
    """Called on visit to /admin/feedback — clears the admin's badge for
    every ticket in one shot."""
    now = now_iso()
    await db.feedback_items.update_many(
        {},
        {"$set": {f"admin_reads.{user['id']}": now}},
    )
    return {"ok": True, "at": now}


@router.patch("/feedback/{fid}")
async def patch_feedback(
    fid: str,
    patch: FeedbackPatch,
    user: dict = Depends(require_role("superadmin")),
):
    row = await db.feedback_items.find_one({"id": fid})
    if not row:
        raise HTTPException(status_code=404, detail="Feedback not found")

    old_status = row.get("status")
    updates: dict = {"updated_at": now_iso()}
    trigger_status_email = False

    if patch.status is not None:
        if patch.status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUSES)}")
        updates["status"] = patch.status
        if patch.status != old_status and row.get("notify_submitter") is not False:
            trigger_status_email = True

    if patch.notify_submitter is not None:
        updates["notify_submitter"] = bool(patch.notify_submitter)

    push_note = None
    if patch.admin_note and patch.admin_note.strip():
        vis = patch.note_visibility or "internal"
        if vis not in VALID_VISIBILITIES:
            raise HTTPException(status_code=400, detail=f"note_visibility must be one of {sorted(VALID_VISIBILITIES)}")
        push_note = {
            "id": str(uuid.uuid4()),
            "author_id": user["id"],
            "author_name": user.get("name") or user.get("email") or "Superadmin",
            "author_role": "superadmin",
            "note": patch.admin_note.strip()[:2000],
            "visibility": vis,
            "email_sent": False,  # set below if we actually dispatch
            "attachments": [],
            "at": now_iso(),
        }

    ops: dict = {"$set": updates}
    if push_note:
        ops["$push"] = {"admin_notes": push_note}
    await db.feedback_items.update_one({"id": fid}, ops)

    fresh = await db.feedback_items.find_one({"id": fid})

    # Fire post-write side-effects (never blocks the patch response)
    if trigger_status_email:
        await _notify_reporter_status_change(fresh, patch.status)

    if push_note and push_note["visibility"] == "reporter" and patch.email_reporter:
        await _notify_reporter_reply(fresh, push_note, user)
        # Persist email_sent=True on that note
        await db.feedback_items.update_one(
            {"id": fid, "admin_notes.id": push_note["id"]},
            {"$set": {"admin_notes.$.email_sent": True}},
        )
        fresh = await db.feedback_items.find_one({"id": fid})

    return _scrub(fresh)


@router.post("/feedback/{fid}/reply")
async def reporter_reply(
    fid: str,
    inp: FeedbackReporterReply,
    user: dict = Depends(get_current_user),
):
    """Reporter follow-up from `/feedback/mine`. Only the original
    submitter can post here — everyone else 404s (enumeration guard so
    strangers can't fish for feedback IDs)."""
    row = await db.feedback_items.find_one({"id": fid})
    if not row or row.get("submitter_user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Feedback not found")

    attachments = _validate_attachments(inp.attachments or [])
    note = {
        "id": str(uuid.uuid4()),
        "author_id": user["id"],
        "author_name": user.get("name") or user.get("email") or "Reporter",
        "author_role": "reporter",
        "note": inp.note.strip()[:2000],
        "visibility": "reporter",   # reporter's own note is naturally in the shared thread
        "email_sent": False,        # we email superadmins below; this bool tracks reporter-email dispatches only
        "attachments": attachments,
        "at": now_iso(),
    }
    await db.feedback_items.update_one(
        {"id": fid},
        {
            "$push": {"admin_notes": note},
            "$set": {"updated_at": now_iso()},
        },
    )
    fresh = await db.feedback_items.find_one({"id": fid})
    await _notify_superadmins_of_reporter_reply(fresh, note, user)
    return _scrub_for_submitter(fresh)

