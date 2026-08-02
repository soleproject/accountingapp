"""Marketing comparison PDF — SmartBooks vs QuickBooks Online vs Xero.

Pulls together the differentiators, parity items, and honest gaps into a
sales-ready one-pager (three pages) so the team can share it with
prospective firms/clients. Refresh the copy in `_ROWS` / `_HIGHLIGHTS`
whenever we ship new features or hear new competitor claims — the PDF
regenerates on demand.

Two variants are available via `?variant=`:
  • `default`  → the general SMB pitch (business owners)
  • `cpa`      → the accounting-firm pitch (white-label, per-client
                 billing, ProAdvisor comparisons)
"""
from __future__ import annotations
from datetime import date
from io import BytesIO

from fastapi import APIRouter, Query
from fastapi.responses import Response
from reportlab.lib.pagesizes import LETTER, landscape
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame,
    Paragraph, Spacer, Table, TableStyle, PageBreak, NextPageTemplate,
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT

router = APIRouter(prefix="/api")


# ── Default (SMB) content ────────────────────────────────────────────

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


# ── CPA-firm variant content ─────────────────────────────────────────
#
# The firm pitch reframes the same product around what CPAs / bookkeepers
# actually buy on: white-label, per-client margin, client-onboarding
# time, and getting off the QBO Accountant + Karbon + Ignition stack.

_CPA_HIGHLIGHTS = [
    ("Full white-label — your firm, not ours",
     "Upload your logo & brand colors once. Every client login, invoice "
     "PDF, statement email, and marketing link ships under your brand. "
     "No 'Powered by' footer required.",
     "QBO Accountant — no white-label. Clients see Intuit.",
     "Xero HQ — Xero branding stays. No custom domain."),
    ("Per-client Stripe billing, out of the box",
     "Add your markup on each seat and let Stripe auto-charge. We meter "
     "usage, you keep the margin. Cancel a client → their seat locks.",
     "Manual billing via ProAdvisor discount + separate invoicing tool",
     "Manual billing via Xero Partner discount + separate tool"),
    ("AI Cleanup Copilot for messy books",
     "First job on any new client: run Cleanup, review the GAAP-aware "
     "queue, batch-approve fixes. Cuts onboarding cleanup from days to "
     "hours.",
     "Not offered — firms use 3rd-party tools like LiveFlow / Uncat",
     "Not offered — firms use 3rd-party tools"),
    ("Field-level AES-256 encryption of client data",
     "Plaid tokens, bank account numbers, Tax IDs & EINs are encrypted "
     "at the row — meaningful for SOC 2 & IRS Pub 4557 client-data "
     "safeguarding requirements your firm is on the hook for.",
     "Disk-level only (per public docs)",
     "Disk-level only (per public docs)"),
    ("AI Insights Chat that answers client questions",
     "Give clients a natural-language window into their books so they "
     "stop calling you for 'what's my profit'. You bill for the "
     "advisory, not the report look-up.",
     "Advanced only ($235/mo/client) — most SMBs don't buy it",
     "Not offered natively"),
    ("Portal-level firm views",
     "One roster of every client, alerts on overdue tasks, book-review "
     "queues, and month-close status — designed for a firm running 40+ "
     "engagements, not one business.",
     "QBO Accountant works but siloed per file",
     "Xero HQ dashboard is basic"),
    ("Unified AI Follow-up emails",
     "Every overdue invoice drafts a contextual reminder in your firm's "
     "voice. Full audit trail per invoice so partners can review before "
     "send.",
     "Basic reminders (no LLM, generic copy)",
     "Basic reminders (no LLM, generic copy)"),
    ("Book Review + Month Close workflows",
     "Structured review queue with reviewer sign-off, closing entries, "
     "and period locks. Purpose-built for firm workflow, not retro-fit.",
     "3rd party (Financial Cents, Karbon) required",
     "3rd party (Karbon, Xenett) required"),
]

_CPA_PARITY = [
    "Double-entry accounting engine with closed-period locks",
    "Bank feeds via Plaid — no manual bank statement uploads",
    "Receipt OCR (Veryfi) — clients snap-and-forward",
    "Invoicing, bills, payments, contacts",
    "Multi-user roles: Owner / Accountant / Bookkeeper / Read-only",
    "Chart of Accounts w/ QBO-style strict sub-types + templates",
    "Balance Sheet, Income Statement, Cash Flow, A/R & A/P Aging",
    "Inventory tracking (weighted-average) — Tier 2 firms only",
    "Fixed assets w/ auto-amortization JEs",
    "Loan schedules w/ auto payment JEs",
    "Customer Statements + AI Follow-ups",
    "CSV / PDF / QBO-format export on every report",
    "General Ledger + Journal Entry drill-through",
]

