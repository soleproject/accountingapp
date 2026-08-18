"""
Generate Practice Partner marketing PDF at:
/app/frontend/public/downloads/Practice_Partner_Program.pdf

Sections:
  1. Cover
  2. Program at a Glance
  3. How it Works (3-step)
  4. Accountant P&L (the pitch)
  5. Competitive Comparison
  6. Affiliate Program
  7. FAQ
  8. Get Started
"""
from pathlib import Path
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

OUT = Path("/app/frontend/public/downloads/Practice_Partner_Program.pdf")
OUT.parent.mkdir(parents=True, exist_ok=True)

# ---- Brand palette ----
NAVY     = colors.HexColor("#0F172A")
CYAN     = colors.HexColor("#0891B2")
CYAN_LT  = colors.HexColor("#E0F2FE")
SLATE    = colors.HexColor("#475569")
SLATE_LT = colors.HexColor("#F1F5F9")
AMBER    = colors.HexColor("#F59E0B")
EMERALD  = colors.HexColor("#059669")
EMERALD_LT = colors.HexColor("#D1FAE5")
WHITE    = colors.white

# ---- Styles ----
styles = getSampleStyleSheet()

def add_style(name, **kw):
    styles.add(ParagraphStyle(name, **kw))

add_style("Cover",         parent=styles["Title"],
          fontName="Helvetica-Bold", fontSize=42, leading=48,
          textColor=NAVY, alignment=TA_LEFT, spaceAfter=6)
add_style("CoverSub",      parent=styles["Normal"],
          fontName="Helvetica", fontSize=15, leading=20,
          textColor=SLATE, alignment=TA_LEFT, spaceAfter=24)
add_style("H1",            parent=styles["Heading1"],
          fontName="Helvetica-Bold", fontSize=22, leading=26,
          textColor=NAVY, alignment=TA_LEFT, spaceAfter=8, spaceBefore=6)
add_style("H2",            parent=styles["Heading2"],
          fontName="Helvetica-Bold", fontSize=14, leading=18,
          textColor=CYAN, alignment=TA_LEFT, spaceAfter=6, spaceBefore=10)
add_style("Body",          parent=styles["Normal"],
          fontName="Helvetica", fontSize=10.5, leading=15,
          textColor=NAVY, alignment=TA_LEFT, spaceAfter=6)
add_style("BodyJust",      parent=styles["Normal"],
          fontName="Helvetica", fontSize=10.5, leading=15,
          textColor=NAVY, alignment=TA_JUSTIFY, spaceAfter=6)
add_style("BulletX",       parent=styles["Normal"],
          fontName="Helvetica", fontSize=10.5, leading=15,
          textColor=NAVY, alignment=TA_LEFT, leftIndent=14,
          bulletIndent=2, spaceAfter=4)
add_style("Quote",         parent=styles["Normal"],
          fontName="Helvetica-Oblique", fontSize=13, leading=19,
          textColor=NAVY, alignment=TA_LEFT, leftIndent=12,
          borderPadding=12, spaceAfter=10, spaceBefore=6)
add_style("Small",         parent=styles["Normal"],
          fontName="Helvetica", fontSize=9, leading=12,
          textColor=SLATE, alignment=TA_LEFT)
add_style("SmallCenter",   parent=styles["Normal"],
          fontName="Helvetica", fontSize=9, leading=12,
          textColor=SLATE, alignment=TA_CENTER)
add_style("Footer",        parent=styles["Normal"],
          fontName="Helvetica", fontSize=8, leading=10,
          textColor=SLATE, alignment=TA_CENTER)

# ---- Helpers ----
def para(txt, style="Body"):
    return Paragraph(txt, styles[style])

def bullet(txt):
    return Paragraph(f"•&nbsp;&nbsp;{txt}", styles["BulletX"])

def spacer(pt=12):
    return Spacer(1, pt)

def rule_line():
    t = Table([[""]], colWidths=[7*inch], rowHeights=[0.6])
    t.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,-1), CYAN)]))
    return t

