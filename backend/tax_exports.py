"""CSV / PDF exports for the Tax Line and Book-to-Tax reports."""
from __future__ import annotations

import csv
from io import BytesIO, StringIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from reports import _pdf_styles


def _money(x) -> str:
    x = float(x or 0)
    return f"(${abs(x):,.2f})" if x < 0 else f"${x:,.2f}"


def _doc(buf):
    return SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                             topMargin=0.6 * inch, bottomMargin=0.6 * inch)


def _table(rows, widths, bold_rows=(), rule_rows=(), head=False):
    t = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
    style = [("FONTNAME", (0, 0), (-1, -1), "Helvetica"), ("FONTSIZE", (0, 0), (-1, -1), 9),
             ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4)]
    if head:
        style += [("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#94A3B8"))]
    for r in bold_rows:
        style.append(("FONTNAME", (0, r), (-1, r), "Helvetica-Bold"))
    for r in rule_rows:
        style.append(("LINEABOVE", (0, r), (-1, r), 0.5, colors.HexColor("#0F172A")))
    t.setStyle(TableStyle(style))
    return t


# ---------------- Tax Line Report ----------------
def tax_lines_csv(d: dict) -> bytes:
    out = StringIO(); w = csv.writer(out)
    w.writerow(["Company", d.get("company_name"), "Form", d.get("form_label"), "Tax year", d.get("tax_year"),
                "Period", f"{d['period_start']} to {d['period_end']}", "Basis", d.get("basis")])
    w.writerow([])
    w.writerow(["Section", "Line", "Tax line", "Account code", "Account", "Book amount", "Limit %", "Return amount", "Mapped by"])
    for sec, key in (("Income", "income"), ("Cost of goods sold", "cogs"), ("Deductions", "deductions"), ("Schedule K (separately stated)", "schedule_k")):
        for g in d.get(key) or []:
            w.writerow([sec, g["line"], g["label"], "", "", g["book_amount"], g.get("limit_pct") or 100, g["return_amount"], ""])
            for a in g["accounts"]:
                w.writerow([sec, g["line"], g["label"], a["code"], a["name"], a["amount"], "", "", a.get("source") or ""])
    for a in d.get("unmapped") or []:
        w.writerow(["UNMAPPED", "", "", a["code"], a["name"], a["amount"], "", "", ""])
    for a in d.get("not_on_return") or []:
        w.writerow(["Not on return", "", a.get("key"), a["code"], a["name"], a["amount"], "", 0, a.get("source") or ""])
    w.writerow([])
    w.writerow(["Total income", d["total_income"]]); w.writerow(["Total COGS", d["total_cogs"]])
    w.writerow(["Total deductions", d["total_deductions"]]); w.writerow(["Net per return lines (ordinary)", d["return_net"]])
    w.writerow(["Schedule K items total", d.get("total_schedule_k", 0)])
    w.writerow(["Unmapped total", d["unmapped_total"]]); w.writerow(["Not on return total", d["not_on_return_total"]])
    w.writerow(["Book net income", d["book_net_income"]])
    return out.getvalue().encode("utf-8")


