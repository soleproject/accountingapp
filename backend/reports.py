"""Financial reports + PDF generation (ReportLab)."""
from __future__ import annotations
from io import BytesIO
from datetime import datetime
from collections import defaultdict
from reportlab.lib.pagesizes import LETTER
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)

from db import db


async def _load_context(company_id: str, start: str, end: str, basis: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    txns = await db.transactions.find({
        "company_id": company_id,
        "date": {"$gte": start, "$lte": end},
        "posted": True,
    }).to_list(20000)
    return company, accts, txns


async def compute_income_statement(company_id: str, start: str, end: str, basis: str = "accrual"):
    company, accts, txns = await _load_context(company_id, start, end, basis)
    by_acct = defaultdict(float)
    for t in txns:
        aid = t.get("category_account_id")
        if aid:
            by_acct[aid] += float(t.get("amount", 0.0))

    revenue_rows = []
    expense_rows = []
    for a in sorted(accts, key=lambda x: x["code"]):
        amt = by_acct.get(a["id"], 0.0)
        if a["type"] == "revenue" and amt != 0:
            revenue_rows.append({"code": a["code"], "name": a["name"], "amount": round(amt, 2)})
        elif a["type"] == "expense" and amt != 0:
            expense_rows.append({"code": a["code"], "name": a["name"], "amount": round(-amt, 2)})

    total_revenue = sum(r["amount"] for r in revenue_rows)
    total_expense = sum(r["amount"] for r in expense_rows)
    net_income = total_revenue - total_expense

    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "basis": basis,
        "revenue": revenue_rows, "expenses": expense_rows,
        "total_revenue": round(total_revenue, 2),
        "total_expense": round(total_expense, 2),
        "net_income": round(net_income, 2),
    }


async def compute_balance_sheet(company_id: str, as_of: str, basis: str = "accrual"):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    txns = await db.transactions.find({
        "company_id": company_id, "date": {"$lte": as_of}, "posted": True,
    }).to_list(50000)

    by_acct = defaultdict(float)
    for t in txns:
        aid = t.get("category_account_id")
        if aid:
            by_acct[aid] += float(t.get("amount", 0.0))
        bank = t.get("bank_account_id")
        if bank:
            by_acct[bank] += float(t.get("amount", 0.0))

    groups = {"asset": [], "liability": [], "equity": []}
    for a in sorted(accts, key=lambda x: x["code"]):
        amt = by_acct.get(a["id"], 0.0)
        if a["type"] not in groups:
            continue
        if amt == 0 and a["type"] != "equity":
            continue
        groups[a["type"]].append({"code": a["code"], "name": a["name"], "amount": round(amt, 2)})

    # Compute retained earnings = revenue - expense to date
    re_amount = 0.0
    for a in accts:
        amt = by_acct.get(a["id"], 0.0)
        if a["type"] == "revenue":
            re_amount += amt
        elif a["type"] == "expense":
            re_amount -= amt
    groups["equity"].append({"code": "RE", "name": "Retained Earnings (period-to-date)", "amount": round(re_amount, 2)})

    total_a = sum(x["amount"] for x in groups["asset"])
    total_l = -sum(x["amount"] for x in groups["liability"])
    total_e = -sum(x["amount"] for x in groups["equity"])
    return {
        "company_name": company["name"] if company else "", "as_of": as_of, "basis": basis,
        "assets": groups["asset"], "liabilities": groups["liability"], "equity": groups["equity"],
        "total_assets": round(total_a, 2),
        "total_liabilities": round(total_l, 2),
        "total_equity": round(total_e, 2),
        "total_liabilities_equity": round(total_l + total_e, 2),
    }


