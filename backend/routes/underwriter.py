"""Underwriter / Merchant Review portal.

The underwriter (Paul, our NMI merchant-services contact) is a
dedicated role that ONLY has access to review submitted payments
applications and approve or decline them. They don't see books,
transactions, or any other client data — just the KYC application
payload plus the uploaded documents.

Endpoints:
    GET  /underwriter/apps                  → list every submitted app
    GET  /underwriter/apps/{company_id}     → decrypted app detail
    GET  /underwriter/apps/{cid}/files/{fid} → download an uploaded file
    POST /underwriter/apps/{cid}/approve    → set status=approved, save NMI keys, email client
    POST /underwriter/apps/{cid}/decline    → set status=declined, save reason, email client

Approved credentials land in `db.merchant_payments_credentials`
(encrypted at rest via `crypto_service`) — that same collection is
what `nmi_service.py` reads from when running sales.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, Field

from fastapi import APIRouter, Depends, HTTPException, Response

from db import db
from auth import get_current_user, require_role
import crypto_service as cs
import storage as objstore
from email_service import send_email

# Import decrypt helper from payments_app to avoid duplicating the
# per-field cipher logic — same required-list too, so completion %
# stays consistent across surfaces.
from routes.payments_app import (
    _decrypt_payload, _completion, _BUSINESS_SECRETS, _OWNER_SECRETS,
)

log = logging.getLogger("axiom.underwriter")
router = APIRouter(prefix="/api/underwriter")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_underwriter(user: dict = Depends(get_current_user)) -> dict:
    """Only `underwriter` and `superadmin` roles can hit this router."""
    if user["role"] not in ("underwriter", "superadmin"):
        raise HTTPException(403, "This portal is restricted to underwriters.")
    return user


# ---- Dashboard ----------------------------------------------------

def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    """Best-effort ISO parser that tolerates both tz-aware and naive
    strings the app has historically written (`+00:00` vs `Z` vs no
    suffix). Returns None if unparseable — callers treat that as "no
    timestamp"."""
    if not s or not isinstance(s, str):
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        return None


def _hours_since(iso: Optional[str], *, now: datetime) -> Optional[float]:
    dt = _parse_iso(iso)
    if not dt:
        return None
    return round((now - dt).total_seconds() / 3600, 1)