def tax_lines_pdf(d: dict) -> bytes:
    buf = BytesIO(); doc = _doc(buf); s = _pdf_styles(d.get("report_style"))
    story = [Paragraph(d.get("company_name") or "", s["Title2"]),
             Paragraph(f"TAX LINE REPORT — {d.get('form_label') or ''} · TAX YEAR {d.get('tax_year')}".upper(), s["SubTitle"]),
             Paragraph(f"For the period {d['period_start']} to {d['period_end']} · {d.get('basis','accrual')} basis · federal only", s["SubTitle"]),
             Spacer(1, 10)]
    widths = [0.7 * inch, 3.6 * inch, 1.3 * inch, 1.3 * inch]

    def section(title, groups, total):
        if not groups:
            return
        rows = [["Line", title, "Book", "Return"]]
        bold = []
        for g in groups:
            bold.append(len(rows))
            lim = f" ({g['limit_pct']}% limit)" if g.get("limit_pct") else ""
            rows.append([f"{g['line']}", f"{g['label']}{lim}", _money(g["book_amount"]), _money(g["return_amount"])])
            for a in g["accounts"]:
                rows.append(["", f"    {a['code'] or ''}  {a['name']}", _money(a["amount"]), ""])
        rows.append(["", f"Total {title.lower()}", "", _money(total)])
        story.append(_table(rows, widths, bold_rows=bold + [len(rows) - 1], rule_rows=[len(rows) - 1], head=True))
        story.append(Spacer(1, 8))

    section("Income", d.get("income") or [], d["total_income"])
    section("Cost of goods sold", d.get("cogs") or [], d["total_cogs"])
    section("Deductions", d.get("deductions") or [], d["total_deductions"])
    story.append(_table([["", "Net per return lines (ordinary business income)", "", _money(d["return_net"])]], widths, bold_rows=[0], rule_rows=[0]))
    story.append(Spacer(1, 8))
    section("Schedule K — separately stated items", d.get("schedule_k") or [], d.get("total_schedule_k", 0))

    for title, key, tot in (("Unmapped — needs a decision", "unmapped", d["unmapped_total"]), ("Not on return", "not_on_return", d["not_on_return_total"])):
        items = d.get(key) or []
        if not items:
            continue
        rows = [["", title, "Book", ""]] + [["", f"    {a['code'] or ''}  {a['name']}", _money(a["amount"]), ""] for a in items]
        rows.append(["", f"Total {title.split(' —')[0].lower()}", _money(tot), ""])
        story.append(_table(rows, widths, bold_rows=[len(rows) - 1], rule_rows=[len(rows) - 1], head=True)); story.append(Spacer(1, 8))

    story.append(_table([["", "Book net income (per Income Statement)", "", _money(d["book_net_income"])],
                         ["", "Net per return lines (ordinary)", "", _money(d["return_net"])]], widths, bold_rows=[0, 1], rule_rows=[0]))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Lines per IRS forms for the tax year shown; mapping by account. Estimate for preparer review — not a filed return.", s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()


# ---------------- Book-to-Tax ----------------
def book_to_tax_csv(d: dict) -> bytes:
    out = StringIO(); w = csv.writer(out)
    w.writerow(["Company", d.get("company_name"), "Period", f"{d['period_start']} to {d['period_end']}", "Basis", d.get("basis")])
    w.writerow([]); w.writerow(["Book net income", d["book_net_income"]]); w.writerow([])
    w.writerow(["Account code", "Account", "Book amount", "Deductible %", "Deductible amount", "Add-back", "Deductibility source"])
    for a in d["adjustments"]:
        w.writerow([a["code"], a["name"], a["book_amount"], a["deductible_pct"], a["deductible_amount"], a["addback"], "inferred" if a.get("inferred") else "set"])
    w.writerow([]); w.writerow(["Total add-backs", d["total_addback"]]); w.writerow(["Estimated taxable net income", d["taxable_net_income"]])
    return out.getvalue().encode("utf-8")


def book_to_tax_pdf(d: dict) -> bytes:
    buf = BytesIO(); doc = _doc(buf); s = _pdf_styles(d.get("report_style"))
    story = [Paragraph(d.get("company_name") or "", s["Title2"]), Paragraph("BOOK-TO-TAX ADJUSTMENTS", s["SubTitle"]),
             Paragraph(f"For the period {d['period_start']} to {d['period_end']} · {d.get('basis','accrual')} basis", s["SubTitle"]), Spacer(1, 10)]
    widths = [3.4 * inch, 1.2 * inch, 0.9 * inch, 1.2 * inch]
    rows = [["Account", "Book", "Deductible", "Add-back"]]
    for a in d["adjustments"]:
        rows.append([f"{a['code'] or ''}  {a['name']}", _money(a["book_amount"]), f"{a['deductible_pct']}%", _money(a["addback"])])
    rows.append(["Total add-backs", "", "", _money(d["total_addback"])])
    story.append(_table([["Book net income (per Income Statement)", "", "", _money(d["book_net_income"])]], widths, bold_rows=[0]))
    story.append(Spacer(1, 6))
    story.append(_table(rows, widths, bold_rows=[len(rows) - 1], rule_rows=[len(rows) - 1], head=True))
    story.append(Spacer(1, 6))
    story.append(_table([["Estimated taxable net income", "", "", _money(d["taxable_net_income"])]], widths, bold_rows=[0], rule_rows=[0]))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Estimate only — other book/tax differences (depreciation methods, accruals, owner compensation) are not included.", s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()
