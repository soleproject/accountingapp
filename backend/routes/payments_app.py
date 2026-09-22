"""Payments Application — "Get Paid Faster" intake.

Captures the merchant / signer KYC data plus voided-check / ID
uploads that a downstream processor (Stripe Connect, Fiserv, etc.)
would need to enable ACH pull + electronic invoicing for a client.

Storage shape (on `db.payments_applications`, one doc per company):
  { id, company_id, status: "draft"|"submitted",
    business: {
      legal_name, federal_tax_id, dba, start_date, address, phone,
      contact_name, contact_email, website, product_sold,
      avg_txn_size, avg_monthly_volume
    },
    owners: [
      { legal_name, ownership_pct, home_address, home_phone,
        signer_email, dob, ssn }
    ],
    attachments: {
      voided_check:   { name, mime, data_b64 } | null,
      signer_id:      { name, mime, data_b64 } | null,
      processing_stmts: [{...}],
      bank_stmts:       [{...}],
    },
    created_at, updated_at, submitted_at
  }

Sensitive fields (`federal_tax_id`, and per-owner `ssn`, `dob`,
`home_address`, `home_phone`) are encrypted with `crypto_service`
before persistence and decrypted on read. Attachments are stored
inline as base64 for the MVP — swap to Emergent Object Storage in
follow-up once we're pushing to a real processor.
"""
from __future__ import annotations
import uuid
import base64 as _b64  # legacy migration read path
from datetime import datetime, timezone
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response

from db import db
from auth import get_current_user
from deps import require_company, company_ids_for_user
import crypto_service as cs
import storage as objstore

router = APIRouter(prefix="/api")

# Field paths within a payments_application doc that we encrypt at
# rest. Owners is a list, so `owners.$.<field>` is applied per row.
_BUSINESS_SECRETS = ["federal_tax_id"]
_OWNER_SECRETS    = ["ssn", "dob", "home_address", "home_phone"]

# Client-visible required-field list — used by both the "am I
# complete?" check on submit AND the resume-cards' percent-done
# calculation. Attachments are counted separately.
_BIZ_REQUIRED = [
    "legal_name", "federal_tax_id", "start_date", "address", "phone",
    "contact_name", "contact_email", "product_sold",
    "avg_txn_size", "avg_monthly_volume",
]
_OWNER_REQUIRED = [
    "legal_name", "ownership_pct", "home_address", "home_phone",
    "signer_email", "dob", "ssn",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _encrypt_payload(app: dict) -> dict:
    """Deep-copy `app` with sensitive fields ciphered. Idempotent
    thanks to the `enc_v1:` sentinel — re-encrypting a ciphertext is
    a no-op via crypto_service."""
    out = {**app}
    biz = dict(out.get("business") or {})
    for k in _BUSINESS_SECRETS:
        if biz.get(k):
            biz[k] = cs.encrypt(str(biz[k]))
    out["business"] = biz
    owners = []
    for o in (out.get("owners") or []):
        row = dict(o)
        for k in _OWNER_SECRETS:
            if row.get(k):
                row[k] = cs.encrypt(str(row[k]))
        owners.append(row)
    out["owners"] = owners
    return out


def _decrypt_payload(app: Optional[dict]) -> Optional[dict]:
    if not app:
        return app
    out = {**app}
    biz = dict(out.get("business") or {})
    for k in _BUSINESS_SECRETS:
        if biz.get(k):
            biz[k] = cs.decrypt(biz[k])
    out["business"] = biz
    owners = []
    for o in (out.get("owners") or []):
        row = dict(o)
        for k in _OWNER_SECRETS:
            if row.get(k):
                row[k] = cs.decrypt(row[k])
        owners.append(row)
    out["owners"] = owners
    return out


def _completion(app: dict) -> dict:
    """Compute what's still missing so the sidebar/cockpit resume
    cards can render a percent-done chip. Returns
    `{done, total, pct, missing[], ownership_pct}`.
    """
    biz = app.get("business") or {}
    owners = app.get("owners") or []
    filled = 0
    total = 0
    missing: list[str] = []
    for k in _BIZ_REQUIRED:
        total += 1
        if biz.get(k) not in (None, "", 0):
            filled += 1
        else:
            missing.append(f"business.{k}")
    for i, o in enumerate(owners):
        for k in _OWNER_REQUIRED:
            total += 1
            if o.get(k) not in (None, "", 0):
                filled += 1
            else:
                missing.append(f"owners[{i}].{k}")
    # Attachments contribute two required slots — voided check + signer ID.
    atts = app.get("attachments") or {}
    for k in ("voided_check", "signer_id"):
        total += 1
        if atts.get(k):
            filled += 1
        else:
            missing.append(f"attachments.{k}")
    if not owners:
        # An empty owners list means the whole per-owner block is
        # unstarted — count it once so 0-owners doesn't look 100%.
        total += 1
        missing.append("owners[]")
    ownership_pct = sum(float(o.get("ownership_pct") or 0) for o in owners)
    return {
        "done":  filled,
        "total": total,
        "pct":   round(100.0 * filled / total, 1) if total else 0.0,
        "missing": missing,
        "ownership_pct": ownership_pct,
    }


@router.get("/companies/{cid}/payments-app")
async def get_payments_app(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    # Grab the company doc so we can seed `business.legal_name` from
    # the company's name — one less field the user has to retype.
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "name": 1}) or {}
    company_name = (company.get("name") or "").strip()
    doc = await db.payments_applications.find_one({"company_id": cid}, {"_id": 0})
    if not doc:
        # First visit — return an empty shell so the frontend can
        # bind to it without needing to know "created vs draft".
        return {
            "company_id": cid,
            "status": "draft",
            "business": {"legal_name": company_name} if company_name else {},
            "owners": [],
            "attachments": {},
            "completion": _completion({"business": {"legal_name": company_name}} if company_name else {}),
        }
    plain = _decrypt_payload(doc)
    # If the returning draft still has no legal_name, backfill from the
    # company name so the user sees it prefilled after a save-and-return.
    biz = plain.get("business") or {}
    if not (biz.get("legal_name") or "").strip() and company_name:
        biz["legal_name"] = company_name
        plain["business"] = biz
    plain["completion"] = _completion(plain)
    return plain