@router.get("/dashboard")
async def underwriter_dashboard(user: dict = Depends(_require_underwriter)):
    """Executive dashboard payload — everything the underwriter's
    landing page needs in ONE round trip.

    Shape:
      - kpis.awaiting_review    → count, oldest_hours, 14d sparkline,
                                   delta vs prior 7d, top_oldest[3]
      - kpis.waiting_on_client  → count, oldest_days, over_3d_count,
                                   watchlist[]
      - kpis.new_submissions_today → count, items[]
      - pick_up_next            → 5 oldest actionable apps (submitted
                                   or info_received)
      - recent_activity         → last 15 approvals / declines /
                                   info-requests, newest first
      - funnel                  → count per bucket (source of truth
                                   for sidebar badges too)
    """
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    today_utc = now.date()
    since_14d = now - timedelta(days=14)
    since_7d  = now - timedelta(days=7)
    since_14d_iso = since_14d.isoformat()

    # Pull the whole active pipeline once. 1000 is more than enough
    # for any realistic underwriter workload — if this ever gets
    # tight we'd add pagination.
    docs = await db.payments_applications.find(
        {"status": {"$in": _ALL_STATUSES}},
        {"_id": 0},
    ).to_list(1000)
    cids = [d.get("company_id") for d in docs if d.get("company_id")]
    companies = await db.companies.find(
        {"id": {"$in": cids}}, {"_id": 0, "id": 1, "name": 1},
    ).to_list(1000)
    names = {c["id"]: c.get("name") or "Untitled" for c in companies}

    def _row(d):
        biz = d.get("business") or {}
        return {
            "company_id":       d.get("company_id"),
            "company_name":     names.get(d.get("company_id"), "Untitled"),
            "dba":              biz.get("dba") or "",
            "status":           d.get("status") or "draft",
            "submitted_at":     d.get("submitted_at"),
            "updated_at":       d.get("updated_at"),
            "info_requested_at": d.get("info_requested_at"),
            "info_received_at":  d.get("info_received_at"),
            "info_request_note": d.get("info_request_note"),
            "processing_started_at": d.get("processing_started_at"),
        }

    rows = [_row(d) for d in docs]

    # ---- Funnel counts (mirror of the sidebar badges) ------------
    funnel = {s: 0 for s in _ALL_STATUSES}
    for r in rows:
        funnel[r["status"]] = funnel.get(r["status"], 0) + 1

    # ---- Awaiting Review KPI ------------------------------------
    awaiting = [r for r in rows if r["status"] == "submitted"]
    # 14-day sparkline: submissions per day. UTC day buckets keep
    # this deterministic regardless of underwriter timezone.
    spark = [0] * 14
    for r in rows:
        sub = _parse_iso(r["submitted_at"])
        if sub and sub >= since_14d:
            idx = (sub.date() - since_14d.date()).days
            if 0 <= idx < 14:
                spark[idx] += 1
    last7  = sum(spark[7:])
    prev7  = sum(spark[:7])
    delta_pct = None
    if prev7:
        delta_pct = round(100.0 * (last7 - prev7) / prev7, 1)
    elif last7:
        delta_pct = 100.0  # went from zero to something — treat as +100%

    aw_by_age = sorted(
        awaiting,
        key=lambda r: _parse_iso(r["submitted_at"]) or now,
    )
    oldest_hours = _hours_since(aw_by_age[0]["submitted_at"], now=now) if aw_by_age else None
    top_oldest = [
        {
            **r,
            "hours_waiting": _hours_since(r["submitted_at"], now=now),
        }
        for r in aw_by_age[:3]
    ]

    # ---- Waiting on Client KPI ----------------------------------
    waiting = [r for r in rows if r["status"] == "waiting_on_client"]
    waiting_ages = [
        (r, _hours_since(r["info_requested_at"] or r["updated_at"], now=now) or 0)
        for r in waiting
    ]
    waiting_ages.sort(key=lambda t: -t[1])
    over_3d = sum(1 for _, h in waiting_ages if h and h >= 72)
    oldest_days = round(waiting_ages[0][1] / 24, 1) if waiting_ages else None
    watchlist = [
        {
            **r,
            "days_waiting": round(h / 24, 1) if h else None,
            "note_preview": (r.get("info_request_note") or "")[:120],
        }
        for r, h in waiting_ages[:5]
    ]

    # ---- New Submissions Today KPI ------------------------------
    submissions_today = []
    for r in rows:
        sub = _parse_iso(r["submitted_at"])
        if sub and sub.date() == today_utc and r["status"] in ("submitted", "processing"):
            submissions_today.append({
                **r,
                "hours_since_submit": _hours_since(r["submitted_at"], now=now),
            })
    submissions_today.sort(key=lambda r: r["submitted_at"] or "", reverse=True)

    # ---- Pick up next: 5 oldest actionable ----------------------
    actionable = [r for r in rows if r["status"] in ("submitted", "info_received")]
    actionable.sort(key=lambda r: _parse_iso(r["submitted_at"] or r["info_received_at"]) or now)
    pick_up_next = [
        {
            **r,
            "hours_waiting": _hours_since(r["submitted_at"] or r["info_received_at"], now=now),
        }
        for r in actionable[:5]
    ]

    # ---- Recent activity feed (last 7d, newest 15) --------------
    activity = []
    for r in rows:
        # Approved
        if r["status"] == "approved":
            at = _parse_iso(next((d.get("reviewed_at") for d in docs if d.get("company_id") == r["company_id"]), None))
            if at and at >= since_7d:
                activity.append({"type": "approved", "company_name": r["company_name"], "at": at.isoformat(), "company_id": r["company_id"]})
        elif r["status"] == "declined":
            src = next((d for d in docs if d.get("company_id") == r["company_id"]), {})
            at = _parse_iso(src.get("reviewed_at"))
            if at and at >= since_7d:
                activity.append({
                    "type": "declined",
                    "company_name": r["company_name"],
                    "at": at.isoformat(),
                    "reason": (src.get("decline_reason") or "")[:100],
                    "company_id": r["company_id"],
                })
        # Info requested (from any status — timestamp is the truth)
        info_at = _parse_iso(r.get("info_requested_at"))
        if info_at and info_at >= since_7d:
            activity.append({
                "type": "info_requested",
                "company_name": r["company_name"],
                "at": info_at.isoformat(),
                "note_preview": (r.get("info_request_note") or "")[:100],
                "company_id": r["company_id"],
            })
    activity.sort(key=lambda x: x["at"], reverse=True)
    activity = activity[:15]

    return {
        "kpis": {
            "awaiting_review": {
                "count":         funnel.get("submitted", 0),
                "oldest_hours":  oldest_hours,
                "sparkline_14d": spark,
                "last7":         last7,
                "prev7":         prev7,
                "delta_pct_7d":  delta_pct,
                "top_oldest":    top_oldest,
            },
            "waiting_on_client": {
                "count":         funnel.get("waiting_on_client", 0),
                "oldest_days":   oldest_days,
                "over_3d_count": over_3d,
                "watchlist":     watchlist,
            },
            "new_submissions_today": {
                "count": len(submissions_today),
                "items": submissions_today[:8],
            },
        },
        "funnel":          funnel,
        "pick_up_next":    pick_up_next,
        "recent_activity": activity,
        "generated_at":    now.isoformat(),
    }


