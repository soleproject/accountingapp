"""PDF generation for invoices and bills.

Kept in its own module so the reportlab imports stay lazy — most
requests don't need PDF rendering, and importing reportlab at cold
start adds ~200ms per worker.
"""
from __future__ import annotations
from io import BytesIO
from typing import Iterable


def _fmt_money(v) -> str:
    try:
        return f"${float(v):,.2f}"
    except (TypeError, ValueError):
        return "$0.00"


def build_document_pdf(*, kind: str, doc: dict, company: dict | None = None,
                       payments: Iterable[dict] | None = None) -> bytes:
    """Render an invoice or a bill to a PDF.

    `kind` = "invoice" | "bill". Layout is the same; only the header
    label ("INVOICE" / "BILL") and the counterparty label ("Bill To" /
    "Vendor") differ.
    """
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buf = BytesIO()
    pdf = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.5 * inch, bottomMargin=0.5 * inch,
    )
    styles = getSampleStyleSheet()
    label_kind = "INVOICE" if kind == "invoice" else "BILL"
    counter_label = "Bill To" if kind == "invoice" else "Vendor"

    heading = ParagraphStyle("h", parent=styles["Heading1"], fontSize=22, spaceAfter=6, textColor=colors.HexColor("#0F172A"))
    subtle = ParagraphStyle("s", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#64748B"))
    bold = ParagraphStyle("b", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#0F172A"))
    right = ParagraphStyle("r", parent=styles["Normal"], fontSize=10, alignment=2)

    story = []
    firm = (company or {}).get("name") or "Your Company"
    story.append(Paragraph(f"<b>{firm}</b>", heading))
    story.append(Paragraph(f"<font color='#64748B' size='10'>{label_kind} · {doc.get('number','')}</font>", subtle))
    story.append(Spacer(1, 12))

    meta_rows = [
        [Paragraph(f"<b>{counter_label}</b>", bold), Paragraph("<b>Issue date</b>", bold), Paragraph("<b>Due date</b>", bold), Paragraph("<b>Status</b>", bold)],
        [
            Paragraph(doc.get("contact_name") or "—", styles["Normal"]),
            Paragraph(doc.get("issue_date") or "", styles["Normal"]),
            Paragraph(doc.get("due_date") or "", styles["Normal"]),
            Paragraph((doc.get("status") or "").upper(), styles["Normal"]),
        ],
    ]
    meta = Table(meta_rows, colWidths=[2.4 * inch, 1.2 * inch, 1.2 * inch, 1.2 * inch])
    meta.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#F1F5F9")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F8FAFC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(meta)
    story.append(Spacer(1, 14))

    lines_header = [Paragraph("<b>Description</b>", bold), Paragraph("<b>Qty</b>", bold),
                    Paragraph("<b>Rate</b>", bold), Paragraph("<b>Amount</b>", right)]
    line_rows = [lines_header]
    for li in (doc.get("line_items") or []):
        line_rows.append([
            Paragraph(li.get("description") or li.get("item_name") or "—", styles["Normal"]),
            Paragraph(str(li.get("quantity") or 0), styles["Normal"]),
            Paragraph(_fmt_money(li.get("rate")), styles["Normal"]),
            Paragraph(_fmt_money(li.get("amount")), right),
        ])
    lines = Table(line_rows, colWidths=[3.8 * inch, 0.8 * inch, 1.1 * inch, 1.3 * inch])
    lines.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#94A3B8")),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#F1F5F9")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(lines)
    story.append(Spacer(1, 12))

    subtotal = float(doc.get("subtotal", 0) or 0)
    tax = float(doc.get("tax", 0) or 0)
    total = float(doc.get("total", 0) or 0)
    balance = float(doc.get("balance_due", 0) or 0)
    totals_rows = [
        ["Subtotal", _fmt_money(subtotal)],
        ["Tax", _fmt_money(tax)],
        ["Total", _fmt_money(total)],
        ["Balance due", _fmt_money(balance)],
    ]
    totals = Table(totals_rows, colWidths=[5.7 * inch, 1.3 * inch])
    totals.setStyle(TableStyle([
        ("FONTNAME", (0, 2), (-1, 2), "Helvetica-Bold"),
        ("FONTNAME", (0, 3), (-1, 3), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, 3), (-1, 3), colors.HexColor("#B91C1C") if balance > 0.01 else colors.HexColor("#059669")),
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(totals)

    if payments:
        story.append(Spacer(1, 12))
        story.append(Paragraph("<b>Payments applied</b>", bold))
        pay_rows = [[Paragraph("<b>Date</b>", bold), Paragraph("<b>Method</b>", bold), Paragraph("<b>Amount</b>", right)]]
        for p in payments:
            pay_rows.append([
                Paragraph(str(p.get("date") or ""), styles["Normal"]),
                Paragraph(str(p.get("method") or ""), styles["Normal"]),
                Paragraph(_fmt_money(p.get("amount")), right),
            ])
        pay_tbl = Table(pay_rows, colWidths=[1.8 * inch, 2.4 * inch, 2.8 * inch])
        pay_tbl.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#94A3B8")),
            ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#F1F5F9")),
        ]))
        story.append(pay_tbl)

    if doc.get("notes"):
        story.append(Spacer(1, 14))
        story.append(Paragraph(f"<font color='#64748B' size='9'><b>Notes.</b> {doc['notes']}</font>", subtle))

    pdf.build(story)
    return buf.getvalue()
