"""QBO migration verification — upload a QBO Balance Sheet OR Profit &
Loss PDF; we extract each account+amount with an LLM, then diff against
what our computed report shows for the same period. Read-only in v1 —
the diff table is for CPA review, no auto-post.

Feb 26 2026. Sits alongside the migration screen so a customer can
prove their migrated books tie to QBO's own reports before trusting
the numbers.

Feb 27 2026. Added P&L (Profit & Loss / Income Statement) support.
Report type is auto-detected from the PDF header text.
"""
from __future__ import annotations

import io
import json
import re
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pypdf import PdfReader

from auth import require_role
from db import db
from llm_client import LlmChat, UserMessage
from reports import compute_balance_sheet, compute_income_statement

router = APIRouter(prefix="/api/companies/{company_id}/qbo", tags=["qbo"])

_BS_SYSTEM = (
    "You extract structured account balances from a QuickBooks Online "
    "Balance Sheet PDF. Return STRICT JSON with schema: "
    "{\"as_of\": \"YYYY-MM-DD\", \"accounts\": "
    "[{\"name\": string, \"amount\": number, \"section\": "
    "\"asset\"|\"liability\"|\"equity\"}]}. "
    "Rules: (1) Only leaf accounts with actual dollar amounts; skip "
    "section header rows like 'Bank Accounts' and roll-up subtotals "
    "like 'Total Bank Accounts'. (2) Negative values in parentheses "
    "are stored as negative numbers. (3) Preserve exact account names "
    "as displayed on the PDF (e.g. 'Accounts Receivable (A/R)'). "
    "(4) If the report uses parent/child accounts (Truck > Original "
    "Cost), emit ONLY the child leaves with amounts."
)

_PL_SYSTEM = (
    "You extract structured account totals from a QuickBooks Online "
    "Profit & Loss (Income Statement) PDF. Return STRICT JSON with "
    "schema: "
    "{\"period_start\": \"YYYY-MM-DD\", \"period_end\": \"YYYY-MM-DD\", "
    "\"accounts\": [{\"name\": string, \"amount\": number, \"section\": "
    "\"revenue\"|\"cogs\"|\"expense\"}]}. "
    "Rules: (1) Only leaf accounts with actual dollar amounts; skip "
    "section header rows like 'Income' and roll-up subtotals like "
    "'Total Income', 'Gross Profit', 'Net Operating Income', 'Net "
    "Income'. (2) Negative values in parentheses are stored as negative "
    "numbers. (3) Preserve exact account names as displayed on the PDF. "
    "(4) If the report uses parent/child accounts, emit ONLY the child "
    "leaves with amounts. (5) Map QBO sections: 'Income' → revenue, "
    "'Cost of Goods Sold' → cogs, 'Expenses' / 'Other Expenses' → "
    "expense. If the PDF header shows a period like 'January 1 - "
    "December 31, 2024', use those as period_start/period_end."
)


def _pdf_to_text(raw: bytes) -> str:
    """Extract text from a PDF bytes buffer via pypdf."""
    reader = PdfReader(io.BytesIO(raw))
    return "\n\n".join((p.extract_text() or "") for p in reader.pages)


def _norm(s: str) -> str:
    """Normalize an account name for fuzzy matching between QBO's PDF
    label and our internal account name. Strip parenthetical suffixes
    like '(A/R)', collapse whitespace, lowercase."""
    s = re.sub(r"\s*\(.*?\)\s*", " ", s or "")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def _detect_report_type(text: str, override: str | None) -> str:
    """Decide whether the PDF is a Balance Sheet or a Profit & Loss.
    An explicit override wins; otherwise sniff the first ~2 KB for
    the QBO report header. Falls back to balance_sheet."""
    if override in ("balance_sheet", "profit_loss"):
        return override
    head = (text[:2000] or "").lower()
    if "profit and loss" in head or "income statement" in head \
            or "statement of income" in head:
        return "profit_loss"
    return "balance_sheet"


def _diff_rows(qbo_accounts: list[dict], our_by_norm: dict[str, dict]):
    """Shared per-account diff builder used by both BS and P&L paths.
    Returns (diff_rows, match_count)."""
    diff_rows: list[dict] = []
    matched_ours: set[str] = set()
    for qa in qbo_accounts:
        qname = qa.get("name") or ""
        qamt = float(qa.get("amount") or 0)
        n = _norm(qname)
        row = our_by_norm.get(n)
        if not row:
            for k, v in our_by_norm.items():
                if n in k or k in n:
                    row = v
                    break
        our_amt = float(row.get("amount", 0)) if row else 0.0
        if row:
            matched_ours.add(row["name"])
        delta = round(our_amt - qamt, 2)
        if abs(delta) < 0.01:
            status = "match"
        elif abs(delta) / max(abs(qamt), 1.0) < 0.05:
            status = "minor"  # < 5%
        else:
            status = "diff"
        diff_rows.append({
            "account_name": qname,
            "section": qa.get("section"),
            "qbo_amount": round(qamt, 2),
            "our_amount": round(our_amt, 2),
            "delta": delta,
            "status": status,
            "matched": row is not None,
        })
    # Anything on OUR side that QBO didn't list.
    for _n, row in our_by_norm.items():
        if row["name"] in matched_ours:
            continue
        if abs(float(row.get("amount", 0))) < 0.005:
            continue
        diff_rows.append({
            "account_name": row["name"],
            "section": row.get("section"),
            "qbo_amount": 0.0,
            "our_amount": round(float(row["amount"]), 2),
            "delta": round(float(row["amount"]), 2),
            "status": "our_only",
            "matched": False,
        })
    match_count = sum(1 for r in diff_rows if r["status"] == "match")
    return diff_rows, match_count


