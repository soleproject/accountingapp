"""CSV builders for financial reports.

Mirrors the ``build_*_pdf`` functions in :mod:`reports` — same data
shapes in, same visual grouping (section headings, subtotals, grand
totals) preserved as CSV rows for spreadsheet use. Numeric cells are
kept as raw floats (unquoted, unformatted) so Excel / Google Sheets /
Numbers can SUM them directly without a text-to-number conversion.

Every builder returns ``bytes`` (UTF-8 encoded) ready to stream from a
FastAPI ``Response``.
"""
from __future__ import annotations

import csv
import io
from typing import Any


def _fmt_money(v: Any) -> str:
    """Serialize a number for CSV: raw float with 2 decimals, no $, no
    thousands separators — spreadsheet-friendly. Non-numeric → empty."""
    if v is None or v == "":
        return ""
    try:
        return f"{float(v):.2f}"
    except (TypeError, ValueError):
        return ""


def _writer() -> tuple[io.StringIO, "csv.writer"]:
    buf = io.StringIO()
    return buf, csv.writer(buf, quoting=csv.QUOTE_MINIMAL)


def _header(w, data: dict, subtitle: str) -> None:
    """Standard 4-line header block written to every report CSV."""
    w.writerow([data.get("company_name", "")])
    w.writerow([data.get("report_label") or ""])
    w.writerow([subtitle])
    w.writerow([])


def _finish(buf: io.StringIO) -> bytes:
    return buf.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# Section-grouped writer used by BS + IS. Emits detail-type banners as
# their own header rows so the CSV visually mirrors the on-screen report
# and the PDF export.
# ---------------------------------------------------------------------------

_DETAIL_LABELS = {
    # Mirrors reports._DETAIL_PDF_LABELS — kept locally so this module has
    # no dep on the PDF builder internals.
    "bank": "Bank / Cash", "accounts_receivable": "Accounts Receivable",
    "other_current_asset": "Other Current Assets", "fixed_asset": "Fixed Assets",
    "other_asset": "Other Assets", "inventory_asset": "Inventory",
    "accounts_payable": "Accounts Payable",
    "credit_card": "Credit Cards", "other_current_liability": "Other Current Liabilities",
    "long_term_liability": "Long-Term Liabilities",
    "income": "Income", "other_income": "Other Income",
    "cost_of_goods_sold": "Cost of Goods Sold",
    "expense": "Expenses", "other_expense": "Other Expenses",
}


def _write_grouped(w, rows: list[dict], totals_label: str, totals_amount: Any) -> None:
    current = "___INIT___"
    for r in rows or []:
        dt = (r.get("detail_type") or "").strip()
        if dt and dt != current:
            current = dt
            w.writerow(["", _DETAIL_LABELS.get(dt, dt.replace("_", " ").title()), ""])
        w.writerow([r.get("code", ""), r.get("name", ""), _fmt_money(r.get("amount"))])
    w.writerow(["", totals_label, _fmt_money(totals_amount)])


# ---------------------------------------------------------------------------
# Balance Sheet
# ---------------------------------------------------------------------------