_CPA_GAPS_TODAY = [
    ("Payroll", "QBO has native Payroll add-on ($50-125/mo/client). We don't run payroll — most firms use Gusto or ADP anyway; we integrate on the roadmap."),
    ("Public app marketplace", "QBO has 750+ apps; we're building direct integrations first (Plaid, Veryfi, Stripe, Resend). Q3 2026 for the marketplace."),
    ("Multi-currency ledger", "USD-first today. If your firm books non-US clients, wait until Q4 2026 or use QBO/Xero for those engagements."),
    ("Sales tax / 1099 filings", "Neither we nor QBO/Xero file directly — QBO bundles Tax Suite. We recommend Avalara integration until Q2 2026."),
    ("Native mobile apps", "iOS/Android planned Q3 2026. Web app is mobile-responsive so clients can snap receipts today."),
]


def _highlights_for(variant: str):
    return _CPA_HIGHLIGHTS if variant == "cpa" else _HIGHLIGHTS


def _parity_for(variant: str):
    return _CPA_PARITY if variant == "cpa" else _PARITY


def _gaps_for(variant: str):
    return _CPA_GAPS_TODAY if variant == "cpa" else _GAPS_TODAY


def _title_for(variant: str, company_name: str):
    if variant == "cpa":
        return f"{company_name} for Accounting Firms — vs QuickBooks Online Accountant & Xero HQ"
    return f"{company_name} vs QuickBooks Online vs Xero"


def _subtitle_for(variant: str):
    if variant == "cpa":
        return ("A firm-first feature & margin comparison for CPAs, "
                "bookkeepers, and outsourced controllers — prepared "
                f"{date.today().strftime('%B %Y')}.")
    return ("A no-fluff feature comparison for firms and business owners — "
            f"prepared {date.today().strftime('%B %Y')}.")


def _pricing_rows_for(variant: str):
    if variant == "cpa":
        return [
            ["Plan tier", "SmartBooks (for firms)", "QuickBooks Online Accountant", "Xero HQ / Partner"],
            ["Firm platform fee",
                "$99/mo — unlimited clients + white-label",
                "Free w/ ProAdvisor status (no white-label)",
                "Free w/ Xero Partner status (no white-label)"],
            ["Client seat cost (to firm)",
                "Starts at $9/client/mo (metered by Stripe)",
                "ProAdvisor discount 30-50% off retail",
                "Xero Partner discount 15-25% off retail"],
            ["Firm markup to client",
                "You set it. Stripe auto-invoices client at your rate.",
                "You bill separately (Karbon / Ignition / manual)",
                "You bill separately (Ignition / manual)"],
            ["AI features per client",
                "Included on every client seat",
                "Advanced only ($235/mo/client)",
                "Xero Analytics Plus $10/mo extra per client"],
            ["White-label branding",
                "Yes — logo, colors, custom domain",
                "No — client sees Intuit branding",
                "No — client sees Xero branding"],
            ["Cleanup / Month Close tooling",
                "Built-in Cleanup Copilot + Book Review + Month Close",
                "Requires Karbon / Financial Cents",
                "Requires Karbon / Xenett"],
        ]
    return [
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


def _bottom_line_for(variant: str):
    if variant == "cpa":
        return (
            "Your firm's product stack today probably looks like: QBO or Xero + Karbon + "
            "Ignition + Uncat + LiveFlow. That's five vendors, five bills, five audit surfaces, "
            "and a client experience stitched together with SSO. SmartBooks collapses cleanup, "
            "book review, month close, AI insights, client follow-ups, and metered billing into "
            "one white-labeled portal — under your brand, on your margin. If you're spending "
            "more than 20% of a bookkeeper's day on 'where's the receipt / what category is "
            "this / did the client see the email', you're the target firm."
        )
    return (
        "QuickBooks Online won the last 20 years on distribution and ecosystem. "
        "Xero won the last 10 on UX. SmartBooks is building for the next 10 by putting the "
        "AI accountant in the same window as the books — on every tier, for every client. "
        "If your firm is tired of paying $235/user/month just to unlock the AI features, "
        "or you want your clients to talk to their reports the same way they talk to ChatGPT, "
        "you're already the target customer."
    )


def _pricing_header_label(variant: str):
    return "Firm economics" if variant == "cpa" else "Pricing story"


def _footer_for(variant: str, company_name: str):
    tag = "Firm edition · " if variant == "cpa" else ""
    return (
        f"Prepared {date.today().isoformat()} · {tag}{company_name} · "
        "Figures & competitor claims sourced from public QBO / Xero pricing pages. "
        "Refresh this document from Settings → Marketing → Comparison PDF."
    )


# ── Rendering ────────────────────────────────────────────────────────

def _styles():
    return {
        "title": ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=colors.HexColor("#0F172A")),
        "sub":   ParagraphStyle("s", fontName="Helvetica", fontSize=10, leading=14, textColor=colors.HexColor("#475569")),
        "h2":    ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=colors.HexColor("#312E81"), spaceBefore=8),
        "body":  ParagraphStyle("b", fontName="Helvetica", fontSize=9.5, leading=13, textColor=colors.HexColor("#1E293B"), alignment=TA_LEFT),
        "small": ParagraphStyle("sm", fontName="Helvetica", fontSize=8, leading=11, textColor=colors.HexColor("#64748B")),
    }


