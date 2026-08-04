"""Axiom Ledger — Contacts routes.

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
from pymongo.errors import DuplicateKeyError

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


# ----------------------- Contacts -----------------------

@router.get("/companies/{cid}/contacts")
async def list_contacts(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)

    # Cache the enriched response briefly. For 3k concurrent users each
    # refreshing every ~30 s, this drops the aggregation load on Mongo by
    # ~40x while staying fresh enough for a UI list. The cache is
    # invalidated in all contact-mutating endpoints AND by sync completion
    # (see sync_tasks._mark_done → get_cache().ainvalidate).
    cache = get_cache()
    ckey = cache.key("contacts_list", company_id=cid)

    async def _compute() -> dict:
        docs = await db.contacts.find({"company_id": cid}).sort("name", 1).to_list(2000)
        ytd_start = f"{datetime.now(timezone.utc).year}-01-01"
        pipeline = [
            {"$match": {"company_id": cid, "contact_id": {"$nin": [None, ""]}}},
            {"$group": {
                "_id": "$contact_id",
                "hits": {"$sum": 1},
                "last_seen": {"$max": "$date"},
                "ytd_in": {"$sum": {"$cond": [
                    {"$and": [{"$gt": ["$amount", 0]},
                              {"$gte": ["$date", ytd_start]}]},
                    "$amount", 0]}},
                "ytd_out_neg": {"$sum": {"$cond": [
                    {"$and": [{"$lt": ["$amount", 0]},
                              {"$gte": ["$date", ytd_start]}]},
                    "$amount", 0]}},
            }},
        ]
        stats: dict[str, dict] = {}
        async for row in db.transactions.aggregate(pipeline):
            ytd_in = round(row.get("ytd_in") or 0.0, 2)
            ytd_out = round(-(row.get("ytd_out_neg") or 0.0), 2)
            stats[row["_id"]] = {
                "hits": row.get("hits") or 0,
                "last_seen": row.get("last_seen"),
                "ytd_in": ytd_in,
                "ytd_out": ytd_out,
                "net": round(ytd_in - ytd_out, 2),
            }
        out = []
        empty = {"hits": 0, "last_seen": None, "ytd_in": 0.0,
                 "ytd_out": 0.0, "net": 0.0}
        for d in docs:
            c = coerce(d)
            s = stats.get(c["id"], empty)
            c["hits"] = s["hits"]
            c["last_seen"] = s["last_seen"]
            c["ytd_in"] = s["ytd_in"]
            c["ytd_out"] = s["ytd_out"]
            c["net"] = s["net"]
            # Back-compat alias: older UI referenced `txn_count`.
            c["txn_count"] = s["hits"]
            out.append(c)
        return {"contacts": out}

    return await cache.get_or_compute(ckey, ttl=45, compute=_compute)


@router.post("/companies/{cid}/contacts")
async def create_contact(cid: str, inp: ContactCreate, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    xid = str(uuid.uuid4()); now = now_iso()
    payload = inp.model_dump()
    # The `contacts` collection has a unique index on (company_id, normalized_name).
    # Without this key set, every second manual contact creation in a given
    # company would fail with a duplicate-null-key error.
    from contact_resolver import normalize_contact_name  # local import to avoid cycle
    key = normalize_contact_name(payload.get("name"))
    payload["normalized_name"] = key
    # Race-safe upsert: two clients POSTing the same contact name simultaneously
    # previously produced a 500 (E11000 duplicate key). Now we catch that
    # collision, look up the existing doc, and return it — the caller sees
    # the same shape and their intent ("give me a contact by this name") is
    # honoured. This also handles the "click Create twice" UX pattern.
    try:
        await db.contacts.insert_one({
            "id": xid, "company_id": cid, **payload,
            "created_at": now, "updated_at": now,
        })
    except DuplicateKeyError:
        existing = await db.contacts.find_one({"company_id": cid, "normalized_name": key})
        if existing:
            xid = existing.get("id") or xid
        else:
            # Extremely unlikely — unique key fired but no doc matches. Re-raise.
            raise
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"id": xid}


@router.patch("/companies/{cid}/contacts/{xid}")
async def update_contact(cid: str, xid: str, payload: dict, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    payload["updated_at"] = now_iso()
    await db.contacts.update_one({"id": xid, "company_id": cid}, {"$set": payload})
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@router.delete("/companies/{cid}/contacts/{xid}")
async def delete_contact(cid: str, xid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.contacts.delete_one({"id": xid, "company_id": cid})
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@router.post("/companies/{cid}/contacts/merge")
async def merge_contacts(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Merge one or more "loser" contacts into a single "keeper".

    Body: {"keeper_id": str, "loser_ids": [str, ...]}

    - Reassigns contact_id + contact_name on every collection that references
      contacts (transactions, invoices, bills, payments, receipts,
      contact_learning_cache) from losers → keeper.
    - Deletes the loser contact rows.
    - Invalidates the report cache so dashboards refresh immediately.
    """
    await require_company(user, cid)
    keeper_id = payload.get("keeper_id")
    loser_ids = [x for x in (payload.get("loser_ids") or []) if x and x != keeper_id]
    if not keeper_id or not loser_ids:
        raise HTTPException(400, "keeper_id and non-empty loser_ids required")

    keeper = await db.contacts.find_one({"id": keeper_id, "company_id": cid})
    if not keeper:
        raise HTTPException(404, "Keeper contact not found in this company")
    loser_docs = await db.contacts.find(
        {"id": {"$in": loser_ids}, "company_id": cid}
    ).to_list(1000)
    if len(loser_docs) != len(loser_ids):
        raise HTTPException(404, "One or more loser contacts not found in this company")

    keeper_name = keeper.get("name")
    reassignment = {"$set": {"contact_id": keeper_id, "contact_name": keeper_name,
                             "updated_at": now_iso()}}
    match = {"company_id": cid, "contact_id": {"$in": loser_ids}}

    results = {}
    for coll_name in ("transactions", "invoices", "bills", "payments", "receipts"):
        r = await db[coll_name].update_many(match, reassignment)
        results[coll_name] = r.modified_count

    # Learning cache stores contact_id without contact_name; migrate too so
    # future AI resolves land on the keeper.
    lc = await db.contact_learning_cache.update_many(
        {"company_id": cid, "contact_id": {"$in": loser_ids}},
        {"$set": {"contact_id": keeper_id, "contact_name": keeper_name}},
    )
    results["contact_learning_cache"] = lc.modified_count

    deleted = await db.contacts.delete_many(
        {"id": {"$in": loser_ids}, "company_id": cid}
    )

    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "keeper_id": keeper_id,
        "keeper_name": keeper_name,
        "merged_contacts": deleted.deleted_count,
        "reassigned": results,
    }