def data_table(header, rows, col_widths, highlight_col=None,
               highlight_from_row=None):
    """Build a styled table with navy header + zebra rows."""
    data = [header] + rows
    t = Table(data, colWidths=col_widths, hAlign="LEFT")
    ts = [
        ("BACKGROUND",   (0,0), (-1,0), NAVY),
        ("TEXTCOLOR",    (0,0), (-1,0), WHITE),
        ("FONTNAME",     (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",     (0,0), (-1,0), 10),
        ("BOTTOMPADDING",(0,0), (-1,0), 8),
        ("TOPPADDING",   (0,0), (-1,0), 8),
        ("ALIGN",        (0,0), (-1,0), "CENTER"),

        ("FONTNAME",     (0,1), (-1,-1), "Helvetica"),
        ("FONTSIZE",     (0,1), (-1,-1), 10),
        ("TEXTCOLOR",    (0,1), (-1,-1), NAVY),
        ("BOTTOMPADDING",(0,1), (-1,-1), 6),
        ("TOPPADDING",   (0,1), (-1,-1), 6),
        ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),
        ("GRID",         (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E1")),
        ("ALIGN",        (1,1), (-1,-1), "RIGHT"),
    ]
    # Zebra
    for i in range(1, len(data)):
        if i % 2 == 0:
            ts.append(("BACKGROUND", (0,i), (-1,i), SLATE_LT))
    # Highlight column (typically profit)
    if highlight_col is not None:
        start_row = highlight_from_row or 1
        ts.append(("BACKGROUND", (highlight_col, start_row),
                                 (highlight_col, -1), EMERALD_LT))
        ts.append(("FONTNAME",  (highlight_col, start_row),
                                 (highlight_col, -1), "Helvetica-Bold"))
    t.setStyle(TableStyle(ts))
    return t


# ---- Page frame with brand footer ----
def draw_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE)
    canvas.drawString(0.75*inch, 0.4*inch,
                      "Business Software  ·  Practice Partner Program  ·  businessosoftware.ai")
    canvas.drawRightString(LETTER[0] - 0.75*inch, 0.4*inch,
                           f"Page {doc.page}")
    # cyan bar
    canvas.setFillColor(CYAN)
    canvas.rect(0, 0, LETTER[0], 0.15*inch, stroke=0, fill=1)
    canvas.restoreState()


# ============================================================
# Build story
# ============================================================
story = []

# ---------- PAGE 1: COVER ----------
story.append(spacer(60))
story.append(Paragraph(
    "<font color='#0891B2'>PRACTICE</font> PARTNER",
    styles["Cover"]))
story.append(Paragraph(
    "Turn your practice into a $200k/year platform.",
    styles["CoverSub"]))

# hero panel
hero = Table([
    ["A white-label bookkeeping platform for CPAs, bookkeepers, and firms."],
    ["Flat monthly license. Flat per-client pricing. Your brand, your margin."],
], colWidths=[7*inch])
hero.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,-1), CYAN_LT),
    ("TEXTCOLOR",  (0,0), (-1,-1), NAVY),
    ("FONTNAME",   (0,0), (0,0), "Helvetica-Bold"),
    ("FONTSIZE",   (0,0), (0,0), 15),
    ("FONTNAME",   (0,1), (0,1), "Helvetica"),
    ("FONTSIZE",   (0,1), (0,1), 12),
    ("TOPPADDING", (0,0), (-1,-1), 16),
    ("BOTTOMPADDING", (0,0), (-1,-1), 16),
    ("LEFTPADDING", (0,0), (-1,-1), 24),
    ("RIGHTPADDING",(0,0), (-1,-1), 24),
]))
story.append(hero)
story.append(spacer(30))