async def compute_trial_balance(company_id: str, as_of: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    txns = await db.transactions.find({
        "company_id": company_id, "date": {"$lte": as_of}, "posted": True,
    }).to_list(50000)
    by_acct = defaultdict(float)
    for t in txns:
        aid = t.get("category_account_id")
        if aid:
            by_acct[aid] += float(t.get("amount", 0.0))
        bank = t.get("bank_account_id")
        if bank:
            by_acct[bank] += float(t.get("amount", 0.0))
    rows = []
    total_d = 0.0
    total_c = 0.0
    for a in sorted(accts, key=lambda x: x["code"]):
        bal = by_acct.get(a["id"], 0.0)
        if bal == 0:
            continue
        # Normal balance: assets/expenses = debit positive; liabilities/equity/revenue = credit
        if a["type"] in ("asset", "expense"):
            debit = max(bal, 0.0)
            credit = -min(bal, 0.0)
        else:
            debit = -min(bal, 0.0)
            credit = max(bal, 0.0)
        rows.append({"code": a["code"], "name": a["name"], "debit": round(debit, 2), "credit": round(credit, 2)})
        total_d += debit
        total_c += credit
    return {"company_name": company["name"] if company else "", "as_of": as_of,
            "rows": rows, "total_debit": round(total_d, 2), "total_credit": round(total_c, 2)}


async def compute_general_ledger(company_id: str, start: str, end: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    txns = await db.transactions.find({
        "company_id": company_id, "date": {"$gte": start, "$lte": end}, "posted": True,
    }).sort("date", 1).to_list(50000)
    grouped = defaultdict(list)
    for t in txns:
        aid = t.get("category_account_id")
        if aid:
            grouped[aid].append(t)
    accts_by_id = {a["id"]: a for a in accts}
    sections = []
    for aid, entries in grouped.items():
        a = accts_by_id.get(aid)
        if not a:
            continue
        rows = []
        run = 0.0
        for t in entries:
            amt = float(t.get("amount", 0.0))
            run += amt
            rows.append({
                "date": t["date"], "description": t.get("description", ""),
                "amount": round(amt, 2), "balance": round(run, 2),
            })
        sections.append({"code": a["code"], "name": a["name"], "entries": rows,
                         "total": round(run, 2)})
    sections.sort(key=lambda s: s["code"])
    return {"company_name": company["name"] if company else "",
            "period_start": start, "period_end": end, "sections": sections}


async def compute_cash_flow(company_id: str, start: str, end: str):
    """Simple direct-method cash flow: change in bank + operating breakdown."""
    company = await db.companies.find_one({"id": company_id})
    txns = await db.transactions.find({
        "company_id": company_id, "date": {"$gte": start, "$lte": end}, "posted": True,
    }).to_list(50000)
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    operating = 0.0
    investing = 0.0
    financing = 0.0
    for t in txns:
        aid = t.get("category_account_id")
        a = accts_by_id.get(aid) if aid else None
        amt = float(t.get("amount", 0.0))
        if not a:
            operating += amt
            continue
        if a["type"] in ("revenue", "expense"):
            operating += amt
        elif a["subtype"] == "fixed_asset":
            investing += amt
        elif a["type"] == "liability" and "loan" in a["name"].lower():
            financing += amt
        else:
            operating += amt
    net = operating + investing + financing
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "operating": round(operating, 2),
        "investing": round(investing, 2),
        "financing": round(financing, 2),
        "net_change": round(net, 2),
    }


# ---------- PDF rendering ----------

def _pdf_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Title2", fontName="Helvetica-Bold", fontSize=18,
                              alignment=1, spaceAfter=4))
    styles.add(ParagraphStyle(name="SubTitle", fontName="Helvetica", fontSize=11,
                              alignment=1, textColor=colors.HexColor("#52525B"), spaceAfter=2))
    styles.add(ParagraphStyle(name="Section", fontName="Helvetica-Bold", fontSize=11,
                              textColor=colors.HexColor("#0F172A"),
                              backColor=colors.HexColor("#F1F5F9"), spaceBefore=8, spaceAfter=4,
                              leftIndent=4, rightIndent=4))
    return styles


