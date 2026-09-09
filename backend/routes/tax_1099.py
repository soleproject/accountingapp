"""SmartBooks — 1099 Cockpit.

Year-round vendor tax cockpit. For every accessible company:
  • Track YTD payments per 1099-flagged vendor
  • Flag vendors over the $600 threshold
  • Chase missing W-9s via the existing client-portal machinery
  • Generate 1099-NEC preview PDFs (Q1 filing prep)

Two routers:
  cross_router  /api/cockpit/1099/*          — cross-client rollup
  firm_router   /api/companies/{cid}/1099/*  — per-company detail
"""
from __future__ import annotations
import secrets
from datetime import datetime, timezone, timedelta
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from db import db, now_iso, coerce
from auth import get_current_user, require_role
from deps import require_company
from routes.cockpit import require_firm_or_pro

cross_router = APIRouter(prefix="/api/cockpit/1099", tags=["1099"])
firm_router = APIRouter(prefix="/api", tags=["1099"])

THRESHOLD = 600.0  # IRS 1099-NEC threshold — bumped from $600 for 2026


# ---------------------------------------------------------------------------
# Payment aggregation
# ---------------------------------------------------------------------------

async def _vendor_payments_ytd(cid: str, year: int) -> dict:
    """Return {contact_id: total_paid} for the tax year. Sums posted
    expense transactions with direction=out and non-null contact_id."""
    start = f"{year:04d}-01-01"
    end = f"{year:04d}-12-31"
    cursor = db.transactions.aggregate([
        {"$match": {
            "company_id": cid,
            "posted": True,
            "date": {"$gte": start, "$lte": end},
            "direction": "out",
            "contact_id": {"$ne": None},
        }},
        {"$group": {
            "_id": "$contact_id",
            "total_paid": {"$sum": {"$abs": "$amount"}},
            "txn_count": {"$sum": 1},
        }},
    ])
    out: dict = {}
    async for doc in cursor:
        out[doc["_id"]] = {"total": float(doc["total_paid"] or 0), "count": int(doc["txn_count"] or 0)}
    return out


async def _company_1099_vendors(cid: str, year: int) -> list[dict]:
    """One row per 1099-flagged or over-threshold vendor."""
    payments = await _vendor_payments_ytd(cid, year)

    # Also include contacts flagged is_1099_vendor even if they haven't
    # crossed the threshold yet — CPAs want to see them "on watch".
    flagged = await db.contacts.find({
        "company_id": cid,
        "type": {"$in": ["vendor", None]},
        "is_1099_vendor": True,
    }).to_list(1000)
    flagged_ids = {c["id"] for c in flagged}

    candidate_ids = set(payments.keys()) | flagged_ids
    if not candidate_ids:
        return []

    contacts = await db.contacts.find({
        "id": {"$in": list(candidate_ids)},
        "company_id": cid,
    }).to_list(1000)
    contact_by_id = {c["id"]: c for c in contacts}

    rows = []
    for cid_ in candidate_ids:
        c = contact_by_id.get(cid_)
        if not c:
            continue
        p = payments.get(cid_) or {"total": 0.0, "count": 0}
        total = p["total"]
        needs_1099 = c.get("is_1099_vendor") and total >= THRESHOLD
        watch = c.get("is_1099_vendor") and total < THRESHOLD and total > 0
        rows.append({
            "contact_id": cid_,
            "vendor_name": c.get("name") or "Unknown",
            "email": c.get("email"),
            "total_paid": round(total, 2),
            "txn_count": p["count"],
            "is_1099_vendor": bool(c.get("is_1099_vendor")),
            "w9_on_file": bool(c.get("w9_on_file")),
            "has_tin": bool(c.get("tax_id_encrypted") or c.get("tax_id")),
            "needs_1099": needs_1099,
            "on_watch": watch,
            "threshold_gap": round(max(0.0, THRESHOLD - total), 2) if watch else 0.0,
            "issues": _row_issues(c, total, needs_1099),
        })
    # Sort: needs_1099 first, then on_watch, then by total desc.
    rows.sort(key=lambda r: (
        0 if r["needs_1099"] else (1 if r["on_watch"] else 2),
        -r["total_paid"],
    ))
    return rows


def _row_issues(contact: dict, total: float, needs_1099: bool) -> list[str]:
    out = []
    if needs_1099 and not contact.get("w9_on_file"):
        out.append("missing_w9")
    if needs_1099 and not (contact.get("tax_id_encrypted") or contact.get("tax_id")):
        out.append("missing_tin")
    if needs_1099 and not contact.get("address"):
        out.append("missing_address")
    if total >= THRESHOLD and not contact.get("is_1099_vendor"):
        out.append("over_threshold_not_flagged")
    return out