# 3 stat callouts — two-row table, generous padding, MIDDLE valign so
# nothing overlaps regardless of font metrics
stats = Table([
    ["$349", "$15", "100%"],
    ["Firm license / month", "Per client / month", "Your brand, your clients"],
], colWidths=[2.33*inch]*3)
stats.setStyle(TableStyle([
    ("BACKGROUND",  (0,0), (-1,-1), NAVY),
    # Number row
    ("TEXTCOLOR",   (0,0), (-1,0), WHITE),
    ("FONTNAME",    (0,0), (-1,0), "Helvetica-Bold"),
    ("FONTSIZE",    (0,0), (-1,0), 32),
    ("LEADING",     (0,0), (-1,0), 38),
    ("VALIGN",      (0,0), (-1,0), "MIDDLE"),
    ("TOPPADDING",  (0,0), (-1,0), 22),
    ("BOTTOMPADDING", (0,0), (-1,0), 8),
    # Label row
    ("TEXTCOLOR",   (0,1), (-1,1), CYAN_LT),
    ("FONTNAME",    (0,1), (-1,1), "Helvetica"),
    ("FONTSIZE",    (0,1), (-1,1), 10),
    ("LEADING",     (0,1), (-1,1), 12),
    ("VALIGN",      (0,1), (-1,1), "MIDDLE"),
    ("TOPPADDING",  (0,1), (-1,1), 2),
    ("BOTTOMPADDING", (0,1), (-1,1), 20),
    # Column separators
    ("ALIGN",       (0,0), (-1,-1), "CENTER"),
    ("LINEBEFORE",  (1,0), (1,-1), 1, WHITE),
    ("LINEBEFORE",  (2,0), (2,-1), 1, WHITE),
]))
story.append(stats)
story.append(spacer(30))

# Break-even quote
story.append(Paragraph(
    "&ldquo;Break even at 10 clients. Clear $1,400/mo at 50. "
    "Clear $3,100/mo at 100. Every additional client is $35 pure margin.&rdquo;",
    styles["Quote"]))

story.append(spacer(40))
story.append(Paragraph("Now open — US & UK.  ·  Feb 2026", styles["Small"]))

story.append(PageBreak())

# ---------- PAGE 2: PROGRAM AT A GLANCE ----------
story.append(Paragraph("Program at a Glance", styles["H1"]))
story.append(rule_line())
story.append(spacer(14))

story.append(Paragraph(
    "Practice Partner is a wholesale licensing program built for accounting "
    "professionals who want to own the client relationship, own the pricing, "
    "and own the brand — without owning the infrastructure.",
    styles["BodyJust"]))
story.append(spacer(4))
story.append(Paragraph(
    "You pay one flat license fee per month and a flat per-client seat. "
    "We handle the platform, the AI, the bank feeds, the receipts, and "
    "the compliance. You handle your clients. Everything they see wears "
    "your brand.",
    styles["BodyJust"]))
story.append(spacer(12))

story.append(Paragraph("What's included", styles["H2"]))
for b in [
    "<b>Unlimited client companies</b> under one login",
    "<b>Full white-label</b> — your logo, your colours, your domain (annual plans)",
    "<b>Multi-client dashboard</b> with consolidated reporting across your book",
    "<b>AI transaction categorisation</b> — junior staff service 3× the clients",
    "<b>Bank-feed reconciliation</b> via Plaid (US) and Open Banking (UK)",
    "<b>Receipt OCR</b> for every client via Veryfi",
    "<b>Client-invite flow</b> — you onboard clients, we never touch them",
    "<b>Partner analytics</b> — revenue, retention, at-risk accounts",
    "<b>Priority support</b> — dedicated Slack channel, 4-hour SLA",
    "<b>&ldquo;Certified Practice Partner&rdquo; badge</b> — for your website",
]:
    story.append(bullet(b))
story.append(spacer(14))

story.append(Paragraph("Pricing", styles["H2"]))
pricing_tbl = data_table(
    header=["Plan", "Price", "White-label domain", "Best for"],
    rows=[
        ["Monthly",      "$349 / mo",   "+$100/mo add-on",  "Solo bookkeepers testing the model"],
        ["Annual",       "$3,700 / yr", "Included",         "Firms with 20+ clients (saves $488/yr)"],
        ["Enterprise (250+ clients)", "Custom", "Included + SLA", "Multi-office firms, accounting networks"],
    ],
    col_widths=[1.4*inch, 1.4*inch, 1.6*inch, 2.6*inch],
)
story.append(pricing_tbl)

story.append(PageBreak())

# ---------- PAGE 3: HOW IT WORKS ----------
story.append(Paragraph("How it works", styles["H1"]))
story.append(rule_line())
story.append(spacer(14))

step_body_st = ParagraphStyle("StepBody", parent=styles["Body"],
                              fontSize=10.5, leading=14,
                              spaceAfter=0, textColor=NAVY)
