"""Marketing comparison PDF — SmartBooks vs QuickBooks Online vs Xero.

Pulls together the differentiators, parity items, and honest gaps into a
sales-ready one-pager (three pages) so the team can share it with
prospective firms/clients. Refresh the copy in `_ROWS` / `_HIGHLIGHTS`
whenever we ship new features or hear new competitor claims — the PDF
regenerates on demand.
"""
from __future__ import annotations
from datetime import date
from io import BytesIO

from fastapi import APIRouter
from fastapi.responses import Response
from reportlab.lib.pagesizes import LETTER
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT

router = APIRouter(prefix="/api")


# ── Content ──────────────────────────────────────────────────────────

_HIGHLIGHTS = [
    ("AI Insights Chat on every tier",
     "Floating conversational assistant that answers 'how's my profit', "
     "'who owes me money', 'what should I reorder' with live charts.",
     "Advanced only ($235/mo)", "Not offered natively"),
    ("Firm-first portal + white labelling",
     "Built for CPAs/bookkeepers running client rosters. Full white-label "
     "branding + Stripe-metered client billing out of the box.",
     "QBO Accountant tier — separate product",
     "Xero HQ — separate product"),
    ("Field-level AES-256 encryption",
     "Plaid tokens, bank account numbers, and Tax IDs / EINs are "
     "encrypted at the row level, not just at-disk. Independent of the "
     "hosting provider's disk encryption.",
     "Disk-level only (per public docs)",
     "Disk-level only (per public docs)"),
    ("AI Follow-up emails w/ history timeline",
     "Overdue invoices trigger contextual follow-up drafts. Every "
     "attempt is logged on the invoice for audit.",
     "Basic reminders (no LLM copy)",
     "Basic reminders (no LLM copy)"),
    ("AI Cleanup Copilot for messy books",
     "Runs across uncategorized transactions, misapplied JEs, and "
     "orphan bills to propose a review queue with GAAP-aware fixes.",
     "Not offered", "Not offered"),
    ("One-click Draft PO from Reorder Alert",
     "Dashboard tile lists every low-stock item and drafts a bill for "
     "the suggested quantity — vendor + item pre-filled.",
     "Advanced only", "Not offered natively"),
    ("Voice input on Insights chat",
     "Web Speech API mic — just talk to your books.",
     "Not offered", "Not offered"),
    ("Contextual chart-registration hook",
     "Any report page auto-advertises what it's showing so the AI can "
     "'expand on this' without a backend change.",
     "Not offered", "Not offered"),
]

_PARITY = [
    "Double-entry accounting engine with closed-period locks",
    "Bank feeds via Plaid",
    "Receipt OCR (Veryfi)",
    "Invoicing, bills, payments, contacts",
    "Multi-user roles & permissions",
    "Chart of Accounts w/ QBO-style strict sub-types",
    "Balance Sheet, Income Statement, Cash Flow, A/R & A/P Aging",
    "Inventory tracking (weighted-average)",
    "Fixed assets w/ auto-amortization JEs",
    "Loan schedules w/ auto payment JEs",
    "Customer Statements (Wave-style)",
    "CSV/PDF export on every report",
    "Stripe-metered subscription billing",
]

_GAPS_TODAY = [
    ("Payroll", "QBO has QBO Payroll ($50-125/mo); Xero has Gusto integrations. We don't run payroll natively — recommend integration."),
    ("Third-party marketplace", "QBO has 750+ apps; Xero has 1000+. Ours is early — planned Q3 2026."),
    ("Multi-currency ledger", "QBO Essentials+ and Xero support 160+ currencies; ours is USD-first."),
    ("Tax filings (1099s, sales tax)", "Neither of us does IRS filing natively; QBO has Tax integration bundle."),
    ("Native mobile apps", "iOS/Android planned Q3 2026 — for now the web app is mobile-responsive."),
]


# ── Rendering ────────────────────────────────────────────────────────

def _styles():
    return {
        "title": ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=colors.HexColor("#0F172A")),
        "sub":   ParagraphStyle("s", fontName="Helvetica", fontSize=10, leading=14, textColor=colors.HexColor("#475569")),
        "h2":    ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=colors.HexColor("#312E81"), spaceBefore=8),
        "body":  ParagraphStyle("b", fontName="Helvetica", fontSize=9.5, leading=13, textColor=colors.HexColor("#1E293B"), alignment=TA_LEFT),
        "small": ParagraphStyle("sm", fontName="Helvetica", fontSize=8, leading=11, textColor=colors.HexColor("#64748B")),
    }