# ---- List ---------------------------------------------------------

# Every status the underwriter portal can display. Ordered so that
# items requiring action bubble to the top of the mixed list before
# the frontend applies its per-bucket filter.
_ALL_STATUSES = [
    "draft",              # Application Started (client mid-signup)
    "submitted",          # Awaiting Review
    "processing",         # Processing Review (underwriter picked it up)
    "waiting_on_client",  # Waiting on Client (info requested)
    "info_received",      # Info Received (client re-submitted after info request)
    "approved",
    "declined",
]
_STATUS_ORDER = {s: i for i, s in enumerate(_ALL_STATUSES)}


@router.get("/apps")
async def list_submitted_apps(user: dict = Depends(_require_underwriter)):
    """Every payments application across every merchant, in every
    lifecycle bucket the underwriter cares about — including drafts
    so we can proactively reach out to abandoned signups."""
    docs = await db.payments_applications.find(
        {"status": {"$in": _ALL_STATUSES}},
        {"_id": 0},
    ).to_list(1000)
    cids = [d.get("company_id") for d in docs if d.get("company_id")]
    companies = await db.companies.find(
        {"id": {"$in": cids}}, {"_id": 0, "id": 1, "name": 1},
    ).to_list(1000)
    names = {c["id"]: c.get("name") or "Untitled" for c in companies}
    items = []
    for d in docs:
        # We DON'T decrypt here — the list only needs summary info.
        biz = d.get("business") or {}
        items.append({
            "company_id":   d.get("company_id"),
            "company_name": names.get(d.get("company_id"), "Untitled"),
            "dba":          biz.get("dba") or "",
            "status":       d.get("status") or "draft",
            "submitted_at": d.get("submitted_at"),
            "reviewed_at":  d.get("reviewed_at"),
            "updated_at":   d.get("updated_at"),
            # Extra hint for the list row when we're mid-review.
            "info_requested_at":     d.get("info_requested_at"),
            "info_received_at":      d.get("info_received_at"),
            "processing_started_at": d.get("processing_started_at"),
        })
    # Recent activity first within each bucket, then group by status
    # so "waiting on the underwriter" work bubbles above closed rows.
    items.sort(key=lambda x: (x.get("submitted_at") or x.get("updated_at") or ""), reverse=True)
    items.sort(key=lambda x: _STATUS_ORDER.get(x["status"], 99))
    return {"items": items}


# ---- Detail -------------------------------------------------------

@router.get("/apps/{company_id}")
async def get_app(company_id: str, user: dict = Depends(_require_underwriter)):
    """Full decrypted payload — this is the only surface where the
    underwriter sees SSNs and EINs in plain text. Callers are
    superadmin or the dedicated underwriter role."""
    doc = await db.payments_applications.find_one(
        {"company_id": company_id, "status": {"$in": _ALL_STATUSES}},
        {"_id": 0},
    )
    if not doc:
        raise HTTPException(404, "No submitted application for that company.")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    plain = _decrypt_payload(doc)
    plain["company_name"] = company.get("name") or "Untitled"
    plain["completion"] = _completion(plain)
    # File manifest for the underwriter's preview panel. `storage_path`
    # is the S3-style key; the client asks us to sign a temp URL via
    # /files/{fid} rather than trusting the browser with it.
    files = await db.payments_app_files.find(
        {"company_id": company_id, "is_deleted": {"$ne": True}},
        {"_id": 0, "id": 1, "original_filename": 1, "content_type": 1,
         "size": 1, "uploaded_at": 1, "storage_path": 1},
    ).to_list(200)
    plain["files"] = files
    # Redact the still-encrypted credentials from any prior approval —
    # underwriter re-enters keys on re-approve if needed.
    cred = await db.merchant_payments_credentials.find_one(
        {"company_id": company_id}, {"_id": 0, "environment": 1, "nmi_tokenization_key": 1,
                                     "surcharge_pct": 1, "approved_at": 1, "approved_by": 1},
    )
    plain["credentials"] = cred  # None if never approved
    return plain