# ---------------------------------------------------------------------------
# Cross-client rollup
# ---------------------------------------------------------------------------

@cross_router.get("/summary")
async def cross_summary(
    year: int = Query(None),
    user: dict = Depends(get_current_user),
):
    """Cross-client 1099 rollup for the Cockpit rail header."""
    accessible = await require_firm_or_pro(user)
    y = year or datetime.now(timezone.utc).year

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(1000)
    per_company = []
    total_needs = 0
    total_watch = 0
    total_missing_w9 = 0
    total_missing_tin = 0
    for c in companies:
        try:
            rows = await _company_1099_vendors(c["id"], y)
        except Exception:  # noqa: BLE001
            rows = []
        needs = sum(1 for r in rows if r["needs_1099"])
        watch = sum(1 for r in rows if r["on_watch"])
        miss_w9 = sum(1 for r in rows if "missing_w9" in r["issues"])
        miss_tin = sum(1 for r in rows if "missing_tin" in r["issues"])
        if needs or watch:
            per_company.append({
                "company_id": c["id"],
                "company_name": c.get("name") or "Untitled",
                "needs_1099_count": needs,
                "on_watch_count": watch,
                "missing_w9_count": miss_w9,
                "missing_tin_count": miss_tin,
            })
        total_needs += needs
        total_watch += watch
        total_missing_w9 += miss_w9
        total_missing_tin += miss_tin

    per_company.sort(key=lambda r: (-r["needs_1099_count"], -r["on_watch_count"]))

    return {
        "year": y,
        "threshold": THRESHOLD,
        "totals": {
            "needs_1099": total_needs,
            "on_watch": total_watch,
            "missing_w9": total_missing_w9,
            "missing_tin": total_missing_tin,
            "companies_with_activity": len(per_company),
        },
        "per_company": per_company,
    }


# ---------------------------------------------------------------------------
# Per-company detail
# ---------------------------------------------------------------------------

