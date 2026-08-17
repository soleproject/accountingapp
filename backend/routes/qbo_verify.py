"""QBO migration verification — upload the QBO Balance Sheet PDF, we
extract each account+amount with an LLM, then diff against what our
computed BS reports. Read-only in v1 — the diff table is for CPA
review, no auto-post.

Feb 26 2026. Sits alongside the migration screen so a customer can
prove their migrated books tie to QBO's own report before trusting
the numbers.
"""
from __future__ import annotations

import base64
import json
import re
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pypdf import PdfReader
import io

from auth import require_role
from db import db
from llm_client import LlmChat, UserMessage
from reports import compute_balance_sheet

router = APIRouter(prefix="/api/companies/{company_id}/qbo", tags=["qbo"])

_EXTRACT_SYSTEM = (
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


@router.post("/verify-migration")
async def verify_migration(
    company_id: str,
    file: UploadFile = File(..., description="QBO Balance Sheet PDF"),
    user: dict = Depends(require_role("client", "pro", "partner",
                                        "enterprise_owner",
                                        "enterprise_pro", "superadmin")),
):
    """Parse the uploaded QBO Balance Sheet PDF, compute our own BS
    for the same as-of date, and return a side-by-side diff."""
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

    # Ask the LLM to structure the PDF text.
    chat = LlmChat(
        api_key="", session_id=f"qbo-verify-{company_id[:8]}",
        system_message=_EXTRACT_SYSTEM,
        feature="qbo-verify-migration", company_id=company_id,
    ).with_model("anthropic", "claude-sonnet-4-5-20250929")
    prompt = (
        "Extract the balance sheet from this QBO export. "
        "Return ONLY the JSON — no prose, no markdown fences.\n\n"
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

    as_of = parsed.get("as_of") or date.today().isoformat()
    qbo_accounts = parsed.get("accounts") or []

    # Compute our own BS for the same as-of.
    ours = await compute_balance_sheet(company_id, as_of=as_of,
                                          basis="accrual")

    # Build a lookup of our top-level (non-child) account rows.
    our_by_norm: dict[str, dict] = {}
    for row in (ours.get("assets", []) + ours.get("liabilities", [])
                + ours.get("equity", [])):
        if row.get("parent_id") or row.get("parent_code"):
            continue  # skip child rows already rolled into parents
        our_by_norm[_norm(row["name"])] = row

    # Diff each QBO row against ours.
    diff_rows: list[dict] = []
    matched_ours = set()
    for qa in qbo_accounts:
        qname = qa.get("name") or ""
        qamt = float(qa.get("amount") or 0)
        n = _norm(qname)
        # Try exact match, then substring both ways.
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
    for name, row in our_by_norm.items():
        if row["name"] in matched_ours:
            continue
        if abs(float(row.get("amount", 0))) < 0.005:
            continue
        diff_rows.append({
            "account_name": row["name"],
            "section": None,
            "qbo_amount": 0.0,
            "our_amount": round(float(row["amount"]), 2),
            "delta": round(float(row["amount"]), 2),
            "status": "our_only",
            "matched": False,
        })

    match_count = sum(1 for r in diff_rows if r["status"] == "match")
    total = len(diff_rows)
    return {
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