# ---- Application PDF export --------------------------------------

@router.get("/apps/{company_id}/pdf")
async def download_app_pdf(
    company_id: str, user: dict = Depends(_require_underwriter),
):
    """Generate a printable application PDF the underwriter can save
    to their records or forward to a processor. Includes every
    decrypted field — this is the underwriter's authoritative copy."""
    doc = await db.payments_applications.find_one(
        {"company_id": company_id, "status": {"$in": _ALL_STATUSES}},
        {"_id": 0},
    )
    if not doc:
        raise HTTPException(404, "No submitted application for that company.")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    plain = _decrypt_payload(doc)
    files = await db.payments_app_files.find(
        {"company_id": company_id, "is_deleted": {"$ne": True}},
        {"_id": 0, "original_filename": 1, "content_type": 1, "size": 1, "uploaded_at": 1},
    ).to_list(200)
    pdf_bytes = _build_app_pdf(company.get("name") or "Untitled", plain, files)
    filename = f"payments-app-{(company.get('name') or 'application').replace(' ', '_')}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _build_app_pdf(company_name: str, plain: dict, files: list) -> bytes:
    """Compact one-page-ish PDF using reportlab. Grouped into
    Business / Owners / Documents / Metadata sections."""
    from io import BytesIO
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    )

    buf = BytesIO()
    pdf = SimpleDocTemplate(buf, pagesize=LETTER,
                             leftMargin=0.6*inch, rightMargin=0.6*inch,
                             topMargin=0.6*inch, bottomMargin=0.6*inch)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=18,
                        textColor=colors.HexColor("#0f172a"), spaceAfter=6)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8,
                           textColor=colors.HexColor("#64748b"))
    label = ParagraphStyle("label", parent=styles["Normal"], fontSize=7,
                           textColor=colors.HexColor("#94a3b8"),
                           spaceAfter=1, leading=8)
    value = ParagraphStyle("value", parent=styles["Normal"], fontSize=10,
                           textColor=colors.HexColor("#0f172a"), leading=12)
    section = ParagraphStyle("section", parent=styles["Heading3"], fontSize=10,
                             textColor=colors.HexColor("#475569"),
                             spaceBefore=10, spaceAfter=4,
                             textTransform="uppercase")

    story = []
    story.append(Paragraph(company_name, h1))
    status_label = (plain.get("status") or "draft").upper()
    story.append(Paragraph(
        f"Payments Application · Status: <b>{status_label}</b> · "
        f"Submitted {(plain.get('submitted_at') or '—')[:10]}",
        small,
    ))
    story.append(Spacer(1, 10))

    def kv_table(pairs, cols=2):
        cells, row = [], []
        for lab, val in pairs:
            row.append([Paragraph(lab, label), Paragraph(str(val) if val is not None else "—", value)])
            if len(row) == cols:
                cells.append([c for cell in row for c in cell])
                row = []
        if row:
            # pad odd row
            while len(row) < cols:
                row.append([Paragraph("", label), Paragraph("", value)])
            cells.append([c for cell in row for c in cell])
        col_w = (7.3*inch) / (cols*2)
        t = Table(cells, colWidths=[col_w]*(cols*2))
        t.setStyle(TableStyle([
            ("VALIGN", (0,0), (-1,-1), "TOP"),
            ("BOTTOMPADDING", (0,0), (-1,-1), 4),
        ]))
        return t

    biz = plain.get("business") or {}
    story.append(Paragraph("Business", section))
    story.append(kv_table([
        ("Legal name",  biz.get("legal_name")),
        ("EIN",         biz.get("federal_tax_id")),
        ("DBA",         biz.get("dba")),
        ("Start date",  biz.get("start_date")),
        ("Address",     biz.get("address")),
        ("Phone",       biz.get("phone")),
        ("Contact",     biz.get("contact_name")),
        ("Contact email", biz.get("contact_email")),
        ("Website",     biz.get("website")),
        ("Product / service", biz.get("product_sold")),
        ("Avg transaction", f"${biz.get('avg_txn_size')}" if biz.get("avg_txn_size") else "—"),
        ("Avg monthly volume", f"${biz.get('avg_monthly_volume')}" if biz.get("avg_monthly_volume") else "—"),
    ]))

    for i, o in enumerate(plain.get("owners") or [], start=1):
        story.append(Paragraph(f"Signer #{i} — {o.get('ownership_pct') or 0}%", section))
        story.append(kv_table([
            ("Legal name",  o.get("legal_name")),
            ("Date of birth", o.get("dob")),
            ("SSN",         o.get("ssn")),
            ("Home address", o.get("home_address")),
            ("Home phone",  o.get("home_phone")),
            ("Signer email", o.get("signer_email")),
        ]))

    story.append(Paragraph("Uploaded documents", section))
    if not files:
        story.append(Paragraph("<i>No documents uploaded.</i>", small))
    else:
        rows = [[Paragraph("<b>Filename</b>", small),
                 Paragraph("<b>Type</b>", small),
                 Paragraph("<b>Size (KB)</b>", small),
                 Paragraph("<b>Uploaded</b>", small)]]
        for f in files:
            rows.append([
                Paragraph(f.get("original_filename") or "—", small),
                Paragraph(f.get("content_type") or "—", small),
                Paragraph(f"{(f.get('size') or 0) // 1024}", small),
                Paragraph((f.get("uploaded_at") or "—")[:10], small),
            ])
        t = Table(rows, colWidths=[3.2*inch, 1.6*inch, 1*inch, 1.5*inch])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#f1f5f9")),
            ("BOX", (0,0), (-1,-1), 0.5, colors.HexColor("#e2e8f0")),
            ("INNERGRID", (0,0), (-1,-1), 0.25, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
            ("LEFTPADDING", (0,0), (-1,-1), 6),
            ("BOTTOMPADDING", (0,0), (-1,-1), 4),
            ("TOPPADDING", (0,0), (-1,-1), 4),
        ]))
        story.append(t)

    story.append(Spacer(1, 12))
    story.append(Paragraph(
        f"Generated {datetime.now(timezone.utc).isoformat()[:19]}Z · "
        "Confidential — contains encrypted PII decrypted server-side for the underwriter role only.",
        small,
    ))
    pdf.build(story)
    return buf.getvalue()