@router.post("/verify-migration")
async def verify_migration(
    company_id: str,
    file: UploadFile = File(..., description="QBO Balance Sheet or P&L PDF"),
    report_type: str | None = Form(
        None,
        description="Optional override: 'balance_sheet' or 'profit_loss'. "
                    "Auto-detected from PDF text when omitted."),
    user: dict = Depends(require_role("client", "pro", "partner",
                                        "enterprise_owner",
                                        "enterprise_pro", "superadmin")),
):
    """Parse the uploaded QBO PDF (BS or P&L), compute our own report
    for the same period, and return a side-by-side per-account diff."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDF upload required")
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "PDF too large — 5 MB max")

    try:
        text = _pdf_to_text(raw)
    except Exception as e:
        raise HTTPException(400, f"Could not read PDF: {e}")

    if len(text.strip()) < 100:
        raise HTTPException(422,
            "PDF looks empty or is image-only — please export directly "
            "from QBO (not a scan).")

    rtype = _detect_report_type(text, report_type)
    system = _PL_SYSTEM if rtype == "profit_loss" else _BS_SYSTEM

    chat = LlmChat(
        api_key="", session_id=f"qbo-verify-{company_id[:8]}",
        system_message=system,
        feature=f"qbo-verify-migration-{rtype}", company_id=company_id,
    ).with_model("anthropic", "claude-sonnet-4-5-20250929")
    prompt = (
        f"Extract the {'profit & loss' if rtype == 'profit_loss' else 'balance sheet'} "
        "from this QBO export. Return ONLY the JSON — no prose, no "
        "markdown fences.\n\n"
        f"{text[:18000]}"
    )
    resp = await chat.send_message(UserMessage(text=prompt))
    raw_text = resp if isinstance(resp, str) else str(resp)
    m = re.search(r"\{[\s\S]*\}", raw_text)
    if not m:
        raise HTTPException(502, "LLM could not extract structured data")
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        raise HTTPException(502, "LLM returned malformed JSON")

    qbo_accounts = parsed.get("accounts") or []

    if rtype == "profit_loss":
        period_start = parsed.get("period_start") or ""
        period_end = parsed.get("period_end") or date.today().isoformat()
        if not period_start:
            # Fall back to Jan-1-of-period_end year so the compute call
            # has a valid window even when the LLM missed the header.
            period_start = f"{period_end[:4]}-01-01"

        ours = await compute_income_statement(
            company_id, start=period_start, end=period_end,
            basis="accrual")

        our_by_norm: dict[str, dict] = {}
        for section_type, rows in (
            ("revenue", ours.get("revenue", [])),
            ("cogs", ours.get("cogs", [])),
            ("expense", ours.get("expenses", [])),
        ):
            for row in rows:
                if row.get("parent_code"):
                    continue
                our_by_norm[_norm(row.get("name", ""))] = {
                    **row, "section": section_type}

        diff_rows, match_count = _diff_rows(qbo_accounts, our_by_norm)
        total = len(diff_rows)
        qbo_totals = {
            "revenue": sum(float(a.get("amount") or 0) for a in qbo_accounts
                           if a.get("section") == "revenue"),
            "cogs": sum(float(a.get("amount") or 0) for a in qbo_accounts
                        if a.get("section") == "cogs"),
            "expense": sum(float(a.get("amount") or 0) for a in qbo_accounts
                           if a.get("section") == "expense"),
        }
        qbo_net_income = round(
            qbo_totals["revenue"] - qbo_totals["cogs"] - qbo_totals["expense"], 2)
        return {
            "report_type": "profit_loss",
            "period_start": period_start,
            "period_end": period_end,
            # Kept for backward compatibility with existing frontend
            # that only reads `as_of`.
            "as_of": f"{period_start} → {period_end}",
            "our_net_income": ours.get("net_income"),
            "qbo_net_income": qbo_net_income,
            "our_total_revenue": ours.get("total_revenue"),
            "qbo_total_revenue": round(qbo_totals["revenue"], 2),
            "match_count": match_count,
            "row_count": total,
            "match_pct": round(match_count / total * 100, 1) if total else 0.0,
            "rows": diff_rows,
        }

    # Balance Sheet path (default) ------------------------------------
    as_of = parsed.get("as_of") or date.today().isoformat()
    ours = await compute_balance_sheet(company_id, as_of=as_of,
                                          basis="accrual")

    our_by_norm = {}
    for row in (ours.get("assets", []) + ours.get("liabilities", [])
                + ours.get("equity", [])):
        if row.get("parent_id") or row.get("parent_code"):
            continue
        our_by_norm[_norm(row["name"])] = row

    diff_rows, match_count = _diff_rows(qbo_accounts, our_by_norm)
    total = len(diff_rows)
    return {
        "report_type": "balance_sheet",
        "as_of": as_of,
        "our_total_assets": ours.get("total_assets"),
        "qbo_total_assets": sum(
            float(a.get("amount") or 0) for a in qbo_accounts
            if a.get("section") == "asset"),
        "our_balanced": ours.get("balanced"),
        "match_count": match_count,
        "row_count": total,
        "match_pct": round(match_count / total * 100, 1) if total else 0.0,
        "rows": diff_rows,
    }
