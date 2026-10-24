"""AI Review bank-statement engine — GPT-4o alternative to Veryfi OCR.

Hybrid extraction: PDF pages with a real text layer are sent as text;
scanned/image pages are rendered to PNG and sent as vision input. Two
passes: (1) statement summary, (2) chunked transaction extraction, then
self-reconciliation against the summary totals with one diligent retry.

Output is a Veryfi-shaped doc so `statements._process_veryfi_result`
(account resolution, dedupe guards, categorization, posting) is reused
unchanged. ``doc["ai_review"]`` carries the summary + reconciliation.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from datetime import date, datetime

logger = logging.getLogger("axiom.statement_ai")

MODEL = "gpt-4o"
TEXT_PAGES_PER_CALL = 2
IMAGE_PAGES_PER_CALL = 2
MIN_TEXT_CHARS = 200      # below this a page is treated as scanned → vision
RENDER_DPI = 130
TOLERANCE = 0.01


# ---------------------------------------------------------------- pages
def _pdf_pages(file_bytes: bytes) -> list[dict]:
    import pymupdf
    pages = []
    with pymupdf.open(stream=file_bytes, filetype="pdf") as doc:
        for i, page in enumerate(doc):
            text = page.get_text("text") or ""
            if len(text.strip()) >= MIN_TEXT_CHARS:
                pages.append({"page": i + 1, "text": text, "image_b64": None})
            else:
                pix = page.get_pixmap(dpi=RENDER_DPI)
                pages.append({"page": i + 1, "text": text,
                              "image_b64": base64.b64encode(pix.tobytes("png")).decode()})
    return pages


def extract_pages(file_bytes: bytes, content_type: str, filename: str) -> list[dict]:
    is_pdf = (content_type or "").lower() == "application/pdf" or filename.lower().endswith(".pdf") \
        or file_bytes[:5] == b"%PDF-"
    if is_pdf:
        return _pdf_pages(file_bytes)
    return [{"page": 1, "text": "", "image_b64": base64.b64encode(file_bytes).decode(),
             "mime": content_type or "image/png"}]


def _chunks(pages: list[dict]) -> list[list[dict]]:
    out, cur = [], []
    for p in pages:
        limit = IMAGE_PAGES_PER_CALL if p["image_b64"] else TEXT_PAGES_PER_CALL
        if cur and (len(cur) >= limit or bool(cur[0]["image_b64"]) != bool(p["image_b64"])):
            out.append(cur); cur = []
        cur.append(p)
    if cur:
        out.append(cur)
    return out


def _content_for(pages: list[dict], intro: str) -> list[dict]:
    parts = [{"type": "text", "text": intro}]
    for p in pages:
        if p["image_b64"]:
            parts.append({"type": "text", "text": f"--- Page {p['page']} (image) ---"})
            mime = p.get("mime") or "image/png"
            parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{p['image_b64']}", "detail": "high"}})
        else:
            parts.append({"type": "text", "text": f"--- Page {p['page']} (text) ---\n{p['text']}"})
    return parts


# ---------------------------------------------------------------- llm
def _client():
    from openai import AsyncOpenAI
    key = os.environ.get("OPENAI_API_KEY") or ""
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    return AsyncOpenAI(api_key=key)


class _Truncated(Exception):
    pass


async def _ask_json(client, system: str, content: list[dict], *, max_tokens: int = 4096) -> dict:
    resp = await client.chat.completions.create(
        model=MODEL, temperature=0, max_tokens=max_tokens,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": content}],
    )
    if resp.choices[0].finish_reason == "length":
        raise _Truncated()
    raw = (resp.choices[0].message.content or "{}").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        return json.loads(m.group(0)) if m else {}


async def _extract_chunk(client, chunk: list[dict], intro: str) -> dict:
    """Extract one chunk; on output truncation split the chunk in half."""
    try:
        return await _ask_json(client, TXN_SYSTEM, _content_for(chunk, intro), max_tokens=16000)
    except _Truncated:
        if len(chunk) == 1:
            logger.warning("statement_ai: page %s output truncated even alone", chunk[0]["page"])
            return {"transactions": []}
        mid = len(chunk) // 2
        a, b = await asyncio.gather(_extract_chunk(client, chunk[:mid], intro), _extract_chunk(client, chunk[mid:], intro))
        return {"transactions": (a.get("transactions") or []) + (b.get("transactions") or [])}


SUMMARY_SYSTEM = """You are a meticulous bookkeeper reading a bank, credit-card, or loan statement.
Return ONLY JSON with this exact shape (use null when unknown, numbers as plain decimals, dates as YYYY-MM-DD):
{
 "bank_name": str, "account_holder": str, "account_type": "checking|savings|money_market|credit_card|loan|line_of_credit|other",
 "is_liability": bool, "account_number_last4": str, "account_number_masked": str,
 "period_start": str, "period_end": str, "statement_date": str,
 "beginning_balance": number, "ending_balance": number,
 "totals": {"deposits": number, "withdrawals": number, "fees": number, "interest": number, "other_credits": number},
 "has_multiple_accounts": bool, "accounts": [{"label": str, "account_number_last4": str, "account_type": str, "beginning_balance": number, "ending_balance": number}],
 "transaction_pages": [int], "notes": str
}
Rules: "deposits" = all money INTO the account (deposits, credits, payments received on a card). "withdrawals" = all money OUT
(purchases, checks, debits, payments made from a bank account, cash advances). Report amounts as positive numbers.
For credit cards: payments/credits are deposits; purchases/fees/interest are withdrawals (list fees and interest separately too).
transaction_pages = page numbers that contain transaction detail tables (exclude pages that only have summaries, terms, or ads)."""

TXN_SYSTEM = """You are extracting EVERY individual transaction line from the given statement pages.
Return ONLY JSON: {"transactions": [ {"post_date": "YYYY-MM-DD", "trans_date": "YYYY-MM-DD|null", "description": str,
 "reference": str|null, "check_number": str|null, "amount": number (positive), "direction": "deposit|withdrawal",
 "cardholder": str|null, "type": "purchase|payment|deposit|withdrawal|fee|interest|transfer|check|credit|other", "page": int } ] }