def _money_table(rows, totals_label, totals_amount):
    data = [[r.get("code", ""), r["name"], f"${r['amount']:,.2f}"] for r in rows]
    data.append(["", totals_label, f"${totals_amount:,.2f}"])
    t = Table(data, colWidths=[0.9 * inch, 4.2 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#52525B")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def build_income_statement_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("INCOME STATEMENT", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("REVENUE", s["Section"]),
        _money_table(data["revenue"], "Total Revenue", data["total_revenue"]),
        Spacer(1, 8),
        Paragraph("OPERATING EXPENSES", s["Section"]),
        _money_table(data["expenses"], "Total Expenses", data["total_expense"]),
        Spacer(1, 12),
        _money_table([], "NET INCOME", data["net_income"]),
    ]
    doc.build(story)
    return buf.getvalue()


def build_balance_sheet_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("BALANCE SHEET", s["SubTitle"]),
        Paragraph(f"As of {data['as_of']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("ASSETS", s["Section"]),
        _money_table(data["assets"], "Total Assets", data["total_assets"]),
        Spacer(1, 8),
        Paragraph("LIABILITIES", s["Section"]),
        _money_table(data["liabilities"], "Total Liabilities", data["total_liabilities"]),
        Spacer(1, 8),
        Paragraph("EQUITY", s["Section"]),
        _money_table(data["equity"], "Total Equity", data["total_equity"]),
        Spacer(1, 12),
        _money_table([], "TOTAL LIABILITIES & EQUITY", data["total_liabilities_equity"]),
    ]
    doc.build(story)
    return buf.getvalue()


def build_trial_balance_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    rows = [["Code", "Account", "Debit", "Credit"]]
    for r in data["rows"]:
        rows.append([r["code"], r["name"], f"${r['debit']:,.2f}" if r["debit"] else "",
                     f"${r['credit']:,.2f}" if r["credit"] else ""])
    rows.append(["", "TOTAL", f"${data['total_debit']:,.2f}", f"${data['total_credit']:,.2f}"])
    t = Table(rows, colWidths=[0.9 * inch, 3.6 * inch, 1.2 * inch, 1.2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("TRIAL BALANCE", s["SubTitle"]),
        Paragraph(f"As of {data['as_of']}", s["SubTitle"]),
        Spacer(1, 12), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_general_ledger_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("GENERAL LEDGER", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 10),
    ]
    for sec in data["sections"]:
        story.append(Paragraph(f"{sec['code']} — {sec['name']}", s["Section"]))
        rows = [["Date", "Description", "Amount", "Balance"]]
        for e in sec["entries"]:
            rows.append([e["date"], e["description"][:60], f"${e['amount']:,.2f}", f"${e['balance']:,.2f}"])
        rows.append(["", "Ending Balance", "", f"${sec['total']:,.2f}"])
        t = Table(rows, colWidths=[0.9 * inch, 3.4 * inch, 1.2 * inch, 1.4 * inch])
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(t)
        story.append(Spacer(1, 8))
    doc.build(story)
    return buf.getvalue()


def build_cash_flow_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    rows = [
        ["Cash flow from Operating Activities", f"${data['operating']:,.2f}"],
        ["Cash flow from Investing Activities", f"${data['investing']:,.2f}"],
        ["Cash flow from Financing Activities", f"${data['financing']:,.2f}"],
        ["Net Change in Cash", f"${data['net_change']:,.2f}"],
    ]
    t = Table(rows, colWidths=[4.5 * inch, 2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("STATEMENT OF CASH FLOWS", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 14), t,
    ]
    doc.build(story)
    return buf.getvalue()


# ---------- Sales Tax Liability ----------

async def compute_sales_tax(company_id: str, start: str, end: str):
    """Sum tax collected (invoices) minus tax paid (bills) for the period.

    Also breaks out by tax rate if line_items carry `tax_rate`.
    """
    company = await db.companies.find_one({"id": company_id})
    invs = await db.invoices.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)
    bills = await db.bills.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)

    collected = sum(float(i.get("tax", 0) or 0) for i in invs)
    paid = sum(float(b.get("tax", 0) or 0) for b in bills)
    taxable_sales = sum(float(i.get("subtotal", 0) or 0) for i in invs if float(i.get("tax", 0) or 0) > 0)
    nontaxable_sales = sum(float(i.get("subtotal", 0) or 0) for i in invs if float(i.get("tax", 0) or 0) == 0)

    # Aggregate paid vs unpaid liability (invoices with balance_due still open aren't yet remitted)
    settled_tax = 0.0
    for i in invs:
        total = float(i.get("total", 0) or 0)
        bal = float(i.get("balance_due", total) or 0)
        if total > 0:
            paid_ratio = max(0.0, min(1.0, (total - bal) / total))
            settled_tax += float(i.get("tax", 0) or 0) * paid_ratio

    net_liability = collected - paid
    rows = [
        {"label": "Taxable sales", "amount": round(taxable_sales, 2)},
        {"label": "Non-taxable sales", "amount": round(nontaxable_sales, 2)},
        {"label": "Sales tax collected (invoiced)", "amount": round(collected, 2)},
        {"label": "Sales tax collected & received", "amount": round(settled_tax, 2)},
        {"label": "Sales tax paid on purchases", "amount": round(paid, 2)},
    ]
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "rows": rows,
        "net_liability": round(net_liability, 2),
        "invoices_count": len(invs),
        "bills_count": len(bills),
    }