# Curated merchant → domain map used by the logo backfill endpoint. Match is
# case-insensitive substring on the contact name so "AT&T Wireless" hits
# "AT&T". Keep this list short and high-signal — real production would pull
# from Plaid `counterparties[].logo_url` on sync + Veryfi `vendor.logo` on
# OCR. This dict is the demo/prod backfill fallback.
LOGO_BACKFILL_DOMAINS = {
    "starbucks": "starbucks.com",
    "uber": "uber.com",
    "delta": "delta.com",
    "aws": "aws.amazon.com",
    "amazon": "amazon.com",
    "google workspace": "workspace.google.com",
    "google ads": "ads.google.com",
    "adobe": "adobe.com",
    "wework": "wework.com",
    "comcast": "comcast.com",
    "at&t": "att.com",
    "state farm": "statefarm.com",
    "staples": "staples.com",
    "home depot": "homedepot.com",
    "costco": "costco.com",
    "sysco": "sysco.com",
    "peet's coffee": "peets.com",
    "facebook ads": "facebook.com",
    "meta ads": "facebook.com",
    "linkedin": "linkedin.com",
    "lincare": "lincare.com",
    "new york life": "newyorklife.com",
    "mcdonald": "mcdonalds.com",
    "olive garden": "olivegarden.com",
    "venmo": "venmo.com",
    "zelle": "zellepay.com",
    "cash app": "cash.app",
    "shopify": "shopify.com",
    "stripe": "stripe.com",
    "paypal": "paypal.com",
    "spotify": "spotify.com",
    "netflix": "netflix.com",
    "microsoft": "microsoft.com",
    "notion": "notion.so",
    "slack": "slack.com",
    "zoom": "zoom.us",
    "twilio": "twilio.com",
    "docusign": "docusign.com",
    "quickbooks": "quickbooks.intuit.com",
    "gusto": "gusto.com",
    "adp": "adp.com",
    "bank of america": "bankofamerica.com",
    "chase": "chase.com",
    "wells fargo": "wellsfargo.com",
    "citi": "citi.com",
    "capital one": "capitalone.com",
}