def build_comparison_pdf(company_name: str = "SmartBooks Software",
                         variant: str = "default") -> bytes:
    variant = (variant or "default").lower()
    if variant not in ("default", "cpa"):
        variant = "default"

    buf = BytesIO()
    # Two page templates on one document — portrait for pages 1-2, then
    # landscape for the wider pricing table on page 3 that kept clipping
    # in portrait mode.
    portrait_size = LETTER
    landscape_size = landscape(LETTER)
    portrait_frame = Frame(
        0.55 * inch, 0.5 * inch,
        portrait_size[0] - 1.1 * inch, portrait_size[1] - 1.05 * inch,
        showBoundary=0,
    )
    landscape_frame = Frame(
        0.55 * inch, 0.5 * inch,
        landscape_size[0] - 1.1 * inch, landscape_size[1] - 1.05 * inch,
        showBoundary=0,
    )
    doc = BaseDocTemplate(buf, pagesize=portrait_size)
    doc.addPageTemplates([
        PageTemplate(id="portrait", frames=[portrait_frame], pagesize=portrait_size),
        PageTemplate(id="landscape", frames=[landscape_frame], pagesize=landscape_size),
    ])
    s = _styles()
    story = []

    story.append(Paragraph(_title_for(variant, company_name), s["title"]))
    story.append(Paragraph(_subtitle_for(variant), s["sub"]))
    story.append(Spacer(1, 14))

    # ── What sets us apart ────────────────────────────────────────
    lead_heading = ("Where we lead against QBO Accountant & Xero HQ"
                    if variant == "cpa" else "Where we lead")
    story.append(Paragraph(lead_heading, s["h2"]))
    story.append(Spacer(1, 4))
    us_col = "SmartBooks (firm edition)" if variant == "cpa" else "SmartBooks"
    qbo_col = "QBO Online Accountant" if variant == "cpa" else "QuickBooks Online"
    xero_col = "Xero HQ / Partner" if variant == "cpa" else "Xero"
    header = ["Feature", us_col, qbo_col, xero_col]
    rows = [header]
    for feat, ours, qbo, xero in _highlights_for(variant):
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
    parity_heading = ("Feature parity with QBO & Xero — nothing your clients will miss"
                      if variant == "cpa" else "Where we match feature-for-feature")
    story.append(Paragraph(parity_heading, s["h2"]))
    parity_sub = (
        "Everything below works the same day-one as QuickBooks Online and Xero — no "
        "re-training your team, no re-onboarding your clients."
        if variant == "cpa" else
        "Everything below works the same day-one as QuickBooks Online and Xero — no "
        "learning curve for anyone migrating between platforms."
    )
    story.append(Paragraph(parity_sub, s["sub"]))
    story.append(Spacer(1, 6))
    parity_rows = [[Paragraph(f"✔ {item}", s["body"])] for item in _parity_for(variant)]
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
    gap_heading = ("Where you'd still keep QBO or Xero (for now)"
                   if variant == "cpa" else "Honest gaps we won't hide from you")
    story.append(Paragraph(gap_heading, s["h2"]))
    gap_sub = (
        "Firm partners see through marketing that pretends to be everything to everyone. "
        "Here's exactly where QBO or Xero still have the edge for specific engagement "
        "types, and our concrete roadmap for each."
        if variant == "cpa" else
        "Buyers see through marketing that pretends to be everything to everyone. "
        "Here's exactly where QBO or Xero still have the edge over us today, and our plan for each."
    )
    story.append(Paragraph(gap_sub, s["sub"]))
    story.append(Spacer(1, 6))
    gap_rows = [["Gap", "The story"]]
    for name, story_line in _gaps_for(variant):
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
    # Switch to landscape for the wider pricing story + bottom line.
    story.append(NextPageTemplate("landscape"))
    story.append(PageBreak())

    # ── Pricing story ───────────────────────────────────────────
    story.append(Paragraph(
        f"{_pricing_header_label(variant)} (as of " + date.today().strftime("%b %Y") + ")",
        s["h2"],
    ))
    price_rows = _pricing_rows_for(variant)
    pt = Table(price_rows, colWidths=[1.7 * inch, 2.8 * inch, 2.8 * inch, 2.7 * inch])
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
    story.append(Paragraph(_bottom_line_for(variant), s["body"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph(_footer_for(variant, company_name), s["small"]))

    doc.build(story)
    return buf.getvalue()


@router.get("/marketing/comparison-pdf")
def marketing_comparison_pdf(
    variant: str = Query("default", description="`default` (SMB) or `cpa` (accounting-firm pitch)"),
):
    """Public-ish endpoint — the comparison document is intentionally
    not gated behind auth so the sales team can link to it from decks,
    emails, and the marketing site."""
    pdf = build_comparison_pdf(variant=variant)
    variant_tag = "-cpa" if (variant or "").lower() == "cpa" else ""
    filename = f"smartbooks-vs-qbo-xero{variant_tag}-{date.today().isoformat()}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
