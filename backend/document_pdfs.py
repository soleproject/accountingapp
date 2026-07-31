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
    company = company or {}
    firm = company.get("name") or "Your Company"
    # Per-doc title override (e.g. "Deposit invoice", "Retainer" — Wave-
    # style). Falls back to canonical INVOICE / BILL label.
    doc_title = (doc.get("title") or "").strip() or ("Invoice" if kind == "invoice" else "Bill")
    doc_summary = (doc.get("summary") or "").strip()

    # Header row: optional logo on the left, firm identity block on the
    # right. Falls back to a plain heading when no logo is uploaded.
    from reportlab.platypus import Image
    from reportlab.lib.utils import ImageReader
    import base64 as _b64
    logo_url = company.get("logo_data_url") or ""
    logo_flowable = None
    if logo_url.startswith("data:image/"):
        try:
            _, b64 = logo_url.split(",", 1)
            reader = ImageReader(BytesIO(_b64.b64decode(b64)))
            iw, ih = reader.getSize()
            scale = min(1.2 * inch / iw if iw else 1, 0.75 * inch / ih if ih else 1)
            logo_flowable = Image(BytesIO(_b64.b64decode(b64)),
                                  width=iw * scale, height=ih * scale)
        except Exception:
            logo_flowable = None

    identity_bits = [f"<b>{firm}</b>"]
    for field in ("address", "phone", "email", "website"):
        v = company.get(field)
        if v: identity_bits.append(str(v))
    if company.get("tax_id"):
        identity_bits.append(f"Tax ID: {company['tax_id']}")
    identity_html = "<br/>".join(identity_bits)
    identity_p = Paragraph(f"<font size='9' color='#0F172A'>{identity_html}</font>",
                           styles["Normal"])

    if logo_flowable is not None:
        header_row = Table([[logo_flowable, identity_p]], colWidths=[1.6 * inch, 5.4 * inch])
        header_row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(header_row)
    else:
        story.append(Paragraph(f"<b>{firm}</b>", heading))
        if len(identity_bits) > 1:
            story.append(Paragraph(f"<font size='9' color='#64748B'>{'<br/>'.join(identity_bits[1:])}</font>", subtle))

    story.append(Spacer(1, 8))
    story.append(Paragraph(f"<font size='16' color='#0F172A'><b>{doc_title}</b></font> "
                           f"<font size='10' color='#64748B'>· {doc.get('number','')}</font>", styles["Normal"]))
    if doc_summary:
        story.append(Paragraph(f"<font size='9' color='#64748B'>{doc_summary}</font>", subtle))
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

    # Optional PO number / Terms strip, rendered only when either is set.
    po = (doc.get("po_number") or "").strip()
    terms = (doc.get("terms") or "").strip()
    if po or terms:
        info_rows = [[
            Paragraph(f"<b>PO number</b><br/><font size='9'>{po or '—'}</font>", styles["Normal"]),
            Paragraph(f"<b>Terms</b><br/><font size='9'>{terms or '—'}</font>", styles["Normal"]),
        ]]
        info = Table(info_rows, colWidths=[3.0 * inch, 4.0 * inch])
        info.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#F1F5F9")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(Spacer(1, 6))
        story.append(info)
    story.append(Spacer(1, 14))

    all_lines = doc.get("line_items") or []
    has_line_tax = any(float(li.get("tax_rate", 0) or 0) > 0 for li in all_lines)
    if has_line_tax:
        lines_header = [Paragraph("<b>Description</b>", bold), Paragraph("<b>Qty</b>", bold),
                        Paragraph("<b>Rate</b>", bold), Paragraph("<b>Tax</b>", bold),
                        Paragraph("<b>Amount</b>", right)]
        line_rows = [lines_header]
        for li in all_lines:
            tr = float(li.get("tax_rate", 0) or 0)
            tax_cell = f"{(li.get('tax_name') or '')} {tr:g}%".strip() if tr else "—"
            line_rows.append([
                Paragraph(li.get("description") or li.get("item_name") or "—", styles["Normal"]),
                Paragraph(str(li.get("quantity") or 0), styles["Normal"]),
                Paragraph(_fmt_money(li.get("rate")), styles["Normal"]),
                Paragraph(tax_cell, styles["Normal"]),
                Paragraph(_fmt_money(li.get("amount")), right),
            ])
        lines = Table(line_rows, colWidths=[3.0 * inch, 0.7 * inch, 1.0 * inch, 1.0 * inch, 1.3 * inch])
    else:
        lines_header = [Paragraph("<b>Description</b>", bold), Paragraph("<b>Qty</b>", bold),
                        Paragraph("<b>Rate</b>", bold), Paragraph("<b>Amount</b>", right)]
        line_rows = [lines_header]
        for li in all_lines:
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
    disc_amt = float(doc.get("discount_amount", 0) or 0)
    ship = float(doc.get("shipping", 0) or 0)
    dtype = (doc.get("discount_type") or "amount").lower()
    disc_val = float(doc.get("discount", 0) or 0)
    disc_label = f"Discount ({disc_val:g}%)" if dtype == "percent" and disc_val else "Discount"

    totals_rows = [["Subtotal", _fmt_money(subtotal)]]
    if disc_amt > 0.005:
        totals_rows.append([disc_label, f"-{_fmt_money(disc_amt)}"])
    if ship > 0.005:
        totals_rows.append(["Shipping", _fmt_money(ship)])
    totals_rows.append(["Tax", _fmt_money(tax)])
    totals_rows.append(["Total", _fmt_money(total)])
    totals_rows.append(["Balance due", _fmt_money(balance)])
    totals = Table(totals_rows, colWidths=[5.7 * inch, 1.3 * inch])
    total_row = len(totals_rows) - 2
    balance_row = len(totals_rows) - 1
    totals.setStyle(TableStyle([
        ("FONTNAME", (0, total_row), (-1, total_row), "Helvetica-Bold"),
        ("FONTNAME", (0, balance_row), (-1, balance_row), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, balance_row), (-1, balance_row), colors.HexColor("#B91C1C") if balance > 0.01 else colors.HexColor("#059669")),
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(totals)

    if payments:
        story.append(Spacer(1, 16))
        # Section title band, matches the Wave-style "Payment History".
        title_bar = Table([[Paragraph("<b>PAYMENT HISTORY</b>", bold)]], colWidths=[7.0 * inch])
        title_bar.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F1F5F9")),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(title_bar)
        # Method + Reference columns join the existing Date/Amount pair.
        pay_rows = [[
            Paragraph("<b>Payment date</b>", bold),
            Paragraph("<b>Description</b>", bold),
            Paragraph("<b>Payment method</b>", bold),
            Paragraph("<b>Reference / ID</b>", bold),
            Paragraph("<b>Amount</b>", right),
        ]]
        total_paid = 0.0
        for p in payments:
            amt = float(p.get("amount") or 0)
            total_paid += amt
            method_raw = str(p.get("method") or "")
            method_pretty = {
                "check": "Check",
                "ach": "ACH Transfer",
                "credit_card": "Credit card",
                "wire": "Wire transfer",
                "cash": "Cash",
                "other": "Other",
            }.get(method_raw.lower(), method_raw.title() or "—")
            desc = "Payment Received" if kind == "invoice" else "Payment Sent"
            pay_rows.append([
                Paragraph(str(p.get("date") or ""), styles["Normal"]),
                Paragraph(desc, styles["Normal"]),
                Paragraph(method_pretty, styles["Normal"]),
                Paragraph(str(p.get("memo") or p.get("reference") or "—"), styles["Normal"]),
                Paragraph(_fmt_money(amt), right),
            ])
        # Total row
        pay_rows.append([
            "", "", "",
            Paragraph("<b>Total Payments Received</b>", bold),
            Paragraph(f"<b>{_fmt_money(total_paid)}</b>", right),
        ])
        pay_tbl = Table(pay_rows, colWidths=[0.9 * inch, 1.4 * inch, 1.7 * inch, 1.7 * inch, 1.3 * inch])
        pay_tbl.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#94A3B8")),
            ("LINEBELOW", (0, 1), (-1, -2), 0.25, colors.HexColor("#F1F5F9")),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#94A3B8")),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(pay_tbl)

        # ── Invoice Summary block: Original − Paid − Credits = Remaining ──
        original = float(doc.get("total") or 0)
        credits = 0.0  # placeholder — credits engine not wired yet.
        remaining = round(original - total_paid - credits, 2)
        story.append(Spacer(1, 12))
        sum_title = Table([[Paragraph(f"<b>{kind.upper()} SUMMARY</b>", bold)]], colWidths=[7.0 * inch])
        sum_title.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F1F5F9")),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(sum_title)
        rem_color = colors.HexColor("#059669") if remaining <= 0.01 else colors.HexColor("#B91C1C")
        remaining_label = "Fully paid" if remaining <= 0.01 else "Remaining Balance Due"
        sum_rows = [[
            Paragraph(f"<b>Original {kind.title()} Amount</b><br/><font size='10'>{_fmt_money(original)}</font>", styles["Normal"]),
            Paragraph("<font size='14'>−</font>", styles["Normal"]),
            Paragraph(f"<b>Total Payments Received</b><br/><font size='10'>{_fmt_money(total_paid)}</font>", styles["Normal"]),
            Paragraph("<font size='14'>−</font>", styles["Normal"]),
            Paragraph(f"<b>Credits Applied</b><br/><font size='10'>{_fmt_money(credits)}</font>", styles["Normal"]),
            Paragraph("<font size='14'>=</font>", styles["Normal"]),
            Paragraph(
                f"<b><font color='{'#059669' if remaining <= 0.01 else '#B91C1C'}'>{remaining_label}</font></b>"
                f"<br/><font size='12' color='{'#059669' if remaining <= 0.01 else '#B91C1C'}'>{_fmt_money(remaining)}</font>",
                styles["Normal"],
            ),
        ]]
        sum_tbl = Table(sum_rows, colWidths=[1.4 * inch, 0.3 * inch, 1.5 * inch, 0.3 * inch, 1.3 * inch, 0.3 * inch, 1.9 * inch])
        sum_tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        _ = rem_color  # silence unused-var warning; color inline above.
        story.append(sum_tbl)

    if doc.get("notes"):
        story.append(Spacer(1, 14))
        story.append(Paragraph(f"<font color='#64748B' size='9'><b>Notes.</b> {doc['notes']}</font>", subtle))

    pdf.build(story)
    return buf.getvalue()