@firm_router.get("/companies/{cid}/1099/vendors")
async def list_1099_vendors(
    cid: str,
    year: int = Query(None),
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    rows = await _company_1099_vendors(cid, y)
    return {"year": y, "threshold": THRESHOLD, "vendors": rows, "count": len(rows)}


@firm_router.post("/companies/{cid}/1099/vendors/{contact_id}/request-w9")
async def request_w9(
    cid: str, contact_id: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Create a client_questions doc asking for the W-9. Reuses the
    same magic-link infrastructure the portal already speaks."""
    await require_company(user, cid)
    contact = await db.contacts.find_one({"id": contact_id, "company_id": cid})
    if not contact:
        raise HTTPException(404, "Vendor not found.")
    to_email = (contact.get("email") or "").strip()
    if not to_email:
        raise HTTPException(400, "Vendor has no email on file — add one first.")

    token = secrets.token_urlsafe(24)
    first_name = ""
    if contact.get("name"):
        parts = contact["name"].split()
        if parts:
            first_name = f" {parts[0]}"
    q = {
        "id": token,
        "company_id": cid,
        "flow_type": "w9_request",
        "asked_by_user_id": user["id"],
        "asked_by_name": user.get("full_name") or user.get("email"),
        "question": (
            f"Hi{first_name} — we're preparing 1099s for the "
            f"{datetime.now().year - 1} tax year. "
            "Please upload your completed W-9 (or reply with your legal name, "
            "business address, and Taxpayer ID Number). Reply here or upload via the portal."
        ),
        "status": "pending",
        "answer": None,
        "sent_at": now_iso(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=60)).isoformat(),
        "to_email": to_email,
        "contact_id": contact_id,
        "txn_ids": [],
    }
    await db.client_questions.insert_one(q)
    return {"ok": True, "question_id": token, "magic_url": f"/q/{token}"}


@firm_router.get("/companies/{cid}/1099/preview/{contact_id}")
async def preview_1099(
    cid: str, contact_id: str,
    year: int = Query(None),
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Form-1099-NEC preview: JSON of every box we'll stamp on the PDF."""
    await require_company(user, cid)
    y = year or (datetime.now(timezone.utc).year - 1)
    contact = await db.contacts.find_one({"id": contact_id, "company_id": cid})
    if not contact:
        raise HTTPException(404, "Vendor not found.")
    company = await db.companies.find_one({"id": cid})
    payments = await _vendor_payments_ytd(cid, y)
    total = (payments.get(contact_id) or {}).get("total", 0.0)

    tin_last4 = None
    if contact.get("tax_id"):
        digits = "".join(ch for ch in str(contact["tax_id"]) if ch.isdigit())
        tin_last4 = digits[-4:] if len(digits) >= 4 else None

    return {
        "year": y,
        "form_type": "1099-NEC",
        "payer": {
            "name": (company or {}).get("name"),
            "address": (company or {}).get("address"),
            "ein": (company or {}).get("ein_last4"),
        },
        "recipient": {
            "name": contact.get("name"),
            "address": contact.get("address"),
            "email": contact.get("email"),
            "tin_last4": tin_last4,
            "has_w9": bool(contact.get("w9_on_file")),
        },
        "box_1_nonemployee_compensation": round(total, 2),
        "issues": _row_issues(contact, total, needs_1099=True),
    }


@firm_router.get("/companies/{cid}/1099/pdf/{contact_id}")
async def download_1099_pdf(
    cid: str, contact_id: str,
    year: int = Query(None),
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Generate a printable 1099-NEC PDF preview. Not IRS-official
    (that requires IRS FIRE or a paid e-file gateway) — this is the
    workpaper the CPA sends to Track1099 / Tax1099 / prints and mails."""
    await require_company(user, cid)
    y = year or (datetime.now(timezone.utc).year - 1)
    preview = await preview_1099(cid, contact_id, y, user)

    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.5*inch, rightMargin=0.5*inch, topMargin=0.5*inch, bottomMargin=0.5*inch)
    st = getSampleStyleSheet()
    story = []

    story.append(Paragraph(f"<b>Form 1099-NEC · Nonemployee Compensation · {preview['year']}</b>", st["Title"]))
    story.append(Spacer(1, 0.15*inch))
    story.append(Paragraph("<i>Working-paper preview — not an official IRS submission. Use as the source-of-truth for your e-file provider (Track1099, Tax1099) or the pre-printed IRS form.</i>", st["BodyText"]))
    story.append(Spacer(1, 0.25*inch))

    payer = preview["payer"]
    recip = preview["recipient"]

    payer_lines = [
        ("PAYER's name", payer.get("name") or ""),
        ("PAYER's address", payer.get("address") or "—"),
        ("PAYER's EIN (last 4)", payer.get("ein") or "—"),
    ]
    recip_lines = [
        ("RECIPIENT's name", recip.get("name") or ""),
        ("RECIPIENT's address", recip.get("address") or "—"),
        ("RECIPIENT's TIN (last 4)", recip.get("tin_last4") or "—"),
        ("W-9 on file", "Yes" if recip.get("has_w9") else "No"),
    ]
    tbl = Table([[
        Table([[k, v] for k, v in payer_lines], colWidths=[1.5*inch, 2.5*inch]),
        Table([[k, v] for k, v in recip_lines], colWidths=[1.5*inch, 2.5*inch]),
    ]], colWidths=[4*inch, 4*inch])
    tbl.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "TOP")]))
    story.append(tbl)
    story.append(Spacer(1, 0.3*inch))

    box_style = TableStyle([
        ("BOX", (0,0), (-1,-1), 1, colors.black),
        ("INNERGRID", (0,0), (-1,-1), 0.5, colors.grey),
        ("BACKGROUND", (0,0), (0,-1), colors.HexColor("#f1f5f9")),
        ("FONTNAME", (1,0), (1,-1), "Helvetica-Bold"),
        ("PADDING", (0,0), (-1,-1), 8),
    ])
    box_data = [
        ["Box 1 — Nonemployee Compensation", f"${preview['box_1_nonemployee_compensation']:,.2f}"],
        ["Box 4 — Federal income tax withheld", "$0.00"],
    ]
    box_tbl = Table(box_data, colWidths=[4*inch, 2*inch])
    box_tbl.setStyle(box_style)
    story.append(box_tbl)

    if preview.get("issues"):
        story.append(Spacer(1, 0.25*inch))
        story.append(Paragraph("<b>Issues to resolve before filing:</b>", st["BodyText"]))
        for i in preview["issues"]:
            story.append(Paragraph(f"• {i.replace('_', ' ').title()}", st["BodyText"]))

    doc.build(story)
    pdf = buf.getvalue()
    buf.close()
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="1099-NEC-{recip.get("name","vendor").replace(" ","-")}-{y}.pdf"'},
    )
