"""SmartBooks — Advisor Reports Pack.

One-click branded monthly PDF per (company, period). Combines:
  • P&L for the period + prior period + delta
  • Balance Sheet as-of period end
  • AI-generated flux commentary (2-3 sentences per section)
  • KPI callouts (revenue, gross margin, opex, cash on hand)

Stored in `advisor_reports` collection so re-download is cheap and
"send to client via portal" reuses the existing client_questions pipe.

Two routers:
  cross_router  /api/cockpit/reports         — cross-client rollup
  firm_router   /api/companies/{cid}/advisor-reports/*   — per-company
"""
from __future__ import annotations
import base64
import uuid
from calendar import monthrange
from datetime import datetime, timezone
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from db import db, now_iso, coerce
from auth import get_current_user, require_role
from deps import require_company
from routes.cockpit import require_firm_or_pro
import reports as R

cross_router = APIRouter(prefix="/api/cockpit/reports", tags=["advisor-reports"])
firm_router = APIRouter(prefix="/api", tags=["advisor-reports"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _period_bounds(ym: str) -> tuple[str, str]:
    y, m = map(int, ym.split("-"))
    last = monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}"


def _prev_period(ym: str) -> str:
    y, m = map(int, ym.split("-"))
    if m == 1:
        return f"{y-1}-12"
    return f"{y:04d}-{m-1:02d}"


def _sum_by_type(is_data: dict, kind: str) -> float:
    """Prefer the report's own pre-computed totals for accuracy — falls
    back to summing leaf rows (skip is_subtotal to avoid double-counting)
    when they aren't present.

    `reports.compute_income_statement` stores leaf amounts on
    `row.amount` (NOT `row.total`) and pre-computes section totals as
    `total_revenue` / `total_cogs` / `total_expense` on the top level."""
    if not is_data:
        return 0.0
    precomputed = {
        "revenue": "total_revenue",
        "cogs": "total_cogs",
        "expenses": "total_expense",
    }.get(kind)
    if precomputed and precomputed in is_data:
        return round(float(is_data.get(precomputed) or 0), 2)
    rows = is_data.get(kind) or []
    if not isinstance(rows, list):
        return 0.0
    return round(sum(
        float((r or {}).get("amount") or (r or {}).get("total") or 0)
        for r in rows if not r.get("is_subtotal")
    ), 2)


async def _cash_on_hand(cid: str, as_of: str) -> float:
    """Sum current-asset accounts of subtype cash/bank."""
    total = 0.0
    accs = await db.accounts.find({
        "company_id": cid, "active": True,
        "type": {"$in": ["asset", "current_asset", "other_current_asset"]},
        "$or": [
            {"subtype": {"$regex": "bank|cash", "$options": "i"}},
            {"name": {"$regex": "cash|checking|savings", "$options": "i"}},
        ],
    }).to_list(200)
    for a in accs:
        # Balance = sum(debits) - sum(credits) through as_of.
        cursor = db.journal_entries.aggregate([
            {"$match": {"company_id": cid, "date": {"$lte": as_of}}},
            {"$unwind": "$lines"},
            {"$match": {"lines.account_id": a["id"]}},
            {"$group": {"_id": None,
                        "d": {"$sum": {"$ifNull": ["$lines.debit", 0]}},
                        "c": {"$sum": {"$ifNull": ["$lines.credit", 0]}}}},
        ])
        async for doc in cursor:
            total += float(doc["d"] or 0) - float(doc["c"] or 0)
            break
    return round(total, 2)


async def _flux_narrative(cur_is: dict, prev_is: dict, cur_bs: dict, kpis: dict) -> dict:
    """Generate AI commentary. Falls back to deterministic templated
    text on any LLM error so the report always renders."""
    def _templated() -> dict:
        rev_pct = kpis.get("revenue_pct_change") or 0
        rev_dir = "up" if rev_pct > 0 else ("down" if rev_pct < 0 else "flat")
        return {
            "revenue": (
                f"Revenue was ${kpis['revenue']:,.0f} — {rev_dir} "
                f"{abs(rev_pct):.1f}% vs prior month."
            ),
            "expenses": (
                f"Total operating expense was ${kpis['opex']:,.0f}. "
                f"Gross margin held at {kpis.get('gross_margin_pct', 0):.1f}%."
            ),
            "position": (
                f"Cash on hand is ${kpis['cash']:,.0f}. Net income "
                f"for the period was ${kpis['net_income']:,.0f}."
            ),
        }

    try:
        from ai_service import _new_chat
        from llm_client import UserMessage
        chat = _new_chat(
            system=(
                "You are a senior CPA writing plain-English flux "
                "commentary for a small-business owner. Each section: "
                "2-3 sentences, first-person plural ('we'), no jargon, "
                "no ranges, always give one specific number. Return "
                "JSON: {revenue, expenses, position}."
            ),
            session_id=str(uuid.uuid4()),
            feature="advisor-report",
        )
        prompt = (
            f"Period: {cur_is.get('period_end')}. KPIs: {kpis}. "
            f"Prior-period revenue: {_sum_by_type(prev_is, 'revenue')}, "
            f"prior expenses: {_sum_by_type(prev_is, 'expenses')}. "
            "Return ONE JSON object with keys revenue, expenses, position."
        )
        r = await chat.send_message(UserMessage(text=prompt))
        text = r.text if hasattr(r, "text") else str(r)
        import json, re
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            j = json.loads(m.group(0))
            if all(k in j for k in ("revenue", "expenses", "position")):
                return {k: str(j[k])[:400] for k in ("revenue", "expenses", "position")}
    except Exception:  # noqa: BLE001
        pass
    return _templated()


async def _generate_report_data(cid: str, ym: str, basis: str = "accrual") -> dict:
    start, end = _period_bounds(ym)
    prev = _prev_period(ym)
    prev_start, prev_end = _period_bounds(prev)

    cur_is = await R.compute_income_statement(cid, start, end, basis)
    prev_is = await R.compute_income_statement(cid, prev_start, prev_end, basis)
    cur_bs = await R.compute_balance_sheet(cid, end, basis)

    rev = _sum_by_type(cur_is, "revenue")
    cogs = _sum_by_type(cur_is, "cogs")
    opex = _sum_by_type(cur_is, "expenses")
    prev_rev = _sum_by_type(prev_is, "revenue")
    gross = rev - cogs
    net = gross - opex
    cash = await _cash_on_hand(cid, end)
    kpis = {
        "revenue": rev,
        "revenue_prev": prev_rev,
        "revenue_pct_change": ((rev - prev_rev) / prev_rev * 100.0) if prev_rev else 0.0,
        "gross_profit": round(gross, 2),
        "gross_margin_pct": round((gross / rev * 100.0) if rev else 0.0, 1),
        "opex": opex,
        "net_income": round(net, 2),
        "cash": cash,
    }
    narrative = await _flux_narrative(cur_is, prev_is, cur_bs, kpis)

    return {
        "period": ym,
        "period_start": start,
        "period_end": end,
        "basis": basis,
        "kpis": kpis,
        "narrative": narrative,
        "income_statement": cur_is,
        "balance_sheet": cur_bs,
    }


# ---------------------------------------------------------------------------
# PDF builder
# ---------------------------------------------------------------------------

def _build_pdf(company_name: str, brand_color: str, data: dict) -> bytes:
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER,
                             leftMargin=0.6*inch, rightMargin=0.6*inch,
                             topMargin=0.5*inch, bottomMargin=0.5*inch)
    st = getSampleStyleSheet()
    accent = colors.HexColor(brand_color if brand_color.startswith("#") else "#6366F1")
    h_style = ParagraphStyle("h", parent=st["Title"], textColor=accent, fontSize=22, spaceAfter=4)
    sub_style = ParagraphStyle("sub", parent=st["Normal"], textColor=colors.grey, fontSize=10, spaceAfter=18)
    story = []

    story.append(Paragraph(company_name, h_style))
    story.append(Paragraph(
        f"Monthly Advisor Report · {data['period']} · Basis: {data['basis'].title()}",
        sub_style,
    ))

    # KPI grid
    k = data["kpis"]
    def _kpi(label, value, sub=""):
        return [
            Paragraph(f"<font size=8 color='#64748b'>{label.upper()}</font>", st["Normal"]),
            Paragraph(f"<b><font size=15>{value}</font></b>", st["Normal"]),
            Paragraph(f"<font size=8 color='#64748b'>{sub}</font>", st["Normal"]),
        ]
    kpi_grid = Table([[
        _kpi("Revenue", f"${k['revenue']:,.0f}",
             f"{k['revenue_pct_change']:+.1f}% vs prior mo"),
        _kpi("Gross margin", f"{k['gross_margin_pct']:.1f}%",
             f"${k['gross_profit']:,.0f} gross profit"),
        _kpi("Operating expense", f"${k['opex']:,.0f}", ""),
        _kpi("Net income", f"${k['net_income']:,.0f}", ""),
    ]], colWidths=[1.7*inch]*4)
    kpi_grid.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("BACKGROUND", (0,0), (-1,-1), colors.HexColor("#f8fafc")),
        ("BOX", (0,0), (-1,-1), 0.5, colors.HexColor("#e2e8f0")),
        ("INNERGRID", (0,0), (-1,-1), 0.5, colors.HexColor("#e2e8f0")),
        ("LEFTPADDING", (0,0), (-1,-1), 10),
        ("TOPPADDING", (0,0), (-1,-1), 8),
        ("BOTTOMPADDING", (0,0), (-1,-1), 8),
    ]))
    story.append(kpi_grid)
    story.append(Spacer(1, 0.25*inch))

    # AI narrative
    n = data["narrative"]
    story.append(Paragraph("<b>What happened this month</b>", st["Heading3"]))
    story.append(Paragraph(f"<b>Revenue.</b> {n['revenue']}", st["BodyText"]))
    story.append(Paragraph(f"<b>Expenses.</b> {n['expenses']}", st["BodyText"]))
    story.append(Paragraph(f"<b>Position.</b> {n['position']}", st["BodyText"]))
    story.append(Spacer(1, 0.2*inch))

    # P&L compact — leaf amounts live on row.amount (NOT row.total).
    # Skip is_subtotal rows so parent-account roll-ups don't
    # double-count. Section totals come from `total_revenue` /
    # `total_cogs` / `total_expense` (pre-computed by reports.py).
    story.append(Paragraph("<b>Income Statement</b>", st["Heading3"]))
    is_ = data["income_statement"]
    is_rows = [["Section", "Amount"]]
    for kind, label in [("revenue","Revenue"),("cogs","Cost of Goods Sold"),("expenses","Operating Expenses")]:
        for r_ in (is_.get(kind) or []):
            if r_.get("is_subtotal"):
                continue
            amt = float(r_.get("amount") or r_.get("total") or 0)
            is_rows.append([f"  {r_.get('name')}", f"${amt:,.2f}"])
        subtotal = _sum_by_type(is_, kind)
        is_rows.append([f"Total {label}", f"${subtotal:,.2f}"])
    is_rows.append(["Net Income", f"${float(is_.get('net_income') or k['net_income']):,.2f}"])
    is_tbl = Table(is_rows, colWidths=[4.5*inch, 1.5*inch])
    is_tbl.setStyle(TableStyle([
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#f1f5f9")),
        ("LINEBELOW", (0,0), (-1,0), 0.5, colors.grey),
        ("ALIGN", (1,0), (1,-1), "RIGHT"),
    ]))
    story.append(is_tbl)
    story.append(PageBreak())

    # Balance Sheet
    story.append(Paragraph(f"{company_name} — Balance Sheet", h_style))
    story.append(Paragraph(f"As of {data['period_end']}", sub_style))
    bs = data["balance_sheet"]
    bs_rows = [["Account", "Balance"]]
    for section, total_key in [
        ("assets", "total_assets"),
        ("liabilities", "total_liabilities"),
        ("equity", "total_equity"),
    ]:
        for r_ in (bs.get(section) or []):
            # Show BOTH leaf accounts and their parent subtotal roll-ups
            # (assets are hierarchical: individual bank accounts +
            # "Total Business Checking"). The leaf rows carry the actual
            # per-account balance on `amount`.
            name = r_.get("name") or ""
            amt = float(r_.get("amount") or r_.get("total") or 0)
            indent = "  " if not r_.get("is_subtotal") else ""
            bs_rows.append([f"{indent}{name}", f"${amt:,.2f}"])
        bs_rows.append([f"Total {section.title()}", f"${float(bs.get(total_key) or 0):,.2f}"])
    bs_tbl = Table(bs_rows, colWidths=[4.5*inch, 1.5*inch])
    bs_tbl.setStyle(TableStyle([
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#f1f5f9")),
        ("LINEBELOW", (0,0), (-1,0), 0.5, colors.grey),
        ("ALIGN", (1,0), (1,-1), "RIGHT"),
    ]))
    story.append(bs_tbl)

    doc.build(story)
    b = buf.getvalue(); buf.close()
    return b