@router.delete("/companies/{cid}/payments-app/draft")
async def delete_payments_app_draft(cid: str, user: dict = Depends(get_current_user)):
    """Nuke a draft-in-progress and any orphan file uploads so the
    user can start fresh from the marketing intro. Only allowed
    while the application is in `draft` status — submitted /
    approved / declined docs are protected (roll them back via
    the underwriter portal instead)."""
    await require_company(user, cid)
    doc = await db.payments_applications.find_one({"company_id": cid}, {"_id": 0, "status": 1})
    if not doc:
        return {"ok": True, "existed": False}
    if (doc.get("status") or "draft") != "draft":
        raise HTTPException(
            409, "Only draft applications can be discarded. Contact the underwriter to reset a submitted or approved application.",
        )
    await db.payments_applications.delete_one({"company_id": cid})
    # Uploaded files stay in object storage (audit trail) but we mark
    # them soft-deleted so a fresh draft doesn't collide with them.
    await db.payments_app_files.update_many(
        {"company_id": cid, "is_deleted": {"$ne": True}},
        {"$set": {"is_deleted": True, "deleted_at": _now()}},
    )
    return {"ok": True, "existed": True}


@router.patch("/companies/{cid}/payments-app")
async def upsert_payments_app(
    cid: str,
    payload: dict,
    user: dict = Depends(get_current_user),
):
    """Autosave-friendly upsert. Client sends the full editable
    payload (business/owners/attachments) on every debounce — we
    re-encrypt secrets and overwrite. Non-editable fields (status,
    submitted_at) stay put unless explicitly changed."""
    await require_company(user, cid)
    now = _now()
    body = {
        "business":    payload.get("business") or {},
        "owners":      payload.get("owners") or [],
        "attachments": payload.get("attachments") or {},
    }
    encrypted = _encrypt_payload(body)
    existing = await db.payments_applications.find_one({"company_id": cid})
    if existing:
        await db.payments_applications.update_one(
            {"company_id": cid},
            {"$set": {**encrypted, "updated_at": now}},
        )
    else:
        await db.payments_applications.insert_one({
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "status": "draft",
            "created_at": now,
            "updated_at": now,
            **encrypted,
        })
    plain = _decrypt_payload({**(existing or {}), **body})
    return {"ok": True, "completion": _completion(plain)}


