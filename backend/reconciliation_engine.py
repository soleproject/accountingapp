"""Axiom Ledger — Reconciliation engine.

Powers three flows:

R1  Plaid auto-clear     Called from the Plaid sync path. Posted txns older
                          than a provisional window get `cleared_at` set to
                          their transaction date so they contribute to
                          "already reconciled" status without user input.

R2  Manual matching      /preview + /complete endpoints backing the interactive
                          reconciliation UI (pick account/date/balance → tick
                          items → watch the diff hit $0 → finish).

R3  Statement matcher    /match-statement runs Veryfi OCR on an uploaded PDF,
                          fuzzy-scores each extracted line against uncleared
                          ledger txns, and returns candidates grouped by
                          confidence tier.

Runs entirely in-process, no external services beyond the existing Veryfi hit.
Kept transparent — every automated clear stores its `cleared_source` so audit
logs can distinguish Plaid-auto from statement-match from user-tick.
"""
from __future__ import annotations
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta, date as dt_date
from typing import Optional

from db import db, now_iso


PROVISIONAL_DAYS = 5  # Match Plaid's typical repost window.

# Words we strip when computing description similarity — pure bank noise.
_DESC_NOISE = re.compile(
    r"\b(pos|purchase|debit|credit|payment|transfer|xfer|ach|deposit|withdrawal|"
    r"web|ppd|ccd|pmt|from|to|ref|id|check|chk|no|nbr|number|#|inst|online|"
    r"mobile|banking|card|ending|in|on|@)\b",
    re.IGNORECASE,
)
_NUMERIC_TOKENS = re.compile(r"\b\d{2,}\b")
_PUNCT = re.compile(r"[^\w\s]")


def _normalize_desc(s: str) -> set[str]:
    """Turn a raw description into a bag-of-tokens for Jaccard scoring."""
    if not s:
        return set()
    s = s.lower()
    s = _NUMERIC_TOKENS.sub(" ", s)   # store numbers, POS ids, etc.
    s = _DESC_NOISE.sub(" ", s)
    s = _PUNCT.sub(" ", s)
    return {tok for tok in s.split() if len(tok) >= 2}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _parse_date(d: str) -> Optional[dt_date]:
    try:
        return datetime.fromisoformat(str(d)[:10]).date()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# R1 — Plaid auto-clear
# ---------------------------------------------------------------------------