def build_balance_sheet_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data, f"As of {data.get('as_of', '')} · {data.get('basis', '')} basis")
    w.writerow(["Code", "Account", "Amount"])
    w.writerow([])
    w.writerow(["ASSETS"])
    _write_grouped(w, data.get("assets") or [], "Total Assets", data.get("total_assets"))
    w.writerow([])
    w.writerow(["LIABILITIES"])
    _write_grouped(w, data.get("liabilities") or [], "Total Liabilities", data.get("total_liabilities"))
    w.writerow([])
    w.writerow(["EQUITY"])
    _write_grouped(w, data.get("equity") or [], "Total Equity", data.get("total_equity"))
    w.writerow([])
    w.writerow(["", "TOTAL LIABILITIES & EQUITY", _fmt_money(data.get("total_liabilities_equity"))])
    if not data.get("balanced", True):
        w.writerow([])
        w.writerow(["Imbalance", _fmt_money(data.get("imbalance"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# Income Statement (P&L)
# ---------------------------------------------------------------------------

def build_income_statement_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data,
            f"For the period {data.get('period_start', '')} to {data.get('period_end', '')} "
            f"· {(data.get('basis') or '').title()} basis")
    w.writerow(["Code", "Account", "Amount"])
    w.writerow([])
    w.writerow(["REVENUE"])
    _write_grouped(w, data.get("revenue") or [], "Total Income", data.get("total_revenue"))
    cogs = data.get("cogs") or []
    total_cogs = data.get("total_cogs") or 0
    if cogs or abs(float(total_cogs or 0)) >= 0.005:
        w.writerow([])
        w.writerow(["COST OF GOODS SOLD"])
        _write_grouped(w, cogs, "Total Cost of Goods Sold", total_cogs)
        w.writerow([])
        w.writerow(["", "GROSS PROFIT", _fmt_money(data.get("gross_profit"))])
    w.writerow([])
    w.writerow(["OPERATING EXPENSES"])
    _write_grouped(w, data.get("expenses") or [], "Total Expenses", data.get("total_expense"))
    w.writerow([])
    w.writerow(["", "NET INCOME", _fmt_money(data.get("net_income"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# Trial Balance
# ---------------------------------------------------------------------------

def build_trial_balance_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data, f"As of {data.get('as_of', '')}")
    w.writerow(["Code", "Account", "Debit", "Credit"])
    for r in data.get("rows") or []:
        w.writerow([r.get("code", ""), r.get("name", ""),
                    _fmt_money(r.get("debit")), _fmt_money(r.get("credit"))])
    w.writerow(["", "TOTAL", _fmt_money(data.get("total_debit")),
                _fmt_money(data.get("total_credit"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# General Ledger
# ---------------------------------------------------------------------------

def build_general_ledger_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data, f"For the period {data.get('period_start', '')} to {data.get('period_end', '')}")
    w.writerow(["Account Code", "Account", "Date", "Source", "Description",
                "Debit", "Credit", "Balance"])
    for sec in data.get("sections") or []:
        w.writerow([sec.get("code", ""), sec.get("name", ""), "", "", "Opening balance",
                    "", "", _fmt_money(sec.get("opening_balance"))])
        for e in sec.get("entries") or []:
            w.writerow([sec.get("code", ""), sec.get("name", ""),
                        e.get("date", ""), e.get("source", "Txn"),
                        e.get("description", ""),
                        _fmt_money(e.get("debit")), _fmt_money(e.get("credit")),
                        _fmt_money(e.get("balance"))])
        w.writerow([sec.get("code", ""), sec.get("name", ""), "", "", "Ending Balance",
                    "", "", _fmt_money(sec.get("total"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# Cash Flow
# ---------------------------------------------------------------------------

def build_cash_flow_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data, f"For the period {data.get('period_start', '')} to {data.get('period_end', '')}")
    w.writerow(["Section", "Amount"])
    w.writerow(["Cash flow from Operating Activities", _fmt_money(data.get("operating"))])
    w.writerow(["Cash flow from Investing Activities", _fmt_money(data.get("investing"))])
    w.writerow(["Cash flow from Financing Activities", _fmt_money(data.get("financing"))])
    w.writerow(["Net Change in Cash", _fmt_money(data.get("net_change"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# Sales Tax Liability
# ---------------------------------------------------------------------------

def build_sales_tax_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data, f"For the period {data.get('period_start', '')} to {data.get('period_end', '')}")
    w.writerow(["Line", "Amount"])
    for r in data.get("rows") or []:
        w.writerow([r.get("label", ""), _fmt_money(r.get("amount"))])
    w.writerow(["Net sales tax liability owed", _fmt_money(data.get("net_liability"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# 1099 Summary
# ---------------------------------------------------------------------------

def build_1099_csv(data: dict) -> bytes:
    buf, w = _writer()
    _header(w, data, f"Tax year {data.get('year', '')} · Contractors paid ≥ $600")
    w.writerow(["Contractor", "TIN / EIN", "W-9 on file", "Total Paid"])
    for r in data.get("rows") or []:
        w.writerow([r.get("contact_name", ""),
                    r.get("tin") or "",
                    "Yes" if r.get("w9_on_file") else "No",
                    _fmt_money(r.get("total_paid"))])
    w.writerow(["", "", "TOTAL", _fmt_money(data.get("total_reportable"))])
    return _finish(buf)


# ---------------------------------------------------------------------------
# Account Detail (transaction listing)
# ---------------------------------------------------------------------------

def build_account_detail_csv(data: dict) -> bytes:
    buf, w = _writer()
    a = data.get("account") or {}
    _header(
        w, data,
        f"{a.get('code', '')} · {a.get('name', '')} · "
        f"{data.get('count', 0)} txns · balance {_fmt_money(data.get('balance'))}",
    )
    w.writerow(["Date", "Merchant", "Description", "Contact", "Amount", "Running Balance"])
    for r in data.get("rows") or []:
        w.writerow([
            r.get("date", ""),
            r.get("merchant", ""),
            r.get("description", ""),
            r.get("contact_name", ""),
            _fmt_money(r.get("amount")),
            _fmt_money(r.get("running")),
        ])
    w.writerow(["", "", "TOTAL", "",
                _fmt_money(data.get("sum_amount")),
                _fmt_money(data.get("balance"))])
    return _finish(buf)
