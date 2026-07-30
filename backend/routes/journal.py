"""Axiom Ledger — Journal Entries routes.

Auto-extracted from server.py during the Feb 2026 modularization refactor.
Behaviour is intentionally identical to the pre-split codebase.
"""
from __future__ import annotations
import os
import re
import uuid
import json
import random
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, EmailStr, Field

from db import db, now_iso, coerce
from auth import (
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
from ai_service import (
    categorize_transaction, chat_stream, suggest_chart_of_accounts,
    onboarding_interview_questions, onboarding_interview_synthesize,
    parse_voice_intent,
)
import reports as R
import plaid_service
import plaid_connect
import veryfi_service
import merchant_cache
import contact_resolver
from infra import get_cache

from models import (
    LoginIn, SignupIn, CompanyCreate, TransactionUpdate, TransactionCreate,
    SplitIn, RuleCreate, InvoiceCreate, BillCreate, ContactCreate,
    AccountCreate, JECreate, ChatIn, OnboardingUpdate, PaymentCreate,
    ReceiptCreate, GenericCreate, NewClientIn,
)
from deps import (
    DASH_CACHE_TTL,
    company_ids_for_user, require_company, log_ai,
    is_period_closed, assert_open,
    categorize_and_insert, sync_and_import,
)

router = APIRouter(prefix="/api")


# ----------------------- Journal Entries -----------------------

@router.get("/companies/{cid}/journal-entries")
async def list_jes(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.journal_entries.find({"company_id": cid}).sort("date", -1).to_list(2000)
    return {"entries": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/journal-entries")
async def create_je(cid: str, inp: JECreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await assert_open(cid, inp.date)
    total_d = sum(float(l.get("debit", 0)) for l in inp.lines)
    total_c = sum(float(l.get("credit", 0)) for l in inp.lines)
    if abs(total_d - total_c) > 0.01:
        raise HTTPException(400, f"Debits ({total_d}) must equal credits ({total_c})")
    jid = str(uuid.uuid4()); now = now_iso()
    await db.journal_entries.insert_one({
        "id": jid, "company_id": cid, "date": inp.date, "memo": inp.memo,
        "lines": inp.lines, "total_debit": round(total_d, 2), "total_credit": round(total_c, 2),
        "created_by": user["id"], "created_at": now, "updated_at": now,
    })
    return {"id": jid}


@router.delete("/companies/{cid}/journal-entries/{jid}")
async def delete_je(cid: str, jid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    existing = await db.journal_entries.find_one({"id": jid, "company_id": cid})
    if existing:
        await assert_open(cid, existing.get("date"))
    await db.journal_entries.delete_one({"id": jid, "company_id": cid})
    return {"ok": True}





# --------------------------------------------------------------------------
# General Ledger Import — Excel / CSV / PDF → journal_entries
#
# The GL comes flat: one row per debit/credit LINE with a shared
# date + reference/memo per journal entry. We group by
# (date, reference_or_memo), validate debit == credit per JE, and
# insert. Every batch writes a rollback log so a bad import can be
# one-click undone.
# --------------------------------------------------------------------------

_GL_HEADER_ALIASES = {
    "date":         ["date", "posting date", "transaction date",
                     "entry date", "tx date", "trans date"],
    "reference":    ["reference", "ref", "ref#", "ref #", "entry",
                     "entry number", "je#", "je #", "journal",
                     "journal id", "journal number", "voucher", "doc"],
    "memo":         ["memo", "description", "narration", "notes",
                     "narrative", "particulars", "explanation"],
    "account_code": ["account", "account code", "account number",
                     "acct", "acct #", "acct#", "gl code", "gl account"],
    "account_name": ["account name", "gl name", "ledger account name"],
    "debit":        ["debit", "dr", "debits", "debit amount"],
    "credit":       ["credit", "cr", "credits", "credit amount"],
    "amount":       ["amount", "value", "signed amount"],
}


def _gl_canonical_header(h: str) -> Optional[str]:
    if not h:
        return None
    key = str(h).strip().lower()
    for canonical, aliases in _GL_HEADER_ALIASES.items():
        if key in aliases:
            return canonical
    return None


def _parse_money(raw: str) -> float:
    """Turn '$1,234.56', '(500.00)', '  '  or '-42' into a float."""
    if raw is None:
        return 0.0
    s = str(raw).strip()
    if not s or s in ("-", "–", "—"):
        return 0.0
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1]
    s = s.replace(",", "").replace("$", "").strip()
    try:
        v = float(s)
    except ValueError:
        return 0.0
    return -v if negative else v


def _normalize_date(raw: str) -> Optional[str]:
    """Coerce ``5/12/2024`` / ``2024-05-12`` / Excel serial → ISO date."""
    if not raw:
        return None
    s = str(raw).strip()
    # ISO already?
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    # Excel serial (days since 1899-12-30)?
    if re.match(r"^\d{4,6}(\.\d+)?$", s):
        try:
            from datetime import date, timedelta as _td
            base = date(1899, 12, 30)
            return (base + _td(days=int(float(s)))).isoformat()
        except Exception:
            pass
    # US-style MM/DD/YYYY or DD/MM/YYYY — assume MM/DD (US convention).
    for fmt in ("%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%d %b %Y", "%b %d, %Y",
                "%Y/%m/%d", "%m.%d.%Y"):
        try:
            return datetime.strptime(s.split(" ")[0], fmt).date().isoformat()
        except ValueError:
            continue
    return None


@router.post("/companies/{cid}/journal-entries/import/preview")
async def gl_import_preview(
    cid: str,
    file: UploadFile = File(...),
    ai: str = Form("false"),
    user: dict = Depends(get_current_user),
):
    """Parse a GL spreadsheet / PDF, group lines into journal entries by
    (date, reference or memo), resolve accounts by code or name against
    the company's CoA, and return a preview with per-JE balance check.

    Returns::

        {
            "source", "filename", "detected_headers",
            "row_count_raw", "row_count_after_group",
            "entries": [{
                "key", "date", "memo", "reference",
                "balanced", "debit_total", "credit_total",
                "unresolved_accounts", "lines": [{...}]
            }]
        }
    """
    await require_company(user, cid)
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "File too large. Max 15 MB.")
    from routes import contacts as _c
    fname = (file.filename or "").lower()
    use_ai = (str(ai).lower() == "true") and fname.endswith(".pdf")
    if use_ai:
        headers, rows = await _c._ai_parse_pdf(data)
        parsed = {"headers": headers, "rows": rows, "source": "pdf-ai"}
    else:
        parsed = _c._parse_upload(file.filename or "", data)

    # Column resolution.
    resolved: dict[int, str] = {}
    for i, h in enumerate(parsed["headers"]):
        canonical = _gl_canonical_header(h)
        if canonical and canonical not in resolved.values():
            resolved[i] = canonical
    by_field = {v: k for k, v in resolved.items()}

    def _cell(row, field):
        i = by_field.get(field)
        return row[i].strip() if i is not None and i < len(row) and row[i] else ""

    # Preload the company's CoA for account resolution.
    accts = await db.accounts.find(
        {"company_id": cid}, {"id": 1, "code": 1, "name": 1, "_id": 0},
    ).to_list(3000)
    by_code = {str(a.get("code") or "").strip(): a for a in accts if a.get("code")}
    by_name = {str(a.get("name") or "").strip().lower(): a for a in accts}

    # Group lines into JEs.
    entries: dict[str, dict] = {}
    order: list[str] = []
    for r in parsed["rows"]:
        date_str = _normalize_date(_cell(r, "date"))
        if not date_str:
            continue
        reference = _cell(r, "reference")
        memo = _cell(r, "memo")
        key = f"{date_str}::{reference or memo}"
        if key not in entries:
            entries[key] = {
                "key": key, "date": date_str, "reference": reference,
                "memo": memo, "lines": [],
            }
            order.append(key)
        # Resolve amount — prefer explicit debit/credit columns, fall
        # back to signed amount.
        if "debit" in by_field or "credit" in by_field:
            debit = _parse_money(_cell(r, "debit"))
            credit = _parse_money(_cell(r, "credit"))
        else:
            amt = _parse_money(_cell(r, "amount"))
            debit = amt if amt > 0 else 0.0
            credit = -amt if amt < 0 else 0.0
        if abs(debit) < 0.005 and abs(credit) < 0.005:
            continue
        acct_code = _cell(r, "account_code")
        acct_name = _cell(r, "account_name")
        match = None
        if acct_code and acct_code in by_code:
            match = by_code[acct_code]
        elif acct_name:
            match = by_name.get(acct_name.lower())
        entries[key]["lines"].append({
            "account_code": acct_code,
            "account_name": acct_name or (match.get("name") if match else ""),
            "account_id": match["id"] if match else None,
            "debit": round(debit, 2),
            "credit": round(credit, 2),
            "description": memo,
        })

    # Compute balance + resolution status per JE.
    out_entries: list[dict] = []
    for key in order:
        e = entries[key]
        total_d = round(sum(l["debit"] for l in e["lines"]), 2)
        total_c = round(sum(l["credit"] for l in e["lines"]), 2)
        e["debit_total"] = total_d
        e["credit_total"] = total_c
        e["balanced"] = abs(total_d - total_c) < 0.01
        e["unresolved_accounts"] = any(l["account_id"] is None for l in e["lines"])
        if e["lines"]:
            out_entries.append(e)

    return {
        "source": parsed["source"],
        "filename": file.filename,
        "detected_headers": parsed["headers"],
        "row_count_raw": len(parsed["rows"]),
        "row_count_after_group": len(out_entries),
        "entries": out_entries,
        "summary": {
            "balanced": sum(1 for e in out_entries if e["balanced"]),
            "unbalanced": sum(1 for e in out_entries if not e["balanced"]),
            "unresolved": sum(1 for e in out_entries if e["unresolved_accounts"]),
        },
    }


class GLImportCommitIn(BaseModel):
    entries: list[dict]
    filename: Optional[str] = None
    source: Optional[str] = None


@router.post("/companies/{cid}/journal-entries/import/commit")
async def gl_import_commit(
    cid: str, inp: GLImportCommitIn,
    user: dict = Depends(get_current_user),
):
    """Insert every balanced JE in the payload. Skips unbalanced entries
    and entries with any unresolved account (the UI shouldn't let the
    CPA commit them anyway, but we double-guard here). Writes a batch
    log for one-click undo."""
    await require_company(user, cid)
    now = now_iso()
    created_ids: list[str] = []
    skipped: list[dict] = []
    for e in inp.entries:
        lines = e.get("lines") or []
        if not lines:
            skipped.append({"reason": "no lines", "date": e.get("date")}); continue
        # Guard rails — never let a bad row into the DB.
        if any(not l.get("account_id") for l in lines):
            skipped.append({"reason": "unresolved account", "date": e.get("date")}); continue
        d = round(sum(float(l.get("debit") or 0) for l in lines), 2)
        c = round(sum(float(l.get("credit") or 0) for l in lines), 2)
        if abs(d - c) > 0.01:
            skipped.append({"reason": "unbalanced", "date": e.get("date")}); continue
        try:
            await assert_open(cid, e.get("date"))
        except HTTPException:
            skipped.append({"reason": "period closed", "date": e.get("date")}); continue
        jid = str(uuid.uuid4())
        await db.journal_entries.insert_one({
            "id": jid, "company_id": cid,
            "date": e.get("date"),
            "memo": (e.get("memo") or "").strip() or (e.get("reference") or ""),
            "reference": (e.get("reference") or "").strip(),
            "lines": [{
                "account_id": l["account_id"],
                "debit": round(float(l.get("debit") or 0), 2),
                "credit": round(float(l.get("credit") or 0), 2),
                "description": (l.get("description") or "").strip(),
            } for l in lines],
            "total_debit": d, "total_credit": c,
            "source": "gl_import",
            "created_by": user["id"],
            "created_at": now, "updated_at": now,
        })
        created_ids.append(jid)
    log_id: Optional[str] = None
    if created_ids:
        log_id = str(uuid.uuid4())
        await db.gl_imports.insert_one({
            "id": log_id, "company_id": cid, "user_id": user.get("id"),
            "at": now, "filename": inp.filename or "(unknown)",
            "source": inp.source or "",
            "created_je_ids": created_ids,
            "created_count": len(created_ids),
            "skipped_count": len(skipped),
            "skipped": skipped[:50],
            "undone": False,
        })
    return {"ok": True, "created": len(created_ids),
            "skipped": len(skipped), "skipped_details": skipped[:20],
            "batch_id": log_id}


@router.get("/companies/{cid}/journal-entries/imports")
async def gl_import_history(
    cid: str, limit: int = 20,
    user: dict = Depends(get_current_user),
):
    """List recent GL import batches (newest first)."""
    await require_company(user, cid)
    docs = await db.gl_imports.find(
        {"company_id": cid}, {"_id": 0, "created_je_ids": 0, "skipped": 0},
    ).sort("at", -1).to_list(min(limit, 100))
    user_ids = list({d.get("user_id") for d in docs if d.get("user_id")})
    name_map: dict[str, str] = {}
    if user_ids:
        for u in await db.users.find(
            {"id": {"$in": user_ids}}, {"id": 1, "name": 1, "email": 1, "_id": 0},
        ).to_list(len(user_ids)):
            name_map[u["id"]] = u.get("name") or u.get("email") or "—"
    for d in docs:
        d["user_name"] = name_map.get(d.get("user_id"), "—")
    return {"batches": docs}


@router.post("/companies/{cid}/journal-entries/imports/{batch_id}/undo")
async def gl_import_undo(
    cid: str, batch_id: str,
    user: dict = Depends(get_current_user),
):
    """Delete every journal entry created by this import batch. Blocks
    the delete leg if any JE falls in a closed period so the CPA has
    to reopen the period first — matches how manual JE deletes behave."""
    await require_company(user, cid)
    batch = await db.gl_imports.find_one({"id": batch_id, "company_id": cid})
    if not batch:
        raise HTTPException(404, "Import batch not found")
    if batch.get("undone"):
        return {"ok": True, "already_undone": True, "deleted": 0}
    ids = batch.get("created_je_ids") or []
    if not ids:
        return {"ok": True, "deleted": 0}
    # Assert all JEs are in open periods before deleting any.
    jes = await db.journal_entries.find(
        {"id": {"$in": ids}, "company_id": cid}, {"date": 1, "_id": 0},
    ).to_list(len(ids))
    for je in jes:
        try:
            await assert_open(cid, je.get("date"))
        except HTTPException as e:
            raise HTTPException(400, f"One or more entries fall in a closed period: {e.detail}") from e
    r = await db.journal_entries.delete_many({"id": {"$in": ids}, "company_id": cid})
    await db.gl_imports.update_one(
        {"id": batch_id, "company_id": cid},
        {"$set": {"undone": True, "undone_at": now_iso(), "undone_by": user.get("id")}},
    )
    return {"ok": True, "deleted": r.deleted_count}