# ---------------------------------------------------------------------------
# Firm endpoints
# ---------------------------------------------------------------------------

@firm_router.post("/companies/{cid}/advisor-reports/generate")
async def generate_report(
    cid: str,
    ym: str = Query(..., pattern=r"^\d{4}-\d{2}$"),
    basis: str = Query("accrual"),
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Compute, render, persist, and return the report shell + PDF id."""
    await require_company(user, cid)
    company = await db.companies.find_one({"id": cid}) or {}
    data = await _generate_report_data(cid, ym, basis)
    pdf = _build_pdf(
        company_name=company.get("name") or "Company",
        brand_color=company.get("brand_primary_color") or "#6366F1",
        data=data,
    )
    rid = str(uuid.uuid4())
    doc = {
        "id": rid, "company_id": cid, "period": ym, "basis": basis,
        "generated_at": now_iso(),
        "generated_by": user.get("email") or user.get("id"),
        "kpis": data["kpis"], "narrative": data["narrative"],
        "pdf_base64": base64.b64encode(pdf).decode("ascii"),
        "size_bytes": len(pdf),
        "sent_to_client_at": None,
    }
    # One report per period per company — replace prior for cleanliness.
    await db.advisor_reports.delete_many({"company_id": cid, "period": ym})
    await db.advisor_reports.insert_one(doc)
    return {"id": rid, "period": ym, "kpis": data["kpis"], "narrative": data["narrative"], "size_bytes": len(pdf)}


@firm_router.get("/companies/{cid}/advisor-reports")
async def list_reports(
    cid: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    docs = await db.advisor_reports.find({"company_id": cid}).sort("period", -1).limit(24).to_list(24)
    out = []
    for d in docs:
        d2 = coerce(d)
        d2.pop("pdf_base64", None)
        out.append(d2)
    return {"reports": out}


@firm_router.get("/companies/{cid}/advisor-reports/{rid}/pdf")
async def download_report_pdf(
    cid: str, rid: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    r = await db.advisor_reports.find_one({"id": rid, "company_id": cid})
    if not r:
        raise HTTPException(404, "Report not found.")
    pdf = base64.b64decode(r["pdf_base64"])
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="advisor-{r["period"]}.pdf"'})


@firm_router.post("/companies/{cid}/advisor-reports/{rid}/send-to-portal")
async def send_report_to_portal(
    cid: str, rid: str,
    to_email: str = Query(...),
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Create a client_questions doc pointing the client at the report.
    Lands in the client portal like any other question."""
    await require_company(user, cid)
    r = await db.advisor_reports.find_one({"id": rid, "company_id": cid})
    if not r:
        raise HTTPException(404, "Report not found.")
    import secrets
    token = secrets.token_urlsafe(24)
    from datetime import timedelta
    q = {
        "id": token, "company_id": cid,
        "flow_type": "advisor_report",
        "asked_by_user_id": user.get("id"),
        "asked_by_name": user.get("full_name") or user.get("email"),
        "question": (
            f"Your monthly advisor report for {r['period']} is ready. "
            f"Revenue was ${r['kpis']['revenue']:,.0f}, net income "
            f"${r['kpis']['net_income']:,.0f}. Reply with any questions."
        ),
        "status": "pending", "answer": None,
        "sent_at": now_iso(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "to_email": to_email.strip().lower(),
        "advisor_report_id": rid,
    }
    await db.client_questions.insert_one(q)
    await db.advisor_reports.update_one({"id": rid}, {"$set": {"sent_to_client_at": now_iso()}})
    return {"ok": True, "question_id": token}


# ---------------------------------------------------------------------------
# Cross-client rollup
# ---------------------------------------------------------------------------

@cross_router.get("")
async def cross_reports(
    period: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    accessible = await require_firm_or_pro(user)
    p = period or (datetime.now(timezone.utc).strftime("%Y-%m"))

    companies = await db.companies.find({"id": {"$in": accessible}}).to_list(1000)
    per = []
    for c in companies:
        latest = await db.advisor_reports.find_one(
            {"company_id": c["id"]},
            sort=[("period", -1)],
        )
        target = await db.advisor_reports.find_one({"company_id": c["id"], "period": p})
        per.append({
            "company_id": c["id"],
            "company_name": c.get("name") or "Untitled",
            "period_target": p,
            "has_target_report": bool(target),
            "target_sent_at": (target or {}).get("sent_to_client_at"),
            "target_generated_at": (target or {}).get("generated_at"),
            "latest_period": (latest or {}).get("period"),
        })

    generated = sum(1 for r in per if r["has_target_report"])
    sent = sum(1 for r in per if r["target_sent_at"])
    per.sort(key=lambda r: (
        0 if not r["has_target_report"] else (1 if not r["target_sent_at"] else 2),
        r["company_name"].lower(),
    ))
    return {
        "period": p,
        "totals": {
            "companies": len(per),
            "generated": generated,
            "sent": sent,
            "pending": len(per) - generated,
        },
        "per_company": per,
    }