@router.post("/companies/{cid}/payments-app/submit")
async def submit_payments_app(cid: str, user: dict = Depends(get_current_user)):
    """Finalize the application. Enforces the two hard gates on the
    frontend: (1) at least one owner and combined ownership ≥ 80%,
    (2) no required field left blank. Everything else is CPA polish."""
    await require_company(user, cid)
    doc = await db.payments_applications.find_one({"company_id": cid})
    if not doc:
        raise HTTPException(400, "Nothing to submit yet — start filling the application first.")
    plain = _decrypt_payload(doc)
    comp = _completion(plain)
    if comp["ownership_pct"] < 80:
        raise HTTPException(
            400,
            f"Combined ownership is {comp['ownership_pct']:.0f}%. Add another signer so the total covers at least 80% of the business.",
        )
    if comp["missing"]:
        raise HTTPException(
            400,
            f"Still missing {len(comp['missing'])} field(s) — save & come back when you have them.",
        )
    # If the underwriter had bounced this back for more info, the
    # re-submission lands in the "Info Received" bucket so it's easy
    # to spot as a follow-up rather than a fresh application.
    prior = doc.get("status") or "draft"
    new_status = "info_received" if prior in ("waiting_on_client", "info_received") else "submitted"
    now = _now()
    set_fields = {
        "status":       new_status,
        "submitted_at": now,
        "submitted_by": user.get("id"),
        "updated_at":   now,
    }
    if new_status == "info_received":
        set_fields["info_received_at"] = now
    await db.payments_applications.update_one(
        {"company_id": cid}, {"$set": set_fields},
    )

    # Close out the most recent pending info-request in the history
    # array and attach any files uploaded since it was made — that's
    # the merchant's response to that specific request. Files uploaded
    # before the request obviously don't count. If somehow multiple
    # requests are still open we only close the newest one; older ones
    # can be closed manually via a future admin action.
    if new_status == "info_received":
        history = list(doc.get("info_requests") or [])
        open_idx = None
        for i in range(len(history) - 1, -1, -1):
            if not history[i].get("responded_at"):
                open_idx = i
                break
        if open_idx is not None:
            requested_at = history[open_idx].get("requested_at") or ""
            # Files uploaded after `requested_at` (and not soft-deleted)
            # are the response set. Small manifest — we just need IDs.
            resp_files = await db.payments_app_files.find(
                {
                    "company_id": cid,
                    "is_deleted": {"$ne": True},
                    "uploaded_at": {"$gt": requested_at},
                },
                {"_id": 0, "id": 1},
            ).to_list(200)
            file_ids = [f["id"] for f in resp_files]
            await db.payments_applications.update_one(
                {"company_id": cid},
                {"$set": {
                    f"info_requests.{open_idx}.responded_at":      now,
                    f"info_requests.{open_idx}.response_file_ids": file_ids,
                }},
            )
    return {"ok": True, "status": new_status}


@router.get("/companies/{cid}/payments-app/status")
async def payments_app_status(cid: str, user: dict = Depends(get_current_user)):
    """Lightweight status endpoint powering the sidebar + cockpit
    resume cards. Never returns any decrypted secrets — just enough
    to decide whether/how to nudge the user."""
    await require_company(user, cid)
    doc = await db.payments_applications.find_one({"company_id": cid}, {"_id": 0})
    if not doc:
        return {"exists": False, "status": None, "pct": 0.0, "ownership_pct": 0.0}
    plain = _decrypt_payload(doc)
    comp = _completion(plain)
    return {
        "exists": True,
        "status": doc.get("status") or "draft",
        "pct":    comp["pct"],
        "ownership_pct": comp["ownership_pct"],
        "updated_at": doc.get("updated_at"),
    }