def build_comparison_pdf(company_name: str = "SmartBooks Software") -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.55 * inch, rightMargin=0.55 * inch,
        topMargin=0.55 * inch, bottomMargin=0.5 * inch,
    )
    s = _styles()
    story = []

    story.append(Paragraph(f"{company_name} vs QuickBooks Online vs Xero", s["title"]))
    story.append(Paragraph(
        "A no-fluff feature comparison for firms and business owners — "
        f"prepared {date.today().strftime('%B %Y')}.",
        s["sub"],
    ))
    story.append(Spacer(1, 14))

    # ── What sets us apart ────────────────────────────────────────
    story.append(Paragraph("Where we lead", s["h2"]))
    story.append(Spacer(1, 4))
    header = ["Feature", "SmartBooks", "QuickBooks Online", "Xero"]
    rows = [header]
    for feat, ours, qbo, xero in _HIGHLIGHTS:
        rows.append([
            Paragraph(f"<b>{feat}</b><br/><font color='#64748B' size='7.5'>{ours}</font>", s["body"]),
            Paragraph("<b>Standard on every plan</b>", s["body"]),
            Paragraph(qbo, s["body"]),
            Paragraph(xero, s["body"]),
        ])
    t = Table(rows, colWidths=[2.5 * inch, 1.5 * inch, 1.7 * inch, 1.6 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#312E81")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CBD5E1")),
        ("BACKGROUND", (1, 1), (1, -1), colors.HexColor("#EEF2FF")),
        ("ROWBACKGROUNDS", (0, 1), (0, -1), [colors.white, colors.HexColor("#F8FAFC")]),
    ]))
    story.append(t)
    story.append(PageBreak())

    # ── Where we match ──────────────────────────────────────────
    story.append(Paragraph("Where we match feature-for-feature", s["h2"]))
    story.append(Paragraph(
        "Everything below works the same day-one as QuickBooks Online and Xero — no "
        "learning curve for anyone migrating between platforms.", s["sub"],
    ))
    story.append(Spacer(1, 6))
    parity_rows = [[Paragraph(f"✔ {item}", s["body"])] for item in _PARITY]
    parity_table = Table(parity_rows, colWidths=[7.4 * inch])
    parity_table.setStyle(TableStyle([
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#E2E8F0")),
    ]))
    story.append(parity_table)
    story.append(Spacer(1, 18))

    # ── Honest gaps ─────────────────────────────────────────────
    story.append(Paragraph("Honest gaps we won't hide from you", s["h2"]))
    story.append(Paragraph(
        "Buyers see through marketing that pretends to be everything to everyone. "
        "Here's exactly where QBO or Xero still have the edge over us today, and our plan for each.",
        s["sub"],
    ))
    story.append(Spacer(1, 6))
    gap_rows = [["Gap", "The story"]]
    for name, story_line in _GAPS_TODAY:
        gap_rows.append([Paragraph(f"<b>{name}</b>", s["body"]),
                         Paragraph(story_line, s["body"])])
    gap_t = Table(gap_rows, colWidths=[1.7 * inch, 5.7 * inch])
    gap_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CBD5E1")),
    ]))
    story.append(gap_t)
    story.append(PageBreak())

    # ── Pricing story ───────────────────────────────────────────
    story.append(Paragraph("Pricing story (as of " + date.today().strftime("%b %Y") + ")", s["h2"]))
    price_rows = [
        ["Plan tier", "SmartBooks", "QuickBooks Online", "Xero"],
        ["Entry",  "$19/mo — full features, 1 user",
                   "$35/mo Simple Start — 1 user, limited reports",
                   "$16/mo Early — 20 invoices, 5 bills/mo cap"],
        ["Growing","$39/mo — 3 users, AI Insights included",
                   "$65/mo Essentials — 3 users",
                   "$47/mo Growing — no cap"],
        ["Firm",   "$99/mo per firm — unlimited clients + white-label",
                   "QBO Accountant — free w/ ProAdvisor, per-client add-on",
                   "Xero HQ — free w/ Xero Partner"],
        ["AI features",
                   "On every tier",
                   "Advanced ($235/mo) only",
                   "Basic AI only; Xero Analytics Plus $10/mo extra"],
    ]
    pt = Table(price_rows, colWidths=[1.3 * inch, 1.9 * inch, 2.2 * inch, 2.0 * inch])
    pt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#312E81")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CBD5E1")),
        ("BACKGROUND", (1, 1), (1, -1), colors.HexColor("#EEF2FF")),
    ]))
    story.append(pt)
    story.append(Spacer(1, 14))

    story.append(Paragraph("Bottom line", s["h2"]))
    story.append(Paragraph(
        "QuickBooks Online won the last 20 years on distribution and ecosystem. "
        "Xero won the last 10 on UX. SmartBooks is building for the next 10 by putting the "
        "AI accountant in the same window as the books — on every tier, for every client. "
        "If your firm is tired of paying $235/user/month just to unlock the AI features, "
        "or you want your clients to talk to their reports the same way they talk to ChatGPT, "
        "you're already the target customer.", s["body"],
    ))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f"Prepared {date.today().isoformat()} · SmartBooks Software · "
        "Figures & competitor claims sourced from public QBO / Xero pricing pages. "
        "Refresh this document from Settings → Marketing → Comparison PDF.",
        s["small"],
    ))

    doc.build(story)
    return buf.getvalue()


@router.get("/marketing/comparison-pdf")
def marketing_comparison_pdf():
    """Public-ish endpoint — the comparison document is intentionally
    not gated behind auth so the sales team can link to it from decks,
    emails, and the marketing site."""
    pdf = build_comparison_pdf()
    filename = f"smartbooks-vs-qbo-xero-{date.today().isoformat()}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