# ---- File preview -------------------------------------------------

@router.get("/apps/{company_id}/files/{file_id}")
async def download_file(
    company_id: str, file_id: str,
    user: dict = Depends(_require_underwriter),
):
    """Stream an uploaded document. Underwriter-only. We proxy through
    the backend rather than issuing a signed URL so the object-storage
    origin never accepts anonymous traffic."""
    f = await db.payments_app_files.find_one({
        "id": file_id, "company_id": company_id, "is_deleted": {"$ne": True},
    })
    if not f:
        raise HTTPException(404, "File not found")
    try:
        data, ct = objstore.get_object(f["storage_path"])
    except Exception as e:
        raise HTTPException(503, f"Storage unavailable: {e}")
    return Response(
        content=data,
        media_type=ct or f.get("content_type") or "application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{f.get("original_filename","file")}"',
        },
    )


# ---- Workflow transitions ----------------------------------------

@router.post("/apps/{company_id}/mark-processing")
async def mark_processing(
    company_id: str, user: dict = Depends(_require_underwriter),
):
    """Move an app into the "Processing Review" bucket. Called two
    ways: (1) automatically when an underwriter opens the detail
    page for a submitted / info_received app, and (2) manually via
    a "Start Review" button. Idempotent — hitting it on an already
    processing app is a no-op that still returns 200."""
    doc = await db.payments_applications.find_one(
        {"company_id": company_id}, {"_id": 0, "status": 1},
    )
    if not doc:
        raise HTTPException(404, "No application on file.")
    prior = doc.get("status") or "draft"
    # Only allowed from awaiting-review-adjacent states. Approved /
    # declined stay put — undoing those is a separate action.
    if prior not in ("submitted", "info_received", "processing"):
        raise HTTPException(
            409,
            f"Can't start review from status '{prior}'. Reopen from Approved/Declined via Reconsider.",
        )
    if prior == "processing":
        return {"ok": True, "status": "processing", "unchanged": True}
    now = _now()
    await db.payments_applications.update_one(
        {"company_id": company_id},
        {"$set": {
            "status":                 "processing",
            "processing_started_at":  now,
            "processing_started_by":  user.get("id"),
            "updated_at":             now,
        }},
    )
    return {"ok": True, "status": "processing"}