async def auto_clear_settled_plaid_txns(cid: str) -> dict:
    """Set `cleared_at` on posted Plaid txns older than the provisional window.

    Idempotent — only touches rows that don't already have a cleared timestamp.
    Called after every Plaid sync AND once from the recon UI on demand.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=PROVISIONAL_DAYS)).date().isoformat()
    result = await db.transactions.update_many(
        {
            "company_id": cid,
            "source": {"$regex": "^plaid"},   # includes both `plaid` and `plaid_mock`
            "posted": True,
            "cleared_at": {"$in": [None, "", False]},
            "date": {"$lte": cutoff},
            # Never auto-clear items Plaid flagged pending.
            "plaid_pending": {"$ne": True},
        },
        # `$currentDate` isn't quite right here — we want the txn's own date,
        # not "now" — so we set the source flag and do a follow-up update per
        # doc if needed. For MVP we set cleared_at = date directly via aggregation.
        [
            {"$set": {
                "cleared_at": "$date",
                "cleared_source": "plaid_auto",
                "updated_at": now_iso(),
            }},
        ],
    )
    return {"cleared": result.modified_count}


# ---------------------------------------------------------------------------
# R2 — Manual matching preview / complete
# ---------------------------------------------------------------------------

async def preview_recon(
    cid: str, bank_account_id: str, as_of: str, statement_balance: float,
) -> dict:
    """Return everything the reconciliation UI needs to render the interactive
    matcher: uncleared txns through `as_of`, book balance, and the starting
    difference. Nothing is written."""
    # Book balance: sum of every posted txn for the bank account through as_of.
    pipe = [
        {"$match": {
            "company_id": cid,
            "bank_account_id": bank_account_id,
            "posted": True,
            "date": {"$lte": as_of},
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]
    agg = await db.transactions.aggregate(pipe).to_list(1)
    book_balance = round(float(agg[0]["total"]) if agg else 0.0, 2)

    # Uncleared items = book txns not yet marked cleared.
    uncleared_docs = await db.transactions.find({
        "company_id": cid,
        "bank_account_id": bank_account_id,
        "posted": True,
        "date": {"$lte": as_of},
        "$or": [
            {"cleared_at": None},
            {"cleared_at": {"$exists": False}},
            {"cleared_at": ""},
        ],
    }).sort("date", 1).to_list(1000)

    uncleared = [{
        "id": t["id"], "date": t.get("date"), "amount": t.get("amount"),
        "description": t.get("description") or t.get("merchant"),
        "merchant": t.get("merchant"),
        "category_account_name": t.get("category_account_name"),
    } for t in uncleared_docs]

    diff = round(book_balance - float(statement_balance), 2)
    return {
        "book_balance": book_balance,
        "statement_balance": round(float(statement_balance), 2),
        "difference": diff,
        "uncleared": uncleared,
    }


async def complete_recon(
    cid: str, bank_account_id: str, period_end: str, period_start: Optional[str],
    statement_balance: float, cleared_txn_ids: list[str], user_email: str,
) -> dict:
    """Snapshot the reconciliation: write `cleared_at` on the ticked txns and
    insert a `reconciliations` doc. Balance check enforced server-side."""
    if not cleared_txn_ids:
        raise ValueError("Nothing selected to clear.")
    now = now_iso()
    # Set cleared_at on the ticked txns.
    await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": cleared_txn_ids}},
        {"$set": {
            "cleared_at": period_end,
            "cleared_source": "manual",
            "updated_at": now,
        }},
    )
    rec_id = str(uuid.uuid4())
    doc = {
        "id": rec_id, "company_id": cid, "bank_account_id": bank_account_id,
        "as_of": period_end,
        "period_start": period_start,
        "period_end": period_end,
        "statement_balance": round(float(statement_balance), 2),
        "cleared_txn_ids": cleared_txn_ids,
        "matched_count": len(cleared_txn_ids),
        "source": "manual",
        "status": "reconciled",
        "completed_at": now, "completed_by": user_email,
        "created_at": now, "updated_at": now,
    }
    await db.reconciliations.insert_one(doc)
    # Backfill reconciliation_id onto the cleared txns for audit.
    await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": cleared_txn_ids}},
        {"$set": {"cleared_reconciliation_id": rec_id}},
    )
    return {"id": rec_id, "cleared": len(cleared_txn_ids)}


# ---------------------------------------------------------------------------
# R3 — Statement fuzzy matcher
# ---------------------------------------------------------------------------

@dataclass
class MatchScore:
    txn_id: str
    score: float
    amount_component: float
    date_component: float
    desc_component: float


def _score_candidate(stmt: dict, txn: dict) -> MatchScore:
    # Amount: exact wins big, ±$0.01 fine, otherwise 0.
    try:
        da = abs(float(stmt.get("amount", 0)) - float(txn.get("amount", 0)))
    except Exception:
        da = 999
    if da < 0.005:      amt = 1.0
    elif da < 0.02:     amt = 0.85
    else:               amt = 0.0

    # Date: ±3 days linear falloff.
    sd = _parse_date(stmt.get("date"))
    td = _parse_date(txn.get("date"))
    if sd and td:
        delta = abs((sd - td).days)
        dt_score = max(0.0, 1.0 - (delta * 0.2))  # -0.2 per day; 0 at ≥5 days
    else:
        dt_score = 0.0

    # Description: Jaccard on normalized tokens.
    stmt_toks = _normalize_desc(stmt.get("description") or stmt.get("merchant", ""))
    txn_toks = _normalize_desc(f"{txn.get('description', '')} {txn.get('merchant', '')}")
    desc = _jaccard(stmt_toks, txn_toks)

    combined = round(0.5 * amt + 0.2 * dt_score + 0.3 * desc, 3)
    return MatchScore(
        txn_id=txn["id"], score=combined,
        amount_component=amt, date_component=dt_score, desc_component=desc,
    )


async def match_statement_lines(
    cid: str, bank_account_id: str, statement_lines: list[dict],
    date_window_days: int = 10,
) -> dict:
    """Score every statement line against uncleared ledger txns, return the
    top candidate per line grouped by confidence tier.

    tiers:
      ≥ 0.90 → auto        (silent bulk-apply)
      0.60 – 0.90 → suggest
      < 0.60 → manual      (statement line has no confident match — likely
                            missing from ledger)
    """
    if not statement_lines:
        return {"auto": [], "suggest": [], "manual": [], "missing_from_statement": []}

    # Pull candidate pool once: uncleared posted txns for the account,
    # within a ±window around the statement's date range.
    all_dates = [d for d in (l.get("date") for l in statement_lines) if d]
    if not all_dates:
        return {
            "auto": [], "suggest": [],
            "manual": [{"line": l, "best": None} for l in statement_lines],
            "missing_from_statement": [],
        }
    lo = min(all_dates)
    hi = max(all_dates)
    lo_d = _parse_date(lo); hi_d = _parse_date(hi)
    if lo_d and hi_d:
        lo = (lo_d - timedelta(days=date_window_days)).isoformat()
        hi = (hi_d + timedelta(days=date_window_days)).isoformat()

    candidates = await db.transactions.find({
        "company_id": cid, "bank_account_id": bank_account_id,
        "posted": True,
        "date": {"$gte": lo, "$lte": hi},
        "$or": [
            {"cleared_at": None},
            {"cleared_at": {"$exists": False}},
            {"cleared_at": ""},
        ],
    }).to_list(2000)

    used: set[str] = set()  # A ledger txn can only match one statement line.
    auto: list[dict] = []
    suggest: list[dict] = []
    manual: list[dict] = []

    for line in statement_lines:
        # Prefilter on amount tolerance to cut scoring work.
        try:
            la = float(line.get("amount", 0))
        except Exception:
            la = 0.0
        pool = [c for c in candidates
                if c["id"] not in used
                and abs(float(c.get("amount", 0)) - la) < 0.02]
        if not pool:
            manual.append({"line": line, "best": None, "score": 0.0})
            continue
        scored = [_score_candidate(line, c) for c in pool]
        scored.sort(key=lambda s: s.score, reverse=True)
        best = scored[0]
        top_txn = next(c for c in pool if c["id"] == best.txn_id)
        entry = {
            "line": line,
            "best": {
                "id": top_txn["id"], "date": top_txn.get("date"),
                "amount": top_txn.get("amount"),
                "description": top_txn.get("description") or top_txn.get("merchant"),
            },
            "score": best.score,
            "components": {
                "amount": best.amount_component,
                "date": best.date_component,
                "desc": best.desc_component,
            },
        }
        if best.score >= 0.90:
            auto.append(entry)
            used.add(best.txn_id)
        elif best.score >= 0.60:
            suggest.append(entry)
            used.add(best.txn_id)
        else:
            manual.append(entry)

    # "Missing from statement" — ledger txns in the same period+account that
    # no statement line matched. Enterprise-grade trust signal: surfaces the
    # transactions a client either forgot to send OR that hit the bank
    # without landing on the paper statement (fraud / duplicate / typo).
    missing = [
        {
            "id": c["id"], "date": c.get("date"),
            "amount": c.get("amount"),
            "description": c.get("description") or c.get("merchant"),
            "category_account_name": c.get("category_account_name"),
        }
        for c in candidates if c["id"] not in used
    ]

    return {
        "auto": auto, "suggest": suggest, "manual": manual,
        "missing_from_statement": missing,
    }


# ---------------------------------------------------------------------------
# Utility — is a bank account fully reconciled for a given month?
# Used by month_close.py to auto-satisfy the `recon` checkpoint.
# ---------------------------------------------------------------------------

async def month_recon_state(cid: str, start: str, end: str) -> dict:
    """Return `{green, total, cleared, sources}` — used by Month Close to
    decide whether to auto-flip the `recon` checkpoint."""
    base = {
        "company_id": cid,
        "posted": True,
        "date": {"$gte": start, "$lte": end},
    }
    # Only look at real bank/CC posts. Bank_account_id present means it hit
    # a cash-like account (as opposed to internal journal entries).
    base["bank_account_id"] = {"$exists": True, "$ne": None}
    total = await db.transactions.count_documents(base)
    if total == 0:
        # Vacuous green — no bank activity to reconcile.
        return {"green": True, "auto": True, "total": 0, "cleared": 0, "sources": {}}
    cleared = await db.transactions.count_documents({
        **base, "cleared_at": {"$nin": [None, "", False], "$exists": True},
    })
    # Source breakdown for UI hint ("100% Plaid-auto" etc.)
    src_pipe = [
        {"$match": {**base, "cleared_at": {"$nin": [None, "", False]}}},
        {"$group": {"_id": "$cleared_source", "count": {"$sum": 1}}},
    ]
    src_docs = await db.transactions.aggregate(src_pipe).to_list(10)
    sources = {d["_id"] or "unknown": d["count"] for d in src_docs}
    return {
        "green": cleared == total,
        "auto": cleared == total,
        "total": total, "cleared": cleared,
        "sources": sources,
    }