steps = Table([
    ["1", "SIGN UP",
     Paragraph("$349/mo or $3,700/yr. Firm license activates instantly. "
               "Configure your brand: logo, colours, domain (annual).",
               step_body_st)],
    ["2", "INVITE CLIENTS",
     Paragraph("Send each client a branded invite. They see your firm, "
               "not ours. $15/mo per active client seat, billed to you "
               "monthly.", step_body_st)],
    ["3", "KEEP THE DELTA",
     Paragraph("Charge your clients whatever you want. Common range: "
               "$40&ndash;$100/mo. You keep 100% of the difference "
               "&mdash; recurring, life-of-account.", step_body_st)],
], colWidths=[0.5*inch, 1.4*inch, 5.1*inch])
steps.setStyle(TableStyle([
    ("BACKGROUND",  (0,0), (0,-1), CYAN),
    ("TEXTCOLOR",   (0,0), (0,-1), WHITE),
    ("FONTNAME",    (0,0), (0,-1), "Helvetica-Bold"),
    ("FONTSIZE",    (0,0), (0,-1), 22),
    ("ALIGN",       (0,0), (0,-1), "CENTER"),
    ("VALIGN",      (0,0), (-1,-1), "TOP"),

    ("FONTNAME",    (1,0), (1,-1), "Helvetica-Bold"),
    ("FONTSIZE",    (1,0), (1,-1), 11),
    ("TEXTCOLOR",   (1,0), (1,-1), NAVY),

    ("FONTNAME",    (2,0), (2,-1), "Helvetica"),
    ("FONTSIZE",    (2,0), (2,-1), 10.5),
    ("TEXTCOLOR",   (2,0), (2,-1), NAVY),

    ("TOPPADDING",  (0,0), (-1,-1), 14),
    ("BOTTOMPADDING",(0,0), (-1,-1), 14),
    ("LEFTPADDING", (0,0), (-1,-1), 12),
    ("RIGHTPADDING",(0,0), (-1,-1), 12),

    ("LINEBELOW",   (0,0), (-1,0), 1, colors.HexColor("#CBD5E1")),
    ("LINEBELOW",   (0,1), (-1,1), 1, colors.HexColor("#CBD5E1")),
    ("BOX",         (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E1")),
]))
story.append(steps)
story.append(spacer(20))

story.append(Paragraph("What your clients see", styles["H2"]))
story.append(Paragraph(
    "A modern bookkeeping app, wearing your firm's brand. They never see the "
    "words &ldquo;Business Software&rdquo; anywhere. Support requests route "
    "through your firm-branded portal, giving you full control of the "
    "client relationship.",
    styles["BodyJust"]))
story.append(spacer(6))
for b in [
    "Auto bank reconciliation with AI category suggestions",
    "Snap-a-photo receipt capture (with OCR)",
    "Direct chat channel to your firm inside the app",
    "Real-time balance, P&L, and cash-flow views",
    "Monthly close-out ritual with one-click approval",
]:
    story.append(bullet(b))

story.append(PageBreak())

# ---------- PAGE 4: THE ECONOMICS ----------
story.append(Paragraph("The economics — what you make", styles["H1"]))
story.append(rule_line())
story.append(spacer(10))

story.append(Paragraph(
    "Assumes you charge your clients <b>$50/month</b> each — competitive with "
    "QBO Essentials plus light bookkeeping. Adjust up or down to fit your "
    "market.",
    styles["Body"]))
story.append(spacer(10))

econ = data_table(
    header=["Clients", "Firm license", "Seat fees", "Your cost",
            "Client revenue", "Net profit / mo", "Annual"],
    rows=[
        ["5",   "$349", "$75",   "$424",   "$250",   "-$174",  "-$2,088"],
        ["10",  "$349", "$150",  "$499",   "$500",   "$1",     "$12"],
        ["20",  "$349", "$300",  "$649",   "$1,000", "$351",   "$4,212"],
        ["30",  "$349", "$450",  "$799",   "$1,500", "$701",   "$8,412"],
        ["50",  "$349", "$750",  "$1,099", "$2,500", "$1,401", "$16,812"],
        ["75",  "$349", "$1,125","$1,474", "$3,750", "$2,276", "$27,312"],
        ["100", "$349", "$1,500","$1,849", "$5,000", "$3,151", "$37,812"],
        ["200", "$349", "$3,000","$3,349", "$10,000","$6,651", "$79,812"],
    ],
    col_widths=[0.65*inch, 0.9*inch, 0.9*inch, 0.9*inch,
                1.1*inch, 1.15*inch, 0.9*inch],
    highlight_col=5,
    highlight_from_row=3,   # highlight from 20 clients up
)
story.append(econ)
story.append(spacer(8))

story.append(Paragraph(
    "Break-even lands at <b>10 clients</b>. Every additional client above "
    "that is roughly <b>$35 of pure margin</b> — clean recurring revenue "
    "you own, priced by you.",
    styles["Body"]))
story.append(spacer(14))

story.append(Paragraph("If you charge $75/client (full-service bookkeeping)", styles["H2"]))
econ75 = data_table(
    header=["Clients", "Client revenue", "Total cost", "Net / mo", "Annual"],
    rows=[
        ["10",  "$750",   "$499",  "$251",   "$3,012"],
        ["30",  "$2,250", "$799",  "$1,451", "$17,412"],
        ["50",  "$3,750", "$1,099","$2,651", "$31,812"],
        ["100", "$7,500", "$1,849","$5,651", "$67,812"],
    ],
    col_widths=[0.9*inch, 1.4*inch, 1.4*inch, 1.4*inch, 1.4*inch],
    highlight_col=3,
)
story.append(econ75)

story.append(PageBreak())

# ---------- PAGE 5: COMPETITIVE ----------
story.append(Paragraph("Why not just use QuickBooks?", styles["H1"]))
story.append(rule_line())
story.append(spacer(10))

story.append(Paragraph(
    "QBO Accountant is free — but the wholesale pricing is tiered "
    "(Simple Start / Essentials / Plus / Advanced), which means your "
    "monthly bill depends on <i>which mix of clients</i> you happen to "
    "have that month. Practice Partner is flat.",
    styles["Body"]))
story.append(spacer(10))

comp = data_table(
    header=["Feature", "QBO ProAdvisor", "Xero Partner", "Practice Partner"],
    rows=[
        ["Cost to accountant",       "Free",             "Free",             "$349/mo flat"],
        ["Per-client cost",          "$15–100 tiered",   "$18–80 tiered",   "$15 flat"],
        ["White-label branding",     "Not available",    "Limited",          "Full white-label"],
        ["Custom domain",            "Not available",    "Not available",    "Included (annual)"],
        ["AI categorisation",        "Limited",          "Basic",            "Built-in, all tiers"],
        ["Multi-client dashboard",   "Yes",              "Yes",              "Yes"],
        ["Reporting consolidation",  "Manual",           "Partial",          "Auto-consolidated"],
        ["UK FRS 102 + HMRC",        "Weak (US-first)",  "Native",           "Native"],
        ["US GAAP + IRS",            "Native",           "Weak (UK-first)",  "Native"],
        ["Setup fee",                "$0",               "$0",               "$0"],
    ],
    col_widths=[1.7*inch, 1.55*inch, 1.55*inch, 1.7*inch],
)
story.append(comp)
story.append(spacer(14))

story.append(Paragraph("Where we lose", styles["H2"]))
story.append(Paragraph(
    "QuickBooks has 30 years of market presence, deeper GAAP tooling for "
    "unusual edge cases, and the largest accountant network in the world. "
    "If you're deep in a QBO-only workflow with complex clients, migration "
    "will take real work.",
    styles["BodyJust"]))
story.append(spacer(8))
story.append(Paragraph("Where we win", styles["H2"]))
story.append(Paragraph(
    "Flat pricing, real white-label, AI-native categorisation, dramatically "
    "cheaper per client above 20 clients, and equally strong on US + UK "
    "accounting standards. The switching pain typically breaks even after "
    "one billing cycle at 30+ clients.",
    styles["BodyJust"]))

story.append(PageBreak())

# ---------- PAGE 6: AFFILIATE ----------
story.append(Paragraph("Affiliate program", styles["H1"]))
story.append(rule_line())
story.append(spacer(10))

story.append(Paragraph(
    "If you have an audience of accounting professionals — a newsletter, "
    "YouTube channel, LinkedIn following, or CPE course — Practice Partner "
    "pays $125/month per referred firm, for the life of the account. No cap. "
    "No degradation. Real recurring income.",
    styles["BodyJust"]))
story.append(spacer(10))

aff = data_table(
    header=["Firms referred", "Monthly income", "Annual income", "5-year total"],
    rows=[
        ["5",   "$625",    "$7,500",   "$37,500"],
        ["10",  "$1,250",  "$15,000",  "$75,000"],
        ["20",  "$2,500",  "$30,000",  "$150,000"],
        ["50",  "$6,250",  "$75,000",  "$375,000"],
        ["100", "$12,500", "$150,000", "$750,000"],
        ["200", "$25,000", "$300,000", "$1,500,000"],
    ],
    col_widths=[1.4*inch, 1.6*inch, 1.6*inch, 1.9*inch],
    highlight_col=2,
)
story.append(aff)
story.append(spacer(14))

story.append(Paragraph("Program terms", styles["H2"]))
for b in [
    "<b>$125/mo per referred firm</b>, paid monthly by ACH",
    "<b>Lifetime commission</b> — as long as the firm pays, you get paid",
    "<b>No cap</b>, no degradation, no tier gates",
    "<b>90-day clawback</b> — if the firm cancels in the first 90 days, "
    "the payout is reversed",
    "<b>Full marketing kit</b> — banners, one-pagers, comparison decks, "
    "UTM links, live referral dashboard",
    "Payouts held in escrow until firm completes their first billing cycle",
]:
    story.append(bullet(b))

story.append(spacer(14))
story.append(Paragraph(
    "&ldquo;Refer 20 firms. Take home $2,500/mo — forever. This isn't "
    "affiliate marketing. It's a career.&rdquo;",
    styles["Quote"]))

story.append(PageBreak())

# ---------- PAGE 7: FAQ ----------
story.append(Paragraph("FAQ", styles["H1"]))
story.append(rule_line())
story.append(spacer(10))

faqs = [
    ("Can my clients cancel and take their data with them?",
     "Yes. Full CSV export, QuickBooks Online export, and IIF for QuickBooks "
     "Desktop. Client data is portable by default."),

    ("What happens if I cancel Practice Partner?",
     "Your firm keeps read-only access for 90 days. Clients can migrate to "
     "a self-serve Business Software plan or export their data to another "
     "platform. No lock-in."),

    ("Is white-label included in the $349?",
     "Custom colours and logo, yes. Custom domain (yourfirm.com portal) is "
     "included on annual plans, or +$100/mo on monthly plans."),

    ("What if I have 500+ clients?",
     "Above 250 clients we shift to Enterprise pricing — lower per-seat "
     "rate, dedicated Customer Success Manager, and priority SLAs. Contact "
     "sales for a custom quote."),

    ("Do you support UK VAT and FRS 102?",
     "Yes. Full UK statutory support including FRS 102 chart of accounts, "
     "HMRC-compliant filings, Companies House format, VAT return generation, "
     "and native GBP handling."),

    ("Can I set client-facing pricing myself?",
     "Yes. You set client pricing, you bill your clients, you own the "
     "relationship. We only bill you — the firm — for the license and "
     "seat fees. We never see or touch your client billing."),

    ("How is client data segregated?",
     "Each firm's client data is isolated. We're pursuing SOC 2 Type II "
     "certification, UK GDPR compliant, and maintain full audit logs. "
     "No cross-firm data access, ever."),

    ("Who owns the client relationship?",
     "You do — completely. We are pure infrastructure. Your clients see "
     "your brand, contact your firm, and never see or hear from us."),

    ("Can I bring my QBO clients over?",
     "Yes. We provide a QBO import tool that pulls chart of accounts, "
     "customers, vendors, transactions, and open invoices. Typical firm "
     "migration takes 2-3 hours per client."),

    ("What integrations are included?",
     "Plaid (US bank feeds), Open Banking (UK), Veryfi (receipt OCR), "
     "QuickBooks Online (bi-directional sync), and Stripe. "
     "Full integration list in the client dashboard."),
]

for q, a in faqs:
    story.append(Paragraph(f"<b>{q}</b>", styles["Body"]))
    story.append(Paragraph(a, styles["BodyJust"]))
    story.append(spacer(4))

story.append(PageBreak())

# ---------- PAGE 8: GET STARTED ----------
story.append(spacer(60))
story.append(Paragraph("Ready to start?", styles["Cover"]))
story.append(spacer(20))

cta_body_st = ParagraphStyle("CtaBody", parent=styles["Body"],
                             fontSize=11, leading=15,
                             spaceAfter=0, textColor=NAVY)
cta = Table([
    ["1. Free 14-day trial",
     Paragraph("Start with full white-label access. No credit card required "
               "until day 15.", cta_body_st)],
    ["2. Live 15-min demo",
     Paragraph("See the QBO migration flow, the client-invite flow, and the "
               "affiliate dashboard walkthrough.", cta_body_st)],
    ["3. Pilot cohort",
     Paragraph("Design-partner spots available for firms 30+ clients "
               "&mdash; includes 60 days free and a direct feedback line "
               "to our product team.", cta_body_st)],
], colWidths=[2*inch, 5*inch])
cta.setStyle(TableStyle([
    ("BACKGROUND",   (0,0), (0,-1), NAVY),
    ("TEXTCOLOR",    (0,0), (0,-1), WHITE),
    ("FONTNAME",     (0,0), (0,-1), "Helvetica-Bold"),
    ("FONTSIZE",     (0,0), (0,-1), 12),
    ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),

    ("FONTNAME",     (1,0), (1,-1), "Helvetica"),
    ("FONTSIZE",     (1,0), (1,-1), 11),
    ("TEXTCOLOR",    (1,0), (1,-1), NAVY),

    ("TOPPADDING",   (0,0), (-1,-1), 16),
    ("BOTTOMPADDING",(0,0), (-1,-1), 16),
    ("LEFTPADDING",  (0,0), (-1,-1), 16),
    ("RIGHTPADDING", (0,0), (-1,-1), 16),

    ("LINEBELOW",    (0,0), (-1,0), 1, WHITE),
    ("LINEBELOW",    (0,1), (-1,1), 1, WHITE),
]))
story.append(cta)
story.append(spacer(30))

story.append(Paragraph(
    "<b>Contact</b>",
    styles["H2"]))
contact = Table([
    ["Practice Partner enquiries", "partners@businessosoftware.ai"],
    ["Affiliate program",           "affiliates@businessosoftware.ai"],
    ["Demo booking",                "businessosoftware.ai/practice-partner/demo"],
    ["General",                     "hello@businessosoftware.ai"],
], colWidths=[2.4*inch, 4.6*inch])
contact.setStyle(TableStyle([
    ("FONTNAME",     (0,0), (0,-1), "Helvetica-Bold"),
    ("FONTNAME",     (1,0), (1,-1), "Helvetica"),
    ("FONTSIZE",     (0,0), (-1,-1), 10.5),
    ("TEXTCOLOR",    (0,0), (0,-1), NAVY),
    ("TEXTCOLOR",    (1,0), (1,-1), CYAN),
    ("TOPPADDING",   (0,0), (-1,-1), 6),
    ("BOTTOMPADDING",(0,0), (-1,-1), 6),
    ("LINEBELOW",    (0,0), (-1,-2), 0.5, colors.HexColor("#E2E8F0")),
]))
story.append(contact)

story.append(spacer(40))
story.append(Paragraph(
    "Business Software Inc.  ·  US &amp; UK  ·  Feb 2026",
    styles["SmallCenter"]))
story.append(Paragraph(
    "This document is confidential and intended for prospective Practice "
    "Partners. Pricing subject to change. See businessosoftware.ai/legal "
    "for full terms.",
    styles["SmallCenter"]))


# ============================================================
# Build PDF
# ============================================================
doc = SimpleDocTemplate(
    str(OUT),
    pagesize=LETTER,
    leftMargin=0.75*inch,
    rightMargin=0.75*inch,
    topMargin=0.75*inch,
    bottomMargin=0.6*inch,
    title="Practice Partner Program",
    author="Business Software",
    subject="Wholesale accountant program",
    creator="Business Software Inc.",
)
doc.build(story, onFirstPage=draw_footer, onLaterPages=draw_footer)
print(f"Wrote: {OUT}")
print(f"Size: {OUT.stat().st_size:,} bytes")