class RequestInfoIn(BaseModel):
    note: str = Field(..., min_length=4)


@router.post("/apps/{company_id}/request-info")
async def request_info(
    company_id: str, body: RequestInfoIn,
    user: dict = Depends(_require_underwriter),
):
    """Move an app to "Waiting on Client" and email them the note.
    The client sees the same note as a banner inside their Payments
    Application page so they know what to fix. When they re-submit
    the app auto-lands in the "Info Received" bucket."""
    doc = await db.payments_applications.find_one({"company_id": company_id})
    if not doc:
        raise HTTPException(404, "No application on file.")
    prior = doc.get("status") or "draft"
    if prior not in ("submitted", "processing", "info_received", "waiting_on_client"):
        raise HTTPException(
            409,
            f"Can't request info from status '{prior}'.",
        )
    now = _now()
    await db.payments_applications.update_one(
        {"company_id": company_id},
        {"$set": {
            "status":               "waiting_on_client",
            "info_request_note":    body.note.strip(),
            "info_requested_at":    now,
            "info_requested_by":    user.get("id"),
            "updated_at":           now,
        }},
    )
    # Fire the client email. Fall back to the submitter's login email
    # if the application never captured a contact email.
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    biz = _decrypt_payload(doc).get("business") or {}
    to_email = (biz.get("contact_email") or "").strip()
    if not to_email and doc.get("submitted_by"):
        owner = await db.users.find_one(
            {"id": doc.get("submitted_by")}, {"_id": 0, "email": 1},
        )
        to_email = (owner or {}).get("email") or ""
    if to_email:
        try:
            await send_email(
                to=to_email,
                subject=f"We need a quick update on your payments application — {company.get('name') or 'your business'}",
                html=_request_info_email_html(company.get("name") or "your business", body.note.strip()),
            )
        except Exception as e:  # noqa: BLE001
            log.warning("request-info email send failed: %s", e)
    return {"ok": True, "status": "waiting_on_client"}


# ---- Approve ------------------------------------------------------

class ApproveIn(BaseModel):
    nmi_security_key: str = Field(..., min_length=8)
    nmi_tokenization_key: str = Field(..., min_length=8)
    nmi_processor_id: Optional[str] = ""
    webhook_secret: Optional[str] = ""
    environment: str = Field("sandbox", pattern="^(sandbox|production)$")
    surcharge_pct: float = Field(0, ge=0, le=10)
    note: Optional[str] = ""