Rules:
- Include every transaction row on these pages exactly once; never summarize or skip rows. Keep the statement's row order.
- Exclude: section subtotals/totals, per-cardholder subtotal lines, daily balance tables, "pending" items, summary boxes, marketing text.
- "deposit" = money INTO the account (deposits, credits, refunds, payments received on a credit card).
  "withdrawal" = money OUT (purchases, checks, fees, interest charged, payments made FROM a bank account).
- Infer the year from the statement period provided; handle Dec→Jan wrap.
- Copy descriptions verbatim (collapse whitespace). Put check numbers in check_number, reference/confirmation numbers in reference.
- If no transactions are on these pages return {"transactions": []}."""


def _f(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return round(float(str(v).replace(",", "").replace("$", "")), 2)
    except ValueError:
        return None


def _norm_date(s: str | None, period_start: str | None, period_end: str | None) -> str | None:
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    m = re.match(r"^(\d{1,2})/(\d{1,2})$", s)
    if m and period_end:
        yr = int(period_end[:4]); mo, dy = int(m.group(1)), int(m.group(2))
        try:
            d = date(yr, mo, dy)
            if period_start and d.isoformat() > period_end:
                d = date(yr - 1, mo, dy)
            return d.isoformat()
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------- main
async def analyze_statement(file_bytes: bytes, filename: str, content_type: str,
                            account_kind_hint: str | None = None, progress_cb=None) -> dict:
    pages = extract_pages(file_bytes, content_type, filename)
    client = _client()

    async def _progress(stage: str, **kw):
        if progress_cb:
            await progress_cb(stage, **kw)

    await _progress("summary", pages=len(pages))
    hint = ""
    if account_kind_hint in ("asset", "liability"):
        hint = f"\nThe user says this is a {'LIABILITY (credit card / loan)' if account_kind_hint == 'liability' else 'ASSET (bank / cash)'} account."
    summary = await _ask_json(client, SUMMARY_SYSTEM,
                              _content_for(pages[:3], "Read the statement summary from these first pages." + hint), max_tokens=1500)
    period_start = _norm_date(summary.get("period_start"), None, None)
    period_end = _norm_date(summary.get("period_end") or summary.get("statement_date"), None, None)
    txn_pages = {int(p) for p in (summary.get("transaction_pages") or []) if str(p).isdigit()}
    cand = [p for p in pages if not txn_pages or p["page"] in txn_pages or p["page"] >= min(txn_pages)]

    async def _extract(diligent: bool) -> list[dict]:
        intro = (f"Statement period: {period_start} to {period_end}. Account type: {summary.get('account_type')}. "
                 f"Extract all transactions from these pages.")
        if diligent:
            intro += (" IMPORTANT: a previous pass missed or double-counted rows — the totals did not tie to the statement "
                      "summary. Re-read every line carefully, including continuation rows and rows at page edges.")
        results = await asyncio.gather(*[_extract_chunk(client, chunk, intro) for chunk in _chunks(cand)])
        rows = []
        for r in results:
            for t in r.get("transactions") or []:
                amt = _f(t.get("amount"))
                if amt is None or amt == 0:
                    continue
                rows.append({
                    "post_date": _norm_date(t.get("post_date"), period_start, period_end),
                    "trans_date": _norm_date(t.get("trans_date"), period_start, period_end),
                    "description": " ".join(str(t.get("description") or "").split()),
                    "reference": (str(t.get("reference")).strip() or None) if t.get("reference") else None,
                    "check_number": (str(t.get("check_number")).strip() or None) if t.get("check_number") else None,
                    "amount": abs(amt),
                    "direction": "deposit" if str(t.get("direction", "")).lower().startswith("dep") else "withdrawal",
                    "cardholder": t.get("cardholder") or None,
                    "type": t.get("type") or None,
                    "page": t.get("page"),
                })
        return rows

    await _progress("transactions", pages=len(cand))
    rows = await _extract(diligent=False)
    recon = _reconcile(summary, rows)
    if not recon["ties"]:
        await _progress("retry")
        rows2 = await _extract(diligent=True)
        recon2 = _reconcile(summary, rows2)
        if recon2["score"] < recon["score"]:
            rows, recon = rows2, recon2
        recon["retried"] = True

    return _build_doc(summary, rows, recon, period_start, period_end, filename, len(pages))


def _reconcile(summary: dict, rows: list[dict]) -> dict:
    totals = summary.get("totals") or {}
    dep_sum = round(sum(r["amount"] for r in rows if r["direction"] == "deposit"), 2)
    wd_sum = round(sum(r["amount"] for r in rows if r["direction"] == "withdrawal"), 2)
    s_dep = _f(totals.get("deposits")) or 0.0
    s_fees = _f(totals.get("fees")) or 0.0
    s_int = _f(totals.get("interest")) or 0.0
    s_wd_raw = _f(totals.get("withdrawals")) or 0.0
    s_oc = _f(totals.get("other_credits")) or 0.0
    beg, end = _f(summary.get("beginning_balance")), _f(summary.get("ending_balance"))
    liability = bool(summary.get("is_liability"))
    # Summary withdrawals may or may not already include fees/interest — accept either.
    wd_candidates = {round(s_wd_raw, 2), round(s_wd_raw + s_fees + s_int, 2)}
    dep_candidates = {round(s_dep, 2), round(s_dep + s_oc, 2)}
    dep_ok = any(abs(dep_sum - c) <= TOLERANCE for c in dep_candidates)
    wd_ok = any(abs(wd_sum - c) <= TOLERANCE for c in wd_candidates)
    bal_ok, bal_drift = None, None
    if beg is not None and end is not None:
        computed = round(beg - dep_sum + wd_sum, 2) if liability else round(beg + dep_sum - wd_sum, 2)
        bal_drift = round(computed - end, 2)
        bal_ok = abs(bal_drift) <= TOLERANCE
    dep_drift = round(dep_sum - min(dep_candidates, key=lambda c: abs(dep_sum - c)), 2)
    wd_drift = round(wd_sum - min(wd_candidates, key=lambda c: abs(wd_sum - c)), 2)
    ties = dep_ok and wd_ok and (bal_ok is not False)
    return {"ties": ties, "deposits_extracted": dep_sum, "withdrawals_extracted": wd_sum,
            "deposits_stated": s_dep, "withdrawals_stated": s_wd_raw, "fees_stated": s_fees, "interest_stated": s_int,
            "deposits_ok": dep_ok, "withdrawals_ok": wd_ok, "balance_ok": bal_ok, "balance_drift": bal_drift,
            "deposits_drift": dep_drift, "withdrawals_drift": wd_drift,
            "score": abs(dep_drift) + abs(wd_drift) + abs(bal_drift or 0), "retried": False,
            "count_deposits": sum(1 for r in rows if r["direction"] == "deposit"),
            "count_withdrawals": sum(1 for r in rows if r["direction"] == "withdrawal")}


def _build_doc(summary: dict, rows: list[dict], recon: dict, period_start, period_end, filename: str, n_pages: int) -> dict:
    liability = bool(summary.get("is_liability"))
    acct_type = summary.get("account_type") or ("credit_card" if liability else "checking")
    txns = []
    for r in rows:
        d = r["post_date"] or r["trans_date"]
        if not d:
            continue
        t = {"date": d, "posted_date": r["post_date"], "transaction_date": r["trans_date"],
             "description": r["description"] or "Statement Line", "reference": r["reference"],
             "check_number": r["check_number"], "cardholder": r["cardholder"], "txn_type": r["type"], "page": r["page"]}
        if r["direction"] == "deposit":
            t["credit_amount"] = r["amount"]
        else:
            t["debit_amount"] = r["amount"]
        txns.append(t)
    last4 = summary.get("account_number_last4") or ""
    account = {"number": summary.get("account_number_masked") or (f"****{last4}" if last4 else None),
               "account_number": summary.get("account_number_masked") or (f"****{last4}" if last4 else None),
               "account_type": acct_type, "starting_balance": _f(summary.get("beginning_balance")),
               "ending_balance": _f(summary.get("ending_balance")), "transactions": txns}
    return {
        "id": None, "engine": "ai_review", "model": MODEL,
        "bank_name": summary.get("bank_name"), "account_holder_name": summary.get("account_holder"),
        "account_number": account["account_number"], "account_type": acct_type, "is_liability": liability,
        "period_start_date": period_start, "period_end_date": period_end,
        "statement_date": _norm_date(summary.get("statement_date"), None, None) or period_end,
        "starting_balance": account["starting_balance"], "ending_balance": account["ending_balance"],
        # Current Veryfi shape: rows live under accounts[].transactions only
        # (veryfi_service.extract_transactions reads both; listing twice doubles).
        "accounts": [account], "transactions": [],
        "ai_review": {"summary": {**summary, "period_start": period_start, "period_end": period_end},
                      "reconciliation": recon, "rows": rows, "pages": n_pages, "filename": filename},
    }