@router.get("/pro/payments-apps")
async def pro_payments_apps(user: dict = Depends(get_current_user)):
    """Firm-wide list of payments applications across every client the
    caller has access to. Powers the Pro Cockpit "Payments applications"
    card. Returns nothing sensitive — status + completion pct + timestamps
    only. Sorted so drafts-in-progress bubble up before submitted rows,
    with the most recently touched at the top of each bucket."""
    cids = await company_ids_for_user(user)
    if not cids:
        return {"items": []}
    # Fetch companies once so we can join names in one pass.
    companies = await db.companies.find(
        {"id": {"$in": cids}},
        {"_id": 0, "id": 1, "name": 1},
    ).to_list(1000)
    names = {c["id"]: c.get("name") or "Untitled" for c in companies}
    docs = await db.payments_applications.find(
        {"company_id": {"$in": cids}},
        {"_id": 0},
    ).to_list(1000)
    items = []
    for d in docs:
        # `_completion` needs decrypted secrets to score EIN as filled,
        # so we run the same decrypt pass the status endpoint uses.
        plain = _decrypt_payload(d)
        comp = _completion(plain)
        items.append({
            "company_id":   d.get("company_id"),
            "company_name": names.get(d.get("company_id"), "Untitled"),
            "status":       d.get("status") or "draft",
            "pct":          comp["pct"],
            "ownership_pct": comp["ownership_pct"],
            "updated_at":   d.get("updated_at"),
            "submitted_at": d.get("submitted_at"),
        })
    status_order = {"draft": 0, "submitted": 1}
    # Two-pass stable sort: recent updates first, then bucket by status
    # so drafts-in-progress bubble above submitted rows.
    items.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    items.sort(key=lambda x: status_order.get(x["status"], 2))
    return {"items": items}


# ---- Object-storage uploads ------------------------------------
# Attachments now live in Emergent Object Storage; the payments_app
# doc keeps a lightweight reference (`{id, name, mime, size,
# storage_path}`) instead of the full base64 payload. That keeps
# Mongo small and lets us swap providers later without touching the
# form. `db.payments_app_files` is the DB source of truth — the
# `is_deleted` flag lets us soft-remove without hitting a delete API
# we don't have.

@router.post("/companies/{cid}/payments-app/upload")
async def upload_payments_app_file(
    cid: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Accept a single file, push it to object storage, and return a
    reference the frontend embeds into `attachments.*`."""
    await require_company(user, cid)
    ext = "bin"
    if file.filename and "." in file.filename:
        ext = file.filename.rsplit(".", 1)[-1].lower()[:12]
    file_id = str(uuid.uuid4())
    path = f"{objstore.APP_NAME}/{cid}/payments_app/{file_id}.{ext}"
    data = await file.read()
    try:
        result = objstore.put_object(
            path, data, file.content_type or "application/octet-stream"
        )
    except objstore.StorageUnavailable as e:
        raise HTTPException(503, f"Storage unavailable — try again shortly ({e})")
    now = _now()
    await db.payments_app_files.insert_one({
        "id": file_id,
        "company_id": cid,
        "storage_path": result["path"],
        "original_filename": file.filename or f"{file_id}.{ext}",
        "content_type": file.content_type or "application/octet-stream",
        "size": result.get("size") or len(data),
        "uploaded_by": user.get("id"),
        "uploaded_at": now,
        "is_deleted": False,
    })
    return {
        "id": file_id,
        "name": file.filename or f"{file_id}.{ext}",
        "mime": file.content_type or "application/octet-stream",
        "size": result.get("size") or len(data),
        "storage_path": result["path"],
    }


@router.get("/companies/{cid}/payments-app/files/{file_id}")
async def download_payments_app_file(
    cid: str, file_id: str, user: dict = Depends(get_current_user),
):
    """Streams a previously-uploaded attachment. Authorized to the
    same set as the parent payments-app doc (CPA/owner/superadmin
    via `require_company`). File must belong to `cid` — cross-tenant
    fetches return 404 not 403 so we don't leak existence."""
    await require_company(user, cid)
    rec = await db.payments_app_files.find_one(
        {"id": file_id, "company_id": cid, "is_deleted": {"$ne": True}},
    )
    if not rec:
        raise HTTPException(404, "File not found")
    try:
        data, ct = objstore.get_object(rec["storage_path"])
    except objstore.StorageUnavailable as e:
        raise HTTPException(503, f"Storage unavailable — try again shortly ({e})")
    return Response(content=data, media_type=rec.get("content_type") or ct)


@router.delete("/companies/{cid}/payments-app/files/{file_id}")
async def delete_payments_app_file(
    cid: str, file_id: str, user: dict = Depends(get_current_user),
):
    """Soft-delete an attachment. The object stays in storage (no
    delete API) — we just mark the DB record so downloads 404."""
    await require_company(user, cid)
    await db.payments_app_files.update_one(
        {"id": file_id, "company_id": cid},
        {"$set": {"is_deleted": True, "deleted_at": _now()}},
    )
    return {"ok": True}