@router.post("/apps/{company_id}/approve")
async def approve_app(
    company_id: str, body: ApproveIn,
    user: dict = Depends(_require_underwriter),
):
    """Persist NMI credentials (encrypted), flip the app status, and
    email the client that they're live."""
    doc = await db.payments_applications.find_one({"company_id": company_id})
    if not doc:
        raise HTTPException(404, "No application on file.")
    if doc.get("status") not in ("submitted", "declined"):
        # Re-approving an already-approved app is idempotent but noisy —
        # allow it so keys can be rotated in place.
        pass
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    now = _now()
    cred = {
        "company_id":            company_id,
        "environment":           body.environment,
        "nmi_security_key":      cs.encrypt(body.nmi_security_key.strip()),
        "nmi_tokenization_key":  body.nmi_tokenization_key.strip(),
        "nmi_processor_id":      (body.nmi_processor_id or "").strip(),
        "webhook_secret":        cs.encrypt(body.webhook_secret.strip()) if body.webhook_secret else "",
        "surcharge_pct":         float(body.surcharge_pct or 0),
        "approved_at":           now,
        "approved_by":           user.get("id"),
        "updated_at":            now,
    }
    await db.merchant_payments_credentials.update_one(
        {"company_id": company_id},
        {"$set": cred, "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now}},
        upsert=True,
    )
    await db.payments_applications.update_one(
        {"company_id": company_id},
        {"$set": {
            "status":         "approved",
            "reviewed_at":    now,
            "reviewed_by":    user.get("id"),
            "review_note":    body.note or "",
            "updated_at":     now,
        }},
    )
    # Flip the company-level flag so the Pay Now button lights up on invoices.
    await db.companies.update_one(
        {"id": company_id},
        {"$set": {"payments_enabled": True, "payments_enabled_at": now}},
    )

    # Notify the client. `contact_email` is the merchant's primary
    # contact from the application; fall back to owner user if missing.
    biz = _decrypt_payload(doc).get("business") or {}
    to_email = (biz.get("contact_email") or "").strip()
    if not to_email:
        owner = await db.users.find_one({"id": doc.get("submitted_by")}, {"_id": 0, "email": 1}) if doc.get("submitted_by") else None
        to_email = (owner or {}).get("email") or ""
    if to_email:
        try:
            await send_email(
                to=to_email,
                subject=f"You're live: {company.get('name') or 'your business'} can now accept payments",
                html=_approval_email_html(company.get("name") or "your business"),
            )
        except Exception as e:  # noqa: BLE001
            log.warning("approval email send failed: %s", e)
    return {"ok": True, "status": "approved"}


class DeclineIn(BaseModel):
    reason: str = Field(..., min_length=4)
    note:   Optional[str] = ""


@router.post("/apps/{company_id}/decline")
async def decline_app(
    company_id: str, body: DeclineIn,
    user: dict = Depends(_require_underwriter),
):
    doc = await db.payments_applications.find_one({"company_id": company_id})
    if not doc:
        raise HTTPException(404, "No application on file.")
    now = _now()
    await db.payments_applications.update_one(
        {"company_id": company_id},
        {"$set": {
            "status":         "declined",
            "reviewed_at":    now,
            "reviewed_by":    user.get("id"),
            "decline_reason": body.reason,
            "review_note":    body.note or "",
            "updated_at":     now,
        }},
    )
    await db.companies.update_one(
        {"id": company_id}, {"$set": {"payments_enabled": False}},
    )
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1}) or {}
    biz = _decrypt_payload(doc).get("business") or {}
    to_email = (biz.get("contact_email") or "").strip()
    if to_email:
        try:
            await send_email(
                to=to_email,
                subject=f"Your payments application update — {company.get('name') or 'your business'}",
                html=_decline_email_html(company.get("name") or "your business", body.reason),
            )
        except Exception as e:  # noqa: BLE001
            log.warning("decline email send failed: %s", e)
    return {"ok": True, "status": "declined"}


# ---- Email templates ---------------------------------------------

def _approval_email_html(business_name: str) -> str:
    return f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;color:#059669;margin:0 0 12px;">You're approved — payments are live!</h1>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Great news for <b>{business_name}</b>: your Get Paid Faster application has been approved.
    You can now send invoices with a one-click Pay Now link, accept ACH pulls, and share a hosted
    payment page with your customers.
  </p>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Money settles in 2–3 business days. We'll auto-post each payment into your books and clear the
    matching invoice — no double entry required.
  </p>
  <p style="font-size:13px;color:#64748b;margin-top:24px;">
    Head to <b>Invoices</b> to send your first Pay Now invoice, or ping us with any questions.
  </p>
</div>
""".strip()


def _decline_email_html(business_name: str, reason: str) -> str:
    return f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;color:#0f172a;margin:0 0 12px;">Your payments application needs another look</h1>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Thanks for submitting the payments application for <b>{business_name}</b>. Unfortunately we
    weren't able to approve it as-is. Our underwriter noted:
  </p>
  <blockquote style="border-left:3px solid #cbd5e1;padding:8px 12px;color:#475569;font-size:14px;background:#f8fafc;">
    {reason}
  </blockquote>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    You can update your application in <b>Get Paid Faster</b> and resubmit anytime — we're here to
    help you get across the finish line.
  </p>
</div>
""".strip()


def _request_info_email_html(business_name: str, note: str) -> str:
    return f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;color:#0f172a;margin:0 0 12px;">Quick update needed on your payments application</h1>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Our underwriter is reviewing <b>{business_name}</b> and needs one more thing before we can
    move you forward:
  </p>
  <blockquote style="border-left:3px solid #f59e0b;padding:8px 12px;color:#475569;font-size:14px;background:#fffbeb;">
    {note}
  </blockquote>
  <p style="font-size:14px;color:#334155;line-height:1.6;">
    Head to <b>Get Paid Faster</b> in your app — you'll see a highlighted banner with this same note.
    Update the flagged section and click Submit again to send it back to review. We'll pick it right
    back up.
  </p>
</div>
""".strip()