def _domain_for_contact(name: str | None) -> str | None:
    if not name:
        return None
    n = name.lower()
    # Longest match first so "Google Workspace" beats "Google Ads" for a row
    # named "Google Workspace India".
    for key in sorted(LOGO_BACKFILL_DOMAINS.keys(), key=len, reverse=True):
        if key in n:
            return LOGO_BACKFILL_DOMAINS[key]
    return None


@router.post("/companies/{cid}/contacts/backfill-logos")
async def backfill_contact_logos(cid: str, user: dict = Depends(get_current_user)):
    """Populate `logo_url` on every contact for this company that doesn't
    already have one, using a curated merchant → domain map + Clearbit's
    free logo endpoint (`logo.clearbit.com/{domain}`). Idempotent: contacts
    with an existing `logo_url` are left alone.

    In production we get logos automatically from Plaid's
    `counterparties[].logo_url` on transactions/sync and from Veryfi's
    `vendor.logo` on receipts — this endpoint fills the gap for
    contacts created before the resolver was updated, and for demo /
    mocked-integration environments.
    """
    await require_company(user, cid)
    updated = []
    async for c in db.contacts.find({
        "company_id": cid,
        "$or": [{"logo_url": {"$exists": False}}, {"logo_url": None}, {"logo_url": ""}],
    }):
        domain = _domain_for_contact(c.get("name"))
        if not domain:
            continue
        logo_url = f"https://logo.clearbit.com/{domain}"
        await db.contacts.update_one(
            {"id": c["id"]},
            {"$set": {"logo_url": logo_url, "updated_at": now_iso()}},
        )
        updated.append({"name": c.get("name"), "logo_url": logo_url})
    return {"ok": True, "updated": len(updated), "contacts": updated}



class BulkTypeIn(BaseModel):
    ids: list[str]
    type: str  # "customer" | "vendor"


@router.post("/companies/{cid}/contacts/bulk-set-type")
async def bulk_set_contact_type(
    cid: str,
    inp: BulkTypeIn,
    user: dict = Depends(get_current_user),
):
    """Change the ``type`` on every contact whose id is in ``ids`` to
    ``customer`` or ``vendor``. Used by the Contacts list bulk-action
    bar to fix a wrong default-type import in one shot. Returns the
    number of docs actually flipped so the UI can toast accurately."""
    await require_company(user, cid)
    if inp.type not in ("customer", "vendor"):
        raise HTTPException(400, "type must be 'customer' or 'vendor'")
    if not inp.ids:
        return {"ok": True, "modified": 0}
    r = await db.contacts.update_many(
        {"id": {"$in": inp.ids}, "company_id": cid, "type": {"$ne": inp.type}},
        {"$set": {"type": inp.type, "updated_at": now_iso()}},
    )
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "modified": r.modified_count, "new_type": inp.type}



# --------------------------------------------------------------------------
# Contacts Import — Excel / CSV / PDF → contact rows
#
# Two-step flow so the CPA can proofread before writes hit the DB:
#   1. POST /contacts/import/preview  → parse the upload, return rows +
#      auto-detected column mapping. No DB writes.
#   2. POST /contacts/import/commit   → user confirms the mapping and
#      the (possibly edited) rows, we insert.
#
# Deduplication: the collection already has a unique index on
# (company_id, normalized_name), so re-imports are idempotent — we
# UPSERT by normalized_name and count matches as "updated".
# --------------------------------------------------------------------------
import io
import csv as _csv


# Header aliases → canonical fields. Kept generous so QBO/Xero/Excel
# exports auto-map without the user having to touch anything.
_HEADER_ALIASES = {
    "name":    ["name", "contact", "contact name", "customer name",
                "vendor name", "supplier name",
                "company", "company name", "display name", "full name",
                "client name", "payee"],
    "email":   ["email", "email address", "e-mail", "mail"],
    "phone":   ["phone", "phone number", "phone #", "tel", "telephone",
                "mobile", "cell", "cell phone"],
    "address": ["address", "billing address", "street", "street address",
                "location", "shipping address", "full address"],
    "type":    ["type", "contact type", "kind", "role"],
}