def build_sales_tax_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("SALES TAX LIABILITY", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 12),
    ]
    rows = [[r["label"], f"${r['amount']:,.2f}"] for r in data["rows"]]
    rows.append(["Net sales tax liability owed", f"${data['net_liability']:,.2f}"])
    t = Table(rows, colWidths=[4.5 * inch, 2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    doc.build(story)
    return buf.getvalue()


# ---------- 1099 Summary ----------

async def compute_1099_summary(company_id: str, year: int):
    """List contractor payments (vendors) totaling ≥ $600 in the calendar year.

    A "contractor" here = a contact of type=vendor. Amount = sum of payments linked to bills
    for that vendor + direct expense transactions categorized to Legal & Professional Fees or
    Payroll where the contact matches.
    """
    company = await db.companies.find_one({"id": company_id})
    start = f"{year}-01-01"; end = f"{year}-12-31"
    contacts = await db.contacts.find({"company_id": company_id, "type": {"$in": ["vendor", "both"]}}).to_list(2000)
    contact_by_id = {c["id"]: c for c in contacts}
    contact_by_name = {(c.get("name") or "").lower(): c for c in contacts}

    # Sum bill totals paid within the year to each vendor
    totals = {c["id"]: 0.0 for c in contacts}
    bills = await db.bills.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(20000)
    for b in bills:
        cid = b.get("contact_id")
        if not cid or cid not in totals:
            continue
        total = float(b.get("total", 0) or 0)
        bal = float(b.get("balance_due", total) or 0)
        paid_amt = max(0.0, total - bal)
        totals[cid] += paid_amt

    # Also include expense transactions with a matching merchant name (best-effort)
    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end}, "amount": {"$lt": 0},
    }).to_list(50000)
    for t in txns:
        merch = (t.get("merchant") or "").lower()
        c = contact_by_name.get(merch)
        if not c:
            continue
        totals[c["id"]] += abs(float(t.get("amount", 0) or 0))

    rows = []
    for cid_, amt in totals.items():
        if amt < 600.0:
            continue
        c = contact_by_id[cid_]
        rows.append({
            "contact_name": c.get("name"),
            "tin": c.get("tin", ""),
            "w9_on_file": bool(c.get("w9_on_file", False)),
            "total_paid": round(amt, 2),
        })
    rows.sort(key=lambda r: r["total_paid"], reverse=True)
    return {
        "company_name": company["name"] if company else "",
        "year": year,
        "rows": rows,
        "total_reportable": round(sum(r["total_paid"] for r in rows), 2),
        "count": len(rows),
    }


def build_1099_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("1099 SUMMARY", s["SubTitle"]),
        Paragraph(f"Tax year {data['year']} · Contractors paid ≥ $600", s["SubTitle"]),
        Spacer(1, 12),
    ]
    rows = [["Contractor", "TIN / EIN", "W-9 on file", "Total Paid"]]
    for r in data["rows"]:
        rows.append([r["contact_name"], r["tin"] or "—",
                     "Yes" if r["w9_on_file"] else "No", f"${r['total_paid']:,.2f}"])
    rows.append(["", "", "TOTAL", f"${data['total_reportable']:,.2f}"])
    t = Table(rows, colWidths=[3.0 * inch, 1.5 * inch, 1.0 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (3, 0), (3, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    if not data["rows"]:
        story.append(Spacer(1, 20))
        story.append(Paragraph("No contractors met the $600 reporting threshold this year.",
                               s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()