def _canonical_header(h: str) -> Optional[str]:
    if not h:
        return None
    key = str(h).strip().lower()
    for canonical, aliases in _HEADER_ALIASES.items():
        if key in aliases:
            return canonical
    return None


def _guess_type(row_type: Optional[str], default_type: str) -> str:
    """Normalize whatever the user's spreadsheet used into
    ``customer`` / ``vendor``. Anything unrecognized falls back to
    the caller's default_type."""
    t = (row_type or "").strip().lower()
    if t in ("customer", "client", "buyer", "member"):
        return "customer"
    if t in ("vendor", "supplier", "payee", "contractor"):
        return "vendor"
    return default_type


_EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")
_PHONE_RE = re.compile(r"(\+?\d[\d\s\-().]{7,}\d)")


def _parse_excel(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Read the first sheet of an .xlsx file. Returns (headers, rows)."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.active
    headers: list[str] = []
    rows: list[list[str]] = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        cells = ["" if c is None else str(c).strip() for c in row]
        if i == 0:
            headers = cells
            continue
        if any(c for c in cells):
            rows.append(cells)
    return headers, rows


def _parse_csv(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Read a CSV file with either \\n or \\r\\n line endings. Assumes
    utf-8 with a lenient fallback so imports from Excel exports don't
    choke on a stray latin-1 character."""
    text = data.decode("utf-8", errors="replace")
    reader = _csv.reader(io.StringIO(text))
    all_rows = [r for r in reader]
    if not all_rows:
        return [], []
    headers = [h.strip() for h in all_rows[0]]
    body = [[c.strip() for c in r] for r in all_rows[1:] if any(c.strip() for c in r)]
    return headers, body


def _parse_pdf(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Best-effort PDF extraction with two strategies:

    **Table mode** — when the top of the extracted text is a run of
    lines matching known column names (Type / Name / Email / Phone /
    Address, etc.), we treat those N lines as headers and chunk the
    remaining lines into groups of N — each group is one row. This is
    how pypdf flattens standard PDF tables (cell-by-cell in reading
    order), so this covers exports from Excel/Google Sheets/Word.

    **Fallback mode** — no clear header run, so scan each line with
    regex for emails and phone numbers, and treat the leftover text as
    the name. Works for unstructured directories.
    """
    import pypdf
    reader = pypdf.PdfReader(io.BytesIO(data))
    all_text = []
    for page in reader.pages:
        try:
            all_text.append(page.extract_text() or "")
        except Exception:
            continue
    text = "\n".join(all_text)

    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    if not lines:
        return [], []

    # ---- Table-mode detection ----
    # Walk from the top skipping title-y lines that don't look like
    # column headers ("Test Contacts Import File", page numbers) until
    # we hit the first line that IS a known header alias. Then keep
    # collecting consecutive header-ish lines until we hit a data line.
    header_start = None
    for i, ln in enumerate(lines):
        if _canonical_header(ln):
            header_start = i
            break
    if header_start is not None:
        headers_raw: list[str] = []
        seen_canonical: set[str] = set()
        j = header_start
        while j < len(lines):
            canon = _canonical_header(lines[j])
            if not canon or canon in seen_canonical:
                break
            headers_raw.append(lines[j])
            seen_canonical.add(canon)
            j += 1
        n = len(headers_raw)
        # Need at least a name column, and headers must not swallow the
        # entire file (defensive against small hand-written docs).
        if n >= 2 and (len(lines) - j) >= n:
            body = lines[j:]
            rows: list[list[str]] = []
            for k in range(0, len(body) - n + 1, n):
                chunk = body[k:k + n]
                if len(chunk) == n:
                    rows.append(chunk)
            if rows:
                return headers_raw, rows

    # ---- Fallback: regex per line ----
    rows: list[list[str]] = []
    for line in lines:
        if len(line) < 3 or re.match(r"^page\s+\d+", line.lower()):
            continue
        email_m = _EMAIL_RE.search(line)
        phone_m = _PHONE_RE.search(line)
        name_part = line
        if email_m: name_part = name_part.replace(email_m.group(0), "")
        if phone_m: name_part = name_part.replace(phone_m.group(0), "")
        name_part = re.sub(r"[|,;]{1,}", " ", name_part)
        name_part = re.sub(r"\s{2,}", " ", name_part).strip(" -")
        if not name_part or len(name_part) < 2:
            continue
        if len(name_part.split()) == 1 and name_part.islower():
            continue
        rows.append([
            name_part,
            email_m.group(0) if email_m else "",
            phone_m.group(0) if phone_m else "",
        ])
    return ["name", "email", "phone"], rows


def _parse_upload(filename: str, data: bytes) -> dict:
    """Route the file to the right parser based on extension. Returns
    a structured dict of parsed rows keyed by canonical field."""
    fname = (filename or "").lower()
    if fname.endswith((".xlsx", ".xls", ".xlsm")):
        headers, rows = _parse_excel(data)
        source = "excel"
    elif fname.endswith(".csv") or fname.endswith(".txt"):
        headers, rows = _parse_csv(data)
        source = "csv"
    elif fname.endswith(".pdf"):
        headers, rows = _parse_pdf(data)
        source = "pdf"
    else:
        raise HTTPException(400,
            "Unsupported file type. Upload .xlsx, .csv, or .pdf.")
    return {"headers": headers, "rows": rows, "source": source}


async def _ai_parse_pdf(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Fallback for PDFs the deterministic parser can't structure —
    scanned tables, multi-column vendor lists, unstructured
    directories. Runs the extracted text through the same LLM the
    categorizer uses and asks for a strict JSON array of contact
    dicts. Returns (headers, rows) matching the deterministic
    parser's shape so downstream code doesn't need to branch.

    Bounded to 12 KB of PDF text and 200 rows to keep token cost
    predictable — any larger and the deterministic parser is a better
    fit anyway."""
    import pypdf
    reader = pypdf.PdfReader(io.BytesIO(data))
    text_parts = []
    for page in reader.pages:
        try:
            text_parts.append(page.extract_text() or "")
        except Exception:
            continue
    text = "\n".join(text_parts).strip()
    if not text:
        return [], []
    # Cap the input so a 200-page PDF doesn't blow the token budget.
    text = text[:12000]

    from llm_client import LlmChat, UserMessage
    system = (
        "You are a data extraction assistant. Given raw text pulled from a PDF "
        "of contacts (customers, vendors, or a directory), return a strict JSON "
        "object with a single key `contacts` whose value is an array of objects. "
        "Each object has these fields (empty string if unknown): "
        "`name` (required), `email`, `phone`, `address`, `type` (either "
        "`customer` or `vendor` — infer from context, default to `customer`). "
        "Return ONLY the JSON, no prose, no code fences. Skip page headers, "
        "footers, and column labels. Merge multi-line addresses into one field."
    )
    session_id = f"pdf-import-{uuid.uuid4().hex[:8]}"
    chat = LlmChat(
        api_key="",
        session_id=session_id,
        system_message=system,
        feature="ai-pdf-import",
    ).with_model(
        os.environ.get("LLM_PROVIDER", "openai"),
        os.environ.get("LLM_MODEL", "gpt-4o-mini"),
    )
    try:
        reply = await chat.send_message(UserMessage(text=text))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"AI parse failed: {e}") from e

    # Reply may include surrounding text or code fences — extract the
    # first {...} block that looks like JSON.
    m = re.search(r"\{[\s\S]*\}", str(reply or ""))
    if not m:
        return [], []
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        return [], []
    contacts = parsed.get("contacts") if isinstance(parsed, dict) else None
    if not isinstance(contacts, list):
        return [], []
    headers = ["name", "email", "phone", "address", "type"]
    rows: list[list[str]] = []
    for c in contacts[:200]:
        if not isinstance(c, dict):
            continue
        name = (c.get("name") or "").strip()
        if not name:
            continue
        rows.append([
            name,
            (c.get("email") or "").strip(),
            (c.get("phone") or "").strip(),
            (c.get("address") or "").strip(),
            (c.get("type") or "").strip().lower(),
        ])
    return headers, rows


def _rows_to_contacts(
    headers: list[str],
    rows: list[list[str]],
    default_type: str,
    mapping_override: Optional[dict[int, str]] = None,
) -> tuple[list[dict], dict[int, str]]:
    """Map raw parsed rows into contact dicts.

    - When ``mapping_override`` is provided (from the UI's column mapper),
      it wins — the key is the column index (int) and the value is the
      canonical field ("name" / "email" / "phone" / "address" / "type" /
      "" to skip).
    - Otherwise falls back to header alias detection.

    Returns ``(contacts, resolved_mapping)`` so the UI can render which
    columns were used vs skipped.
    """
    resolved: dict[int, str] = {}
    if mapping_override:
        # Trust the UI. Normalize keys to int (they may arrive as strings
        # from JSON).
        for k, v in mapping_override.items():
            try:
                i = int(k)
            except (ValueError, TypeError):
                continue
            if v and v in _HEADER_ALIASES:
                resolved[i] = v
    else:
        for i, h in enumerate(headers):
            canonical = _canonical_header(h)
            if canonical and canonical not in resolved.values():
                resolved[i] = canonical
        # Fallback: no known headers found → assume first column is a name.
        if not resolved and headers:
            resolved[0] = "name"

    # Invert to {canonical: column_index} for lookup convenience.
    by_field: dict[str, int] = {v: k for k, v in resolved.items()}

    def _get(row, field):
        i = by_field.get(field)
        return row[i].strip() if i is not None and i < len(row) and row[i] else ""

    out: list[dict] = []
    for r in rows:
        name = _get(r, "name")
        if not name:
            continue
        out.append({
            "name": name,
            "email": _get(r, "email"),
            "phone": _get(r, "phone"),
            "address": _get(r, "address"),
            "type": _guess_type(_get(r, "type"), default_type),
        })
    return out, resolved


@router.post("/companies/{cid}/contacts/import/preview")
async def contacts_import_preview(
    cid: str,
    file: UploadFile = File(...),
    default_type: str = Form("customer"),
    ai: str = Form("false"),  # "true" forces the AI PDF parser
    user: dict = Depends(get_current_user),
):
    """Parse an Excel / CSV / PDF upload and return the extracted rows
    without touching the database. Use this to render a review table
    the CPA can proofread before hitting Commit.

    Returns the raw parsed cells alongside the resolved contacts so the
    UI can offer a column-mapping override (remap without re-uploading).

    When ``ai=true`` and the file is a PDF, the deterministic parser is
    skipped in favor of the GPT-based extractor — useful for messy
    layouts (multi-column, scanned, unstructured directories). Non-PDF
    uploads ignore the flag."""
    await require_company(user, cid)
    if default_type not in ("customer", "vendor"):
        raise HTTPException(400, "default_type must be customer or vendor")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "File too large. Max 15 MB.")
    fname = (file.filename or "").lower()
    use_ai = (str(ai).lower() == "true") and fname.endswith(".pdf")
    if use_ai:
        headers, rows = await _ai_parse_pdf(data)
        parsed = {"headers": headers, "rows": rows, "source": "pdf-ai"}
    else:
        parsed = _parse_upload(file.filename or "", data)
    contacts, mapping = _rows_to_contacts(parsed["headers"], parsed["rows"], default_type)
    # Deduplicate within the upload itself — a spreadsheet often has
    # the same customer listed twice. Keep the first occurrence.
    seen = set()
    deduped: list[dict] = []
    for c in contacts:
        key = contact_resolver.normalize_contact_name(c["name"])
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append({**c, "normalized_name": key})
    if deduped:
        existing_keys = {
            d["normalized_name"] async for d in db.contacts.find(
                {"company_id": cid,
                 "normalized_name": {"$in": [c["normalized_name"] for c in deduped]}},
                {"normalized_name": 1, "_id": 0},
            )
        }
        for c in deduped:
            c["existing"] = c["normalized_name"] in existing_keys
    return {
        "source": parsed["source"],
        "filename": file.filename,
        "detected_headers": parsed["headers"],
        "raw_rows": parsed["rows"],
        "auto_mapping": {str(k): v for k, v in mapping.items()},
        "known_fields": list(_HEADER_ALIASES.keys()),
        "row_count_raw": len(parsed["rows"]),
        "row_count_after_dedupe": len(deduped),
        "contacts": deduped,
    }


class RemapIn(BaseModel):
    headers: list[str]
    raw_rows: list[list[str]]
    mapping: dict[str, str]
    default_type: str = "customer"


@router.post("/companies/{cid}/contacts/import/remap")
async def contacts_import_remap(
    cid: str,
    inp: RemapIn,
    user: dict = Depends(get_current_user),
):
    """Re-resolve raw parsed rows with a UI-supplied column mapping.
    Called when the CPA overrides the auto-detected mapping in the
    import modal — avoids re-uploading the file. Returns the same
    shape as ``preview`` for a clean drop-in replacement."""
    await require_company(user, cid)
    if inp.default_type not in ("customer", "vendor"):
        raise HTTPException(400, "default_type must be customer or vendor")
    override = {int(k): v for k, v in inp.mapping.items() if v}
    contacts, resolved = _rows_to_contacts(inp.headers, inp.raw_rows, inp.default_type, override)
    seen: set[str] = set()
    deduped: list[dict] = []
    for c in contacts:
        key = contact_resolver.normalize_contact_name(c["name"])
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append({**c, "normalized_name": key})
    if deduped:
        existing_keys = {
            d["normalized_name"] async for d in db.contacts.find(
                {"company_id": cid,
                 "normalized_name": {"$in": [c["normalized_name"] for c in deduped]}},
                {"normalized_name": 1, "_id": 0},
            )
        }
        for c in deduped:
            c["existing"] = c["normalized_name"] in existing_keys
    return {
        "row_count_after_dedupe": len(deduped),
        "resolved_mapping": {str(k): v for k, v in resolved.items()},
        "contacts": deduped,
    }


class ContactsImportCommitIn(BaseModel):
    contacts: list[dict]
    filename: Optional[str] = None
    source: Optional[str] = None  # excel | csv | pdf, for log display


@router.post("/companies/{cid}/contacts/import/commit")
async def contacts_import_commit(
    cid: str,
    inp: ContactsImportCommitIn,
    user: dict = Depends(get_current_user),
):
    """Insert (or upsert) the contacts the CPA confirmed in the preview.
    Also writes an ``contact_imports`` batch log with per-row snapshots
    of the previous contact state so an accidental import can be
    undone in one click. Returns per-outcome counts."""
    await require_company(user, cid)
    now = now_iso()
    created_ids: list[str] = []
    updated_snapshots: list[dict] = []
    skipped = 0
    for c in inp.contacts:
        name = (c.get("name") or "").strip()
        if not name:
            skipped += 1
            continue
        key = contact_resolver.normalize_contact_name(name)
        if not key:
            skipped += 1
            continue
        t = c.get("type") or "customer"
        if t not in ("customer", "vendor"):
            t = "customer"
        payload = {
            "company_id": cid,
            "name": name,
            "type": t,
            "email": (c.get("email") or "").strip(),
            "phone": (c.get("phone") or "").strip(),
            "address": (c.get("address") or "").strip(),
            "normalized_name": key,
            "updated_at": now,
        }
        existing = await db.contacts.find_one(
            {"company_id": cid, "normalized_name": key},
        )
        if existing:
            # Snapshot the ENTIRE previous doc so undo can restore it
            # even if fields we don't currently overwrite change later.
            prev = {k: v for k, v in existing.items() if k != "_id"}
            await db.contacts.update_one(
                {"id": existing["id"], "company_id": cid},
                {"$set": payload},
            )
            updated_snapshots.append({"id": existing["id"], "prev": prev})
        else:
            payload["id"] = str(uuid.uuid4())
            payload["created_at"] = now
            # Race-safe: two concurrent imports of the same CSV, OR a Plaid sync
            # inserting the same contact between our find_one and insert_one,
            # previously raised E11000 and 500'd the import. Now we treat the
            # race as "someone else won → treat as an update against the
            # winner" so the import stays atomic per-row.
            try:
                await db.contacts.insert_one(payload)
                created_ids.append(payload["id"])
            except DuplicateKeyError:
                winner = await db.contacts.find_one(
                    {"company_id": cid, "normalized_name": key},
                )
                if winner:
                    prev = {k: v for k, v in winner.items() if k != "_id"}
                    # Build a fresh $set that omits identity/immutable fields —
                    # note that motor's insert_one populates `_id` on `payload`
                    # as a side effect, so filter `_id` explicitly too.
                    update_payload = {k: v for k, v in payload.items()
                                      if k not in ("id", "_id", "created_at")}
                    await db.contacts.update_one(
                        {"id": winner["id"], "company_id": cid},
                        {"$set": update_payload},
                    )
                    updated_snapshots.append({"id": winner["id"], "prev": prev})
                else:
                    # Duplicate key fired but no matching doc — shouldn't happen
                    raise
    # Write the batch log (only when something happened — a fully-
    # skipped import doesn't deserve a rollback row).
    log_id: Optional[str] = None
    if created_ids or updated_snapshots:
        log_id = str(uuid.uuid4())
        await db.contact_imports.insert_one({
            "id": log_id,
            "company_id": cid,
            "user_id": user.get("id"),
            "at": now,
            "filename": inp.filename or "(unknown)",
            "source": inp.source or "",
            "created_ids": created_ids,
            "updated_snapshots": updated_snapshots,
            "created_count": len(created_ids),
            "updated_count": len(updated_snapshots),
            "skipped_count": skipped,
            "undone": False,
        })
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True,
            "created": len(created_ids),
            "updated": len(updated_snapshots),
            "skipped": skipped,
            "total": len(created_ids) + len(updated_snapshots) + skipped,
            "batch_id": log_id}


@router.get("/companies/{cid}/contacts/imports")
async def contacts_import_history(
    cid: str,
    limit: int = 20,
    user: dict = Depends(get_current_user),
):
    """List recent import batches so the CPA can see what was imported
    and (if needed) undo one. Ordered newest-first."""
    await require_company(user, cid)
    docs = await db.contact_imports.find(
        {"company_id": cid},
        {"_id": 0, "updated_snapshots": 0},  # trim the payload
    ).sort("at", -1).to_list(min(limit, 100))
    # Attach the actor's display name so the log reads nicely.
    user_ids = list({d.get("user_id") for d in docs if d.get("user_id")})
    name_map = {}
    if user_ids:
        for u in await db.users.find(
            {"id": {"$in": user_ids}}, {"id": 1, "name": 1, "email": 1, "_id": 0},
        ).to_list(len(user_ids)):
            name_map[u["id"]] = u.get("name") or u.get("email") or "—"
    for d in docs:
        d["user_name"] = name_map.get(d.get("user_id"), "—")
    return {"batches": docs}


@router.post("/companies/{cid}/contacts/imports/{batch_id}/undo")
async def contacts_import_undo(
    cid: str,
    batch_id: str,
    user: dict = Depends(get_current_user),
):
    """Roll a specific import batch back:
      - every contact created by this batch is deleted
      - every contact updated by this batch has its previous doc restored

    Idempotent: calling it again is a no-op (the ``undone`` flag flips
    on the first call). Returns per-outcome counts so the UI can render
    a matching toast."""
    await require_company(user, cid)
    batch = await db.contact_imports.find_one({"id": batch_id, "company_id": cid})
    if not batch:
        raise HTTPException(404, "Import batch not found")
    if batch.get("undone"):
        return {"ok": True, "already_undone": True, "deleted": 0, "restored": 0}
    created_ids = batch.get("created_ids") or []
    snapshots = batch.get("updated_snapshots") or []
    deleted = 0
    if created_ids:
        r = await db.contacts.delete_many({"id": {"$in": created_ids}, "company_id": cid})
        deleted = r.deleted_count
    restored = 0
    for snap in snapshots:
        prev = snap.get("prev") or {}
        if not prev.get("id"):
            continue
        # Overwrite the current doc with the pre-import snapshot. Using
        # replace_one keeps things simple: whatever was there at time-of-
        # import is exactly what we restore.
        r = await db.contacts.replace_one(
            {"id": prev["id"], "company_id": cid}, prev
        )
        restored += r.modified_count
    await db.contact_imports.update_one(
        {"id": batch_id, "company_id": cid},
        {"$set": {"undone": True, "undone_at": now_iso(), "undone_by": user.get("id")}},
    )
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "deleted": deleted, "restored": restored}



@router.post("/companies/{cid}/contacts/reclassify")
async def contacts_reclassify(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Auto-classify every contact's `type` from the direction of transactions
    that reference it (money-in → customer, money-out → vendor, mixed → both).

    Only touches contacts that are un-typed OR were previously auto-classified
    by this same routine (marked via `type_source: "auto"`). Manual tags set
    by the user are always preserved.

    Wired in as a manual "Auto-classify all" button on the Contacts page for
    now; will also be triggered automatically after Plaid sync completions
    and Veryfi statement uploads in a follow-up so it feels magical instead
    of user-initiated.
    """
    await require_company(user, cid)
    from contact_resolver import reclassify_contact_types
    summary = await reclassify_contact_types(cid, respect_manual=True)
    try:
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return summary
